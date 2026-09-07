import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
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
import { captureCodexAppServerRun, runCodexQueueEntry } from "../src/codex-run.js";
import { RunBundleAssembler, type RunBundleDefinition } from "../src/run-bundles.js";
import {
  buildCorpusIndex,
  compileRunQueue,
  createPortableRunBundleExport,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  packPortableExport,
  readPortableRunBundleExport,
  unpackPortableExport,
  validateCorpusIndex,
  writeRunQueue,
  type ExperimentConfiguration,
  type PortableExportPolicy,
  type TaskPacket,
} from "../src/index.js";

const fixture = resolve("test/fixtures/codex/fake-app-server.mjs");
const contractRoot = resolve("contracts/codex-app-server-0.150.1");

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
    const promise = runFake(root, "interrupt", [], controller.signal);
    await waitForRecord(join(root, "session.jsonl"), (record) => record.kind === "response" && record.method === "turn/start");
    controller.abort();
    const capture = await promise;
    assert.equal(capture.terminalStatus, "interrupted");
    assert.ok(capture.records.some(({ record }) => record.kind === "request" && record.method === "turn/interrupt"));
    assert.ok(capture.records.some(({ record }) => record.kind === "response" && record.method === "turn/interrupt"));
    assert.ok(capture.records.some(({ record }) => record.kind === "completion" && record.status === "interrupted"));
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

test("pins the generated contract subset and validates representative 0.150.1 fixtures", async () => {
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

async function runFake(
  root: string,
  mode: string,
  signals: readonly ("logs" | "traces" | "metrics")[] = [],
  signal?: AbortSignal,
  maxInMemoryObservations?: number,
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
    shutdownGraceMs: 500,
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

function createQueueFixture(parent: string): { bundleRoot: string; queuePath: string; runId: string } {
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
    harness: { schemaVersion: "ebo.codex-config/v1", kind: "harness", adapter: "codex-app-server", executable: process.execPath, version: "0.150.1", contractDigest: "sha256:844b52d4a5a8cda58794e28b3b119c3a3d20a588b7db83209c298bec62704092" },
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
