import { canonicalizeMetadata, digestMetadata } from "./artifacts.js";
import { validateOccurrenceRatings, type OccurrenceRatings } from "./occurrence-ratings.js";
import { OCCURRENCE_TYPES, type Occurrence, type OccurrenceType } from "./occurrences.js";
import { createRetainedBehaviorEvidence } from "./retained-evidence.js";
import type { SemanticJudgeRequest } from "./semantic-judge.js";
import { createStructuralObservationSet, type StructuralObservationSet } from "./structural-observations.js";
import type { UniformEvent } from "./uniform-events.js";

/**
 * `ebo judge prepare`: build a semantic judge request from an observation set by a fixed, recorded policy. Every
 * occurrence of the requested types enters the input as a ledger row (with its ratings, when supplied); full native
 * records are chosen in priority tiers until `limits.maxEvidenceItems` events, never splitting an occurrence.
 */
export type JudgePrepareSpec = {
  schemaVersion: "ebo.judge-prepare-spec/v1";
  id: string;
  behavior: SemanticJudgeRequest["behavior"];
  rubric: SemanticJudgeRequest["rubric"];
  evaluator: SemanticJudgeRequest["evaluator"];
  limits: SemanticJudgeRequest["limits"];
  blinding: SemanticJudgeRequest["blinding"];
  occurrenceTypes: readonly OccurrenceType[];
  includeOutcomeObservations?: boolean;
};

export const JUDGE_PREPARE_METHOD = "ebo.judge-prepare/v1: ledger rows for every occurrence of the selected types; "
  + "full records in tiers until maxEvidenceItems events, whole occurrences only: (1) first user message and last two "
  + "model messages, (2) failure responses, failed validation runs and low-confidence or adverse ratings, (3) the last "
  + "validation run of each check kind, (4) evenly spaced remaining occurrences of the selected types.";

const ADVERSE_LABELS = new Set(["retried-unchanged", "some-failed", "not-completed", "no-response", "redundant"]);

export function prepareJudgeRequest(
  observations: StructuralObservationSet,
  events: readonly UniformEvent[],
  spec: JudgePrepareSpec,
  ratings?: OccurrenceRatings,
): SemanticJudgeRequest {
  if (spec.schemaVersion !== "ebo.judge-prepare-spec/v1") throw new Error("Judge prepare spec schemaVersion is unsupported.");
  if (spec.occurrenceTypes.length === 0 || spec.occurrenceTypes.some((type) => !OCCURRENCE_TYPES.includes(type))) {
    throw new Error("Judge prepare spec needs known occurrence types.");
  }
  if (observations.occurrences === undefined || observations.occurrenceCoverage === undefined) {
    throw new Error("Judge prepare needs an observation set with occurrences (extractor 1.1.0 or later).");
  }
  if (ratings !== undefined) {
    validateOccurrenceRatings(ratings);
    if (ratings.observationSetDigest !== `sha256:${digestMetadata(observations).value}`) throw new Error("Occurrence ratings belong to another observation set.");
  }
  // Unavailable types stay in the request and its frame with their reason: unsupported evidence is not absence.
  const types = [...spec.occurrenceTypes];
  const unavailable = new Map(observations.occurrenceCoverage.flatMap((entry) => entry.status === "unavailable" ? [[entry.type, entry.reason] as const] : []));
  const population = observations.occurrences.filter(({ type }) => types.includes(type));
  const budget = spec.limits.maxEvidenceItems;
  const selected = new Set<string>();
  const full = new Set<string>();
  const take = (eventIds: readonly string[]) => {
    const fresh = eventIds.filter((id) => !selected.has(id));
    if (selected.size + fresh.length > budget) return false;
    for (const id of fresh) selected.add(id);
    return true;
  };
  const takeOccurrence = (occurrence: Occurrence) => {
    if (full.has(occurrence.id)) return;
    if (take(occurrence.eventIds)) full.add(occurrence.id);
  };

  // Tier 1: the task as given and the final report.
  const messages = events.filter(({ family }) => family === "message");
  const firstUser = messages.find(({ actor }) => actor.kind === "user");
  const modelMessages = messages.filter(({ actor }) => actor.kind === "model");
  for (const event of [firstUser, ...modelMessages.slice(-2)]) if (event !== undefined) take([event.id]);

  // Tier 2: failures and what ratings mark as adverse or uncertain.
  // The effective rating per question: a fallback answer replaces the deferred model answer it resolves.
  const effective = new Map<string, Map<string, OccurrenceRatings["ratings"][number]>>();
  for (const rating of ratings?.ratings ?? []) {
    const questions = effective.get(rating.occurrenceId) ?? new Map();
    if (rating.source === "fallback" || !questions.has(rating.questionId)) questions.set(rating.questionId, rating);
    effective.set(rating.occurrenceId, questions);
  }
  const flagged = (occurrence: Occurrence) => occurrence.type === "failure-response"
    || occurrence.type === "validation-run" && occurrence.attributes.result === "failed"
    || [...effective.get(occurrence.id)?.values() ?? []].some(({ accepted, label }) => !accepted || ADVERSE_LABELS.has(label));
  for (const occurrence of population.filter(flagged)) takeOccurrence(occurrence);

  // Tier 3: the final validation of each check kind.
  const lastByKind = new Map<string, Occurrence>();
  for (const occurrence of population.filter(({ type }) => type === "validation-run")) {
    const kinds = Array.isArray(occurrence.attributes.checkKinds) ? occurrence.attributes.checkKinds.map(String) : ["unknown"];
    for (const kind of kinds) lastByKind.set(kind, occurrence);
  }
  for (const occurrence of new Set(lastByKind.values())) takeOccurrence(occurrence);

  // Tier 4: evenly spaced remaining occurrences, in order.
  const remaining = population.filter(({ id }) => !full.has(id));
  for (const index of spread(remaining.length)) takeOccurrence(remaining[index]!);

  const order = new Map(events.map(({ id }, index) => [id, index]));
  const eventIds = [...selected].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  const ratingsDigest = ratings === undefined ? undefined : `sha256:${digestMetadata(ratings).value}` as const;
  return {
    schemaVersion: "ebo.semantic-judge-request/v1",
    id: spec.id,
    behavior: structuredClone(spec.behavior),
    rubric: structuredClone(spec.rubric),
    evaluator: structuredClone(spec.evaluator),
    selection: {
      eventIds,
      structuralObservationIds: [],
      includeOutcomeObservations: spec.includeOutcomeObservations ?? false,
      occurrences: { types, ...(ratingsDigest === undefined ? {} : { ratingsDigest }) },
      frame: {
        method: JUDGE_PREPARE_METHOD,
        strata: types.map((type) => {
          const members = population.filter((occurrence) => occurrence.type === type);
          const reason = unavailable.get(type);
          return { type, population: members.length, ledgerRows: members.length, fullRecords: members.filter(({ id }) => full.has(id)).length,
            ...(reason === undefined ? {} : { unavailable: reason.slice(0, 1024) }) };
        }),
      },
    },
    limits: structuredClone(spec.limits),
    blinding: structuredClone(spec.blinding),
  };
}

/** Indices of `count` items visited evenly: first, last, then repeated midpoints. */
function spread(count: number): number[] {
  if (count === 0) return [];
  const order: number[] = [0];
  if (count > 1) order.push(count - 1);
  const seen = new Set(order);
  let step = count;
  while (order.length < count) {
    step /= 2;
    for (let position = step; position < count; position += step * 2) {
      const index = Math.floor(position);
      if (!seen.has(index)) { seen.add(index); order.push(index); }
    }
    if (step < 0.5) for (let index = 0; index < count; index += 1) if (!seen.has(index)) { seen.add(index); order.push(index); }
  }
  return order;
}

/** Prepare a request for a retained bundle; the observation set must equal the one rebuilt from the bundle. */
export async function prepareRetainedJudgeRequest(
  bundleRoot: string,
  observations: StructuralObservationSet,
  spec: JudgePrepareSpec,
  ratings?: OccurrenceRatings,
): Promise<SemanticJudgeRequest> {
  const { outcomeCapture, dataset, coverage } = await createRetainedBehaviorEvidence(bundleRoot);
  const rebuilt = createStructuralObservationSet(dataset, coverage, outcomeCapture);
  if (canonicalizeMetadata(rebuilt) !== canonicalizeMetadata(observations)) {
    throw new Error(`Structural observation set for attempt "${observations.attemptId}" is stale; recreate it before preparing.`);
  }
  return prepareJudgeRequest(rebuilt, dataset.events, spec, ratings);
}
