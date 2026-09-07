import { readFileSync } from "node:fs";

import {
  CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION,
  claudeAgentSdkNormalizationAdapter,
  createAgentSdkNativeEvidenceResolver,
  readQualifiedClaudeAgentSdkCapture,
  type AgentSdkNativeRecord,
} from "./agent-sdk-normalizer.js";
import { canonicalizeMetadata, digestMetadata, validateArtifact } from "./artifacts.js";
import {
  describeNormalizedDataset,
  validateNormalizedDataset,
  type NormalizedDataset,
} from "./normalization-integrity.js";
import type {
  NativeEvidenceReference,
  NativeEvidenceResolution,
  NativeEvidenceResolver,
  NormalizationInput,
} from "./uniform-events.js";

type DigestString = `sha256:${string}`;
type VersionedIdentity = { id: string; version: string };

export type BehaviorVocabulary = {
  schemaVersion: "ebo.behavior-vocabulary/v1";
  version: string;
  categories: ReadonlyArray<{
    id: string;
    name: string;
    dimensions: ReadonlyArray<{ id: string; name: string }>;
  }>;
};

export type BehaviorCitation = {
  eventId: string;
  nativeReference: NativeEvidenceReference;
};

type AssessedJudgment = {
  disposition: "assessed";
  assessment: "constructive" | "adverse" | "mixed" | "context-dependent";
  confidence: { value: number; scale: "evaluator-reported-0-to-1" };
  rationale: string;
  alternativeExplanation: string;
  citations: readonly BehaviorCitation[];
};

type AbstainedJudgment = {
  disposition: "abstained";
  reason: string;
  missingEvidenceCapability?: string;
  rationale: string;
  alternativeExplanation: string;
  citations: readonly BehaviorCitation[];
};

export type BehaviorAssertion = {
  schemaVersion: "ebo.behavior-assertion/v1";
  id: string;
  runId: string;
  attemptId: string;
  dataset: { schemaVersion: "ebo.normalized-dataset/v1"; digest: DigestString };
  behavior: { vocabularyVersion: string; categoryId: string; dimensionId: string };
  rubric: VersionedIdentity;
  evaluator: VersionedIdentity;
  judgment: AssessedJudgment | AbstainedJudgment;
};

export type BehaviorReview = {
  schemaVersion: "ebo.behavior-review/v1";
  id: string;
  assertion: { id: string; schemaVersion: "ebo.behavior-assertion/v1"; digest: DigestString };
  state: "proposed" | "confirmed" | "disputed" | "rejected" | "insufficient-evidence";
  reviewer?: { kind: "human"; id: string };
  rationale?: string;
};

export type ResolvedBehaviorCitation = BehaviorCitation & {
  resolution: NativeEvidenceResolution;
};

export type AgentSdkBehaviorEvidence = {
  capture: NormalizationInput<AgentSdkNativeRecord>;
  dataset: NormalizedDataset;
  resolver: NativeEvidenceResolver;
};

export const DEFAULT_BEHAVIOR_VOCABULARY = loadDefaultVocabulary();

export async function validateBehaviorAssertion(
  assertion: BehaviorAssertion,
  dataset: NormalizedDataset,
  resolver: NativeEvidenceResolver,
  vocabulary: BehaviorVocabulary = DEFAULT_BEHAVIOR_VOCABULARY,
): Promise<readonly ResolvedBehaviorCitation[]> {
  assertValid("behavior assertion", assertion);
  assertVocabulary(vocabulary);
  await validateNormalizedDataset(dataset, resolver);

  const datasetDigest = digest(dataset);
  if (assertion.dataset.schemaVersion !== dataset.schemaVersion || assertion.dataset.digest !== datasetDigest) {
    throw new Error("Behavior assertion normalized dataset version or digest does not match.");
  }
  if (assertion.runId !== dataset.runId || assertion.attemptId !== dataset.attemptId) {
    throw new Error("Behavior assertion belongs to the wrong run or attempt.");
  }
  if (assertion.behavior.vocabularyVersion !== vocabulary.version) {
    throw new Error("Behavior assertion uses the wrong vocabulary version.");
  }
  const category = vocabulary.categories.find(({ id }) => id === assertion.behavior.categoryId);
  if (category === undefined || !category.dimensions.some(({ id }) => id === assertion.behavior.dimensionId)) {
    throw new Error("Behavior assertion does not identify one declared behavior dimension.");
  }

  const eventIds = new Set<string>();
  const events = new Map(dataset.events.map((event) => [event.id, event]));
  const records = new Map(dataset.nativeRecords.map((record) => [referenceKey(record.reference), record]));
  const resolved: ResolvedBehaviorCitation[] = [];
  for (const citation of assertion.judgment.citations) {
    if (eventIds.has(citation.eventId)) throw new Error(`Behavior assertion cites event "${citation.eventId}" more than once.`);
    eventIds.add(citation.eventId);
    const event = events.get(citation.eventId);
    if (event === undefined) throw new Error(`Behavior assertion cites unknown normalized event "${citation.eventId}".`);
    if (referenceKey(citation.nativeReference) !== referenceKey(event.source.nativeReference)) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" does not match its native source.`);
    }
    const nativeRecord = records.get(referenceKey(citation.nativeReference));
    if (nativeRecord === undefined) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" has no captured native record.`);
    }
    const resolution = await resolver.resolve(citation.nativeReference);
    if (typeof resolution !== "object" || resolution.runId !== dataset.runId
        || resolution.attemptId !== dataset.attemptId || resolution.digest !== nativeRecord.digest) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" is stale or belongs to another attempt.`);
    }
    resolved.push({ ...structuredClone(citation), resolution });
  }
  return resolved;
}

export function validateBehaviorReview(assertion: BehaviorAssertion, review: BehaviorReview): void {
  assertValid("behavior assertion", assertion);
  assertValid("behavior review", review);
  if (review.assertion.id !== assertion.id || review.assertion.schemaVersion !== assertion.schemaVersion
      || review.assertion.digest !== digest(assertion)) {
    throw new Error("Behavior review assertion identity or digest does not match.");
  }
}

export async function isConfirmedBehaviorAssertion(
  assertion: BehaviorAssertion,
  dataset: NormalizedDataset,
  resolver: NativeEvidenceResolver,
  review?: BehaviorReview,
  vocabulary: BehaviorVocabulary = DEFAULT_BEHAVIOR_VOCABULARY,
): Promise<boolean> {
  await validateBehaviorAssertion(assertion, dataset, resolver, vocabulary);
  if (review === undefined) return false;
  validateBehaviorReview(assertion, review);
  return assertion.judgment.disposition === "assessed" && review.state === "confirmed";
}

export async function validateAgentSdkBehaviorAssertion(
  bundleRoot: string,
  assertion: BehaviorAssertion,
  review?: BehaviorReview,
): Promise<readonly ResolvedBehaviorCitation[]> {
  const { dataset, resolver } = await createAgentSdkBehaviorEvidence(bundleRoot);
  const citations = await validateBehaviorAssertion(assertion, dataset, resolver);
  if (review !== undefined) validateBehaviorReview(assertion, review);
  return citations;
}

export async function createAgentSdkBehaviorEvidence(bundleRoot: string): Promise<AgentSdkBehaviorEvidence> {
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
  const resolver = createAgentSdkNativeEvidenceResolver(capture);
  await validateNormalizedDataset(dataset, resolver);
  return { capture, dataset, resolver };
}

function assertVocabulary(vocabulary: BehaviorVocabulary): void {
  assertValid("behavior vocabulary", vocabulary);
  const categoryIds = vocabulary.categories.map(({ id }) => id);
  if (new Set(categoryIds).size !== categoryIds.length) throw new Error("Behavior vocabulary category IDs must be unique.");
  for (const category of vocabulary.categories) {
    const dimensionIds = category.dimensions.map(({ id }) => id);
    if (new Set(dimensionIds).size !== dimensionIds.length) {
      throw new Error(`Behavior vocabulary dimension IDs in category "${category.id}" must be unique.`);
    }
  }
}

function loadDefaultVocabulary(): BehaviorVocabulary {
  const vocabulary = JSON.parse(readFileSync(
    new URL("../../ontology/behavior-categories.v1.json", import.meta.url),
    "utf8",
  )) as BehaviorVocabulary;
  assertVocabulary(vocabulary);
  return vocabulary;
}

function digest(value: unknown): DigestString {
  return `sha256:${digestMetadata(value).value}`;
}

function referenceKey(reference: NativeEvidenceReference): string {
  return canonicalizeMetadata(reference);
}

function assertValid(label: string, value: unknown): void {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}

function agentSdkNativeType(record: AgentSdkNativeRecord): string {
  const document = asRecord(record.document);
  if (record.kind === "session") return text(document?.nativeType) ?? "session";
  if (record.kind === "hook") return text(document?.hook) ?? "hook";
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
): DigestString | undefined {
  for (const { record } of capture.records) {
    if (record.kind !== "workspace" && record.kind !== "diagnostic") continue;
    const descriptor = asRecord(record.document);
    if (descriptor?.id === reference.artifactId && typeof descriptor.digest === "string"
        && /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)) return descriptor.digest as DigestString;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
