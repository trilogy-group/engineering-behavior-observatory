import assert from "node:assert/strict";
import test from "node:test";

import { decide, parseDecisionResponse, type DecisionQuestion } from "../src/decision-models.js";
import { checkClaims, validateClaimChecks } from "../src/claim-checks.js";
import {
  acceptedByPolicy,
  occurrenceState,
  rateOccurrences,
  validateOccurrenceRatings,
  verifyRatingRules,
} from "../src/occurrence-ratings.js";
import { extractOccurrences, type OccurrenceOperation } from "../src/occurrences.js";
import type { StructuralObservationSet } from "../src/structural-observations.js";
import type { UniformEvent } from "../src/uniform-events.js";

const questions: Record<string, DecisionQuestion> = {
  result: { type: "choice", instructions: "Did it pass?", criteria: { passed: "yes", failed: "no" } },
  ran: { type: "noul", instructions: "Did a test run?" },
  depth: { type: "score", instructions: "How deep?", criteria: ["none", "some", "full"] },
};
const env = { TYPESAFE_API_KEY: "ts-secret-key", FIREWORKS_API_KEY: "fw-secret-key", FIREWORKS_SYSTEMONE_MODEL: "accounts/fireworks/routers/example" };

/** A provider that answers every question with its first option, and records what it received. */
function provider(options: { status?: number[]; body?: (request: { model: string; questions: Record<string, DecisionQuestion> }) => unknown; headers?: Record<string, string> } = {}) {
  const calls: Array<{ url: string; authorization: string; body: { model: string; state: unknown; questions: Record<string, DecisionQuestion> } }> = [];
  const statuses = [...(options.status ?? [])];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { model: string; state: unknown; questions: Record<string, DecisionQuestion> };
    calls.push({ url: String(url), authorization: String((init!.headers as Record<string, string>).Authorization), body });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response(`{"error":"busy"}`, { status, headers: { "retry-after": "0" } });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (question.type === "noul") return [id, { type: "noul", noul: 0.97 }];
      const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
      const probabilities = Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 0.9 : 0.1 / (keys.length - 1)]));
      return [id, question.type === "choice" ? { type: "choice", choice: keys[0], probabilities, confidence: 0.85 } : { type: "score", score: 0.2, probabilities, confidence: 0.85 }];
    }));
    return new Response(JSON.stringify(options.body?.(body) ?? { model: `${body.model}-resolved`, answers, usage: { input_tokens: 120, output_tokens: 4, cached_input_tokens: 30 } }),
      { status: 200, headers: options.headers ?? {} });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

test("decide sends one request per state to the configured provider and validates every answer", async () => {
  const typesafe = provider();
  const record = await decide({ provider: "typesafe" }, { output: "PASS" }, questions, { fetch: typesafe.fetch, env });
  assert.equal(record.status, "completed");
  assert.equal(typesafe.calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(typesafe.calls[0]!.authorization, "Bearer ts-secret-key");
  assert.equal(typesafe.calls[0]!.body.model, "jev-1.13.0");
  assert.equal(record.model, "jev-1.13.0-resolved");
  assert.deepEqual(record.answers!.ran, { type: "noul", noul: 0.97 });
  assert.deepEqual(record.usage, { inputTokens: 120, outputTokens: 4, cachedInputTokens: 30 });

  const fireworks = provider({ headers: { "fireworks-server-processing-time": "0.042" } });
  const fireworksRecord = await decide({ provider: "fireworks" }, "state", questions, { fetch: fireworks.fetch, env });
  assert.equal(fireworks.calls[0]!.url, "https://api.fireworks.ai/inference/v1/systemone");
  assert.equal(fireworks.calls[0]!.body.model, "accounts/fireworks/routers/example", "the Fireworks model comes from FIREWORKS_SYSTEMONE_MODEL");
  assert.equal(fireworksRecord.serverProcessingTime, "0.042");
});

test("decide retries busy responses, records failures without answers and never leaks the key", async () => {
  const busy = provider({ status: [429, 503] });
  const slept: number[] = [];
  const retried = await decide({ provider: "typesafe" }, "s", questions, { fetch: busy.fetch, env, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(retried.status, "completed");
  assert.equal(retried.attempts, 3);
  assert.equal(slept.length, 2);
  assert.deepEqual(retried.failedResponses!.map(({ attempt, status }) => [attempt, status]), [[1, 429], [2, 503]], "retried responses are kept");

  const unauthorized = (async () => new Response("invalid key ts-secret-key", { status: 401 })) as unknown as typeof fetch;
  const failed = await decide({ provider: "typesafe" }, "s", questions, { fetch: unauthorized, env });
  assert.equal(failed.status, "failed");
  assert.equal(failed.answers, undefined);
  assert.match(failed.error!, /HTTP 401/u);
  assert.equal(failed.error!.includes("ts-secret-key"), false);
  assert.deepEqual(failed.failedResponses, [{ attempt: 1, status: 401, body: "invalid key [REDACTED]" }], "the failed body is kept, redacted");

  const missing = await decide({ provider: "fireworks" }, "s", questions, { fetch: busy.fetch, env: { FIREWORKS_SYSTEMONE_MODEL: "m" } });
  assert.match(missing.error!, /FIREWORKS_API_KEY is required/u);
  await assert.rejects(decide({ provider: "fireworks" }, "s", questions, { env: { FIREWORKS_API_KEY: "k" } }), /needs a model/u);
});

test("responses that do not match the questions fail the whole call", () => {
  const good = { model: "m", usage: { input_tokens: 1, output_tokens: 0 }, answers: {
    result: { type: "choice", choice: "passed", probabilities: { passed: 0.7, failed: 0.3 }, confidence: 0.4 },
    ran: { type: "noul", noul: 0.5 },
    depth: { type: "score", score: 1.2, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.3 },
  } };
  assert.doesNotThrow(() => parseDecisionResponse(good, questions));
  const broken = (patch: (value: typeof good) => void) => { const copy = structuredClone(good); patch(copy); return copy; };
  for (const [name, value] of [
    ["undeclared choice", broken((value) => { value.answers.result.choice = "maybe"; })],
    ["probabilities off by more than tolerance", broken((value) => { value.answers.result.probabilities.failed = 0.2; })],
    ["noul out of range", broken((value) => { value.answers.ran.noul = 1.2; })],
    ["score out of range", broken((value) => { value.answers.depth.score = 3; })],
    ["missing answer", broken((value) => { delete (value.answers as Record<string, unknown>).ran; })],
    ["missing usage", broken((value) => { delete (value as Record<string, unknown>).usage; })],
  ] as const) assert.throws(() => parseDecisionResponse(value, questions), Error, name);
});

function event(sequence: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"]): UniformEvent {
  return {
    schemaVersion: "ebo.uniform-event/v1", id: `event-${sequence}`, runId: "run", attemptId: "attempt",
    source: { harness: "fixture", nativeType: "tool", nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } },
    nativeOrder: { status: "known", value: sequence, domain: "session" },
    nativeTime: { status: "known", value: new Date(Date.UTC(2026, 9, 6, 0, 0, sequence)).toISOString() },
    actor: { kind: "tool" }, family: "tool", phase, scope: { kind: "session", id: "s" },
    relations: { parent: { status: "unknown", reason: "fixture" }, known: [] }, attributes,
    content: { status: "known", value: [{ nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } }] },
  };
}

test("occurrence ratings ask only bounded, typed questions and bind every answer to its decision record", async () => {
  const content: Record<string, unknown> = {
    "line:1": { input: { command: "pnpm exec jest src/a.test.ts" } },
    "line:2": { content: [{ type: "text", text: `FAIL src/a.test.ts\n${"x".repeat(20_000)}\nTests: 1 failed` }, { type: "thinking", thinking: "hidden reasoning" }] },
    "line:3": { input: { command: "pnpm exec jest src/a.test.ts --runInBand" } },
    "line:4": { content: "Tests: 4 passed" },
    "line:5": { input: { command: "pnpm exec jest" } },
  };
  const operation = (id: string, events: UniformEvent[], failed: boolean): OccurrenceOperation => ({ id, events, toolName: "Bash", inputDigest: `sha256:${id}`, failed });
  const failing = operation("a", [event(1, { toolName: "Bash", toolUseId: "a" }, "before"), event(2, { toolName: "Bash", toolUseId: "a", isError: true }, "after")], true);
  const passing = operation("b", [event(3, { toolName: "Bash", toolUseId: "b" }, "before"), event(4, { toolName: "Bash", toolUseId: "b", isError: false }, "after")], false);
  const unanswered = operation("c", [event(5, { toolName: "Bash", toolUseId: "c" }, "before")], false);
  const operations = [failing, passing, unanswered];
  const events = operations.flatMap(({ events: own }) => own);
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events, operations, toolCapability: { status: "available" }, delegationCapability: { status: "available" },
    isCompaction: () => false, resolveContent: ({ recordLocator }) => content[recordLocator],
  });
  const observationSet = { runId: "run", attemptId: "attempt", normalization: { datasetDigest: `sha256:${"a".repeat(64)}` }, occurrences, occurrenceCoverage: coverage } as unknown as StructuralObservationSet;

  const failure = occurrences.find(({ type }) => type === "failure-response")!;
  const { state, omittedCharacters } = occurrenceState(failure, new Map(events.map((value) => [value.id, value])), ({ recordLocator }) => content[recordLocator]);
  const calls = state.calls as Array<{ position: string; input?: string; output?: string; nativeResult: string }>;
  assert.deepEqual(calls.map(({ position, nativeResult }) => [position, nativeResult]), [["failure 1", "failed"], ["response", "passed"]]);
  assert.ok(omittedCharacters > 0 && calls[0]!.output!.includes("characters omitted from this request"), "long output keeps head and tail with a marked omission");
  assert.ok(calls[0]!.output!.startsWith("FAIL") && calls[0]!.output!.endsWith("Tests: 1 failed"));
  assert.equal(JSON.stringify(state).includes("hidden reasoning"), false, "hidden reasoning is never sent");

  const fake = provider();
  const streamed: string[] = [];
  const ratings = await rateOccurrences(observationSet, events, ({ recordLocator }) => content[recordLocator], { provider: "typesafe" },
    { fetch: fake.fetch, env, now: () => new Date("2026-10-06T00:00:00.000Z"), onDecision: (_record, occurrenceId) => streamed.push(occurrenceId) });
  assert.equal(streamed.length, ratings.coverage.asked, "every decision is handed to the caller as it finishes");
  validateOccurrenceRatings(ratings);
  assert.equal(ratings.coverage.failedDecisions, 0);
  assert.equal(fake.calls.length, ratings.coverage.asked, "one request per rated occurrence, all its questions together");
  assert.ok(fake.calls.every(({ body }) => Object.keys(body.questions).length >= 1));
  const byType = (type: string) => ratings.ratings.filter(({ occurrenceType }) => occurrenceType === type).map(({ questionId, label, accepted, source }) => [questionId, label, accepted, source]);
  assert.deepEqual(byType("failure-response"), [["response", "addressed-cause", true, "model"]]);
  assert.deepEqual(byType("validation-run").sort(), [
    ["outcome", "all-passed", true, "model"], ["outcome", "all-passed", true, "model"], ["outcome", "all-passed", true, "model"],
    ["targeted", "yes", true, "model"], ["targeted", "yes", true, "model"], ["targeted", "yes", true, "model"],
  ]);

  const tampered = structuredClone(ratings);
  tampered.ratings[0]!.label = "retried-unchanged";
  tampered.ratings[0]!.answer = { ...tampered.ratings[0]!.answer!, choice: "retried-unchanged" } as never;
  assert.throws(() => validateOccurrenceRatings(tampered), /differs from its decision record/u);
  const relabeled = structuredClone(ratings);
  relabeled.ratings[0]!.label = "retried-unchanged";
  assert.throws(() => validateOccurrenceRatings(relabeled), /label .* differs from its answer/u, "labels are derived from answers, not trusted");
  assert.equal(acceptedByPolicy({ type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.3 }, ratings.policy), false);
  assert.equal(acceptedByPolicy({ type: "noul", noul: 0.95 }, ratings.policy), true);
});

test("a failure with no later call is rated by rule without asking the model", async () => {
  const lone = { id: "a", events: [event(1, { toolName: "Bash", toolUseId: "a" }, "before"), event(2, { toolName: "Bash", toolUseId: "a", isError: true }, "after")], toolName: "Bash", inputDigest: "sha256:a", failed: true };
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events: lone.events, operations: [lone], toolCapability: { status: "available" }, delegationCapability: { status: "available" },
    isCompaction: () => false, resolveContent: () => undefined,
  });
  const observationSet = { runId: "run", attemptId: "attempt", normalization: { datasetDigest: `sha256:${"b".repeat(64)}` }, occurrences, occurrenceCoverage: coverage } as unknown as StructuralObservationSet;
  const fake = provider();
  const ratings = await rateOccurrences(observationSet, lone.events, () => undefined, { provider: "typesafe" }, { fetch: fake.fetch, env });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(ratings.ratings.map(({ source, label, rule }) => [source, label, rule]), [["rule", "no-response", "no later call of the tool in the same session"]]);
  validateOccurrenceRatings(ratings);
  verifyRatingRules(ratings, observationSet, lone.events, () => undefined);
  const lost = structuredClone(ratings);
  lost.ratings = [];
  lost.coverage.byRule = 0;
  validateOccurrenceRatings(lost);
  assert.throws(() => verifyRatingRules(lost, observationSet, lone.events, () => undefined), /Rule ratings differ/u, "dropping the only rule rating is evidence loss");
  const forged = structuredClone(ratings);
  forged.ratings[0]!.label = "addressed-cause";
  assert.throws(() => validateOccurrenceRatings(forged), /not a known rule/u);
});

test("claim checks route unsupported or uncertain claims to review and bind to the assertion", async () => {
  const citation = { eventId: "event-1", nativeReference: { artifactId: "session", recordLocator: "line:1" } };
  const assertion = {
    schemaVersion: "ebo.behavior-assertion/v1", id: "a-1", runId: "run", attemptId: "attempt", dataset: { schemaVersion: "ebo.normalized-dataset/v1", digest: `sha256:${"d".repeat(64)}` },
    behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" }, rubric: { id: "r", version: "1" },
    evaluator: { id: "openai/x", version: "1", configurationDigest: `sha256:${"e".repeat(64)}` },
    judgment: { disposition: "assessed", assessment: "constructive", confidence: { value: 0.8, scale: "evaluator-reported-0-to-1" }, rationale: "r", alternativeExplanation: "a", citations: [citation],
      claims: [{ id: "passed", text: "All tests passed.", citations: [citation], workspace: null }, { id: "typed", text: "Typecheck passed.", citations: [citation], workspace: null }] },
  } as unknown as Parameters<typeof checkClaims>[0];
  const capture = { runId: "run", attemptId: "attempt", qualification: "qualified", records: [{ reference: citation.nativeReference, record: { content: [{ type: "thinking", thinking: "SECRET-THOUGHT" }, { type: "text", text: "Tests: 4 passed" }] } }] } as never;
  const seen: unknown[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { state: { claim: { text: string } } };
    seen.push(body.state);
    const supported = body.state.claim.text.startsWith("All");
    const probabilities = supported ? { supported: 0.95, contradicted: 0.02, insufficient: 0.03 } : { supported: 0.2, contradicted: 0.1, insufficient: 0.7 };
    return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 5, output_tokens: 1 },
      answers: { support: { type: "choice", choice: supported ? "supported" : "insufficient", probabilities, confidence: supported ? 0.95 : 0.7 } } }));
  }) as typeof fetch;
  const streamed: string[] = [];
  const checks = await checkClaims(assertion, capture, { provider: "typesafe" }, { fetch: fetchImpl, env, onDecision: (_record, claimId) => streamed.push(claimId) });
  assert.deepEqual(streamed.sort(), ["passed", "typed"], "each decision is handed to the caller as it finishes");
  assert.deepEqual(checks.checks.map(({ claimId, label, flagged }) => [claimId, label, flagged]), [["passed", "supported", false], ["typed", "insufficient", true]]);
  assert.deepEqual(checks.coverage, { claims: 2, checked: 2, failedDecisions: 0, supported: 1, flagged: 1 });
  assert.equal(JSON.stringify(seen).includes("SECRET-THOUGHT"), false, "hidden reasoning is not sent");
  validateClaimChecks(checks, assertion);
  const forged = structuredClone(checks);
  forged.checks[1]!.flagged = false;
  forged.coverage.flagged = 0;
  assert.throws(() => validateClaimChecks(forged, assertion), /contradicts its answer/u);
  const swapped = structuredClone(checks);
  swapped.checks[1]!.decision = 0;
  swapped.checks[1]!.answer = swapped.checks[0]!.answer;
  swapped.checks[1]!.label = "supported";
  swapped.checks[1]!.flagged = false;
  swapped.coverage = { ...swapped.coverage, supported: 2, flagged: 0 };
  assert.throws(() => validateClaimChecks(swapped, assertion), /every claim once/u, "a check cannot borrow another claim's decision");
  const misstated = structuredClone(checks);
  (misstated.decisions[1]!.request.state as { claim: { text: string } }).claim.text = "Something else.";
  assert.throws(() => validateClaimChecks(misstated, assertion), /different claim/u, "each decision must be about its own claim");
  validateClaimChecks(checks, assertion, capture);
  const omitted = structuredClone(checks);
  omitted.checks.pop();
  omitted.coverage = { ...omitted.coverage, checked: 1, flagged: 0 };
  assert.throws(() => validateClaimChecks(omitted, assertion), /every claim once/u, "a check cannot be dropped");
  const recounted = structuredClone(checks);
  recounted.coverage.flagged = 0;
  assert.throws(() => validateClaimChecks(recounted, assertion), /coverage differs/u);
  const substituted = structuredClone(checks);
  (substituted.decisions[0]!.request.state as { citedRecords: Array<{ record: string }> }).citedRecords[0]!.record = "Tests: 99 passed";
  assert.throws(() => validateClaimChecks(substituted, assertion, capture), /differ from the cited native records/u);
  const changed = structuredClone(assertion) as typeof assertion;
  (changed.judgment as { rationale: string }).rationale = "edited";
  assert.throws(() => validateClaimChecks(checks, changed), /different assertion/u);
});

test("question set 1.1: silent success is a rule rating, source changes between failure and response are a fact, deferred answers go to the fallback", async () => {
  const at = (sequence: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"]) => event(sequence, attributes, phase);
  const content: Record<string, unknown> = {
    "line:1": { input: { command: "pnpm exec jest src/a.test.ts" } }, "line:2": { content: "Tests: 1 failed" },
    "line:3": { input: { file_path: "src/a.ts" } }, "line:4": { content: "ok" },
    "line:5": { input: { command: "pnpm exec jest src/a.test.ts" } }, "line:6": { content: "Tests: 1 passed" },
    "line:7": { input: { command: "npx tsc --noEmit" } }, "line:8": { content: "(Bash completed with no output)" },
  };
  const op = (id: string, events: UniformEvent[], failed: boolean, toolName = "Bash"): OccurrenceOperation => ({ id, events, toolName, inputDigest: `sha256:${id}`, failed });
  const failing = op("a", [at(1, { toolName: "Bash", toolUseId: "a" }, "before"), at(2, { toolName: "Bash", toolUseId: "a", isError: true }, "after")], true);
  const edit = op("e", [at(3, { toolName: "Edit", toolUseId: "e" }, "before"), at(4, { toolName: "Edit", toolUseId: "e", isError: false }, "after")], false, "Edit");
  const rerun = op("b", [at(5, { toolName: "Bash", toolUseId: "b" }, "before"), at(6, { toolName: "Bash", toolUseId: "b", isError: false }, "after")], false);
  const silent = op("c", [at(7, { toolName: "Bash", toolUseId: "c" }, "before"), at(8, { toolName: "Bash", toolUseId: "c", isError: false }, "after")], false);
  const operations = [failing, edit, rerun, silent];
  const events = operations.flatMap(({ events: own }) => own);
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events, operations, toolCapability: { status: "available" }, delegationCapability: { status: "available" },
    isCompaction: () => false, resolveContent: ({ recordLocator }) => content[recordLocator],
  });
  const observationSet = { runId: "run", attemptId: "attempt", normalization: { datasetDigest: `sha256:${"a".repeat(64)}` }, occurrences, occurrenceCoverage: coverage } as unknown as StructuralObservationSet;
  const sent: Array<{ state: { facts: Record<string, unknown> }; questions: Record<string, unknown> }> = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { state: { facts: Record<string, unknown> }; questions: Record<string, DecisionQuestion> };
    sent.push(body);
    // Low confidence everywhere, so every model answer is deferred to the fallback.
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => question.type === "noul" ? [id, { type: "noul", noul: 0.6 }]
      : [id, { type: "choice", choice: Object.keys((question as { criteria: Record<string, string> }).criteria)[0], probabilities: Object.fromEntries(Object.keys((question as { criteria: Record<string, string> }).criteria).map((key, index, all) => [key, index === 0 ? 0.5 : 0.5 / (all.length - 1)])), confidence: 0.5 }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 5, output_tokens: 1 } }));
  }) as typeof fetch;
  const prompts: string[] = [];
  const fallback = { model: "reasoner", effort: "low" as const, batchSize: 2, run: async (prompt: string, schema: Record<string, unknown>) => {
    prompts.push(prompt);
    const items = (JSON.parse(prompt.slice(prompt.indexOf("<STATE_DATA>\n") + 13, prompt.indexOf("\n</STATE_DATA>"))) as { items: Array<{ occurrenceId: string; questions: Record<string, { type: string; criteria?: Record<string, string> }> }> }).items;
    assert.ok(JSON.stringify(schema).includes('"rationale"'));
    return { status: "completed" as const, raw: {}, response: { answers: items.flatMap(({ occurrenceId, questions }) => Object.entries(questions).map(([questionId, question]) => ({
      occurrenceId, questionId, label: question.type === "noul" ? "no" : Object.keys(question.criteria!)[1]!, rationale: "Read from the state." }))) } };
  } };
  const records: unknown[] = [];
  const ratings = await rateOccurrences(observationSet, events, ({ recordLocator }) => content[recordLocator], { provider: "typesafe" }, { fetch: fetchImpl, env, fallback, onFallback: (record) => records.push(record) });
  validateOccurrenceRatings(ratings);
  const failureState = sent.find(({ questions }) => "response" in questions)!;
  assert.equal(failureState.state.facts.sourceChangesBetween, 1, "the edit between the failure and the re-run is a fact");
  const silentRatings = ratings.ratings.filter(({ occurrenceId }) => occurrenceId.endsWith("/event-7"));
  assert.deepEqual(silentRatings.filter(({ questionId }) => questionId === "outcome").map(({ source, label }) => [source, label]), [["rule", "all-passed"]], "exit success with no output is a pass by rule, not asked");
  assert.ok(sent.every(({ questions }) => !("outcome" in questions) || !JSON.stringify(questions).includes("silent")));
  const fallbacks = ratings.ratings.filter(({ source }) => source === "fallback");
  assert.equal(fallbacks.length, ratings.coverage.deferred, "every deferred answer has a fallback answer");
  assert.ok(fallbacks.every(({ rationale, accepted }) => rationale === "Read from the state." && accepted));
  assert.equal(records.length, Math.ceil(new Set(fallbacks.map(({ occurrenceId }) => occurrenceId)).size / 2));
  assert.equal(ratings.coverage.failedFallbacks, 0);
  const forged = structuredClone(ratings);
  forged.ratings.find(({ source }) => source === "fallback")!.label = "unclear";
  assert.throws(() => validateOccurrenceRatings(forged), /Fallback rating/u);
  const banana = structuredClone(ratings);
  const fallbackRating = banana.ratings.find(({ source }) => source === "fallback")!;
  const record = banana.fallbackDecisions![fallbackRating.fallback!]!;
  (record.response as { answers: Array<{ occurrenceId: string; questionId: string; label: string }> }).answers
    .find(({ occurrenceId, questionId }) => occurrenceId === fallbackRating.occurrenceId && questionId === fallbackRating.questionId)!.label = "banana";
  fallbackRating.label = "banana";
  assert.throws(() => validateOccurrenceRatings(banana), /Fallback rating/u, "a fallback label must be one the question allows");
  verifyRatingRules(ratings, observationSet, events, ({ recordLocator }) => content[recordLocator]);
  const invented = structuredClone(ratings);
  const noisy = occurrences.find(({ type, eventIds }) => type === "validation-run" && eventIds[0] === "event-5")!;
  invented.ratings.push({ occurrenceId: noisy.id, occurrenceType: "validation-run", questionId: "outcome", source: "rule", label: "all-passed", accepted: true, rule: "native success with empty output" });
  assert.throws(() => validateOccurrenceRatings(invented), /two primary ratings/u, "a pass by rule cannot sit beside the asked answer");
  invented.ratings = invented.ratings.filter(({ occurrenceId, questionId, source }) => !(occurrenceId === noisy.id && questionId === "outcome" && source !== "rule"));
  assert.throws(() => validateOccurrenceRatings(invented), /has no rating/u, "nor replace it");
  const dropped = structuredClone(ratings);
  dropped.ratings.splice(dropped.ratings.findIndex(({ source }) => source === "fallback"), 1);
  dropped.coverage.fallback = dropped.coverage.fallback! - 1;
  assert.throws(() => validateOccurrenceRatings(dropped), /completed fallback answer .* has no rating/u, "a retained fallback answer cannot be discarded");
  const onlyFailures = await rateOccurrences(observationSet, events, ({ recordLocator }) => content[recordLocator], { provider: "typesafe" }, { fetch: fetchImpl, env, types: ["failure-response"] });
  assert.equal(sent.at(-1)!.state.facts.sourceChangesBetween, 1, "supporting facts count every source change, whichever types are rated");
  verifyRatingRules(onlyFailures, observationSet, events, ({ recordLocator }) => content[recordLocator]);
  const restated = structuredClone(ratings);
  const restatedRating = restated.ratings.find(({ source }) => source === "fallback")!;
  const restatedItem = restated.fallbackDecisions![restatedRating.fallback!]!.request.items.find(({ occurrenceId }) => occurrenceId === restatedRating.occurrenceId)!;
  restatedItem.state = { fabricated: true };
  assert.throws(() => validateOccurrenceRatings(restated), /Fallback rating/u, "the fallback must have seen the deferred decision's state");
  const legacy = structuredClone(ratings);
  legacy.questionSetVersion = "1.0.0";
  assert.throws(() => validateOccurrenceRatings(legacy), /question set/u, "1.0 artifacts are checked against the 1.0 questions");

  const broken = await rateOccurrences(observationSet, events, ({ recordLocator }) => content[recordLocator], { provider: "typesafe" }, { fetch: fetchImpl, env,
    fallback: { ...fallback, run: async () => ({ status: "completed" as const, raw: {}, response: { answers: [] } }) } });
  assert.equal(broken.ratings.filter(({ source }) => source === "fallback").length, 0, "answers that do not match the questions are recorded, never used");
  assert.ok((broken.coverage.failedFallbacks ?? 0) > 0);
  assert.match(broken.fallbackDecisions![0]!.error!, /do not match/u);
  const timedOut = await rateOccurrences(observationSet, events, ({ recordLocator }) => content[recordLocator], { provider: "typesafe" }, { fetch: fetchImpl, env,
    fallback: { ...fallback, run: async () => ({ status: "failed" as const, kind: "timeout" as const, message: "Codex judge exceeded maxWallClockMs.", rawModelResponse: { content: "{\"answers\": [", truncated: false }, raw: { threadId: "t", turnId: "u" } }) } });
  assert.deepEqual(timedOut.fallbackDecisions![0]!.rawModelResponse, { content: "{\"answers\": [", truncated: false }, "partial model output of a failed call is kept");
  assert.deepEqual(timedOut.fallbackDecisions![0]!.raw, { threadId: "t", turnId: "u" });
});
