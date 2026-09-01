import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type HookEvent,
  type HookInput,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  captureClaudeAgentSdkRun,
  createRunBundleAssembler,
  createRunIdentity,
  digestBytes,
  executeClaudeAgentSdk,
  executeRunAttempt,
  openClaudeAgentSdkHookCapture,
  openClaudeAgentSdkStreamCapture,
  probeClaudeAgentSdkCapabilities,
  qualifyRunBundle,
  type CaptureMissingEvidence,
  type CaptureQualificationReasonCode,
  type ClaudeAgentSdkAttemptEvidence,
  type ClaudeAgentSdkConfiguration,
  type ClaudeAgentSdkEvidenceSink,
  type RunManifest,
} from "../src/index.js";

type QueryInput = { prompt: string; options?: Options };
type QueryHandle = AsyncIterable<SDKMessage> & { close: () => void };
type QueryFunction = (input: QueryInput) => QueryHandle;
type Scenario = "success" | "optional-beta-gap" | "tool-failure-recovery" | "interrupted" | "verifier-error" | "collector-failure";

const SHA = (character: string) => `sha256:${character.repeat(64)}` as const;
const capabilities = probeClaudeAgentSdkCapabilities();
const configuration: ClaudeAgentSdkConfiguration = {
  prompt: "Reply with the inspected fixture state.",
  model: "claude-test",
  tools: ["Read"],
  allowedTools: ["Read"],
  disallowedTools: ["Write"],
  permissionMode: "dontAsk",
  maxTurns: 2,
  telemetry: {
    endpoint: "http://127.0.0.1:4318",
    protocol: "http/json",
    checkReceipt: () => ({ status: "received", signals: ["traces", "metrics", "logs"] }),
  },
};

for (const scenario of [
  { name: "success", status: "qualified", codes: [] },
  { name: "optional-beta-gap", status: "qualified-with-gaps", codes: ["OPTIONAL_BETA_TIMING_UNAVAILABLE"] },
  { name: "tool-failure-recovery", status: "qualified", codes: [] },
  { name: "interrupted", status: "unqualified", codes: ["VERIFIER_EVIDENCE_MISSING"] },
  { name: "verifier-error", status: "unqualified", codes: ["VERIFIER_RESULT_ERROR"] },
  { name: "collector-failure", status: "qualified-with-gaps", codes: ["TELEMETRY_RECEIPT_MISSING"] },
] as const) {
  test(`qualifies the native Agent SDK ${scenario.name} smoke`, async () => {
    const fixture = await assembleScenario(scenario.name);
    try {
      const report = await qualifyRunBundle(fixture.bundleRoot, {
        startingWorkspacePath: fixture.start,
        hookCapabilities: capabilities,
        expectedHooks: fixture.expectedHooks,
      });
      assert.equal(report.status, scenario.status, JSON.stringify(report.reasons));
      assert.equal(report.semanticAnalysisUsable, true);
      assert.deepEqual(report.attempt, { id: `attempt-${scenario.name}`, number: 1 });
      assert.deepEqual(Object.keys(report.dimensions), [
        "attemptIdentity", "semanticEvidence", "hooks", "telemetry", "workspace", "verifier", "terminal", "sharing",
      ]);
      assert.equal(fixture.queryCalls, 1, "the whole attempt must not retry silently");
      for (const code of scenario.codes) assert.ok(reasonCodes(report).has(code));
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(fixture.bundleRoot, "manifest.json"), "utf8")));
      assert.ok(readFileSync(join(fixture.bundleRoot, "session.jsonl")).length > 0);
      assert.equal(report.reasons.some((reason) => reason.code === "INFRASTRUCTURE_FAILURE_MISCLASSIFIED_AS_TASK"), false);
      if (scenario.name === "collector-failure") assert.equal(report.terminal?.failureClass, "none");
      if (scenario.name === "verifier-error") assert.equal(report.terminal?.failureClass, "infrastructure");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("distinguishes a supported missing hook from an unsupported pinned hook", async () => {
  const fixture = await assembleScenario("success", ["SessionStart"]);
  try {
    const supported = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: ["SessionStart"],
    });
    assert.ok(reasonCodes(supported).has("HOOK_SUPPORTED_BUT_MISSING"));

    const unsupportedProfile = {
      ...capabilities,
      hooks: Object.fromEntries(Object.entries(capabilities.hooks).filter(([hook]) => hook !== "SessionStart")) as typeof capabilities.hooks,
      unsupportedHooks: ["SessionStart"],
    };
    const unsupported = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: unsupportedProfile,
      expectedHooks: ["SessionStart"],
    });
    assert.ok(reasonCodes(unsupported).has("HOOK_UNSUPPORTED_BY_PINNED_SDK"));
    assert.equal(reasonCodes(unsupported).has("HOOK_SUPPORTED_BUT_MISSING"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const corruption of [
  { name: "empty JSON", artifact: "telemetry", bytes: Buffer.alloc(0), code: "NATIVE_JSON_EMPTY" },
  { name: "malformed JSON", artifact: "telemetry", bytes: Buffer.from("{"), code: "NATIVE_JSON_MALFORMED" },
  { name: "empty JSONL", artifact: "hooks", bytes: Buffer.alloc(0), code: "NATIVE_JSONL_EMPTY" },
  { name: "malformed JSONL", artifact: "session", bytes: Buffer.from('{"ok":true}\n{'), code: "NATIVE_JSONL_MALFORMED" },
] as const) {
  test(`rejects ${corruption.name} native evidence with a stable reason`, async () => {
    const fixture = await assembleScenario("success");
    try {
      rewriteEvidence(fixture.bundleRoot, corruption.artifact, corruption.bytes);
      const report = await qualifyRunBundle(fixture.bundleRoot, {
        startingWorkspacePath: fixture.start,
        hookCapabilities: capabilities,
        expectedHooks: fixture.expectedHooks,
      });
      assert.equal(report.status, "unqualified");
      assert.ok(reasonCodes(report).has(corruption.code), JSON.stringify(report.reasons));
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(fixture.bundleRoot, "manifest.json"), "utf8")));
      assert.doesNotThrow(() => readFileSync(join(fixture.bundleRoot, evidencePath(fixture.bundleRoot, corruption.artifact))));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("rejects an unusable workspace patch", async () => {
  const fixture = await assembleScenario("success");
  try {
    rewriteEvidence(fixture.bundleRoot, "workspace", Buffer.from("not a patch\n"));
    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.ok(reasonCodes(report).has("WORKSPACE_PATCH_UNUSABLE"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects capture-report facts contradicted by retained evidence", async () => {
  const fixture = await assembleScenario("success");
  try {
    const manifest = readManifest(fixture.bundleRoot);
    const descriptor = manifest.evidence.find((entry) => entry.kind === "capture-report")!;
    const captureReport = JSON.parse(readFileSync(join(fixture.bundleRoot, descriptor.relativePath), "utf8")) as {
      qualification: string;
      capabilities: { semantic: { status: string } };
      missingEvidence: unknown[];
    };
    captureReport.qualification = "incomplete";
    captureReport.capabilities.semantic.status = "missing";
    captureReport.missingEvidence = [{ kind: "session", reason: "not-collected", affects: ["semantic"] }];
    rewriteEvidence(fixture.bundleRoot, descriptor.id, Buffer.from(`${JSON.stringify(captureReport)}\n`));

    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.ok(reasonCodes(report).has("CAPTURE_REPORT_CONTRADICTS_SOURCE"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("binds descriptor session identity to retained native records", async () => {
  const fixture = await assembleScenario("success");
  try {
    const sessionPath = evidencePath(fixture.bundleRoot, "session");
    const records = readFileSync(join(fixture.bundleRoot, sessionPath), "utf8").trim().split("\n").map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.message !== null && typeof record.message === "object") {
        (record.message as Record<string, unknown>).session_id = "different-session";
      }
      return record;
    });
    rewriteEvidence(fixture.bundleRoot, "session", Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`));
    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.ok(reasonCodes(report).has("SESSION_RECORD_IDENTITY_MISMATCH"));
    assert.equal(report.semanticAnalysisUsable, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects syntactically valid hook JSONL without callback records", async () => {
  const fixture = await assembleScenario("success");
  try {
    rewriteEvidence(fixture.bundleRoot, "hooks", Buffer.from('{"sequence":1,"sessionId":"session-smoke"}\n'));
    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
    });
    assert.ok(reasonCodes(report).has("HOOK_RECORDS_MISSING"));
    assert.equal(report.semanticAnalysisUsable, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("keeps a usage-only telemetry artifact as an explicit receipt gap", async () => {
  const fixture = await assembleScenario("success");
  try {
    const manifest = readManifest(fixture.bundleRoot);
    const telemetryDescriptor = manifest.evidence.find((descriptor) => descriptor.kind === "telemetry")!;
    const telemetry = JSON.parse(readFileSync(join(fixture.bundleRoot, telemetryDescriptor.relativePath), "utf8")) as Record<string, unknown>;
    delete telemetry.telemetry;
    const telemetryBytes = Buffer.from(`${JSON.stringify(telemetry)}\n`);
    writeFileSync(join(fixture.bundleRoot, telemetryDescriptor.relativePath), telemetryBytes);
    telemetryDescriptor.digest = `sha256:${digestBytes(telemetryBytes).value}`;
    telemetryDescriptor.sizeBytes = telemetryBytes.length;

    const captureDescriptor = manifest.evidence.find((descriptor) => descriptor.kind === "capture-report")!;
    const captureReport = JSON.parse(readFileSync(join(fixture.bundleRoot, captureDescriptor.relativePath), "utf8")) as {
      qualification: string;
      capabilities: { timingResource: { status: string } };
      missingEvidence: unknown[];
    };
    captureReport.qualification = "incomplete";
    captureReport.capabilities.timingResource.status = "missing";
    captureReport.missingEvidence = [{ kind: "telemetry", reason: "not-collected", affects: ["timing-resource"] }];
    const captureBytes = Buffer.from(`${JSON.stringify(captureReport)}\n`);
    writeFileSync(join(fixture.bundleRoot, captureDescriptor.relativePath), captureBytes);
    captureDescriptor.digest = `sha256:${digestBytes(captureBytes).value}`;
    captureDescriptor.sizeBytes = captureBytes.length;
    writeFileSync(join(fixture.bundleRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.equal(report.status, "qualified-with-gaps", JSON.stringify(report.reasons));
    assert.ok(reasonCodes(report).has("TELEMETRY_RECEIPT_MISSING"));
    assert.equal(reasonCodes(report).has("CAPTURE_REPORT_CONTRADICTS_SOURCE"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reports unknown sharing independently without invalidating semantic analysis", async () => {
  const fixture = await assembleScenario("success");
  try {
    const manifest = readManifest(fixture.bundleRoot);
    manifest.evidence.find((descriptor) => descriptor.id === "session")!.sharingClass = "unknown";
    writeFileSync(join(fixture.bundleRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.equal(report.status, "qualified-with-gaps");
    assert.equal(report.semanticAnalysisUsable, true);
    assert.ok(reasonCodes(report).has("SHARING_CLASSIFICATION_UNKNOWN"));
    assert.equal(report.dimensions.sharing.status, "gap");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("preserves explicit unsupported telemetry as a qualified dimension", async () => {
  const fixture = await assembleScenario("success");
  try {
    const manifest = readManifest(fixture.bundleRoot);
    const captureDescriptor = manifest.evidence.find((descriptor) => descriptor.kind === "capture-report")!;
    const captureReport = JSON.parse(readFileSync(join(fixture.bundleRoot, captureDescriptor.relativePath), "utf8")) as {
      qualification: string;
      capabilities: { timingResource: { status: string } };
      missingEvidence: unknown[];
    };
    captureReport.qualification = "qualified";
    captureReport.capabilities.timingResource.status = "unsupported";
    captureReport.missingEvidence = [{ kind: "telemetry", reason: "unsupported", affects: ["timing-resource"] }];
    const bytes = Buffer.from(`${JSON.stringify(captureReport)}\n`);
    writeFileSync(join(fixture.bundleRoot, captureDescriptor.relativePath), bytes);
    captureDescriptor.digest = `sha256:${digestBytes(bytes).value}`;
    captureDescriptor.sizeBytes = bytes.length;
    manifest.evidence = manifest.evidence.filter((descriptor) => descriptor.kind !== "telemetry");
    if (manifest.run.native !== undefined) delete manifest.run.native.traceId;
    writeFileSync(join(fixture.bundleRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.equal(report.status, "qualified", JSON.stringify(report.reasons));
    assert.equal(report.dimensions.telemetry.status, "unsupported");
    assert.ok(reasonCodes(report).has("TELEMETRY_UNSUPPORTED_BY_PINNED_RUNTIME"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects native evidence above the documented qualification bound without reading it", async () => {
  const fixture = await assembleScenario("success");
  try {
    truncateSync(join(fixture.bundleRoot, evidencePath(fixture.bundleRoot, "hooks")), 64 * 1024 * 1024 + 1);
    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.equal(report.status, "unqualified");
    assert.ok(reasonCodes(report).has("ARTIFACT_TOO_LARGE"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("returns an attempt-identity report for an invalid manifest instead of throwing", async () => {
  const fixture = await assembleScenario("success");
  try {
    const manifest = readManifest(fixture.bundleRoot);
    manifest.attempt.number = 0;
    writeFileSync(join(fixture.bundleRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    const report = await qualifyRunBundle(fixture.bundleRoot);
    assert.equal(report.status, "unqualified");
    assert.ok(reasonCodes(report).has("ATTEMPT_IDENTITY_INVALID"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("reuses export-manifest qualification for unsafe ready exports", async () => {
  const fixture = await assembleScenario("success");
  try {
    const exportRoot = join(fixture.bundleRoot, "export");
    mkdirSync(exportRoot);
    const exportDocument = {
      schemaVersion: "export-manifest/v1", bundleId: "bundle-success", status: "ready", assessmentMode: "verified",
      sharingClass: "partner", policyDigest: SHA("e"), artifactIds: ["session"],
    };
    const bytes = Buffer.from(`${JSON.stringify(exportDocument)}\n`);
    writeFileSync(join(exportRoot, "manifest.json"), bytes);
    const manifest = readManifest(fixture.bundleRoot);
    manifest.evidence.push({
      id: "export-manifest", source: "ebo-export", kind: "export-manifest", authority: "export",
      mediaType: "application/json", digest: `sha256:${digestBytes(bytes).value}`, sizeBytes: bytes.length,
      sharingClass: "internal", relativePath: "export/manifest.json",
    });
    writeFileSync(join(fixture.bundleRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    const report = await qualifyRunBundle(fixture.bundleRoot, {
      startingWorkspacePath: fixture.start,
      hookCapabilities: capabilities,
      expectedHooks: fixture.expectedHooks,
    });
    assert.equal(report.dimensions.sharing.status, "unqualified");
    assert.ok(reasonCodes(report).has("EXPORT_MANIFEST_INVALID"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("passive capture leaves prompt and tool policy exactly unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-passive-capture-equality-"));
  try {
    const withoutCapture = await observedPolicy(root, noOpSink());
    const hookCapture = await openClaudeAgentSdkHookCapture(join(root, "hooks.jsonl"));
    const streamCapture = await openClaudeAgentSdkStreamCapture(join(root, "session.jsonl"), {
      ...noOpSink(),
      hook: hookCapture.hook,
      flush: hookCapture.flush,
    });
    try {
      const withCapture = await observedPolicy(root, streamCapture);
      assert.deepEqual(withCapture, withoutCapture);
      assert.deepEqual(withCapture, {
        prompt: configuration.prompt,
        tools: configuration.tools,
        allowedTools: configuration.allowedTools,
        disallowedTools: configuration.disallowedTools,
        permissionMode: configuration.permissionMode,
      });
    } finally {
      await Promise.all([streamCapture.close(), hookCapture.close()]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved live Agent SDK smoke records sanitized collector receipt", {
  skip: process.env.EBO_LIVE_AGENT_SDK_SMOKE !== "1",
  timeout: 120_000,
}, async () => {
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined, "unset stale API-key auth before the approved OAuth smoke");
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined, "unset stale auth-token override before the approved OAuth smoke");
  const root = mkdtempSync(join(tmpdir(), "ebo-live-agent-sdk-smoke-"));
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "fixture.txt"), "unchanged\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  const requests: Array<{ path: string; body: string }> = [];
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolvePromise) => receiver.listen(0, "127.0.0.1", resolvePromise));
  const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  try {
    const model = process.env.EBO_LIVE_AGENT_SDK_MODEL ?? "sonnet";
    const result = await captureClaudeAgentSdkRun({
      definition: {
        bundleRoot,
        bundleId: "bundle-live-smoke",
        run: {
          id: "run-live-smoke",
          assessmentMode: "verified",
          task: { id: "task-live-smoke" },
          fixture: { id: "fixture-live-smoke", digest: SHA("a") },
          model: { provider: "anthropic", id: model },
          harness: { id: "agent-sdk", version: capabilities.sdkVersion },
          runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }],
        },
        attempt: { id: "attempt-live-smoke", number: 1 },
        configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
      },
      startingWorkspacePath: start,
      workspace: {
        setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }),
        cleanup: async () => undefined,
      },
      configuration: {
        prompt: "Reply exactly OK. Do not use tools.",
        model,
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk",
        maxTurns: 1,
        maxBudgetUsd: 0.25,
        telemetry: {
          endpoint,
          protocol: "http/json",
          exportIntervalMs: 100,
          checkReceipt: (correlation) => {
            const paths = new Set(requests.map((request) => request.path));
            const signals = [
              ...(paths.has("/v1/traces") ? ["traces" as const] : []),
              ...(paths.has("/v1/metrics") ? ["metrics" as const] : []),
              ...(paths.has("/v1/logs") ? ["logs" as const] : []),
            ];
            const correlated = requests.every(({ body }) => Object.values(correlation.attributes).every((value) => body.includes(value)));
            return correlated && signals.length === 3
              ? { status: "received", signals }
              : { status: "missing", signals, reason: "partial-receipt" };
          },
        },
      },
      verifier: async (_context, workspace) => ({
        schemaVersion: "verifier-result/v1",
        bundleId: "bundle-live-smoke",
        status: "passed",
        exitCode: 0,
        workspace: {
          artifactId: workspace.descriptor.id,
          digest: workspace.descriptor.digest,
          fingerprint: workspace.fingerprint,
        },
        assertions: [{ id: "live-route", status: "passed" }],
      }),
    });
    const evidence = result.attempt.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence;
    assert.equal(result.attempt.classification.kind, "completed", JSON.stringify({
      classification: result.attempt.classification,
      harnessStatus: result.attempt.record.harness?.status,
      harnessReason: result.attempt.record.harness?.reason,
      harnessError: sanitizedDiagnostic(result.attempt.record.harness?.error),
      receipt: evidence.telemetry?.receipt,
    }));
    assert.equal(result.stream.status, "complete");
    assert.equal(result.qualification.status, "qualified", JSON.stringify(result.qualification.reasons));
    assert.deepEqual(evidence.telemetry?.receipt, { status: "received", signals: ["traces", "metrics", "logs"] });
    const structuralEvidence = {
      classification: result.attempt.classification.kind,
      qualification: result.qualification.status,
      messageRecords: readFileSync(join(bundleRoot, "session.jsonl"), "utf8").trim().split("\n").length,
      hookRecords: readFileSync(join(bundleRoot, "hooks.jsonl"), "utf8").trim().split("\n").filter(Boolean).length,
      collectorPaths: [...new Set(requests.map((request) => request.path))].sort(),
      receipt: evidence.telemetry?.receipt.status,
    };
    process.stdout.write(`live-agent-sdk-smoke ${JSON.stringify(structuralEvidence)}\n`);
  } finally {
    await new Promise<void>((resolvePromise, reject) => receiver.close((error) => error === undefined ? resolvePromise() : reject(error)));
    rmSync(root, { recursive: true, force: true });
  }
});

async function assembleScenario(scenario: Scenario, omitHooks: HookEvent[] = []) {
  const root = mkdtempSync(join(tmpdir(), `ebo-capture-qualification-${scenario}-`));
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "fixture.txt"), "before\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  writeFileSync(join(final, "fixture.txt"), "after\n");

  const attempt = { id: `attempt-${scenario}`, number: 1 } as const;
  const assembler = await createRunBundleAssembler({
    bundleRoot,
    bundleId: `bundle-${scenario}`,
    run: {
      id: `run-${scenario}`,
      assessmentMode: "verified",
      task: { id: "task-smoke" },
      fixture: { id: "fixture-smoke", digest: SHA("a") },
      model: { provider: "anthropic", id: "claude-test" },
      harness: { id: "agent-sdk", version: capabilities.sdkVersion },
      runtime: [
        { source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion },
        { source: "anthropic", name: "agent-cli", version: capabilities.claudeCodeVersion },
      ],
    },
    attempt,
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  });
  const hookCapture = await openClaudeAgentSdkHookCapture(join(bundleRoot, "hooks.jsonl"));
  const streamCapture = await openClaudeAgentSdkStreamCapture(join(bundleRoot, "session.jsonl"), {
    ...noOpSink(), hook: hookCapture.hook, flush: hookCapture.flush,
  });
  const controller = new AbortController();
  const calledHooks: HookEvent[] = scenario === "tool-failure-recovery"
    ? ["UserPromptSubmit", "SessionStart", "PreToolUse", "PostToolUseFailure", "PostToolUse", "SessionEnd"]
    : ["UserPromptSubmit", "SessionStart", "SessionEnd"];
  const expectedHooks = calledHooks.filter((hook) => !omitHooks.includes(hook));
  let queryCalls = 0;
  const query: QueryFunction = (input) => {
    queryCalls += 1;
    return stream(scenario === "interrupted" ? [assistantMessage()] : [assistantMessage(), sdkResult()], async () => {
      for (const hook of expectedHooks) {
        await input.options?.hooks?.[hook]?.[0]?.hooks[0]?.(hookInput(hook), undefined, { signal: new AbortController().signal });
      }
    }, scenario === "interrupted" ? () => controller.abort("fixture interruption") : undefined);
  };
  const result = await executeRunAttempt({
    run: createRunIdentity({ id: `run-${scenario}`, taskId: "task-smoke", modelId: "claude-test", harnessId: "agent-sdk" }),
    attempt,
    signal: controller.signal,
    workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
    harness: (context) => executeClaudeAgentSdk(context, {
      ...configuration,
      telemetry: {
        ...configuration.telemetry!,
        checkReceipt: () => scenario === "collector-failure"
          ? { status: "missing", signals: [], reason: "collector-unreachable" }
          : scenario === "interrupted"
            ? { status: "missing", signals: [], reason: "process-interrupted" }
            : { status: "received", signals: ["traces", "metrics", "logs"] },
      },
    }, streamCapture, query),
    verifier: scenario === "interrupted" ? undefined : async () => scenario === "verifier-error"
      ? { status: "error", error: "verifier infrastructure failed" }
      : { status: "passed" },
    evidence: streamCapture,
  });
  await Promise.allSettled([streamCapture.flush(), hookCapture.flush()]);
  await Promise.allSettled([streamCapture.close(), hookCapture.close()]);
  const streamReport = streamCapture.report();
  await assembler.registerArtifact({
    id: "session", source: "anthropic-agent-sdk", kind: "session", mediaType: "application/x-ndjson",
    sharingClass: "restricted", relativePath: "session.jsonl",
    nativeReference: { type: "session", id: streamReport.capabilities.sessionIdentity.status === "available"
      ? streamReport.capabilities.sessionIdentity.sessionId : "session-smoke" },
  });
  await assembler.registerArtifact({
    id: "hooks", source: "anthropic-agent-sdk", kind: "hook", mediaType: "application/x-ndjson",
    sharingClass: "restricted", relativePath: "hooks.jsonl",
  });
  const evidence = result.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence;
  await assembler.writeAgentSdkTelemetry({ evidence, traceId: `trace-${scenario}` });
  const workspace = await assembler.captureWorkspaceOutcome({ startPath: start, finalPath: final });
  if (scenario !== "interrupted") {
    await assembler.writeJsonArtifact({
      id: "verifier", source: "ebo-verifier", kind: "verifier", mediaType: "application/json",
      sharingClass: "restricted", relativePath: "verifier.json",
    }, scenario === "verifier-error" ? {
      schemaVersion: "verifier-result/v1", bundleId: `bundle-${scenario}`, status: "error",
      error: "verifier infrastructure failed", workspace: {
        artifactId: workspace.descriptor.id, digest: workspace.descriptor.digest, fingerprint: workspace.fingerprint,
      }, assertions: [],
    } : {
      schemaVersion: "verifier-result/v1", bundleId: `bundle-${scenario}`, status: "passed", exitCode: 0,
      workspace: { artifactId: workspace.descriptor.id, digest: workspace.descriptor.digest, fingerprint: workspace.fingerprint },
      assertions: [{ id: "task", status: "passed" }],
    });
  }
  const missingEvidence: CaptureMissingEvidence[] = scenario === "optional-beta-gap" ? [{
    kind: "detailed-beta-hook-span-timing", reason: "optional-beta-unavailable", affects: ["timing-resource"],
  }] : [];
  await assembler.finalize({ terminal: result.terminal, missingEvidence });
  return { root, start, bundleRoot, expectedHooks, get queryCalls() { return queryCalls; } };
}

async function observedPolicy(root: string, sink: ClaudeAgentSdkEvidenceSink) {
  let observed: QueryInput | undefined;
  const result = await executeRunAttempt({
    run: createRunIdentity({ id: `policy-${Math.random()}`, taskId: "policy", modelId: "claude-test", harnessId: "agent-sdk" }),
    workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace", retained: true }) },
    harness: (context) => executeClaudeAgentSdk(context, configuration, sink, (input) => {
      observed = input;
      return stream([sdkResult()]);
    }),
    verifier: async () => ({ status: "passed" }),
    evidence: sink,
  });
  assert.equal(result.classification.kind, "completed");
  assert.ok(observed);
  return {
    prompt: observed.prompt,
    tools: observed.options?.tools,
    allowedTools: observed.options?.allowedTools,
    disallowedTools: observed.options?.disallowedTools,
    permissionMode: observed.options?.permissionMode,
  };
}

function noOpSink(): ClaudeAgentSdkEvidenceSink {
  return { message: () => undefined, stderr: () => undefined, hook: () => undefined, lifecycle: () => undefined, flush: () => undefined };
}

function stream(
  messages: SDKMessage[],
  before?: () => void | Promise<void>,
  afterYield?: (index: number) => void | Promise<void>,
): QueryHandle {
  let closed = false;
  return {
    close: () => { closed = true; },
    async *[Symbol.asyncIterator]() {
      await before?.();
      for (const [index, message] of messages.entries()) {
        if (closed) break;
        yield message;
        await afterYield?.(index);
      }
    },
  };
}

function assistantMessage(): SDKMessage {
  return { type: "assistant", uuid: "assistant-1", session_id: "session-smoke", message: { role: "assistant", content: [] } } as unknown as SDKMessage;
}

function sdkResult(): SDKMessage {
  return {
    type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false,
    num_turns: 1, stop_reason: null, total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-test": { inputTokens: 1, outputTokens: 1, costUSD: 0.01 } },
    permission_denials: [], result: "done", session_id: "session-smoke", uuid: "result-1",
  } as unknown as SDKResultMessage;
}

function hookInput(hook: HookEvent): HookInput {
  return {
    hook_event_name: hook, session_id: "session-smoke", transcript_path: "/restricted/session.jsonl",
    cwd: "/attempt/workspace",
  } as unknown as HookInput;
}

function reasonCodes(report: Awaited<ReturnType<typeof qualifyRunBundle>>): Set<CaptureQualificationReasonCode> {
  return new Set(report.reasons.map((reason) => reason.code));
}

function sanitizedDiagnostic(value: string | undefined): string | undefined {
  return value?.slice(0, 2_000)
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_./+=-]{64,}/gu, "[redacted]");
}

function readManifest(bundleRoot: string): RunManifest {
  return JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as RunManifest;
}

function evidencePath(bundleRoot: string, artifactId: string): string {
  return readManifest(bundleRoot).evidence.find((descriptor) => descriptor.id === artifactId)!.relativePath;
}

function rewriteEvidence(bundleRoot: string, artifactId: string, bytes: Buffer): void {
  const manifest = readManifest(bundleRoot);
  const descriptor = manifest.evidence.find((entry) => entry.id === artifactId)!;
  writeFileSync(join(bundleRoot, descriptor.relativePath), bytes);
  descriptor.digest = `sha256:${digestBytes(bytes).value}`;
  descriptor.sizeBytes = bytes.length;
  writeFileSync(join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest)}\n`);
}
