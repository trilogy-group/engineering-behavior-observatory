import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assessComparisonEligibility,
  claudeAgentSdkNormalizationAdapter,
  createAgentSdkNativeEvidenceResolver,
  createCapturedNativeEvidenceResolver,
  DEEPSEEK_CAPABILITY_PROFILE,
  DEEPSEEK_SDK_VERSION,
  describeNormalizedDataset,
  normalizeDeepSeekCapture,
  normalizeOpenHandsCapture,
  OPENHANDS_AGENT_SERVER_CAPABILITIES,
  OPENHANDS_AGENT_SERVER_VERSION,
  validateNormalizedCorpus,
  validateNormalizedDataset,
  type AgentSdkNativeRecord,
  type ComparisonRequest,
  type DeepSeekNativeObservation,
  type NormalizationInput,
  type OpenHandsNativeRecord,
} from "../src/index.js";
import { main } from "../src/cli.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "test/fixtures");

test("validates Agent SDK golden data and rejects unresolved, wrong-run, and digest-mismatched references", async () => {
  const capture = agentSdkFixture("complete");
  const normalization = await claudeAgentSdkNormalizationAdapter.normalize(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: normalization.capabilityProfile,
    adapterVersion: "0.3.258",
    nativeType: agentSdkNativeType,
  });
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver(capture));

  const coverage = await validateNormalizedDataset(dataset, resolver);
  assert.equal(coverage.records.total, capture.records.length);
  assert.equal(coverage.records.total, coverage.records.mapped + coverage.records.unmapped);

  const target = dataset.nativeRecords[0]!;
  await assert.rejects(validateNormalizedDataset(dataset, {
    resolve: (reference) => sameReference(reference, target.reference) ? false : resolver.resolve(reference),
  }), /unresolved/u);
  await assert.rejects(validateNormalizedDataset(dataset, {
    async resolve(reference) {
      const resolved = await resolver.resolve(reference);
      return sameReference(reference, target.reference) && typeof resolved === "object"
        ? { ...resolved, runId: "wrong-run" }
        : resolved;
    },
  }), /wrong run or attempt/u);
  const mismatched = structuredClone(dataset);
  mismatched.nativeRecords[0]!.digest = SHA("0");
  await assert.rejects(validateNormalizedDataset(mismatched, resolver), /digest mismatch/u);

  const reversed = structuredClone(dataset);
  const events = [...reversed.events];
  const ordered = events.filter(({ nativeOrder }) => nativeOrder.status === "known"
    && nativeOrder.domain.startsWith("session:"));
  const first = events.indexOf(ordered[0]!);
  const last = events.indexOf(ordered.at(-1)!);
  [events[first], events[last]] = [events[last]!, events[first]!];
  reversed.events = events;
  await assert.rejects(validateNormalizedDataset(reversed, resolver), /source-local order/u);
});

test("keeps unknown Agent SDK records reachable and distinguishes unsupported capabilities from observed zero", async () => {
  const capture = agentSdkFixture("partial");
  const normalization = await claudeAgentSdkNormalizationAdapter.normalize(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: normalization.capabilityProfile,
    adapterVersion: "0.3.258",
    nativeType: agentSdkNativeType,
  });
  const coverage = await validateNormalizedDataset(
    dataset,
    createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver(capture)),
  );
  const unknown = coverage.nativeTypes.find(({ nativeType }) => nativeType === "future_message");

  assert.deepEqual(unknown, { nativeType: "future_message", total: 1, mapped: 0, unmapped: 1 });
  assert.equal(dataset.unmapped.some(({ reference }) => reference.recordLocator === "line:2"), true);
  assert.equal(coverage.families["model-request"].observedEvents, 0);
  assert.equal(coverage.families["model-request"].capability.status, "available");
});

test("applies the same normalization and native-reference gate to Agent SDK, OpenHands, and DeepSeek", async () => {
  const agentCapture = agentSdkFixture("partial");
  const agentNormalization = await claudeAgentSdkNormalizationAdapter.normalize(agentCapture);
  const openHandsCapture = openHandsFixture();
  const openHandsNormalization = await normalizeOpenHandsCapture(openHandsCapture);
  const deepSeekCapture = deepSeekFixture();
  const deepSeekNormalization = normalizeDeepSeekCapture(deepSeekCapture);

  const reports = await validateNormalizedCorpus([
    {
      dataset: describeNormalizedDataset({
        capture: agentCapture,
        normalization: agentNormalization,
        capabilityProfile: agentNormalization.capabilityProfile,
        adapterVersion: "0.3.258",
        nativeType: agentSdkNativeType,
      }),
      resolver: createCapturedNativeEvidenceResolver(agentCapture, createAgentSdkNativeEvidenceResolver(agentCapture)),
    },
    {
      dataset: describeNormalizedDataset({
        capture: openHandsCapture,
        normalization: openHandsNormalization,
        capabilityProfile: OPENHANDS_AGENT_SERVER_CAPABILITIES,
        adapterVersion: OPENHANDS_AGENT_SERVER_VERSION,
        nativeType: ({ payload, channel }) => typeof payload.kind === "string" ? payload.kind : channel,
      }),
      resolver: createCapturedNativeEvidenceResolver(openHandsCapture),
    },
    {
      dataset: describeNormalizedDataset({
        capture: deepSeekCapture,
        normalization: deepSeekNormalization,
        capabilityProfile: DEEPSEEK_CAPABILITY_PROFILE,
        adapterVersion: DEEPSEEK_SDK_VERSION,
        nativeType: ({ method, kind }) => method ?? kind,
      }),
      resolver: createCapturedNativeEvidenceResolver(deepSeekCapture),
    },
  ]);

  assert.deepEqual(reports.map(({ adapter }) => adapter.harness), [
    "claude-agent-sdk",
    "openhands-agent-server",
    "deepseek-harness",
  ]);
  assert.ok(reports[1]!.nativeTypes.some(({ nativeType }) => nativeType === "server-info"));
  assert.ok(reports[2]!.nativeTypes.some(({ nativeType }) => nativeType === "session/prompt"));
  assert.equal(reports[1]!.families["model-request"].capability.status, "unsupported");
  assert.equal(reports[1]!.families["model-request"].observedEvents, 0);
  assert.equal(reports[2]!.families.permission.capability.status, "unsupported");
  assert.equal(reports[2]!.families.permission.observedEvents, 0);
});

test("reports exact, declared harness, fixture mismatch, material mismatch, and missing capability comparisons", () => {
  const exact = comparisonFixture();
  assert.equal(assessComparisonEligibility(exact).status, "supported");

  const harnessDifference = structuredClone(exact);
  harnessDifference.right.harness = {
    id: "harness-b",
    version: "2.0.0",
    configurationDigest: SHA("2"),
  };
  harnessDifference.right.capabilityProfile.adapterId = "adapter-b";
  harnessDifference.right.capabilityProfile.harness = "harness-b";
  harnessDifference.policy.declaredDifferences = ["harness"];
  const qualified = assessComparisonEligibility(harnessDifference);
  assert.equal(qualified.status, "qualified-with-caveats");
  assert.deepEqual(qualified.reasons.map(({ code }) => code), ["declared-harness-difference"]);
  assert.match(qualified.reasons[0]!.detail, /do not establish causality/u);

  const fixtureMismatch = comparisonFixture("fixture-mismatch");
  const incompatible = assessComparisonEligibility(fixtureMismatch);
  assert.equal(incompatible.status, "unsupported");
  assert.equal(incompatible.reasons[0]?.code, "fixture-mismatch");

  const materialMismatch = structuredClone(exact);
  materialMismatch.right.toolPolicyDigest = SHA("3");
  assert.deepEqual(assessComparisonEligibility(materialMismatch).reasons.map(({ code }) => code), [
    "material-configuration-mismatch",
  ]);

  const missingCapability = structuredClone(exact);
  missingCapability.right.capabilityProfile.families.tool = { status: "unsupported", detail: "not exposed" };
  const unsupported = assessComparisonEligibility(missingCapability);
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.reasons.some(({ code }) => code === "capability-unsupported"), true);
});

test("comparison CLI emits the inspectable report and blocks incompatible requests", () => {
  const path = join(fixtureRoot, "comparison/exact.json");
  let output = "";
  assert.equal(main(["comparison", "check", path], (message) => (output += message)), 0);
  assert.equal((JSON.parse(output) as { status: string }).status, "supported");
  output = "";
  const incompatiblePath = join(fixtureRoot, "comparison/fixture-mismatch.json");
  assert.equal(main(["comparison", "check", incompatiblePath], (message) => (output += message)), 1);
  assert.equal((JSON.parse(output) as { status: string }).status, "unsupported");
});

function agentSdkFixture(name: "complete" | "partial"): NormalizationInput<AgentSdkNativeRecord> {
  return JSON.parse(readFileSync(join(fixtureRoot, `agent-sdk-normalizer/${name}.input.json`), "utf8")) as NormalizationInput<AgentSdkNativeRecord>;
}

function agentSdkNativeType(record: AgentSdkNativeRecord): string {
  const document = record.document as { nativeType?: unknown; hook?: unknown } | null;
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

function openHandsFixture(): NormalizationInput<OpenHandsNativeRecord> {
  return {
    runId: "run-openhands",
    attemptId: "attempt-openhands",
    qualification: "qualified-with-gaps",
    records: [
      openHandsRecord(1, "server-info", { version: OPENHANDS_AGENT_SERVER_VERSION }),
      openHandsRecord(2, "rest-event", {
        id: "message-1",
        kind: "MessageEvent",
        source: "user",
        timestamp: "2026-09-03T00:00:00Z",
        llm_message: { role: "user", content: [] },
      }),
      openHandsRecord(3, "conversation-final", { execution_status: "finished" }),
    ],
  };
}

function openHandsRecord(
  sequence: number,
  channel: OpenHandsNativeRecord["channel"],
  payload: Record<string, unknown>,
): { reference: { artifactId: string; recordLocator: string }; record: OpenHandsNativeRecord } {
  return {
    reference: { artifactId: "session", recordLocator: `line:${sequence}` },
    record: {
      schemaVersion: "ebo.openhands-native-record/v1",
      session_id: "conversation-1",
      channel,
      sequence,
      payload,
    },
  };
}

function deepSeekFixture(): NormalizationInput<DeepSeekNativeObservation> {
  const records: DeepSeekNativeObservation[] = [
    deepSeekRecord(1, "composition"),
    deepSeekRecord(2, "capability"),
    deepSeekRecord(3, "response", "initialize"),
    deepSeekRecord(4, "response", "session/prompt"),
    deepSeekRecord(5, "notification", "session.event", {
      sessionId: "session-1",
      event: { type: "tool/call", seq: 1, timestamp: "2026-09-03T00:00:00Z" },
    }),
    deepSeekRecord(6, "diagnostic"),
  ];
  return {
    runId: "run-deepseek",
    attemptId: "attempt-deepseek",
    qualification: "qualified",
    records: records.map((record) => ({
      reference: { artifactId: "deepseek-session", recordLocator: `line:${record.sequence}` },
      record,
    })),
  };
}

function deepSeekRecord(
  sequence: number,
  kind: DeepSeekNativeObservation["kind"],
  method?: string,
  payload?: unknown,
): DeepSeekNativeObservation {
  return {
    schemaVersion: "ebo.deepseek-native-observation/v1",
    sequence,
    observedAt: `2026-09-03T00:00:0${sequence}Z`,
    kind,
    ...(method === undefined ? {} : { method }),
    ...(payload === undefined ? {} : { payload }),
  };
}

function comparisonFixture(name: "exact" | "fixture-mismatch" = "exact"): ComparisonRequest {
  return JSON.parse(readFileSync(join(fixtureRoot, `comparison/${name}.json`), "utf8")) as ComparisonRequest;
}

function sameReference(
  left: { artifactId: string; recordLocator: string },
  right: { artifactId: string; recordLocator: string },
): boolean {
  return left.artifactId === right.artifactId && left.recordLocator === right.recordLocator;
}

function SHA(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}
