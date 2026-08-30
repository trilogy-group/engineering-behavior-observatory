import { strict as assert } from "node:assert";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
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

function workspace(result: { status: "ready" | "failed" } = { status: "ready" }) {
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

test("verifier task failures and verifier errors remain distinct", async () => {
  const taskFailure = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "failed", error: "assertion failed" }),
  });
  assert.equal(taskFailure.terminal.failureClass, "task");
  assert.equal(taskFailure.classification.kind, "task-failure");

  const infrastructureFailure = await executeRunAttempt({
    run,
    workspace: workspace(),
    harness: async () => ({ status: "completed" }),
    verifier: async () => ({ status: "error", error: "verifier crashed" }),
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

test("retry creates a new linked identity and never replaces the prior attempt", () => {
  const first = createAttemptIdentity(run.id, 1, "attempt-1");
  const second = retryAttempt(first, "attempt-2");
  assert.deepEqual(second, { id: "attempt-2", number: 2, retryOf: "attempt-1" });
  assert.notEqual(second.id, first.id);
  assert.throws(() => createAttemptIdentity(run.id, 2, "attempt-2"), /retryOf/);
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
});
