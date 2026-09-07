import { createHash } from "node:crypto";

import {
  claudeAgentSdkNormalizationAdapter,
  createAgentSdkNativeEvidenceResolver,
  readQualifiedClaudeAgentSdkCapture,
  type AgentSdkNativeRecord,
} from "./agent-sdk-normalizer.js";
import { canonicalizeMetadata, digestMetadata, validateArtifact } from "./artifacts.js";
import {
  describeNormalizedDataset,
  validateNormalizedDataset,
  type AdapterCoverageReport,
  type NormalizedDataset,
} from "./normalization-integrity.js";
import type {
  AdapterCapability,
  NativeEvidenceReference,
  NativeEvidenceResolver,
  NormalizationInput,
  UniformEvent,
  UniformEventFamily,
} from "./uniform-events.js";

export const STRUCTURAL_EXTRACTOR_VERSION = "1.0.0";
export const CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION = "1.0.0";

type RequiredCapability = `family:${UniformEventFamily}` | "evidence:nativeOrder";
type KnownValue = { status: "known"; value: string | number | boolean; unit: string };
type UnavailableValue = { status: "unavailable"; reason: string };

export type StructuralObservation = {
  schemaVersion: "ebo.structural-observation/v1";
  id: string;
  runId: string;
  attemptId: string;
  extractor: {
    id: string;
    version: typeof STRUCTURAL_EXTRACTOR_VERSION;
    requiredCapabilities: readonly RequiredCapability[];
  };
  definition: string;
  denominator: { scope: "attempt"; id: string; value: 1; unit: "attempt" };
  value: KnownValue | UnavailableValue;
  sourceEventIds: readonly string[];
  sourceRecordCount: number;
  citations: readonly NativeEvidenceReference[];
};

export type StructuralObservationSet = {
  schemaVersion: "ebo.structural-observation-set/v1";
  runId: string;
  attemptId: string;
  assessmentMode: "observational" | "verified" | "unknown";
  extractorVersion: typeof STRUCTURAL_EXTRACTOR_VERSION;
  normalization: {
    datasetDigest: `sha256:${string}`;
    adapter: NormalizedDataset["adapter"];
    coverage: AdapterCoverageReport;
  };
  observations: readonly StructuralObservation[];
};

type ExtractorRegistration = { id: string; requiredCapabilities: readonly RequiredCapability[]; definition: string };

export const STRUCTURAL_EXTRACTOR_REGISTRY = [
  registry("model-request-count", ["family:model-request"], "Distinct source-native inference requests observed in the attempt."),
  registry("tool-operation-count", ["family:tool"], "Distinct logical tool operations, deduplicated by source-native operation identity."),
  registry("tool-native-record-count", ["family:tool"], "Native records carrying mapped or explicitly unprojectable tool evidence."),
  registry("unidentified-tool-native-record-count", ["family:tool"], "Native tool-family records without a resolvable source-native operation identity."),
  registry("tool-error-count", ["family:tool"], "Distinct logical tool operations with an explicit native failure result."),
  registry("repeated-tool-operation-count", ["family:tool"], "Distinct logical tool operations beyond the first with the same explicit tool identity and input digest."),
  registry("failure-followed-by-same-tool-count", ["family:tool", "evidence:nativeOrder"], "Failed logical tool operations followed by a distinct operation of the same tool in the same native-order domain."),
  registry("failure-followed-by-alternate-tool-count", ["family:tool", "evidence:nativeOrder"], "Failed logical tool operations followed by a distinct operation of another tool in the same native-order domain."),
  registry("validation-after-last-mutation", ["family:artifact", "family:validation", "evidence:nativeOrder"], "Whether an explicitly identified validation occurs after the last explicitly identified mutation in one native-order domain."),
  registry("compaction-boundary-record-count", ["family:context"], "Native records that explicitly identify a compaction boundary."),
  registry("input-token-count", ["family:runtime"], "Native-reported input-token total without combining cumulative snapshots or telemetry sources."),
  registry("output-token-count", ["family:runtime"], "Native-reported output-token total without combining cumulative snapshots or telemetry sources."),
  registry("cache-read-input-token-count", ["family:runtime"], "Native-reported cache-read input-token total."),
  registry("cache-creation-input-token-count", ["family:runtime"], "Native-reported cache-creation input-token total."),
  registry("total-token-count", ["family:runtime"], "Native-reported total-token total; component categories are not added to reconstruct it."),
  registry("total-cost-usd", ["family:runtime"], "Native-reported attempt cost in US dollars; subscription utilization is not inferred."),
  registry("attempt-latency-ms", ["family:outcome"], "Native-reported end-to-end attempt duration in milliseconds."),
] as const satisfies readonly ExtractorRegistration[];
type ToolOperation = {
  id: string;
  events: UniformEvent[];
  toolName?: string;
  inputDigest?: string;
  failed: boolean;
};

export async function createAgentSdkStructuralObservationSet(bundleRoot: string): Promise<StructuralObservationSet> {
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
  const coverage = await validateNormalizedDataset(dataset, resolver);
  const result = createStructuralObservationSet(dataset, coverage, capture);
  await validateStructuralObservationSet(result, resolver);
  return result;
}

export function createStructuralObservationSet(
  dataset: NormalizedDataset,
  coverage: AdapterCoverageReport,
  nativeCapture?: NormalizationInput<AgentSdkNativeRecord>,
): StructuralObservationSet {
  if (coverage.runId !== dataset.runId || coverage.attemptId !== dataset.attemptId
      || canonicalizeMetadata(coverage.adapter) !== canonicalizeMetadata(dataset.adapter)) {
    throw new Error("Structural observation coverage does not match the normalized dataset.");
  }
  const assessmentMode = importAssessmentMode(dataset, nativeCapture);
  const observations = [
    ...importOutcomes(dataset, nativeCapture, assessmentMode),
    ...extractStructuralFacts(dataset),
  ];
  return {
    schemaVersion: "ebo.structural-observation-set/v1",
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    assessmentMode,
    extractorVersion: STRUCTURAL_EXTRACTOR_VERSION,
    normalization: {
      datasetDigest: `sha256:${digestMetadata(dataset).value}`,
      adapter: structuredClone(dataset.adapter),
      coverage: structuredClone(coverage),
    },
    observations,
  };
}

export async function validateStructuralObservationSet(
  report: StructuralObservationSet,
  resolver: NativeEvidenceResolver,
): Promise<void> {
  const errors = validateArtifact("structural observations", report);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  const ids = new Set<string>();
  for (const observation of report.observations) {
    if (ids.has(observation.id)) throw new Error(`Duplicate structural observation ID "${observation.id}".`);
    ids.add(observation.id);
    if (observation.runId !== report.runId || observation.attemptId !== report.attemptId) {
      throw new Error(`Structural observation "${observation.id}" belongs to another run or attempt.`);
    }
    if (observation.denominator.id !== report.attemptId) {
      throw new Error(`Structural observation "${observation.id}" has the wrong attempt denominator.`);
    }
    if (observation.sourceRecordCount !== observation.citations.length) {
      throw new Error(`Structural observation "${observation.id}" source-record count does not match its citations.`);
    }
    for (const citation of observation.citations) {
      const resolution = await resolver.resolve(citation);
      if (typeof resolution !== "object" || resolution.runId !== report.runId || resolution.attemptId !== report.attemptId) {
        throw new Error(`Structural observation "${observation.id}" has an unresolved native citation.`);
      }
    }
  }
}

function extractStructuralFacts(dataset: NormalizedDataset): StructuralObservation[] {
  const operations = toolOperations(dataset.events);
  const unprojectedToolEvidence = dataset.events.filter((event) =>
    typeof event.attributes.unprojectedToolBlockCount === "number" && event.attributes.unprojectedToolBlockCount > 0);
  const ambiguousTools = uniqueEvents([
    ...dataset.events.filter((event) => event.family === "tool" && operationId(event, dataset.events) === undefined),
    ...ambiguousActorScopedToolEvents(dataset.events),
    ...unprojectedToolEvidence,
  ]);
  const ambiguousToolFailures = ambiguousTools.filter(explicitToolFailure);
  const toolEvidence = uniqueEvents([...dataset.events.filter(({ family }) => family === "tool"), ...unprojectedToolEvidence]);
  const toolCitations = citations(toolEvidence);
  const unprojectedToolReason = unprojectedToolEvidence.length === 0 ? undefined
    : `${unprojectedToolEvidence.length} native record(s) contain unprojectable tool blocks.`;
  const modelEvents = dataset.events.filter(({ family }) => family === "model-request");
  const requests = logicalRequestCount(modelEvents);
  const failed = operations.filter(({ failed }) => failed);
  const repeated = repeatedOperations(operations);
  const followed = followedOperations(operations);
  const compactions = dataset.events.filter(isCompactionBoundary);
  return [
    countOrUnavailable(dataset, registration("model-request-count"), requests.count, citations(modelEvents), requests.reason, "requests", modelEvents),
    countOrUnavailable(dataset, registration("tool-operation-count"), operations.length, toolCitations, unprojectedToolReason, "identified-logical-tool-operations", toolEvidence),
    countOrUnavailable(dataset, registration("tool-native-record-count"), toolCitations.length, toolCitations, undefined, "native-records", toolEvidence),
    countOrUnavailable(dataset, registration("unidentified-tool-native-record-count"), citations(ambiguousTools).length, citations(ambiguousTools), undefined, "native-records", ambiguousTools),
    countOrUnavailable(dataset, registration("tool-error-count"), failed.length, citations(failed.flatMap(({ events }) => events)), unprojectedToolReason
      ?? (ambiguousToolFailures.length > 0 ? "Tool failure totals are unavailable because a failure record has ambiguous operation identity." : undefined), "logical-tool-operations", failed.flatMap(({ events }) => events)),
    countOrUnavailable(dataset, registration("repeated-tool-operation-count"), repeated.count, repeated.citations, unprojectedToolReason ?? repeated.reason, "logical-tool-operations", repeated.events),
    countOrUnavailable(dataset, registration("failure-followed-by-same-tool-count"), followed.same, followed.citations, unprojectedToolReason ?? followed.reason, "failed-logical-tool-operations", followed.events),
    countOrUnavailable(dataset, registration("failure-followed-by-alternate-tool-count"), followed.alternate, followed.citations, unprojectedToolReason ?? followed.reason, "failed-logical-tool-operations", followed.events),
    validationAfterMutation(dataset),
    countOrUnavailable(dataset, registration("compaction-boundary-record-count"), compactions.length, citations(compactions), undefined, "native-records", compactions),
    resourceObservation(dataset, "input-token-count", ["inputTokens"], "tokens"),
    resourceObservation(dataset, "output-token-count", ["outputTokens"], "tokens"),
    resourceObservation(dataset, "cache-read-input-token-count", ["cacheReadInputTokens", "cachedInputTokens"], "tokens"),
    resourceObservation(dataset, "cache-creation-input-token-count", ["cacheCreationInputTokens", "cacheWriteInputTokens"], "tokens"),
    resourceObservation(dataset, "total-token-count", ["totalTokens"], "tokens"),
    resourceObservation(dataset, "total-cost-usd", ["totalCostUsd"], "usd"),
    resourceObservation(dataset, "attempt-latency-ms", ["durationMs"], "milliseconds"),
  ];
}

function importOutcomes(
  dataset: NormalizedDataset,
  capture: NormalizationInput<AgentSdkNativeRecord> | undefined,
  assessmentMode: "observational" | "verified" | "unknown",
): StructuralObservation[] {
  const terminal = dataset.events.find((event) => event.family === "outcome" && event.source.nativeType === "terminal-record");
  const terminalWorkspaceIds = new Set(terminal?.content.status === "known"
    ? terminal.content.value.flatMap(({ nativeReference, role }) => role === "final-workspace" ? [nativeReference.artifactId] : [])
    : []);
  const workspace = dataset.events.filter((event) => event.family === "artifact"
    && event.scope.kind === "workspace" && typeof event.scope.id === "string" && terminalWorkspaceIds.has(event.scope.id)
    && event.content.status === "known" && event.content.value.some(({ nativeReference, role }) =>
      role === "workspace-outcome" && terminalWorkspaceIds.has(nativeReference.artifactId)));
  const captureReports = capture?.records.filter(({ record }) => record.kind === "capture-report") ?? [];
  const captureReferences = captureReports.length > 0
    ? captureReports.map(({ reference }) => reference)
    : capture?.records.map(({ reference }) => reference) ?? [];
  const assessmentEvents = dataset.events.filter((event) => event.source.nativeType === "assessment-mode");
  const verifierReferences = capture?.records.filter(({ record }) => record.kind === "verifier").map(({ reference }) => reference) ?? [];
  const base = [
    assessmentMode === "unknown"
      ? unavailable(dataset, outcomeRegistry("assessment-mode", "Assessment mode retained by the run manifest."), "Assessment mode evidence is missing.", [])
      : directObservation(dataset, "assessment-mode", "Assessment mode retained by the run manifest.", assessmentMode, "mode",
        assessmentEvents, assessmentEvents.length === 0 ? verifierReferences : []),
    terminal === undefined || typeof terminal.attributes.state !== "string"
      ? unavailable(dataset, outcomeRegistry("terminal-state", "Terminal state retained by the run manifest."), "Terminal outcome evidence is missing.", [])
      : directObservation(dataset, "terminal-state", "Terminal state retained by the run manifest.", String(terminal.attributes.state), "state", [terminal]),
    capture === undefined
      ? unavailable(dataset, outcomeRegistry("capture-qualification", "Structural capture qualification used to admit normalization."), "Capture qualification evidence was not supplied.", [])
      : directObservation(dataset, "capture-qualification", "Structural capture qualification used to admit normalization.",
        capture.qualification, "qualification", [], captureReferences),
    workspace.length === 0
      ? unavailable(dataset, outcomeRegistry("workspace-outcome-count", "Retained final workspace outcomes referenced by the attempt."),
        terminalWorkspaceIds.size === 0 ? "Terminal outcome does not reference a final workspace artifact." : "Terminal-referenced workspace outcome evidence is missing.",
        terminal === undefined ? [] : citations([terminal]), terminal === undefined ? [] : [terminal])
      : directObservation(dataset, "workspace-outcome-count", "Retained final workspace outcomes referenced by the attempt.",
        new Set(workspace.map(({ scope }) => scope.id)).size, "workspace-outcomes", [...workspace, ...(terminal === undefined ? [] : [terminal])]),
  ];
  if (assessmentMode !== "verified" || capture === undefined) return base;
  const assertions = capture.records.flatMap(({ record, reference }) => {
    if (record.kind !== "verifier") return [];
    const document = asRecord(record.document);
    return Array.isArray(document?.assertions) ? document.assertions.flatMap((candidate, index) => {
      const assertion = asRecord(candidate);
      return typeof assertion?.id === "string" && typeof assertion.status === "string"
        ? [{ id: assertion.id, status: assertion.status, reference: derivedReference(reference, `/assertions/${index}`) }]
        : [];
    }) : [];
  });
  return [...base, ...assertions.map(({ id, status, reference }) => directObservation(
    dataset,
    `verifier-assertion-${stableSuffix(id)}`,
    "Verifier assertion outcome identified by the cited native record.",
    status,
    "assertion-status",
    [],
    [reference],
  ))];
}

function toolOperations(events: readonly UniformEvent[]): ToolOperation[] {
  const groups = new Map<string, UniformEvent[]>();
  for (const event of events.filter(({ family }) => family === "tool")) {
    const id = operationId(event, events);
    if (id === undefined) continue;
    const grouped = groups.get(id) ?? [];
    grouped.push(event);
    groups.set(id, grouped);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).flatMap(([id, grouped]) => {
    const actorScopes = new Set(grouped.flatMap((event) => actorScope(event) ?? []));
    const scopedGroups = actorScopes.size <= 1
      ? [[id, grouped] as const]
      : [...actorScopes].sort().map((scope) => [`${scope}:${id}`, grouped.filter((event) => actorScope(event) === scope)] as const);
    return scopedGroups.map(([scopedId, scoped]) => operation(scopedId, scoped));
  });
}

function operation(id: string, grouped: UniformEvent[]): ToolOperation {
    const toolNames = new Set(grouped.flatMap((event) => scalarString(event.attributes.toolName) ?? []));
    const inputDigests = new Set(grouped.flatMap((event) => scalarString(event.attributes.inputDigest) ?? []));
    return {
      id,
      events: grouped,
      ...(toolNames.size === 1 ? { toolName: [...toolNames][0] } : {}),
      ...(inputDigests.size === 1 ? { inputDigest: [...inputDigests][0] } : {}),
      failed: grouped.some(explicitToolFailure),
    };
}

function actorScope(event: UniformEvent): string | undefined {
  return scalarString(event.attributes.agentId)
    ?? (event.scope.kind === "session" || event.scope.kind === "turn" ? event.scope.id : undefined)
    ?? (event.actor.kind === "agent" ? event.actor.id : undefined);
}

function ambiguousActorScopedToolEvents(events: readonly UniformEvent[]): UniformEvent[] {
  const groups = new Map<string, UniformEvent[]>();
  for (const event of events.filter(({ family }) => family === "tool")) {
    const id = operationId(event, events);
    if (id === undefined) continue;
    const grouped = groups.get(id) ?? [];
    grouped.push(event);
    groups.set(id, grouped);
  }
  return [...groups.values()].flatMap((grouped) => {
    const scopes = new Set(grouped.flatMap((event) => actorScope(event) ?? []));
    return scopes.size > 1 ? grouped.filter((event) => actorScope(event) === undefined) : [];
  });
}

function uniqueEvents(events: readonly UniformEvent[]): UniformEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function repeatedOperations(operations: readonly ToolOperation[]): { count: number; citations: NativeEvidenceReference[]; events: UniformEvent[]; reason?: string } {
  if (operations.length === 0) return { count: 0, citations: [], events: [] };
  if (operations.some(({ toolName, inputDigest }) => toolName === undefined || inputDigest === undefined)) {
    const events = operations.flatMap(({ events }) => events);
    return { count: 0, citations: citations(events), events, reason: "Repetition requires an explicit tool identity and native-input digest for every logical operation." };
  }
  const seen = new Map<string, ToolOperation>();
  let count = 0;
  const records: UniformEvent[] = [];
  for (const operation of operations) {
    const signature = JSON.stringify([operation.toolName, operation.inputDigest]);
    const first = seen.get(signature);
    if (first !== undefined) {
      count += 1;
      records.push(...first.events, ...operation.events);
    }
    else seen.set(signature, operation);
  }
  return { count, citations: citations(records), events: records };
}

function followedOperations(operations: readonly ToolOperation[]): { same: number; alternate: number; citations: NativeEvidenceReference[]; events: UniformEvent[]; reason?: string } {
  const failed = operations.filter(({ failed }) => failed);
  if (failed.length === 0) return { same: 0, alternate: 0, citations: [], events: [] };
  const ordered = operations.map((operation) => ({ operation, starts: orderedEvents(operation.events, false), failures: orderedEvents(operation.events, true) }));
  if (ordered.some(({ operation, starts }) => starts.length === 0 || operation.toolName === undefined)
      || ordered.filter(({ operation }) => operation.failed).some(({ failures }) => failures.length === 0)) {
    const events = operations.flatMap(({ events }) => events);
    return {
      same: 0,
      alternate: 0,
      citations: citations(events),
      events,
      reason: "Failure-followed-by-operation requires explicit tool identities and source-local order for starts and failures.",
    };
  }
  let same = 0;
  let alternate = 0;
  const records: UniformEvent[] = [];
  for (const current of ordered.filter(({ operation }) => operation.failed)) {
    const nextOperations: ToolOperation[] = [];
    for (const failure of current.failures) {
      const candidates = ordered.flatMap(({ operation, starts }) => starts.map((start) => ({ operation, start })))
        .filter(({ operation, start }) => operation.id !== current.operation.id
          && start.domain === failure.domain && start.value > failure.value);
      if (candidates.length === 0) continue;
      const nextOrder = Math.min(...candidates.map(({ start }) => start.value));
      const tied = candidates.filter(({ start }) => start.value === nextOrder);
      const tiedClassifications = new Set(tied.map(({ operation }) =>
        operation.toolName === current.operation.toolName ? "same" : "alternate"));
      if (tiedClassifications.size > 1) {
        const events = [current.operation, ...tied.map(({ operation }) => operation)].flatMap(({ events }) => events);
        return {
          same: 0,
          alternate: 0,
          citations: citations(events),
          events,
          reason: "Tied next operations in one native-order domain disagree on tool classification.",
        };
      }
      nextOperations.push(...tied.map(({ operation }) => operation));
    }
    const classifications = new Set(nextOperations.map((operation) =>
      operation.toolName === current.operation.toolName ? "same" : "alternate"));
    if (classifications.size > 1) {
      const events = [current.operation, ...nextOperations].flatMap(({ events }) => events);
      return {
        same: 0,
        alternate: 0,
        citations: citations(events),
        events,
        reason: "Independent native-order domains disagree on the next tool operation classification.",
      };
    }
    const classification = [...classifications][0];
    if (classification === "same") same += 1;
    if (classification === "alternate") alternate += 1;
    if (classification !== undefined) records.push(...current.operation.events, ...nextOperations.flatMap(({ events }) => events));
  }
  return { same, alternate, citations: citations(records), events: records };
}

function validationAfterMutation(dataset: NormalizedDataset): StructuralObservation {
  const registrationValue = registration("validation-after-last-mutation");
  const mutations = dataset.events.filter((event) => event.family === "artifact" && event.attributes.mutation === true);
  const validations = dataset.events.filter(({ family }) => family === "validation");
  const records = [...mutations, ...validations];
  const capabilityReason = unavailableCapability(dataset, registrationValue, true);
  if (capabilityReason !== undefined) return unavailable(dataset, registrationValue, capabilityReason, citations(records), records);
  if (mutations.length === 0) return unavailable(dataset, registrationValue, "No normalized event explicitly identifies a mutation.", citations(records), records);
  const ordered = records.flatMap((event) => event.nativeOrder.status === "known"
    ? [{ event, value: event.nativeOrder.value, domain: event.nativeOrder.domain }] : []);
  if (ordered.length !== records.length || new Set(ordered.map(({ domain }) => domain)).size !== 1) {
    return unavailable(dataset, registrationValue, "Mutation and validation ordering is unknown or spans unrelated native-order domains.", citations(records), records);
  }
  const lastMutation = Math.max(...ordered.filter(({ event }) => event.family === "artifact").map(({ value }) => value));
  const value = ordered.some(({ event, value: order }) => event.family === "validation" && order > lastMutation);
  return known(dataset, registrationValue, value, "boolean", citations(records), records);
}

function resourceObservation(dataset: NormalizedDataset, id: ExtractorRegistration["id"], fields: readonly string[], unit: string): StructuralObservation {
  const resourceEvents = dataset.events.filter((event) => typeof event.attributes.resourceSemantics === "string");
  const candidates = resourceEvents.flatMap((event) => {
    if (typeof event.attributes.resourceSemantics !== "string") return [];
    const aliases = fields.flatMap((field) => typeof event.attributes[field] === "number"
      ? [{ field, value: event.attributes[field] as number }] : []);
    return aliases.length === 0 ? [] : [{
      event,
      field: aliases.map(({ field }) => field).join("/"),
      value: aliases[0]!.value,
      semantics: event.attributes.resourceSemantics as string,
      aliasConflict: new Set(aliases.map(({ value }) => value)).size > 1,
    }];
  });
  const field = fields.join("/");
  const registrationValue = registration(id);
  const capabilityReason = unavailableCapability(dataset, registrationValue, resourceEvents.length === 0);
  if (capabilityReason !== undefined) return unavailable(dataset, registrationValue, capabilityReason, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event));
  if (candidates.length === 0) return unavailable(dataset, registrationValue, `No supported native ${field} record is available.`, []);
  const finals = candidates.filter(({ semantics }) => semantics === "cumulative-final");
  if (finals.length > 0) {
    const invalid = invalidResourceReason(finals, field, unit);
    if (invalid !== undefined) return unavailable(dataset, registrationValue, invalid, citations(finals.map(({ event }) => event)), finals.map(({ event }) => event));
    const values = new Set(finals.map(({ value }) => value));
    return values.size === 1
      ? known(dataset, registrationValue, finals[0]!.value, unit, citations(finals.map(({ event }) => event)), finals.map(({ event }) => event))
      : unavailable(dataset, registrationValue, `Conflicting cumulative-final ${field} records are available.`, citations(finals.map(({ event }) => event)), finals.map(({ event }) => event));
  }
  if (candidates.every(({ semantics }) => semantics === "increment")) {
    const invalid = invalidResourceReason(candidates, field, unit);
    return invalid === undefined
      ? known(dataset, registrationValue, candidates.reduce((sum, { value }) => sum + value, 0), unit, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event))
      : unavailable(dataset, registrationValue, invalid, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event));
  }
  if (candidates.every(({ semantics }) => semantics === "cumulative-snapshot")) {
    const snapshots = resourceEvents.filter(({ attributes }) => attributes.resourceSemantics === "cumulative-snapshot");
    return cumulativeResourceObservation(dataset, registrationValue, candidates, snapshots, field, unit);
  }
  return unavailable(dataset, registrationValue, `${field} records have overlapping or unordered usage semantics.`, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event));
}

function cumulativeResourceObservation(
  dataset: NormalizedDataset,
  extractor: ExtractorRegistration,
  candidates: readonly { event: UniformEvent; value: number; semantics: string; aliasConflict: boolean }[],
  semanticEvents: readonly UniformEvent[],
  field: string,
  unit: string,
): StructuralObservation {
  const ordered = semanticEvents.flatMap((event) => event.nativeOrder.status === "known"
    ? [{ event, order: event.nativeOrder.value, domain: event.nativeOrder.domain }] : []);
  if (semanticEvents.length > 1 && (ordered.length !== semanticEvents.length || new Set(ordered.map(({ domain }) => domain)).size !== 1)) {
    return unavailable(dataset, extractor, `${field} cumulative snapshot records have unknown or unrelated native order.`, citations(semanticEvents), semanticEvents);
  }
  const latestEvents = semanticEvents.length === 1
    ? semanticEvents
    : ordered.filter(({ order }) => order === Math.max(...ordered.map(({ order: value }) => value))).map(({ event }) => event);
  const latestIds = new Set(latestEvents.map(({ id }) => id));
  const latest = candidates.filter(({ event }) => latestIds.has(event.id));
  if (latest.length === 0) {
    return unavailable(dataset, extractor, `Latest cumulative snapshot omits ${field}.`, citations(latestEvents), latestEvents);
  }
  const invalid = invalidResourceReason(latest, field, unit);
  if (invalid !== undefined) return unavailable(dataset, extractor, invalid, citations(latest.map(({ event }) => event)), latest.map(({ event }) => event));
  const values = new Set(latest.map(({ value }) => value));
  return values.size === 1
    ? known(dataset, extractor, latest[0]!.value, unit, citations(latest.map(({ event }) => event)), latest.map(({ event }) => event))
    : unavailable(dataset, extractor, `Conflicting latest cumulative ${field} snapshots are available.`, citations(latest.map(({ event }) => event)), latest.map(({ event }) => event));
}

function invalidResourceReason(
  candidates: readonly { value: number; aliasConflict: boolean }[],
  field: string,
  unit: string,
): string | undefined {
  if (candidates.some(({ aliasConflict }) => aliasConflict)) return `${field} aliases conflict within one native record.`;
  return candidates.some(({ value }) => !Number.isFinite(value) || value < 0 || unit === "tokens" && !Number.isSafeInteger(value))
    ? `${field} contains a negative or non-integral native value.` : undefined;
}

function countOrUnavailable(
  dataset: NormalizedDataset,
  extractor: ExtractorRegistration,
  count: number,
  evidence: readonly NativeEvidenceReference[],
  reason?: string,
  unit = "requests",
  sourceEvents: readonly UniformEvent[] = [],
): StructuralObservation {
  if (reason !== undefined) return unavailable(dataset, extractor, reason, evidence, sourceEvents);
  const unavailableReason = unavailableCapability(dataset, extractor, count === 0);
  if (unavailableReason !== undefined) return unavailable(dataset, extractor, unavailableReason, evidence, sourceEvents);
  return known(dataset, extractor, count, unit, evidence, sourceEvents);
}

function directObservation(
  dataset: NormalizedDataset,
  id: string,
  definition: string,
  value: string | number | boolean,
  unit: string,
  events: readonly UniformEvent[],
  extraCitations: readonly NativeEvidenceReference[] = [],
): StructuralObservation {
  return known(dataset, outcomeRegistry(id, definition), value, unit, citations(events, extraCitations), events);
}

function known(
  dataset: NormalizedDataset,
  extractor: ExtractorRegistration,
  value: string | number | boolean,
  unit: string,
  evidence: readonly NativeEvidenceReference[],
  sourceEvents: readonly UniformEvent[] = [],
): StructuralObservation {
  return observation(dataset, extractor, { status: "known", value, unit }, evidence, sourceEvents);
}

function unavailable(
  dataset: NormalizedDataset,
  extractor: ExtractorRegistration,
  reason: string,
  evidence: readonly NativeEvidenceReference[],
  sourceEvents: readonly UniformEvent[] = [],
): StructuralObservation {
  return observation(dataset, extractor, { status: "unavailable", reason }, evidence, sourceEvents);
}

function observation(
  dataset: NormalizedDataset,
  extractor: ExtractorRegistration,
  value: KnownValue | UnavailableValue,
  evidence: readonly NativeEvidenceReference[],
  sourceEvents: readonly UniformEvent[],
): StructuralObservation {
  const unique = uniqueReferences(evidence);
  return {
    schemaVersion: "ebo.structural-observation/v1",
    id: `${dataset.attemptId}:${extractor.id}`,
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    extractor: { id: extractor.id, version: STRUCTURAL_EXTRACTOR_VERSION, requiredCapabilities: extractor.requiredCapabilities },
    definition: extractor.definition,
    denominator: { scope: "attempt", id: dataset.attemptId, value: 1, unit: "attempt" },
    value,
    sourceEventIds: [...new Set(sourceEvents.map(({ id }) => id))].sort(),
    sourceRecordCount: unique.length,
    citations: unique,
  };
}

function operationId(event: UniformEvent, events: readonly UniformEvent[]): string | undefined {
  const direct = [event.attributes.toolUseId, event.attributes.toolCallId, event.attributes.actionId, event.attributes.callId, event.attributes.itemId]
    .map(scalarString).find((value) => value !== undefined)
    ?? (event.scope.kind === "operation" ? event.scope.id : undefined);
  if (direct !== undefined) return direct;
  for (const relation of event.relations.known) {
    // ponytail: linear lookup keeps the extractor stateless; index IDs if million-record profiles require it.
    const related = events.find(({ id }) => id === relation.eventId);
    const relatedId = related === undefined ? undefined : operationIdWithoutRelations(related);
    if (relatedId !== undefined) return relatedId;
  }
  return undefined;
}

function operationIdWithoutRelations(event: UniformEvent): string | undefined {
  return [event.attributes.toolUseId, event.attributes.toolCallId, event.attributes.actionId, event.attributes.callId, event.attributes.itemId]
    .map(scalarString).find((value) => value !== undefined)
    ?? (event.scope.kind === "operation" ? event.scope.id : undefined);
}

function requestId(event: UniformEvent): string | undefined {
  return [event.attributes.requestId, event.attributes.callId, event.attributes.llmResponseId]
    .map(scalarString).find((value) => value !== undefined)
    ?? (event.scope.kind === "operation" ? event.scope.id : undefined);
}

function logicalRequestCount(events: readonly UniformEvent[]): { count: number; reason?: string } {
  const groups = new Map<string, UniformEvent[]>();
  const unidentified = events.filter((event) => {
    const id = requestId(event);
    if (id === undefined) return true;
    const grouped = groups.get(id) ?? [];
    grouped.push(event);
    groups.set(id, grouped);
    return false;
  });
  let count = 0;
  let ambiguousScopes = 0;
  for (const grouped of groups.values()) {
    const scopes = new Set(grouped.flatMap((event) => actorScope(event) ?? []));
    count += Math.max(1, scopes.size);
    if (scopes.size > 1) ambiguousScopes += grouped.filter((event) => actorScope(event) === undefined).length;
  }
  const ambiguities = [
    unidentified.length > 0 ? `${unidentified.length} record(s) lack a source-native request identity` : undefined,
    ambiguousScopes > 0 ? `${ambiguousScopes} record(s) lack a native scope while the same request ID occurs in multiple scopes` : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  return { count, ...(ambiguities.length === 0 ? {} : { reason: `Model-request count is unavailable because ${ambiguities.join(" and ")}.` }) };
}

function explicitToolFailure(event: UniformEvent): boolean {
  return event.attributes.isError === true || event.attributes.errorScope === "agent-tool"
    || event.attributes.hook === "PostToolUseFailure" || event.attributes.status === "failed"
    || event.attributes.status === "error" || event.attributes.status === "declined";
}

function orderedEvents(events: readonly UniformEvent[], failures: boolean): Array<{ value: number; domain: string }> {
  return events.filter((event) => failures ? explicitToolFailure(event) : event.phase === "before" || event.phase === "instant")
    .flatMap((event) => event.nativeOrder.status === "known"
      ? [{ value: event.nativeOrder.value, domain: event.nativeOrder.domain }] : []);
}

function isCompactionBoundary(event: UniformEvent): boolean {
  if (event.family !== "context") return false;
  const subtype = scalarString(event.attributes.subtype);
  const hook = scalarString(event.attributes.hook);
  const method = scalarString(event.attributes.method);
  const eventType = scalarString(event.attributes.eventType);
  return subtype === "compact_boundary" || hook === "PreCompact" || hook === "PostCompact"
    || method === "thread/compacted" || eventType?.startsWith("compaction/") === true;
}

function importAssessmentMode(
  dataset: NormalizedDataset,
  capture?: NormalizationInput<AgentSdkNativeRecord>,
): "observational" | "verified" | "unknown" {
  const record = capture?.records.find(({ record }) => record.kind === "assessment-mode")?.record.document;
  if (record === "observational" || record === "verified") return record;
  if (capture?.records.some(({ record }) => record.kind === "verifier") === true) return "verified";
  const value = dataset.events.find((event) => event.source.nativeType === "assessment-mode")?.attributes.assessmentMode;
  return value === "observational" || value === "verified" ? value : "unknown";
}

function agentSdkNativeType(record: AgentSdkNativeRecord): string {
  const document = asRecord(record.document);
  if (record.kind === "session") return scalarString(document?.nativeType) ?? "session";
  if (record.kind === "hook") return scalarString(document?.hook) ?? "hook";
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
    if (record.kind !== "workspace") continue;
    const descriptor = asRecord(record.document);
    if (descriptor?.id === reference.artifactId && typeof descriptor.digest === "string"
        && /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)) return descriptor.digest as `sha256:${string}`;
  }
  return undefined;
}

function unavailableCapability(dataset: NormalizedDataset, extractor: ExtractorRegistration, zero: boolean): string | undefined {
  for (const requirement of extractor.requiredCapabilities) {
    const capability: AdapterCapability = requirement === "evidence:nativeOrder"
      ? dataset.capabilityProfile.evidence.nativeOrder
      : dataset.capabilityProfile.families[requirement.slice("family:".length) as UniformEventFamily];
    if (capability.status === "unsupported") return capability.detail ?? `Required capability ${requirement} is unsupported.`;
    if (zero && capability.status === "partial") return capability.detail ?? `Required capability ${requirement} is partial, so an observed zero is not supported.`;
  }
  return undefined;
}

function citations(events: readonly UniformEvent[], extra: readonly NativeEvidenceReference[] = []): NativeEvidenceReference[] {
  return uniqueReferences([...events.map(({ source }) => source.nativeReference), ...extra]);
}

function uniqueReferences(references: readonly NativeEvidenceReference[]): NativeEvidenceReference[] {
  return [...new Map(references.map((reference) => [canonicalizeMetadata(reference), structuredClone(reference)])).values()]
    .sort((left, right) => canonicalizeMetadata(left).localeCompare(canonicalizeMetadata(right)));
}

function derivedReference(reference: NativeEvidenceReference, pointer: string): NativeEvidenceReference {
  return { artifactId: reference.artifactId, recordLocator: reference.recordLocator === "#" ? `#${pointer}` : `${reference.recordLocator}#${pointer}` };
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stableSuffix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function registry<const Id extends string>(id: Id, requiredCapabilities: readonly RequiredCapability[], definition: string) {
  return { id, requiredCapabilities, definition } as const;
}

function registration(id: string): ExtractorRegistration {
  const found = STRUCTURAL_EXTRACTOR_REGISTRY.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Unknown structural extractor "${id}".`);
  return found;
}

function outcomeRegistry(id: string, definition: string): ExtractorRegistration {
  return registry(`outcome-${id}`, [], definition) as ExtractorRegistration;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
