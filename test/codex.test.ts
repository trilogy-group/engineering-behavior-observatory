import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { gzipSync } from "node:zlib";

import {
  captureCodexAppServer,
  CODEX_APP_SERVER_VERSION,
  describeAndValidateCodexDataset,
  normalizeCodexCapture,
  type CodexAppServerCapture,
  type CodexAppServerConfiguration,
} from "../src/codex.js";
import { captureCodexAppServerRun, runCodexQueueEntry, CODEX_CONTRACT_DIGEST } from "../src/codex-run.js";
import { RunBundleAssembler, type RunBundleDefinition, type RunManifest } from "../src/run-bundles.js";
import {
  buildCorpusIndex,
  compileRunQueue,
  createPortableRunBundleExport,
  createRetainedBehaviorEvidence,
  createRetainedStructuralObservationSet,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  main,
  packPortableExport,
  readPortableRunBundleExport,
  qualifyRunBundle,
  runRetainedSemanticJudge,
  unpackPortableExport,
  validateCorpusIndex,
  writeRunQueue,
  type ExperimentConfiguration,
  type PortableExportPolicy,
  type TaskPacket,
  type SemanticJudgeRequest,
} from "../src/index.js";

const fixture = resolve("test/fixtures/codex/fake-app-server.mjs");
const contractRoot = resolve("contracts/codex-app-server-0.153.4");
const reasoningSentinel = "EBO_RAW_REASONING_SENTINEL";

test("retained 0.150.1 evidence keeps its original normalized dataset", async () => {
  const root = resolve("test/fixtures/codex/legacy-0.150.1");
  const before = await readFile(join(root, "manifest.json"));
  const evidence = await createRetainedBehaviorEvidence(root);
  const expected = JSON.parse(await readFile(resolve("test/fixtures/codex/legacy-0.150.1.dataset.json"), "utf8"));
  assert.deepEqual(evidence.dataset, expected);
  assert.equal(evidence.dataset.adapter.id, "ebo-codex-app-server-v0.150.1");
  assert.deepEqual(await readFile(join(root, "manifest.json")), before);
});

test("new capture rejects the older runtime declaration before launching", async () => {
  await assert.rejects(captureCodexAppServer({ runId: "fixture", attemptId: "fixture", workspacePath: tmpdir(), evidencePath: tmpdir(), prompt: "fixture",
    configuration: { ...fakeConfiguration("success"), version: "0.150.1" as typeof CODEX_APP_SERVER_VERSION },
  }), /requires pinned runtime 0\.153\.4/u);
});

for (const mode of ["sandbox-implicit-cwd", "sandbox-cwd-mismatch"]) {
  test(`checks the effective cwd with native ${mode} sandbox roots`, async () => {
    const root = await temporaryRoot();
    try {
      const capture = await runFake(root, mode);
      assert.equal(capture.gaps.some(({ kind }) => kind === "sandbox-mismatch"), mode === "sandbox-cwd-mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const mode of ["history-paginated", "history-summary", "history-not-loaded"]) {
  test(`does not claim complete native history for ${mode}`, async () => {
    const root = await temporaryRoot();
    try {
      const capture = await runFake(root, mode);
      assert.equal(capture.terminalStatus, "completed");
      assert.ok(capture.history);
      assert.ok(capture.gaps.some(({ kind }) => kind === "history-mismatch"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("approved existing-auth 0.153.4 native capture smoke", { skip: process.env.EBO_LIVE_CODEX_CAPTURE_SMOKE !== "1" }, async (context) => {
  const model = process.env.EBO_LIVE_CODEX_CAPTURE_MODEL;
  assert.ok(model, "Supply an existing authenticated model route.");
  const root = await temporaryRoot();
  try {
    const capture = await captureCodexAppServer({ runId: "synthetic-live-capture", attemptId: "synthetic-live-capture-1", workspacePath: root,
      prompt: "Synthetic test only. Create capture-proof.txt in the current workspace containing exactly EBO_SYNTHETIC_CAPTURE_OK followed by a newline, then reply done.", evidencePath: join(root, "session.jsonl"),
      configuration: { executable: "codex", version: CODEX_APP_SERVER_VERSION, provider: "openai", model, effort: "low",
        approvalPolicy: "never", sandbox: "workspace-write", telemetry: { signals: ["logs", "traces", "metrics"] } },
      signal: AbortSignal.timeout(30000), shutdownGraceMs: 3000,
    });
    assert.equal(capture.terminalStatus, "completed", JSON.stringify(capture.gaps));
    assert.equal(await readFile(join(root, "capture-proof.txt"), "utf8"), "EBO_SYNTHETIC_CAPTURE_OK\n");
    assert.ok(capture.records.some(({ record }) => record.kind === "response" && record.method === "initialize"
      && JSON.stringify(record.payload).includes(CODEX_APP_SERVER_VERSION)), "Native handshake must report the installed pinned version.");
    assert.equal(capture.gaps.some(({ kind }) => kind === "history-mismatch" || kind === "history-mode-mismatch" || kind === "history-readback"), false, JSON.stringify(capture.gaps));
    assert.equal(capture.gaps.some(({ kind }) => kind === "effort-mismatch" || kind === "sandbox-mismatch"), false, JSON.stringify(capture.gaps));
    const { dataset } = await describeAndValidateCodexDataset(capture);
    assert.equal(dataset.adapter.id, "ebo-codex-app-server-v0.153.4");
    context.diagnostic(JSON.stringify({ runtime: capture.telemetry.runtime.version, terminal: capture.terminalStatus, events: dataset.events.length,
      receipt: capture.telemetry.telemetry.receipt, gaps: capture.gaps }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("captures matching native lifecycle, interleaving, usage, history, and independent OTLP receipts", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "success", ["logs", "traces", "metrics"]);
    assert.equal(capture.threadId, "thread-1");
    assert.equal(capture.turnId, "turn-1");
    assert.equal(capture.terminalStatus, "completed");
    assert.equal(capture.process.status, "shutdown");
    assert.equal(capture.telemetry.telemetry.receipt.status, "received");
    assert.equal(capture.telemetry.runtime.userConfiguration, "isolated");
    assert.equal(capture.telemetry.effectiveConfiguration.environmentKeys.includes("LINEAR_API_KEY"), false);
    assert.equal(capture.telemetry.effectiveConfiguration.environmentKeys.includes("NODE_OPTIONS"), false);
    assert.deepEqual(Object.values(capture.telemetry.telemetry.receipt.signals).map(({ count }) => count), [1, 1, 1]);
    assert.equal(capture.telemetry.usage.final?.total.cacheWriteInputTokens, 1);
    assert.deepEqual(capture.records.map(({ record }) => record.sequence), capture.records.map((_, index) => index + 1));
    assert.ok(capture.records.some(({ record }) => record.method === "unknown/native"));

    const normalized = await normalizeCodexCapture(capture);
    assert.equal(normalized.events.filter(({ family }) => family === "tool").length, 1, "item start and deltas must not inflate tool counts");
    assert.equal(normalized.events.filter(({ family }) => family === "outcome").length, 1);
    assert.deepEqual(normalized.events.find(({ source }) => source.nativeType === "thread/tokenUsage/updated")?.attributes, {
      method: "thread/tokenUsage/updated",
      totalTokens: 14,
      inputTokens: 8,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 4,
      reasoningOutputTokens: 2,
      resourceSemantics: "cumulative-snapshot",
    });
    assert.ok(normalized.unmapped.some(({ reference }) => {
      const record = capture.records.find(({ reference: candidate }) => candidate.recordLocator === reference.recordLocator)?.record;
      return record?.method === "unknown/native";
    }));
    const { coverage } = await describeAndValidateCodexDataset(capture);
    assert.equal(coverage.records.total, capture.records.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks only successfully completed Codex file changes as mutations", async () => {
  const capture = {
    runId: "run-codex-mutations",
    attemptId: "attempt-codex-mutations",
    qualification: "qualified",
    threadId: "thread-1",
    turnId: "turn-1",
    records: ["completed", "failed"].map((status, index) => ({
      reference: { artifactId: "session", recordLocator: `line:${index + 1}` },
      record: {
        schemaVersion: "ebo.protocol-observation/v1",
        sequence: index + 1,
        observedAt: "2026-09-07T00:00:00.000Z",
        kind: "notification",
        source: "codex-app-server",
        method: "item/completed",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: `file-${index + 1}`, type: "fileChange", status },
        },
      },
    })),
  } as unknown as CodexAppServerCapture;
  const events = (await normalizeCodexCapture(capture)).events;
  assert.equal(events.find(({ attributes }) => attributes.itemId === "file-1")?.attributes.mutation, true);
  assert.equal(events.find(({ attributes }) => attributes.itemId === "file-2")?.attributes.mutation, undefined);
});

test("answers an unexpected approval with a retained unattended decline", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "approval");
    assert.equal(capture.terminalStatus, "completed");
    const request = capture.records.find(({ record }) => record.kind === "request"
      && record.source === "codex-app-server" && record.method === "item/commandExecution/requestApproval");
    const response = capture.records.find(({ record }) => record.kind === "response"
      && record.source === "ebo-codex-client" && record.id === request?.record.id);
    assert.ok(request);
    assert.deepEqual(response?.record.payload, { result: { decision: "decline" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unexpected user input without fabricating an answer or hanging", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "user-input");
    assert.equal(capture.terminalStatus, "completed");
    const request = capture.records.find(({ record }) => record.kind === "request" && record.method === "item/tool/requestUserInput");
    const response = capture.records.find(({ record }) => record.kind === "response" && record.id === request?.record.id
      && record.source === "ebo-codex-client");
    assert.ok(request);
    assert.match(String((response?.record.payload as { error?: { message?: string } })?.error?.message), /does not provide/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves non-permission server requests unmapped", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "non-permission-request");
    const normalized = await normalizeCodexCapture(capture);
    const request = capture.records.find(({ record }) => record.kind === "request" && record.method === "currentTime/read");
    assert.ok(request);
    assert.equal(normalized.events.some(({ source }) => source.nativeReference.recordLocator === request.reference.recordLocator), false);
    assert.ok(normalized.unmapped.some(({ reference }) => reference.recordLocator === request.reference.recordLocator));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves recoverable partial evidence for malformed output, auth failure, and process crash", async () => {
  for (const mode of ["malformed", "auth-failure", "crash"] as const) {
    const root = await temporaryRoot();
    try {
      const capture = await runFake(root, mode);
      assert.equal(capture.qualification, "qualified-with-gaps");
      assert.equal(capture.terminalStatus, undefined);
      assert.ok(capture.gaps.some(({ kind }) => kind === "capture-error"));
      assert.ok(capture.records.length > 0);
      if (mode === "malformed") assert.equal(capture.process.status, "malformed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("contains a child stdin pipe error as recoverable partial evidence", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "close-stdin");
    assert.equal(capture.qualification, "qualified-with-gaps");
    assert.ok(capture.gaps.some(({ kind }) => kind === "capture-error" || kind === "process-error"));
    assert.ok(capture.records.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupts the owned turn, records acknowledgement, and finishes on matching turn/completed", async () => {
  const root = await temporaryRoot();
  const controller = new AbortController();
  try {
    const promise = runFake(root, "interrupt", [], controller.signal, undefined, 2_000);
    await waitForRecord(join(root, "session.jsonl"), (record) => record.kind === "response" && record.method === "turn/start");
    controller.abort();
    const capture = await promise;
    assert.equal(capture.terminalStatus, "interrupted");
    assert.ok(capture.records.some(({ record }) => record.kind === "request" && record.method === "turn/interrupt"));
    assert.ok(capture.records.some(({ record }) => record.kind === "response" && record.method === "turn/interrupt"));
    assert.ok(capture.records.some(({ record }) => record.kind === "completion" && record.status === "interrupted"));
    assert.ok(capture.history);
    assert.equal(capture.gaps.some(({ kind }) => kind === "history-readback"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registers teardown so lifecycle shutdown can await an unacknowledged interrupt", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const controller = new AbortController();
  let shutdown: (() => Promise<void>) | undefined;
  try {
    await mkdir(workspace);
    const capturePromise = captureCodexAppServer({
      runId: "run-ignore-interrupt",
      attemptId: "attempt-ignore-interrupt",
      workspacePath: workspace,
      prompt: "Wait for interruption.",
      configuration: fakeConfiguration("ignore-interrupt"),
      evidencePath: join(root, "session.jsonl"),
      signal: controller.signal,
      shutdownGraceMs: 100,
      registerShutdown: (callback) => { shutdown = callback; },
    });
    await waitForRecord(join(root, "session.jsonl"), (record) => record.kind === "response" && record.method === "turn/start");
    controller.abort();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    assert.ok(shutdown);
    await shutdown();
    const capture = await capturePromise;
    assert.equal(capture.terminalStatus, undefined);
    assert.ok(capture.records.some(({ record }) => record.method === "turn/interrupt"));
    assert.ok(capture.records.some(({ record }) => record.kind === "process"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("honors an abort latched before asynchronous capture setup", async (t) => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const controller = new AbortController();
  controller.abort();
  let clockReads = 0;
  t.mock.method(performance, "now", () => clockReads++ === 0 ? 0 : 10_000);
  try {
    await mkdir(workspace);
    const scheduledDelays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      scheduledDelays.push(delay ?? 0);
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const capture = await captureCodexAppServer({
      runId: "run-pre-aborted",
      attemptId: "attempt-pre-aborted",
      workspacePath: workspace,
      prompt: "Do not start after cancellation.",
      configuration: fakeConfiguration("ignore-interrupt"),
      evidencePath: join(root, "session.jsonl"),
      signal: controller.signal,
      shutdownGraceMs: 1_000,
    });
    assert.equal(scheduledDelays[0], 0, "an aged setup deadline must schedule no deferred pre-turn wait");
    assert.equal(capture.process.termination, "interrupted");
    assert.equal(capture.process.partial, true);
    assert.equal(capture.terminalStatus, undefined);
    assert.ok(capture.gaps.some(({ kind }) => kind === "capture-error"));
    assert.equal(capture.records.some(({ record }) => record.method === "turn/start"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps streamed and persisted history evidence separate and declares mismatch", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "history-mismatch");
    assert.equal(capture.terminalStatus, "completed");
    assert.ok(capture.gaps.some(({ kind }) => kind === "history-mismatch"));
    assert.ok(capture.records.some(({ record }) => record.method === "thread/read" && record.kind === "response"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupts a post-terminal history read when the caller aborts", async () => {
  const root = await temporaryRoot();
  const controller = new AbortController();
  try {
    const capturePromise = runFake(root, "history-hang", [], controller.signal);
    await waitForRecord(join(root, "session.jsonl"), (record) => record.kind === "request" && record.method === "thread/read");
    const abortedAt = performance.now();
    controller.abort();
    const capture = await capturePromise;
    assert.ok(performance.now() - abortedAt < 400, "an in-flight readback must adopt the outer abort grace");
    assert.equal(capture.terminalStatus, "completed");
    assert.ok(capture.gaps.some(({ kind }) => kind === "history-readback"));
    assert.equal(capture.process.status, "interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latches aborts that arrive while terminal evidence is being recorded", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const controller = new AbortController();
  let abortedAt: number | undefined;
  try {
    await mkdir(workspace);
    const capture = await Promise.race([
      captureCodexAppServer({
        runId: "run-terminal-abort-race",
        attemptId: "attempt-terminal-abort-race",
        workspacePath: workspace,
        prompt: "Complete then wait on history.",
        configuration: fakeConfiguration("history-hang"),
        evidencePath: join(root, "session.jsonl"),
        signal: controller.signal,
        shutdownGraceMs: 400,
        now: () => {
          if (!controller.signal.aborted && new Error().stack?.includes("recordCompletion")) {
            abortedAt = performance.now();
            controller.abort();
          }
          return new Date().toISOString();
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("terminal abort race hung")), 2_000)),
    ]);
    assert.equal(controller.signal.aborted, true);
    assert.ok(abortedAt !== undefined && performance.now() - abortedAt < 300, "history readback must leave the outer grace for finalization");
    assert.ok(capture.gaps.some(({ kind, detail }) => kind === "history-readback" && detail.includes("timed out")));
    assert.equal(capture.records.some(({ record }) => record.method === "thread/read" && record.kind === "request"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses the abort deadline after successful history readback", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const controller = new AbortController();
  let abortedAt: number | undefined;
  try {
    await mkdir(workspace);
    const capture = await captureCodexAppServer({
      runId: "run-successful-history-abort",
      attemptId: "attempt-successful-history-abort",
      workspacePath: workspace,
      prompt: "Complete, retain history, and stop within the original grace.",
      configuration: fakeConfiguration("history-success-stall-shutdown"),
      evidencePath: join(root, "session.jsonl"),
      signal: controller.signal,
      shutdownGraceMs: 400,
      now: () => {
        if (!controller.signal.aborted && new Error().stack?.includes("recordCompletion")) {
          abortedAt = performance.now();
          controller.abort();
        }
        return new Date().toISOString();
      },
    });
    assert.ok(abortedAt !== undefined && performance.now() - abortedAt < 350, "successful history must not start a fresh shutdown grace");
    assert.ok(capture.history);
    assert.equal(capture.process.status, "interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declares every server-applied material policy mismatch", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "policy-mismatch");
    assert.equal(capture.qualification, "qualified-with-gaps");
    for (const kind of ["provider-mismatch", "approval-policy-mismatch", "sandbox-mismatch"]) {
      assert.ok(capture.gaps.some((gap) => gap.kind === kind), kind);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects broadened workspace-write roots and temp access", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "sandbox-root-mismatch");
    assert.ok(capture.gaps.some(({ kind }) => kind === "sandbox-mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports process finalization errors after a successful turn", async () => {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  const stderrPath = join(root, "diagnostics/stderr.txt");
  try {
    await mkdir(workspace);
    await mkdir(dirname(stderrPath), { recursive: true });
    await writeFile(stderrPath, "pre-existing\n");
    const capture = await captureCodexAppServer({
      runId: "run-finalization-error",
      attemptId: "attempt-finalization-error",
      workspacePath: workspace,
      prompt: "Complete normally.",
      configuration: fakeConfiguration("success"),
      evidencePath: join(root, "session.jsonl"),
      stderrPath,
    });
    assert.equal(capture.terminalStatus, "completed");
    assert.equal(capture.qualification, "qualified-with-gaps");
    assert.ok(capture.gaps.some(({ kind }) => kind === "process-error"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes only the matching owned turn completion", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "foreign-completion");
    assert.ok(capture.gaps.some(({ kind }) => kind === "foreign-turn-completion"));
    const normalized = await normalizeCodexCapture(capture);
    const outcomes = normalized.events.filter(({ family }) => family === "outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.scope.id, "turn-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicates repeated foreign completion gaps while retaining native records", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "foreign-completion-flood");
    assert.equal(capture.gaps.filter(({ kind }) => kind === "foreign-turn-completion").length, 1);
    assert.ok(capture.records.filter(({ record }) => record.method === "turn/completed").length > 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filters every normalized and usage record to the owned thread and turn", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "foreign-scope");
    const normalized = await normalizeCodexCapture(capture);
    assert.equal(normalized.events.some(({ scope }) => scope.id === "foreign-turn"), false);
    assert.equal(normalized.events.some(({ attributes }) => attributes.itemId === "foreign-item"), false);
    assert.equal(capture.telemetry.usage.final?.total.totalTokens, 14);
    const foreign = capture.records.filter(({ record }) => record.sourceIdentity === "foreign-thread");
    assert.ok(foreign.length > 0);
    for (const record of foreign) {
      assert.ok(normalized.unmapped.some(({ reference }) => reference.recordLocator === record.reference.recordLocator));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounds OTLP receiver diagnostics while continuing to accept configured signals", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "receiver-errors", ["logs"]);
    assert.equal(capture.terminalStatus, "completed");
    assert.equal(capture.telemetry.telemetry.receiverErrors.length, 65);
    assert.equal(capture.telemetry.telemetry.receiverErrors.at(-1), "Additional OTLP receiver errors were truncated.");
    assert.equal(capture.telemetry.telemetry.receipt.signals.logs.status, "received");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reserves global OTLP limits across concurrent uploads", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "concurrent-otlp", ["logs"]);
    assert.ok(capture.telemetry.telemetry.records.length <= 256);
    assert.ok(capture.telemetry.telemetry.receiverErrors.some((error) => error.includes("256-record")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not count malformed OTLP JSON as a collector receipt", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "malformed-otlp", ["logs"]);
    assert.equal(capture.telemetry.telemetry.receipt.signals.logs.status, "missing");
    assert.ok(capture.telemetry.telemetry.receiverErrors.some((error) => error.includes("malformed logs")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains reset OTLP body streams as explicit delivery failures", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "reset-otlp", ["logs"]);
    assert.equal(capture.telemetry.telemetry.receipt.signals.logs.status, "missing");
    assert.ok(capture.telemetry.telemetry.receiverErrors.some((error) => error.includes("Failed receiving logs OTLP body")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps UTF-8 stderr intact across split chunks", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "stderr-split");
    const diagnostic = capture.records.filter(({ record }) => record.method === "diagnostic/stderr")
      .map(({ record }) => (record.payload as { text?: string }).text ?? "").join("");
    assert.match(diagnostic, /🙂/u);
    assert.doesNotMatch(diagnostic, /�/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps out-of-range native timestamps explicitly unknown", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "timestamp-range");
    const normalized = await normalizeCodexCapture(capture);
    const tool = normalized.events.find(({ family }) => family === "tool");
    assert.equal(tool?.nativeTime.status, "unknown");
    assert.match(tool?.nativeTime.status === "unknown" ? tool.nativeTime.reason : "", /invalid|outside/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a bounded normalization projection while session JSONL remains authoritative", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "noisy", [], undefined, 8);
    assert.equal(capture.records.length, 8);
    assert.ok(capture.gaps.some(({ kind }) => kind === "normalization-projection-truncated"));
    assert.ok((await readFile(join(root, "session.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).length > 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("composes a qualified observational run bundle with workspace, protocol, diagnostic, telemetry, and normalization", async () => {
  const root = await temporaryRoot();
  try {
    const start = join(root, "start");
    const workspace = join(root, "workspace");
    await mkdir(start);
    await mkdir(workspace);
    await writeFile(join(start, "README.md"), "before\n");
    await writeFile(join(workspace, "README.md"), "after\n");
    const definition: RunBundleDefinition = {
      bundleRoot: join(root, "bundle"),
      bundleId: "bundle-codex-test",
      run: {
        id: "run-codex-test",
        assessmentMode: "observational",
        task: { id: "task-codex" },
        fixture: { id: "fixture", digest: `sha256:${"1".repeat(64)}` },
        model: { provider: "openai", id: "gpt-5.6-sol" },
        harness: { id: "codex-app-server", version: CODEX_APP_SERVER_VERSION },
        runtime: [],
      },
      attempt: { id: "attempt-codex-test", number: 1 },
      configuration: {
        digest: `sha256:${"2".repeat(64)}`,
        budgetDigest: `sha256:${"3".repeat(64)}`,
        toolPolicyDigest: `sha256:${"4".repeat(64)}`,
      },
    };
    const result = await captureCodexAppServerRun({
      definition,
      startingWorkspacePath: start,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: fakeConfiguration("success"),
      prompt: "Inspect the disposable workspace.",
    });
    assert.equal(result.attempt.terminal.state, "completed", JSON.stringify(result.attempt));
    assert.equal(result.qualification.status, "qualified-with-gaps", "disabled telemetry is an explicit gap");
    assert.ok(result.manifest.evidence.some(({ kind }) => kind === "session"));
    assert.ok(result.manifest.evidence.some(({ kind }) => kind === "workspace"));
    assert.ok(result.capture?.records.some(({ record }) => record.method === "diagnostic/stderr"));
    assert.ok(result.manifest.evidence.some(({ kind }) => kind === "telemetry"));
    assert.ok((result.normalized?.events.length ?? 0) > 0);
    assert.equal(result.coverage?.records.total, result.capture?.records.length);
    await checkRetainedEvaluation(definition.bundleRoot, root);
    const manifest = result.manifest;
    const session = manifest.evidence.find(({ kind }) => kind === "session")!;
    const sessionPath = join(definition.bundleRoot, session.relativePath);
    const originalBytes = await readFile(sessionPath);
    const records = originalBytes.toString().trim().split("\n").map((line) => JSON.parse(line));
    for (const mutation of ["missing", "foreign-thread", "foreign-turn", "failed-status", "failed-before-completed", "completed-then-failed", "completed-then-interrupted", "duplicate-completed"]) {
      const changedRecords = structuredClone(records).flatMap((record) => {
        if (record.kind !== "notification" || record.method !== "turn/completed") return [record];
        if (mutation === "missing") return [];
        if (mutation === "failed-before-completed") return [
          { ...record, payload: { ...record.payload, turn: { ...record.payload.turn, status: "failed" } } }, record,
        ];
        if (["completed-then-failed", "completed-then-interrupted", "duplicate-completed"].includes(mutation)) return [record,
          { ...record, payload: { ...record.payload, turn: { ...record.payload.turn,
            status: mutation === "completed-then-failed" ? "failed" : mutation === "completed-then-interrupted" ? "interrupted" : "completed" } } },
        ];
        if (mutation === "foreign-thread") record.payload.threadId = "foreign-thread";
        if (mutation === "foreign-turn") record.payload.turn.id = "foreign-turn";
        if (mutation === "failed-status") record.payload.turn.status = "failed";
        return [record];
      });
      const bytes = Buffer.from(`${changedRecords.map((record, index) => JSON.stringify({ ...record, sequence: index + 1 })).join("\n")}\n`);
      const changedManifest = structuredClone(manifest);
      const descriptor = changedManifest.evidence.find(({ id }) => id === session.id)!;
      descriptor.digest = `sha256:${digestBytes(bytes).value}`;
      descriptor.sizeBytes = bytes.length;
      await writeFile(sessionPath, bytes);
      await writeFile(join(definition.bundleRoot, "manifest.json"), JSON.stringify(changedManifest));
      assert.equal((await qualifyRunBundle(definition.bundleRoot)).semanticAnalysisUsable, true, "Generic qualification does not enforce owned Codex completion.");
      await assert.rejects(createRetainedBehaviorEvidence(definition.bundleRoot), /matching owned terminal evidence/u, mutation);
    }
    const telemetry = manifest.evidence.find(({ relativePath }) => relativePath === "telemetry/codex.json")!;
    const telemetryPath = join(definition.bundleRoot, telemetry.relativePath);
    const originalTelemetry = await readFile(telemetryPath);
    for (const mutation of ["initialize", "telemetry"]) {
      await writeFile(sessionPath, originalBytes);
      await writeFile(telemetryPath, originalTelemetry);
      const changedManifest = structuredClone(manifest);
      const changed = mutation === "initialize"
        ? Buffer.from(`${records.map((record) => JSON.stringify(record.kind === "response" && record.method === "initialize"
          ? { ...record, payload: { ...record.payload, userAgent: "ebo/0.150.1 (synthetic fixture)" } } : record)).join("\n")}\n`)
        : Buffer.from(JSON.stringify({ ...JSON.parse(originalTelemetry.toString()), runtime: { ...JSON.parse(originalTelemetry.toString()).runtime, version: "0.150.1" } }));
      const descriptor = changedManifest.evidence.find(({ id }) => id === (mutation === "initialize" ? session.id : telemetry.id))!;
      descriptor.digest = `sha256:${digestBytes(changed).value}`;
      descriptor.sizeBytes = changed.length;
      await writeFile(mutation === "initialize" ? sessionPath : telemetryPath, changed);
      await writeFile(join(definition.bundleRoot, "manifest.json"), JSON.stringify(changedManifest));
      assert.equal((await qualifyRunBundle(definition.bundleRoot)).semanticAnalysisUsable, true);
      await assert.rejects(createRetainedBehaviorEvidence(definition.bundleRoot), /native runtime version differs/u, mutation);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained auth failure without an owned turn supports observations and abstaining judgment", async () => {
  const root = await temporaryRoot();
  try {
    const start = join(root, "start");
    const workspace = join(root, "workspace");
    await mkdir(start);
    await mkdir(workspace);
    const definition = codexDefinition(join(root, "bundle"), "auth-failure");
    const result = await captureCodexAppServerRun({ definition, startingWorkspacePath: start,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: fakeConfiguration("auth-failure"), prompt: "Synthetic failure before turn acceptance." });
    assert.equal(result.attempt.terminal.state, "failed");
    assert.equal(result.capture?.turnId, undefined);
    const before = await readFile(join(definition.bundleRoot, "manifest.json"));
    const evidence = await createRetainedBehaviorEvidence(definition.bundleRoot);
    assert.equal(evidence.capture.qualification, "qualified-with-gaps");
    assert.equal(evidence.dataset.events.length, 0, "No invented events without an owned turn.");
    const observations = await createRetainedStructuralObservationSet(definition.bundleRoot);
    assert.equal(await main(["observations", "create", definition.bundleRoot, join(root, "observations.json")], () => undefined), 0);
    const request: SemanticJudgeRequest = { schemaVersion: "ebo.semantic-judge-request/v1", id: "partial-fixture",
      behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
      rubric: { id: "synthetic", version: "1.0.0", instructions: "Synthetic partial evidence only." },
      evaluator: { backend: "codex-app-server", provider: "openai", model: "fixture", effort: "low" },
      selection: { eventIds: [], structuralObservationIds: [], includeOutcomeObservations: true },
      limits: { maxEvidenceItems: 20, maxRecordChars: 4096, maxInputChars: 40000, maxOutputChars: 16000, maxCitations: 2, maxWallClockMs: 1000, maxTurns: 1 },
      blinding: { evaluatedModelIdentity: "redact" } };
    const outputRoot = join(root, "judgment");
    const judgment = await runRetainedSemanticJudge({ bundleRoot: definition.bundleRoot, observations, request, outputRoot,
      backend: { id: "codex-app-server", version: CODEX_APP_SERVER_VERSION, run: async () => ({ status: "completed", raw: { synthetic: true }, response: { judgment: {
        disposition: "abstained", assessment: null, confidence: null, reason: "No completed turn.", missingEvidenceCapability: null,
        rationale: "Synthetic fixture.", alternativeExplanation: "No behavioral claim.", citations: [] } } }) } });
    assert.equal(judgment.status, "proposed");
    assert.equal(await main(["assertions", "validate", definition.bundleRoot, join(outputRoot, "assertion.json")], () => undefined), 0);
    assert.deepEqual(await readFile(join(definition.bundleRoot, "manifest.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shares the omitted shutdown grace across lifecycle and Codex capture finalization", async () => {
  const root = await temporaryRoot();
  const start = join(root, "start");
  const workspace = join(root, "workspace");
  try {
    await mkdir(start);
    await mkdir(workspace);
    await writeFile(join(start, "README.md"), "before\n");
    await writeFile(join(workspace, "README.md"), "after\n");
    const result = await captureCodexAppServerRun({
      definition: codexDefinition(join(root, "bundle-default-grace"), "default-grace"),
      startingWorkspacePath: start,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: fakeConfiguration("ignore-all-interrupts"),
      prompt: "Wait until the coordinator interrupts this attempt.",
      maxWallClockMs: 500,
    });
    assert.ok(result.capture, "the lifecycle must wait for the capture's default finalization window");
    assert.equal(result.capture.process.termination, "interrupted");
    assert.ok(result.manifest.evidence.some(({ kind }) => kind === "session"));
    assert.ok(result.manifest.evidence.some(({ kind }) => kind === "telemetry"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps native evidence and the source workspace when post-start packaging fails", async (t) => {
  const root = await temporaryRoot();
  const start = join(root, "start");
  const workspace = join(root, "workspace");
  try {
    await mkdir(start);
    await mkdir(workspace);
    await writeFile(join(start, "README.md"), "before\n");
    await writeFile(join(workspace, "README.md"), "after\n");
    t.mock.method(RunBundleAssembler.prototype, "captureWorkspaceOutcome", async () => {
      throw new Error("ENOSPC: injected Codex packaging failure");
    });
    const definition: RunBundleDefinition = {
      bundleRoot: join(root, "bundle"),
      bundleId: "bundle-codex-packaging-failure",
      run: {
        id: "run-codex-packaging-failure",
        assessmentMode: "observational",
        task: { id: "task-codex" },
        fixture: { id: "fixture", digest: `sha256:${"1".repeat(64)}` },
        model: { provider: "openai", id: "gpt-5.6-sol" },
        harness: { id: "codex-app-server", version: CODEX_APP_SERVER_VERSION },
        runtime: [],
      },
      attempt: { id: "attempt-codex-packaging-failure", number: 1 },
      configuration: { digest: `sha256:${"2".repeat(64)}`, budgetDigest: `sha256:${"3".repeat(64)}`, toolPolicyDigest: `sha256:${"4".repeat(64)}` },
    };
    const result = await captureCodexAppServerRun({
      definition,
      startingWorkspacePath: start,
      workspace: {
        setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }),
        cleanup: () => rm(workspace, { recursive: true, force: true }),
      },
      configuration: fakeConfiguration("success"),
      prompt: "Perform the disposable task.",
    });
    assert.equal(result.attempt.classification.kind, "infrastructure-failure");
    assert.equal(result.qualification.status, "unqualified");
    assert.equal(await readFile(join(workspace, "codex-result.txt"), "utf8"), "done\n");
    assert.ok(result.manifest.evidence.some(({ kind }) => kind === "session"));
    assert.equal(result.manifest.evidence.some(({ kind }) => kind === "workspace"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pins the generated contract subset and validates representative 0.153.4 fixtures", async () => {
  const manifest = JSON.parse(await readFile(join(contractRoot, "manifest.json"), "utf8")) as {
    codexCliVersion: string;
    files: Record<string, string>;
  };
  assert.equal(manifest.codexCliVersion, CODEX_APP_SERVER_VERSION);
  for (const [path, digest] of Object.entries(manifest.files)) {
    assert.equal(createHash("sha256").update(await readFile(join(contractRoot, path))).digest("hex"), digest, path);
  }
  const ajv = new Ajv2020({ strict: false, validateSchema: false });
  ajv.addFormat("int64", true);
  ajv.addFormat("uint", true);
  const rpc = ajv.compile(JSON.parse(await readFile(join(contractRoot, "schema/JSONRPCMessage.json"), "utf8")));
  assert.equal(rpc({ method: "thread/read", id: 4, params: { threadId: "thread-1", includeTurns: true } }), true);
  const usage = ajv.compile(JSON.parse(await readFile(join(contractRoot, "schema/v2/ThreadTokenUsageUpdatedNotification.json"), "utf8")));
  assert.equal(usage({
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: {
      total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 128000,
    },
  }), true);
  const start = ajv.compile(JSON.parse(await readFile(join(contractRoot, "schema/v2/ThreadStartParams.json"), "utf8")));
  assert.equal(start({ model: "fixture", historyMode: "legacy", environments: [] }), true);
  const turn = ajv.compile(JSON.parse(await readFile(join(contractRoot, "schema/v2/TurnStartParams.json"), "utf8")));
  assert.equal(turn({ threadId: "thread-1", input: [{ type: "text", text: "fixture", text_elements: [] }], environments: [], outputSchema: { type: "object" } }), true);
});

test("runs one frozen observational queue entry and passes export, corpus, and archive readback", async () => {
  const fixtureRoot = await temporaryRoot();
  try {
    const queueFixture = createQueueFixture(fixtureRoot);
    const corpusRoot = join(fixtureRoot, "corpus");
    const summary = await runCodexQueueEntry({
      bundleRoot: queueFixture.bundleRoot,
      queuePath: queueFixture.queuePath,
      runId: queueFixture.runId,
      outputRoot: join(corpusRoot, "runs"),
      workspaceRoot: join(fixtureRoot, "workspaces"),
      probeRuntime: async () => ({ path: process.execPath, version: `codex-cli ${CODEX_APP_SERVER_VERSION}` }),
      executableArgs: [fixture],
    });
    assert.equal(summary.assessmentMode, "observational");
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    assert.ok(summary.normalizedEvents > 0);
    assert.equal(summary.threadId, "thread-1");

    const policy: PortableExportPolicy = { sharingClass: "partner", maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024 };
    const exportRoot = join(corpusRoot, "exports", "codex");
    const exported = await createPortableRunBundleExport({ sourceRoot: summary.bundlePath, destinationRoot: exportRoot, policy });
    assert.equal((await readPortableRunBundleExport(exportRoot, policy)).bundleId, exported.bundleId);
    assert.deepEqual(validateCorpusIndex(corpusRoot, buildCorpusIndex(corpusRoot)), []);
    const archive = join(fixtureRoot, "codex-export.tar.gz");
    await packPortableExport(exportRoot, archive, policy);
    const unpacked = unpackPortableExport(archive, join(fixtureRoot, "unpacked"));
    assert.equal(unpacked.bundleId, exported.bundleId);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("keeps Codex reasoning restricted while removing every portable representation", async () => {
  const root = await temporaryRoot();
  try {
    const queueFixture = createQueueFixture(root);
    const outputRoot = join(root, "runs");
    const summary = await runCodexQueueEntry({
      bundleRoot: queueFixture.bundleRoot,
      queuePath: queueFixture.queuePath,
      runId: queueFixture.runId,
      outputRoot,
      workspaceRoot: join(root, "workspaces"),
      probeRuntime: async () => ({ path: process.execPath, version: `codex-cli ${CODEX_APP_SERVER_VERSION}` }),
      executableArgs: [fixture, "--mode=reasoning-evidence"],
    });
    const restrictedSession = await readFile(join(summary.bundlePath, "session.jsonl"), "utf8");
    assert.ok(restrictedSession.includes(reasoningSentinel));

    const policy: PortableExportPolicy = { sharingClass: "partner", maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024 };
    const exportRoot = join(root, "portable");
    const exported = await createPortableRunBundleExport({ sourceRoot: summary.bundlePath, destinationRoot: exportRoot, policy });
    await readPortableRunBundleExport(exportRoot, policy);
    const session = exported.artifacts.find(({ kind }) => kind === "session");
    assert.ok(session);
    const portableSession = await readFile(join(exportRoot, session.relativePath), "utf8");
    assert.equal(portableSession.includes(reasoningSentinel), false);
    for (const line of portableSession.trim().split("\n")) {
      assert.equal(containsPortableReasoningContent(JSON.parse(line) as unknown), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI signals interrupt and finalize the detached Codex child", async () => {
  const root = await temporaryRoot();
  try {
    const executable = join(root, "fake-codex.mjs");
    writeFileSync(executable, `#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("codex-cli ${CODEX_APP_SERVER_VERSION}");\nelse { process.argv.push("--mode=ignore-all-interrupts"); await import(${JSON.stringify(pathToFileURL(fixture).href)}); }\n`, { mode: 0o700 });
    const queueFixture = createQueueFixture(root, executable);
    const outputRoot = join(root, "cli-runs");
    const child = spawn(process.execPath, [
      resolve("dist/src/cli.js"),
      "codex", "run",
      queueFixture.bundleRoot,
      queueFixture.queuePath,
      queueFixture.runId,
      outputRoot,
      "--workspace-root", join(root, "cli-workspaces"),
    ], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitPromise = waitForChild(child);
    const sessionPath = await waitForNestedRecord(outputRoot, (record) => record.kind === "response" && record.method === "turn/start");
    child.kill("SIGINT");
    const exit = await exitPromise;
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    const summary = JSON.parse(stdout.trim()) as { bundlePath: string; classification: string };
    assert.equal(summary.classification, "interrupted");
    const manifest = JSON.parse(await readFile(join(summary.bundlePath, "manifest.json"), "utf8")) as RunManifest;
    assert.ok(manifest.evidence.some(({ kind }) => kind === "session"));
    assert.ok(manifest.evidence.some(({ kind }) => kind === "telemetry"));
    const records = (await readFile(sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      kind?: string;
      evidence?: { signal?: string; pid?: number };
    });
    const processRecord = records.find(({ kind }) => kind === "process");
    assert.equal(processRecord?.evidence?.signal, "SIGKILL");
    assert.equal(typeof processRecord?.evidence?.pid, "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runFake(
  root: string,
  mode: string,
  signals: readonly ("logs" | "traces" | "metrics")[] = [],
  signal?: AbortSignal,
  maxInMemoryObservations?: number,
  shutdownGraceMs = 500,
): Promise<CodexAppServerCapture> {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return captureCodexAppServer({
    runId: `run-${mode}`,
    attemptId: `attempt-${mode}`,
    workspacePath: workspace,
    prompt: "Perform one small task.",
    configuration: { ...fakeConfiguration(mode), ...(signals.length === 0 ? {} : { telemetry: { signals } }) },
    evidencePath: join(root, "session.jsonl"),
    stderrPath: join(root, "diagnostics/stderr.txt"),
    shutdownGraceMs,
    ...(signal === undefined ? {} : { signal }),
    ...(maxInMemoryObservations === undefined ? {} : { maxInMemoryObservations }),
  });
}

function fakeConfiguration(mode: string): CodexAppServerConfiguration {
  return {
    executable: process.execPath,
    executableArgs: [fixture, `--mode=${mode}`],
    version: CODEX_APP_SERVER_VERSION,
    provider: "openai",
    model: "gpt-5.6-sol",
    effort: "high" as const,
    approvalPolicy: "never" as const,
    sandbox: "workspace-write" as const,
  };
}

function codexDefinition(bundleRoot: string, suffix: string): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-codex-${suffix}`,
    run: {
      id: `run-codex-${suffix}`,
      assessmentMode: "observational",
      task: { id: "task-codex" },
      fixture: { id: "fixture", digest: `sha256:${"1".repeat(64)}` },
      model: { provider: "openai", id: "gpt-5.6-sol" },
      harness: { id: "codex-app-server", version: CODEX_APP_SERVER_VERSION },
      runtime: [],
    },
    attempt: { id: `attempt-codex-${suffix}`, number: 1 },
    configuration: {
      digest: `sha256:${"2".repeat(64)}`,
      budgetDigest: `sha256:${"3".repeat(64)}`,
      toolPolicyDigest: `sha256:${"4".repeat(64)}`,
    },
  };
}

function containsPortableReasoningContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPortableReasoningContent);
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const hidden = new Set(["content", "delta", "encryptedContent", "summary", "text"]);
  if (record.type === "reasoning" && Object.keys(record).some((key) => hidden.has(key))) return true;
  if (record.method === "item/reasoning/textDelta") {
    for (const container of [record.params, record.payload]) {
      if (typeof container === "object" && container !== null
          && Object.keys(container).some((key) => hidden.has(key))) return true;
    }
  }
  return Object.values(record).some(containsPortableReasoningContent);
}

async function waitForNestedRecord(
  root: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    let paths: string[] = [];
    try {
      paths = await readdir(root, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const path of paths.filter((candidate) => candidate.endsWith("session.jsonl"))) {
      const sessionPath = join(root, path);
      const records = (await readFile(sessionPath, "utf8")).split(/\r?\n/u).filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records.some(predicate)) return sessionPath;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for nested Codex session evidence.");
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex CLI did not exit after SIGINT.")), 10_000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createQueueFixture(parent: string, executable = process.execPath): { bundleRoot: string; queuePath: string; runId: string } {
  const bundleRoot = join(parent, "queue-bundle");
  mkdirSync(bundleRoot, { recursive: true });
  const packet = JSON.parse(readFileSync(resolve("tests/fixtures/task-packet.valid.v1.json"), "utf8")) as Extract<TaskPacket, { assessmentMode: "verified" }>;
  const observational = (({ restricted: _restricted, ...value }) => ({ ...value, assessmentMode: "observational" as const }))(packet);
  observational.agentInput.prompt = "Create codex-result.txt containing done.";
  const writeReference = (reference: { locator: string; digest: { algorithm: "sha256"; value: string } }, locator: string, bytes: Buffer) => {
    reference.locator = locator;
    reference.digest = digestBytes(bytes);
    const path = join(bundleRoot, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  writeReference(observational.agentInput.fixture.source, "components/fixture.tar.gz", fixtureArchive());
  if (!("reference" in observational.controlledPerturbation)) throw new Error("Fixture requires a controlled perturbation reference.");
  writeReference(observational.controlledPerturbation.reference, "components/perturbation.json", Buffer.from("{}\n"));
  const preAdmission = structuredClone(observational) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  writeReference(observational.admission.review!.reviewRecord, "restricted/review.json", Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: observational.admission.status,
    reviewedAt: observational.admission.review!.reviewedAt,
    reviewedBy: observational.admission.review!.reviewedBy,
  })));
  const packetPath = join(bundleRoot, "packets/task.json");
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(observational));
  freezeTaskPacket(bundleRoot, "packets/task.json");

  const configs = {
    model: { schemaVersion: "ebo.codex-config/v1", kind: "model", provider: "openai", model: "gpt-5.6-sol", effort: "high" },
    harness: { schemaVersion: "ebo.codex-config/v1", kind: "harness", adapter: "codex-app-server", executable, version: CODEX_APP_SERVER_VERSION, contractDigest: CODEX_CONTRACT_DIGEST },
    limits: { schemaVersion: "ebo.codex-config/v1", kind: "native-limits", shutdownGraceMs: 1_000 },
    tools: { schemaVersion: "ebo.codex-config/v1", kind: "native-tool-policy", approvalPolicy: "never", sandbox: "workspace-write" },
    capture: { schemaVersion: "ebo.codex-config/v1", kind: "capture-profile", telemetrySignals: ["logs", "traces", "metrics"], workspaceOutcome: { excludeDirectoryNames: ["node_modules"] } },
  };
  const references = Object.fromEntries(Object.entries(configs).map(([name, value]) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const locator = `configs/${name}.json`;
    const path = join(bundleRoot, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return [name, { locator, digest: digestBytes(bytes) }];
  }));
  const experiment: ExperimentConfiguration = {
    schemaVersion: "ebo.experiment/v1",
    id: "codex-runner-fixture",
    taskSet: { task: { packetRef: { locator: "packets/task.json", digest: digestMetadata(observational) } } },
    modelSet: { "gpt-5-6-sol": { configurationRef: references.model! } },
    harnessSet: { "codex-app-server": {
      configurationRef: references.harness!,
      nativeLimitsRef: references.limits!,
      nativeToolPolicyRef: references.tools!,
    } },
    trialCount: 1,
    ordering: { seed: "codex", strategy: "sequential", declaredOrder: { taskIds: ["task"], modelIds: ["gpt-5-6-sol"], harnessIds: ["codex-app-server"] } },
    coordinatorBudget: { maxWallClockMs: 30_000 },
    captureProfile: references.capture!,
  } as ExperimentConfiguration;
  const queue = compileRunQueue(experiment, { bundleRoot });
  const queuePath = join(parent, "queue.json");
  writeRunQueue(queuePath, queue);
  mkdirSync(join(parent, "workspaces"), { recursive: true });
  return { bundleRoot, queuePath, runId: queue.entries[0]!.runId };
}

function fixtureArchive(): Buffer {
  const files = [
    { path: "README.md", bytes: Buffer.from("# fixture\n"), type: "0" },
    { path: "package.json", bytes: Buffer.from("{}\n"), type: "0" },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n"), type: "0" },
  ];
  const blocks = files.map(({ path, bytes, type }) => {
    const header = Buffer.alloc(512);
    header.write(path);
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    header.write(`${header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ebo-codex-test-"));
}

async function waitForRecord(path: string, predicate: (record: Record<string, unknown>) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const records = (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      if (records.some(predicate)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for the fake Codex protocol record.");
}
import { checkRetainedEvaluation } from "./retained-evaluation-helper.js";
