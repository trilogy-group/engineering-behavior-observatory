import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { HookInput, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  buildCorpusIndex,
  captureClaudeAgentSdkRun,
  createStructuralObservationSet,
  main,
  probeClaudeAgentSdkCapabilities,
  validateArtifact,
  validateStructuralObservationSet,
  writeCorpusIndex,
  type AdapterCapabilityProfile,
  type AdapterCoverageReport,
  type AgentSdkNativeRecord,
  type ClaudeAgentSdkQuery,
  type NormalizedDataset,
  type NormalizationInput,
  type RunBundleDefinition,
  type StructuralObservationSet,
  type UniformEvent,
  type UniformEventFamily,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const families = ["message", "model-request", "tool", "context", "permission", "delegation", "artifact", "validation", "runtime", "outcome"] as const;
const golden = JSON.parse(readFileSync(resolve("test/fixtures/structural-observations/golden.json"), "utf8")) as {
  present: Record<string, string | number | boolean>;
  zero: Record<string, string | number | boolean>;
  unavailable: string[];
};

test("golden structural facts deduplicate operations and select the latest cumulative usage snapshot", async () => {
  const events = [
    event(1, "model-request", "before", { callId: "request-1" }),
    event(2, "tool", "before", { toolUseId: "operation-1", toolName: "Bash", inputDigest: digest }),
    event(3, "tool", "after", { toolUseId: "operation-1", toolName: "Bash", isError: true }),
    event(2, "tool", "before", { toolUseId: "operation-1", toolName: "Bash", inputDigest: digest }, "hook-duplicate"),
    event(4, "tool", "before", { toolUseId: "operation-2", toolName: "Bash", inputDigest: digest }),
    event(5, "artifact", "instant", { mutation: true }),
    event(6, "validation", "after", { status: "passed" }),
    event(7, "context", "after", { method: "thread/compacted" }),
    event(8, "runtime", "during", { inputTokens: 3, resourceSemantics: "cumulative-snapshot" }),
    event(9, "runtime", "during", { inputTokens: 9, resourceSemantics: "cumulative-snapshot" }),
    event(10, "outcome", "after", { durationMs: 1200, resourceSemantics: "cumulative-final", state: "completed" }),
  ];
  const report = createStructuralObservationSet(dataset(events), coverage(events));
  assert.deepEqual(knownValues(report, Object.keys(golden.present)), golden.present);
  assert.equal(observation(report, "tool-operation-count").sourceRecordCount, 4, "duplicate native records remain cited separately");
  await validateStructuralObservationSet(report, resolver());
  assert.deepEqual(validateArtifact("structural observations", report), []);
  assert.deepEqual(createStructuralObservationSet(dataset(events), coverage(events)), report, "stable input must produce stable output");
});

test("available zero and unsupported or partial evidence remain distinct", () => {
  const zero = createStructuralObservationSet(dataset([]), coverage([]));
  assert.deepEqual(knownValues(zero, Object.keys(golden.zero)), golden.zero);

  const unsupported = createStructuralObservationSet(dataset([], "unsupported"), coverage([], "unsupported"));
  for (const id of golden.unavailable) assert.equal(observation(unsupported, id).value.status, "unavailable", id);
  assert.doesNotMatch(JSON.stringify([zero, unsupported]), /\b(?:intelligent|appropriate|well[- ]reasoned)\b/iu);
});

test("unknown or cross-domain order and overlapping usage snapshots stay unavailable", () => {
  const events = [
    event(1, "artifact", "instant", { mutation: true }, "mutation", "mutations"),
    event(2, "validation", "after", { status: "passed" }, "validation", "validations"),
    event(3, "runtime", "during", { inputTokens: 5, resourceSemantics: "cumulative-snapshot" }, "usage-a", "usage-a"),
    event(4, "runtime", "during", { inputTokens: 8, resourceSemantics: "cumulative-snapshot" }, "usage-b", "usage-b"),
  ];
  const report = createStructuralObservationSet(dataset(events), coverage(events));
  assert.equal(observation(report, "validation-after-last-mutation").value.status, "unavailable");
  assert.equal(observation(report, "input-token-count").value.status, "unavailable");
  const partial = createStructuralObservationSet(dataset([
    event(1, "artifact", "instant", { mutation: true }),
  ], "partial"), coverage([event(1, "artifact", "instant", { mutation: true })], "partial"));
  assert.equal(observation(partial, "validation-after-last-mutation").value.status, "unavailable");
});

test("native operation IDs are scoped by explicit actors and unscoped duplicates stay visible", () => {
  const events = [
    event(1, "tool", "before", { toolUseId: "reused", agentId: "agent-a", toolName: "Read", inputDigest: digest }, "actor-a"),
    event(2, "tool", "before", { toolUseId: "reused", agentId: "agent-b", toolName: "Read", inputDigest: digest }, "actor-b"),
    event(3, "tool", "after", { toolUseId: "reused", status: "completed" }, "unscoped"),
  ];
  const report = createStructuralObservationSet(dataset(events), coverage(events));
  assert.deepEqual(observation(report, "tool-operation-count").value, {
    status: "known", value: 2, unit: "identified-logical-tool-operations",
  });
  assert.deepEqual(observation(report, "unidentified-tool-native-record-count").value, {
    status: "known", value: 1, unit: "native-records",
  });
});

test("session-scoped progress remains part of an explicitly agent-scoped native operation", () => {
  const hook = event(1, "tool", "before", {
    toolUseId: "shared-operation",
    agentId: "worker-1",
    sessionId: "session-1",
    toolName: "Read",
    inputDigest: digest,
  }, "agent-hook", "hooks");
  const progress = event(2, "tool", "during", {
    toolUseId: "shared-operation",
    toolName: "Read",
  }, "session-progress", "session");
  progress.scope = { kind: "session", id: "session-1" };
  const report = createStructuralObservationSet(dataset([hook, progress]), coverage([hook, progress]));
  assert.deepEqual(observation(report, "tool-operation-count").value, {
    status: "known", value: 1, unit: "identified-logical-tool-operations",
  });
  assert.deepEqual(observation(report, "unidentified-tool-native-record-count").value, {
    status: "known", value: 0, unit: "native-records",
  });
});

test("additional agent identity does not erase distinct native sessions", () => {
  const root = event(1, "tool", "before", {
    callId: "1",
    toolName: "Read",
    inputDigest: digest,
  }, "root-session-operation", "root-order");
  root.scope = { kind: "session", id: "root-session" };
  const child = event(1, "tool", "before", {
    callId: "1",
    agentId: "worker-1",
    toolName: "Read",
    inputDigest: digest,
  }, "child-session-operation", "child-order");
  child.scope = { kind: "session", id: "child-session" };
  const report = createStructuralObservationSet(dataset([root, child]), coverage([root, child]));
  assert.deepEqual(observation(report, "tool-operation-count").value, {
    status: "known", value: 2, unit: "identified-logical-tool-operations",
  });
  assert.deepEqual(observation(report, "repeated-tool-operation-count").value, {
    status: "known", value: 1, unit: "logical-tool-operations",
  });
});

test("session-local request IDs remain distinct across root and subagent sessions", () => {
  const root = event(1, "model-request", "before", { callId: "1" }, "root-request", "root-order");
  root.scope = { kind: "session", id: "root" };
  const child = event(1, "model-request", "before", { callId: "1" }, "child-request", "child-order");
  child.scope = { kind: "session", id: "child" };
  const duplicate = event(2, "model-request", "after", { callId: "1" }, "root-request-result", "root-order");
  duplicate.scope = { kind: "session", id: "root" };
  const report = createStructuralObservationSet(dataset([root, child, duplicate]), coverage([root, child, duplicate]));
  assert.deepEqual(observation(report, "model-request-count").value, { status: "known", value: 2, unit: "requests" });
});

test("duplicate failure evidence across native order domains classifies one logical operation once", () => {
  const events = [
    event(1, "tool", "before", { toolUseId: "failed", toolName: "Read", inputDigest: digest }, "failed-session-start", "session"),
    event(2, "tool", "after", { toolUseId: "failed", toolName: "Read", isError: true }, "failed-session-end", "session"),
    event(1, "tool", "before", { toolUseId: "failed", toolName: "Read", inputDigest: digest }, "failed-hook-start", "hooks"),
    event(2, "tool", "after", { toolUseId: "failed", toolName: "Read", isError: true }, "failed-hook-end", "hooks"),
    event(3, "tool", "before", { toolUseId: "next", toolName: "Read", inputDigest: digest }, "next-session", "session"),
    event(3, "tool", "before", { toolUseId: "next", toolName: "Read", inputDigest: digest }, "next-hook", "hooks"),
  ];
  const report = createStructuralObservationSet(dataset(events), coverage(events));
  assert.deepEqual(observation(report, "failure-followed-by-same-tool-count").value, {
    status: "known", value: 1, unit: "failed-logical-tool-operations",
  });
});

test("terminal failures cite native evidence for zero follow-up counts", () => {
  const start = event(1, "tool", "before", { toolUseId: "failed", toolName: "Read", inputDigest: digest }, "terminal-failure-start");
  const failure = event(2, "tool", "after", { toolUseId: "failed", toolName: "Read", isError: true }, "terminal-failure-end");
  const report = createStructuralObservationSet(dataset([start, failure]), coverage([start, failure]));
  for (const id of ["failure-followed-by-same-tool-count", "failure-followed-by-alternate-tool-count"]) {
    const followup = observation(report, id);
    assert.deepEqual(followup.value, { status: "known", value: 0, unit: "failed-logical-tool-operations" });
    assert.deepEqual(followup.sourceEventIds, [failure.id, start.id].sort());
  }
});

test("an identity-less intervening tool start makes failure follow-up unavailable", () => {
  const failedStart = event(1, "tool", "before", { toolUseId: "failed", toolName: "Read", inputDigest: digest }, "failed-before-unknown");
  const failure = event(2, "tool", "after", { toolUseId: "failed", toolName: "Read", isError: true }, "failed-before-unknown-result");
  const unknown = event(3, "tool", "before", { toolName: "Write", inputDigest: digest }, "identity-less-start");
  const later = event(4, "tool", "before", { toolUseId: "later", toolName: "Read", inputDigest: digest }, "later-known-start");
  const report = createStructuralObservationSet(dataset([failedStart, failure, unknown, later]), coverage([failedStart, failure, unknown, later]));
  for (const id of ["failure-followed-by-same-tool-count", "failure-followed-by-alternate-tool-count"]) {
    const followup = observation(report, id);
    assert.equal(followup.value.status, "unavailable");
    assert.equal(followup.sourceEventIds.includes(unknown.id), true);
  }
  const repeated = observation(report, "repeated-tool-operation-count");
  assert.equal(repeated.value.status, "unavailable");
  assert.equal(repeated.sourceEventIds.includes(unknown.id), true);
});

test("tied same-tool and alternate-tool successors remain unavailable", () => {
  const events = [
    event(1, "tool", "before", { toolUseId: "failed", toolName: "Read", inputDigest: digest }, "failed-start"),
    event(2, "tool", "after", { toolUseId: "failed", toolName: "Read", isError: true }, "failed-end"),
    event(3, "tool", "before", { toolUseId: "same", toolName: "Read", inputDigest: digest }, "same"),
    event(3, "tool", "before", { toolUseId: "alternate", toolName: "Write", inputDigest: digest }, "alternate"),
  ];
  const report = createStructuralObservationSet(dataset(events), coverage(events));
  assert.equal(observation(report, "failure-followed-by-same-tool-count").value.status, "unavailable");
  assert.equal(observation(report, "failure-followed-by-alternate-tool-count").value.status, "unavailable");
});

test("source event IDs do not absorb another projection of the same native record", () => {
  const resource = event(1, "runtime", "after", { inputTokens: 5, resourceSemantics: "cumulative-final" }, "resource");
  const outcome = event(1, "outcome", "after", { state: "completed" }, "outcome");
  outcome.source.nativeReference = resource.source.nativeReference;
  const report = createStructuralObservationSet(dataset([resource, outcome]), coverage([resource, outcome]));
  assert.deepEqual(observation(report, "input-token-count").sourceEventIds, [resource.id]);
});

test("unprojectable native tool blocks make logical totals unavailable", () => {
  const retained = event(1, "message", "instant", { unprojectedToolBlockCount: 1 }, "invalid-tool-block");
  const report = createStructuralObservationSet(dataset([retained]), coverage([retained]));
  assert.equal(observation(report, "tool-operation-count").value.status, "unavailable");
  assert.deepEqual(observation(report, "unidentified-tool-native-record-count").value, {
    status: "known", value: 1, unit: "native-records",
  });
});

test("resource aliases are deduplicated per event and conflicts stay unavailable", () => {
  const matching = event(1, "runtime", "during", {
    cacheReadInputTokens: 5,
    cachedInputTokens: 5,
    resourceSemantics: "increment",
  }, "matching-aliases");
  const matchingReport = createStructuralObservationSet(dataset([matching]), coverage([matching]));
  assert.deepEqual(observation(matchingReport, "cache-read-input-token-count").value, {
    status: "known", value: 5, unit: "tokens",
  });
  const conflicting = event(1, "runtime", "during", {
    cacheReadInputTokens: 5,
    cachedInputTokens: 6,
    resourceSemantics: "increment",
  }, "conflicting-aliases");
  const conflictingReport = createStructuralObservationSet(dataset([conflicting]), coverage([conflicting]));
  assert.equal(observation(conflictingReport, "cache-read-input-token-count").value.status, "unavailable");
});

test("an omitted category in the latest cumulative resource snapshot stays unavailable", () => {
  const earlier = event(1, "runtime", "during", {
    cacheWriteInputTokens: 5,
    resourceSemantics: "cumulative-snapshot",
  }, "earlier-resource-snapshot");
  const latest = event(2, "runtime", "during", {
    outputTokens: 8,
    resourceSemantics: "cumulative-snapshot",
  }, "latest-resource-snapshot");
  const report = createStructuralObservationSet(dataset([earlier, latest]), coverage([earlier, latest]));
  const cacheCreation = observation(report, "cache-creation-input-token-count");
  assert.equal(cacheCreation.value.status, "unavailable");
  assert.deepEqual(cacheCreation.sourceEventIds, [latest.id]);
  assert.deepEqual(cacheCreation.citations, [latest.source.nativeReference]);
});

test("OpenHands condensation records count as explicit compaction boundaries", () => {
  const condensation = event(1, "context", "during", {}, "openhands-condensation");
  condensation.source.nativeType = "Condensation";
  const summary = event(2, "context", "after", {}, "openhands-condensation-summary");
  summary.source.nativeType = "CondensationSummaryEvent";
  const report = createStructuralObservationSet(dataset([condensation, summary]), coverage([condensation, summary]));
  const compactions = observation(report, "compaction-boundary-record-count");
  assert.deepEqual(compactions.value, { status: "known", value: 2, unit: "native-records" });
  assert.deepEqual(compactions.sourceEventIds, [condensation.id, summary.id].sort());
});

test("workspace outcome count follows the terminal workspace reference", () => {
  const checkpoint = event(1, "artifact", "after", {}, "checkpoint-workspace");
  checkpoint.source.nativeType = "workspace-outcome";
  checkpoint.scope = { kind: "workspace", id: "checkpoint" };
  checkpoint.content = { status: "known", value: [{ nativeReference: { artifactId: "checkpoint", recordLocator: "#" }, role: "workspace-outcome" }] };
  const final = event(2, "artifact", "after", {}, "final-workspace");
  final.source.nativeType = "workspace-outcome";
  final.scope = { kind: "workspace", id: "final" };
  final.content = { status: "known", value: [{ nativeReference: { artifactId: "final", recordLocator: "#" }, role: "workspace-outcome" }] };
  const terminal = event(3, "outcome", "after", { state: "completed" }, "terminal");
  terminal.source.nativeType = "terminal-record";
  terminal.content = { status: "known", value: [{ nativeReference: { artifactId: "final", recordLocator: "#" }, role: "final-workspace" }] };
  const report = createStructuralObservationSet(dataset([checkpoint, final, terminal]), coverage([checkpoint, final, terminal]));
  const workspace = observation(report, "outcome-workspace-outcome-count");
  assert.deepEqual(workspace.value, { status: "known", value: 1, unit: "workspace-outcomes" });
  assert.deepEqual(workspace.sourceEventIds, [final.id, terminal.id].sort());
  assert.equal(workspace.sourceEventIds.includes(checkpoint.id), false);
});

test("verified outcomes retain assertion-level citations while observational outcomes make no verifier claim", () => {
  const verifiedCapture: NormalizationInput<AgentSdkNativeRecord> = {
    runId: "run-structural-golden",
    attemptId: "attempt-structural-golden",
    qualification: "qualified",
    records: [{
      reference: { artifactId: "manifest", recordLocator: "#/run/assessmentMode" },
      record: { kind: "assessment-mode", document: "verified" },
    }, {
      reference: { artifactId: "verifier", recordLocator: "#" },
      record: { kind: "verifier", document: { schemaVersion: "verifier-result/v1", assertions: [{ id: "file-exists", status: "passed" }] } },
    }],
  };
  const verified = createStructuralObservationSet(dataset([]), coverage([]), verifiedCapture);
  const assertion = verified.observations.find(({ extractor }) => extractor.id.startsWith("outcome-verifier-assertion-"));
  assert.deepEqual(assertion?.value, { status: "known", value: "passed", unit: "assertion-status" });
  assert.deepEqual(assertion?.citations, [{ artifactId: "verifier", recordLocator: "#/assertions/0" }]);
  const observational = createStructuralObservationSet(dataset([]), coverage([]));
  assert.equal(observational.observations.some(({ extractor }) => extractor.id.startsWith("outcome-verifier-assertion-")), false);
});

test("CLI reads a qualified observational bundle, validates it, and writes derived output outside the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-observations-cli-"));
  const source = await qualifiedBundle(root);
  const output = join(root, "observation.json");
  let stdout = "";
  assert.equal(await main(["observations", "create", source, output], (message) => { stdout += message; }), 0);
  assert.match(stdout, /Created \d+ structural observations/);
  const report = JSON.parse(readFileSync(output, "utf8")) as StructuralObservationSet;
  assert.deepEqual(validateArtifact(output, report), []);
  assert.equal(await main(["validate", output], () => undefined), 0);
  assert.equal(report.assessmentMode, "observational");
  assert.equal(report.observations.some(({ extractor }) => extractor.id.startsWith("outcome-verifier-assertion-")), false);
  assert.deepEqual(observation(report, "input-token-count").value, { status: "known", value: 3, unit: "tokens" });
  assert.deepEqual(observation(report, "output-token-count").value, { status: "known", value: 2, unit: "tokens" });
  assert.deepEqual(observation(report, "attempt-latency-ms").value, { status: "known", value: 12, unit: "milliseconds" });
  const originalOutput = readFileSync(output);
  assert.equal(await main(["observations", "create", source, output], () => undefined), 1);
  assert.deepEqual(readFileSync(output), originalOutput, "atomic no-clobber publication preserves the completed report");
  assert.equal(await main(["observations", "create", source, join(source, "derived.json")], () => undefined), 1);
  const sourceAlias = join(root, "source-alias");
  const forbiddenParent = join(source, "derived-via-alias");
  symlinkSync(source, sourceAlias);
  assert.equal(await main(["observations", "create", sourceAlias, join(forbiddenParent, "report.json")], () => undefined), 1);
  assert.equal(existsSync(forbiddenParent), false);

  const corpus = join(root, "corpus");
  const index = join(root, "index.jsonl");
  const outputs = join(root, "corpus-observations");
  cpSync(source, join(corpus, "runs", "complete"), { recursive: true });
  writeCorpusIndex(index, buildCorpusIndex(corpus));
  assert.equal(await main(["observations", "corpus", corpus, index, outputs, "--attempt", "attempt-structural-cli"], () => undefined), 0);
  const outputName = `sha256-${createHash("sha256").update(JSON.stringify(["run-structural-cli", "attempt-structural-cli"])).digest("hex")}.json`;
  assert.equal(existsSync(join(outputs, outputName)), true);
  const nestedOutputs = join(root, "nested", "derived", "observations");
  assert.equal(await main(["observations", "corpus", corpus, index, nestedOutputs, "--attempt", "attempt-structural-cli"], () => undefined), 0);
  assert.equal(existsSync(join(nestedOutputs, outputName)), true);

  const mixedCorpus = join(root, "mixed-corpus");
  const mixedIndex = join(root, "mixed-index.jsonl");
  const mixedOutput = join(root, "mixed-output");
  cpSync(source, join(mixedCorpus, "runs", "a-good"), { recursive: true });
  cpSync(source, join(mixedCorpus, "runs", "z-unsupported"), { recursive: true });
  const unsupportedManifestPath = join(mixedCorpus, "runs", "z-unsupported", "manifest.json");
  const unsupportedManifest = JSON.parse(readFileSync(unsupportedManifestPath, "utf8")) as { run: { harness: { id: string } } };
  unsupportedManifest.run.harness.id = "codex-app-server";
  writeFileSync(unsupportedManifestPath, JSON.stringify(unsupportedManifest));
  writeCorpusIndex(mixedIndex, buildCorpusIndex(mixedCorpus));
  assert.equal(await main(["observations", "corpus", mixedCorpus, mixedIndex, mixedOutput], () => undefined), 1);
  assert.equal(existsSync(mixedOutput), false, "a later unsupported bundle must not leave earlier reports published");
});

function dataset(events: UniformEvent[], capability: "available" | "partial" | "unsupported" = "available"): NormalizedDataset {
  const profile = capabilityProfile(capability);
  return {
    schemaVersion: "ebo.normalized-dataset/v1",
    runId: "run-structural-golden",
    attemptId: "attempt-structural-golden",
    adapter: { id: profile.adapterId, version: "1.0.0", harness: profile.harness },
    capabilityProfile: profile,
    nativeRecords: events.map(({ source }) => ({ reference: source.nativeReference, nativeType: source.nativeType, digest })),
    contentReferences: [],
    events,
    unmapped: [],
  };
}

function coverage(events: UniformEvent[], capability: "available" | "partial" | "unsupported" = "available"): AdapterCoverageReport {
  const profile = capabilityProfile(capability);
  return {
    schemaVersion: "ebo.adapter-coverage-report/v1",
    runId: "run-structural-golden",
    attemptId: "attempt-structural-golden",
    adapter: { id: profile.adapterId, version: "1.0.0", harness: profile.harness },
    records: { total: events.length, mapped: events.length, unmapped: 0 },
    nativeTypes: [],
    families: Object.fromEntries(families.map((family) => [family, {
      capability: profile.families[family],
      observedEvents: events.filter((eventValue) => eventValue.family === family).length,
    }])) as AdapterCoverageReport["families"],
    evidence: profile.evidence,
  };
}

function capabilityProfile(status: "available" | "partial" | "unsupported"): AdapterCapabilityProfile {
  return {
    schemaVersion: "ebo.adapter-capability-profile/v1",
    adapterId: "golden-adapter",
    harness: "golden-harness",
    nativeTypes: ["golden-record"],
    families: Object.fromEntries(families.map((family) => [family, { status }])) as AdapterCapabilityProfile["families"],
    evidence: {
      nativeOrder: { status },
      nativeTime: { status: "unsupported" },
      parentage: { status: "unsupported" },
      content: { status: "available" },
    },
  };
}

function event(
  order: number,
  family: UniformEventFamily,
  phase: UniformEvent["phase"],
  attributes: UniformEvent["attributes"],
  suffix = `${family}-${order}`,
  domain = "golden-order",
): UniformEvent {
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id: `event-${suffix}`,
    runId: "run-structural-golden",
    attemptId: "attempt-structural-golden",
    source: {
      harness: "golden-harness",
      nativeType: "golden-record",
      nativeReference: { artifactId: "golden", recordLocator: `line:${suffix}` },
    },
    nativeOrder: { status: "known", value: order, domain },
    nativeTime: { status: "unsupported", reason: "fixture omits native time" },
    actor: { kind: family === "tool" ? "tool" : "harness" },
    family,
    phase,
    scope: family === "tool" && typeof attributes.toolUseId === "string"
      ? { kind: "operation", id: attributes.toolUseId }
      : { kind: "attempt", id: "attempt-structural-golden" },
    relations: { parent: { status: "unsupported", reason: "fixture omits parentage" }, known: [] },
    attributes,
    content: { status: "known", value: [] },
  };
}

function knownValues(report: StructuralObservationSet, ids: readonly string[]): Record<string, string | number | boolean> {
  return Object.fromEntries(ids.map((id) => {
    const value = observation(report, id).value;
    assert.equal(value.status, "known", id);
    return [id, value.value];
  }));
}

function observation(report: StructuralObservationSet, id: string) {
  return report.observations.find(({ extractor }) => extractor.id === id)!;
}

function resolver() {
  return {
    resolve: () => ({ runId: "run-structural-golden", attemptId: "attempt-structural-golden", digest }),
  };
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
  const sha = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-structural-cli",
    run: {
      id: "run-structural-cli",
      assessmentMode: "observational",
      task: { id: "task-structural-cli" },
      fixture: { id: "fixture-structural-cli", digest: sha("a") },
      model: { provider: "anthropic", id: "claude-test" },
      harness: { id: "agent-sdk", version: capabilities.sdkVersion },
      runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }],
    },
    attempt: { id: "attempt-structural-cli", number: 1 },
    configuration: { digest: sha("b"), budgetDigest: sha("c"), toolPolicyDigest: sha("d") },
  };
  const query: ClaudeAgentSdkQuery = (input) => ({
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({
        hook_event_name: "SessionStart",
        session_id: "session-structural-cli",
        transcript_path: "/restricted/session.jsonl",
        cwd: final,
        source: "startup",
      } as HookInput, undefined, { signal: new AbortController().signal });
      yield {
        type: "assistant",
        uuid: "assistant-structural-cli",
        session_id: "session-structural-cli",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [] },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 12,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 2 },
        modelUsage: { "claude-test": { inputTokens: 3, outputTokens: 2, costUSD: 0.01 } },
        permission_denials: [],
        result: "done",
        session_id: "session-structural-cli",
        uuid: "result-structural-cli",
      } as unknown as SDKResultMessage;
    },
  });
  const captured = await captureClaudeAgentSdkRun({
    definition,
    startingWorkspacePath: start,
    workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
    configuration: { prompt: "Inspect result.txt.", model: "claude-test", tools: ["Read"], permissionMode: "dontAsk" },
    expectedHooks: ["SessionStart"],
    query,
  });
  assert.equal(captured.qualification.semanticAnalysisUsable, true);
  return bundleRoot;
}
