import { join, resolve } from "node:path";

import { canonicalizeMetadata, digestBytes, digestMetadata, validateArtifact } from "./artifacts.js";
import { validateAgentSdkBehaviorAssertion, type BehaviorAssertion } from "./behavior-assertions.js";
import type { CorpusIndexEntry } from "./corpus.js";
import {
  effectiveReviewOutcome,
  isDisputedReviewOutcome,
  revalidateReviewSample,
  validateReviewHistory,
  type ReviewHistory,
  type ReviewSample,
} from "./human-calibration.js";
import { assessComparisonEligibility, type ComparisonCapability, type ComparisonReport, type ComparisonRequest } from "./normalization-integrity.js";
import { readBoundedFile } from "./scheduler.js";
import { createAgentSdkStructuralObservationSet, type StructuralObservationSet } from "./structural-observations.js";

export type AggregationDimension = "task" | "model" | "harness" | "trial" | "capture-qualification";
export type AttemptSelectionPolicy = "all-attempts" | "latest-attempt-per-run";

export type AggregationRequest = {
  schemaVersion: "ebo.aggregation-request/v1";
  sources: {
    corpusRoot: string;
    corpusIndex: string;
    observationSets: ReadonlyArray<{ bundleRoot: string; path: string }>;
    assertions: ReadonlyArray<{ bundleRoot: string; path: string }>;
    calibrations: ReadonlyArray<{ selection: string; history: string }>;
  };
  groupBy: readonly AggregationDimension[];
  selectedAttemptPolicy: AttemptSelectionPolicy;
  recurrence: { minimumOccurrences: number };
  comparisons: ReadonlyArray<{
    id: string;
    measure: string;
    left: Partial<Record<AggregationDimension, string>>;
    right: Partial<Record<AggregationDimension, string>>;
    matchBy: readonly AggregationDimension[];
    eligibilityGates: ReadonlyArray<{ request: string; report: string }>;
  }>;
};

export type AggregationInput = {
  corpusEntries: readonly CorpusIndexEntry[];
  observationSets: ReadonlyArray<{ bundleRoot: string; document: StructuralObservationSet }>;
  assertions: ReadonlyArray<{ bundleRoot: string; document: BehaviorAssertion }>;
  calibrations: ReadonlyArray<{ selection: ReviewSample; history: ReviewHistory }>;
  comparisons: ReadonlyArray<{
    id: string;
    measure: string;
    left: Partial<Record<AggregationDimension, string>>;
    right: Partial<Record<AggregationDimension, string>>;
    matchBy: readonly AggregationDimension[];
    eligibility: ReadonlyArray<{ request: ComparisonRequest; report: ComparisonReport }>;
  }>;
};

export type AggregateMeasurement = {
  status: "available" | "unavailable";
  numerator: { value: number; unit: string };
  denominator: { value: number; unit: string };
  rate?: number;
  exclusions: ReadonlyArray<{ reason: string; count: number; unit: string }>;
  reason?: string;
};

export type AggregateMetric = {
  id: string;
  population: "run" | "attempt" | "operation" | "assertion" | "reviewed-assertion";
  claimStatus: "descriptive" | "unavailable";
  measurement: AggregateMeasurement;
};

export type AggregationReport = {
  schemaVersion: "ebo.aggregation-report/v1";
  policy: {
    groupBy: readonly AggregationDimension[];
    selectedAttemptPolicy: AttemptSelectionPolicy;
    recurrence: { minimumOccurrences: number; establishesCausality: false; establishesStatisticalSignificance: false };
  };
  sourcePopulation: {
    uniqueRuns: number;
    uniqueAttempts: number;
    selectedAttempts: number;
    duplicateInputsIgnored: number;
  };
  groups: ReadonlyArray<{
    dimensions: Partial<Record<AggregationDimension, string>>;
    metrics: readonly AggregateMetric[];
    variations: ReadonlyArray<{
      measure: "terminal-state" | "verifier-status";
      distribution: readonly AggregateMetric[];
      claimStatus: "no-variation" | "case-study" | "recurring-description" | "unavailable";
    }>;
  }>;
  comparisons: ReadonlyArray<{
    id: string;
    measure: string;
    eligibility: readonly ComparisonReport[];
    matchedDifference: AggregateMeasurement;
    differingMatchedUnits: number;
    claimStatus: "no-difference" | "case-study" | "recurring-description" | "unavailable";
    limitations: readonly string[];
  }>;
  limitations: readonly string[];
};

type Attempt = CorpusIndexEntry & { runId: string; attemptId: string };
type ReviewOutcome = { outcome: ReturnType<typeof effectiveReviewOutcome>; disputed: boolean };

export function aggregateEvaluation(
  input: AggregationInput,
  policy: Pick<AggregationRequest, "groupBy" | "selectedAttemptPolicy" | "recurrence">,
): Promise<AggregationReport> {
  return aggregateValidatedEvaluation(input, policy);
}

async function aggregateValidatedEvaluation(
  input: AggregationInput,
  policy: Pick<AggregationRequest, "groupBy" | "selectedAttemptPolicy" | "recurrence">,
): Promise<AggregationReport> {
  assertPolicy(policy);
  const { attempts, duplicates } = uniqueAttempts(input.corpusEntries);
  const selected = selectAttempts(attempts, policy.selectedAttemptPolicy);
  const observationSources = uniqueBy(input.observationSets, ({ document }) => `${document.runId}\0${document.attemptId}`, "observation set");
  const observations = new Map<string, StructuralObservationSet>();
  for (const { bundleRoot, document } of observationSources.values()) {
    assertIndexedBundle(bundleRoot, document.runId, document.attemptId, attempts);
    const rebuilt = await createAgentSdkStructuralObservationSet(bundleRoot);
    if (canonicalizeMetadata(rebuilt) !== canonicalizeMetadata(document)) throw new Error(`Structural observation set for attempt "${document.attemptId}" is stale.`);
    observations.set(`${document.runId}\0${document.attemptId}`, document);
  }
  const assertionSources = uniqueBy(input.assertions, ({ document }) => assertionKey(document), "behavior assertion");
  const assertions = new Map<string, BehaviorAssertion>();
  for (const { bundleRoot, document } of assertionSources.values()) {
    assertIndexedBundle(bundleRoot, document.runId, document.attemptId, attempts);
    await validateAgentSdkBehaviorAssertion(bundleRoot, document);
    assertions.set(assertionKey(document), document);
  }
  for (const { selection } of input.calibrations) await revalidateReviewSample(selection);
  const reviewOutcomes = reviewOutcomeIndex(input.calibrations);
  const groups = groupAttempts(selected, policy.groupBy).map(([dimensions, members]) => ({
    dimensions,
    metrics: groupMetrics(members, attempts, observations, assertions, reviewOutcomes, dimensions),
    variations: [
      variation("terminal-state", members, policy.recurrence.minimumOccurrences),
      variation("verifier-status", members, policy.recurrence.minimumOccurrences),
    ],
  }));
  const report: AggregationReport = {
    schemaVersion: "ebo.aggregation-report/v1",
    policy: {
      groupBy: [...policy.groupBy],
      selectedAttemptPolicy: policy.selectedAttemptPolicy,
      recurrence: {
        minimumOccurrences: policy.recurrence.minimumOccurrences,
        establishesCausality: false,
        establishesStatisticalSignificance: false,
      },
    },
    sourcePopulation: {
      uniqueRuns: new Set(attempts.map(({ runId }) => runId)).size,
      uniqueAttempts: attempts.length,
      selectedAttempts: selected.length,
      duplicateInputsIgnored: duplicates,
    },
    groups,
    comparisons: input.comparisons.map((comparison) => compare(
      comparison,
      selected,
      observations,
      policy.recurrence.minimumOccurrences,
    )),
    limitations: [
      "All aggregates are descriptive; no causal attribution or statistical significance is claimed.",
      "Observational completion is a terminal-state measure, not task success.",
      "Verifier rates include only verified attempts with an available terminal verifier result.",
      "Human-reviewed assertion rates include only digest-bound calibration selections and validated review lineage.",
    ],
  };
  assertArtifact("aggregation report", report);
  return report;
}

function groupMetrics(
  selected: readonly Attempt[],
  all: readonly Attempt[],
  observations: ReadonlyMap<string, StructuralObservationSet>,
  assertions: ReadonlyMap<string, BehaviorAssertion>,
  reviews: ReadonlyMap<string, ReviewOutcome>,
  dimensions: Partial<Record<AggregationDimension, string>>,
): AggregateMetric[] {
  const selectedIds = new Set(selected.map(attemptKey));
  const relatedAll = all.filter((attempt) => matches(attempt, dimensions));
  const selectionExclusions = exclusionCounts(relatedAll.filter((attempt) => !selectedIds.has(attemptKey(attempt))).map(() => "not-selected-by-attempt-policy"), "attempt");
  const metrics: AggregateMetric[] = [
    metric("attempt-count", "attempt", selected.length, relatedAll.length, "attempt", "attempt", selectionExclusions),
    rateMetric("infrastructure-failure-rate", "attempt", selected.filter(({ failureClass }) => failureClass === "infrastructure").length, selected.length, "attempt", []),
    rateMetric("capture-qualified-rate", "attempt", selected.filter(({ captureQualification }) => captureQualification === "qualified" || captureQualification === "qualified-with-gaps").length, selected.length, "attempt", []),
    rateMetric("terminal-completed-rate", "attempt", selected.filter(({ terminalState }) => terminalState === "completed").length, selected.length, "attempt", []),
  ];
  const verified = selected.filter(({ assessmentMode, verifierStatuses }) => assessmentMode === "verified" && verifierStatuses.length === 1);
  metrics.push(rateMetric(
    "verifier-pass-rate",
    "attempt",
    verified.filter(({ verifierStatuses }) => verifierStatuses[0] === "passed").length,
    verified.length,
    "verified-attempt",
    exclusionCounts(selected.flatMap((attempt) => attempt.assessmentMode !== "verified"
      ? ["observational-or-unknown-assessment-mode"]
      : attempt.verifierStatuses.length !== 1 ? ["verifier-outcome-unavailable-or-conflicting"] : []), "attempt"),
  ));
  const selectedObservationSets = selected.flatMap((attempt) => observations.get(attemptKey(attempt)) ?? []);
  metrics.push(rateMetric("structural-observation-set-availability-rate", "attempt", selectedObservationSets.length,
    selected.length, "attempt", exclusionCounts(selected.flatMap((attempt) => observations.has(attemptKey(attempt)) ? [] : ["observation-set-missing"]), "attempt")));
  const extractorIds = [...new Set(selectedObservationSets.flatMap(({ observations: values }) => values.map(({ extractor }) => extractor.id)))].sort();
  for (const extractorId of extractorIds) {
    const values = selected.map((attempt) => observations.get(attemptKey(attempt))?.observations.find(({ extractor }) => extractor.id === extractorId)?.value);
    const known = values.flatMap((value) => value?.status === "known" && typeof value.value === "number" ? [value] : []);
    const units = new Set(known.map(({ unit }) => unit));
    metrics.push(units.size > 1
      ? unavailableMetric(`structural:${extractorId}`, "attempt", "Structural observation units differ within the group.", selected.length, "attempt")
      : metric(`structural:${extractorId}`, "attempt", known.reduce((sum, { value }) => sum + Number(value), 0), known.length,
        known[0]?.unit ?? "observation-value", "attempt-with-known-observation",
        exclusionCounts(values.flatMap((value) => value?.status === "unavailable" ? [value.reason] : value === undefined ? ["observation-set-missing"] : []), "attempt")));
  }
  const selectedAssertions = [...assertions.values()].filter(({ runId, attemptId }) => selectedIds.has(`${runId}\0${attemptId}`));
  metrics.push(rateMetric("assertion-abstention-rate", "assertion", selectedAssertions.filter(({ judgment }) => judgment.disposition === "abstained").length,
    selectedAssertions.length, "assertion", []));
  const reviewResults = selectedAssertions.map((assertion) => reviews.get(assertionBindingKey(assertion)) ?? {
    outcome: assertion.judgment.disposition === "abstained" ? "judge-abstained" as const : "unreviewed" as const,
    disputed: false,
  });
  const outcomes = reviewResults.map(({ outcome }) => outcome);
  const reviewed = outcomes.filter((outcome) => outcome === "confirmed" || outcome === "rejected" || outcome === "unresolved");
  metrics.push(rateMetric("reviewed-assertion-confirmed-rate", "reviewed-assertion", reviewed.filter((outcome) => outcome === "confirmed").length,
    reviewed.length, "reviewed-assertion", exclusionCounts(outcomes.flatMap((outcome) => outcome === "unreviewed" || outcome === "judge-abstained" ? [outcome] : []), "assertion")));
  metrics.push(rateMetric("review-unresolved-rate", "assertion", outcomes.filter((outcome) => outcome === "unresolved" || outcome === "unreviewed" || outcome === "judge-abstained").length,
    outcomes.length, "assertion", []));
  metrics.push(rateMetric("review-disputed-rate", "assertion", reviewResults.filter(({ disputed }) => disputed).length,
    reviewResults.length, "assertion", []));
  return metrics;
}

function variation(
  measure: "terminal-state" | "verifier-status",
  attempts: readonly Attempt[],
  recurrenceMinimum: number,
): AggregationReport["groups"][number]["variations"][number] {
  const values = attempts.flatMap((attempt) => measure === "terminal-state"
    ? attempt.terminalState === undefined ? [] : [attempt.terminalState]
    : attempt.assessmentMode === "verified" && attempt.verifierStatuses.length === 1 ? [attempt.verifierStatuses[0]!] : []);
  const excluded = attempts.length - values.length;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const distribution = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) =>
    rateMetric(`${measure}:${value}`, "attempt", count, values.length, "attempt", excluded === 0 ? [] : [{ reason: `${measure}-unavailable`, count: excluded, unit: "attempt" }]));
  const secondMostFrequent = [...counts.values()].sort((left, right) => right - left)[1] ?? 0;
  return {
    measure,
    distribution,
    claimStatus: values.length === 0 ? "unavailable" : secondMostFrequent === 0 ? "no-variation"
      : secondMostFrequent >= recurrenceMinimum ? "recurring-description" : "case-study",
  };
}

function compare(
  comparison: AggregationInput["comparisons"][number],
  attempts: readonly Attempt[],
  observations: ReadonlyMap<string, StructuralObservationSet>,
  recurrenceMinimum: number,
): AggregationReport["comparisons"][number] {
  const gates = new Map<string, { request: ComparisonRequest; report: ComparisonReport }>();
  for (const { request, report } of comparison.eligibility) {
    const rebuilt = assessComparisonEligibility(request);
    if (canonicalizeMetadata(rebuilt) !== canonicalizeMetadata(report)) {
      throw new Error(`Comparison "${comparison.id}" has a stale eligibility report.`);
    }
    assertArtifact("comparison report", report);
    const key = candidatePairKey(report.candidates[0], report.candidates[1]);
    const current = gates.get(key);
    if (current !== undefined && canonicalizeMetadata(current) !== canonicalizeMetadata({ request, report })) {
      throw new Error(`Comparison "${comparison.id}" has conflicting eligibility reports for one candidate pair.`);
    }
    gates.set(key, { request, report });
  }
  const left = attempts.filter((attempt) => matches(attempt, comparison.left));
  const right = attempts.filter((attempt) => matches(attempt, comparison.right));
  const exclusions: string[] = [
    ...left.filter((attempt) => hasMissingDimension(attempt, comparison.matchBy)).map(() => "match-dimension-unavailable"),
    ...right.filter((attempt) => hasMissingDimension(attempt, comparison.matchBy)).map(() => "match-dimension-unavailable"),
  ];
  const leftByMatch = indexedMatches(left.filter((attempt) => !hasMissingDimension(attempt, comparison.matchBy)), comparison.matchBy);
  const rightByMatch = indexedMatches(right.filter((attempt) => !hasMissingDimension(attempt, comparison.matchBy)), comparison.matchBy);
  const keys = [...new Set([...leftByMatch.keys(), ...rightByMatch.keys()])].sort();
  const differences: number[] = [];
  for (const key of keys) {
    const leftMatches = leftByMatch.get(key) ?? [];
    const rightMatches = rightByMatch.get(key) ?? [];
    if (leftMatches.length !== 1 || rightMatches.length !== 1) {
      exclusions.push(leftMatches.length === 0 || rightMatches.length === 0 ? "unmatched-unit" : "ambiguous-matched-unit");
      continue;
    }
    const gate = gates.get(candidatePairKey(leftMatches[0]!.runId, rightMatches[0]!.runId));
    if (gate === undefined) {
      exclusions.push("comparison-eligibility-missing");
      continue;
    }
    const leftCandidate = gate.request.left.id === leftMatches[0]!.runId ? gate.request.left : gate.request.right;
    const rightCandidate = gate.request.left.id === rightMatches[0]!.runId ? gate.request.left : gate.request.right;
    if (!candidateMatchesAttempt(leftCandidate, leftMatches[0]!, comparison.measure, observations)
        || !candidateMatchesAttempt(rightCandidate, rightMatches[0]!, comparison.measure, observations)) {
      exclusions.push("comparison-candidate-evidence-mismatch");
      continue;
    }
    if (gate.report.status === "unsupported") {
      exclusions.push("comparison-eligibility-unsupported");
      continue;
    }
    if (gate.report.measure !== comparison.measure) {
      exclusions.push("comparison-measure-not-gated");
      continue;
    }
    if (measureCapabilities(comparison.measure, [leftMatches[0]!, rightMatches[0]!], observations)
      .some((capability) => !gate.report.policy.requiredCapabilities.includes(capability))) {
      exclusions.push("comparison-measure-capability-not-gated");
      continue;
    }
    const leftValue = measureValue(leftMatches[0]!, comparison.measure, observations);
    const rightValue = measureValue(rightMatches[0]!, comparison.measure, observations);
    if (leftValue === undefined || rightValue === undefined) exclusions.push("measure-unavailable");
    else if (leftValue.unit !== rightValue.unit) exclusions.push("measure-unit-mismatch");
    else differences.push(rightValue.value - leftValue.value);
  }
  const differing = differences.filter((value) => value !== 0).length;
  const measurement = differences.length === 0
    ? unavailableMeasurement("No uniquely matched units have the requested measure on both sides.", 0, "matched-unit", exclusionCounts(exclusions, "matched-unit"))
    : availableMeasurement(differences.reduce((sum, value) => sum + value, 0), differences.length,
      "right-minus-left-value", "matched-unit", exclusionCounts(exclusions, "matched-unit"));
  return {
    id: comparison.id,
    measure: comparison.measure,
    eligibility: comparison.eligibility.map(({ report }) => structuredClone(report)),
    matchedDifference: measurement,
    differingMatchedUnits: differing,
    claimStatus: differences.length === 0 ? "unavailable" : differing === 0 ? "no-difference"
      : differing >= recurrenceMinimum ? "recurring-description" : "case-study",
    limitations: [
      ...new Set(comparison.eligibility.flatMap(({ report }) => report.reasons.map(({ detail }) => detail))),
      "Matched differences are descriptive and do not establish causality or statistical significance.",
    ],
  };
}

function candidateMatchesAttempt(
  candidate: ComparisonRequest["left"],
  attempt: Attempt,
  measure: string,
  observations: ReadonlyMap<string, StructuralObservationSet>,
): boolean {
  const exact = candidate.id === attempt.runId
    && candidate.manifestDigest === attempt.manifestDigest
    && candidate.task.id === attempt.taskId
    && candidate.task.digest === attempt.taskDigest
    && candidate.fixture.id === attempt.fixtureId
    && candidate.fixture.digest === attempt.fixtureDigest
    && candidate.model.id === attempt.modelId
    && candidate.model.configurationDigest === attempt.modelConfigurationDigest
    && candidate.harness.id === attempt.harnessId
    && candidate.harness.version === attempt.harnessVersion
    && candidate.harness.configurationDigest === attempt.harnessConfigurationDigest
    && candidate.assessmentMode === attempt.assessmentMode
    && candidate.captureProfileDigest === attempt.captureProfileDigest
    && candidate.budgetDigest === attempt.budgetDigest
    && candidate.toolPolicyDigest === attempt.toolPolicyDigest;
  if (!exact || !measure.startsWith("structural:")) return exact;
  const observationSet = observations.get(attemptKey(attempt));
  if (observationSet === undefined) return false;
  const coverage = observationSet.normalization.coverage;
  const profile = {
    schemaVersion: "ebo.adapter-capability-profile/v1",
    adapterId: observationSet.normalization.adapter.id,
    harness: observationSet.normalization.adapter.harness,
    nativeTypes: coverage.nativeTypes.map(({ nativeType }) => nativeType),
    families: Object.fromEntries(Object.entries(coverage.families).map(([family, value]) => [family, value.capability])),
    evidence: coverage.evidence,
  };
  return candidate.adapterVersion === observationSet.normalization.adapter.version
    && canonicalizeMetadata(candidate.capabilityProfile) === canonicalizeMetadata(profile);
}

function measureCapabilities(
  measure: string,
  attempts: readonly Attempt[],
  observations: ReadonlyMap<string, StructuralObservationSet>,
): readonly ComparisonCapability[] {
  if (measure === "attempt:infrastructure-failure" || measure === "attempt:terminal-completed" || measure === "verified:verifier-passed") {
    return ["family:outcome"];
  }
  if (measure.startsWith("structural:")) {
    const extractorId = measure.slice("structural:".length);
    return [...new Set(attempts.flatMap((attempt) => observations.get(attemptKey(attempt))?.observations
      .find(({ extractor }) => extractor.id === extractorId)?.extractor.requiredCapabilities ?? []))];
  }
  throw new Error(`Unsupported aggregate comparison measure "${measure}".`);
}

function candidatePairKey(left: string, right: string): string {
  return canonicalizeMetadata([left, right].sort());
}

function measureValue(attempt: Attempt, measure: string, observations: ReadonlyMap<string, StructuralObservationSet>): { value: number; unit: string } | undefined {
  if (measure === "attempt:infrastructure-failure") return { value: attempt.failureClass === "infrastructure" ? 1 : 0, unit: "attempt" };
  if (measure === "attempt:terminal-completed") return attempt.terminalState === undefined ? undefined : { value: attempt.terminalState === "completed" ? 1 : 0, unit: "attempt" };
  if (measure === "verified:verifier-passed") return attempt.assessmentMode !== "verified" || attempt.verifierStatuses.length !== 1
    ? undefined : { value: attempt.verifierStatuses[0] === "passed" ? 1 : 0, unit: "verified-attempt" };
  if (measure.startsWith("structural:")) {
    const value = observations.get(attemptKey(attempt))?.observations.find(({ extractor }) => extractor.id === measure.slice("structural:".length))?.value;
    return value?.status === "known" && typeof value.value === "number" ? { value: value.value, unit: value.unit } : undefined;
  }
  throw new Error(`Unsupported aggregate comparison measure "${measure}".`);
}

function reviewOutcomeIndex(calibrations: AggregationInput["calibrations"]): Map<string, ReviewOutcome> {
  const outcomes = new Map<string, ReviewOutcome>();
  for (const { selection, history } of calibrations) {
    validateReviewHistory(selection, history);
    for (const candidate of selection.candidates) {
      const key = bindingKey(candidate.assertion.id, candidate.assertion.digest);
      const outcome = {
        outcome: effectiveReviewOutcome(candidate, history.decisions),
        disputed: isDisputedReviewOutcome(candidate, history.decisions),
      };
      const current = outcomes.get(key);
      if (current !== undefined && canonicalizeMetadata(current) !== canonicalizeMetadata(outcome)) throw new Error(`Calibration inputs conflict for assertion "${candidate.assertion.id}".`);
      outcomes.set(key, outcome);
    }
  }
  return outcomes;
}

function uniqueAttempts(entries: readonly CorpusIndexEntry[]): { attempts: Attempt[]; duplicates: number } {
  const attempts = new Map<string, Attempt>();
  let duplicates = 0;
  for (const entry of entries) {
    if (entry.manifestKind !== "run" || entry.runId === undefined || entry.attemptId === undefined) continue;
    const key = attemptKey(entry as Attempt);
    const current = attempts.get(key);
    if (current === undefined) attempts.set(key, structuredClone(entry) as Attempt);
    else if (canonicalizeMetadata(current) === canonicalizeMetadata(entry)) duplicates += 1;
    else throw new Error(`Corpus inputs conflict for run "${entry.runId}" attempt "${entry.attemptId}".`);
  }
  return { attempts: [...attempts.values()].sort((left, right) => attemptKey(left).localeCompare(attemptKey(right))), duplicates };
}

function assertIndexedBundle(bundleRoot: string, runId: string, attemptId: string, attempts: readonly Attempt[]): void {
  const indexed = attempts.filter((attempt) => attempt.runId === runId && attempt.attemptId === attemptId);
  if (indexed.length !== 1) throw new Error(`Derived source run "${runId}" attempt "${attemptId}" has no unique corpus entry.`);
  const actual = `sha256:${digestBytes(readBoundedFile(join(resolve(bundleRoot), "manifest.json"), "Derived source manifest")).value}`;
  if (actual !== indexed[0]!.manifestDigest) {
    throw new Error(`Derived source run "${runId}" attempt "${attemptId}" does not match the indexed manifest digest.`);
  }
}

function selectAttempts(attempts: readonly Attempt[], policy: AttemptSelectionPolicy): Attempt[] {
  if (policy === "all-attempts") return [...attempts];
  const latest = new Map<string, Attempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.runId);
    if (current === undefined || (attempt.attemptNumber ?? -1) > (current.attemptNumber ?? -1)) latest.set(attempt.runId, attempt);
    else if ((attempt.attemptNumber ?? -1) === (current.attemptNumber ?? -1) && attempt.attemptId !== current.attemptId) {
      throw new Error(`Run "${attempt.runId}" has ambiguous latest attempts.`);
    }
  }
  return [...latest.values()].sort((left, right) => attemptKey(left).localeCompare(attemptKey(right)));
}

function groupAttempts(attempts: readonly Attempt[], dimensions: readonly AggregationDimension[]): Array<[Partial<Record<AggregationDimension, string>>, Attempt[]]> {
  const groups = new Map<string, [Partial<Record<AggregationDimension, string>>, Attempt[]]>();
  for (const attempt of attempts) {
    const values = Object.fromEntries(dimensions.map((dimension) => [dimension, dimensionValue(attempt, dimension) ?? "unavailable"])) as Partial<Record<AggregationDimension, string>>;
    const key = canonicalizeMetadata(values);
    const group = groups.get(key) ?? [values, []];
    group[1].push(attempt);
    groups.set(key, group);
  }
  return [...groups.values()].sort(([left], [right]) => canonicalizeMetadata(left).localeCompare(canonicalizeMetadata(right)));
}

function dimensionValue(attempt: Attempt, dimension: AggregationDimension): string | undefined {
  return ({
    task: attempt.taskId,
    model: attempt.modelId,
    harness: attempt.harnessId,
    trial: attempt.trialId,
    "capture-qualification": attempt.captureQualification,
  })[dimension];
}

function matches(attempt: Attempt, filters: Partial<Record<AggregationDimension, string>>): boolean {
  return Object.entries(filters).every(([dimension, value]) => (dimensionValue(attempt, dimension as AggregationDimension) ?? "unavailable") === value);
}

function indexedMatches(attempts: readonly Attempt[], dimensions: readonly AggregationDimension[]): Map<string, Attempt[]> {
  const result = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const key = canonicalizeMetadata(dimensions.map((dimension) => dimensionValue(attempt, dimension) ?? null));
    const values = result.get(key) ?? [];
    values.push(attempt);
    result.set(key, values);
  }
  return result;
}

function hasMissingDimension(attempt: Attempt, dimensions: readonly AggregationDimension[]): boolean {
  return dimensions.some((dimension) => dimensionValue(attempt, dimension) === undefined);
}

function metric(id: string, population: AggregateMetric["population"], numerator: number, denominator: number,
  numeratorUnit: string, denominatorUnit: string, exclusions: AggregateMeasurement["exclusions"]): AggregateMetric {
  const measurement = denominator === 0
    ? unavailableMeasurement("The eligible denominator is empty.", numerator, denominatorUnit, exclusions, numeratorUnit)
    : availableMeasurement(numerator, denominator, numeratorUnit, denominatorUnit, exclusions);
  return { id, population, claimStatus: measurement.status === "available" ? "descriptive" : "unavailable", measurement };
}

function rateMetric(id: string, population: AggregateMetric["population"], numerator: number, denominator: number,
  unit: string, exclusions: AggregateMeasurement["exclusions"]): AggregateMetric {
  return metric(id, population, numerator, denominator, unit, unit, exclusions);
}

function unavailableMetric(id: string, population: AggregateMetric["population"], reason: string, denominator: number, unit: string): AggregateMetric {
  return { id, population, claimStatus: "unavailable", measurement: unavailableMeasurement(reason, 0, unit, [], unit, denominator) };
}

function availableMeasurement(numerator: number, denominator: number, numeratorUnit: string, denominatorUnit: string,
  exclusions: AggregateMeasurement["exclusions"]): AggregateMeasurement {
  return { status: "available", numerator: { value: numerator, unit: numeratorUnit }, denominator: { value: denominator, unit: denominatorUnit }, rate: numerator / denominator, exclusions };
}

function unavailableMeasurement(reason: string, numerator: number, denominatorUnit: string,
  exclusions: AggregateMeasurement["exclusions"], numeratorUnit = denominatorUnit, denominator = 0): AggregateMeasurement {
  return { status: "unavailable", numerator: { value: numerator, unit: numeratorUnit }, denominator: { value: denominator, unit: denominatorUnit }, exclusions, reason };
}

function exclusionCounts(reasons: readonly string[], unit: string): AggregateMeasurement["exclusions"] {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => ({ reason, count, unit }));
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string, label: string): Map<string, Value> {
  const result = new Map<string, Value>();
  for (const value of values) {
    const identity = key(value);
    const current = result.get(identity);
    if (current === undefined) result.set(identity, structuredClone(value));
    else if (canonicalizeMetadata(current) !== canonicalizeMetadata(value)) throw new Error(`Duplicate ${label} identity has conflicting content.`);
  }
  return result;
}

function assertPolicy(policy: Pick<AggregationRequest, "groupBy" | "selectedAttemptPolicy" | "recurrence">): void {
  if (new Set(policy.groupBy).size !== policy.groupBy.length) throw new Error("Aggregate grouping dimensions must be unique.");
  if (!Number.isSafeInteger(policy.recurrence.minimumOccurrences) || policy.recurrence.minimumOccurrences < 2) {
    throw new Error("Aggregate recurrence minimum must be an integer of at least two.");
  }
}

function assertArtifact(label: string, value: unknown): void {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}

function attemptKey(attempt: Pick<Attempt, "runId" | "attemptId">): string {
  return `${attempt.runId}\0${attempt.attemptId}`;
}

function assertionKey(assertion: BehaviorAssertion): string {
  return `${assertion.runId}\0${assertion.attemptId}\0${assertionBindingKey(assertion)}`;
}

function assertionBindingKey(assertion: BehaviorAssertion): string {
  return bindingKey(assertion.id, `sha256:${digestMetadata(assertion).value}`);
}

function bindingKey(id: string, digest: string): string {
  return `${id}\0${digest}`;
}
