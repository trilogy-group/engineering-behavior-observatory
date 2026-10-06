import assert from "node:assert/strict";
import test from "node:test";

import { digestMetadata, validateArtifact } from "../src/artifacts.js";
import { JUDGE_PREPARE_METHOD, prepareJudgeRequest, type JudgePrepareSpec } from "../src/judge-prepare.js";
import { rateOccurrences } from "../src/occurrence-ratings.js";
import { extractOccurrences, type OccurrenceOperation } from "../src/occurrences.js";
import { packageSemanticJudgeInput, parseSemanticJudgeResponse, semanticJudgeResponseSchema } from "../src/semantic-judge.js";
import type { StructuralObservationSet } from "../src/structural-observations.js";
import type { NormalizationInput, UniformEvent } from "../src/uniform-events.js";

function event(sequence: number, family: UniformEvent["family"], attributes: UniformEvent["attributes"], phase: UniformEvent["phase"], actor: UniformEvent["actor"] = { kind: "tool" }): UniformEvent {
  return {
    schemaVersion: "ebo.uniform-event/v1", id: `event-${sequence}`, runId: "run", attemptId: "attempt",
    source: { harness: "fixture", nativeType: family, nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } },
    nativeOrder: { status: "known", value: sequence, domain: "session" },
    nativeTime: { status: "known", value: new Date(Date.UTC(2026, 9, 6, 0, 0, sequence)).toISOString() },
    actor, family, phase, scope: { kind: "session", id: "s" },
    relations: { parent: { status: "unknown", reason: "fixture" }, known: [] }, attributes,
    content: { status: "known", value: [{ nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } }] },
  };
}

/** A small attempt: a task message, six test runs (two failing), a failure chain and a final report. */
function fixture() {
  const content: Record<string, unknown> = { "line:1": { text: "Migrate the tables." }, "line:99": { text: "Done; all tests pass." } };
  const events: UniformEvent[] = [event(1, "message", {}, "instant", { kind: "user" })];
  const operations: OccurrenceOperation[] = [];
  for (let index = 0; index < 6; index += 1) {
    const start = 10 + index * 2;
    const failed = index === 1 || index === 2;
    const id = `call-${String(index)}`;
    content[`line:${String(start)}`] = { input: { command: `pnpm exec jest src/table-${String(index)}.test.ts` } };
    content[`line:${String(start + 1)}`] = { content: failed ? "Tests: 1 failed" : "Tests: 4 passed" };
    const own = [event(start, "tool", { toolName: "Bash", toolUseId: id }, "before"), event(start + 1, "tool", { toolName: "Bash", toolUseId: id, isError: failed }, "after")];
    events.push(...own);
    operations.push({ id, events: own, toolName: "Bash", inputDigest: `sha256:${id}`, failed });
  }
  events.push(event(99, "message", {}, "instant", { kind: "model" }));
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events, operations, toolCapability: { status: "available" }, delegationCapability: { status: "available" },
    isCompaction: () => false, resolveContent: ({ recordLocator }) => content[recordLocator],
  });
  const observations = {
    schemaVersion: "ebo.structural-observation-set/v1", runId: "run", attemptId: "attempt", assessmentMode: "observational", extractorVersion: "1.1.0",
    normalization: { datasetDigest: `sha256:${"c".repeat(64)}` }, observations: [], occurrences, occurrenceCoverage: coverage,
  } as unknown as StructuralObservationSet;
  const capture = { runId: "run", attemptId: "attempt", qualification: "qualified", records: events.map(({ source }) => ({ reference: source.nativeReference, record: content[source.nativeReference.recordLocator] ?? {} })) } as unknown as NormalizationInput<unknown>;
  return { events, observations, capture, content };
}

const spec = (maxEvidenceItems: number): JudgePrepareSpec => ({
  schemaVersion: "ebo.judge-prepare-spec/v1",
  id: "attempt-verification",
  behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
  rubric: { id: "verification", version: "2.0.0", instructions: "Assess validation before completion." },
  evaluator: { provider: "openai", model: "fixture", effort: "low", backend: "codex-app-server" },
  limits: { maxEvidenceItems, maxRecordChars: 4_000, maxInputChars: 200_000, maxOutputChars: 8_192, maxCitations: 24, maxWallClockMs: 5_000, maxTurns: 1 },
  blinding: { evaluatedModelIdentity: "redact" },
  occurrenceTypes: ["validation-run", "failure-response"],
});

test("judge prepare records the frame and fills full records by tier without splitting occurrences", () => {
  const { events, observations } = fixture();
  const request = prepareJudgeRequest(observations, events, spec(8));
  assert.deepEqual(validateArtifact("request", request), []);
  assert.equal(request.selection.frame!.method, JUDGE_PREPARE_METHOD);
  assert.deepEqual(request.selection.occurrences, { types: ["validation-run", "failure-response"] });
  const strata = Object.fromEntries(request.selection.frame!.strata.map(({ type, population, ledgerRows, fullRecords }) => [type, [population, ledgerRows, fullRecords]]));
  assert.deepEqual(strata["validation-run"]!.slice(0, 2), [6, 6], "every validation run is a ledger row");
  assert.deepEqual(strata["failure-response"]!.slice(0, 2), [1, 1]);
  assert.ok(request.selection.eventIds.length <= 8);
  assert.ok(request.selection.eventIds.includes("event-1") && request.selection.eventIds.includes("event-99"), "the task and the final report come first");
  assert.ok(request.selection.eventIds.includes("event-12") && request.selection.eventIds.includes("event-13"), "the failing run is in full");
  const ids = new Set(request.selection.eventIds);
  for (const occurrence of observations.occurrences!) {
    const included = occurrence.eventIds.filter((id) => ids.has(id)).length;
    assert.ok(included === 0 || included === occurrence.eventIds.length, `occurrence ${occurrence.id} is whole or absent`);
  }
});

test("the judge input carries every ledger row, ratings bound by digest, and accepts occurrence citations", async () => {
  const { events, observations, capture, content } = fixture();
  const ratings = await rateOccurrences(observations, events, ({ recordLocator }) => content[recordLocator], { provider: "typesafe" }, {
    env: { TYPESAFE_API_KEY: "key" },
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => question.type === "noul"
        ? [id, { type: "noul", noul: 0.9 }]
        : [id, { type: "choice", choice: Object.keys(question.criteria!)[0], probabilities: Object.fromEntries(Object.keys(question.criteria!).map((key, index) => [key, index === 0 ? 0.7 : 0.3 / (Object.keys(question.criteria!).length - 1)])), confidence: 0.5 }]));
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 1 } }));
    }) as typeof fetch,
  });
  const boundObservations = observations;
  ratings.observationSetDigest = `sha256:${digestMetadata(boundObservations).value}`;
  const request = prepareJudgeRequest(boundObservations, events, spec(6), ratings);
  assert.equal(request.selection.occurrences!.ratingsDigest, `sha256:${digestMetadata(ratings).value}`);
  const input = packageSemanticJudgeInput(events, capture, boundObservations, request, `sha256:${"c".repeat(64)}`, "evaluated-model", ratings);
  assert.deepEqual(validateArtifact("input", input), []);
  assert.equal(input.promptVersion, "1.1.0");
  assert.equal(input.selection.ledgerOccurrenceIds!.length, observations.occurrences!.filter(({ type }) => ["validation-run", "failure-response"].includes(type)).length);
  const ledger = input.evidence.filter(({ kind }) => kind === "occurrence-ledger").flatMap(({ content: text }) => (JSON.parse(text) as { rows: Array<{ id: string; cite: { eventId: string; nativeReference: unknown }; ratings?: unknown[] }> }).rows);
  assert.equal(ledger.length, input.selection.ledgerOccurrenceIds!.length, "no ledger row is dropped");
  assert.ok(ledger.every(({ ratings: own }) => (own?.length ?? 0) > 0), "rows carry their ratings");

  const row = ledger.find(({ cite }) => !input.selection.includedEventIds.includes(cite.eventId))!;
  const response = (citation: Record<string, unknown>) => ({ judgment: { disposition: "assessed", assessment: "mixed", confidence: { value: 0.6, scale: "evaluator-reported-0-to-1" }, reason: null, missingEvidenceCapability: null, rationale: "Two runs failed before later runs passed.", alternativeExplanation: "Failures may be flaky tests.", citations: [citation] } });
  const assertion = parseSemanticJudgeResponse(response({ eventId: row.cite.eventId, nativeReference: row.cite.nativeReference, occurrenceId: row.id }), request, input, "0.157.0");
  assert.equal(assertion.judgment.citations[0]!.occurrenceId, row.id, "an occurrence known only from its ledger row can be cited");
  assert.throws(() => parseSemanticJudgeResponse(response({ eventId: input.selection.includedEventIds[0], nativeReference: { artifactId: "session", recordLocator: "line:1" }, occurrenceId: row.id }), request, input, "0.157.0"),
    /must use that ledger row's cited event/u);
  const schema = semanticJudgeResponseSchema(24, true) as { properties: { judgment: { anyOf: Array<{ properties: { citations: { maxItems: number; items: { required: string[] } } } }> } } };
  assert.equal(schema.properties.judgment.anyOf[0]!.properties.citations.maxItems, 24);
  assert.deepEqual(schema.properties.judgment.anyOf[0]!.properties.citations.items.required, ["eventId", "nativeReference", "occurrenceId"]);
});
