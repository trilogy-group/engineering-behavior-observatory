import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateEvaluation,
  assessComparisonEligibility,
  buildCorpusIndex,
  validateArtifact,
  writeCorpusIndex,
  type AggregationReport,
  type AggregationRequest,
  type ComparisonReport,
  type CorpusIndexEntry,
} from "../src/index.js";
import { main } from "../src/cli.js";

const fixtureRoot = join(process.cwd(), "test/fixtures");
const digest = `sha256:${"a".repeat(64)}` as const;

test("aggregates distinct populations, retries, variation, and gated matched differences", async () => {
  const attempts = [
    entry("run-a", "attempt-a1", 1, { modelId: "model-a", trialId: "trial-1", terminalState: "completed", verifierStatuses: ["passed"] }),
    entry("run-r", "attempt-r1", 1, { modelId: "model-a", trialId: "trial-retry", terminalState: "completed", verifierStatuses: ["passed"] }),
    entry("run-r", "attempt-r2", 2, { modelId: "model-a", trialId: "trial-retry", terminalState: "interrupted", failureClass: "infrastructure", retryOf: "attempt-r1", verifierStatuses: [] }),
    entry("run-b", "attempt-b1", 1, { modelId: "model-b", trialId: "trial-1", terminalState: "completed", verifierStatuses: ["failed"] }),
    entry("run-c", "attempt-c1", 1, { modelId: "model-a", trialId: "trial-2", assessmentMode: "observational", terminalState: "completed", verifierStatuses: [] }),
  ];
  const exactRequest = readJson(join(fixtureRoot, "comparison/exact.json")) as Parameters<typeof assessComparisonEligibility>[0];
  exactRequest.measure = "verified:verifier-passed";
  exactRequest.left.id = "run-a";
  exactRequest.left.manifestDigest = digest;
  exactRequest.left.assessmentMode = "verified";
  exactRequest.right.id = "run-b";
  exactRequest.right.manifestDigest = digest;
  exactRequest.right.assessmentMode = "verified";
  exactRequest.right.model = { ...exactRequest.right.model, id: "model-b" };
  exactRequest.policy = { declaredDifferences: ["model"], requiredCapabilities: ["family:outcome"] };
  const exact: ComparisonReport = assessComparisonEligibility(exactRequest);
  const unsupportedRequest = readJson(join(fixtureRoot, "comparison/fixture-mismatch.json")) as Parameters<typeof assessComparisonEligibility>[0];
  unsupportedRequest.measure = "attempt:terminal-completed";
  unsupportedRequest.left.id = "run-a";
  unsupportedRequest.left.manifestDigest = digest;
  unsupportedRequest.left.assessmentMode = "verified";
  unsupportedRequest.right.id = "run-b";
  unsupportedRequest.right.manifestDigest = digest;
  unsupportedRequest.right.assessmentMode = "verified";
  unsupportedRequest.right.model = { ...unsupportedRequest.right.model, id: "model-b" };
  unsupportedRequest.policy = { declaredDifferences: ["model"], requiredCapabilities: ["family:outcome"] };
  const unsupported: ComparisonReport = assessComparisonEligibility(unsupportedRequest);

  const report = await aggregateEvaluation({
    corpusEntries: [...attempts, structuredClone(attempts[0]!)],
    observationSets: [],
    assertions: [],
    calibrations: [],
    comparisons: [
      { id: "verifier-model-difference", measure: "verified:verifier-passed", left: { model: "model-a" }, right: { model: "model-b" }, matchBy: ["task", "trial"], eligibility: [{ request: exactRequest, report: exact }] },
      { id: "mismatched-fixture", measure: "attempt:terminal-completed", left: { model: "model-a" }, right: { model: "model-b" }, matchBy: ["task", "trial"], eligibility: [{ request: unsupportedRequest, report: unsupported }] },
      { id: "wrong-measure-gate", measure: "attempt:terminal-completed", left: { model: "model-a" }, right: { model: "model-b" }, matchBy: ["task", "trial"], eligibility: [{ request: exactRequest, report: exact }] },
    ],
  }, { groupBy: ["task", "model", "harness"], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 } });

  assert.deepEqual(validateArtifact("aggregate", report), []);
  assert.deepEqual(report.sourcePopulation, { uniqueRuns: 4, uniqueAttempts: 5, selectedAttempts: 5, duplicateInputsIgnored: 1 });
  const modelA = report.groups.find(({ dimensions }) => dimensions.model === "model-a")!;
  assert.equal(metric(modelA, "infrastructure-failure-rate").measurement.rate, 1 / 4);
  assert.equal(metric(modelA, "verifier-pass-rate").measurement.denominator.value, 2);
  assert.equal(metric(modelA, "reviewed-assertion-confirmed-rate").measurement.status, "unavailable");
  assert.equal(modelA.variations.find(({ measure }) => measure === "terminal-state")!.claimStatus, "case-study");
  assert.equal(report.comparisons[0]!.claimStatus, "case-study", JSON.stringify(report.comparisons[0]));
  assert.equal(report.comparisons[0]!.matchedDifference.rate, -1);
  assert.equal(report.comparisons[0]!.matchedDifference.numerator.unit, "right-minus-left-verified-attempt");
  assert.equal(report.comparisons[1]!.claimStatus, "unavailable");
  assert.equal(report.comparisons[2]!.matchedDifference.exclusions[0]!.reason, "comparison-measure-not-gated");
  assert.equal(JSON.stringify(report).includes("statistical significance"), true);
  assert.deepEqual(metric(modelA, "structural-observation-set-availability-rate").measurement, {
    status: "available",
    numerator: { value: 0, unit: "attempt" },
    denominator: { value: 4, unit: "attempt" },
    rate: 0,
    exclusions: [{ reason: "observation-set-missing", count: 4, unit: "attempt" }],
  });
  await assert.rejects(aggregateEvaluation({
    corpusEntries: attempts,
    observationSets: [],
    assertions: [],
    calibrations: [],
    comparisons: [{
      id: "stale-gate",
      measure: "verified:verifier-passed",
      left: { model: "model-a" },
      right: { model: "model-b" },
      matchBy: ["task", "trial"],
      eligibility: [{ request: exactRequest, report: { ...exact, status: "unsupported" } }],
    }],
  }, { groupBy: ["task"], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 } }), /stale eligibility report/u);

  const latest = await aggregateEvaluation({ corpusEntries: attempts, observationSets: [], assertions: [], calibrations: [], comparisons: [] }, {
    groupBy: ["task"], selectedAttemptPolicy: "latest-attempt-per-run", recurrence: { minimumOccurrences: 2 },
  });
  assert.equal(latest.sourcePopulation.uniqueAttempts, 5);
  assert.equal(latest.sourcePopulation.selectedAttempts, 4);
  assert.deepEqual(metric(latest.groups[0]!, "attempt-count").measurement.exclusions, [
    { reason: "not-selected-by-attempt-policy", count: 1, unit: "attempt" },
  ]);
  assert.equal(metric(latest.groups[0]!, "verifier-pass-rate").measurement.denominator.value, 2);
  const observationalOnly = await aggregateEvaluation({ corpusEntries: [attempts[4]!], observationSets: [], assertions: [], calibrations: [], comparisons: [] }, {
    groupBy: ["task"], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 },
  });
  assert.equal(metric(observationalOnly.groups[0]!, "verifier-pass-rate").measurement.status, "unavailable");

  const singletonStates = [
    ...Array.from({ length: 8 }, (_, index) => entry(`stable-${index}`, `stable-attempt-${index}`, 1, { terminalState: "completed" })),
    entry("failed-once", "failed-once-attempt", 1, { terminalState: "failed", failureClass: "task" }),
    entry("interrupted-once", "interrupted-once-attempt", 1, { terminalState: "interrupted", failureClass: "infrastructure" }),
  ];
  const singletonReport = await aggregateEvaluation({ corpusEntries: singletonStates, observationSets: [], assertions: [], calibrations: [], comparisons: [] }, {
    groupBy: ["model"], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 },
  });
  assert.equal(singletonReport.groups[0]!.variations.find(({ measure }) => measure === "terminal-state")!.claimStatus, "case-study");
  const missingMatch = attempts.slice(0, 1).concat(attempts[3]!).map((attempt) => ({ ...attempt, captureQualification: undefined }));
  const missingMatchReport = await aggregateEvaluation({
    corpusEntries: missingMatch,
    observationSets: [],
    assertions: [],
    calibrations: [],
    comparisons: [{
      id: "missing-match-dimension",
      measure: "verified:verifier-passed",
      left: { model: "model-a" },
      right: { model: "model-b" },
      matchBy: ["capture-qualification"],
      eligibility: [{ request: exactRequest, report: exact }],
    }],
  }, { groupBy: ["task"], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 } });
  assert.deepEqual(missingMatchReport.comparisons[0]!.matchedDifference.exclusions, [
    { reason: "match-dimension-unavailable", count: 2, unit: "matched-unit" },
  ]);
});

test("CLI rebuilds aggregate output from a current local corpus index", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "ebo-aggregation-cli-"));
  try {
    const corpusRoot = join(temporary, "corpus");
    cpSync(join(fixtureRoot, "run-bundles/complete"), join(corpusRoot, "complete"), { recursive: true });
    cpSync(join(fixtureRoot, "run-bundles/task-failed"), join(corpusRoot, "task-failed"), { recursive: true });
    const indexPath = join(temporary, "index.jsonl");
    writeCorpusIndex(indexPath, buildCorpusIndex(corpusRoot));
    const requestPath = join(temporary, "request.json");
    const outputPath = join(temporary, "aggregate.json");
    const request: AggregationRequest = {
      schemaVersion: "ebo.aggregation-request/v1",
      sources: { corpusRoot, corpusIndex: indexPath, observationSets: [], assertions: [], calibrations: [] },
      groupBy: ["task", "model", "harness"],
      selectedAttemptPolicy: "all-attempts",
      recurrence: { minimumOccurrences: 2 },
      comparisons: [],
    };
    writeFileSync(requestPath, JSON.stringify(request));
    let output = "";
    assert.equal(await main(["aggregate", "build", requestPath, outputPath], (message) => { output += message; }), 0);
    assert.match(output, /Built 1 aggregate group\(s\)/u);
    const report = readJson(outputPath) as AggregationReport;
    assert.equal(report.sourcePopulation.uniqueAttempts, 2);
    assert.equal(report.groups[0]!.variations.find(({ measure }) => measure === "verifier-status")!.claimStatus, "case-study");
    const corpusAlias = join(temporary, "corpus-alias");
    symlinkSync(corpusRoot, corpusAlias);
    writeFileSync(requestPath, JSON.stringify({ ...request, sources: { ...request.sources, corpusRoot: corpusAlias } }));
    assert.equal(await main(["aggregate", "build", requestPath, join(corpusRoot, "forbidden.json")], () => undefined), 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function entry(runId: string, attemptId: string, attemptNumber: number, overrides: Partial<CorpusIndexEntry>): CorpusIndexEntry {
  return {
    schemaVersion: "ebo.corpus-index-entry/v1",
    manifestKind: "run",
    manifestPath: `${runId}/${attemptId}/manifest.json`,
    manifestDigest: digest,
    bundleId: `bundle-${attemptId}`,
    runId,
    trialId: runId,
    attemptId,
    attemptNumber,
    taskId: "task-a",
    taskDigest: digest,
    fixtureId: "fixture-a",
    fixtureDigest: `sha256:${"b".repeat(64)}`,
    modelId: "model-a",
    modelConfigurationDigest: `sha256:${"c".repeat(64)}`,
    harnessId: "harness-a",
    harnessVersion: "1.0.0",
    harnessConfigurationDigest: `sha256:${"d".repeat(64)}`,
    assessmentMode: "verified",
    captureProfileDigest: `sha256:${"e".repeat(64)}`,
    budgetDigest: `sha256:${"f".repeat(64)}`,
    toolPolicyDigest: `sha256:${"1".repeat(64)}`,
    terminalState: "completed",
    verifierArtifactIds: [],
    verifierStatuses: ["passed"],
    captureArtifactIds: [],
    captureQualification: "qualified",
    exportArtifactIds: [],
    issues: [],
    ...overrides,
  };
}

function metric(group: AggregationReport["groups"][number], id: string) {
  return group.metrics.find((value) => value.id === id)!;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
