import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { HookInput, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION,
  claudeAgentSdkNormalizationAdapter,
  captureClaudeAgentSdkRun,
  createAgentSdkNativeEvidenceResolver,
  describeNormalizedDataset,
  digestMetadata,
  isConfirmedBehaviorAssertion,
  probeClaudeAgentSdkCapabilities,
  readQualifiedClaudeAgentSdkCapture,
  validateBehaviorAssertion,
  validateBehaviorReview,
  type AgentSdkNativeRecord,
  type BehaviorAssertion,
  type BehaviorReview,
  type ClaudeAgentSdkQuery,
  type NativeEvidenceReference,
  type NativeEvidenceResolver,
  type NormalizationInput,
  type NormalizedDataset,
  type RunBundleDefinition,
} from "../src/index.js";
import { main } from "../src/cli.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "test/fixtures/behavior-assertions");

test("validates positive, disputed, abstained, and invalid-reference fixtures", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const positive = fixture<BehaviorAssertion>("positive.json");
  const disputed = fixture<BehaviorReview>("disputed.review.json");
  const abstained = fixture<BehaviorAssertion>("abstained.json");

  assert.equal((await validateBehaviorAssertion(positive, dataset, resolver(dataset))).length, 1);
  validateBehaviorReview(positive, disputed);
  assert.equal(await isConfirmedBehaviorAssertion(positive, dataset, resolver(dataset), disputed), false);
  assert.equal(await isConfirmedBehaviorAssertion(positive, dataset, resolver(dataset)), false);

  const confirmed = structuredClone(disputed);
  confirmed.state = "confirmed";
  assert.equal(await isConfirmedBehaviorAssertion(positive, dataset, resolver(dataset), confirmed), true);

  assert.deepEqual(await validateBehaviorAssertion(abstained, dataset, resolver(dataset)), []);
  assert.equal(await isConfirmedBehaviorAssertion(
    abstained,
    dataset,
    resolver(dataset),
    { ...confirmed, assertion: binding(abstained) },
  ), false);

  await assert.rejects(
    validateBehaviorAssertion(fixture("invalid-reference.json"), dataset, resolver(dataset)),
    /unknown normalized event/u,
  );
});

test("rejects wrong-run, changed-digest, stale, dangling, and conflicting assertion identities", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const assertion = fixture<BehaviorAssertion>("positive.json");
  const disputed = fixture<BehaviorReview>("disputed.review.json");

  const wrongRun = structuredClone(assertion);
  wrongRun.attemptId = "another-attempt";
  await assert.rejects(validateBehaviorAssertion(wrongRun, dataset, resolver(dataset)), /wrong run or attempt/u);

  const changedDigest = structuredClone(assertion);
  changedDigest.dataset.digest = sha("0");
  await assert.rejects(validateBehaviorAssertion(changedDigest, dataset, resolver(dataset)), /dataset version or digest/u);

  await assert.rejects(validateBehaviorAssertion(assertion, dataset, {
    resolve: () => ({ runId: dataset.runId, attemptId: dataset.attemptId, digest: sha("0") }),
  }), /digest mismatch/u);

  const dangling = structuredClone(dataset);
  dangling.nativeRecords = [];
  await assert.rejects(validateBehaviorAssertion({
    ...assertion,
    dataset: { ...assertion.dataset, digest: digest(dangling) },
  }, dangling, resolver(dataset)), /captured native record/u);

  const wrongNative = structuredClone(assertion);
  wrongNative.judgment.citations[0]!.nativeReference.recordLocator = "line:2";
  await assert.rejects(validateBehaviorAssertion(wrongNative, dataset, resolver(dataset)), /does not match its native source/u);

  assert.throws(() => validateBehaviorReview(assertion, {
    ...disputed,
    assertion: { ...disputed.assertion, id: "another-assertion" },
  }), /identity or digest does not match/u);
});

test("rejects undeclared dimensions and keeps proposed review separate from human confirmation", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const assertion = fixture<BehaviorAssertion>("positive.json");
  const undeclared = structuredClone(assertion);
  undeclared.behavior.dimensionId = "invented-dimension";

  await assert.rejects(validateBehaviorAssertion(undeclared, dataset, resolver(dataset)), /declared behavior dimension/u);
  await assert.rejects(isConfirmedBehaviorAssertion(undeclared, dataset, resolver(dataset), {
    schemaVersion: "ebo.behavior-review/v1",
    id: "invalid-confirmation",
    assertion: binding(undeclared),
    state: "confirmed",
    reviewer: { kind: "human", id: "synthetic-fixture-reviewer" },
    rationale: "Synthetic fixture must not confirm an invalid assertion.",
  }), /declared behavior dimension/u);
  assert.throws(() => validateBehaviorReview(assertion, {
    schemaVersion: "ebo.behavior-review/v1",
    id: "invalid-proposal",
    assertion: binding(assertion),
    state: "proposed",
    reviewer: { kind: "human", id: "must-not-appear" },
  }), /must NOT be valid/u);
});

test("Agent SDK assertion CLI validates through retained native evidence", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "ebo-behavior-cli-"));
  const bundleRoot = await qualifiedBundle(temporary);
  const capture = await readQualifiedClaudeAgentSdkCapture(bundleRoot);
  const normalization = await claudeAgentSdkNormalizationAdapter.normalize(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: normalization.capabilityProfile,
    adapterVersion: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION,
    nativeType: agentSdkNativeType,
    contentDigest: (reference) => agentSdkContentDigest(capture, reference),
  });
  const event = dataset.events[0]!;
  const assertion: BehaviorAssertion = {
    ...fixture("positive.json"),
    id: "assertion-cli",
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    dataset: { schemaVersion: dataset.schemaVersion, digest: digest(dataset) },
    judgment: {
      ...fixture<BehaviorAssertion>("positive.json").judgment,
      citations: [{ eventId: event.id, nativeReference: event.source.nativeReference }],
    },
  };
  const path = join(temporary, "assertion.json");
  writeFileSync(path, JSON.stringify(assertion));
  let output = "";

  try {
    assert.equal(await main(["assertions", "validate", bundleRoot, path], (message) => (output += message)), 0);
    assert.match(output, /Validated behavior assertion "assertion-cli" \(1 citation\(s\); review=unreviewed\)/u);
    assert.equal(typeof await createAgentSdkNativeEvidenceResolver(capture).resolve(event.source.nativeReference), "object");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function fixture<Value>(name: string): Value {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as Value;
}

async function qualifiedBundle(root: string): Promise<string> {
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
    bundleId: "bundle-behavior-cli",
    run: {
      id: "run-behavior-cli",
      assessmentMode: "observational",
      task: { id: "task-behavior-cli" },
      fixture: { id: "fixture-behavior-cli", digest: sha("a") },
      model: { provider: "anthropic", id: "claude-test" },
      harness: { id: "agent-sdk", version: capabilities.sdkVersion },
      runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }],
    },
    attempt: { id: "attempt-behavior-cli", number: 1 },
    configuration: { digest: sha("b"), budgetDigest: sha("c"), toolPolicyDigest: sha("d") },
  };
  const query: ClaudeAgentSdkQuery = (input) => ({
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({
        hook_event_name: "SessionStart",
        session_id: "session-behavior-cli",
        transcript_path: "/restricted/session.jsonl",
        cwd: final,
        source: "startup",
      } as HookInput, undefined, { signal: new AbortController().signal });
      yield {
        type: "assistant",
        uuid: "assistant-behavior-cli",
        session_id: "session-behavior-cli",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [] },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 12,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 2 },
        modelUsage: { "claude-test": { inputTokens: 3, outputTokens: 2, costUSD: 0.01 } },
        permission_denials: [],
        result: "done",
        session_id: "session-behavior-cli",
        uuid: "result-behavior-cli",
      } as unknown as SDKResultMessage;
    },
  });
  const captured = await captureClaudeAgentSdkRun({
    definition,
    startingWorkspacePath: start,
    workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
    configuration: { prompt: "Inspect result.txt.", model: "claude-test", tools: ["Read"], permissionMode: "dontAsk" },
    expectedHooks: ["SessionStart"],
    query,
  });
  assert.equal(captured.qualification.semanticAnalysisUsable, true);
  return bundleRoot;
}

function resolver(dataset: NormalizedDataset): NativeEvidenceResolver {
  return {
    resolve(reference) {
      const record = dataset.nativeRecords.find(({ reference: candidate }) =>
        candidate.artifactId === reference.artifactId && candidate.recordLocator === reference.recordLocator);
      return record === undefined ? false : {
        runId: dataset.runId,
        attemptId: dataset.attemptId,
        digest: record.digest,
      };
    },
  };
}

function binding(assertion: BehaviorAssertion): BehaviorReview["assertion"] {
  return { id: assertion.id, schemaVersion: assertion.schemaVersion, digest: digest(assertion) };
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${digestMetadata(value).value}`;
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}

function agentSdkNativeType(record: AgentSdkNativeRecord): string {
  const document = typeof record.document === "object" && record.document !== null
    ? record.document as Record<string, unknown> : undefined;
  if (record.kind === "session" && typeof document?.nativeType === "string") return document.nativeType;
  if (record.kind === "hook" && typeof document?.hook === "string") return document.hook;
  return ({
    telemetry: "agent-sdk-telemetry",
    workspace: "workspace-outcome",
    verifier: "verifier-result",
    "assessment-mode": "assessment-mode",
    manifest: "terminal-record",
  } as Partial<Record<AgentSdkNativeRecord["kind"], string>>)[record.kind] ?? record.kind;
}

function agentSdkContentDigest(
  capture: NormalizationInput<AgentSdkNativeRecord>,
  reference: NativeEvidenceReference,
): `sha256:${string}` | undefined {
  for (const { record } of capture.records) {
    if (record.kind !== "workspace" && record.kind !== "diagnostic") continue;
    const descriptor = record.document as { id?: unknown; digest?: unknown } | null;
    if (descriptor?.id === reference.artifactId && typeof descriptor.digest === "string"
        && /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)) return descriptor.digest as `sha256:${string}`;
  }
  return undefined;
}
