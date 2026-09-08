import { createServer, type Server } from "node:http";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { aggregateEvaluation, selectAggregationAttempts, type BehaviorAggregate, type AggregationInput, type AggregationReport, type AggregationRequest } from "./aggregation.js";
import { assertNoDuplicateJsonKeys, canonicalizeMetadata, digestMetadata, validateArtifact } from "./artifacts.js";
import type { BehaviorAssertion } from "./behavior-assertions.js";
import type { AgentSdkNativeRecord } from "./agent-sdk-normalizer.js";
import { createRetainedBehaviorEvidence } from "./retained-evidence.js";
import { readCorpusIndex, validateCorpusIndex } from "./corpus.js";
import { readPortableRunBundleExport, sanitizeDerivedExport, type PortableExportPolicy } from "./exports.js";
import { assertCalibrationDestination, effectiveReviewOutcome, isDisputedReviewOutcome, type ReviewDecision } from "./human-calibration.js";
import { readBoundedFile } from "./scheduler.js";
import { renderAtlas } from "./atlas-html.js";
import { writeAtlasGrafana } from "./atlas-grafana.js";

type Digest = `sha256:${string}`;
export const ATLAS_FILTERS = ["model", "harness", "task", "trial", "capture", "outcome", "review", "category", "assessment", "q"] as const;
export type AtlasFilters = Partial<Record<typeof ATLAS_FILTERS[number], string>>;
export type AtlasRequest = {
  schemaVersion: "ebo.atlas-request/v1";
  aggregationRequest: string;
  title: string;
  operatorNarrative?: string;
  reviewPackets?: readonly string[];
  traces?: ReadonlyArray<{ runId: string; attemptId: string; traceId: string; originalStart: string; replayStart?: string }>;
  grafanaUrl?: string;
  atlasUrl?: string;
  tempoDatasourceUid?: string;
  sharing?: { policy: PortableExportPolicy; approvedExports: readonly string[]; fields: readonly string[] };
};
export type AtlasCase = {
  key: string; runId: string; attemptId: string; model: string; harness: string; task: string; trial: string;
  capture: string; outcome: string; review: string; category: string; assessment: string;
  assertion?: BehaviorAssertion; assertionDigest?: Digest; decisions: readonly ReviewDecision[];
  citations: ReadonlyArray<{ eventId: string; nativeReference: unknown; normalizedEvent: unknown; nativeRecord: unknown }>;
  trace?: { href: string; originalStart: string; replayStart?: string };
  retryOf?: string;
};
export type AtlasView = {
  schemaVersion: "ebo.atlas-view/v1"; title: string; mode: "restricted-local-only" | "partner" | "public";
  generatedAt: string; sourceDigest: Digest; cohortDigest: Digest; filters: AtlasFilters;
  filterOptions: Record<string, string[]>; report: AggregationReport; cases: readonly AtlasCase[];
  sourceAttempts: number; policyExcludedAttempts: number; filteredOutAttempts: number; matchingCases: number;
  operatorNarrative?: string; reviewPackets: readonly string[]; grafanaUrl?: string; atlasUrl?: string;
};
export type AtlasSource = { request: AtlasRequest; aggregation: AggregationRequest; input: AggregationInput; corpusRoot: string; requestPath: string; cases: AtlasCase[]; sourceDigest: Digest };
export function atlasBehaviorPartitions(view: AtlasView): Array<{ group: string; partition: BehaviorAggregate }> {
  return view.report.groups.flatMap((group) => (group.behaviors ?? []).map((partition) => ({ group: Object.values(group.dimensions).join(" · ") || "Selected cohort", partition })));
}

export function atlasBehaviorRows(view: AtlasView) {
  const rows = atlasBehaviorPartitions(view).flatMap(({ group, partition }) => partition.assessments.map(({ assessment, measurement }) => ({ group, category: partition.behavior.categoryId, dimension: partition.behavior.dimensionId, vocabulary: partition.behavior.vocabularyVersion, rubric: `${partition.rubric.id}@${partition.rubric.version}`, evaluator: canonicalizeMetadata(partition.evaluator), assessment, label: `${group} · ${partition.behavior.categoryId} · ${assessment}`, status: measurement.status, numerator: measurement.status === "available" ? measurement.numerator.value : null, denominator: measurement.denominator.value, unit: measurement.denominator.unit, exclusions: measurement.exclusions.map(({ reason, count }) => `${reason}: ${count}`).join("; "), cohortDigest: view.cohortDigest })));
  return rows.length ? rows : [{ group: "Selected cohort", category: "unavailable", dimension: "unavailable", vocabulary: "unavailable", rubric: "unavailable", evaluator: "unavailable", assessment: "unavailable", label: "Behavior distribution unavailable", status: "unavailable", numerator: null, denominator: 0, unit: "confirmed-attempt-dimension", exclusions: "No behavior assessment partition is available.", cohortDigest: view.cohortDigest }];
}
const digest = (value: unknown): Digest => `sha256:${digestMetadata(value).value}`;
const attemptKey = (value: { runId?: string; attemptId?: string }) => `${value.runId}\0${value.attemptId}`;

export async function loadAtlas(requestPath: string): Promise<AtlasSource> {
  const request = readJson(requestPath) as AtlasRequest;
  exactKeys(request, ["schemaVersion", "aggregationRequest", "title", "operatorNarrative", "reviewPackets", "traces", "grafanaUrl", "atlasUrl", "tempoDatasourceUid", "sharing"]);
  if (request.schemaVersion !== "ebo.atlas-request/v1" || typeof request.title !== "string" || !request.title.trim() || typeof request.aggregationRequest !== "string") throw new Error("Invalid or incompatible Atlas request.");
  if (request.operatorNarrative !== undefined && typeof request.operatorNarrative !== "string") throw new Error("Operator narrative must be text.");
  if (request.grafanaUrl !== undefined) localUrl(request.grafanaUrl);
  if (request.atlasUrl !== undefined) localUrl(request.atlasUrl);
  const base = dirname(resolve(requestPath));
  for (const path of request.reviewPackets ?? []) {
    if (typeof path !== "string" || !statSync(resolve(base, path), { throwIfNoEntry: false })?.isFile()) throw new Error("Configured human review packet is unavailable.");
  }
  const aggregationPath = resolve(base, request.aggregationRequest);
  const aggregation = readArtifact<AggregationRequest>(aggregationPath);
  const aggregateBase = dirname(aggregationPath);
  const source = aggregation.sources;
  const corpusRoot = resolve(aggregateBase, source.corpusRoot);
  const corpusEntries = readCorpusIndex(resolve(aggregateBase, source.corpusIndex));
  const issues = validateCorpusIndex(corpusRoot, corpusEntries);
  if (issues.length) throw new Error("Atlas corpus index is stale or invalid; rebuild and validate it before querying.");
  const input: AggregationInput = {
    lineage: { requestDigest: digest(aggregation), corpusIndexDigest: digest(corpusEntries) }, corpusEntries,
    observationSets: source.observationSets.map(({ bundleRoot, path }) => ({ bundleRoot: resolve(aggregateBase, bundleRoot), document: readArtifact(resolve(aggregateBase, path)) })),
    assertions: source.assertions.map(({ bundleRoot, path }) => ({ bundleRoot: resolve(aggregateBase, bundleRoot), document: readArtifact(resolve(aggregateBase, path)) })),
    calibrations: source.calibrations.map(({ selection, history }) => ({ selection: readArtifact(resolve(aggregateBase, selection)), history: readArtifact(resolve(aggregateBase, history)) })),
    comparisons: aggregation.comparisons.map(({ eligibilityGates, ...comparison }) => ({ ...comparison, eligibility: eligibilityGates.map(({ request, report }) => ({ request: readArtifact(resolve(aggregateBase, request)), report: readArtifact(resolve(aggregateBase, report)) })) })),
  };
  // Validate the complete source before any case or review state is exposed.
  const validated = await aggregateEvaluation(input, aggregation);
  const cases: AtlasCase[] = [];
  for (const entry of corpusEntries.filter(({ manifestKind }) => manifestKind === "run")) {
    const ownAssertions = input.assertions.filter(({ document }) => attemptKey(document) === attemptKey(entry));
    const context = { runId: entry.runId!, attemptId: entry.attemptId!, model: entry.modelId ?? "unavailable", harness: entry.harnessId ?? "unavailable", task: entry.taskId ?? "unavailable", trial: entry.trialId ?? "unavailable", capture: entry.captureQualification ?? "unavailable", outcome: entry.terminalState ?? "unavailable", ...(entry.retryOf ? { retryOf: entry.retryOf } : {}) };
    let trace: AtlasCase["trace"];
    const traceSource = request.traces?.find((item) => attemptKey(item) === attemptKey(entry));
    if (traceSource) {
      if (!/^[a-f0-9]{32}$/u.test(traceSource.traceId) || !Number.isFinite(Date.parse(traceSource.originalStart)) || (traceSource.replayStart !== undefined && !Number.isFinite(Date.parse(traceSource.replayStart)))) throw new Error("Invalid trace identity or timestamp.");
      if (request.grafanaUrl && request.tempoDatasourceUid) {
        const panes = { atlas: { datasource: request.tempoDatasourceUid, queries: [{ refId: "A", queryType: "traceId", query: traceSource.traceId }], range: { from: "now-1h", to: "now" } } };
        trace = { href: `${localUrl(request.grafanaUrl)}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`, originalStart: traceSource.originalStart, ...(traceSource.replayStart ? { replayStart: traceSource.replayStart } : {}) };
      }
    }
    if (!ownAssertions.length) cases.push({ ...context, key: digest(context).slice(7), category: "unavailable", assessment: "unavailable", review: "unavailable", decisions: [], citations: [], ...(trace ? { trace } : {}) });
    for (const { document: assertion, bundleRoot } of ownAssertions) {
      const assertionDigest = digest(assertion);
      const reviews = input.calibrations.flatMap(({ selection, history }) => selection.candidates.filter(({ assertion: binding }) => binding.id === assertion.id && binding.digest === assertionDigest).map((candidate) => ({ candidate, history })));
      const latest = reviews[0];
      const outcome = latest ? effectiveReviewOutcome(latest.candidate, latest.history.decisions) : assertion.judgment.disposition === "abstained" ? "judge-abstained" : "unreviewed";
      const review = latest && isDisputedReviewOutcome(latest.candidate, latest.history.decisions) ? "disputed" : ({ "judge-abstained": "abstained", unreviewed: "proposed", unresolved: "insufficient-evidence", confirmed: "confirmed", rejected: "rejected" } as const)[outcome];
      const evidence = await createRetainedBehaviorEvidence(bundleRoot);
      const citations = assertion.judgment.citations.map((citation) => {
        const normalizedEvent = evidence.dataset.events.find(({ id }) => id === citation.eventId);
        const native = evidence.capture.records.find(({ reference }) => canonicalizeMetadata(reference) === canonicalizeMetadata(citation.nativeReference));
        if (!normalizedEvent || !native) throw new Error("Atlas citation cannot resolve to normalized and native evidence.");
        return { ...citation, normalizedEvent: displaySafe(normalizedEvent), nativeRecord: displaySafe(evidence.dataset.adapter.harness === "claude-agent-sdk" ? (native.record as AgentSdkNativeRecord).document : native.record) };
      });
      const decisions = latest?.history.decisions.filter(({ assertion: binding }) => binding.id === assertion.id && binding.digest === assertionDigest) ?? [];
      cases.push({ ...context, key: assertionDigest.slice(7), assertion: displaySafe(assertion) as BehaviorAssertion, assertionDigest, category: assertion.behavior.categoryId, assessment: assertion.judgment.disposition === "assessed" ? assertion.judgment.assessment : "abstained", review, decisions: displaySafe(decisions) as ReviewDecision[], citations, ...(trace ? { trace } : {}) });
    }
  }
  return { request, aggregation, input, corpusRoot, requestPath: resolve(requestPath), cases, sourceDigest: digest({ request, lineage: validated.sourceLineage }) };
}

export async function queryAtlas(source: AtlasSource, filters: AtlasFilters = {}): Promise<AtlasView> {
  exactKeys(filters, [...ATLAS_FILTERS]);
  for (const value of Object.values(filters)) if (typeof value !== "string" || value.length > 500) throw new Error("Invalid Atlas filter.");
  const eligible = selectAggregationAttempts(source.input.corpusEntries, source.aggregation.selectedAttemptPolicy);
  const eligibleIds = new Set(eligible.map(attemptKey));
  const eligibleCases = source.cases.filter((item) => eligibleIds.has(attemptKey(item)));
  const matches = eligibleCases.filter((item) => Object.entries(filters).every(([key, value]) => !value || (key === "q" ? [item.runId, item.attemptId, item.model, item.task, item.assertion?.judgment.rationale ?? "", item.category].join(" ").toLocaleLowerCase().includes(value.toLocaleLowerCase()) : item[key as keyof AtlasCase] === value)));
  // Filters select attempts through matching cases; all judgments on those attempts
  // remain in aggregation so a constructive filter cannot erase an adverse rerun.
  const ids = new Set(matches.map(attemptKey));
  const corpusEntries = source.input.corpusEntries.filter((entry) => ids.has(attemptKey(entry)));
  const report = await aggregateEvaluation({ ...source.input, lineage: { ...source.input.lineage, corpusIndexDigest: digest(corpusEntries) }, corpusEntries, observationSets: source.input.observationSets.filter(({ document }) => ids.has(attemptKey(document))), assertions: source.input.assertions.filter(({ document }) => ids.has(attemptKey(document))) }, source.aggregation);
  const filterOptions = Object.fromEntries(ATLAS_FILTERS.filter((key) => key !== "q").map((key) => [key, [...new Set(eligibleCases.map((item) => String(item[key])))].sort()]));
  const sourceAttempts = new Set(source.input.corpusEntries.filter(({ manifestKind }) => manifestKind === "run").map(attemptKey)).size;
  return { schemaVersion: "ebo.atlas-view/v1", title: source.request.title, atlasUrl: source.request.atlasUrl ?? "http://127.0.0.1:13011", mode: "restricted-local-only", generatedAt: new Date().toISOString(), sourceDigest: source.sourceDigest, cohortDigest: digest({ source: source.sourceDigest, filters, lineage: report.sourceLineage }), filters, filterOptions, report, cases: matches, matchingCases: matches.length, sourceAttempts, policyExcludedAttempts: sourceAttempts - eligible.length, filteredOutAttempts: eligible.length - ids.size, ...(source.request.operatorNarrative ? { operatorNarrative: (displaySafe({ text: source.request.operatorNarrative }) as { text: string }).text } : {}), reviewPackets: (source.request.reviewPackets ?? []).map((path) => pathToFileURL(resolve(dirname(source.requestPath), path)).href), ...(source.request.grafanaUrl ? { grafanaUrl: localUrl(source.request.grafanaUrl) } : {}) };
}

export async function shareAtlas(source: AtlasSource, view: AtlasView): Promise<AtlasView> {
  const sharing = source.request.sharing;
  if (!sharing) throw new Error("Sharing unavailable: configure approved exports and explicit report fields first.");
  exactKeys(sharing, ["policy", "approvedExports", "fields"]);
  const supported = ["cohort", "aggregate-metrics", "source-digests"];
  if (sharing.fields.length !== supported.length || !supported.every((field) => sharing.fields.includes(field))) throw new Error("Unsupported report-field sharing; only cohort, aggregate-metrics and source-digests are supported.");
  const approved = await Promise.all(sharing.approvedExports.map((root) => readPortableRunBundleExport(resolve(dirname(source.requestPath), root), sharing.policy)));
  if (view.report.sourceLineage.manifests.some(({ digest }) => !approved.some(({ sourceManifestDigest }) => sourceManifestDigest === digest))) throw new Error("Every selected source manifest requires a policy-validated approved export.");
  // Semantic assertions, human prose, evidence records and operator narrative have
  // no portable sharing classification yet. The shareable surface excludes them.
  const { operatorNarrative: _narrative, grafanaUrl: _grafana, atlasUrl: _atlas, ...metadata } = view;
  const correlations = source.input.corpusEntries.flatMap(({ runId, attemptId, bundleId }) => [runId, attemptId, bundleId].filter((value): value is string => value !== undefined));
  const sanitized = sanitizeDerivedExport({ ...metadata, title: "Approved cohort summary", mode: sharing.policy.sharingClass, cases: [], matchingCases: 0, reviewPackets: [], filterOptions: {}, filters: Object.fromEntries(Object.entries(view.filters).map(([key, value]) => [key, key === "q" ? digest(value) : value])), report: { ...view.report, groups: view.report.groups.map(({ dimensions, metrics, variations }) => ({ dimensions, metrics: metrics.filter(({ population }) => population !== "assertion" && population !== "reviewed-assertion"), variations })), comparisons: [], sourceLineage: { ...view.report.sourceLineage, assertions: [], calibrations: [], comparisonGates: [] }, limitations: [...view.report.limitations, "Sharing excludes semantic findings, human decisions, native content, local links and operator narrative: those fields lack export approval."] } }, sharing.policy, correlations);
  return sanitized as AtlasView;
}

export async function writeAtlas(requestPath: string, outputRoot: string, filters: AtlasFilters = {}, share = false): Promise<AtlasView> {
  const source = await loadAtlas(requestPath);
  const view = await queryAtlas(source, filters);
  const result = share ? await shareAtlas(source, view) : view;
  assertCalibrationDestination([source.corpusRoot, ...source.input.assertions.map(({ bundleRoot }) => bundleRoot)], outputRoot);
  if (statSync(outputRoot, { throwIfNoEntry: false })) throw new Error("Atlas output destination already exists.");
  await mkdir(dirname(resolve(outputRoot)), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(resolve(outputRoot)), ".ebo-atlas-"));
  try {
    await writeFile(join(staging, "index.html"), renderAtlas(result, false), { mode: 0o600, flag: "wx" });
    await writeFile(join(staging, "report.json"), `${canonicalizeMetadata(result)}\n`, { mode: 0o600, flag: "wx" });
    if (!share) await writeAtlasGrafana(staging, result);
    await rename(staging, outputRoot);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return result;
}

export async function serveAtlas(requestPath: string, port = 13011): Promise<Server> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Atlas port.");
  await loadAtlas(requestPath);
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.method !== "GET") { res.writeHead(405).end(); return; }
      if (!req.headers.host || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(`http://${req.headers.host}`).hostname)) { res.writeHead(403).end(); return; }
      if (req.headers.origin && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(req.headers.origin).hostname)) { res.writeHead(403).end(); return; }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!["/", "/api/view", "/api/metrics", "/api/behaviors", "/api/behavior-chart", "/api/cases", "/report.html", "/report.json"].includes(url.pathname)) { res.writeHead(404).end(); return; }
      const filters: AtlasFilters = {};
      for (const [key, value] of url.searchParams) {
        if (key === "share") continue;
        if (!ATLAS_FILTERS.includes(key as typeof ATLAS_FILTERS[number])) throw new Error("Unknown Atlas query parameter.");
        if (value && value !== "$__all") filters[key as keyof AtlasFilters] = value;
      }
      const source = await loadAtlas(requestPath);
      let view = await queryAtlas(source, filters);
      if (url.searchParams.get("share") === "true") view = await shareAtlas(source, view);
      if (url.pathname === "/" || url.pathname === "/report.html") {
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(renderAtlas(view, url.pathname === "/"));
      } else {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const rows = url.pathname === "/api/metrics" ? view.report.groups.flatMap((group) => group.metrics.map((metric) => ({ group: Object.values(group.dimensions).join(" · "), metric: metric.id, status: metric.measurement.status, numerator: metric.measurement.numerator.value, denominator: metric.measurement.denominator.value, unit: metric.measurement.denominator.unit, exclusions: metric.measurement.exclusions.map(({ reason, count }) => `${reason}: ${count}`).join("; "), cohortDigest: view.cohortDigest }))) : view;
        res.end(JSON.stringify(url.pathname === "/api/behavior-chart" ? atlasBehaviorRows(view).map(({ label, numerator }) => ({ label, count: numerator })) : url.pathname === "/api/behaviors" ? atlasBehaviorRows(view) : url.pathname === "/api/cases" ? view.cases.map(({ runId, attemptId, model, harness, task, trial, category, assessment, review, key }) => ({ runId, attemptId, model, harness, task, trial, category, assessment, review, href: `http://${req.headers.host}/?${new URLSearchParams(filters)}#case-${key}` })) : rows));
      }
    } catch (error) { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end(error instanceof Error ? error.message : "Atlas query failed."); }
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  return server;
}

function readJson(path: string): unknown { const text = readBoundedFile(path).toString("utf8"); assertNoDuplicateJsonKeys(text); return JSON.parse(text); }
function displaySafe(value: unknown): unknown { return sanitizeDerivedExport(value, { sharingClass: "partner", maxArtifactBytes: 16 * 1024 * 1024, maxStringBytes: 128 * 1024 }); }
function readArtifact<T>(path: string): T { const value = readJson(path); const errors = validateArtifact(path, value); if (errors.length) throw new Error(`Invalid Atlas source: ${errors[0]!.field} ${errors[0]!.message}`); return value as T; }
function exactKeys(value: unknown, keys: readonly string[]): void { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown or invalid Atlas fields."); }
function localUrl(value: string): string { const url = new URL(value); if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Atlas integration URL must be a local HTTP origin."); return url.origin; }
