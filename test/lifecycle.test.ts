import { strict as assert } from "node:assert";
import { readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createAttemptIdentity,
  createRunIdentity,
  executeRunAttempt,
  InvalidLifecycleTransitionError,
  LifecycleController,
  readAttemptRecord,
  retryAttempt,
  writeAttemptRecord,
} from "../src/index.js";

const run = createRunIdentity({ taskId: "task-1", modelId: "model-1", harnessId: "harness-1" });

function workspace(result: { status: "ready" | "failed"; artifactId?: string; retained?: boolean; evidence?: unknown } = { status: "ready", artifactId: "workspace-1" }) {
  return {
    setup: async () => result,
    cleanup: async () => undefined,
  };
}

test("lifecycle transitions are guarded and retain timestamps", () => {
  const lifecycle = new LifecycleController(() => "2026-01-01T00:00:00.000Z");
  lifecycle.transition("setup", "2026-01-01T00:00:01.000Z");
  assert.throws(() => lifecycle.transition("verifying"), InvalidLifecycleTransitionError);
  lifecycle.transition("running", "2026-01-01T00:00:02.000Z");
  lifecycle.transition("verifying", "2026-01-01T00:00:03.000Z");
  lifecycle.transition("cleaning", "2026-01-01T00:00:04.000Z");
  lifecycle.transition("terminal", "2026-01-01T00:00:05.000Z");
  assert.equal(lifecycle.snapshot().state, "terminal");
  assert.equal(lifecycle.snapshot().timestamps.running, "2026-01-01T00:00:02.000Z");
  assert.throws(() => lifecycle.transition("running"), InvalidLifecycleTransitionError);
});

test("successful runs coordinate setup, harness, verifier, cleanup, and persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-success-"));
  const calls: string[] = [];
  try {
    const recordPath = join(root, "attempt.json");
    const result = await executeRunAttempt({
      run,
      recordPath,
      workspace: {
        setup: async () => { calls.push("setup"); return { status: "ready", artifactId: "workspace-1" }; },
        cleanup: async () => { calls.push("cleanup"); },
      },
      harness: async ({ signal }) => { calls.push(`harness:${signal.aborted}`); return { status: "completed", completionEvidence: { source: "fake", status: "idle" } }; },
      verifier: async () => { calls.push("verifier"); return { status: "passed" }; },
    });
    assert.deepEqual(result.terminal, { state: "completed", failureClass: "none", stopReason: "none", workspaceArtifactId: "workspace-1" });
    assert.deepEqual(calls, ["setup", "harness:false", "verifier", "cleanup"]);
    assert.equal((await readAttemptRecord(recordPath)).terminal?.state, "completed");
    assert.equal(readFileSync(recordPath, "utf8").endsWith("\n"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime shutdown callbacks stay executable but never enter durable records", async () => {
  let shutdownCalls = 0;
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed", shutdown: () => { shutdownCalls += 1; } }),
    verifier: async () => ({ status: "passed" }),
  });
  assert.equal(result.terminal.state, "completed");
  assert.equal(shutdownCalls, 0);
  assert.equal("shutdown" in (result.record.harness ?? {}), false);
});

test("verifier task failures and verifier errors remain distinct", async () => {
  const taskFailure = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "failed", error: "assertion failed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(taskFailure.terminal.failureClass, "task");
  assert.equal(taskFailure.classification.kind, "task-failure");

  const infrastructureFailure = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "error", error: "verifier crashed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(infrastructureFailure.terminal.failureClass, "infrastructure");
  assert.equal(infrastructureFailure.classification.kind, "verifier-error");
});

test("harness infrastructure, policy, and cleanup outcomes stay classified", async () => {
  const harnessFailure = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "failed", failureClass: "infrastructure", reason: "process crashed" }),
  });
  assert.equal(harnessFailure.terminal.failureClass, "infrastructure");

  const policyStop = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "stopped", stopReason: "policy", reason: "approval required" }),
  });
  assert.equal(policyStop.terminal.stopReason, "policy");

  const cleanupFailure = await executeRunAttempt({
    run,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: async () => { throw new Error("cleanup unavailable"); },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
  });
  assert.equal(cleanupFailure.terminal.failureClass, "infrastructure");
  assert.equal(cleanupFailure.record.cleanup?.status, "failed");
});

test("a harness cannot declare a task failure without verifier evidence", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "failed", failureClass: "task", reason: "unverified task result" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.classification.source, "harness");
});

test("setup failures are infrastructure failures and still clean up", async () => {
  let cleaned = false;
  const result = await executeRunAttempt({
    run,
    workspace: {
      setup: async () => { throw new Error("setup unavailable"); },
      cleanup: async () => { cleaned = true; },
    },
    harness: async () => { throw new Error("must not run"); },
  });
  assert.equal(result.terminal.state, "failed");
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(cleaned, true);
});

test("budget and interruption stop an attempt without retrying it", async () => {
  let harnessCalls = 0;
  const budget = await executeRunAttempt({
    run,
    maxWallClockMs: 20,
    workspace: workspace(),
    harness: async ({ signal }) => {
      harnessCalls += 1;
      await new Promise<void>((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(), { once: true }));
      return { status: "interrupted" };
    },
  });
  assert.equal(budget.terminal.state, "stopped");
  assert.equal(budget.terminal.stopReason, "budget");

  const controller = new AbortController();
  const interruptedPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    workspace: workspace(),
    harness: async ({ signal }) => {
      await new Promise<void>((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(), { once: true }));
      return { status: "interrupted" };
    },
  });
  controller.abort();
  const interrupted = await interruptedPromise;
  assert.equal(interrupted.terminal.state, "interrupted");
  assert.equal(interrupted.terminal.failureClass, "infrastructure");
  assert.equal(harnessCalls, 1);
});

test("a workspace that settles during interruption is retained for cleanup and evidence", async () => {
  const controller = new AbortController();
  let cleanedWorkspace: string | undefined;
  const runPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    shutdownGraceMs: 100,
    workspace: {
      setup: async () => {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
        return { status: "ready", artifactId: "late-workspace" };
      },
      cleanup: async ({ workspace: settled }) => { cleanedWorkspace = settled?.artifactId; },
    },
    harness: async () => ({ status: "completed" }),
  });
  setTimeout(() => controller.abort(), 1);
  const result = await runPromise;
  assert.equal(result.terminal.state, "interrupted");
  assert.equal(result.record.workspace?.artifactId, "late-workspace");
  assert.equal(cleanedWorkspace, "late-workspace");
});

test("external interruption remains the first cause when budget expires during settling", async () => {
  const controller = new AbortController();
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    maxWallClockMs: 10,
    shutdownGraceMs: 100,
    workspace: {
      setup: async () => {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 40));
        return { status: "ready", artifactId: "late-workspace" };
      },
      cleanup: async () => undefined,
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.terminal.state, "interrupted");
  assert.equal(result.terminal.stopReason, "none");
});

test("callback rejections during cancellation remain in partial evidence", async () => {
  const setupController = new AbortController();
  let setupStartedResolve: (() => void) | undefined;
  const setupStarted = new Promise<void>((resolvePromise) => { setupStartedResolve = resolvePromise; });
  const setupRun = executeRunAttempt({
    run,
    signal: setupController.signal,
    shutdownGraceMs: 50,
    workspace: {
      setup: async () => {
        setupStartedResolve?.();
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
        throw new Error("setup rejected");
      },
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  await setupStarted;
  setupController.abort();
  const setupResult = await setupRun;
  assert.equal(setupResult.record.workspace?.error, "setup rejected");

  const verifierController = new AbortController();
  let verifierStartedResolve: (() => void) | undefined;
  const verifierStarted = new Promise<void>((resolvePromise) => { verifierStartedResolve = resolvePromise; });
  const verifierRun = executeRunAttempt({
    run,
    signal: verifierController.signal,
    shutdownGraceMs: 50,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => {
      verifierStartedResolve?.();
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      throw new Error("verifier rejected");
    },
    evidence: { flush: () => undefined },
  });
  await verifierStarted;
  verifierController.abort();
  const verifierResult = await verifierRun;
  assert.equal(verifierResult.record.verifier?.error, "verifier rejected");
});

test("the harness is not launched after the coordinator deadline", async () => {
  let harnessCalled = false;
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 1,
    workspace: {
      setup: async () => {
        const end = Date.now() + 5;
        while (Date.now() < end) {}
        return { status: "ready", artifactId: "workspace-1" };
      },
      cleanup: async () => undefined,
    },
    harness: async () => { harnessCalled = true; return { status: "completed" }; },
    evidence: { flush: () => undefined },
  });
  assert.equal(harnessCalled, false);
  assert.equal(result.terminal.stopReason, "budget");
});

test("cancellation during cleanup reaches cleanup and interrupts a successful outcome", async () => {
  const controller = new AbortController();
  let cleanupSawAbort = false;
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: async ({ signal }) => {
        controller.abort();
        cleanupSawAbort = signal.aborted;
      },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
  });
  const result = await resultPromise;
  assert.equal(cleanupSawAbort, true);
  assert.equal(result.terminal.state, "interrupted");
});

test("harness shutdown failures remain explicit in interrupted records", async () => {
  const controller = new AbortController();
  let harnessStartedResolve: (() => void) | undefined;
  const harnessStarted = new Promise<void>((resolvePromise) => { harnessStartedResolve = resolvePromise; });
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    shutdownGraceMs: 25,
    workspace: workspace(),
    harness: async ({ signal }) => {
      harnessStartedResolve?.();
      await new Promise<void>((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(), { once: true }));
      return {
        status: "interrupted",
        shutdown: () => { throw new Error("shutdown failed"); },
      };
    },
    evidence: { flush: () => undefined },
  });
  await harnessStarted;
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.terminal.state, "interrupted");
  assert.deepEqual(result.record.harness?.shutdownResult, { status: "failed", error: "shutdown failed" });
});

test("in-flight harness shutdown is available before an eventual result", async () => {
  const controller = new AbortController();
  let harnessStartedResolve: (() => void) | undefined;
  const harnessStarted = new Promise<void>((resolvePromise) => { harnessStartedResolve = resolvePromise; });
  let shutdownCalls = 0;
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    shutdownGraceMs: 25,
    workspace: workspace(),
    harness: async ({ signal, registerShutdown }) => {
      registerShutdown(() => { shutdownCalls += 1; });
      harnessStartedResolve?.();
      await new Promise<void>(() => undefined);
      return { status: "completed" };
    },
    evidence: { flush: () => undefined },
  });
  await harnessStarted;
  controller.abort();
  const result = await resultPromise;
  assert.equal(shutdownCalls, 1);
  assert.deepEqual(result.record.harness?.shutdownResult, { status: "completed" });
  assert.equal(result.terminal.state, "interrupted");
});

test("cleanup receives a workspace snapshot and cannot rewrite retained evidence", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1", evidence: { owner: "setup" } }),
      cleanup: async ({ workspace: cleanupWorkspace }) => {
        if (cleanupWorkspace !== undefined) {
          cleanupWorkspace.artifactId = "rewritten";
          (cleanupWorkspace.evidence as { owner: string }).owner = "cleanup";
        }
      },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.record.workspace?.artifactId, "workspace-1");
  assert.deepEqual(result.record.workspace?.evidence, { owner: "setup" });
});

test("verifier results are snapshotted before cleanup can mutate them", async () => {
  let verifierResult: { status: "passed" | "failed" } = { status: "passed" };
  const result = await executeRunAttempt({
    run,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: async () => { verifierResult.status = "failed"; },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => verifierResult,
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.state, "completed");
  assert.equal(result.record.verifier?.status, "passed");
});

test("a hanging evidence flush is bounded by cancellation grace", async () => {
  const startedAt = Date.now();
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 10,
    shutdownGraceMs: 10,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => new Promise<void>(() => undefined) },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.ok(Date.now() - startedAt < 100);
  assert.equal(result.record.capture?.status, "incomplete");
});

test("a flush that completes during cancellation grace remains complete", async () => {
  let flushes = 0;
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 10,
    shutdownGraceMs: 50,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    evidence: {
      flush: async () => {
        flushes += 1;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, flushes === 1 ? 20 : 0));
      },
    },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.record.capture?.status, "complete");
});

test("cleanup timeout is retained and prevents false completion", async () => {
  const controller = new AbortController();
  const result = await executeRunAttempt({
    run,
    shutdownGraceMs: 10,
    signal: controller.signal,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: async () => {
        controller.abort();
        return new Promise<void>(() => undefined);
      },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.record.cleanup?.status, "timed-out");
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.classification.source, "cleanup");
});

test("a verifier result that settles during interruption remains in the partial record", async () => {
  const controller = new AbortController();
  let verifierStartedResolve: (() => void) | undefined;
  const verifierStarted = new Promise<void>((resolvePromise) => { verifierStartedResolve = resolvePromise; });
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    shutdownGraceMs: 100,
    workspace: workspace({ status: "ready" }),
    harness: async () => ({ status: "completed" }),
    verifier: async () => {
      verifierStartedResolve?.();
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
      return { status: "passed", evidence: { completed: true } };
    },
    evidence: { flush: () => undefined },
  });
  await verifierStarted;
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.terminal.state, "interrupted");
  assert.equal(result.record.verifier?.status, "passed");
});

test("an already-aborted signal is retained as an interruption", async () => {
  const controller = new AbortController();
  controller.abort();
  let setupSawAbort = false;
  const result = await executeRunAttempt({
    run,
    signal: controller.signal,
    workspace: {
      setup: async ({ signal }) => { setupSawAbort = signal.aborted; return { status: "ready" }; },
      cleanup: async () => undefined,
    },
    harness: async () => ({ status: "completed" }),
  });
  assert.equal(setupSawAbort, true);
  assert.equal(result.terminal.state, "interrupted");
});

test("a missing verifier is recorded as not-run instead of a false completion", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.record.verifier?.status, "not-run");
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.classification.kind, "verifier-error");
});

test("completion requires a retained workspace artifact", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace({ status: "ready" }),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.classification.source, "workspace");
});

test("task-failed terminals require a retained workspace artifact", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace({ status: "ready" }),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "failed", error: "assertion failed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.classification.source, "workspace");
});

test("failure terminals omit explicitly unretained workspace IDs", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace({ status: "ready", artifactId: "workspace-1", retained: false }),
    harness: async () => ({ status: "failed", failureClass: "infrastructure" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.terminal.workspaceArtifactId, undefined);
});

test("run identity fields are validated before callbacks execute", async () => {
  let setupCalled = false;
  const invalidRun = { ...run, taskId: "" };
  await assert.rejects(executeRunAttempt({
    run: invalidRun,
    workspace: {
      setup: async () => { setupCalled = true; return { status: "ready", artifactId: "workspace-1" }; },
    },
    harness: async () => ({ status: "completed" }),
  }), /Task ID/);
  assert.equal(setupCalled, false);
});

test("callbacks cannot mutate the identities retained by an attempt", async () => {
  const suppliedRun = createRunIdentity({ taskId: "task-original", modelId: "model-original", harnessId: "harness-original" });
  const result = await executeRunAttempt({
    run: suppliedRun,
    workspace: {
      setup: async ({ run: callbackRun, attempt: callbackAttempt }) => {
        callbackRun.id = "mutated-run";
        callbackRun.taskId = "mutated-task";
        callbackAttempt.id = "mutated-attempt";
        return { status: "ready", artifactId: "workspace-1" };
      },
    },
    harness: async ({ run: callbackRun, attempt: callbackAttempt }) => {
      callbackRun.modelId = "mutated-model";
      callbackAttempt.number = 99;
      return { status: "completed" };
    },
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.run.id, suppliedRun.id);
  assert.equal(result.run.taskId, "task-original");
  assert.equal(result.run.modelId, "model-original");
  assert.equal(result.attempt.number, 1);
  assert.equal(result.record.run.harnessId, "harness-original");
});

test("retry creates a new linked identity and never replaces the prior attempt", () => {
  const first = createAttemptIdentity(run.id, 1, "attempt-1");
  const second = retryAttempt(first, "attempt-2");
  assert.deepEqual(second, { id: "attempt-2", number: 2, retryOf: "attempt-1" });
  assert.notEqual(second.id, first.id);
  assert.throws(() => createAttemptIdentity(run.id, 2, "attempt-2"), /retryOf/);
});

test("supplied attempt identities are validated before execution", async () => {
  await assert.rejects(executeRunAttempt({
    run,
    attempt: { id: "attempt-2", number: 2 },
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
  }), /retryOf/);
});

test("attempt persistence rejects replacing another attempt's record", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-record-"));
  try {
    const path = join(root, "attempt.json");
    const first = {
      schemaVersion: "ebo.attempt/v1" as const,
      run,
      attempt: createAttemptIdentity(run.id, 1, "first"),
      lifecycle: new LifecycleController().snapshot(),
      partial: true,
    };
    const second = { ...first, attempt: createAttemptIdentity(run.id, 1, "second") };
    await writeAttemptRecord(path, first);
    await assert.rejects(writeAttemptRecord(path, second), /another attempt/);
    assert.equal((await readAttemptRecord(path)).attempt.id, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attempt persistence rejects reopening a terminal attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-terminal-overwrite-"));
  try {
    const path = join(root, "attempt.json");
    const terminal = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    await writeAttemptRecord(path, terminal.record);
    await assert.rejects(writeAttemptRecord(path, {
      schemaVersion: "ebo.attempt/v1",
      run,
      attempt: terminal.attempt,
      lifecycle: new LifecycleController().snapshot(),
      partial: true,
    }), /already terminal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution rejects an owned record path before invoking callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-owned-path-"));
  try {
    const path = join(root, "attempt.json");
    const first = await executeRunAttempt({
      run,
      recordPath: path,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    let setupCalled = false;
    await assert.rejects(executeRunAttempt({
      run,
      attempt: first.attempt,
      recordPath: path,
      workspace: {
        setup: async () => { setupCalled = true; return { status: "ready", artifactId: "workspace-1" }; },
      },
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    }), /already owned/);
    assert.equal(setupCalled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attempt paths are reserved before concurrent callbacks can start", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-reservation-"));
  try {
    const path = join(root, "attempt.json");
    let setupCalls = 0;
    const options = {
      run,
      recordPath: path,
      workspace: {
        setup: async () => { setupCalls += 1; return { status: "ready" as const, artifactId: "workspace-1" }; },
      },
      harness: async () => ({ status: "completed" as const }),
      verifier: async () => ({ status: "passed" as const }),
      evidence: { flush: () => undefined },
    };
    const results = await Promise.allSettled([executeRunAttempt(options), executeRunAttempt(options)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(setupCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an initial checkpoint failure prevents workspace and harness callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-initial-checkpoint-"));
  try {
    const parentFile = join(root, "parent");
    writeFileSync(parentFile, "not a directory");
    let setupCalled = false;
    let harnessCalled = false;
    await assert.rejects(executeRunAttempt({
      run,
      recordPath: join(parentFile, "attempt.json"),
      workspace: { setup: async () => { setupCalled = true; return { status: "ready", artifactId: "workspace-1" }; } },
      harness: async () => { harnessCalled = true; return { status: "completed" }; },
    }), /ENOTDIR|checkpoint|directory/);
    assert.equal(setupCalled, false);
    assert.equal(harnessCalled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record persistence failure does not bypass cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-persist-"));
  let cleaned = false;
  try {
    const result = await executeRunAttempt({
      run,
      recordPath: join(root, "attempt.json"),
      workspace: {
        setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
        cleanup: async () => {
          cleaned = true;
          rmSync(join(root, "attempt.json"), { force: true });
          mkdirSync(join(root, "attempt.json"));
        },
      },
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    assert.equal(cleaned, true);
    assert.equal(result.terminal.failureClass, "infrastructure");
    assert.equal(result.record.persistence?.status, "incomplete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attempt records are validated when read", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-invalid-record-"));
  try {
    const path = join(root, "invalid.json");
    writeFileSync(path, "{}\n");
    await assert.rejects(readAttemptRecord(path), /schemaVersion|run|attempt|lifecycle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal attempt records require matching terminal classification", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-terminal-record-"));
  try {
    const path = join(root, "terminal.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: "ebo.attempt/v1",
      run,
      attempt: createAttemptIdentity(run.id, 1, "attempt-1"),
      lifecycle: {
        state: "terminal",
        createdAt: "a",
        startedAt: "b",
        timestamps: { created: "a", setup: "b", running: "c", verifying: "d", cleaning: "e", terminal: "f" },
        transitions: [
          { from: "created", to: "setup", at: "b" },
          { from: "setup", to: "running", at: "c" },
          { from: "running", to: "verifying", at: "d" },
          { from: "verifying", to: "cleaning", at: "e" },
          { from: "cleaning", to: "terminal", at: "f" },
        ],
      },
      partial: true,
    }));
    await assert.rejects(readAttemptRecord(path), /terminal and classification/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable validation rejects classification kinds that contradict terminals", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-kind-record-"));
  try {
    const path = join(root, "contradictory.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: "ebo.attempt/v1",
      run,
      attempt: createAttemptIdentity(run.id, 1, "attempt-1"),
      lifecycle: {
        state: "terminal",
        createdAt: "a",
        startedAt: "b",
        timestamps: { created: "a", setup: "b", running: "c", verifying: "d", cleaning: "e", terminal: "f" },
        transitions: [
          { from: "created", to: "setup", at: "b" },
          { from: "setup", to: "running", at: "c" },
          { from: "running", to: "verifying", at: "d" },
          { from: "verifying", to: "cleaning", at: "e" },
          { from: "cleaning", to: "terminal", at: "f" },
        ],
      },
      terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none" },
      classification: { kind: "completed", terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none" } },
      partial: true,
    }));
    await assert.rejects(readAttemptRecord(path), /classification kind/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture flush failures are explicit and do not masquerade as task failures", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => { throw new Error("evidence sink closed"); } },
  });
  assert.equal(result.terminal.state, "completed");
  assert.equal(result.classification.kind, "capture-incomplete");
  assert.equal(result.classification.underlying, "completed");
  assert.equal(result.record.capture?.status, "incomplete");
  assert.equal(result.record.partial, true);
});

test("capture failure keeps unsuccessful attempts partial", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "failed", error: "assertion failed" }),
    evidence: { flush: () => { throw new Error("capture unavailable"); } },
  });
  assert.equal(result.classification.kind, "capture-incomplete");
  assert.equal(result.classification.underlying, "task-failure");
  assert.equal(result.record.partial, true);
});

test("a final capture failure is classified before the durable terminal record", async () => {
  let flushes = 0;
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: {
      flush: () => {
        flushes += 1;
        if (flushes === 4) throw new Error("final capture unavailable");
      },
    },
  });
  assert.equal(result.classification.kind, "capture-incomplete");
  assert.equal(result.record.classification?.kind, "capture-incomplete");
  assert.equal(result.record.capture?.status, "incomplete");
});

test("a stopped harness without a reason is not silently treated as a budget stop", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "stopped" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.notEqual(result.terminal.stopReason, "budget");
});

test("a synchronously over-budget harness is stopped before its result is accepted", async () => {
  const result = await executeRunAttempt({
    run,
    harnessBudgetMs: 1,
    workspace: workspace(),
    harness: () => {
      const end = Date.now() + 5;
      while (Date.now() < end) {}
      return { status: "completed" };
    },
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
});

test("a synchronously over-budget verifier cannot produce completion", async () => {
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 1,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: () => {
      const end = Date.now() + 5;
      while (Date.now() < end) {}
      return { status: "passed" };
    },
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
});
