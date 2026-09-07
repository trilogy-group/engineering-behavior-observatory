import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import type { HookInput, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION,
  captureClaudeAgentSdkRun,
  claudeAgentSdkNormalizationAdapter,
  describeNormalizedDataset,
  digestMetadata,
  importReviewDecision,
  probeClaudeAgentSdkCapabilities,
  readQualifiedClaudeAgentSdkCapture,
  selectReviewSample,
  summarizeCalibration,
  assertCalibrationDestination,
  type AgentSdkNativeRecord,
  type BehaviorAssertion,
  type ClaudeAgentSdkQuery,
  type NativeEvidenceReference,
  type NormalizationInput,
  type ReviewDecision,
  type ReviewHistory,
  type ReviewSample,
  type ReviewSampleCriteria,
  type ReviewSourceSet,
  type RunBundleDefinition,
} from "../src/index.js";
import { main } from "../src/cli.js";

test("reproducibly samples, renders safe native drilldown, imports lineage, and reports explicit populations", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "ebo-human-calibration-"));
  try {
    const bundleRoot = await qualifiedBundle(temporary);
    const assertions = await writeAssertions(temporary, bundleRoot);
    const sources: ReviewSourceSet = {
      schemaVersion: "ebo.review-source-set/v1",
      sources: assertions.map((assertion) => ({
        bundleRoot,
        assertionPath: join(temporary, `${assertion.id}.json`),
        taskContext: "Inspect <img src=x onerror=alert(1)> result.txt and report the retained change.",
      })),
    };
    const criteria: ReviewSampleCriteria = {
      schemaVersion: "ebo.review-sample-criteria/v1",
      seed: "fixture-seed",
      strata: [
        { id: "verification", sampleSize: 3, filters: { categoryIds: ["verification-completion"] } },
        { id: "abstentions", sampleSize: 1, filters: { abstentions: [true] } },
        { id: "unavailable", sampleSize: 1, filters: { taskIds: ["not-present"] } },
      ],
    };
    const first = await selectReviewSample(sources, criteria, () => "2026-09-07T12:00:00Z");
    const second = await selectReviewSample(sources, criteria, () => "2026-09-07T12:01:00Z");
    assert.deepEqual(first.population.selectedAssertionIds, second.population.selectedAssertionIds);
    assert.deepEqual(first.population.unavailableStrata, ["unavailable"]);
    assert.equal(first.candidates.every(({ context }) => context.outcome === "unavailable"), true, "observational runs have no verifier outcome");
    const duplicateId = { ...structuredClone(assertions[1]!), id: assertions[0]!.id };
    duplicateId.judgment = { ...duplicateId.judgment, rationale: "A second run may reuse the request-derived assertion ID." };
    const duplicatePath = join(temporary, "duplicate-id.json");
    writeJson(duplicatePath, duplicateId);
    const repeated = await selectReviewSample({
      schemaVersion: "ebo.review-source-set/v1",
      sources: [
        sources.sources[0]!,
        { ...sources.sources[1]!, assertionPath: duplicatePath },
      ],
    }, { schemaVersion: "ebo.review-sample-criteria/v1", seed: "repeat", strata: [{ id: "all", sampleSize: 2, filters: {} }] });
    assert.deepEqual(repeated.population.selectedAssertionIds, ["assertion-a", "assertion-a"]);

    const sourcePath = join(temporary, "sources.json");
    const criteriaPath = join(temporary, "criteria.json");
    const selectionPath = join(temporary, "selection.json");
    writeJson(sourcePath, sources);
    writeJson(criteriaPath, criteria);
    let output = "";
    assert.equal(await main(["calibration", "sample", sourcePath, criteriaPath, selectionPath], (message) => { output += message; }), 0);
    assert.match(output, /Selected 4 of 4 eligible/u);
    const selection = readJson<ReviewSample>(selectionPath);

    const packetRoot = join(temporary, "packet");
    output = "";
    assert.equal(await main(["calibration", "packet", selectionPath, packetRoot], (message) => { output += message; }), 0);
    assert.throws(() => assertCalibrationDestination(selection.candidates.map(({ source }) => source.bundleRoot), join(bundleRoot, "derived.json")), /outside immutable/u);
    const sourceAlias = join(temporary, "source-alias");
    symlinkSync(bundleRoot, sourceAlias, "dir");
    assert.throws(() => assertCalibrationDestination(selection.candidates.map(({ source }) => source.bundleRoot), join(sourceAlias, "derived.json")), /outside immutable/u);
    const html = readFileSync(join(packetRoot, "index.html"), "utf8");
    assert.match(html, /&#60;&#115;&#99;&#114;&#105;&#112;&#116;&#62;/u);
    assert.doesNotMatch(html, /<script>fixture<\/script>/u);
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/u);
    assert.equal(existsSync(join(packetRoot, "session.jsonl")), false, "the source artifact is not copied wholesale");
    assert.equal(relative(packetRoot, bundleRoot).startsWith(".."), true, "packet links remain relative to the declared local evidence root");
    output = "";
    const citedEventId = assertions[0]!.judgment.citations[0]!.eventId;
    assert.equal(await main(["calibration", "inspect", join(packetRoot, "packet.json"), "assertion-a", citedEventId], (message) => { output += message; }), 0);
    assert.match(output, /"nativeHref":"\.\.\/bundle\/session\.jsonl"/u);
    const evidenceHref = (JSON.parse(output) as { href: string }).href;
    assert.equal(readJson<{ evidenceBoundary: { copiedNativeEvidence: boolean } }>(join(packetRoot, "packet.json")).evidenceBoundary.copiedNativeEvidence, true);
    const evidenceHtml = readFileSync(join(packetRoot, evidenceHref), "utf8");
    assert.match(evidenceHtml, /the native artifact/u);
    assert.match(evidenceHtml, /<code>.+<\/code>/u);
    assert.doesNotMatch(evidenceHtml, /<script>|<img/u);
    assert.match(evidenceHtml, /&#/u);
    output = "";
    assert.equal(await main(["calibration", "binding", selectionPath, "assertion-a"], (message) => { output += message; }), 0);
    assert.match(output, /"previousHistory":null/u);

    const byId = new Map(selection.candidates.map((candidate) => [candidate.assertion.id, candidate.assertion]));
    const historyPath = join(temporary, "history.json");
    let history: ReviewHistory | undefined;
    const append = async (decision: Omit<ReviewDecision, "previousHistory">): Promise<ReviewDecision> => {
      const record: ReviewDecision = {
        ...decision,
        previousHistory: history === undefined ? null : { schemaVersion: history.schemaVersion, digest: digest(history) },
      };
      const result = await importReviewDecision(selection, historyPath, record);
      assert.equal(result.appended, true);
      history = result.history;
      return record;
    };
    const confirmed = await append(decision("review-confirmed", "review", byId.get("assertion-a")!, "synthetic-fixture-reviewer-a", "confirmed"));
    const rejected = await append(decision("review-rejected", "review", byId.get("assertion-a")!, "synthetic-fixture-reviewer-b", "rejected"));
    await append(decision("review-disputed", "review", byId.get("assertion-b")!, "synthetic-fixture-reviewer-c", "disputed"));
    await append(decision("review-abstained", "review", byId.get("assertion-c")!, "synthetic-fixture-reviewer-d", "insufficient-evidence"));
    await append(decision("review-confirmed-after-abstention", "review", byId.get("assertion-c")!, "synthetic-fixture-reviewer-d", "confirmed"));
    await append({
      ...decision("adjudication-a", "adjudication", byId.get("assertion-a")!, "synthetic-fixture-adjudicator", "confirmed"),
      adjudicates: [confirmed.id, rejected.id],
    });
    await append(decision("review-after-adjudication", "review", byId.get("assertion-a")!, "synthetic-fixture-reviewer-e", "disputed"));

    const duplicate = await importReviewDecision(selection, historyPath, confirmed);
    assert.equal(duplicate.appended, false);
    await assert.rejects(importReviewDecision(selection, historyPath, { ...confirmed, rationale: "conflicting fixture" }), /conflicts/u);
    await assert.rejects(importReviewDecision(selection, historyPath, {
      ...decision("unknown", "review", { ...confirmed.assertion, id: "unknown" }, "synthetic-fixture-reviewer", "confirmed"),
      previousHistory: { schemaVersion: history!.schemaVersion, digest: digest(history!) },
    }), /unknown assertion/u);
    await assert.rejects(importReviewDecision(selection, historyPath, {
      ...decision("stale", "review", { ...confirmed.assertion, digest: sha("0") }, "synthetic-fixture-reviewer", "confirmed"),
      previousHistory: { schemaVersion: history!.schemaVersion, digest: digest(history!) },
    }), /stale/u);

    const summary = summarizeCalibration(selection, history!);
    assert.deepEqual(summary.totals.judgeHumanAgreement, {
      status: "available",
      denominator: 5,
      population: "judge-human decision pairs on non-abstaining assertions",
      agreements: 2,
      disagreements: 3,
      rate: 0.4,
    });
    assert.deepEqual(summary.totals.humanHumanAgreement, {
      status: "available",
      denominator: 3,
      population: "distinct-human reviewer pairs on the same assertion with comparable decisions",
      agreements: 0,
      disagreements: 3,
      rate: 0,
    });
    assert.equal(summary.totals.confirmedEligibleAssertions, 1);
    assert.equal(summary.totals.disputedAssertions, 2);
    assert.equal(summary.totals.unresolvedAssertions, 3);
    assert.equal(summary.totals.humanDecisionAbstentions, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("reports agreement as unavailable when no human reviews exist", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "ebo-human-calibration-empty-"));
  try {
    const bundleRoot = await qualifiedBundle(temporary);
    const [assertion] = await writeAssertions(temporary, bundleRoot);
    const selection = await selectReviewSample({
      schemaVersion: "ebo.review-source-set/v1",
      sources: [{ bundleRoot, assertionPath: join(temporary, `${assertion!.id}.json`), taskContext: "Synthetic fixture task context." }],
    }, {
      schemaVersion: "ebo.review-sample-criteria/v1",
      seed: "empty-fixture",
      strata: [{ id: "all", sampleSize: 1, filters: {} }],
    });
    const history: ReviewHistory = {
      schemaVersion: "ebo.review-history/v1",
      selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) },
      decisions: [],
    };
    const summary = summarizeCalibration(selection, history);
    assert.equal(summary.totals.judgeHumanAgreement.status, "unavailable");
    assert.equal(summary.totals.judgeHumanAgreement.denominator, 0);
    assert.equal(summary.totals.humanHumanAgreement.status, "unavailable");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function decision(
  id: string,
  kind: ReviewDecision["kind"],
  assertion: ReviewDecision["assertion"],
  reviewer: string,
  state: ReviewDecision["state"],
): Omit<ReviewDecision, "previousHistory"> {
  return {
    schemaVersion: "ebo.human-review-decision/v1",
    id,
    kind,
    assertion,
    reviewer: { kind: "human", id: reviewer },
    decidedAt: "2026-09-07T12:00:00Z",
    state,
    rationale: "Synthetic test fixture decision only.",
  };
}

async function writeAssertions(root: string, bundleRoot: string): Promise<BehaviorAssertion[]> {
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
  const event = dataset.events.find(({ source }) => source.nativeReference.artifactId === "session")!;
  const base = (id: string): BehaviorAssertion => ({
    schemaVersion: "ebo.behavior-assertion/v1",
    id,
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    dataset: { schemaVersion: dataset.schemaVersion, digest: digest(dataset) },
    behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
    rubric: { id: "fixture-rubric", version: "1.0.0" },
    evaluator: { id: "fixture-judge", version: "1.0.0" },
    judgment: {
      disposition: "assessed",
      assessment: "constructive",
      confidence: { value: 0.8, scale: "evaluator-reported-0-to-1" },
      rationale: "<script>fixture</script>",
      alternativeExplanation: "The retained validation may cover only part of the task.",
      citations: [{ eventId: event.id, nativeReference: event.source.nativeReference }],
    },
  });
  const assertions = [base("assertion-a"), base("assertion-b"), base("assertion-c"), {
    ...base("assertion-abstained"),
    behavior: { vocabularyVersion: "1.0.0", categoryId: "permission-escalation", dimensionId: "permission-escalation" },
    judgment: {
      disposition: "abstained" as const,
      reason: "No permission evidence is present.",
      rationale: "The selected evidence does not establish permission behavior.",
      alternativeExplanation: "The task may not have required permission escalation.",
      citations: [],
    },
  }];
  for (const assertion of assertions) writeJson(join(root, `${assertion.id}.json`), assertion);
  return assertions;
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
    bundleId: "bundle-human-calibration",
    run: {
      id: "run-human-calibration",
      assessmentMode: "observational",
      task: { id: "task-human-calibration" },
      fixture: { id: "fixture-human-calibration", digest: sha("a") },
      model: { provider: "anthropic", id: "claude-fixture" },
      harness: { id: "agent-sdk", version: capabilities.sdkVersion },
      runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }],
    },
    attempt: { id: "attempt-human-calibration", number: 1 },
    configuration: { digest: sha("b"), budgetDigest: sha("c"), toolPolicyDigest: sha("d") },
  };
  const query: ClaudeAgentSdkQuery = (input) => ({
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({
        hook_event_name: "SessionStart",
        session_id: "session-human-calibration",
        transcript_path: "/restricted/session.jsonl",
        cwd: final,
        source: "startup",
      } as HookInput, undefined, { signal: new AbortController().signal });
      yield {
        type: "assistant", uuid: "assistant-human-calibration", session_id: "session-human-calibration",
        parent_tool_use_id: null, message: { role: "assistant", content: [] },
      } as unknown as SDKMessage;
      yield {
        type: "result", subtype: "success", duration_ms: 12, duration_api_ms: 8, is_error: false,
        num_turns: 1, stop_reason: null, total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 },
        modelUsage: { "claude-fixture": { inputTokens: 3, outputTokens: 2, costUSD: 0.01 } },
        permission_denials: [], result: "done", session_id: "session-human-calibration", uuid: "result-human-calibration",
      } as unknown as SDKResultMessage;
    },
  });
  await captureClaudeAgentSdkRun({
    definition,
    startingWorkspacePath: start,
    workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
    configuration: { prompt: "Inspect result.txt.", model: "claude-fixture", tools: ["Read"], permissionMode: "dontAsk" },
    expectedHooks: ["SessionStart"],
    query,
  });
  return bundleRoot;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function readJson<Value>(path: string): Value {
  return JSON.parse(readFileSync(path, "utf8")) as Value;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${digestMetadata(value).value}`;
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}

function agentSdkNativeType(record: AgentSdkNativeRecord): string {
  const document = typeof record.document === "object" && record.document !== null ? record.document as Record<string, unknown> : undefined;
  if (record.kind === "session" && typeof document?.nativeType === "string") return document.nativeType;
  if (record.kind === "hook" && typeof document?.hook === "string") return document.hook;
  return ({ telemetry: "agent-sdk-telemetry", workspace: "workspace-outcome", verifier: "verifier-result", "assessment-mode": "assessment-mode", manifest: "terminal-record" } as Partial<Record<AgentSdkNativeRecord["kind"], string>>)[record.kind] ?? record.kind;
}

function agentSdkContentDigest(input: NormalizationInput<AgentSdkNativeRecord>, reference: NativeEvidenceReference): `sha256:${string}` | undefined {
  for (const { record } of input.records) {
    if (record.kind !== "workspace" && record.kind !== "diagnostic") continue;
    const descriptor = record.document as { id?: unknown; digest?: unknown } | null;
    if (descriptor?.id === reference.artifactId && typeof descriptor.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)) return descriptor.digest as `sha256:${string}`;
  }
  return undefined;
}
