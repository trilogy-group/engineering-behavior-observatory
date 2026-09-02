import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAdapterContract,
  createDeepSeekHarnessAdapter,
  createDeepSeekRuntimeComposition,
  createRunBundleAssembler,
  deepSeekCapabilities,
  deepSeekCompositionDigest,
  DeepSeekNativeCapture,
  digestBytes,
  executeDeepSeekHarness,
  normalizeDeepSeekCapture,
  qualifyRunBundle,
  qualifiedDeepSeekCapture,
  validateArtifact,
  type DeepSeekCaptureReport,
  type DeepSeekHarnessConfiguration,
  type DeepSeekRuntimeComposition,
  type DeepSeekRuntimeCompositionInput,
  type HarnessExecutionContext,
  type RunBundleDefinition,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "test/fixtures/deepseek");
const SHA = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;

test("records a controlled official-client run and normalizes only native-linked facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-adapter-"));
  const composition = fixtureComposition("minimal");
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  const context = harnessContext(undefined, undefined, undefined, composition.workspaceCwd);
  try {
    const execution = await executeDeepSeekHarness(context, configuration(composition, "success"), capture);
    await capture.close();
    const report = execution.evidence as DeepSeekCaptureReport;
    const golden = jsonFixture("golden-success.json") as {
      requests: string[];
      responses: string[];
      notifications: string[];
      sessionEventTypes: string[];
    };

    assert.equal(execution.status, "completed");
    assert.deepEqual(report.serverInfo, { name: "deepseek-harness-sdk-runtime", version: "fake-1.0.0" });
    assert.ok(report.receiptSequence !== undefined);
    assert.ok(report.idleSequence !== undefined && report.idleSequence > report.receiptSequence);
    assert.deepEqual((execution.completionEvidence as { promptResult: unknown }).promptResult, { status: "unsupported" });
    assert.deepEqual(methods(report, "request"), golden.requests);
    assert.deepEqual(methods(report, "response"), golden.responses);
    assert.deepEqual([...new Set(methods(report, "notification"))], golden.notifications);
    const events = sessionEvents(report);
    assert.deepEqual(events.map((event) => event.type), golden.sessionEventTypes);
    const rootEvents = sessionEvents(report, "session-deepseek-fixture");
    assert.deepEqual(rootEvents.map((event) => event.seq), Array.from({ length: 19 }, (_, index) => index + 1));
    assert.deepEqual(sessionEvents(report, "child-fixture-1").map((event) => event.seq), [1]);
    assert.ok(report.records.some((record) => record.method === "session.event" && record.sessionId === "child-fixture-1"));
    assert.deepEqual(report.relatedSessionIds, ["child-fixture-1"]);
    assert.equal(events.find((event) => event.type === "user/message")?.surfaceOp, "append");
    assert.equal(Object.hasOwn(events.find((event) => event.type === "turn/start")!, "surfaceOp"), false);

    const qualified = qualifiedDeepSeekCapture(context.run.id, context.attempt.id, report);
    const normalized = normalizeDeepSeekCapture(qualified);
    assert.ok(normalized.events.some((event) => event.family === "tool"));
    assert.ok(normalized.events.some((event) => event.family === "context"));
    assert.ok(normalized.events.some((event) => event.family === "delegation"));
    assert.ok(normalized.events.some((event) => event.family === "validation"));
    assert.ok(normalized.events.some((event) => event.family === "artifact"));
    assert.ok(normalized.events.every((event) => event.source.nativeReference.artifactId === "deepseek-session"));
    assert.ok(normalized.events.every((event) => event.source.nativeReference.recordLocator.startsWith("line:")));
    assert.ok(normalized.unmapped.some(({ reason }) => reason.includes("session.event")));
    for (const line of readFileSync(capture.path, "utf8").trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("implements the uniform adapter contract through the official public client", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-contract-"));
  const composition = fixtureComposition("minimal");
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  try {
    const result = await assertAdapterContract(createDeepSeekHarnessAdapter(), {
      context: harnessContext(undefined, undefined, undefined, composition.workspaceCwd),
      configuration: configuration(composition, "success"),
      capture,
    }, { resolve: ({ artifactId, recordLocator }) => artifactId === "deepseek-session" && recordLocator.startsWith("line:") });

    assert.ok(result.events.length > 0);
    assert.equal(result.unmapped.length, 1);
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("packages a verified smoke bundle and qualifies session evidence without invented hooks or spans", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-bundle-"));
  const bundleRoot = join(root, "bundle");
  const start = join(root, "start");
  const final = join(root, "final");
  mkdirSync(start);
  writeFileSync(join(start, "result.txt"), "before\n");
  cpSync(start, final, { recursive: true });
  writeFileSync(join(final, "result.txt"), "after\n");
  const composition = fixtureComposition("minimal", final);
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-deepseek-smoke",
    run: {
      id: "run-deepseek-smoke",
      assessmentMode: "verified",
      task: { id: "task-deepseek-smoke" },
      fixture: { id: "fixture-deepseek-smoke", digest: SHA("a") },
      model: { provider: composition.route.provider, id: composition.route.model },
      harness: { id: "deepseek-harness", version: composition.runtime.clientVersion },
      runtime: [
        { source: "deepseek-ai", name: "deepseek-harness", version: composition.runtime.clientVersion },
        { source: "deepseek-ai", name: "dsh-sdk-protocol", version: composition.runtime.protocolVersion },
      ],
    },
    attempt: { id: "attempt-deepseek-smoke", number: 1 },
    configuration: { digest: deepSeekCompositionDigest(composition), budgetDigest: SHA("b"), toolPolicyDigest: SHA("c") },
  };
  const assembler = await createRunBundleAssembler(definition);
  const capture = new DeepSeekNativeCapture(join(bundleRoot, "deepseek/session.jsonl"));
  try {
    const execution = await executeDeepSeekHarness(harnessContext(
      definition.run.id,
      definition.attempt.id,
      undefined,
      final,
    ), configuration(composition, "success"), capture);
    await capture.close();
    await assembler.registerArtifact({
      id: "deepseek-session",
      source: "deepseek-harness-sdk",
      kind: "session",
      mediaType: "application/x-ndjson",
      sharingClass: "restricted",
      relativePath: "deepseek/session.jsonl",
      nativeReference: { type: "session", id: "session-deepseek-fixture" },
    });
    const workspace = await assembler.captureWorkspaceOutcome({ startPath: start, finalPath: final, id: "workspace" });
    await assembler.writeJsonArtifact({
      id: "verifier",
      source: "ebo-verifier",
      kind: "verifier",
      mediaType: "application/json",
      sharingClass: "restricted",
      relativePath: "verifier.json",
    }, {
      schemaVersion: "verifier-result/v1",
      bundleId: definition.bundleId,
      status: "passed",
      exitCode: 0,
      workspace: { artifactId: workspace.descriptor.id, digest: workspace.descriptor.digest, fingerprint: workspace.fingerprint },
      assertions: [{ id: "deepseek-smoke", status: "passed" }],
    });
    const qualificationOptions = {
      startingWorkspacePath: start,
      semanticEvidenceKinds: ["session" as const],
      relatedSessionIds: (execution.evidence as DeepSeekCaptureReport).relatedSessionIds,
    };
    const manifest = await assembler.finalize({
      terminal: { state: "completed", failureClass: "none", stopReason: "none", workspaceArtifactId: workspace.descriptor.id },
      missingEvidence: [{ kind: "telemetry", reason: "unsupported", affects: ["timing-resource"] }],
      qualification: qualificationOptions,
    });
    const qualification = await qualifyRunBundle(bundleRoot, qualificationOptions);
    const normalized = normalizeDeepSeekCapture(qualifiedDeepSeekCapture(
      definition.run.id,
      definition.attempt.id,
      execution.evidence as DeepSeekCaptureReport,
    ));

    assert.equal(qualification.status, "qualified");
    assert.equal(manifest.run.native?.sessionId, "session-deepseek-fixture");
    assert.ok(manifest.evidence.some((entry) => entry.id === "deepseek-session"));
    assert.ok(manifest.evidence.some((entry) => entry.id === "verifier"));
    assert.ok(normalized.events.every((event) => event.attemptId === definition.attempt.id));
    const reportDescriptor = manifest.evidence.find((entry) => entry.kind === "capture-report")!;
    const captureReport = JSON.parse(readFileSync(join(bundleRoot, reportDescriptor.relativePath), "utf8")) as {
      semanticEvidenceKinds: string[];
      capabilities: { timingResource: { status: string } };
    };
    assert.deepEqual(captureReport.semanticEvidenceKinds, ["session"]);
    assert.equal(captureReport.capabilities.timingResource.status, "unsupported");
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a caller override that weakens the retained semantic evidence profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-qualification-override-"));
  const bundleRoot = join(root, "bundle");
  cpSync(join(repositoryRoot, "test/fixtures/run-bundles/complete"), bundleRoot, { recursive: true });
  try {
    const manifestPath = join(bundleRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      evidence: Array<{ kind: string; relativePath: string; digest: string; sizeBytes: number }>;
    };
    const descriptor = manifest.evidence.find(({ kind }) => kind === "capture-report")!;
    const reportPath = join(bundleRoot, descriptor.relativePath);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    report.semanticEvidenceKinds = ["session", "hook"];
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
    writeFileSync(reportPath, bytes);
    descriptor.digest = `sha256:${digestBytes(bytes).value}`;
    descriptor.sizeBytes = bytes.length;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    const qualification = await qualifyRunBundle(bundleRoot, { semanticEvidenceKinds: ["session"] });
    assert.equal(qualification.status, "unqualified");
    assert.ok(qualification.reasons.some(({ code, detail }) =>
      code === "CAPTURE_REPORT_CONTRADICTS_SOURCE" && detail.includes("semantic-evidence")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains delivered native events and clean shutdown after interruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-interrupt-"));
  const controller = new AbortController();
  const capture = new SlowAbortCapture(join(root, "session.jsonl"), controller);
  const composition = fixtureComposition("minimal");
  const golden = jsonFixture("golden-interrupted.json") as {
    terminal: string;
    lastSessionEventType: string;
    requiredRetainedMethods: string[];
  };
  try {
    const execution = await executeDeepSeekHarness(
      harnessContext(undefined, undefined, controller.signal, composition.workspaceCwd),
      configuration(composition, "interrupt"),
      capture,
    );
    await capture.close();
    const report = execution.evidence as DeepSeekCaptureReport;
    assert.equal(execution.status, golden.terminal);
    assert.equal(sessionEvents(report, "session-deepseek-fixture").at(-1)?.type, golden.lastSessionEventType);
    const retained = new Set(report.records.flatMap((record) => record.method ?? []));
    for (const method of golden.requiredRetainedMethods) assert.ok(retained.has(method), method);
    assert.equal(qualifiedDeepSeekCapture("run-deepseek", "attempt-deepseek", report).qualification, "qualified-with-gaps");
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("marks a native notification append failure as unqualified capture loss", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-notification-failure-"));
  const composition = fixtureComposition("minimal");
  const capture = new FailingNotificationCapture(join(root, "session.jsonl"));
  try {
    const execution = await executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, composition.workspaceCwd),
      configuration(composition, "success"),
      capture,
    );
    const report = execution.evidence as DeepSeekCaptureReport;
    assert.equal(execution.status, "failed");
    assert.match(execution.captureError ?? "", /fixture notification evidence failure/);
    assert.ok(report.records.some((record) => record.method === "session.event"));
    assert.throws(() => qualifiedDeepSeekCapture("run", "attempt", report), /unqualified/);
    assert.equal(execution.shutdownResult?.status, "completed");
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("never prompts an already-aborted or initialize-aborted attempt", async () => {
  for (const scenario of ["already-aborted", "initialize-aborted"] as const) {
    const root = mkdtempSync(join(tmpdir(), `ebo-deepseek-${scenario}-`));
    const composition = fixtureComposition("minimal");
    const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
    const controller = new AbortController();
    if (scenario === "already-aborted") controller.abort("before launch");
    else setTimeout(() => controller.abort("during initialize"), 50);
    try {
      const execution = await executeDeepSeekHarness(
        harnessContext(undefined, undefined, controller.signal, composition.workspaceCwd),
        configuration(composition, scenario === "already-aborted" ? "success" : "slow-initialize"),
        capture,
      );
      const report = execution.evidence as DeepSeekCaptureReport;
      assert.equal(execution.status, "interrupted");
      assert.equal(report.records.some((record) => record.method === "session/prompt"), false);
      assert.equal(execution.shutdownResult?.status, "completed");
    } finally {
      await capture.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("times out through official close while preserving the delivered partial stream", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-timeout-"));
  const composition = fixtureComposition("minimal");
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  try {
    const options = configuration(composition, "interrupt");
    options.activityTimeoutMs = 40;
    const execution = await executeDeepSeekHarness(harnessContext(undefined, undefined, undefined, composition.workspaceCwd), options, capture);
    await capture.close();
    const report = execution.evidence as DeepSeekCaptureReport;
    assert.equal(execution.status, "stopped");
    assert.ok(report.records.some((record) => record.method === "session.event"));
    assert.ok(report.records.some((record) => record.kind === "response" && record.method === "client.close"));
    assert.equal(qualifiedDeepSeekCapture("run", "attempt", report).qualification, "qualified-with-gaps");
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails a contaminated protocol runtime and retains only redacted stderr diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-contaminated-"));
  const composition = fixtureComposition("minimal");
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  try {
    const execution = await executeDeepSeekHarness(harnessContext(undefined, undefined, undefined, composition.workspaceCwd), configuration(
      composition,
      "contaminated",
      "fixture-secret",
    ), capture);
    await capture.close();
    const report = execution.evidence as DeepSeekCaptureReport;
    assert.equal(execution.status, "failed");
    assert.match(report.stderr ?? "", /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
    assert.ok(report.records.some((record) => record.kind === "diagnostic" && record.stream === "stderr"));
    assert.equal(report.records.some((record) => record.stream === ("stdout" as never)), false);
    assert.throws(() => qualifiedDeepSeekCapture("run", "attempt", report), /unqualified/);
    for (const line of readFileSync(capture.path, "utf8").trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("reaps the official client when shutdown evidence recording fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-capture-failure-"));
  const composition = fixtureComposition("minimal");
  const capture = new FailingShutdownCapture(join(root, "session.jsonl"));
  try {
    const execution = await executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, composition.workspaceCwd),
      configuration(composition, "success"),
      capture,
    );
    assert.equal(execution.shutdownResult?.status, "completed");
    assert.match(execution.captureError ?? "", /fixture shutdown evidence failure/);
    assert.throws(() => qualifiedDeepSeekCapture("run", "attempt", execution.evidence as DeepSeekCaptureReport), /unqualified/);
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a runtime workspace that differs from the retained lifecycle workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-workspace-mismatch-"));
  const composition = fixtureComposition("minimal");
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  try {
    await assert.rejects(executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, root),
      configuration(composition, "success"),
      capture,
    ), /workspace must match/);
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects launch arguments that diverge from retained runtime and patch artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-argv-mismatch-"));
  const composition = fixtureComposition("minimal");
  const changed = structuredClone(composition);
  changed.launch.args[0] = join(root, "other-runtime.mjs");
  cpSync(join(fixtureRoot, "fake-runtime.mjs"), changed.launch.args[0]!);
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  try {
    await assert.rejects(executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, composition.workspaceCwd),
      configuration(changed, "success"),
      capture,
    ), /launch arguments do not match/);
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a child home that differs from the retained composition", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-home-mismatch-"));
  const composition = fixtureComposition("minimal");
  const retained = structuredClone(composition);
  retained.launch.dshHome = join(root, "retained-home");
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  try {
    await assert.rejects(executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, composition.workspaceCwd),
      configuration(retained, "success"),
      capture,
    ), /outside the recorded environment allowlist/);
    retained.environment.allowedKeys.push("DSH_HOME");
    const options = configuration(retained, "success");
    options.env.DSH_HOME = join(root, "other-home");
    await assert.rejects(executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, composition.workspaceCwd),
      options,
      capture,
    ), /DSH_HOME does not match/);
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("swaps named compositions by configuration and reports explicit protocol and telemetry gaps", async () => {
  const minimal = fixtureComposition("minimal");
  const telemetry = fixtureComposition("telemetry");

  assert.equal(validateArtifact("minimal", minimal).length, 0);
  assert.equal(validateArtifact("telemetry", telemetry).length, 0);
  assert.equal(deepSeekCompositionDigest(minimal), deepSeekCompositionDigest(fixtureComposition("minimal")));
  assert.notEqual(deepSeekCompositionDigest(minimal), deepSeekCompositionDigest(telemetry));
  assert.equal(minimal.launch.command, telemetry.launch.command);
  assert.deepEqual(minimal.launch.args.slice(0, 3), telemetry.launch.args.slice(0, 3));
  assert.equal(deepSeekCapabilities(minimal).telemetry, "unsupported");
  assert.equal(deepSeekCapabilities(telemetry).telemetry, "available");
  assert.equal(deepSeekCapabilities(minimal).nativeSpans, "unsupported");
  assert.deepEqual({
    negotiation: deepSeekCapabilities(minimal).protocolVersionNegotiation,
    cancellation: deepSeekCapabilities(minimal).promptCancellation,
    close: deepSeekCapabilities(minimal).sessionClose,
    result: deepSeekCapabilities(minimal).promptResult,
  }, { negotiation: "unsupported", cancellation: "unsupported", close: "unsupported", result: "unsupported" });
  const packageDocument = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(packageDocument.dependencies["@deepseek-ai/dsh-sdk-client"], "0.1.1-rc.2");
  assert.equal(packageDocument.dependencies["@deepseek-ai/dsh-sdk-protocol"], "0.1.1-rc.2");
  assert.equal(minimal.patches.length, 2);
  assert.ok(minimal.patches.every(({ digest }) => digest.startsWith("sha256:")));
  assert.equal(minimal.launch.runtimeArtifact.locator, minimal.launch.args[0]);
  assert.ok(minimal.launch.runtimeArtifact.digest.startsWith("sha256:"));

  const [minimalRun, telemetryRun] = await Promise.all([
    controlledReport(minimal),
    controlledReport(telemetry),
  ]);
  assert.deepEqual(sessionEvents(minimalRun).map(({ type }) => type), sessionEvents(telemetryRun).map(({ type }) => type));
  assert.equal(minimalRun.capabilities.telemetry, "unsupported");
  assert.equal(telemetryRun.capabilities.telemetry, "available");

  const tamperedRoot = mkdtempSync(join(tmpdir(), "ebo-deepseek-tampered-composition-"));
  cpSync(join(fixtureRoot, "compositions", "minimal"), tamperedRoot, { recursive: true });
  const input = JSON.parse(readFileSync(join(tamperedRoot, "composition.json"), "utf8")) as Omit<DeepSeekRuntimeCompositionInput, "baseDir">;
  input.dshBin = join(fixtureRoot, "fake-runtime.mjs");
  const tampered = createDeepSeekRuntimeComposition({ ...input, baseDir: tamperedRoot });
  writeFileSync(join(tamperedRoot, "overlay.yml"), "plugins: {}\n");
  const capture = new DeepSeekNativeCapture(join(tamperedRoot, "session.jsonl"));
  try {
    await assert.rejects(executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, tampered.workspaceCwd),
      configuration(tampered, "success"),
      capture,
    ), /digest mismatch/);
  } finally {
    await capture.close();
    rmSync(tamperedRoot, { recursive: true, force: true });
  }
});

function fixtureComposition(name: "minimal" | "telemetry", workspaceCwd?: string): DeepSeekRuntimeComposition {
  const baseDir = join(fixtureRoot, "compositions", name);
  const input = JSON.parse(readFileSync(join(baseDir, "composition.json"), "utf8")) as Omit<DeepSeekRuntimeCompositionInput, "baseDir">;
  return createDeepSeekRuntimeComposition({ ...input, ...(workspaceCwd === undefined ? {} : { workspaceCwd }), baseDir });
}

function jsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));
}

function harnessContext(
  runId = "run-deepseek-fixture",
  attemptId = "attempt-deepseek-fixture",
  signal = new AbortController().signal,
  workspacePath = fixtureRoot,
): HarnessExecutionContext {
  return {
    run: { id: runId, taskId: "task-deepseek-fixture", modelId: "fake-model", harnessId: "deepseek-harness" },
    attempt: { id: attemptId, number: 1 },
    signal,
    workspace: { status: "ready", path: workspacePath, artifactId: "workspace", retained: true },
    registerShutdown: () => undefined,
  };
}

function configuration(
  composition: DeepSeekRuntimeComposition,
  scenario: "success" | "interrupt" | "contaminated" | "slow-initialize",
  secret = "",
): DeepSeekHarnessConfiguration {
  return {
    composition,
    input: "Inspect the fixture.",
    sessionId: "session-deepseek-fixture",
    env: { FAKE_SCENARIO: scenario, FAKE_SECRET: secret },
    requestTimeoutMs: 5_000,
    activityTimeoutMs: 10_000,
    shutdownTimeoutMs: 2_000,
    disposeEofGraceMs: 2_000,
    disposeGraceMs: 2_000,
  };
}

function methods(report: DeepSeekCaptureReport, kind: "request" | "response" | "notification"): string[] {
  return report.records.flatMap((record) => record.kind === kind && record.method !== undefined ? [record.method] : []);
}

function sessionEvents(report: DeepSeekCaptureReport, sessionId?: string): Array<Record<string, unknown>> {
  return report.records.flatMap((observation) => observation.method === "session.event"
    && (sessionId === undefined || observation.sessionId === sessionId)
    ? [(observation.payload as { event: Record<string, unknown> }).event]
    : []);
}

async function controlledReport(composition: DeepSeekRuntimeComposition): Promise<DeepSeekCaptureReport> {
  const root = mkdtempSync(join(tmpdir(), "ebo-deepseek-composition-"));
  const capture = new DeepSeekNativeCapture(join(root, "session.jsonl"));
  try {
    const execution = await executeDeepSeekHarness(
      harnessContext(undefined, undefined, undefined, composition.workspaceCwd),
      configuration(composition, "success"),
      capture,
    );
    return execution.evidence as DeepSeekCaptureReport;
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

class FailingShutdownCapture extends DeepSeekNativeCapture {
  public override async record(input: Parameters<DeepSeekNativeCapture["record"]>[0]) {
    if (input.method === "client.close" && input.kind === "request") {
      throw new Error("fixture shutdown evidence failure");
    }
    return super.record(input);
  }
}

class SlowAbortCapture extends DeepSeekNativeCapture {
  #delayed = false;

  public constructor(path: string, private readonly controller: AbortController) {
    super(path);
  }

  public override async record(input: Parameters<DeepSeekNativeCapture["record"]>[0]) {
    if (!this.#delayed && input.kind === "notification") {
      this.#delayed = true;
      setTimeout(() => this.controller.abort("fixture interruption with queued notifications"), 10);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return super.record(input);
  }
}

class FailingNotificationCapture extends DeepSeekNativeCapture {
  #failed = false;

  public override async record(input: Parameters<DeepSeekNativeCapture["record"]>[0]) {
    const event = (input.payload as { event?: { seq?: number } } | undefined)?.event;
    if (!this.#failed && input.kind === "notification" && input.method === "session.event" && event?.seq === 8) {
      this.#failed = true;
      throw new Error("fixture notification evidence failure");
    }
    return super.record(input);
  }
}
