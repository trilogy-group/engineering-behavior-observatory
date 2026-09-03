import { canonicalizeMetadata, digestMetadata, validateArtifact } from "./artifacts.js";
import type { Digest } from "./contracts.js";
import {
  UNIFORM_EVENT_FAMILIES,
  validateUniformEvents,
  type AdapterCapability,
  type AdapterCapabilityProfile,
  type NativeEvidenceReference,
  type NativeEvidenceResolution,
  type NativeEvidenceResolver,
  type NormalizationInput,
  type NormalizationResult,
  type UniformEventFamily,
} from "./uniform-events.js";

type DigestString = `sha256:${string}`;

export type NormalizedNativeRecord = {
  reference: NativeEvidenceReference;
  nativeType: string;
  digest: DigestString;
};

export type NormalizedDataset = NormalizationResult & {
  schemaVersion: "ebo.normalized-dataset/v1";
  runId: string;
  attemptId: string;
  adapter: {
    id: string;
    version: string;
    harness: string;
  };
  capabilityProfile: AdapterCapabilityProfile;
  nativeRecords: readonly NormalizedNativeRecord[];
};

export type AdapterCoverageReport = {
  schemaVersion: "ebo.adapter-coverage-report/v1";
  runId: string;
  attemptId: string;
  adapter: NormalizedDataset["adapter"];
  records: { total: number; mapped: number; unmapped: number };
  nativeTypes: ReadonlyArray<{
    nativeType: string;
    total: number;
    mapped: number;
    unmapped: number;
  }>;
  families: Record<UniformEventFamily, {
    capability: AdapterCapability;
    observedEvents: number;
  }>;
  evidence: AdapterCapabilityProfile["evidence"];
};

export type NormalizedDatasetInput<NativeRecord> = {
  capture: NormalizationInput<NativeRecord>;
  normalization: NormalizationResult;
  capabilityProfile: AdapterCapabilityProfile;
  adapterVersion: string;
  nativeType(record: NativeRecord): string;
};

export type ComparisonCapability = `family:${UniformEventFamily}`
  | `evidence:${keyof AdapterCapabilityProfile["evidence"]}`;

export type ComparisonCandidate = {
  id: string;
  task: { id: string; digest: DigestString };
  fixture: { id: string; digest: DigestString };
  model: { id: string; configurationDigest: DigestString };
  harness: { id: string; version: string; configurationDigest: DigestString };
  assessmentMode: "observational" | "verified";
  captureProfileDigest: DigestString;
  budgetDigest: DigestString;
  toolPolicyDigest: DigestString;
  capabilityProfile: AdapterCapabilityProfile;
};

export type ComparisonRequest = {
  schemaVersion: "ebo.comparison-request/v1";
  left: ComparisonCandidate;
  right: ComparisonCandidate;
  policy: {
    declaredDifferences: ReadonlyArray<"model" | "harness">;
    requiredCapabilities: readonly ComparisonCapability[];
  };
};

export type ComparisonReason = {
  code:
    | "task-mismatch"
    | "fixture-mismatch"
    | "material-configuration-mismatch"
    | "undeclared-model-difference"
    | "declared-model-difference"
    | "undeclared-harness-difference"
    | "declared-harness-difference"
    | "capability-unsupported"
    | "capability-partial";
  dimension: string;
  detail: string;
};

export type ComparisonReport = {
  schemaVersion: "ebo.comparison-report/v1";
  status: "supported" | "qualified-with-caveats" | "unsupported";
  candidates: [string, string];
  reasons: readonly ComparisonReason[];
};

export function describeNormalizedDataset<NativeRecord>(
  input: NormalizedDatasetInput<NativeRecord>,
): NormalizedDataset {
  return {
    schemaVersion: "ebo.normalized-dataset/v1",
    runId: input.capture.runId,
    attemptId: input.capture.attemptId,
    adapter: {
      id: input.capabilityProfile.adapterId,
      version: required(input.adapterVersion, "Adapter version"),
      harness: input.capabilityProfile.harness,
    },
    capabilityProfile: structuredClone(input.capabilityProfile),
    nativeRecords: input.capture.records.map(({ reference, record }) => ({
      reference: structuredClone(reference),
      nativeType: required(input.nativeType(record), "Native record type"),
      digest: digestString(digestMetadata(record)),
    })),
    events: structuredClone(input.normalization.events),
    unmapped: structuredClone(input.normalization.unmapped),
  };
}

export function createCapturedNativeEvidenceResolver<NativeRecord>(
  capture: NormalizationInput<NativeRecord>,
  fallback?: NativeEvidenceResolver,
): NativeEvidenceResolver {
  const records = new Map(capture.records.map(({ reference, record }) => [
    referenceKey(reference),
    {
      runId: capture.runId,
      attemptId: capture.attemptId,
      digest: digestString(digestMetadata(record)),
    } satisfies NativeEvidenceResolution,
  ]));
  return {
    async resolve(reference) {
      const exact = records.get(referenceKey(reference));
      if (exact !== undefined) return exact;
      const pointer = reference.recordLocator.indexOf("#");
      const containingRecord = pointer > 0
        ? records.get(referenceKey({ ...reference, recordLocator: reference.recordLocator.slice(0, pointer) }))
        : undefined;
      return containingRecord ?? await fallback?.resolve(reference) ?? false;
    },
  };
}

export async function validateNormalizedDataset(
  dataset: NormalizedDataset,
  resolver: NativeEvidenceResolver,
): Promise<AdapterCoverageReport> {
  assertValidArtifact("normalized dataset", dataset);
  if (dataset.adapter.id !== dataset.capabilityProfile.adapterId
      || dataset.adapter.harness !== dataset.capabilityProfile.harness) {
    throw new Error("Normalized dataset adapter identity does not match its capability profile.");
  }

  const recordByReference = new Map<string, NormalizedNativeRecord>();
  for (const record of dataset.nativeRecords) {
    const key = referenceKey(record.reference);
    if (recordByReference.has(key)) throw new Error("Normalized dataset contains duplicate native records.");
    recordByReference.set(key, record);
    const resolution = await resolver.resolve(record.reference);
    if (resolution === false) throw unresolved(record.reference);
    if (typeof resolution === "boolean") {
      throw new Error(`Native evidence reference ${formatReference(record.reference)} lacks run and digest integrity metadata.`);
    }
    assertResolution(dataset, record, resolution);
  }

  await validateUniformEvents(dataset.events, resolver);
  const mapped = new Set<string>();
  for (const event of dataset.events) {
    if (event.runId !== dataset.runId || event.attemptId !== dataset.attemptId) {
      throw new Error(`Uniform event "${event.id}" belongs to the wrong run or attempt.`);
    }
    if (event.source.harness !== dataset.adapter.harness) {
      throw new Error(`Uniform event "${event.id}" belongs to the wrong harness.`);
    }
    const key = referenceKey(event.source.nativeReference);
    const record = recordByReference.get(key);
    if (record === undefined) throw new Error(`Uniform event "${event.id}" does not identify a captured native record.`);
    if (record.nativeType !== event.source.nativeType) {
      throw new Error(`Uniform event "${event.id}" native type does not match its captured record.`);
    }
    if (!dataset.capabilityProfile.nativeTypes.includes(event.source.nativeType)) {
      throw new Error(`Uniform event "${event.id}" uses undeclared native type "${event.source.nativeType}".`);
    }
    if (dataset.capabilityProfile.families[event.family].status === "unsupported") {
      throw new Error(`Uniform event "${event.id}" uses unsupported event family "${event.family}".`);
    }
    assertEvidenceCapability(dataset.capabilityProfile.evidence.nativeOrder, event.nativeOrder.status, "nativeOrder");
    assertEvidenceCapability(dataset.capabilityProfile.evidence.nativeTime, event.nativeTime.status, "nativeTime");
    assertEvidenceCapability(dataset.capabilityProfile.evidence.parentage, event.relations.parent.status, "parentage");
    assertEvidenceCapability(dataset.capabilityProfile.evidence.content, event.content.status, "content");
    if (dataset.capabilityProfile.evidence.parentage.status === "unsupported" && event.relations.known.length > 0) {
      throw new Error(`Uniform event "${event.id}" contradicts unsupported parentage.`);
    }
    mapped.add(key);
  }
  assertSourceLocalOrder(dataset);

  const unmapped = new Set<string>();
  for (const entry of dataset.unmapped) {
    const key = referenceKey(entry.reference);
    if (unmapped.has(key)) throw new Error("Normalized dataset lists a native record as unmapped more than once.");
    if (!recordByReference.has(key)) throw new Error("Normalized dataset lists an uncaptured native record as unmapped.");
    unmapped.add(key);
  }
  for (const key of recordByReference.keys()) {
    if (mapped.has(key) === unmapped.has(key)) {
      throw new Error("Every native record must be mapped or explicitly retained as unmapped.");
    }
  }

  return coverageReport(dataset, mapped, unmapped);
}

export async function validateNormalizedCorpus(
  entries: ReadonlyArray<{ dataset: NormalizedDataset; resolver: NativeEvidenceResolver }>,
): Promise<readonly AdapterCoverageReport[]> {
  const attempts = new Set<string>();
  const events = new Set<string>();
  const reports: AdapterCoverageReport[] = [];
  for (const { dataset, resolver } of entries) {
    if (attempts.has(dataset.attemptId)) throw new Error(`Normalized corpus contains duplicate attempt ID "${dataset.attemptId}".`);
    attempts.add(dataset.attemptId);
    for (const event of dataset.events) {
      if (events.has(event.id)) throw new Error(`Normalized corpus contains duplicate event ID "${event.id}".`);
      events.add(event.id);
    }
    reports.push(await validateNormalizedDataset(dataset, resolver));
  }
  return reports;
}

export function assessComparisonEligibility(request: ComparisonRequest): ComparisonReport {
  assertValidArtifact("comparison request", request);
  for (const candidate of [request.left, request.right]) {
    if (candidate.capabilityProfile.harness !== candidate.harness.id) {
      throw new Error(`Comparison candidate "${candidate.id}" harness does not match its capability profile.`);
    }
  }
  const blockers: ComparisonReason[] = [];
  const caveats: ComparisonReason[] = [];
  compareExact(request.left.task, request.right.task, "task", "task-mismatch", blockers);
  compareExact(request.left.fixture, request.right.fixture, "fixture", "fixture-mismatch", blockers);
  for (const [dimension, left, right] of [
    ["assessment mode", request.left.assessmentMode, request.right.assessmentMode],
    ["capture profile", request.left.captureProfileDigest, request.right.captureProfileDigest],
    ["budget", request.left.budgetDigest, request.right.budgetDigest],
    ["tool policy", request.left.toolPolicyDigest, request.right.toolPolicyDigest],
  ] as const) {
    if (left !== right) blockers.push({
      code: "material-configuration-mismatch",
      dimension,
      detail: `${dimension} differs between the proposed comparison candidates.`,
    });
  }
  compareDeclaredCondition("model", request.left.model, request.right.model, request.policy.declaredDifferences, blockers, caveats);
  compareDeclaredCondition("harness", request.left.harness, request.right.harness, request.policy.declaredDifferences, blockers, caveats);
  for (const capability of request.policy.requiredCapabilities) {
    for (const candidate of [request.left, request.right]) {
      const value = candidateCapability(candidate, capability);
      if (value.status === "unsupported") blockers.push({
        code: "capability-unsupported",
        dimension: capability,
        detail: `${candidate.id} does not support required capability ${capability}.`,
      });
      else if (value.status === "partial") caveats.push({
        code: "capability-partial",
        dimension: capability,
        detail: `${candidate.id} only partially supports required capability ${capability}.`,
      });
    }
  }
  const reasons = [...blockers, ...caveats];
  const report: ComparisonReport = {
    schemaVersion: "ebo.comparison-report/v1",
    status: blockers.length > 0 ? "unsupported" : caveats.length > 0 ? "qualified-with-caveats" : "supported",
    candidates: [request.left.id, request.right.id],
    reasons,
  };
  assertValidArtifact("comparison report", report);
  return report;
}

function coverageReport(
  dataset: NormalizedDataset,
  mapped: ReadonlySet<string>,
  unmapped: ReadonlySet<string>,
): AdapterCoverageReport {
  const nativeTypes = new Map<string, { total: number; mapped: number; unmapped: number }>();
  for (const record of dataset.nativeRecords) {
    const counts = nativeTypes.get(record.nativeType) ?? { total: 0, mapped: 0, unmapped: 0 };
    counts.total += 1;
    if (mapped.has(referenceKey(record.reference))) counts.mapped += 1;
    else counts.unmapped += 1;
    nativeTypes.set(record.nativeType, counts);
  }
  const report: AdapterCoverageReport = {
    schemaVersion: "ebo.adapter-coverage-report/v1",
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    adapter: structuredClone(dataset.adapter),
    records: { total: dataset.nativeRecords.length, mapped: mapped.size, unmapped: unmapped.size },
    nativeTypes: [...nativeTypes].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([nativeType, counts]) => ({ nativeType, ...counts })),
    families: Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family, {
      capability: structuredClone(dataset.capabilityProfile.families[family]),
      observedEvents: dataset.events.filter((event) => event.family === family).length,
    }])) as AdapterCoverageReport["families"],
    evidence: structuredClone(dataset.capabilityProfile.evidence),
  };
  assertValidArtifact("adapter coverage report", report);
  return report;
}

function assertResolution(
  dataset: NormalizedDataset,
  record: NormalizedNativeRecord,
  resolution: NativeEvidenceResolution,
): void {
  if (resolution.runId !== dataset.runId || resolution.attemptId !== dataset.attemptId) {
    throw new Error(`Native evidence reference ${formatReference(record.reference)} resolves to the wrong run or attempt.`);
  }
  if (resolution.digest !== record.digest) {
    throw new Error(`Native evidence reference ${formatReference(record.reference)} has a digest mismatch.`);
  }
}

function assertSourceLocalOrder(dataset: NormalizedDataset): void {
  const last = new Map<string, number>();
  for (const event of dataset.events) {
    if (event.nativeOrder.status !== "known") continue;
    const previous = last.get(event.nativeOrder.domain);
    if (previous !== undefined && event.nativeOrder.value < previous) {
      throw new Error(`Uniform event "${event.id}" violates source-local order domain "${event.nativeOrder.domain}".`);
    }
    last.set(event.nativeOrder.domain, event.nativeOrder.value);
  }
}

function compareExact(
  left: unknown,
  right: unknown,
  dimension: string,
  code: "task-mismatch" | "fixture-mismatch",
  blockers: ComparisonReason[],
): void {
  if (canonicalizeMetadata(left) !== canonicalizeMetadata(right)) blockers.push({
    code,
    dimension,
    detail: `${dimension} identity or digest differs between the proposed comparison candidates.`,
  });
}

function compareDeclaredCondition(
  dimension: "model" | "harness",
  left: unknown,
  right: unknown,
  declared: readonly ("model" | "harness")[],
  blockers: ComparisonReason[],
  caveats: ComparisonReason[],
): void {
  if (canonicalizeMetadata(left) === canonicalizeMetadata(right)) return;
  if (!declared.includes(dimension)) {
    blockers.push({
      code: dimension === "model" ? "undeclared-model-difference" : "undeclared-harness-difference",
      dimension,
      detail: `${dimension} differs but is not declared by the comparison policy.`,
    });
    return;
  }
  caveats.push({
    code: dimension === "model" ? "declared-model-difference" : "declared-harness-difference",
    dimension,
    detail: `${dimension} differs as declared; results are qualified and do not establish causality.`,
  });
}

function candidateCapability(candidate: ComparisonCandidate, capability: ComparisonCapability): AdapterCapability {
  const [kind, name] = capability.split(":") as ["family" | "evidence", string];
  return kind === "family"
    ? candidate.capabilityProfile.families[name as UniformEventFamily]
    : candidate.capabilityProfile.evidence[name as keyof AdapterCapabilityProfile["evidence"]];
}

function assertEvidenceCapability(
  capability: AdapterCapability,
  evidenceStatus: "known" | "unknown" | "unsupported",
  field: string,
): void {
  if ((capability.status === "unsupported") !== (evidenceStatus === "unsupported")
      && capability.status !== "partial") {
    throw new Error(`Adapter evidence capability contradicts event ${field}.`);
  }
}

function assertValidArtifact(label: string, value: unknown): void {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}

function digestString(digest: Digest): DigestString {
  return `${digest.algorithm}:${digest.value}`;
}

function required(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} is required.`);
  return value;
}

function referenceKey(reference: NativeEvidenceReference): string {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}

function formatReference(reference: NativeEvidenceReference): string {
  return `${reference.artifactId}:${reference.recordLocator}`;
}

function unresolved(reference: NativeEvidenceReference): Error {
  return new Error(`Native evidence reference ${formatReference(reference)} is unresolved.`);
}
