import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { HookInput, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_AGENT_SDK_HARNESS,
  canonicalizeMetadata,
  claudeAgentSdkNormalizationAdapter,
  captureClaudeAgentSdkRun,
  createAgentSdkNativeEvidenceResolver,
  digestBytes,
  normalizeClaudeAgentSdkRunBundle,
  probeClaudeAgentSdkCapabilities,
  validateUniformEvents,
  type AgentSdkNativeRecord,
  type ClaudeAgentSdkQuery,
  type NormalizationInput,
  type RunBundleDefinition,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "test/fixtures/agent-sdk-normalizer");
const SHA = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;

for (const name of ["complete", "partial", "beta-span-missing"] as const) {
  test(`normalizes the ${name} Agent SDK golden fixture`, async () => {
    const input = readFixture(name);
    const result = await claudeAgentSdkNormalizationAdapter.normalize(input);
    const expectedName = name === "beta-span-missing" ? "complete" : name;
    const expected = readFileSync(join(fixtureRoot, `${expectedName}.expected.jsonl`), "utf8");
    const actual = `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`;

    assert.equal(actual, expected);
    await validateUniformEvents(result.events, createAgentSdkNativeEvidenceResolver(input));
  });
}

test("changes only the capability report when detailed-beta hook spans are missing", async () => {
  const complete = await claudeAgentSdkNormalizationAdapter.normalize(readFixture("complete"));
  const missing = await claudeAgentSdkNormalizationAdapter.normalize(readFixture("beta-span-missing"));

  assert.deepEqual(missing.events, complete.events);
  assert.notDeepEqual(missing.capabilityProfile, complete.capabilityProfile);
  assert.match(missing.capabilityProfile.evidence.nativeTime.detail ?? "", /unavailable/u);
  assert.match(complete.capabilityProfile.evidence.nativeTime.detail ?? "", /configured/u);
});

test("keeps unknown records reachable and joins tool facts only through stable source IDs", async () => {
  const partialInput = readFixture("partial");
  const partial = await claudeAgentSdkNormalizationAdapter.normalize(partialInput);
  const unknown = partialInput.records.find(({ reference }) => reference.recordLocator === "line:2")!;
  assert.equal((unknown.record.document as { message: { private_payload: string } }).message.private_payload,
    "retained only in native evidence");
  assert.deepEqual(partial.unmapped, [{
    reference: unknown.reference,
    reason: "Unrecognized Agent SDK message type remains in the native session artifact",
  }]);

  const input = readFixture("complete");
  const uncorrelated = structuredClone(input.records.find(({ reference }) =>
    reference.artifactId === "hooks" && reference.recordLocator === "line:2")!);
  uncorrelated.reference.recordLocator = "line:10";
  const hook = uncorrelated.record.document as { sequence: number; toolUseId?: string; nativePayload: { tool_use_id?: string } };
  hook.sequence = 10;
  delete hook.toolUseId;
  delete hook.nativePayload.tool_use_id;
  input.records = [...input.records, uncorrelated];
  const result = await claudeAgentSdkNormalizationAdapter.normalize(input);
  const canonicalCall = result.events.find(({ source, family, phase }) =>
    source.nativeReference.artifactId === "session" && family === "tool" && phase === "before")!;
  const correlated = result.events.filter(({ relations }) =>
    relations.known.some(({ eventId }) => eventId === canonicalCall.id));
  const noStableId = result.events.find(({ source }) => source.nativeReference.recordLocator === "line:10")!;

  assert.equal(correlated.length, 3);
  assert.deepEqual(noStableId.relations.known, []);
  assert.equal(JSON.stringify(result.events).includes("/private/workspace"), false);
  assert.equal(JSON.stringify(result.events).includes("private tool output"), false);
});

test("handles optional and required evidence gaps without weakening qualification", async () => {
  const complete = readFixture("complete");
  const withoutTelemetry: NormalizationInput<AgentSdkNativeRecord> = {
    ...complete,
    qualification: "qualified-with-gaps",
    records: complete.records.filter(({ record }) => record.kind !== "telemetry"),
  };
  const optionalGap = await claudeAgentSdkNormalizationAdapter.normalize(withoutTelemetry);
  assert.equal(optionalGap.events.some(({ source }) => source.nativeType === "agent-sdk-telemetry"), false);
  assert.match(optionalGap.capabilityProfile.evidence.nativeTime.detail ?? "", /unavailable/u);

  const withoutSession = {
    ...complete,
    records: complete.records.filter(({ record }) => record.kind !== "session"),
  };
  await assert.rejects(claudeAgentSdkNormalizationAdapter.normalize(withoutSession), /required session evidence/u);
  await assert.rejects(claudeAgentSdkNormalizationAdapter.normalize({
    ...complete,
    qualification: "unqualified" as never,
  }), /capture-qualified/u);
});

test("marks recognized but unprojected native payload content as unknown", async () => {
  const input = readFixture("complete");
  input.records = [...input.records, {
    reference: { artifactId: "session", recordLocator: "line:4" },
    record: {
      kind: "session",
      document: {
        schemaVersion: "ebo.agent-sdk-message/v1",
        sequence: 4,
        nativeType: "stream_event",
        sessionId: "session-golden",
        message: { type: "stream_event", session_id: "session-golden", event: { type: "content_block_delta" } },
      },
    },
  }, {
    reference: { artifactId: "session", recordLocator: "line:5" },
    record: {
      kind: "session",
      document: {
        schemaVersion: "ebo.agent-sdk-message/v1",
        sequence: 5,
        nativeType: "assistant",
        sessionId: "session-golden",
        message: {
          type: "assistant",
          uuid: "m".repeat(513),
          session_id: "session-golden",
          timestamp: "2026-01-01T24:00:00Z",
          message: { role: "assistant", content: [] },
        },
      },
    },
  }, {
    reference: { artifactId: "hooks", recordLocator: "line:10" },
    record: {
      kind: "hook",
      document: {
        schemaVersion: "ebo.claude-agent-hook/v1",
        sequence: 10,
        hook: "PermissionRequest",
        sessionId: "session-golden",
        nativePayload: { hook_event_name: "PermissionRequest", session_id: "session-golden", tool_name: "Write", tool_input: { file_path: "/private/workspace/new.txt" } },
      },
    },
  }];
  const result = await claudeAgentSdkNormalizationAdapter.normalize(input);

  for (const [artifactId, locator] of [["session", "line:4"], ["hooks", "line:10"]] as const) {
    assert.deepEqual(result.events.find(({ source }) =>
      source.nativeReference.artifactId === artifactId && source.nativeReference.recordLocator === locator)?.content, {
      status: "unknown",
      reason: locator === "line:4"
        ? "Native message content remains in the source record"
        : "Hook payload content remains in the source record",
    });
  }
  assert.deepEqual(result.events.find(({ source }) =>
    source.nativeReference.artifactId === "session" && source.nativeReference.recordLocator === "line:5")?.nativeTime, {
    status: "unknown",
    reason: "Agent SDK message has no originating timestamp",
  });
  assert.equal(result.events.find(({ source }) =>
    source.nativeReference.artifactId === "session" && source.nativeReference.recordLocator === "line:5")?.attributes.messageId, undefined);
});

test("correlates task lifecycle hooks by task ID before a shared agent ID", async () => {
  const input = readFixture("complete");
  const taskRecords = ["task-a", "task-b"].flatMap((taskId, taskIndex) =>
    ["TaskCreated", "TaskCompleted"].map((hook, hookIndex) => ({
      reference: { artifactId: "hooks", recordLocator: `line:${10 + taskIndex * 2 + hookIndex}` },
      record: {
        kind: "hook" as const,
        document: {
          schemaVersion: "ebo.claude-agent-hook/v1",
          sequence: 10 + taskIndex * 2 + hookIndex,
          hook,
          sessionId: "session-golden",
          agentId: "shared-agent",
          nativePayload: {
            hook_event_name: hook,
            session_id: "session-golden",
            agent_id: "shared-agent",
            task_id: taskId,
            task_subject: "retained subject",
          },
        },
      },
    })));
  input.records = [...input.records, ...taskRecords];
  const result = await claudeAgentSdkNormalizationAdapter.normalize(input);

  for (const taskId of ["task-a", "task-b"]) {
    const started = result.events.find(({ source, attributes }) =>
      source.nativeType === "TaskCreated" && attributes.taskId === taskId)!;
    const completed = result.events.find(({ source, attributes }) =>
      source.nativeType === "TaskCompleted" && attributes.taskId === taskId)!;
    assert.deepEqual(completed.relations.known, [{ kind: "correlates-with", eventId: started.id }]);
  }
});

test("accepts capture-qualified 256-character run and attempt identities", async () => {
  const input = readFixture("complete");
  input.runId = "r".repeat(256);
  input.attemptId = "a".repeat(256);
  input.records = input.records.map((captured) => ({
    ...captured,
    reference: {
      ...captured.reference,
      artifactId: captured.record.kind === "session" ? "s".repeat(256)
        : captured.record.kind === "hook" ? "h".repeat(256) : captured.reference.artifactId,
    },
  }));
  const result = await claudeAgentSdkNormalizationAdapter.normalize(input);

  await validateUniformEvents(result.events, createAgentSdkNativeEvidenceResolver(input));
  assert.equal(result.events.every(({ runId, attemptId }) => runId.length === 256 && attemptId.length === 256), true);
  const orderDomains = result.events.flatMap(({ nativeOrder }) => nativeOrder.status === "known" ? [nativeOrder.domain] : []);
  assert.equal(orderDomains.every((domain) => domain.length <= 256), true);
  assert.equal(orderDomains.some((domain) => domain.startsWith("session:sha256:")), true);
  assert.equal(orderDomains.some((domain) => domain.startsWith("hooks:sha256:")), true);
});

test("produces stable event identities and ordering on repeated normalization", async () => {
  const input = readFixture("complete");
  const first = await claudeAgentSdkNormalizationAdapter.normalize(input);
  const second = await claudeAgentSdkNormalizationAdapter.normalize(structuredClone(input));

  assert.deepEqual(second, first);
  assert.equal(new Set(first.events.map(({ id }) => id)).size, first.events.length);
  assert.deepEqual(first.events.filter(({ nativeOrder }) => nativeOrder.status === "known")
    .map(({ nativeOrder }) => nativeOrder.status === "known" ? nativeOrder.domain : ""), [
    "session:session", "session:session", "session:session", "session:session", "session:session",
    "hooks:hooks", "hooks:hooks", "hooks:hooks", "hooks:hooks", "hooks:hooks",
    "hooks:hooks", "hooks:hooks", "hooks:hooks", "hooks:hooks",
  ]);
});

test("loads a retained bundle only after structural qualification and validates every reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-normalizer-"));
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "result.txt"), "before\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  writeFileSync(join(final, "result.txt"), "after\n");
  const capabilities = probeClaudeAgentSdkCapabilities();
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-normalizer-integration",
    run: {
      id: "run-normalizer-integration",
      assessmentMode: "observational",
      task: { id: "task-normalizer-integration" },
      fixture: { id: "fixture-normalizer-integration", digest: SHA("a") },
      model: { provider: "anthropic", id: "claude-test" },
      harness: { id: "agent-sdk", version: capabilities.sdkVersion },
      runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }],
    },
    attempt: { id: "attempt-normalizer-integration", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };
  const query: ClaudeAgentSdkQuery = (input) => ({
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({
        hook_event_name: "SessionStart",
        session_id: "session-normalizer-integration",
        transcript_path: "/restricted/session.jsonl",
        cwd: final,
        source: "startup",
      } as HookInput, undefined, { signal: new AbortController().signal });
      yield assistantMessage();
      yield sdkResult();
    },
  });

  try {
    const captured = await captureClaudeAgentSdkRun({
      definition,
      startingWorkspacePath: start,
      workspace: {
        setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }),
      },
      configuration: { prompt: "Inspect result.txt.", model: "claude-test", tools: ["Read"], permissionMode: "dontAsk" },
      expectedHooks: ["SessionStart"],
      query,
    });
    assert.ok(captured.qualification.semanticAnalysisUsable);

    const manifestPath = join(bundleRoot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      evidence: Array<{ kind: string; relativePath: string; digest: `sha256:${string}`; sizeBytes: number }>;
    };
    const sessionDescriptor = manifest.evidence.find(({ kind }) => kind === "session")!;
    const sessionPath = join(bundleRoot, sessionDescriptor.relativePath);
    const sessionBytes = Buffer.concat([Buffer.from("\n"), readFileSync(sessionPath)]);
    writeFileSync(sessionPath, sessionBytes);
    sessionDescriptor.digest = `sha256:${digestBytes(sessionBytes).value}`;
    sessionDescriptor.sizeBytes = sessionBytes.length;
    writeFileSync(manifestPath, canonicalizeMetadata(manifest));

    const normalized = await normalizeClaudeAgentSdkRunBundle(bundleRoot);
    assert.equal(normalized.events.every(({ source }) => source.harness === CLAUDE_AGENT_SDK_HARNESS), true);
    assert.equal(normalized.events.some(({ family }) => family === "outcome"), true);
    assert.deepEqual(normalized.events.filter(({ source }) => source.nativeReference.artifactId === "session")
      .map(({ source }) => source.nativeReference.recordLocator), ["line:2", "line:3"]);

    const reportDescriptor = manifest.evidence.find(({ kind }) => kind === "capture-report")!;
    const reportPath = join(bundleRoot, reportDescriptor.relativePath);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      structuralQualification: { status: string; semanticAnalysisUsable: boolean };
    };
    report.structuralQualification.status = "unqualified";
    report.structuralQualification.semanticAnalysisUsable = false;
    const reportBytes = Buffer.from(canonicalizeMetadata(report));
    writeFileSync(reportPath, reportBytes);
    reportDescriptor.digest = `sha256:${digestBytes(reportBytes).value}`;
    reportDescriptor.sizeBytes = reportBytes.length;
    writeFileSync(manifestPath, canonicalizeMetadata(manifest));

    await assert.rejects(normalizeClaudeAgentSdkRunBundle(bundleRoot), /persisted unqualified structural/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readFixture(name: "complete" | "partial" | "beta-span-missing"): NormalizationInput<AgentSdkNativeRecord> {
  if (name !== "beta-span-missing") {
    return JSON.parse(readFileSync(join(fixtureRoot, `${name}.input.json`), "utf8")) as NormalizationInput<AgentSdkNativeRecord>;
  }
  const input = readFixture("complete");
  const recipe = JSON.parse(readFileSync(join(fixtureRoot, `${name}.input.json`), "utf8")) as {
    replace: { artifactId: string; value: unknown };
  };
  const telemetry = input.records.find(({ reference }) => reference.artifactId === recipe.replace.artifactId)!.record.document as {
    telemetry: { hookSpans: unknown };
  };
  telemetry.telemetry.hookSpans = recipe.replace.value;
  return input;
}

function assistantMessage(): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-normalizer-integration",
    session_id: "session-normalizer-integration",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [] },
  } as unknown as SDKMessage;
}

function sdkResult(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-test": { inputTokens: 1, outputTokens: 1, costUSD: 0.01 } },
    permission_denials: [],
    result: "done",
    session_id: "session-normalizer-integration",
    uuid: "result-normalizer-integration",
  } as unknown as SDKResultMessage;
}
