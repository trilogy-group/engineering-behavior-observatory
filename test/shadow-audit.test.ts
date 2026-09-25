import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { boundedEvidence, visibleEvidence, evidenceWorkspaces } from "../src/evidence-projection.js";
import { auditBehaviorAssertion, JEV_MODEL, parseJevResponse, shadowDigest, summarizeShadow, validateShadowReview, writeShadowArtifact, type ShadowReview, type ShadowSelection } from "../src/shadow-audit.js";
import type { BehaviorAssertion } from "../src/behavior-assertions.js";
import { createAtlasFixture } from "./atlas-fixture.js";
import { loadAtlas, queryAtlas, shareAtlas } from "../src/atlas.js";
import { renderAtlas } from "../src/atlas-html.js";
import { main } from "../src/cli.js";

const raw = (choice: "supports" | "insufficient" = "supports") => ({ model: JEV_MODEL, answers: { check: { type: "choice", choice, confidence: 1, probabilities: { supports: choice === "supports" ? 1 : 0, contradicts: 0, insufficient: choice === "insufficient" ? 1 : 0 } } }, usage: { input_tokens: 100, output_tokens: 0 } });
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

test("evidence projection preserves terminal summaries and scope without hidden reasoning", () => {
  const source = { cwd: "/workspace/checkout", exitCode: 1, output: "command header\n" + "x".repeat(90000) + "\n142 suites, 888 tests passed; coverage failed",
    message: { content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: "Visible StaffTable answer" }] },
    codex: { method: "item/reasoning/textDelta", params: { delta: "PRIVATE_DELTA" } } };
  const projected = boundedEvidence(source, 4096);
  assert.equal(projected.truncated, true); assert.ok(projected.content.length <= 4096);
  assert.match(projected.content, /888 tests passed; coverage failed/);
  assert.match(projected.content, /command header/);
  assert.equal(JSON.parse(projected.content).exitCode, 1);
  assert.match(projected.content, /Visible StaffTable answer/);
  assert.doesNotMatch(projected.content, /PRIVATE_/);
  assert.deepEqual(evidenceWorkspaces(source), ["/workspace/checkout"]);
  assert.equal(source.message.content[0].thinking, "PRIVATE_REASONING");
  assert.doesNotMatch(JSON.stringify(visibleEvidence({ channel: "analysis", text: "SECRET" })), /SECRET/);
});

test("Jev audit validates citations before transport, retains failures, binds reviews and leaves Atlas scores intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-shadow-test-"));
  try {
    const requestPath = await createAtlasFixture(root);
    const aggregationPath = join(root, "aggregation.json");
    const aggregation = JSON.parse(readFileSync(aggregationPath, "utf8"));
    const source = aggregation.sources.assertions[4];
    const assertion = JSON.parse(readFileSync(source.path, "utf8")) as BehaviorAssertion;
    assertion.judgment.claims = ["supported", "missed", "flagged"].map((id) => ({ id, text: `Synthetic ${id} claim <script>alert(1)</script>`, workspace: null, citations: assertion.judgment.citations }));
    const original = structuredClone(assertion);
    let calls = 0;
    const transport = (async (_url: unknown, options: RequestInit) => {
      calls++; const request = JSON.parse(options.body as string);
      assert.equal(request.model, JEV_MODEL);
      assert.equal(request.state.evidence.length, 1);
      assert.ok(request.questions.check.instructions.includes("state.claim.text"));
      return Response.json(raw(calls === 3 ? "insufficient" : "supports"));
    }) as typeof fetch;
    const invalid = structuredClone(assertion); invalid.judgment.claims![0].citations = [{ eventId: "invented", nativeReference: { artifactId: "fake", recordLocator: "line:1" } }];
    await assert.rejects(auditBehaviorAssertion(source.bundleRoot, invalid, { apiKey: "fixture", fetch: transport }), /claim citations/);
    assert.equal(calls, 0);
    const wrongWorkspace = structuredClone(assertion); wrongWorkspace.judgment.claims![0].workspace = "/another-checkout";
    await assert.rejects(auditBehaviorAssertion(source.bundleRoot, wrongWorkspace, { apiKey: "fixture", fetch: transport }), /workspace/);
    assert.equal(calls, 0);
    const audit = await auditBehaviorAssertion(source.bundleRoot, assertion, { apiKey: "fixture", fetch: transport });
    assert.equal(calls, 3); assert.ok(audit.results.every(({ status }) => status === "completed"));
    assert.deepEqual(assertion, original);
    const reviews: ShadowReview[] = audit.results.map(({ claim }, index) => ({ schemaVersion: "ebo.shadow-review/v1", auditDigest: shadowDigest(audit), claimId: claim.id,
      reviewer: { kind: "model", id: "synthetic-fixture" }, verdict: index ? "unsupported" : "supported", cause: index === 1 ? "jev-error" : index === 2 ? "citation-gap" : "none", rationale: "Synthetic label only.", reviewedAt: new Date().toISOString() }));
    assert.throws(() => validateShadowReview(audit, { ...reviews[0], auditDigest: `sha256:${"0".repeat(64)}` }), /Stale/);
    const selection: ShadowSelection = { schemaVersion: "ebo.shadow-selection/v1", createdAt: "2020-01-01T00:00:00Z", population: "holdout", members: [{ assertionDigest: shadowDigest(assertion), task: "fixture", harness: "fixture" }] };
    const summary = summarizeShadow(selection, [audit], reviews);
    assert.equal(summary.flagPrecision.value, 1); assert.equal(summary.missedUnsupportedRate.value, 0.5); assert.equal(summary.falseSupportRate.value, 0.5);
    assert.equal(summary.pairedReviewTime.meanSavedMs, null);
    assert.throws(() => summarizeShadow({ ...selection, createdAt: "2099-01-01T00:00:00Z" }, [audit], reviews), /Freeze holdout/);
    assert.throws(() => summarizeShadow(selection, [audit], [...reviews, reviews[0]]), /one explicit resolution/);
    const failed = await auditBehaviorAssertion(source.bundleRoot, assertion, { apiKey: "fixture", fetch: (async () => new Response("untrusted failure", { status: 529 })) as typeof fetch });
    assert.ok(failed.results.every(({ status, error, choice }) => status === "failed" && error?.includes("529") && choice === undefined));
    assert.throws(() => parseJevResponse({ ...raw(), answers: { wrong: raw().answers.check } }), /Invalid Jev/);
    const uncertain = raw(); uncertain.answers.check.confidence = 0.7; uncertain.answers.check.probabilities.supports = 0.8; uncertain.answers.check.probabilities.insufficient = 0.2;
    assert.equal(parseJevResponse(uncertain).confidence, 0.7, "Confidence is not the winning option probability.");
    const malformed = raw(); malformed.answers.check.probabilities.supports = 0.5;
    assert.throws(() => parseJevResponse(malformed), /Invalid Jev/);
    writeShadowArtifact(join(root, "audit.json"), audit, [source.bundleRoot]);
    writeShadowArtifact(join(root, "summary.json"), summary);
    assert.throws(() => writeShadowArtifact(join(root, "audit.json"), audit), /exist/i);
    assert.throws(() => writeShadowArtifact(join(source.bundleRoot, "audit.json"), audit, [source.bundleRoot]), /immutable/);
    json(join(root, "review-input.json"), reviews[1]);
    assert.equal(await main(["shadow", "review", join(root, "audit.json"), join(root, "review-input.json"), join(root, "review.json")], () => undefined), 0);
    json(source.path, assertion); aggregation.sources.calibrations = []; json(aggregationPath, aggregation);
    const before = await queryAtlas(await loadAtlas(requestPath));
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    request.shadowAudits = [{ audit: "audit.json", reviews: ["review.json"] }]; json(requestPath, request);
    const loaded = await loadAtlas(requestPath); const after = await queryAtlas(loaded);
    assert.deepEqual(after.report.groups, before.report.groups);
    const html = renderAtlas(after, true);
    assert.match(html, /Jev citation audit/); assert.match(html, /jev-error/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.equal(after.cases.filter(({ shadow }) => shadow?.length).length, 1);
    await assert.rejects(shareAtlas(loaded, after), /Sharing unavailable/);
    const tampered = structuredClone(audit); tampered.results[0].evidence[0].digest = `sha256:${"0".repeat(64)}`;
    (tampered.results[0].request as any).state.evidence[0].digest = tampered.results[0].evidence[0].digest;
    json(join(root, "audit.json"), tampered);
    request.shadowAudits[0].reviews = []; json(requestPath, request);
    await assert.rejects(loadAtlas(requestPath), /retained native records/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
