import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AdapterRegistry,
  assertAdapterContract,
  UNIFORM_EVENT_FAMILIES,
  validateUniformEvents,
  type AdapterCapabilityProfile,
  type HarnessAdapter,
  type NativeEvidenceReference,
  type NativeEvidenceResolver,
  type UniformEvent,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = JSON.parse(readFileSync(
  join(repositoryRoot, "test/fixtures/uniform-events/all-families.v1.json"),
  "utf8",
)) as UniformEvent[];

const profile: AdapterCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: "fake-adapter",
  harness: "fake-harness",
  nativeTypes: ["fake.event"],
  families: {
    message: { status: "available" },
    "model-request": { status: "unsupported", detail: "fake source has no model request notifications" },
    tool: { status: "unsupported" },
    context: { status: "unsupported" },
    permission: { status: "unsupported" },
    delegation: { status: "unsupported" },
    artifact: { status: "unsupported" },
    validation: { status: "unsupported" },
    runtime: { status: "unsupported" },
    outcome: { status: "unsupported" },
  },
  evidence: {
    nativeOrder: { status: "available" },
    nativeTime: { status: "unsupported" },
    parentage: { status: "unsupported" },
    content: { status: "partial" },
  },
};

test("validates golden events for every initial family without inventing missing evidence", async () => {
  const resolver = resolverFor(fixture);

  await validateUniformEvents(fixture, resolver);

  assert.deepEqual([...new Set(fixture.map(({ family }) => family))].sort(), [...UNIFORM_EVENT_FAMILIES].sort());
  assert.ok(fixture.some(({ nativeTime }) => nativeTime.status === "unknown"));
  assert.ok(fixture.some(({ nativeTime }) => nativeTime.status === "unsupported"));
  assert.deepEqual(fixture.filter(({ nativeOrder }) => nativeOrder.status === "known")
    .map(({ nativeOrder }) => nativeOrder.status === "known" ? nativeOrder.domain : ""),
  ["session", "hooks", "hooks", "hooks", "hooks", "hooks", "hooks"]);
  assert.ok(fixture.some(({ relations }) => relations.parent.status === "unknown"));
  assert.ok(fixture.some(({ content }) => content.status === "unknown"));
  assert.ok(fixture.some(({ content }) => content.status === "known" && content.value.length === 0));
  assert.equal(JSON.stringify(fixture).includes("DeepSeek"), false);
  assert.equal(JSON.stringify(fixture).includes("WebSocket"), false);
  assert.equal(JSON.stringify(fixture).includes("JSON-RPC"), false);
});

test("rejects unresolved native and content references", async () => {
  const event = structuredClone(fixture[0]!);
  const sourceOnly: NativeEvidenceResolver = {
    resolve: ({ recordLocator }) => recordLocator === "line:1",
  };

  await assert.rejects(validateUniformEvents([{ ...event, source: {
    ...event.source,
    nativeReference: { artifactId: "session", recordLocator: "invented" },
  } }], sourceOnly), /unresolved/);
  event.content = {
    status: "known",
    value: [{ nativeReference: { artifactId: "session", recordLocator: "line:1#/message/content" } }],
  };
  await assert.rejects(validateUniformEvents([event], sourceOnly), /message\/content.*unresolved/);
});

test("bounds attributes and requires explicit unknown evidence", async () => {
  const missingTime = structuredClone(fixture[0]!);
  delete (missingTime as { nativeTime?: UniformEvent["nativeTime"] }).nativeTime;
  await assert.rejects(validateUniformEvents([missingTime as UniformEvent], resolverFor(fixture)), /nativeTime/);

  const oversized = structuredClone(fixture[0]!);
  oversized.attributes = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index]));
  await assert.rejects(validateUniformEvents([oversized], resolverFor(fixture)), /attributes/);

  const inventedRelation = structuredClone(fixture[0]!);
  inventedRelation.relations.parent = { status: "known", value: "event-not-emitted" };
  await assert.rejects(validateUniformEvents([inventedRelation], resolverFor(fixture)), /unresolved event relation/);

  const cycleA = { ...structuredClone(fixture[0]!), id: "cycle-a" };
  const cycleB = { ...structuredClone(fixture[0]!), id: "cycle-b" };
  cycleA.relations.parent = { status: "known", value: cycleB.id };
  cycleB.relations.parent = { status: "known", value: cycleA.id };
  await assert.rejects(validateUniformEvents([cycleA, cycleB], resolverFor([cycleA, cycleB])), /cyclic parentage/);
});

test("runs a minimal capture and normalization adapter contract while retaining unmapped records", async () => {
  type FakeRecord = { type: "message" | "source-only" };
  const captured = [
    { reference: { artifactId: "native", recordLocator: "line:1" }, record: { type: "message" as const } },
    { reference: { artifactId: "native", recordLocator: "line:2" }, record: { type: "source-only" as const } },
  ];
  const event: UniformEvent = {
    ...structuredClone(fixture[0]!),
    source: {
      harness: "fake-harness",
      nativeType: "fake.event",
      nativeReference: captured[0]!.reference,
    },
    nativeOrder: { status: "known", value: 1, domain: "fake-stream" },
    nativeTime: { status: "unsupported", reason: "fake source has no native timestamp" },
    relations: {
      parent: { status: "unsupported", reason: "fake source has no parent relation" },
      known: [],
    },
    content: { status: "unknown", reason: "fake source does not expose content" },
  };
  const adapter: HarnessAdapter<null, FakeRecord> = {
    capture: {
      id: "fake-adapter",
      harness: "fake-harness",
      capture: async () => ({
        runId: event.runId,
        attemptId: event.attemptId,
        qualification: "qualified",
        records: captured,
      }),
    },
    normalization: {
      id: "fake-adapter",
      harness: "fake-harness",
      capabilityProfile: profile,
      normalize: async ({ records }) => ({
        events: [event],
        unmapped: [{ reference: records[1]!.reference, reason: "no uniform mapping" }],
      }),
    },
  };
  const resolver: NativeEvidenceResolver = { resolve: () => true };

  const result = await assertAdapterContract(adapter, null, resolver);
  const registry = new AdapterRegistry([adapter]);

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.unmapped, [{ reference: captured[1]!.reference, reason: "no uniform mapping" }]);
  assert.equal(registry.get("fake-harness")?.normalization.id, "fake-adapter");

  const unqualified = {
    ...adapter,
    capture: {
      ...adapter.capture,
      capture: async () => ({
        runId: event.runId,
        attemptId: event.attemptId,
        qualification: "unqualified" as never,
        records: captured,
      }),
    },
  };
  await assert.rejects(assertAdapterContract(unqualified, null, resolver), /capture-qualified/);

  for (const [field, capabilityProfile] of [
    ["nativeOrder", { ...profile, evidence: { ...profile.evidence, nativeOrder: { status: "unsupported" as const } } }],
    ["nativeTime", { ...profile, evidence: { ...profile.evidence, nativeTime: { status: "available" as const } } }],
    ["parentage", { ...profile, evidence: { ...profile.evidence, parentage: { status: "available" as const } } }],
    ["content", { ...profile, evidence: { ...profile.evidence, content: { status: "unsupported" as const } } }],
  ] as const) {
    const contradictory = {
      ...adapter,
      normalization: { ...adapter.normalization, capabilityProfile },
    };
    await assert.rejects(assertAdapterContract(contradictory, null, resolver), new RegExp(field));
  }

  const undeclaredType = {
    ...adapter,
    normalization: {
      ...adapter.normalization,
      capabilityProfile: { ...profile, nativeTypes: ["other.event"] },
    },
  };
  await assert.rejects(assertAdapterContract(undeclaredType, null, resolver), /undeclared native type/);

  const duplicateCapture = {
    ...adapter,
    capture: {
      ...adapter.capture,
      capture: async () => ({
        runId: event.runId,
        attemptId: event.attemptId,
        qualification: "qualified" as const,
        records: [...captured, captured[0]!],
      }),
    },
  };
  await assert.rejects(assertAdapterContract(duplicateCapture, null, resolver), /duplicate native references/);

  const capturedCollision = { artifactId: "a\0", recordLocator: "b" };
  const inventedCollision = { artifactId: "a", recordLocator: "\0b" };
  const collisionAdapter = {
    ...adapter,
    capture: {
      ...adapter.capture,
      capture: async () => ({
        runId: event.runId,
        attemptId: event.attemptId,
        qualification: "qualified" as const,
        records: [{ reference: capturedCollision, record: { type: "message" as const } }],
      }),
    },
    normalization: {
      ...adapter.normalization,
      normalize: async () => ({
        events: [{
          ...event,
          source: { ...event.source, nativeReference: inventedCollision },
        }],
        unmapped: [],
      }),
    },
  };
  await assert.rejects(assertAdapterContract(collisionAdapter, null, resolver), /not captured/);
});

function resolverFor(events: readonly UniformEvent[]): NativeEvidenceResolver {
  const references = new Set<string>();
  for (const event of events) {
    references.add(referenceKey(event.source.nativeReference));
    if (event.content.status === "known") {
      for (const content of event.content.value) references.add(referenceKey(content.nativeReference));
    }
  }
  return { resolve: (reference) => references.has(referenceKey(reference)) };
}

function referenceKey(reference: NativeEvidenceReference): string {
  return `${reference.artifactId}:${reference.recordLocator}`;
}
