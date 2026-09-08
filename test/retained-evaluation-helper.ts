import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateEvaluation, buildCorpusIndex, createRetainedBehaviorEvidence, createRetainedStructuralObservationSet,
  digestMetadata, main, probeClaudeAgentSdkCapabilities, runRetainedSemanticJudge, selectReviewSample, writeReviewPacket, CODEX_APP_SERVER_VERSION,
  type BehaviorAssertion, type ReviewHistory, type SemanticJudgeRequest } from "../src/index.js";

const digest = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;

/** Used by actual retained capture fixtures for every implemented harness. Synthetic reviews only. */
export async function checkRetainedEvaluation(bundleRoot: string, outputRoot: string): Promise<void> {
  const before = readFileSync(join(bundleRoot, "manifest.json"));
  const evidence = await createRetainedBehaviorEvidence(bundleRoot);
  const observations = await createRetainedStructuralObservationSet(bundleRoot);
  if (evidence.dataset.adapter.harness === "openhands-agent-server") assert.equal(evidence.dataset.adapter.version, "1.44.1");
  assert.ok(evidence.dataset.events.length > 0);
  assert.equal(await main(["observations", "create", bundleRoot, join(outputRoot, "observations.json")], () => undefined), 0);
  const event = evidence.dataset.events[0]!;
  const request: SemanticJudgeRequest = {
    schemaVersion: "ebo.semantic-judge-request/v1", id: "synthetic-retained-judge",
    behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
    rubric: { id: "synthetic-only", version: "1.0.0", instructions: "Synthetic fixture." },
    evaluator: { provider: "anthropic", model: "fixture-judge", effort: "low" },
    selection: { eventIds: [event.id], structuralObservationIds: [], includeOutcomeObservations: false },
    limits: { maxEvidenceItems: 4, maxRecordChars: 4096, maxInputChars: 20000, maxOutputChars: 16000, maxCitations: 2, maxWallClockMs: 1000, maxTurns: 1 },
    blinding: { evaluatedModelIdentity: "redact" },
  };
  for (const backend of ["claude-agent-sdk", "codex-app-server"] as const) {
    const configured = structuredClone(request);
    configured.evaluator.backend = backend;
    configured.evaluator.provider = backend === "claude-agent-sdk" ? "anthropic" : "openai";
    const result = await runRetainedSemanticJudge({ bundleRoot, observations, request: configured, outputRoot: join(outputRoot, backend),
      backend: { id: backend, version: backend === "claude-agent-sdk" ? probeClaudeAgentSdkCapabilities().sdkVersion : CODEX_APP_SERVER_VERSION,
        run: async () => ({ status: "completed", raw: { synthetic: true }, response: { judgment: { disposition: "assessed", assessment: "constructive",
          confidence: { value: 0.8, scale: "evaluator-reported-0-to-1" }, reason: null, missingEvidenceCapability: null,
          rationale: "Synthetic fixture only.", alternativeExplanation: "Not a human decision.", citations: [{ eventId: event.id, nativeReference: event.source.nativeReference }] } } }) } });
    assert.equal(result.status, "proposed", JSON.stringify(result));
  }
  const assertion = JSON.parse(readFileSync(join(outputRoot, "claude-agent-sdk/assertion.json"), "utf8")) as BehaviorAssertion;
  const assertPath = join(outputRoot, "assertion.json");
  const reports = [];
  for (const assessment of ["constructive", "adverse"] as const) {
    if (assertion.judgment.disposition === "assessed") assertion.judgment.assessment = assessment;
    writeFileSync(assertPath, JSON.stringify(assertion));
    assert.equal(await main(["assertions", "validate", bundleRoot, assertPath], () => undefined), 0);
    const selection = await selectReviewSample({ schemaVersion: "ebo.review-source-set/v1", sources: [{ bundleRoot, assertionPath: assertPath, taskContext: "SYNTHETIC TEST" }] },
      { schemaVersion: "ebo.review-sample-criteria/v1", seed: "fixture", strata: [{ id: "all", sampleSize: 1, filters: {} }] });
    await writeReviewPacket(selection, join(outputRoot, `packet-${assessment}`));
    const history: ReviewHistory = { schemaVersion: "ebo.review-history/v1", selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) }, decisions: [{
      schemaVersion: "ebo.human-review-decision/v1", id: "synthetic-only", kind: "review", assertion: selection.candidates[0]!.assertion,
      reviewer: { kind: "human", id: "SYNTHETIC-TEST-FIXTURE" }, decidedAt: "2026-09-07T00:00:00Z", state: "confirmed", rationale: "Synthetic test.", previousHistory: null,
    }] };
    const input = { corpusEntries: buildCorpusIndex(bundleRoot), observationSets: [{ bundleRoot, document: observations }], assertions: [{ bundleRoot, document: assertion }], calibrations: [{ selection, history }], comparisons: [] };
    const policy = { groupBy: ["task" as const], selectedAttemptPolicy: "all-attempts" as const, recurrence: { minimumOccurrences: 2 } };
    const report = await aggregateEvaluation(input, policy);
    const behavior = report.groups[0]!.behaviors![0]!;
    assert.equal(behavior.assessments.find((value) => value.assessment === assessment)!.measurement.rate, 1);
    assert.equal(behavior.assertions[0]!.included, true);
    const unreviewed = await aggregateEvaluation({ ...input, calibrations: [] }, policy);
    assert.equal(unreviewed.groups[0]!.behaviors![0]!.assessments[0]!.measurement.status, "unavailable");
    const disputedHistory = structuredClone(history);
    disputedHistory.decisions[0]!.state = "disputed";
    const disputed = await aggregateEvaluation({ ...input, calibrations: [{ selection, history: disputedHistory }] }, policy);
    assert.equal(disputed.groups[0]!.behaviors![0]!.assertions[0]!.included, false);
    assert.equal(disputed.groups[0]!.behaviors![0]!.assessments[0]!.measurement.denominator.value, 0);
    reports.push(report);
  }
  assert.notDeepEqual(reports[0]!.groups, reports[1]!.groups);
  const rerun = structuredClone(assertion);
  rerun.id = "rerun";
  const otherRubric = structuredClone(assertion);
  otherRubric.id = "other-rubric";
  otherRubric.rubric.version = "2.0.0";
  const values = [assertion, rerun, otherRubric];
  for (const conflict of [false, true]) {
    if (conflict && rerun.judgment.disposition === "assessed") rerun.judgment.assessment = "constructive";
    const sources = values.map((document) => {
      const assertionPath = join(outputRoot, `${document.id}.json`);
      writeFileSync(assertionPath, JSON.stringify(document));
      return { bundleRoot, assertionPath, taskContext: "SYNTHETIC RERUN TEST" };
    });
    const selection = await selectReviewSample({ schemaVersion: "ebo.review-source-set/v1", sources },
      { schemaVersion: "ebo.review-sample-criteria/v1", seed: "fixture", strata: [{ id: "all", sampleSize: 3, filters: {} }] });
    const history: ReviewHistory = { schemaVersion: "ebo.review-history/v1", selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) }, decisions: [] };
    for (const candidate of selection.candidates) {
      const previousHistory = history.decisions.length === 0 ? null : { schemaVersion: history.schemaVersion, digest: digest(history) };
      history.decisions = [...history.decisions, { schemaVersion: "ebo.human-review-decision/v1", id: `review-${candidate.assertion.id}`, kind: "review", assertion: candidate.assertion,
        reviewer: { kind: "human", id: "SYNTHETIC-TEST-FIXTURE" }, decidedAt: "2026-09-07T00:00:00Z", state: "confirmed", rationale: "Synthetic test.", previousHistory }];
    }
    const report = await aggregateEvaluation({ corpusEntries: buildCorpusIndex(bundleRoot), observationSets: [], assertions: values.map((document) => ({ bundleRoot, document })),
      calibrations: [{ selection, history }], comparisons: [] }, { groupBy: [], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 } });
    assert.equal(report.groups[0]!.behaviors!.length, 2);
    const original = report.groups[0]!.behaviors!.find(({ rubric }) => rubric.version === "1.0.0")!;
    assert.equal(original.assessments[0]!.measurement.denominator.value, conflict ? 0 : 1);
    if (conflict) assert.equal(original.assessments[0]!.measurement.exclusions[0]!.reason, "conflicting-confirmed-reruns");
  }
  assert.deepEqual(readFileSync(join(bundleRoot, "manifest.json")), before);
}
