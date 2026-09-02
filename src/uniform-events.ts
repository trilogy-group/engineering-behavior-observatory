import { validateArtifact } from "./artifacts.js";

export const UNIFORM_EVENT_FAMILIES = [
  "message",
  "model-request",
  "tool",
  "context",
  "permission",
  "delegation",
  "artifact",
  "validation",
  "runtime",
  "outcome",
] as const;

export type UniformEventFamily = typeof UNIFORM_EVENT_FAMILIES[number];
export type EvidenceUnavailable = { status: "unknown" | "unsupported"; reason: string };
export type EvidenceValue<Value> = { status: "known"; value: Value } | EvidenceUnavailable;
export type NativeEvidenceReference = { artifactId: string; recordLocator: string };
export type ContentReference = {
  nativeReference: NativeEvidenceReference;
  mediaType?: string;
  role?: string;
};
export type UniformAttributeScalar = string | number | boolean | null;
export type UniformAttributeValue = UniformAttributeScalar | readonly UniformAttributeScalar[];

export type UniformEvent = {
  schemaVersion: "ebo.uniform-event/v1";
  id: string;
  runId: string;
  attemptId: string;
  source: {
    harness: string;
    nativeType: string;
    nativeReference: NativeEvidenceReference;
  };
  nativeOrder: EvidenceValue<number>;
  nativeTime: EvidenceValue<string>;
  actor: {
    kind: "user" | "agent" | "model" | "tool" | "harness" | "operator" | "system";
    id?: string;
  };
  family: UniformEventFamily;
  phase: "before" | "during" | "after" | "instant";
  scope: {
    kind: "run" | "attempt" | "session" | "turn" | "operation" | "workspace" | "artifact";
    id?: string;
  };
  relations: {
    parent: EvidenceValue<string>;
    known: ReadonlyArray<{
      kind: "child" | "caused-by" | "correlates-with";
      eventId: string;
    }>;
  };
  attributes: Readonly<Record<string, UniformAttributeValue>>;
  content: EvidenceValue<readonly ContentReference[]>;
};

export type AdapterCapability = {
  status: "available" | "partial" | "unsupported";
  detail?: string;
};

export type AdapterCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1";
  adapterId: string;
  harness: string;
  nativeTypes: readonly string[];
  families: Record<UniformEventFamily, AdapterCapability>;
  evidence: Record<"nativeOrder" | "nativeTime" | "parentage" | "content", AdapterCapability>;
};

export type CapturedNativeRecord<NativeRecord> = {
  reference: NativeEvidenceReference;
  record: NativeRecord;
};

export interface NativeCaptureAdapter<Request, NativeRecord> {
  readonly id: string;
  readonly harness: string;
  capture(request: Request): Promise<readonly CapturedNativeRecord<NativeRecord>[]>;
}

export type NormalizationInput<NativeRecord> = {
  runId: string;
  attemptId: string;
  qualification: "qualified" | "qualified-with-gaps";
  records: readonly CapturedNativeRecord<NativeRecord>[];
};

export type UnmappedNativeRecord = {
  reference: NativeEvidenceReference;
  reason: string;
};

export type NormalizationResult = {
  events: readonly UniformEvent[];
  unmapped: readonly UnmappedNativeRecord[];
};

export interface UniformEventNormalizationAdapter<NativeRecord> {
  readonly id: string;
  readonly harness: string;
  readonly capabilityProfile: AdapterCapabilityProfile;
  normalize(input: NormalizationInput<NativeRecord>): Promise<NormalizationResult>;
}

export type HarnessAdapter<Request = unknown, NativeRecord = unknown> = {
  capture: NativeCaptureAdapter<Request, NativeRecord>;
  normalization: UniformEventNormalizationAdapter<NativeRecord>;
};

export interface NativeEvidenceResolver {
  resolve(reference: NativeEvidenceReference): boolean | Promise<boolean>;
}

export class AdapterRegistry {
  readonly #adapters: ReadonlyMap<string, HarnessAdapter>;

  public constructor(adapters: readonly HarnessAdapter[]) {
    const entries = adapters.map((adapter) => {
      assertAdapterIdentity(adapter);
      return [adapter.capture.harness, adapter] as const;
    });
    if (new Set(entries.map(([harness]) => harness)).size !== entries.length) {
      throw new Error("Adapter registry contains duplicate harnesses.");
    }
    this.#adapters = new Map(entries);
  }

  public get(harness: string): HarnessAdapter | undefined {
    return this.#adapters.get(harness);
  }

  public list(): readonly HarnessAdapter[] {
    return [...this.#adapters.values()];
  }
}

export async function validateUniformEvents(
  events: readonly UniformEvent[],
  resolver: NativeEvidenceResolver,
): Promise<void> {
  const ids = new Set<string>();
  for (const event of events) {
    assertValidArtifact(`uniform event ${event.id}`, event);
    if (ids.has(event.id)) throw new Error(`Duplicate uniform event ID "${event.id}".`);
    ids.add(event.id);
  }
  for (const event of events) {
    await assertResolvable(event.source.nativeReference, resolver);
    if (event.content.status === "known") {
      for (const content of event.content.value) await assertResolvable(content.nativeReference, resolver);
    }
    const relationTargets = [
      ...(event.relations.parent.status === "known" ? [event.relations.parent.value] : []),
      ...event.relations.known.map(({ eventId }) => eventId),
    ];
    if (relationTargets.some((eventId) => !ids.has(eventId))) {
      throw new Error(`Uniform event "${event.id}" has an unresolved event relation.`);
    }
  }
}

export async function assertAdapterContract<Request, NativeRecord>(
  adapter: HarnessAdapter<Request, NativeRecord>,
  request: Request,
  context: Omit<NormalizationInput<NativeRecord>, "records">,
  resolver: NativeEvidenceResolver,
): Promise<NormalizationResult> {
  if (!["qualified", "qualified-with-gaps"].includes(context.qualification as string)) {
    throw new Error("Uniform event normalization requires capture-qualified evidence.");
  }
  assertAdapterIdentity(adapter);
  assertValidArtifact(`adapter capability profile ${adapter.normalization.id}`, adapter.normalization.capabilityProfile);
  const records = await adapter.capture.capture(request);
  const result = await adapter.normalization.normalize({ ...context, records });
  await validateUniformEvents(result.events, resolver);

  for (const { reference } of records) await assertResolvable(reference, resolver);
  for (const event of result.events) {
    if (event.runId !== context.runId || event.attemptId !== context.attemptId) {
      throw new Error("Normalized event identity does not match the qualified attempt.");
    }
    if (event.source.harness !== adapter.normalization.harness) {
      throw new Error("Normalized event source does not match its adapter harness.");
    }
    if (!adapter.normalization.capabilityProfile.nativeTypes.includes(event.source.nativeType)) {
      throw new Error(`Adapter emitted undeclared native type "${event.source.nativeType}".`);
    }
    if (adapter.normalization.capabilityProfile.families[event.family].status === "unsupported") {
      throw new Error(`Adapter mapped unsupported event family "${event.family}".`);
    }
    const capabilities = adapter.normalization.capabilityProfile.evidence;
    assertEvidenceCapability(capabilities.nativeOrder, event.nativeOrder.status, "nativeOrder");
    assertEvidenceCapability(capabilities.nativeTime, event.nativeTime.status, "nativeTime");
    assertEvidenceCapability(capabilities.content, event.content.status, "content");
    assertEvidenceCapability(capabilities.parentage, event.relations.parent.status, "parentage");
    if (capabilities.parentage.status === "unsupported" && event.relations.known.length > 0) {
      throw new Error("Adapter evidence capability contradicts event parentage.");
    }
  }

  const capturedKeys = records.map(({ reference }) => referenceKey(reference));
  if (new Set(capturedKeys).size !== capturedKeys.length) {
    throw new Error("Capture adapter returned duplicate native references.");
  }
  const captured = new Set(capturedKeys);
  const mapped = new Set(result.events.map(({ source }) => referenceKey(source.nativeReference)));
  const unmapped = result.unmapped.map(({ reference }) => referenceKey(reference));
  if (new Set(unmapped).size !== unmapped.length) throw new Error("Normalizer returned a native record as unmapped more than once.");
  const unmappedSet = new Set(unmapped);
  for (const reference of new Set([...mapped, ...unmappedSet])) {
    if (!captured.has(reference)) throw new Error("Normalizer returned a native reference that was not captured.");
  }
  for (const reference of captured) {
    if (mapped.has(reference) === unmappedSet.has(reference)) {
      throw new Error("Every captured native record must be mapped or explicitly retained as unmapped.");
    }
  }
  return result;
}

function assertAdapterIdentity(adapter: HarnessAdapter): void {
  if (adapter.capture.id !== adapter.normalization.id || adapter.capture.harness !== adapter.normalization.harness) {
    throw new Error("Capture and normalization adapters must have matching identities.");
  }
  const profile = adapter.normalization.capabilityProfile;
  if (profile.adapterId !== adapter.normalization.id || profile.harness !== adapter.normalization.harness) {
    throw new Error("Adapter capability profile does not match its adapter identity.");
  }
}

function assertEvidenceCapability(
  capability: AdapterCapability,
  evidenceStatus: EvidenceValue<unknown>["status"],
  field: string,
): void {
  if ((capability.status === "unsupported") !== (evidenceStatus === "unsupported")
      && capability.status !== "partial") {
    throw new Error(`Adapter evidence capability contradicts event ${field}.`);
  }
}

function assertValidArtifact(artifact: string, document: unknown): void {
  const errors = validateArtifact(artifact, document);
  if (errors.length > 0) {
    throw new Error(errors.map(({ field, message }) => `${artifact} ${field}: ${message}`).join("\n"));
  }
}

async function assertResolvable(
  reference: NativeEvidenceReference,
  resolver: NativeEvidenceResolver,
): Promise<void> {
  if (!await resolver.resolve(reference)) {
    throw new Error(`Native evidence reference ${reference.artifactId}:${reference.recordLocator} is unresolved.`);
  }
}

function referenceKey(reference: NativeEvidenceReference): string {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}
