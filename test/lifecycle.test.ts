import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

test("lifecycle rejects empty timestamps before recording state", () => {
  assert.throws(() => new LifecycleController(() => ""), /Lifecycle created timestamp/);
  const lifecycle = new LifecycleController(() => "created");
  assert.throws(() => lifecycle.transition("setup", ""), /Lifecycle transition timestamp/);
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

test("verifier errors shut down their registered helper", async () => {
  let shutdownCalls = 0;
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async ({ registerShutdown }) => {
      registerShutdown(async () => { shutdownCalls += 1; });
      return { status: "error", error: "verifier failed" };
    },
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(shutdownCalls, 1);
  assert.equal(result.record.verifierTerminationConfirmed, true);
});

test("verifier task failures with failed shutdown retain verifier-error provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-verifier-shutdown-failure-"));
  try {
    const recordPath = join(root, "attempt.json");
    const result = await executeRunAttempt({
      run,
      recordPath,
      shutdownGraceMs: 10,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({
        status: "failed",
        error: "assertion failed",
        shutdownResult: { status: "failed" as const, error: "verifier shutdown failed" },
      }),
      evidence: { flush: () => undefined },
    });
    assert.equal(result.classification.kind, "verifier-error");
    assert.equal(result.terminal.failureClass, "infrastructure");
    assert.equal(result.record.verifier?.status, "error");
    assert.equal((result.record.verifier?.evidence as { nativeStatus?: string }).nativeStatus, "failed");
    assert.equal(result.record.verifier?.shutdownResult?.status, "failed");
    assert.equal(result.record.cleanup?.status, "timed-out");
    assert.equal((await readAttemptRecord(recordPath)).classification?.kind, "verifier-error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passed verifier results reject an error field", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed", error: "verification failed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.record.verifier?.status, "error");
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
  assert.equal(policyStop.terminal.workspaceArtifactId, "workspace-1");
  assert.equal(policyStop.terminal.workspaceArtifactId, "workspace-1");

  const harnessInterrupt = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "interrupted", reason: "harness closed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(harnessInterrupt.classification.source, "harness");
  assert.equal(harnessInterrupt.terminal.workspaceArtifactId, "workspace-1");
  assert.equal(harnessInterrupt.terminal.workspaceArtifactId, "workspace-1");

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

test("non-success harness results shut down their registered helper", async () => {
  let shutdownCalls = 0;
  let cleanupCalls = 0;
  const result = await executeRunAttempt({
    run,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: async () => { cleanupCalls += 1; },
    },
    harness: async ({ registerShutdown }) => {
      registerShutdown(async () => { shutdownCalls += 1; });
      return { status: "failed", failureClass: "infrastructure", reason: "harness failed" };
    },
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(shutdownCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(result.record.harnessTerminationConfirmed, true);
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

test("synchronous setup errors honor an elapsed coordinator budget", async () => {
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 1,
    workspace: {
      setup: () => {
        const end = Date.now() + 5;
        while (Date.now() < end) {}
        throw new Error("setup failed after deadline");
      },
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
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
  assert.equal(result.terminal.workspaceArtifactId, "late-workspace");
  assert.equal(result.record.workspace?.artifactId, "late-workspace");
  assert.equal(cleanedWorkspace, "late-workspace");
});

test("cancellation shuts down a setup helper after setup settles", async () => {
  const controller = new AbortController();
  let setupStartedResolve: (() => void) | undefined;
  const setupStarted = new Promise<void>((resolvePromise) => { setupStartedResolve = resolvePromise; });
  let shutdownCalls = 0;
  let cleanupCalls = 0;
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    shutdownGraceMs: 100,
    workspace: {
      setup: async ({ registerShutdown }) => {
        registerShutdown(async () => { shutdownCalls += 1; });
        setupStartedResolve?.();
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
        return { status: "ready", artifactId: "settled-workspace" };
      },
      cleanup: async () => { cleanupCalls += 1; },
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  await setupStarted;
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.terminal.state, "interrupted");
  assert.equal(shutdownCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(result.record.workspace?.shutdownResult?.status, "completed");
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

test("unsettled workspace setup is not cleaned while its callback remains live", async () => {
  const controller = new AbortController();
  let cleanupCalled = false;
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    shutdownGraceMs: 10,
    workspace: {
      setup: async () => new Promise<{ status: "ready" }>(() => undefined),
      cleanup: async () => { cleanupCalled = true; },
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
  controller.abort();
  const result = await resultPromise;
  assert.equal(cleanupCalled, false);
  assert.equal(result.record.cleanup?.status, "timed-out");
  assert.equal(result.terminal.state, "interrupted");
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

test("a rejected harness still receives its registered shutdown", async () => {
  let shutdownCalls = 0;
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async ({ registerShutdown }) => {
      registerShutdown(() => { shutdownCalls += 1; });
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      throw new Error("harness rejected");
    },
    evidence: { flush: () => undefined },
  });
  assert.equal(shutdownCalls, 1);
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.record.harness?.shutdownResult?.status, "completed");
});

test("a rejected workspace setup still receives its registered shutdown", async () => {
  let shutdownCalls = 0;
  const result = await executeRunAttempt({
    run,
    workspace: {
      setup: async ({ registerShutdown }) => {
        registerShutdown(() => { shutdownCalls += 1; });
        throw new Error("workspace setup rejected");
      },
      cleanup: async () => undefined,
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(shutdownCalls, 1);
  assert.equal(result.record.workspace?.error, "workspace setup rejected");
  assert.equal(result.record.workspace?.shutdownResult?.status, "completed");
  assert.equal(result.record.cleanup?.status, "completed");
  assert.equal(result.terminal.failureClass, "infrastructure");
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
      setup: async () => ({ status: "ready", artifactId: "workspace-1", evidence: { owner: "setup" }, shutdownResult: { status: "completed" as const } }),
      cleanup: async ({ workspace: cleanupWorkspace }) => {
        if (cleanupWorkspace !== undefined) {
          cleanupWorkspace.artifactId = "rewritten";
          (cleanupWorkspace.evidence as { owner: string }).owner = "cleanup";
          cleanupWorkspace.shutdownResult!.status = "failed";
        }
      },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.record.workspace?.artifactId, "workspace-1");
  assert.deepEqual(result.record.workspace?.evidence, { owner: "setup" });
  assert.equal(result.record.workspace?.shutdownResult?.status, "completed");
});

test("a failed workspace setup shuts down its registered helper before cleanup", async () => {
  let shutdownCalls = 0;
  let cleanupCalls = 0;
  const result = await executeRunAttempt({
    run,
    shutdownGraceMs: 50,
    workspace: {
      setup: async ({ registerShutdown }) => {
        registerShutdown(async () => { shutdownCalls += 1; });
        return { status: "failed", error: "materialization failed" };
      },
      cleanup: async () => { cleanupCalls += 1; },
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(shutdownCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(result.record.workspace?.shutdownResult?.status, "completed");
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

test("harness evidence is snapshotted before verifier execution", async () => {
  const harnessResult = { status: "completed" as const, evidence: { state: "before" } };
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => harnessResult,
    verifier: async () => {
      harnessResult.evidence.state = "after";
      return { status: "passed" };
    },
    evidence: { flush: () => undefined },
  });
  assert.deepEqual(result.record.harness?.evidence, { state: "before" });
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

test("a synchronous cleanup past the coordinator budget is stopped", async () => {
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 1,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: () => {
        const end = Date.now() + 5;
        while (Date.now() < end) {}
      },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
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

test("an unsettled verifier is not allowed to race workspace cleanup", async () => {
  const controller = new AbortController();
  let verifierStartedResolve: (() => void) | undefined;
  const verifierStarted = new Promise<void>((resolvePromise) => { verifierStartedResolve = resolvePromise; });
  let cleanupCalled = false;
  const resultPromise = executeRunAttempt({
    run,
    signal: controller.signal,
    shutdownGraceMs: 10,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: async () => { cleanupCalled = true; },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => {
      verifierStartedResolve?.();
      await new Promise<void>(() => undefined);
      return { status: "passed" };
    },
    evidence: { flush: () => undefined },
  });
  await verifierStarted;
  controller.abort();
  const result = await resultPromise;
  assert.equal(cleanupCalled, false);
  assert.equal(result.record.verifierTerminationConfirmed, false);
  assert.equal(result.record.cleanup?.status, "timed-out");
  assert.equal(result.terminal.state, "interrupted");
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
  assert.equal(setupSawAbort, false);
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

test("infrastructure failures retain links to explicitly retained failed workspaces", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace({ status: "failed", artifactId: "partial-workspace", retained: true }),
    harness: async () => ({ status: "failed", failureClass: "infrastructure", reason: "setup incomplete" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.terminal.workspaceArtifactId, "partial-workspace");
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

test("invalid shutdown grace periods are rejected before callbacks execute", async () => {
  let setupCalled = false;
  for (const shutdownGraceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(executeRunAttempt({
      run,
      shutdownGraceMs,
      workspace: {
        setup: async () => { setupCalled = true; return { status: "ready", artifactId: "workspace-1" }; },
      },
      harness: async () => ({ status: "completed" }),
    }), /Shutdown grace period/);
  }
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

test("attempt persistence rejects stale lifecycle checkpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-stale-checkpoint-"));
  try {
    const path = join(root, "attempt.json");
    const lifecycle = new LifecycleController(() => "created");
    lifecycle.transition("setup", "setup");
    lifecycle.transition("running", "running");
    const current = {
      schemaVersion: "ebo.attempt/v1" as const,
      run,
      attempt: createAttemptIdentity(run.id, 1, "attempt-1"),
      lifecycle: lifecycle.snapshot(),
      partial: true,
      workspace: { status: "ready" as const, artifactId: "workspace-1" },
    };
    await writeAttemptRecord(path, current);
    await assert.rejects(writeAttemptRecord(path, {
      ...current,
      workspace: { status: "ready", artifactId: "rewritten-workspace" },
    }), /changes retained workspace evidence/);
    const { workspace: _workspace, ...currentWithoutWorkspace } = current;
    const stale = {
      ...currentWithoutWorkspace,
      lifecycle: new LifecycleController(() => "created").snapshot(),
    };
    await assert.rejects(writeAttemptRecord(path, stale), /regresses lifecycle progress/);
    assert.equal((await readAttemptRecord(path)).lifecycle.state, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed harness results reject contradictory failure and stop fields", async () => {
  const failureField = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed", failureClass: "task" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  const stopField = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed", stopReason: "budget" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(failureField.terminal.failureClass, "infrastructure");
  assert.equal(stopField.terminal.failureClass, "infrastructure");
});

test("non-completed harness results reject fields owned by another status", async () => {
  const stoppedWithFailure = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "stopped", failureClass: "task", stopReason: "budget" }),
    evidence: { flush: () => undefined },
  });
  const failedWithStop = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "failed", failureClass: "infrastructure", stopReason: "policy" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(stoppedWithFailure.terminal.failureClass, "infrastructure");
  assert.equal(failedWithStop.terminal.failureClass, "infrastructure");
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

test("concurrent terminal publication has one winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-terminal-race-"));
  try {
    const path = join(root, "attempt.json");
    const terminal = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const first = structuredClone(terminal.record);
    const second = structuredClone(terminal.record);
    (second.classification as { reason?: string }).reason = "different writer";
    const results = await Promise.allSettled([
      writeAttemptRecord(path, first),
      writeAttemptRecord(path, second),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
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

test("attempt records reject lifecycle timestamps that disagree with transitions", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-timestamps-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const path = join(root, "invalid-timestamps.json");
    const record = structuredClone(result.record);
    record.lifecycle.timestamps.running = "wrong";
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /timestamp disagrees/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attempt checkpoints remain partial before terminal state", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-partial-checkpoint-"));
  try {
    const path = join(root, "checkpoint.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: "ebo.attempt/v1",
      run,
      attempt: createAttemptIdentity(run.id, 1, "attempt-1"),
      lifecycle: new LifecycleController(() => "created").snapshot(),
      partial: false,
    }));
    await assert.rejects(readAttemptRecord(path), /Nonterminal attempt records must remain partial/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture-incomplete classifications require incomplete capture evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-capture-classification-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    record.classification = {
      kind: "capture-incomplete",
      underlying: "completed",
      terminal: structuredClone(result.terminal),
    };
    record.capture = { status: "complete" };
    record.partial = false;
    const path = join(root, "contradictory-capture.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /Capture-incomplete classifications require/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal attempt records require explicit capture status", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-terminal-capture-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    delete record.capture;
    const path = join(root, "missing-capture.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /explicit capture status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal incomplete capture requires a capture-incomplete classification", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-capture-wrapper-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    record.capture = { status: "incomplete", error: "capture failed" };
    record.partial = true;
    const path = join(root, "missing-capture-wrapper.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /capture-incomplete classification/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed attempt records require harness and verification lifecycle phases", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-completed-phases-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    const lifecycle = new LifecycleController(() => "created");
    lifecycle.transition("setup", "setup");
    lifecycle.transition("cleaning", "cleaning");
    lifecycle.transition("terminal", "terminal");
    record.lifecycle = lifecycle.snapshot();
    delete record.harness;
    const path = join(root, "missing-phases.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /running and verifying lifecycle phases/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task-failure attempt records require harness execution phases", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-task-phases-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "failed", error: "assertion failed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    const lifecycle = new LifecycleController(() => "created");
    lifecycle.transition("setup", "setup");
    lifecycle.transition("cleaning", "cleaning");
    lifecycle.transition("terminal", "terminal");
    record.lifecycle = lifecycle.snapshot();
    const path = join(root, "missing-task-phases.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /Task-failure terminal records require/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained workspace evidence must be linked from partial terminals", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-partial-link-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    record.terminal = { state: "interrupted", failureClass: "infrastructure", stopReason: "none" };
    record.classification = { kind: "interrupted", source: "runner", terminal: structuredClone(record.terminal) };
    record.partial = true;
    const path = join(root, "missing-partial-link.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /Retained workspace evidence must be linked/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy-stop records require native stopped harness evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-policy-evidence-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "stopped", stopReason: "policy", reason: "approval required" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    delete record.harness;
    const path = join(root, "missing-policy-harness.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /matching stopped harness result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harness budget-stop records require compatible harness evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-budget-evidence-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "stopped", stopReason: "budget", reason: "harness budget" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    delete record.harness;
    const path = join(root, "missing-budget-harness.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /compatible harness evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harness interruption records require native interrupted harness evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-interruption-evidence-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "interrupted", reason: "harness interrupted" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    delete record.harness;
    const path = join(root, "missing-interruption-harness.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /interrupted harness result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("harness infrastructure failures require native failed harness evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-harness-failure-evidence-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "failed", failureClass: "infrastructure", reason: "harness failed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    delete record.harness;
    const path = join(root, "missing-harness-failure.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /failed or unreasoned stopped harness result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreasoned harness stops remain validator-compatible", async () => {
  const result = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "stopped" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.failureClass, "infrastructure");
  assert.equal(result.record.harness?.status, "stopped");
});

test("verifier-error terminals require native verifier evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-verifier-error-evidence-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "error", error: "verifier failed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    delete record.verifier;
    const path = join(root, "missing-verifier-error.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /error or not-run verifier result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifier-error terminals require a viable workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-verifier-workspace-evidence-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "error", error: "verifier failed" }),
      evidence: { flush: () => undefined },
    });
    for (const [name, replacement, errorPattern] of [
      ["failed", { status: "failed", artifactId: "workspace-1", retained: true }, /ready workspace/],
      ["shutdown-failed", { status: "ready", artifactId: "workspace-1", shutdownResult: { status: "failed", error: "workspace shutdown failed" } }, /confirmed workspace/],
    ] as const) {
      const record = structuredClone(result.record);
      record.workspace = replacement;
      const path = join(root, `${name}.json`);
      writeFileSync(path, `${JSON.stringify(record)}\n`);
      await assert.rejects(readAttemptRecord(path), errorPattern);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed terminal records reject incomplete persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-persistence-status-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    record.persistence = { status: "incomplete", error: "publication failed" };
    const path = join(root, "incomplete-persistence.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /incomplete persistence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup-origin failures require failed or timed-out cleanup evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-cleanup-evidence-"));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: {
        setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
        cleanup: async () => { throw new Error("cleanup failed"); },
      },
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    const record = structuredClone(result.record);
    record.cleanup = { status: "completed" };
    const path = join(root, "invalid-cleanup-evidence.json");
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    await assert.rejects(readAttemptRecord(path), /failed or timed-out cleanup evidence/);
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
        endedAt: "f",
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
        endedAt: "f",
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

test("durable validation rejects malformed optional outcome evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-evidence-record-"));
  try {
    const path = join(root, "malformed.json");
    writeFileSync(path, JSON.stringify({
      schemaVersion: "ebo.attempt/v1",
      run,
      attempt: createAttemptIdentity(run.id, 1, "attempt-1"),
      lifecycle: new LifecycleController().snapshot(),
      harness: 17,
      partial: true,
    }));
    await assert.rejects(readAttemptRecord(path), /harness evidence/);
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

test("post-budget harness completion is durably retained as a budget stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-budget-completion-"));
  try {
    const recordPath = join(root, "attempt.json");
    const result = await executeRunAttempt({
      run,
      recordPath,
      harnessBudgetMs: 1,
      workspace: workspace(),
      harness: () => {
        const end = Date.now() + 5;
        while (Date.now() < end) {}
        return { status: "completed", completionEvidence: { completed: true } };
      },
      evidence: { flush: () => undefined },
    });
    assert.equal(result.terminal.state, "stopped");
    assert.equal(result.terminal.stopReason, "budget");
    assert.equal(result.record.harness?.status, "stopped");
    assert.equal(result.record.harness?.stopReason, "budget");
    assert.equal((await readAttemptRecord(recordPath)).terminal?.stopReason, "budget");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-budget harness rejection is durably retained as a budget stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-budget-rejection-"));
  try {
    const recordPath = join(root, "attempt.json");
    const result = await executeRunAttempt({
      run,
      recordPath,
      harnessBudgetMs: 1,
      workspace: workspace(),
      harness: () => {
        const end = Date.now() + 5;
        while (Date.now() < end) {}
        throw new Error("late harness failure");
      },
      evidence: { flush: () => undefined },
    });
    assert.equal(result.terminal.state, "stopped");
    assert.equal(result.terminal.stopReason, "budget");
    assert.equal(result.record.harness?.status, "stopped");
    assert.equal(result.record.harness?.stopReason, "budget");
    assert.equal(result.record.harness?.error, "late harness failure");
    assert.equal((await readAttemptRecord(recordPath)).terminal?.stopReason, "budget");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("synchronous verifier errors honor an elapsed coordinator budget", async () => {
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 1,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: () => {
      const end = Date.now() + 5;
      while (Date.now() < end) {}
      throw new Error("verifier failed after deadline");
    },
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
});

test("a synchronous final flush honors an elapsed coordinator budget", async () => {
  let flushes = 0;
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 10,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: {
      flush: () => {
        flushes += 1;
        if (flushes >= 4) {
          const end = Date.now() + 20;
          while (Date.now() < end) {}
        }
      },
    },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
});

test("a synchronous cleanup error honors an elapsed coordinator budget", async () => {
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 10,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: () => {
        const end = Date.now() + 20;
        while (Date.now() < end) {}
        throw new Error("cleanup failed after deadline");
      },
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
});

test("cleanup timeouts after budget preserve the budget-stop classification", async () => {
  const result = await executeRunAttempt({
    run,
    maxWallClockMs: 10,
    shutdownGraceMs: 5,
    workspace: {
      setup: async () => ({ status: "ready", artifactId: "workspace-1" }),
      cleanup: async () => new Promise<void>(() => undefined),
    },
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "passed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(result.record.cleanup?.status, "timed-out");
  assert.equal(result.terminal.state, "stopped");
  assert.equal(result.terminal.stopReason, "budget");
});

test("workspace shutdown failures gate cleanup", async () => {
  let cleanupCalls = 0;
  const result = await executeRunAttempt({
    run,
    workspace: {
      setup: async () => ({ status: "failed", artifactId: "failed-workspace", retained: true, shutdownResult: { status: "timed-out" as const } }),
      cleanup: async () => { cleanupCalls += 1; },
    },
    harness: async () => ({ status: "completed" }),
    evidence: { flush: () => undefined },
  });
  assert.equal(cleanupCalls, 0);
  assert.equal(result.record.workspace?.shutdownResult?.status, "timed-out");
  assert.equal(result.record.cleanup?.status, "timed-out");
});

test("lifecycle clock failures still release attempt resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-lifecycle-clock-failure-"));
  let calls = 0;
  try {
    const recordPath = join(root, "attempt.json");
    const result = await executeRunAttempt({
      run,
      recordPath,
      now: () => {
        calls += 1;
        if (calls >= 6) throw new Error("clock failed");
        return `timestamp-${calls}`;
      },
      workspace: workspace(),
      harness: async () => ({ status: "completed" }),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });
    assert.equal(result.terminal.failureClass, "infrastructure");
    assert.equal((await readAttemptRecord(recordPath)).lifecycle.state, "terminal");
    assert.equal(existsSync(`${recordPath}.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
