import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { FACTORY_BYOK_MODEL_ID, type FactoryModelRoute } from "../src/factory-model.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { captureFactoryDroid, FACTORY_CLI_VERSION, FACTORY_SDK_VERSION, qualifyFactoryCapture,
  describeAndValidateFactoryDataset, type FactoryDroidConfiguration, type FactoryCapture } from "../src/factory-droid.js";
import { FACTORY_CONTRACT_DIGEST, captureFactoryDroidRun, runFactoryQueueEntry } from "../src/factory-run.js";
import { compileRunQueue, createPortableRunBundleExport, createRetainedBehaviorEvidence, createRetainedStructuralObservationSet,
  digestBytes, digestMetadata, freezeTaskPacket, main, readPortableRunBundleExport, writeRunQueue,
  selectReviewSample, writeReviewPacket,
  type BehaviorAssertion, type ExperimentConfiguration, type PortableExportPolicy, type RunBundleDefinition, type TaskPacket } from "../src/index.js";
import { visibleEvidence } from "../src/exports.js";
import { createFactoryHarborExecutor } from "../src/harbor/harnesses.js";
import { createNativeHarborExecutor, runHarborWorker, type HarborWorkerInput } from "../src/harbor/worker.js";
import { harborStepFixture } from "./harbor-step-helper.js";
import { laneData } from "../src/atlas-lanes.js";
import { deriveUnits } from "../src/atlas-units.js";
import { ownPointer } from "../src/atlas-bundle.js";

const byokRoute: FactoryModelRoute = { kind: "byok", provider: "generic-chat-completion-api", baseUrl: "https://api.fireworks.ai/inference/v1", maxOutputTokens: 4096 };
const fixture = resolve("test/fixtures/factory/fake-droid.mjs");
const CREDENTIAL_ENV = "EBO_FAKE_FACTORY_KEY";
const CREDENTIAL_VALUE = "factory-fixture-credential";
process.env[CREDENTIAL_ENV] = CREDENTIAL_VALUE;
process.env.EBO_FACTORY_UNRELATED = "must-not-be-forwarded";
function config(mode = "success"): FactoryDroidConfiguration {
  return { executable: process.execPath, executableArgs: [fixture, `--mode=${mode}`], version: FACTORY_CLI_VERSION,
    sdkVersion: FACTORY_SDK_VERSION, model: "fixture-model", reasoningEffort: "low", autonomyLevel: "off",
    permissionDecision: "proceed_once", credentialEnv: CREDENTIAL_ENV };
}
async function temporaryRoot() { return mkdtemp(join(tmpdir(), "ebo-factory-test-")); }
async function runFake(root: string, mode = "success", overrides: Partial<FactoryDroidConfiguration> = {}, signal?: AbortSignal) {
  const workspacePath = join(root, "workspace"); await mkdir(workspacePath, { recursive: true });
  return captureFactoryDroid({ runId: "factory-run", attemptId: "factory-attempt", workspacePath, prompt: "Create a result file.",
    configuration: { ...config(mode), ...overrides }, evidencePath: join(root, "session.jsonl"),
    shutdownGraceMs: 100, maxInMemoryObservations: 2, maxLineBytes: mode === "oversized" ? 4096 : undefined, signal });
}
const retainedOptions = (capture: FactoryCapture, expectsCompletion = true) => ({ sessionId: capture.sessionId, expectsCompletion,
  cliVersion: FACTORY_CLI_VERSION, sdkVersion: FACTORY_SDK_VERSION });

test("Factory real SDK records native frames before filtering and completes only the owned session/turn", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root);
    assert.equal(capture.terminalStatus, "completed", JSON.stringify({ gaps: capture.gaps, process: capture.process }));
    assert.equal(capture.sessionId, "fixture-factory-session");
    assert.ok(capture.process.droppedObservations > 0);
    assert.ok(capture.records.length > capture.process.observations.length);
    const text = await readFile(join(root, "session.jsonl"), "utf8");
    assert.ok(text.includes("future_fixture_event"));
    assert.ok(text.includes("FACTORY-HIDDEN-SENTINEL"));
    const outbound = capture.records.find(({ record }) => record.method === "droid.add_user_message")!.record;
    assert.deepEqual(JSON.parse(outbound.raw!), outbound.payload);
    const isolation = JSON.parse(await readFile(join(root, "workspace/isolation.json"), "utf8"));
    assert.equal(isolation.hasUnrelatedSecret, false); assert.equal(isolation.updater, "false");
    assert.equal(isolation.settings.cloudSessionSync, false);
    await assert.rejects(readFile(isolation.home), /ENOENT/);
    assert.equal(qualifyFactoryCapture(capture, retainedOptions(capture)).turnId, capture.turnId);
    const { dataset, coverage } = await describeAndValidateFactoryDataset(capture);
    assert.ok(coverage);
    assert.equal(dataset.events.filter(e => e.family === "tool").length, 2);
    assert.equal(dataset.events.filter(e => e.family === "message").length, 2, "completed message replaces streamed delta");
    assert.equal(dataset.events.filter(e => e.family === "outcome").length, 1);
    assert.ok(dataset.events.some(e => e.family === "delegation"));
    assert.ok(dataset.events.every(e => e.scope.id === capture.sessionId));
    assert.equal(dataset.events.find(e => e.family === "outcome")?.attributes.inputTokens, 4);
    const lane = laneData({ attempt_id: capture.attemptId, task_id: null, condition: null, trial_id: null,
      harness_id: "factory-droid", model_id: "fixture-model", terminal_state: "completed", failure_class: null,
      capture_qualification: "qualified" }, [], dataset.events);
    assert.equal(lane.lane.tokens_total, 10, "owned turn input/output/cache counts once, including child work");
    assert.ok(dataset.unmapped.some(({ reference }) => capture.records.find(r => r.reference.recordLocator === reference.recordLocator)?.record.raw?.includes("future_fixture_event")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ["crash", "malformed", "oversized", "missing-turn", "duplicate-terminal", "provider-error", "settings-mismatch"]) {
  test(`Factory ${mode} keeps a failed partial capture`, async () => {
    const root = await temporaryRoot();
    try {
      const capture = await runFake(root, mode);
      assert.equal(capture.terminalStatus, "failed", JSON.stringify(capture.gaps));
      assert.equal(capture.qualification, "qualified-with-gaps");
      assert.ok(capture.records.length > 0);
      if (mode !== "settings-mismatch") assert.ok((await readFile(join(root, "workspace/factory-result.txt"), "utf8")).includes("workspace change"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const permissionDecision of ["proceed_once", "cancel"] as const) {
  test(`Factory permissions retain the frozen ${permissionDecision} response`, async () => {
    const root = await temporaryRoot();
    try {
      const capture = await runFake(root, "permission", { permissionDecision });
      assert.equal(capture.terminalStatus, permissionDecision === "cancel" ? "interrupted" : "completed", JSON.stringify(capture.gaps));
      const decision = JSON.parse(await readFile(join(root, "workspace/permission.json"), "utf8"));
      assert.equal(decision.selectedOption, permissionDecision);
      assert.ok(capture.records.some(({ record }) => record.source === "ebo-factory-client" && record.id === "permission-fixture"));
      assert.ok((await describeAndValidateFactoryDataset(capture)).dataset.events.some(e => e.family === "permission"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const mode of ["hang", "delayed-interrupt"]) test(`Factory cancellation drains the ${mode} terminal after interrupt acknowledgement`, async () => {
  const root = await temporaryRoot(); const abort = new AbortController();
  try {
    const running = runFake(root, mode, {}, abort.signal);
    for (let i = 0; i < 500; i++) {
      if (await readFile(join(root, "workspace/factory-result.txt")).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    abort.abort(); const capture = await running;
    assert.equal(capture.terminalStatus, "interrupted");
    assert.ok(capture.records.some(({ record }) => record.method === "droid.interrupt_session"));
    assert.equal(capture.terminal?.reason, "cancelled", "delayed terminal and its usage survive interruption");
    assert.equal((capture.terminal?.tokenUsage as any)?.cacheReadTokens, 1);
    assert.notEqual(capture.process.termination, "interrupted", "OS interrupt is a fallback after draining");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Factory retained qualification rejects foreign identities, runtime mismatches and reordered terminals", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root);
    assert.throws(() => qualifyFactoryCapture(capture, { ...retainedOptions(capture), sessionId: "foreign" }), /identity differs/);
    assert.throws(() => qualifyFactoryCapture(capture, { ...retainedOptions(capture), sdkVersion: "unknown" }), /Unsupported/);
    const altered = structuredClone(capture);
    const terminal = altered.records.find(({ record }) => { const f = record.payload as any; return f?.params?.notification?.turnId === capture.turnId && f.params.sessionId === capture.sessionId; })!;
    (terminal.record.payload as any).params.notification.turnId = "foreign";
    assert.throws(() => qualifyFactoryCapture(altered, retainedOptions(capture)), /lacks an owned|raw frame differs/);
    const wrongPrompt = structuredClone(capture);
    const prompt = wrongPrompt.records.find(({ record }) => record.method === "droid.add_user_message")!.record;
    (prompt.payload as any).params.sessionId = "foreign";
    prompt.raw = JSON.stringify(prompt.payload);
    assert.throws(() => qualifyFactoryCapture(wrongPrompt, retainedOptions(capture)), /owned session evidence/);
    const wrongSettings = structuredClone(capture);
    const response = wrongSettings.records.find(({ record }) => (record.payload as any)?.result?.sessionId === capture.sessionId)!.record;
    (response.payload as any).result.settings.autonomyLevel = "high";
    response.raw = JSON.stringify(response.payload);
    assert.throws(() => qualifyFactoryCapture(wrongSettings, retainedOptions(capture)), /effective settings/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function definition(bundleRoot: string): RunBundleDefinition {
  return { bundleRoot, bundleId: "bundle-factory", run: { id: "run-factory", assessmentMode: "observational", task: { id: "task" },
    fixture: { id: "fixture", digest: `sha256:${"1".repeat(64)}` }, model: { provider: "factory", id: "fixture-model" },
    harness: { id: "factory-droid", version: FACTORY_CLI_VERSION }, runtime: [] }, attempt: { id: "attempt-factory", number: 1 },
    configuration: { digest: `sha256:${"2".repeat(64)}`, budgetDigest: `sha256:${"3".repeat(64)}`, toolPolicyDigest: `sha256:${"4".repeat(64)}` } };
}
test("Factory declined permissions retain an interrupted run bundle and native policy reason", async () => {
  const root = await temporaryRoot();
  try {
    const baseline = join(root, "baseline"), workspace = join(root, "workspace"); await mkdir(baseline); await mkdir(workspace);
    const bundle = join(root, "bundle");
    const result = await captureFactoryDroidRun({ definition: definition(bundle), startingWorkspacePath: baseline,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: { ...config("permission"), permissionDecision: "cancel" }, prompt: "Create a result file.", shutdownGraceMs: 100 });
    assert.equal(result.attempt.classification.kind, "interrupted");
    assert.equal(result.manifest.terminal.state, "interrupted");
    assert.equal(result.capture?.terminal?.reason, "permission_rejected");
    const retained = await createRetainedBehaviorEvidence(bundle);
    assert.equal(retained.dataset.events.find(e => e.family === "outcome")?.attributes.reason, "permission_rejected");
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const mode of ["slow-interrupt", "slow-close"]) test(`Factory finalization preserves the ${mode} producer's final evidence during cancellation`, async () => {
  const root = await temporaryRoot(); const abort = new AbortController(); let producer: Promise<FactoryCapture> | undefined;
  try {
    const baseline = join(root, "baseline"), workspace = join(root, "workspace"); await mkdir(baseline); await mkdir(workspace);
    const bundle = join(root, "bundle");
    const running = captureFactoryDroidRun({ definition: definition(bundle), startingWorkspacePath: baseline,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: config(mode), prompt: "Create a result file.", shutdownGraceMs: 20, signal: abort.signal,
      capture: request => producer = captureFactoryDroid({ ...request, shutdownGraceMs: 2_000 }) });
    for (let i = 0; i < 500; i++) {
      if (await readFile(join(workspace, "factory-result.txt")).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    abort.abort(); const result = await running;
    assert.equal(result.capture?.terminal?.reason, "cancelled", "finalization still waited for native drain");
    const descriptor = result.manifest.evidence.find(e => e.id === "session")!;
    const bytes = await readFile(join(bundle, descriptor.relativePath));
    assert.equal(descriptor.digest, `sha256:${digestBytes(bytes).value}`);
    assert.ok(bytes.toString("utf8").includes('"kind":"process"'));
    if (mode === "slow-close") {
      assert.ok((await readFile(join(bundle, "workspace.patch"), "utf8")).includes("workspace write during native close"), "workspace snapshot includes writes made after interrupt completed");
    }
    await createRetainedBehaviorEvidence(bundle);
  } finally { await producer?.catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
test("Factory run bundles reopen for retained behavioral and structural analysis and sanitized portable export", async () => {
  const root = await temporaryRoot();
  try {
    const baseline = join(root, "baseline"), workspace = join(root, "workspace"); await mkdir(baseline); await mkdir(workspace);
    const bundle = join(root, "bundle");
    const result = await captureFactoryDroidRun({ definition: definition(bundle), startingWorkspacePath: baseline,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: config(), prompt: "Create a result file.", shutdownGraceMs: 100 });
    assert.equal(result.manifest.terminal.state, "completed");
    const retained = await createRetainedBehaviorEvidence(bundle);
    assert.ok(retained.coverage); assert.ok(retained.dataset.events.some(e => e.family === "tool"));
    const observations = await createRetainedStructuralObservationSet(bundle);
    assert.ok(observations);
    assert.deepEqual(observations.observations.find(o => o.extractor.id === "cache-read-input-token-count")?.value,
      { status: "known", value: 1, unit: "tokens" });
    assert.deepEqual(observations.observations.find(o => o.extractor.id === "cache-creation-input-token-count")?.value,
      { status: "known", value: 3, unit: "tokens" });
    const units = deriveUnits({ attemptId: retained.dataset.attemptId, events: retained.dataset.events,
      occurrences: observations.occurrences ?? [], resolveContent: reference => {
        const [locator, pointer = ""] = reference.recordLocator.split("#");
        const record = retained.capture.records.find(r => r.reference.artifactId === reference.artifactId && r.reference.recordLocator === locator)?.record;
        return ownPointer(record, pointer.split("/").slice(1).map(t => t.replace(/~1/gu, "/").replace(/~0/gu, "~")));
      } });
    assert.ok(units.units.some(u => u.unit_kind === "message" && u.role === "user" && u.embed_text.includes("Create a result file.")), "Atlas retains the outbound prompt");
    assert.equal(units.units.filter(u => u.unit_kind === "message" && u.role === "assistant").length, 1);
    assert.equal(JSON.stringify(units).includes("FACTORY-HIDDEN-SENTINEL"), false);
    const cited = retained.dataset.events.find(e => e.family === "message" && e.actor.kind === "agent")!;
    const assertion: BehaviorAssertion = { schemaVersion: "ebo.behavior-assertion/v1", id: "factory-review",
      runId: retained.dataset.runId, attemptId: retained.dataset.attemptId,
      dataset: { schemaVersion: retained.dataset.schemaVersion, digest: `sha256:${digestMetadata(retained.dataset).value}` },
      behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
      rubric: { id: "fixture-rubric", version: "1.0.0" }, evaluator: { id: "fixture-judge", version: "1.0.0" },
      judgment: { disposition: "assessed", assessment: "context-dependent", confidence: { value: 0.8, scale: "evaluator-reported-0-to-1" },
        rationale: "The agent reports completion.", alternativeExplanation: "A completion message alone does not establish verification.",
        citations: [{ eventId: cited.id, nativeReference: cited.source.nativeReference }] } };
    const assertionPath = join(root, "assertion.json"); writeFileSync(assertionPath, JSON.stringify(assertion));
    const selection = await selectReviewSample({ schemaVersion: "ebo.review-source-set/v1", sources: [{ bundleRoot: bundle, assertionPath, taskContext: "Create a result file." }] },
      { schemaVersion: "ebo.review-sample-criteria/v1", seed: "factory", strata: [{ id: "all", sampleSize: 1, filters: {} }] });
    const packetRoot = join(root, "review-packet"); await writeReviewPacket(selection, packetRoot);
    const packet = JSON.parse(await readFile(join(packetRoot, "packet.json"), "utf8"));
    assert.ok((await readFile(join(packetRoot, packet.items[0].citations[0].href), "utf8")).includes("droid.session_notification"), "restricted human drilldown preserves the native frame");
    const policy: PortableExportPolicy = { sharingClass: "partner", maxStringBytes: 65536, maxArtifactBytes: 1024 * 1024, sensitiveValues: [CREDENTIAL_VALUE] };
    const exported = await createPortableRunBundleExport({ sourceRoot: bundle, destinationRoot: join(root, "export"), policy });
    assert.ok(exported);
    const sessionArtifact = exported.artifacts.find(artifact => artifact.kind === "session")!;
    const portableSession = await readFile(join(root, "export", sessionArtifact.relativePath), "utf8");
    assert.equal(portableSession.includes("FACTORY-HIDDEN-SENTINEL"), false);
    assert.equal(portableSession.includes("FACTORY-SIGNATURE-SENTINEL"), false);
    assert.equal(portableSession.includes(CREDENTIAL_VALUE), false);
    await readPortableRunBundleExport(join(root, "export"), policy);
    const sanitized = JSON.stringify(visibleEvidence(retained.capture.records));
    assert.equal(sanitized.includes("FACTORY-HIDDEN-SENTINEL"), false);
    assert.equal(sanitized.includes("FACTORY-SIGNATURE-SENTINEL"), false);
    assert.ok(sanitized.includes("Done"));
    assert.equal(JSON.stringify(visibleEvidence({ type: "tool_use", thoughtSignature: "PRIVATE", input: { path: "file" } })).includes("PRIVATE"), false);
    // Tampering the digest as well must not bypass the final readback scan.
    const injected = Buffer.from(portableSession + JSON.stringify({ type: "thinking_text_delta", textDelta: "PRIVATE" }) + "\n");
    writeFileSync(join(root, "export", sessionArtifact.relativePath), injected);
    sessionArtifact.digest = `sha256:${digestBytes(injected).value}`; sessionArtifact.sizeBytes = injected.length;
    writeFileSync(join(root, "export/manifest.json"), JSON.stringify(exported));
    await assert.rejects(readPortableRunBundleExport(join(root, "export"), policy), /Factory private reasoning/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Factory CLI exposes the packet runner and rejects incomplete syntax", async () => {
  let output = ""; assert.equal(await main(["--help"], message => { output += message; }), 0); assert.ok(output.includes("ebo factory run"));
  output = ""; assert.equal(await main(["factory", "run"], message => { output += message; }), 1); assert.ok(output.includes("Usage: ebo factory run"));
});

for (const byok of [false, true]) test(`Factory frozen queue execution uses the same native capture core (BYOK=${byok})`, async () => {
  const root = await temporaryRoot();
  try {
    const q = createQueueFixture(root, process.execPath, byok);
    const result = await runFactoryQueueEntry({ ...q, outputRoot: join(root, "runs"), workspaceRoot: join(root, "workspaces"),
      probeRuntime: async () => ({ path: process.execPath, version: FACTORY_CLI_VERSION }), executableArgs: [fixture] });
    assert.equal(result.terminal.state, "completed"); assert.ok(result.normalizedEvents > 0);
    await createRetainedBehaviorEvidence(result.bundlePath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const byok of [false, true]) test(`Factory Harbor executor and real worker dispatch retain the task filesystem (BYOK=${byok})`, async () => {
  const root = await temporaryRoot();
  try {
    const executable = join(root, "droid-fixture.mjs");
    writeFileSync(executable, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`, { mode: 0o700 });
    const q = createQueueFixture(root, executable, byok);
    const queue = JSON.parse(await readFile(q.queuePath, "utf8")); const entry = queue.entries[0];
    const configuration = { ...entry.configuration, captureProfile: queue.captureProfile };
    const input = harborStepFixture(root, "factory-droid");
    const executor = createFactoryHarborExecutor({ studyRoot: q.bundleRoot, configuration });
    const result = await executor(input);
    assert.equal(result.terminal.state, "completed", JSON.stringify(result));
    await createRetainedBehaviorEvidence(input.stepBundleRoot);
    const workerInput: HarborWorkerInput = { prepared: input.prepared, configuration, configurationRoot: q.bundleRoot,
      instruction: input.step.effectiveInstruction, stepIndex: 1, workspacePath: input.workspacePath, outputRoot: join(root, "worker"), maxWallClockMs: 10000 };
    assert.equal(typeof createNativeHarborExecutor(workerInput), "function");
    const worker = await runHarborWorker(workerInput);
    assert.equal(worker.terminal.state, "completed", JSON.stringify(worker));
    await createRetainedBehaviorEvidence(join(root, "worker/bundle"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

function createQueueFixture(parent: string, executable = process.execPath, byok = false): { bundleRoot: string; queuePath: string; runId: string } {
  const bundleRoot = join(parent, "queue-bundle");
  mkdirSync(bundleRoot, { recursive: true });
  const packet = JSON.parse(readFileSync(resolve("tests/fixtures/task-packet.valid.v1.json"), "utf8")) as Extract<TaskPacket, { assessmentMode: "verified" }>;
  const observational = (({ restricted: _restricted, ...value }) => ({ ...value, assessmentMode: "observational" as const }))(packet);
  observational.agentInput.prompt = "Create factory-result.txt containing done.";
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
    model: { schemaVersion: "ebo.factory-config/v1", kind: "model", provider: "factory", model: "fixture-model", reasoningEffort: "low", credentialEnv: CREDENTIAL_ENV, ...(byok ? { route: byokRoute } : {}) },
    harness: { schemaVersion: "ebo.factory-config/v1", kind: "harness", adapter: "factory-droid", executable, version: FACTORY_CLI_VERSION, sdkVersion: FACTORY_SDK_VERSION, contractDigest: FACTORY_CONTRACT_DIGEST },
    limits: { schemaVersion: "ebo.factory-config/v1", kind: "native-limits", shutdownGraceMs: 1_000 },
    tools: { schemaVersion: "ebo.factory-config/v1", kind: "native-tool-policy", autonomyLevel: "off", permissionDecision: "proceed_once" },
    capture: { schemaVersion: "ebo.factory-config/v1", kind: "capture-profile", workspaceOutcome: { excludeDirectoryNames: ["node_modules"] } },
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
    id: "factory-runner-fixture",
    taskSet: { task: { packetRef: { locator: "packets/task.json", digest: digestMetadata(observational) } } },
    modelSet: { "fixture-model": { configurationRef: references.model! } },
    harnessSet: { "factory-droid": {
      configurationRef: references.harness!,
      nativeLimitsRef: references.limits!,
      nativeToolPolicyRef: references.tools!,
    } },
    trialCount: 1,
    ordering: { seed: "factory", strategy: "sequential", declaredOrder: { taskIds: ["task"], modelIds: ["fixture-model"], harnessIds: ["factory-droid"] } },
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


test("Factory BYOK isolates credentials and corroborates retained upstream routing", async () => {
  const root = await temporaryRoot();
  try {
    const baseline = join(root, "baseline"), workspace = join(root, "workspace"); await mkdir(baseline); await mkdir(workspace);
    const bundle = join(root, "bundle"), d = definition(bundle); d.run.model.provider = "fireworks";
    const result = await captureFactoryDroidRun({ definition: d, startingWorkspacePath: baseline,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: { ...config(), route: byokRoute }, prompt: "Create a result file." });
    assert.equal(result.manifest.terminal.state, "completed");
    const isolation = JSON.parse(await readFile(join(workspace, "isolation.json"), "utf8"));
    assert.equal(isolation.hasFactoryCredential, false); assert.equal(isolation.hasByokCredential, true);
    assert.equal(isolation.hasSourceCredential, false);
    assert.equal(isolation.settings.customModels[0].apiKey, "${EBO_FACTORY_BYOK_API_KEY}");
    assert.equal(isolation.settings.customModels[0].model, d.run.model.id);
    assert.equal(isolation.settings.customModels[0].id, FACTORY_BYOK_MODEL_ID);
    const retained = await createRetainedBehaviorEvidence(bundle);
    assert.ok(retained.dataset.events.some(e => e.family === "tool"));
    await createRetainedStructuralObservationSet(bundle);
    const policy: PortableExportPolicy = { sharingClass: "partner", maxStringBytes: 65536, maxArtifactBytes: 1024 * 1024, sensitiveValues: [CREDENTIAL_VALUE] };
    const exported = await createPortableRunBundleExport({ sourceRoot: bundle, destinationRoot: join(root, "export"), policy });
    for (const artifact of exported.artifacts) assert.equal((await readFile(join(root, "export", artifact.relativePath), "utf8")).includes(CREDENTIAL_VALUE), false);
    await readPortableRunBundleExport(join(root, "export"), policy);
    // Alter the route and its artifact digest together: native composition must still corroborate it.
    const descriptor = result.manifest.evidence.find(e => e.id === "telemetry")!;
    const path = join(bundle, descriptor.relativePath), telemetry = JSON.parse(await readFile(path, "utf8"));
    telemetry.effectiveConfiguration.modelSelection.route.baseUrl = "https://other.example/v1";
    const bytes = Buffer.from(JSON.stringify(telemetry)); writeFileSync(path, bytes);
    descriptor.digest = `sha256:${digestBytes(bytes).value}`; descriptor.sizeBytes = bytes.length;
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify(result.manifest));
    await assert.rejects(createRetainedBehaviorEvidence(bundle), /route differs from recorded composition/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Factory BYOK rejects secrets, route overrides and invalid provider settings before launch", async () => {
  const root = await temporaryRoot();
  try {
    for (const override of [ { apiKey: "literal-secret" }, { baseUrl: "https://user:pass@example.com/v1" },
      { baseUrl: "https://example.com/v1?api_key=value" }, { provider: "openai" }, { maxOutputTokens: 0 },
      { extraArgs: { model: "override" } }, { extraArgs: { apiKey: "literal-secret" } }, { extraArgs: { temperature: 9 } } ]) {
      await assert.rejects(runFake(root, "success", { route: { ...byokRoute, ...override } as FactoryModelRoute }));
    }
    await assert.rejects(runFake(root, "success", { model: "custom:unbound" }), /custom selector/);
    const partial = await runFake(root, "provider-error", { route: byokRoute });
    assert.equal(partial.terminalStatus, "failed");
    assert.equal(partial.telemetry.effectiveConfiguration.modelSelection?.nativeModelId, FACTORY_BYOK_MODEL_ID);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const nativeFactory = process.env.EBO_NATIVE_FACTORY_EXECUTABLE;
test("pinned native Factory BYOK uses Chat Completions through EBO without Factory credentials", {
  skip: !nativeFactory || !existsSync(nativeFactory), timeout: 90_000,
}, async () => {
  const root = await temporaryRoot(), requests: { path: string; model: string; authorization: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ path: req.url!, model: body.model, authorization: req.headers.authorization!, body });
      const tools = body.tools ?? [], create = tools.find((tool: any) => tool.function?.name === "Create");
      const done = body.messages.some((message: any) => message.role === "tool");
      const delta = !done && create ? { role: "assistant", tool_calls: [{ index: 0, id: "ebo-create", type: "function", function: {
        name: "Create", arguments: JSON.stringify({ file_path: join(root, "workspace/capture-proof.txt"), content: "EBO_FACTORY_OK" }) } }] }
        : { role: "assistant", content: "BYOK_PROBE_OK" };
      const common = { id: "chatcmpl-ebo-native", object: "chat.completion.chunk", created: 1, model: body.model };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }) + "\n\n");
      res.end("data: [DONE]\n\n");
    } catch { res.writeHead(500); res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseline = join(root, "baseline"), workspace = join(root, "workspace"); await mkdir(baseline); await mkdir(workspace);
    const d = definition(join(root, "bundle")); d.run.model = { provider: "fireworks", id: "accounts/fireworks/models/glm-5p3-flash" };
    const address = server.address() as { port: number };
    const result = await captureFactoryDroidRun({ definition: d, startingWorkspacePath: baseline,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: { ...config(), executable: nativeFactory!, executableArgs: undefined, model: d.run.model.id,
        route: { ...byokRoute, baseUrl: `http://127.0.0.1:${address.port}/v1`, extraArgs: { temperature: 0, reasoning_effort: "low" } } },
      prompt: "Use Create to write capture-proof.txt containing EBO_FACTORY_OK, then reply DONE.", signal: AbortSignal.timeout(60_000) });
    assert.equal(result.manifest.terminal.state, "completed", JSON.stringify(result.capture?.gaps));
    assert.ok(requests.length >= 2); assert.ok(requests.every(r => r.path === "/v1/chat/completions" && r.model === d.run.model.id && r.authorization === `Bearer ${CREDENTIAL_VALUE}`));
    assert.ok(requests.every(r => r.body.temperature === 0 && r.body.reasoning_effort === "low"));
    assert.ok(!result.capture!.telemetry.effectiveConfiguration.environmentKeys.includes("FACTORY_API_KEY"));
    assert.equal((await readFile(join(workspace, "capture-proof.txt"), "utf8")).trim(), "EBO_FACTORY_OK");
    const retained = await createRetainedBehaviorEvidence(d.bundleRoot);
    assert.ok(retained.dataset.events.some(e => e.family === "tool"));
    const policy: PortableExportPolicy = { sharingClass: "partner", maxStringBytes: 65536, maxArtifactBytes: 8 * 1024 * 1024, sensitiveValues: [CREDENTIAL_VALUE] };
    await createPortableRunBundleExport({ sourceRoot: d.bundleRoot, destinationRoot: join(root, "export"), policy });
    await readPortableRunBundleExport(join(root, "export"), policy);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

// Opt-in live check: credentials are supplied through the process environment.
// EBO_LIVE_FACTORY_EXECUTABLE must be the absolute pinned binary path.
// EBO_LIVE_FACTORY_MODEL and EBO_LIVE_FACTORY_EFFORT select the authorized condition.
test("live Factory CLI tool capture and retained readback", { skip: process.env.EBO_LIVE_FACTORY_CAPTURE_SMOKE !== "1", timeout: 180_000 }, async t => {
  const byok = process.env.EBO_LIVE_FACTORY_ROUTE === "byok";
  const credentialEnv = byok ? "FIREWORKS_API_KEY" : "FACTORY_API_KEY";
  assert.ok(process.env[credentialEnv]);
  assert.ok(process.env.EBO_LIVE_FACTORY_EXECUTABLE);
  assert.ok(process.env.EBO_LIVE_FACTORY_MODEL);
  const root = await temporaryRoot();
  t.diagnostic(`Retained live evidence: ${root}`);
  const baseline = join(root, "baseline"), workspace = join(root, "workspace"); await mkdir(baseline); await mkdir(workspace);
  const model = process.env.EBO_LIVE_FACTORY_MODEL!;
  const d = definition(join(root, "bundle")); d.run.model.id = model;
  const configuration: FactoryDroidConfiguration = { ...config(), executable: process.env.EBO_LIVE_FACTORY_EXECUTABLE!, executableArgs: undefined,
    credentialEnv, ...(byok ? { route: byokRoute } : {}), model, reasoningEffort: (process.env.EBO_LIVE_FACTORY_EFFORT ?? "low") as FactoryDroidConfiguration["reasoningEffort"] };
  const result = await captureFactoryDroidRun({ definition: d, startingWorkspacePath: baseline,
    workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) }, configuration,
    prompt: "Synthetic capture qualification. Create capture-proof.txt containing exactly EBO_FACTORY_OK using a native file or shell tool, then reply DONE. Do nothing else.",
    maxWallClockMs: 120_000, signal: AbortSignal.timeout(130_000) });
  assert.equal(result.manifest.terminal.state, "completed", JSON.stringify(result.capture?.gaps));
  assert.equal((await readFile(join(workspace, "capture-proof.txt"), "utf8")).trim(), "EBO_FACTORY_OK");
  const retained = await createRetainedBehaviorEvidence(d.bundleRoot);
  assert.ok(retained.dataset.events.some(event => event.family === "tool"));
  const policy: PortableExportPolicy = { sharingClass: "partner", maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 65536 };
  await createPortableRunBundleExport({ sourceRoot: d.bundleRoot, destinationRoot: join(root, "export"), policy });
  await readPortableRunBundleExport(join(root, "export"), policy);
});
