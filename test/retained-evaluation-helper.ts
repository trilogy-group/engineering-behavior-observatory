import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAtlas, queryAtlas } from "../src/atlas.js";
import { writeCorpusIndex } from "../src/corpus.js";
import { aggregateEvaluation, buildCorpusIndex, createRetainedBehaviorEvidence, createRetainedStructuralObservationSet,
  digestBytes, digestMetadata, main, probeClaudeAgentSdkCapabilities, runRetainedSemanticJudge, selectReviewSample, writeReviewPacket, validateArtifact, CODEX_APP_SERVER_VERSION,
  type BehaviorAssertion, type ReviewHistory, type SemanticJudgeRequest } from "../src/index.js";

const digest = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;

/** Used by actual retained capture fixtures for every implemented harness. Synthetic reviews only. */
export async function checkRetainedEvaluation(bundleRoot: string, outputRoot: string): Promise<void> {
  const before = readFileSync(join(bundleRoot, "manifest.json"));
  const evidence = await createRetainedBehaviorEvidence(bundleRoot);
  const observations = await createRetainedStructuralObservationSet(bundleRoot);
  if (evidence.dataset.adapter.harness === "openhands-agent-server") {
    const version = (JSON.parse(before.toString("utf8")) as { run: { harness: { version: string } } }).run.harness.version;
    assert.equal(evidence.dataset.adapter.version, version);
    assert.equal(evidence.dataset.adapter.id, `openhands-agent-server-v${version}`);
  }
  assert.ok(evidence.dataset.events.length > 0);
  assert.equal(await main(["observations", "create", bundleRoot, join(outputRoot, "observations.json")], () => undefined), 0);
  const event = evidence.dataset.events[0]!;
  const request: SemanticJudgeRequest = {
    schemaVersion: "ebo.semantic-judge-request/v1", id: "synthetic-retained-judge",
    behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
    rubric: { id: "synthetic-only", version: "1.0.0", instructions: "Synthetic fixture." },
    evaluator: { provider: "anthropic", model: "fixture-judge", effort: "low" },
    selection: { eventIds: [event.id], structuralObservationIds: [], includeOutcomeObservations: false },
    limits: { maxEvidenceItems: 4, maxRecordChars: 4096, maxInputChars: 20000, maxOutputChars: 16000, maxCitations: 2, maxWallClockMs: 1000, maxTurns: 1 },
    blinding: { evaluatedModelIdentity: "redact" },
  };
  for (const backend of ["claude-agent-sdk", "codex-app-server"] as const) {
    const configured = structuredClone(request);
    configured.evaluator.backend = backend;
    configured.evaluator.provider = backend === "claude-agent-sdk" ? "anthropic" : "openai";
    const result = await runRetainedSemanticJudge({ bundleRoot, observations, request: configured, outputRoot: join(outputRoot, backend),
      backend: { id: backend, version: backend === "claude-agent-sdk" ? probeClaudeAgentSdkCapabilities().sdkVersion : CODEX_APP_SERVER_VERSION,
        run: async () => ({ status: "completed", raw: { synthetic: true }, response: { judgment: { disposition: "assessed", assessment: "constructive",
          confidence: { value: 0.8, scale: "evaluator-reported-0-to-1" }, reason: null, missingEvidenceCapability: null,
          rationale: "Synthetic fixture only.", alternativeExplanation: "Not a human decision.", citations: [{ eventId: event.id, nativeReference: event.source.nativeReference }] } } }) } });
    assert.equal(result.status, "proposed", JSON.stringify(result));
  }
  const assertion = JSON.parse(readFileSync(join(outputRoot, "claude-agent-sdk/assertion.json"), "utf8")) as BehaviorAssertion;
  const assertPath = join(outputRoot, "assertion.json");
  const reports = [];
  for (const assessment of ["constructive", "adverse"] as const) {
    if (assertion.judgment.disposition === "assessed") assertion.judgment.assessment = assessment;
    writeFileSync(assertPath, JSON.stringify(assertion));
    assert.equal(await main(["assertions", "validate", bundleRoot, assertPath], () => undefined), 0);
    const selection = await selectReviewSample({ schemaVersion: "ebo.review-source-set/v1", sources: [{ bundleRoot, assertionPath: assertPath, taskContext: "SYNTHETIC TEST" }] },
      { schemaVersion: "ebo.review-sample-criteria/v1", seed: "fixture", strata: [{ id: "all", sampleSize: 1, filters: {} }] });
    await writeReviewPacket(selection, join(outputRoot, `packet-${assessment}`));
    const history: ReviewHistory = { schemaVersion: "ebo.review-history/v1", selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) }, decisions: [{
      schemaVersion: "ebo.human-review-decision/v1", id: "synthetic-only", kind: "review", assertion: selection.candidates[0]!.assertion,
      reviewer: { kind: "human", id: "SYNTHETIC-TEST-FIXTURE" }, decidedAt: "2026-09-07T00:00:00Z", state: "confirmed", rationale: "Synthetic test.", previousHistory: null,
    }] };
    const input = { corpusEntries: buildCorpusIndex(bundleRoot), observationSets: [{ bundleRoot, document: observations }], assertions: [{ bundleRoot, document: assertion }], calibrations: [{ selection, history }], comparisons: [] };
    const policy = { groupBy: ["task" as const], selectedAttemptPolicy: "all-attempts" as const, recurrence: { minimumOccurrences: 2 } };
    const report = await aggregateEvaluation(input, policy);
    const atlasPrefix = join(outputRoot, `atlas-${assessment}`);
    writeCorpusIndex(`${atlasPrefix}.index.jsonl`, input.corpusEntries);
    writeFileSync(`${atlasPrefix}.selection.json`, JSON.stringify(selection));
    writeFileSync(`${atlasPrefix}.history.json`, JSON.stringify(history));
    writeFileSync(`${atlasPrefix}.aggregation.json`, JSON.stringify({ schemaVersion: "ebo.aggregation-request/v1", ...policy,
      sources: { corpusRoot: bundleRoot, corpusIndex: `${atlasPrefix}.index.jsonl`, observationSets: [{ bundleRoot, path: join(outputRoot, "observations.json") }], assertions: [{ bundleRoot, path: assertPath }], calibrations: [{ selection: `${atlasPrefix}.selection.json`, history: `${atlasPrefix}.history.json` }] }, comparisons: [] }));
    writeFileSync(`${atlasPrefix}.request.json`, JSON.stringify({ schemaVersion: "ebo.atlas-request/v1", aggregationRequest: `${atlasPrefix}.aggregation.json`, title: "Synthetic retained-harness Atlas" }));
    const atlas = await queryAtlas(await loadAtlas(`${atlasPrefix}.request.json`));
    assert.deepEqual(atlas.report.groups, report.groups);
    assert.equal(atlas.cases[0]!.assessment, assessment);
    assert.ok(atlas.cases[0]!.citations[0]!.nativeRecord, "each harness exposes its real cited native record to Atlas");
    const behavior = report.groups[0]!.behaviors![0]!;
    const permuted = structuredClone(report);
    permuted.groups[0]!.behaviors![0]!.assessments = [...behavior.assessments].reverse();
    assert.deepEqual(validateArtifact("permuted behavior assessments", permuted), []);
    const repeated = structuredClone(report);
    repeated.groups[0]!.behaviors![0]!.assessments[1]!.assessment = behavior.assessments[0]!.assessment;
    assert.ok(validateArtifact("duplicate behavior assessment", repeated).length > 0);
    assert.equal(behavior.assessments.find((value) => value.assessment === assessment)!.measurement.rate, 1);
    assert.equal(behavior.assertions[0]!.included, true);
    const unreviewed = await aggregateEvaluation({ ...input, calibrations: [] }, policy);
    assert.equal(unreviewed.groups[0]!.behaviors![0]!.assessments[0]!.measurement.status, "unavailable");
    const disputedHistory = structuredClone(history);
    disputedHistory.decisions[0]!.state = "disputed";
    const disputed = await aggregateEvaluation({ ...input, calibrations: [{ selection, history: disputedHistory }] }, policy);
    assert.equal(disputed.groups[0]!.behaviors![0]!.assertions[0]!.included, false);
    assert.equal(disputed.groups[0]!.behaviors![0]!.assessments[0]!.measurement.denominator.value, 0);
    reports.push(report);
  }
  assert.notDeepEqual(reports[0]!.groups, reports[1]!.groups);
  const rerun = structuredClone(assertion);
  rerun.id = "rerun";
  const otherRubric = structuredClone(assertion);
  otherRubric.id = "other-rubric";
  otherRubric.rubric.version = "2.0.0";
  const values = [assertion, rerun, otherRubric];
  for (const conflict of [false, true]) {
    if (conflict && rerun.judgment.disposition === "assessed") rerun.judgment.assessment = "constructive";
    const sources = values.map((document) => {
      const assertionPath = join(outputRoot, `${document.id}.json`);
      writeFileSync(assertionPath, JSON.stringify(document));
      return { bundleRoot, assertionPath, taskContext: "SYNTHETIC RERUN TEST" };
    });
    const selection = await selectReviewSample({ schemaVersion: "ebo.review-source-set/v1", sources },
      { schemaVersion: "ebo.review-sample-criteria/v1", seed: "fixture", strata: [{ id: "all", sampleSize: 3, filters: {} }] });
    const history: ReviewHistory = { schemaVersion: "ebo.review-history/v1", selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) }, decisions: [] };
    for (const candidate of selection.candidates) {
      const previousHistory = history.decisions.length === 0 ? null : { schemaVersion: history.schemaVersion, digest: digest(history) };
      history.decisions = [...history.decisions, { schemaVersion: "ebo.human-review-decision/v1", id: `review-${candidate.assertion.id}`, kind: "review", assertion: candidate.assertion,
        reviewer: { kind: "human", id: "SYNTHETIC-TEST-FIXTURE" }, decidedAt: "2026-09-07T00:00:00Z", state: "confirmed", rationale: "Synthetic test.", previousHistory }];
    }
    const report = await aggregateEvaluation({ corpusEntries: buildCorpusIndex(bundleRoot), observationSets: [], assertions: values.map((document) => ({ bundleRoot, document })),
      calibrations: [{ selection, history }], comparisons: [] }, { groupBy: [], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 } });
    assert.equal(report.groups[0]!.behaviors!.length, 2);
    const original = report.groups[0]!.behaviors!.find(({ rubric }) => rubric.version === "1.0.0")!;
    assert.equal(original.assessments[0]!.measurement.denominator.value, conflict ? 0 : 1);
    if (conflict) assert.equal(original.assessments[0]!.measurement.exclusions[0]!.reason, "conflicting-confirmed-reruns");
  }
  assert.deepEqual(readFileSync(join(bundleRoot, "manifest.json")), before);
  if (["codex-app-server", "openhands-agent-server", "deepseek-harness"].includes(evidence.dataset.adapter.harness)) {
    const manifest = JSON.parse(before.toString());
    const session = manifest.evidence.find((entry: { kind: string }) => entry.kind === "session");
    const path = join(bundleRoot, session.relativePath);
    const original = readFileSync(path);
    const sourceMutations = evidence.dataset.adapter.harness === "codex-app-server" ? ["source", "client-source", "method", "client-thread", "client-turn",
      "missing-thread-request", "missing-turn-request", "mismatched-thread-rpc", "mismatched-turn-rpc", "duplicate-thread-request", "duplicate-turn-request",
      "duplicate-thread-response", "duplicate-turn-response", "foreign-turn-request", "foreign-turn-response", "late-turn-request", "early-terminal"]
      : evidence.dataset.adapter.harness === "openhands-agent-server" ? ["server-version", "missing-server-info", "duplicate-server-info", "foreign-conversation", "foreign-final", "missing-final", "error-final", "stuck-final"]
        : ["client-version", "early-reap", "early-and-late-reap"];
    for (const mutation of ["schema", "sequence", ...sourceMutations]) {
      let records = original.toString().trim().split("\n").map((line) => JSON.parse(line));
      if (mutation === "schema") records[0].schemaVersion = "not-native";
      if (mutation === "sequence") records[0].sequence = 2;
      if (mutation === "source") records.find((record) => record.kind === "notification" && record.method === "item/completed").source = "foreign-runtime";
      if (mutation === "client-source") records.find((record) => record.kind === "notification" && record.method === "item/completed").source = "ebo-codex-client";
      if (mutation === "method") delete records[0].method;
      if (mutation === "client-thread" || mutation === "client-turn") records.find((record) => record.kind === "response"
        && record.method === (mutation === "client-thread" ? "thread/start" : "turn/start")).source = "ebo-codex-client";
      if (/^(missing|mismatched|duplicate)-(thread|turn)-(request|response|rpc)$/u.test(mutation)) {
        const method = mutation.includes("thread") ? "thread/start" : "turn/start";
        const kind = mutation.endsWith("response") ? "response" : "request";
        const selected = records.find((record) => record.kind === kind && record.method === method);
        if (mutation.startsWith("missing")) records = records.filter((record) => record !== selected);
        if (mutation.startsWith("mismatched")) selected.id = "unmatched-rpc-id";
        if (mutation.startsWith("duplicate")) records.push(structuredClone(selected));
        records = records.map((record, index) => ({ ...record, sequence: index + 1 }));
      }
      if (mutation === "foreign-turn-request") records.find((record) => record.kind === "request" && record.method === "turn/start").payload.threadId = "foreign-thread";
      if (mutation === "foreign-turn-response") records.find((record) => record.kind === "response" && record.method === "turn/start").payload.turn.threadId = "foreign-thread";
      if (mutation === "late-turn-request" || mutation === "early-terminal") {
        const selected = records.find((record) => mutation === "late-turn-request"
          ? record.kind === "request" && record.method === "turn/start" : record.kind === "notification" && record.method === "turn/completed");
        records = records.filter((record) => record !== selected);
        if (mutation === "late-turn-request") records.push(selected); else records.unshift(selected);
        records = records.map((record, index) => ({ ...record, sequence: index + 1 }));
      }
      if (mutation === "server-version") records.find((record) => record.channel === "server-info").payload.version = "0.0.0";
      if (mutation === "missing-server-info") records = records.filter((record) => record.channel !== "server-info").map((record, index) => ({ ...record, sequence: index + 1 }));
      if (mutation === "duplicate-server-info") records = [records.find((record) => record.channel === "server-info"), ...records].map((record, index) => ({ ...record, sequence: index + 1 }));
      if (mutation === "foreign-conversation") records.find((record) => record.channel === "rest-event").session_id = "foreign-conversation";
      if (mutation === "foreign-final") records.find((record) => record.channel === "conversation-final").payload.id = "foreign-conversation";
      if (mutation === "missing-final") records = records.filter((record) => record.channel !== "conversation-final").map((record, index) => ({ ...record, sequence: index + 1 }));
      if (mutation === "error-final" || mutation === "stuck-final") records.find((record) => record.channel === "conversation-final").payload.execution_status = mutation === "error-final" ? "error" : "stuck";
      if (mutation === "client-version") records.find((record) => record.kind === "composition").payload.runtime.clientVersion = "0.0.0";
      if (mutation === "early-reap" || mutation === "early-and-late-reap") {
        const close = records.find((record) => record.kind === "response" && record.method === "client.close");
        records = [close, ...records.filter((record) => mutation === "early-and-late-reap" || record !== close)].map((record, index) => ({ ...record, sequence: index + 1 }));
      }
      const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      const changed = structuredClone(manifest);
      const descriptor = changed.evidence.find((entry: { id: string }) => entry.id === session.id);
      descriptor.digest = `sha256:${digestBytes(bytes).value}`;
      descriptor.sizeBytes = bytes.length;
      const report = changed.evidence.find((entry: { kind: string }) => entry.kind === "capture-report");
      const reportPath = join(bundleRoot, report.relativePath);
      const reportBefore = readFileSync(reportPath);
      try {
        if (mutation === "foreign-conversation") {
          const document = JSON.parse(reportBefore.toString());
          const reportBytes = Buffer.from(JSON.stringify({ ...document, relatedSessionIds: [...(document.relatedSessionIds ?? []), "foreign-conversation"] }));
          report.digest = `sha256:${digestBytes(reportBytes).value}`;
          report.sizeBytes = reportBytes.length;
          writeFileSync(reportPath, reportBytes);
        }
        writeFileSync(path, bytes);
        writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify(changed));
        await assert.rejects(createRetainedBehaviorEvidence(bundleRoot), /native envelope|protocol observation|protocol method|owned identity|request\/response pair|owned terminal evidence|native server version|server-info record|conversation identity|finished conversation|native client version|runtime-reap evidence/u, mutation);
      } finally {
        writeFileSync(path, original);
        writeFileSync(reportPath, reportBefore);
        writeFileSync(join(bundleRoot, "manifest.json"), before);
      }
    }
  }
  if (["openhands-agent-server", "deepseek-harness"].includes(evidence.dataset.adapter.harness)) {
    const changed = JSON.parse(before.toString());
    changed.run.harness.version = "unsupported-fixture-version";
    try {
      writeFileSync(join(bundleRoot, "manifest.json"), JSON.stringify(changed));
      await assert.rejects(createRetainedBehaviorEvidence(bundleRoot), /Unsupported retained (OpenHands|DeepSeek) runtime/u);
    } finally { writeFileSync(join(bundleRoot, "manifest.json"), before); }
    assert.deepEqual(readFileSync(join(bundleRoot, "manifest.json")), before);
  }
}
