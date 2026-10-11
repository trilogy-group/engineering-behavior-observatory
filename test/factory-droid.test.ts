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
  type ExperimentConfiguration, type PortableExportPolicy, type RunBundleDefinition, type TaskPacket } from "../src/index.js";
import { visibleEvidence } from "../src/exports.js";
import { createFactoryHarborExecutor } from "../src/harbor/harnesses.js";
import { createNativeHarborExecutor, runHarborWorker, type HarborWorkerInput } from "../src/harbor/worker.js";
import { harborStepFixture } from "./harbor-step-helper.js";

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
    assert.equal(capture.terminalStatus, "completed", JSON.stringify(capture.gaps));
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
      assert.equal(capture.terminalStatus, permissionDecision === "cancel" ? "failed" : "completed", JSON.stringify(capture.gaps));
      const decision = JSON.parse(await readFile(join(root, "workspace/permission.json"), "utf8"));
      assert.equal(decision.selectedOption, permissionDecision);
      assert.ok(capture.records.some(({ record }) => record.source === "ebo-factory-client" && record.id === "permission-fixture"));
      assert.ok((await describeAndValidateFactoryDataset(capture)).dataset.events.some(e => e.family === "permission"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("Factory cancellation interrupts a live prompt and drains partial evidence", async () => {
  const root = await temporaryRoot(); const abort = new AbortController();
  try {
    const running = runFake(root, "hang", {}, abort.signal);
    for (let i = 0; i < 500; i++) {
      if (await readFile(join(root, "workspace/factory-result.txt")).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    abort.abort(); const capture = await running;
    assert.equal(capture.terminalStatus, "interrupted");
    assert.ok(capture.records.some(({ record }) => record.method === "droid.interrupt_session"));
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

test("Factory frozen queue execution uses the same native capture core", async () => {
  const root = await temporaryRoot();
  try {
    const q = createQueueFixture(root);
    const result = await runFactoryQueueEntry({ ...q, outputRoot: join(root, "runs"), workspaceRoot: join(root, "workspaces"),
      probeRuntime: async () => ({ path: process.execPath, version: FACTORY_CLI_VERSION }), executableArgs: [fixture] });
    assert.equal(result.terminal.state, "completed"); assert.ok(result.normalizedEvents > 0);
    await createRetainedBehaviorEvidence(result.bundlePath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Factory Harbor executor and real worker dispatch retain the task filesystem", async () => {
  const root = await temporaryRoot();
  try {
    const executable = join(root, "droid-fixture.mjs");
    writeFileSync(executable, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`, { mode: 0o700 });
    const q = createQueueFixture(root, executable);
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

function createQueueFixture(parent: string, executable = process.execPath): { bundleRoot: string; queuePath: string; runId: string } {
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
    model: { schemaVersion: "ebo.factory-config/v1", kind: "model", provider: "factory", model: "fixture-model", reasoningEffort: "low", credentialEnv: CREDENTIAL_ENV },
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


// Opt-in live check: credentials are supplied through the process environment.
// EBO_LIVE_FACTORY_EXECUTABLE must be the absolute pinned binary path.
// EBO_LIVE_FACTORY_MODEL and EBO_LIVE_FACTORY_EFFORT select the authorized condition.
test("live Factory CLI tool capture and retained readback", { skip: process.env.EBO_LIVE_FACTORY_CAPTURE_SMOKE !== "1", timeout: 180_000 }, async t => {
  assert.ok(process.env.FACTORY_API_KEY);
  assert.ok(process.env.EBO_LIVE_FACTORY_EXECUTABLE);
  assert.ok(process.env.EBO_LIVE_FACTORY_MODEL);
  const root = await temporaryRoot();
  t.diagnostic(`Retained live evidence: ${root}`);
  const baseline = join(root, "baseline"), workspace = join(root, "workspace"); await mkdir(baseline); await mkdir(workspace);
  const model = process.env.EBO_LIVE_FACTORY_MODEL!;
  const d = definition(join(root, "bundle")); d.run.model.id = model;
  const configuration: FactoryDroidConfiguration = { ...config(), executable: process.env.EBO_LIVE_FACTORY_EXECUTABLE!, executableArgs: undefined,
    credentialEnv: "FACTORY_API_KEY", model, reasoningEffort: (process.env.EBO_LIVE_FACTORY_EFFORT ?? "low") as FactoryDroidConfiguration["reasoningEffort"] };
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
