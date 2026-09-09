import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type {
  AgentOptions,
  AgentUsage,
  ConversationTurn,
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKMessage,
  SendOptions,
} from "@cursor/sdk";

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
  readPortableRunBundleExport,
  runCursorSdkQueueEntry,
  writeRunQueue,
  type CursorSdkAgentFactory,
  type ExperimentConfiguration,
  type RunManifest,
  type TaskPacket,
} from "../src/index.js";
import { checkRetainedEvaluation } from "./retained-evaluation-helper.js";

const MODEL: ModelSelection = { id: "cursor-test-model", params: [{ id: "thinking", value: "low" }] };
const AGENT_ID = "cursor-agent-fixture";
const NATIVE_RUN_ID = "cursor-run-fixture";

test("runs one frozen Cursor SDK entry through native store, export, observations, judge evidence, and Atlas", async () => {
  const fixture = createCursorFixture();
  const previousMarker = process.env.EBO_CURSOR_TEST_SECRET;
  process.env.EBO_CURSOR_TEST_SECRET = "must-not-reach-sdk-child";
  try {
    const summary = await runCursorSdkQueueEntry({
      ...fixture,
      apiKey: "fixture-key-not-retained",
      modelLister: fakeModelLister,
      agentFactory: fakeAgentFactory(),
    });
    assert.equal(summary.captureQualification, "qualified");
    assert.equal(summary.classification, "completed");
    assert.equal(summary.sessionId, AGENT_ID);
    assert.equal(summary.nativeRunId, NATIVE_RUN_ID);
    assert.equal(summary.retainedWorkspacePath, undefined);
    assert.equal(process.env.EBO_CURSOR_TEST_SECRET, "must-not-reach-sdk-child");
    assert.deepEqual(readdirSync(fixture.workspaceRoot), []);

    const manifest = readManifest(summary.bundlePath);
    assert.equal(manifest.run.model.provider, "cursor");
    assert.deepEqual(manifest.run.runtime, [
      { source: "cursor", name: "cursor-sdk", version: "1.0.31" },
      { source: "cursor", name: "local-agent-runtime", version: "not-exposed" },
    ]);
    assert.ok(manifest.evidence.some(({ id }) => id === "cursor-store-checkpoints"));
    assert.ok(manifest.evidence.some(({ id }) => id === "cursor-store-runEvents"));
    assert.equal(manifest.evidence.some(({ kind }) => kind === "telemetry"), false);

    const evidence = await createRetainedBehaviorEvidence(summary.bundlePath);
    assert.equal(evidence.dataset.adapter.harness, "cursor-sdk");
    assert.equal(evidence.dataset.capabilityProfile.families.artifact.status, "unsupported");
    assert.equal(evidence.dataset.events.filter(({ family }) => family === "tool").length, 2);
    assert.equal(evidence.dataset.events.filter(({ family }) => family === "artifact").length, 0);
    const observations = await createRetainedStructuralObservationSet(summary.bundlePath);
    const toolCount = observations.observations.find(({ id }) => id.endsWith(":tool-operation-count"))!.value;
    const inputTokens = observations.observations.find(({ id }) => id.endsWith(":input-token-count"))!.value;
    assert.equal(toolCount.status, "known");
    assert.equal(toolCount.status === "known" ? toolCount.value : undefined, 1);
    assert.equal(inputTokens.status, "known");
    assert.equal(inputTokens.status === "known" ? inputTokens.value : undefined, 3);
    assert.equal(buildCorpusIndex(summary.bundlePath)[0]!.harnessId, "cursor-sdk");

    const sourceSession = readFileSync(join(summary.bundlePath, "native/session.jsonl"), "utf8");
    assert.match(sourceSession, /hidden delta reasoning/u);
    assert.doesNotMatch(sourceSession, /mutated after callback/u);
    assert.match(readFileSync(join(summary.bundlePath, "native/store/checkpoints.ndjson"), "utf8"), /dataBase64/u);

    const policy = { sharingClass: "partner" as const, maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024, sensitiveValues: ["fixture-key-not-retained"] };
    const exportRoot = join(fixture.parent, "export");
    await createPortableRunBundleExport({ sourceRoot: summary.bundlePath, destinationRoot: exportRoot, policy });
    await readPortableRunBundleExport(exportRoot, policy, manifest, summary.bundlePath);
    const exported = readdirSync(join(exportRoot, "evidence")).map((name) => readFileSync(join(exportRoot, "evidence", name), "utf8")).join("\n");
    assert.doesNotMatch(exported, /hidden delta reasoning|hidden history reasoning|dataBase64|AQIDBA==|checkpoint-encryption-secret|fixture-key-not-retained/u);
    await checkRetainedEvaluation(summary.bundlePath, join(fixture.parent, "evaluation"));
  } finally {
    if (previousMarker === undefined) delete process.env.EBO_CURSOR_TEST_SECRET;
    else process.env.EBO_CURSOR_TEST_SECRET = previousMarker;
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("requires an exact caller-selected catalog model before creating an attempt", async () => {
  const fixture = createCursorFixture();
  let creates = 0;
  try {
    await assert.rejects(runCursorSdkQueueEntry({
      ...fixture,
      apiKey: "fixture-key",
      modelLister: async () => [],
      agentFactory: async () => { creates += 1; throw new Error("must not create"); },
    }), /not an exact available catalog model/u);
    assert.equal(creates, 0);
    assert.equal(readdirSync(fixture.workspaceRoot).length, 0);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("aborts a pending model catalog preflight without creating an attempt", async () => {
  const fixture = createCursorFixture();
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let creates = 0;
  try {
    const pending = runCursorSdkQueueEntry({
      ...fixture,
      apiKey: "fixture-key",
      signal: controller.signal,
      modelLister: async () => await new Promise(() => { markStarted(); }),
      agentFactory: async () => { creates += 1; throw new Error("must not create"); },
    });
    await started;
    controller.abort();
    await assert.rejects(pending, /catalog lookup was interrupted/u);
    assert.equal(creates, 0);
    assert.equal(existsSync(fixture.outputRoot), false);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("rejects a workspace nested under another Git checkout before SDK creation", async () => {
  const fixture = createCursorFixture();
  mkdirSync(join(fixture.parent, ".git"));
  let creates = 0;
  try {
    await assert.rejects(runCursorSdkQueueEntry({
      ...fixture,
      apiKey: "fixture-key",
      modelLister: fakeModelLister,
      agentFactory: async () => { creates += 1; throw new Error("must not create"); },
    }), /must not be nested in another Git checkout/u);
    assert.equal(creates, 0);
    assert.deepEqual(readdirSync(fixture.workspaceRoot), []);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retains provider creation and missing-terminal failures without fabricating success", async () => {
  for (const [name, agentFactory] of [
    ["provider creation", (async () => { throw new Error("injected provider creation failure"); }) as CursorSdkAgentFactory],
    ["missing terminal", fakeAgentFactory({ waitError: true })],
  ] as const) {
    const fixture = createCursorFixture();
    try {
      const summary = await runCursorSdkQueueEntry({ ...fixture, apiKey: "fixture-key", modelLister: fakeModelLister, agentFactory });
      assert.equal(summary.classification, "infrastructure-failure", name);
      assert.equal(summary.captureQualification, "unqualified", name);
      assert.ok(readManifest(summary.bundlePath).evidence.some(({ id }) => id === "cursor-session"));
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("rejects effective model parameter drift under the requested configuration digest", async () => {
  const fixture = createCursorFixture();
  try {
    const summary = await runCursorSdkQueueEntry({
      ...fixture,
      apiKey: "fixture-key",
      modelLister: fakeModelLister,
      agentFactory: fakeAgentFactory({ mismatchedModelParams: true }),
    });
    assert.equal(summary.classification, "infrastructure-failure");
    assert.equal(summary.captureQualification, "unqualified");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retains cancellation and recorder loss as distinct partial outcomes", async () => {
  for (const [name, behavior, classification, qualification] of [
    ["cancelled", { cancelledResult: true }, "interrupted", "qualified"],
    ["recorder", { oversizedStreamRecord: true }, "capture-incomplete", "unqualified"],
  ] as const) {
    const fixture = createCursorFixture();
    try {
      const summary = await runCursorSdkQueueEntry({
        ...fixture,
        apiKey: "fixture-key",
        modelLister: fakeModelLister,
        agentFactory: fakeAgentFactory(behavior),
      });
      assert.equal(summary.classification, classification, name);
      assert.equal(summary.captureQualification, qualification, name);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("aborts pending agent creation, restores the environment, and disposes a late agent", async () => {
  const fixture = createCursorFixture();
  const controller = new AbortController();
  let resolveAgent!: (agent: SDKAgent) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let disposed = 0;
  const factory: CursorSdkAgentFactory = async () => await new Promise<SDKAgent>((resolve) => { resolveAgent = resolve; markStarted(); });
  const marker = process.env.EBO_CURSOR_TEST_SECRET;
  process.env.EBO_CURSOR_TEST_SECRET = "restore-me";
  try {
    const pending = runCursorSdkQueueEntry({ ...fixture, apiKey: "fixture-key", modelLister: fakeModelLister, agentFactory: factory, signal: controller.signal });
    await started;
    controller.abort();
    const summary = await pending;
    assert.equal(summary.classification, "interrupted");
    assert.equal(summary.captureQualification, "unqualified");
    assert.equal(process.env.EBO_CURSOR_TEST_SECRET, "restore-me");
    resolveAgent({
      agentId: "late-agent", model: MODEL, send: async () => { throw new Error("late agent must not send"); }, close() {}, async reload() {},
      async [Symbol.asyncDispose]() { disposed += 1; }, async listArtifacts() { return []; }, async downloadArtifact() { return Buffer.alloc(0); },
      async getUsage() { return { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }; },
    });
    await nextTurn();
    assert.equal(disposed, 1);
  } finally {
    if (marker === undefined) delete process.env.EBO_CURSOR_TEST_SECRET; else process.env.EBO_CURSOR_TEST_SECRET = marker;
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("aborts pending send, fences late callbacks, and cancels the late run", async () => {
  const fixture = createCursorFixture();
  const controller = new AbortController();
  let resolveRun!: (run: Run) => void;
  let markSendStarted!: () => void;
  const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
  let sendOptions: SendOptions | undefined;
  let cancelled = 0;
  try {
    const baseFactory = fakeAgentFactory();
    const factory: CursorSdkAgentFactory = async (options) => {
      const agent = await baseFactory(options);
      return { ...agent, send: async (_message, options) => {
        sendOptions = options;
        return await new Promise<Run>((resolve) => { resolveRun = resolve; markSendStarted(); });
      } };
    };
    const pending = runCursorSdkQueueEntry({ ...fixture, apiKey: "fixture-key", modelLister: fakeModelLister, agentFactory: factory, signal: controller.signal });
    await sendStarted;
    controller.abort();
    const summary = await pending;
    assert.equal(summary.classification, "interrupted");
    assert.equal(summary.captureQualification, "unqualified");
    await sendOptions?.onDelta?.({ update: { type: "text-delta", text: "late" } });
    resolveRun({
      id: "late-run", agentId: AGENT_ID, model: MODEL, supports: () => true, unsupportedReason: () => undefined,
      async *stream() {}, async conversation() { return []; }, async wait() { return { id: "late-run", status: "cancelled" }; },
      async cancel() { cancelled += 1; }, status: "running", onDidChangeStatus() { return () => undefined; },
    });
    await nextTurn();
    assert.equal(cancelled, 1);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("aborts and fences a pending conversation readback", async () => {
  const fixture = createCursorFixture();
  const controller = new AbortController();
  let markConversationStarted!: () => void;
  const conversationStarted = new Promise<void>((resolve) => { markConversationStarted = resolve; });
  let resolveConversation!: (turns: ConversationTurn[]) => void;
  try {
    const baseFactory = fakeAgentFactory();
    const factory: CursorSdkAgentFactory = async (options) => {
      const agent = await baseFactory(options);
      return { ...agent, send: async (message, sendOptions) => {
        const run = await agent.send(message, sendOptions);
        return { ...run, conversation: async () => await new Promise<ConversationTurn[]>((resolve) => {
          resolveConversation = resolve;
          markConversationStarted();
        }) };
      } };
    };
    const pending = runCursorSdkQueueEntry({ ...fixture, apiKey: "fixture-key", modelLister: fakeModelLister, agentFactory: factory, signal: controller.signal });
    await conversationStarted;
    controller.abort();
    const summary = await pending;
    assert.equal(summary.classification, "capture-incomplete");
    assert.equal(summary.captureQualification, "unqualified");
    resolveConversation([{ type: "assistant", text: "late conversation" }] as unknown as ConversationTurn[]);
    await nextTurn();
    assert.doesNotMatch(readFileSync(join(summary.bundlePath, "native/session.jsonl"), "utf8"), /late conversation/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

for (const behavior of [
  { name: "history failure", historyError: true, expected: "capture-incomplete" },
  { name: "stream identity mismatch", mismatchedStreamIdentity: true, expected: "capture-incomplete" },
  { name: "cleanup failure", cleanupError: true, expected: "infrastructure-failure" },
] as const) {
  test(`preserves a valid partial attempt on ${behavior.name}`, async () => {
    const fixture = createCursorFixture();
    try {
      const summary = await runCursorSdkQueueEntry({
        ...fixture,
        apiKey: "fixture-key",
        modelLister: fakeModelLister,
        agentFactory: fakeAgentFactory(behavior),
      });
      assert.equal(summary.classification, behavior.expected);
      assert.equal(summary.captureQualification, "unqualified");
      const manifest = readManifest(summary.bundlePath);
      assert.ok(manifest.evidence.some(({ id }) => id === "cursor-session"));
      assert.ok(manifest.evidence.some(({ kind }) => kind === "workspace"));
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });
}

test("billing unavailability and absent usage remain explicit without invalidating semantic capture", async () => {
  const fixture = createCursorFixture();
  try {
    const summary = await runCursorSdkQueueEntry({
      ...fixture,
      apiKey: "fixture-key",
      modelLister: fakeModelLister,
      agentFactory: fakeAgentFactory({ billingError: true, omitUsage: true }),
    });
    assert.equal(summary.captureQualification, "qualified");
    const observations = await createRetainedStructuralObservationSet(summary.bundlePath);
    assert.equal(observations.observations.find(({ id }) => id.endsWith(":input-token-count"))?.value.status, "unavailable");
    assert.match(readFileSync(join(summary.bundlePath, "native/session.jsonl"), "utf8"), /"stage":"billing"/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("treats a completed tool envelope with an error result as failure, not mutation", async () => {
  const fixture = createCursorFixture();
  try {
    const summary = await runCursorSdkQueueEntry({
      ...fixture,
      apiKey: "fixture-key",
      modelLister: fakeModelLister,
      agentFactory: fakeAgentFactory({ nestedToolError: true }),
    });
    const evidence = await createRetainedBehaviorEvidence(summary.bundlePath);
    assert.ok(evidence.dataset.events.some(({ family, attributes }) => family === "tool" && attributes.failed === true));
    assert.equal(evidence.dataset.events.filter(({ family }) => family === "artifact").length, 0);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("foreign, oversized, or model-mismatched native store records make capture unqualified", async () => {
  for (const behavior of [{ foreignStoreRecords: true }, { oversizedStoreRecord: true }, { storeModelMismatch: true }]) {
    const fixture = createCursorFixture();
    try {
      const summary = await runCursorSdkQueueEntry({
        ...fixture,
        apiKey: "fixture-key",
        modelLister: fakeModelLister,
        agentFactory: fakeAgentFactory(behavior),
      });
      assert.equal(summary.captureQualification, "unqualified");
      assert.equal(summary.classification, "capture-incomplete");
      await assert.rejects(createRetainedBehaviorEvidence(summary.bundlePath), /unqualified structural capture report|capture-qualified evidence/u);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("CLI exposes Cursor run usage and never accepts an incomplete invocation", async () => {
  const output: string[] = [];
  assert.equal(await main(["cursor", "run", "bundle", "queue", "run"], (message) => output.push(message)), 1);
  assert.equal(output.join(""), "Usage: ebo cursor run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]\n");
});

type Fixture = {
  parent: string;
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot: string;
};

function createCursorFixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "ebo-cursor-sdk-test-"));
  const bundleRoot = join(parent, "bundle");
  mkdirSync(bundleRoot, { recursive: true });
  const verified = JSON.parse(readFileSync("tests/fixtures/task-packet.valid.v1.json", "utf8")) as Extract<TaskPacket, { assessmentMode: "verified" }>;
  const { restricted: _restricted, ...common } = verified;
  const packet = { ...common, assessmentMode: "observational" as const } as TaskPacket;
  const writeRef = (reference: { locator: string; digest: { algorithm: "sha256"; value: string } }, locator: string, bytes: Buffer): void => {
    reference.locator = locator;
    reference.digest = digestBytes(bytes);
    const path = join(bundleRoot, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  writeRef(packet.agentInput.fixture.source, "components/fixture.tar.gz", fixtureArchive());
  if (!("reference" in packet.controlledPerturbation)) throw new Error("Fixture packet requires a perturbation reference.");
  writeRef(packet.controlledPerturbation.reference, "components/perturbation.json", Buffer.from('{"kind":"controlled"}\n'));
  const preAdmission = structuredClone(packet) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  writeRef(packet.admission.review!.reviewRecord, "restricted/review.json", Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: packet.admission.status,
    reviewedAt: packet.admission.review!.reviewedAt,
    reviewedBy: packet.admission.review!.reviewedBy,
  })));
  const packetPath = join(bundleRoot, "packets/task.json");
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(packet));
  freezeTaskPacket(bundleRoot, "packets/task.json");

  const records = {
    model: { schemaVersion: "ebo.cursor-sdk-config/v1", kind: "model", provider: "cursor", model: MODEL },
    harness: { schemaVersion: "ebo.cursor-sdk-config/v1", kind: "harness", adapter: "cursor-sdk", sdkVersion: "1.0.31" },
    limits: { schemaVersion: "ebo.cursor-sdk-config/v1", kind: "native-limits", shutdownGraceMs: 500, maxNativeRecordBytes: 1024 * 1024 },
    tools: {
      schemaVersion: "ebo.cursor-sdk-config/v1", kind: "native-tool-policy",
      tools: ["read", "edit", "grep", "glob", "ls"], disallowedTools: ["task", "mcp", "webSearch", "webFetch", "shell"],
      sandbox: { enabled: true }, settingSources: [], autoReview: false, enableAgentRetries: false,
    },
    capture: { schemaVersion: "ebo.cursor-sdk-config/v1", kind: "capture-profile", nativeOtlp: "unsupported", workspaceOutcome: { excludeDirectoryNames: ["node_modules"] } },
  };
  const experiment: ExperimentConfiguration = {
    schemaVersion: "ebo.experiment/v1",
    id: "cursor-sdk-fixture",
    taskSet: { task: { packetRef: { locator: "packets/task.json", digest: digestMetadata(packet) } } },
    modelSet: { "cursor-model-condition": { configurationRef: { locator: "configs/model.json", digest: digestBytes(Buffer.alloc(0)) } } },
    harnessSet: {
      "cursor-sdk": {
        configurationRef: { locator: "configs/harness.json", digest: digestBytes(Buffer.alloc(0)) },
        nativeLimitsRef: { locator: "configs/limits.json", digest: digestBytes(Buffer.alloc(0)) },
        nativeToolPolicyRef: { locator: "configs/tools.json", digest: digestBytes(Buffer.alloc(0)) },
      },
    },
    trialCount: 1,
    ordering: { seed: "cursor-fixture", strategy: "sequential", declaredOrder: { taskIds: ["task"], modelIds: ["cursor-model-condition"], harnessIds: ["cursor-sdk"] } },
    coordinatorBudget: { maxWallClockMs: 30_000 },
    captureProfile: { locator: "configs/capture.json", digest: digestBytes(Buffer.alloc(0)) },
  } as ExperimentConfiguration;
  writeConfig(experiment.modelSet["cursor-model-condition"]!.configurationRef, records.model, bundleRoot);
  writeConfig(experiment.harnessSet["cursor-sdk"]!.configurationRef, records.harness, bundleRoot);
  writeConfig(experiment.harnessSet["cursor-sdk"]!.nativeLimitsRef, records.limits, bundleRoot);
  writeConfig(experiment.harnessSet["cursor-sdk"]!.nativeToolPolicyRef, records.tools, bundleRoot);
  writeConfig(experiment.captureProfile, records.capture, bundleRoot);
  const queue = compileRunQueue(experiment, { bundleRoot });
  const queuePath = join(parent, "queue.json");
  writeRunQueue(queuePath, queue);
  const workspaceRoot = join(parent, "workspaces");
  mkdirSync(workspaceRoot);
  return { parent, bundleRoot, queuePath, runId: queue.entries[0]!.runId, outputRoot: join(parent, "out"), workspaceRoot };
}

function writeConfig(reference: { locator: string; digest: { algorithm: "sha256"; value: string } }, value: unknown, root: string): void {
  const bytes = Buffer.from(JSON.stringify(value));
  reference.digest = digestBytes(bytes);
  const path = join(root, reference.locator);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function fixtureArchive(): Buffer {
  const entries = [
    { path: "README.md", bytes: Buffer.from("# Cursor fixture\n"), type: "0" },
    { path: "package.json", bytes: Buffer.from("{}\n"), type: "0" },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n"), type: "0" },
  ];
  const blocks = entries.map(({ path, bytes, type }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
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

const fakeModelLister = async (): Promise<Array<{ id: string; displayName: string; parameters: Array<{ id: string; values: Array<{ value: string }> }> }>> => [{
  id: MODEL.id,
  displayName: "Cursor Test Model",
  parameters: [{ id: "thinking", values: [{ value: "low" }] }],
}];

function fakeAgentFactory(behavior: {
  historyError?: boolean;
  mismatchedStreamIdentity?: boolean;
  cleanupError?: boolean;
  billingError?: boolean;
  omitUsage?: boolean;
  waitError?: boolean;
  cancelledResult?: boolean;
  oversizedStreamRecord?: boolean;
  nestedToolError?: boolean;
  foreignStoreRecords?: boolean;
  oversizedStoreRecord?: boolean;
  mismatchedModelParams?: boolean;
  storeModelMismatch?: boolean;
} = {}): CursorSdkAgentFactory {
  return async (options: AgentOptions): Promise<SDKAgent> => {
    assert.equal(process.env.CURSOR_API_KEY, options.apiKey);
    assert.equal(process.env.EBO_CURSOR_TEST_SECRET, undefined);
    assert.equal(process.env.LINEAR_API_KEY, undefined);
    assert.deepEqual(options.local?.settingSources, []);
    assert.deepEqual(options.local?.sandboxOptions, { enabled: true });
    assert.equal(options.local?.autoReview, false);
    assert.equal(options.local?.enableAgentRetries, false);
    const store = options.local!.store!;
    const cwd = options.local!.cwd!;
    await store.agents.create({ agent: { agentId: AGENT_ID, cwd, status: "idle", createdAt: 1, updatedAt: 1,
      sdkMetadata: { blobEncryptionKey: "checkpoint-encryption-secret" } } });
    return {
      agentId: AGENT_ID,
      model: options.model,
      async send(_message: string | { text: string }, sendOptions?: SendOptions): Promise<Run> {
        await store.runs.create({ run: { runId: NATIVE_RUN_ID, agentId: AGENT_ID, turnNumber: 1, status: "running", model: options.model, createdAt: 1, updatedAt: 1 } });
        let status: Run["status"] = "running";
        let resolveDone!: () => void;
        const done = new Promise<void>((resolve) => { resolveDone = resolve; });
        const effectiveModel = behavior.mismatchedModelParams ? { id: MODEL.id, params: [{ id: "thinking", value: "high" }] } : options.model;
        const result: RunResult = { id: NATIVE_RUN_ID, status: behavior.cancelledResult ? "cancelled" : "finished", model: effectiveModel, durationMs: 17,
          usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 9, reasoningTokens: 2 } };
        const run: Run = {
          id: NATIVE_RUN_ID,
          agentId: AGENT_ID,
          model: effectiveModel,
          supports: () => true,
          unsupportedReason: () => undefined,
          async *stream() {
            const delta = { type: "thinking-delta", text: "hidden delta reasoning" } as never;
            await sendOptions?.onDelta?.({ update: delta });
            (delta as { text: string }).text = "mutated after callback";
            await sendOptions?.onStep?.({ step: { type: "assistantMessage", message: { text: "step snapshot" } } });
            writeFileSync(join(cwd, "result.txt"), "cursor completed\n");
            const identity = behavior.mismatchedStreamIdentity ? "foreign-agent" : AGENT_ID;
            const messages: SDKMessage[] = [
              { type: "system", subtype: "init", agent_id: identity, run_id: NATIVE_RUN_ID, model: options.model, tools: options.tools },
              { type: "tool_call", agent_id: AGENT_ID, run_id: NATIVE_RUN_ID, call_id: "tool-1", name: "edit", status: "running", args: { path: join(cwd, "result.txt"), nested: { unfamiliar: true } } },
              { type: "tool_call", agent_id: AGENT_ID, run_id: NATIVE_RUN_ID, call_id: "tool-1", name: "edit", status: "completed", args: { path: join(cwd, "result.txt") },
                result: behavior.nestedToolError ? { status: "error", error: { message: "blocked" } } : { status: "success", value: { ok: true, unknown: { payload: 1 } } } },
              ...behavior.omitUsage ? [] : [{ type: "usage" as const, agent_id: AGENT_ID, run_id: NATIVE_RUN_ID, usage: result.usage! }],
              { type: "thinking", agent_id: AGENT_ID, run_id: NATIVE_RUN_ID, text: "hidden stream reasoning" },
              { type: "assistant", agent_id: AGENT_ID, run_id: NATIVE_RUN_ID, message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
              ...behavior.oversizedStreamRecord ? [{ type: "assistant" as const, agent_id: AGENT_ID, run_id: NATIVE_RUN_ID,
                message: { role: "assistant" as const, content: [{ type: "text" as const, text: "x".repeat(1_100_000) }] } }] : [],
              { type: "status", agent_id: AGENT_ID, run_id: NATIVE_RUN_ID, status: "FINISHED" },
            ];
            try {
              for (const message of messages) yield message;
              status = "finished";
              await store.runs.update({ run: { ...(await store.runs.get({ agentId: AGENT_ID, runId: NATIVE_RUN_ID }))!,
                status: "finished", updatedAt: 2, endedAt: 2, usage: behavior.omitUsage ? null : result.usage,
                ...(behavior.storeModelMismatch ? { model: { id: MODEL.id, params: [{ id: "thinking", value: "high" }] } } : {}) } });
              await store.runEvents.append({ runId: NATIVE_RUN_ID, eventType: "interaction", payload: { type: "thinking-delta", text: "hidden store reasoning" } });
              await store.checkpoints.create({ agentId: AGENT_ID, blobId: "checkpoint-1", data: new Uint8Array([1, 2, 3, 4]) });
              if (behavior.foreignStoreRecords) {
                await store.runEvents.append({ runId: "foreign-run", eventType: "interaction", payload: { type: "text-delta", text: "foreign" } });
                await store.checkpoints.create({ agentId: "foreign-agent", blobId: "foreign-checkpoint", data: new Uint8Array([5]) });
              }
              if (behavior.oversizedStoreRecord) {
                await store.runEvents.append({ runId: NATIVE_RUN_ID, eventType: "interaction", payload: { text: "x".repeat(1_100_000) } });
              }
              await store.agents.update({ agent: { ...(await store.agents.get({ agentId: AGENT_ID }))!, status: "idle", activeRunId: null, updatedAt: 2,
                latestCheckpoint: { schemaVersion: 1, rootBlobId: "checkpoint-1" } } });
            } finally {
              resolveDone();
            }
          },
          async wait() { await done; if (behavior.waitError) throw new Error("injected missing terminal"); return result; },
          async conversation(): Promise<ConversationTurn[]> {
            if (behavior.historyError) throw new Error("injected history failure");
            return [{ type: "thinking", text: "hidden history reasoning" }] as unknown as ConversationTurn[];
          },
          async cancel() { status = "cancelled"; resolveDone(); },
          get status() { return status; },
          onDidChangeStatus() { return () => undefined; },
          result: undefined,
          error: undefined,
          usage: result.usage,
          durationMs: result.durationMs,
          git: undefined,
          createdAt: 1,
        };
        return run;
      },
      close() {},
      async reload() {},
      async [Symbol.asyncDispose]() { if (behavior.cleanupError) throw new Error("injected cleanup failure"); },
      async listArtifacts() { return []; },
      async downloadArtifact() { return Buffer.alloc(0); },
      async getUsage(): Promise<AgentUsage> {
        if (behavior.billingError) throw new Error("injected billing lag");
        return { usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 9, reasoningTokens: 2 }, runs: [] };
      },
    };
  };
}

function readManifest(bundleRoot: string): RunManifest {
  return JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as RunManifest;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
