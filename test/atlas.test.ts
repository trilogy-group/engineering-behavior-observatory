import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import test from "node:test";
import { aggregateEvaluation } from "../src/aggregation.js";
import { atlasBehaviorRows, loadAtlas, queryAtlas, serveAtlas, shareAtlas, writeAtlas, type AtlasRequest } from "../src/atlas.js";
import { renderAtlas } from "../src/atlas-html.js";
import { atlasDashboards } from "../src/atlas-grafana.js";
import { createPortableRunBundleExport, sanitizeDerivedExport } from "../src/exports.js";
import { digestMetadata } from "../src/artifacts.js";
import { importReviewDecision, type ReviewHistory } from "../src/human-calibration.js";
import { main } from "../src/cli.js";
import { createAtlasFixture } from "./atlas-fixture.js";

test("Atlas mixed fixture preserves exact cohort populations, decisions and native drilldown", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-test-"));
  try {
    const requestPath = await createAtlasFixture(root);
    const source = await loadAtlas(requestPath);
    const view = await queryAtlas(source);
    assert.equal(view.report.sourcePopulation.uniqueRuns, 6);
    assert.equal(view.report.sourcePopulation.selectedAttempts, 7);
    assert.deepEqual(new Set(view.cases.map(({ review }) => review)), new Set(["confirmed", "disputed", "rejected", "proposed", "abstained", "unavailable"]));
    assert.equal(view.report.comparisons[0]!.claimStatus, "unavailable");
    assert.equal(view.cases.filter(({ review }) => review === "confirmed").length, 2);
    assert.equal(view.cases[0]!.harnessVersion, source.input.corpusEntries[0]!.harnessVersion);
    assert.ok(atlasBehaviorRows(view).some(({ assessment, numerator, denominator }) => assessment === "constructive" && numerator === 1 && denominator === 1));
    assert.ok(atlasBehaviorRows(view).some(({ assessment, numerator, denominator }) => assessment === "adverse" && numerator === 1 && denominator === 1));
    for (const item of view.cases) {
      for (const citation of item.citations) {
        assert.equal((citation.normalizedEvent as { id: string }).id, citation.eventId);
        assert.ok(citation.nativeRecord);
      }
    }
    const filtered = await queryAtlas(source, { model: "synthetic-model-b", review: "confirmed" });
    assert.equal(filtered.report.sourcePopulation.selectedAttempts, 1);
    assert.equal(filtered.filteredOutAttempts, 6);
    assert.equal(filtered.cases[0]!.assessment, "adverse");
    const selectedIds = new Set(filtered.cases.map(({ attemptId }) => attemptId));
    const exact = await aggregateEvaluation({ ...source.input, corpusEntries: source.input.corpusEntries.filter(({ attemptId }) => selectedIds.has(attemptId!)), assertions: source.input.assertions.filter(({ document }) => selectedIds.has(document.attemptId)), observationSets: source.input.observationSets.filter(({ document }) => selectedIds.has(document.attemptId)) }, source.aggregation);
    assert.deepEqual(filtered.report.groups, exact.groups);
    assert.notEqual(filtered.cohortDigest, view.cohortDigest);
    assert.equal((await queryAtlas(source, { q: "not in fixture" })).report.sourcePopulation.selectedAttempts, 0);
    assert.equal((await queryAtlas(source, { review: "proposed" })).cases[0]!.decisions.length, 0);
    assert.equal((await queryAtlas(source, { trial: "3" })).report.sourcePopulation.selectedAttempts, 2);
    source.aggregation.selectedAttemptPolicy = "latest-attempt-per-run";
    const latest = await queryAtlas(source, { review: "abstained" });
    assert.equal(latest.policyExcludedAttempts, 1);
    assert.equal(latest.report.sourcePopulation.selectedAttempts, 0, "an older matching assertion must not substitute for the latest retry");
    source.aggregation.selectedAttemptPolicy = "all-attempts";
    await assert.rejects(queryAtlas(source, { surprise: "value" } as never), /Unknown/u);
    const html = renderAtlas(view, false);
    assert.match(html, /&lt;script&gt;window.fixtureXss=1&lt;\/script&gt;/u);
    assert.doesNotMatch(html, /<script>window.fixtureXss|ghp_abcdefghijklmnopqrstuvwxyz123456|SYNTHETIC_HIDDEN_REASONING|1200\.0%/u);
    assert.match(html, /Print \/ save PDF/u);
    assert.match(html, /Frozen cohort/u);
    assert.match(html, /No human decision supplied/u);
    assert.match(html, /Operator-authored narrative/u);
    assert.deepEqual(atlasDashboards(view).map(({ uid }) => uid), ["ebo-atlas-overview", "ebo-atlas-behavior"]);
    const chart = atlasDashboards(view)[1]!.panels.find(({ id }) => id === 4)!;
    assert.equal(chart.targets?.[0]?.columns.find(({ selector }) => selector === "count")?.type, "number");
    assert.match(JSON.stringify(atlasDashboards(view)), /\$\{model:percentencode\}/u);
    const report = await writeAtlas(requestPath, join(root, "report"), { review: "confirmed" });
    assert.equal(report.matchingCases, 2);
    assert.equal(JSON.parse(readFileSync(join(root, "report/report.json"), "utf8")).cohortDigest, report.cohortDigest);
    await assert.rejects(writeAtlas(requestPath, join(root, "corpus/forbidden")), /outside immutable/u);
    await assert.rejects(shareAtlas(source, view), /Sharing unavailable/u);
    assert.equal(await main(["atlas", "build", requestPath, join(root, "bad"), "--unknown"], () => undefined), 1);

    const server = await serveAtlas(requestPath, 0);
    try {
      const address = server.address(); assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${base}/api/view?assessment=adverse`);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as typeof view).report.sourcePopulation.selectedAttempts, 1);
      assert.equal((await fetch(`${base}/api/view`, { headers: { Origin: "https://foreign.example" } })).status, 403);
      assert.equal(await new Promise<number | undefined>((accept) => { get(`${base}/api/view`, { headers: { Host: "foreign.example" } }, (response) => { response.resume(); accept(response.statusCode); }); }), 403);
      assert.equal((await fetch(`${base}/api/view?path=/etc/passwd`)).status, 400);
      assert.equal((await fetch(`${base}/corpus/manifest.json`)).status, 404);
      assert.equal((await fetch(`${base}/report.html?share=true`)).status, 400);
      const rows = await (await fetch(`${base}/api/cases?review=disputed`)).json() as Array<{ review: string; href: string }>;
      assert.equal(rows.length, 1); assert.equal(rows[0]!.review, "disputed"); assert.match(rows[0]!.href, /#case-[a-f0-9]{64}$/u);
      const comparisons = await (await fetch(`${base}/api/comparisons`)).json() as Array<{ status: string; numerator: number | null }>;
      assert.equal(comparisons[0]!.status, "unavailable"); assert.equal(comparisons[0]!.numerator, null);
    } finally { await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept())); }

    const request = JSON.parse(readFileSync(requestPath, "utf8")) as AtlasRequest;
    const aggregationPath = join(root, "aggregation.json");
    const aggregation = JSON.parse(readFileSync(aggregationPath, "utf8"));
    const secondHistoryPath = join(root, "second-history.json");
    let secondHistory: ReviewHistory | undefined;
    for (const decision of source.input.calibrations[0]!.history.decisions) {
      secondHistory = (await importReviewDecision(source.input.calibrations[0]!.selection, secondHistoryPath, { ...decision, id: `${decision.id}-second`, reviewer: { ...decision.reviewer, id: "synthetic-second-reviewer" }, previousHistory: secondHistory ? { schemaVersion: secondHistory.schemaVersion, digest: `sha256:${digestMetadata(secondHistory).value}` } : null })).history;
    }
    writeFileSync(aggregationPath, JSON.stringify({ ...aggregation, sources: { ...aggregation.sources, assertions: [...aggregation.sources.assertions, aggregation.sources.assertions[0]], calibrations: [...aggregation.sources.calibrations, { selection: join(root, "selection.json"), history: secondHistoryPath }] } }));
    const repeated = await queryAtlas(await loadAtlas(requestPath));
    assert.equal(repeated.cases.length, view.cases.length, "identical repeated assertion sources count once and produce unique anchors");
    assert.equal(repeated.cases[0]!.decisions.length, 2, "independent compatible review histories remain inspectable");
    writeFileSync(aggregationPath, JSON.stringify(aggregation));
    const traced = { ...request, tempoDatasourceUid: "synthetic-tempo", traces: [{ runId: "synthetic-run-0", attemptId: "synthetic-attempt-0", traceId: "a".repeat(32), originalStart: "2026-09-07T12:00:00Z", replayStart: "2026-09-08T01:00:00Z" }] };
    writeFileSync(requestPath, JSON.stringify(traced));
    const traceView = await queryAtlas(await loadAtlas(requestPath), { review: "confirmed" });
    assert.equal(traceView.cases[0]!.trace?.originalStart, traced.traces[0]!.originalStart);
    assert.equal(traceView.cases[0]!.trace?.replayStart, traced.traces[0]!.replayStart);
    assert.match(traceView.cases[0]!.trace!.href, /^http:\/\/127\.0\.0\.1:13010\/explore\?/u);
    assert.match(renderAtlas(traceView, false), /Replay-shifted: 2026-09-08T01:00:00Z/u);
    writeFileSync(requestPath, JSON.stringify({ ...traced, traces: [...traced.traces, { ...traced.traces[0], traceId: "b".repeat(32) }] }));
    await assert.rejects(loadAtlas(requestPath), /trace attempt keys must be unique/u);
    writeFileSync(requestPath, JSON.stringify({ ...traced, traces: [{ ...traced.traces[0], traceId: "not-a-trace" }] }));
    await assert.rejects(loadAtlas(requestPath), /Invalid trace identity/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, reviewPackets: ["missing.html"] }));
    await assert.rejects(loadAtlas(requestPath), /review packet is unavailable/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, grafanaUrl: "javascript:alert(1)" }));
    await assert.rejects(loadAtlas(requestPath), /local HTTP origin/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, schemaVersion: "ebo.atlas-request/v2" }));
    await assert.rejects(loadAtlas(requestPath), /incompatible/u);
    writeFileSync(requestPath, JSON.stringify(request));
    const assertionPath = source.aggregation.sources.assertions[0]!.path;
    const assertion = JSON.parse(readFileSync(assertionPath, "utf8")); assertion.judgment.citations[0].eventId = "missing-event";
    writeFileSync(assertionPath, JSON.stringify(assertion));
    await assert.rejects(loadAtlas(requestPath), /unknown normalized event/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shareable Atlas requires source export readback and fails closed on unsupported report fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-share-"));
  try {
    const requestPath = await createAtlasFixture(root);
    const source = await loadAtlas(requestPath);
    const view = await queryAtlas(source, { review: "confirmed", model: "synthetic-model-a" });
    const policy = { sharingClass: "public" as const, maxArtifactBytes: 16 * 1024 * 1024, maxStringBytes: 8192 };
    const nativeDisplay = sanitizeDerivedExport({ method: "item/reasoning/textDelta", payload: { delta: "synthetic-hidden-content" }, raw: JSON.stringify({ method: "item/reasoning/textDelta", params: { delta: "synthetic-hidden-content" } }) }, policy);
    assert.doesNotMatch(JSON.stringify(nativeDisplay), /synthetic-hidden-content/u, "derived displays reuse native reasoning omission before the final scan");
    assert.equal((nativeDisplay as { method: string }).method, "item/reasoning/textDelta");
    const approvedRoot = join(root, "approved");
    await createPortableRunBundleExport({ sourceRoot: source.input.assertions[0]!.bundleRoot, destinationRoot: approvedRoot, policy });
    source.request.sharing = { policy, approvedExports: [approvedRoot], fields: ["cohort", "aggregate-metrics", "source-digests"] };
    const shared = await shareAtlas(source, view);
    assert.equal(shared.mode, "public"); assert.equal(shared.cases.length, 0); assert.equal(shared.reviewPackets.length, 0);
    assert.equal(shared.operatorNarrative, undefined);
    const output = JSON.stringify(shared);
    assert.doesNotMatch(output, /window.fixtureXss|ghp_|SYNTHETIC_HIDDEN_REASONING|file:\/\/|\/Users\/|\/private\/|synthetic-fixture-reviewer/u);
    assert.equal(shared.report.groups.some(({ metrics }) => metrics.some(({ population }) => population === "assertion")), false);
    await assert.rejects(shareAtlas(source, await queryAtlas(source)), /Every selected source manifest/u);
    source.request.sharing.fields = [...source.request.sharing.fields, "native-records"];
    await assert.rejects(shareAtlas(source, view), /Unsupported report-field/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
