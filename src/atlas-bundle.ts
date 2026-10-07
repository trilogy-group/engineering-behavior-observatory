import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

import { canonicalizeMetadata, digestMetadata, validateArtifact } from "./artifacts.js";
import { loadAtlas, queryAtlas, type AtlasSource, type AtlasView } from "./atlas.js";
import type { BehaviorAssertion } from "./behavior-assertions.js";
import type { CorpusIndexEntry } from "./corpus.js";
import { createRetainedBehaviorEvidence, type RetainedBehaviorEvidence } from "./retained-evidence.js";
import type { StructuralObservationSet } from "./structural-observations.js";
import type { NativeEvidenceReference, UniformEvent } from "./uniform-events.js";

/**
 * Atlas bundles (ebo.atlas-bundle/v1): the analytical tables behind the Atlas viewer, built from validated EBO
 * artifacts. Every cohort is loaded through the same validation as `ebo atlas build` (corpus index, observation sets,
 * assertions, citations, reviews); each attempt's retained evidence is read once. Native records stay authoritative:
 * event text is a flattened view of resolved native content for search and embedding, never a replacement.
 */
export const ATLAS_BUNDLE_BUILDER = { id: "ebo-atlas-bundle", version: "1.0.0" } as const;
export const ATLAS_TABLES_VERSION = "1.0.0";

export type AtlasBundleRequest = {
  schemaVersion: "ebo.atlas-bundle-request/v1";
  /** Stable study identifier, used in claim and bundle identities. */
  id: string;
  title: string;
  /** Cohorts by their Atlas requests (each names an aggregation request). Paths are relative to this request. */
  cohorts: ReadonlyArray<{ id: string; atlasRequest: string }>;
  /** Study arms: a regular expression over each run bundle's directory name with a named group `condition`. */
  condition?: { pattern: string };
};

export type AtlasBundleManifest = {
  schemaVersion: "ebo.atlas-bundle/v1";
  id: string;
  title: string;
  builder: typeof ATLAS_BUNDLE_BUILDER;
  tablesVersion: typeof ATLAS_TABLES_VERSION;
  createdAt: string;
  request: { digest: `sha256:${string}` };
  cohorts: Array<{ id: string; title: string; sourceDigest: string; cohortDigest: string; attempts: number; assertions: number; report: string }>;
  tables: Record<string, { path: string; rows: number; sha256: `sha256:${string}` }>;
  files: Array<{ path: string; bytes: number; sha256: `sha256:${string}`; role: string }>;
};

type Row = Record<string, string | number | boolean | null>;
type Column = [name: string, type: "VARCHAR" | "BIGINT" | "DOUBLE" | "BOOLEAN"];
const S = "VARCHAR", I = "BIGINT", F = "DOUBLE", B = "BOOLEAN";

/** Atlas tables v1: the lab's P0 tables plus occurrences. Column order is part of the contract. */
export const ATLAS_TABLES: Record<string, Column[]> = {
  cohorts: [["cohort_id", S], ["title", S], ["atlas_request", S], ["report_mode", S], ["cohort_digest", S], ["source_digest", S],
    ["report_generated_at", S], ["source_attempts", I], ["matching_cases", I], ["group_by", S], ["operator_narrative", S]],
  attempts: [["attempt_id", S], ["run_id", S], ["bundle_id", S], ["model_id", S], ["model_provider", S], ["harness_id", S], ["harness_version", S],
    ["task_id", S], ["fixture_id", S], ["trial_id", S], ["condition", S], ["assessment_mode", S], ["capture_qualification", S], ["terminal_state", S],
    ["failure_class", S], ["stop_reason", S], ["adapter_id", S], ["adapter_version", S], ["dataset_digest", S], ["manifest_digest", S],
    ["bundle_root", S], ["event_count", I], ["native_record_count", I], ["unmapped_record_count", I], ["first_event_time", S],
    ["last_event_time", S], ["native_span_seconds", F]],
  attempt_cohorts: [["attempt_id", S], ["cohort_id", S]],
  events: [["event_key", S], ["event_id", S], ["attempt_id", S], ["run_id", S], ["dataset_index", I], ["family", S], ["phase", S], ["actor_kind", S],
    ["actor_id", S], ["scope_kind", S], ["scope_id", S], ["harness", S], ["native_type", S], ["native_event_type", S], ["native_artifact", S],
    ["native_locator", S], ["order_domain", S], ["order_value", I], ["event_time", S], ["t_rel_seconds", F], ["role", S], ["tool_name", S],
    ["tool_call_id", S], ["is_error", B], ["parent_event_key", S], ["attributes_json", S], ["content_status", S], ["content_ref_count", I],
    ["content_resolution", S], ["text", S], ["text_chars", I], ["text_sha256", S], ["content_json", S], ["content_json_chars", I]],
  event_relations: [["src_event_key", S], ["kind", S], ["dst_event_key", S], ["attempt_id", S]],
  assessments: [["assertion_id", S], ["attempt_id", S], ["run_id", S], ["category_id", S], ["dimension_id", S], ["vocabulary_version", S],
    ["rubric_id", S], ["rubric_version", S], ["evaluator_id", S], ["evaluator_version", S], ["evaluator_config_digest", S], ["disposition", S],
    ["assessment", S], ["confidence", F], ["confidence_scale", S], ["review", S], ["rationale", S], ["alternative_explanation", S],
    ["assertion_digest", S], ["dataset_digest", S], ["citation_count", I], ["claim_count", I]],
  assessment_cohorts: [["assertion_id", S], ["cohort_id", S], ["included", B], ["disputed", B], ["review_outcome", S]],
  citations: [["assertion_id", S], ["ordinal", I], ["attempt_id", S], ["event_id", S], ["event_key", S], ["occurrence_id", S],
    ["native_artifact", S], ["native_locator", S], ["resolved", B]],
  claims: [["assertion_id", S], ["claim_id", S], ["ordinal", I], ["text", S], ["workspace", S], ["citation_event_keys", S]],
  observations: [["observation_id", S], ["attempt_id", S], ["run_id", S], ["extractor_id", S], ["extractor_version", S], ["definition", S],
    ["value_status", S], ["value_json", S], ["value_num", F], ["unit", S], ["denominator_scope", S], ["denominator_value", F],
    ["denominator_unit", S], ["source_record_count", I], ["source_event_count", I]],
  observation_sources: [["observation_id", S], ["attempt_id", S], ["event_id", S], ["event_key", S]],
  occurrences: [["occurrence_id", S], ["attempt_id", S], ["type", S], ["rule_id", S], ["rule_version", S], ["heuristic", B],
    ["first_event_key", S], ["event_count", I], ["event_keys", S], ["attributes_json", S]],
  edges: [["src_type", S], ["src_id", S], ["rel", S], ["dst_type", S], ["dst_id", S]],
};

const NOISE_KEYS = new Set(["id", "entryId", "parentId", "sessionId", "threadId", "turnId", "itemId", "requestId", "toolCallId", "callId",
  "call_id", "timestamp", "ts", "createdAt", "updatedAt", "signature", "thinkingSignature", "encrypted_content", "encryptedContent",
  "digest", "sha256", "inputDigest", "eventSeq", "usage", "cost", "api", "provider"]);

/** Searchable text of resolved native content: string leaves (short ones labelled with their key), JSON strings parsed. */
export function flattenText(value: unknown, key?: string, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) flattenText(item, key, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!NOISE_KEYS.has(k)) flattenText(v, k, out);
  } else if (typeof value === "string") {
    const s = value.trim();
    if (!s) return out;
    if (s[0] === "{" || s[0] === "[") {
      try { return flattenText(JSON.parse(s), key, out); } catch { /* not JSON */ }
    }
    out.push(key && s.length <= 120 && !s.includes("\n") ? `${key}: ${s}` : s);
  } else if ((typeof value === "number" || typeof value === "boolean") && key) out.push(`${key}: ${String(value)}`);
  return out;
}

const sha256 = (data: string | Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}` as const;
const known = <T>(field: { status: string; value?: T }) => (field.status === "known" ? field.value ?? null : null);
const str = (value: unknown) => (typeof value === "string" ? value : null);

function readRequest(path: string): AtlasBundleRequest {
  const request = JSON.parse(readFileSync(path, "utf8")) as AtlasBundleRequest;
  const errors = validateArtifact("atlas bundle request", request);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  if (new Set(request.cohorts.map(({ id }) => id)).size !== request.cohorts.length) throw new Error("Atlas bundle cohort ids must be unique.");
  if (request.condition) {
    const pattern = new RegExp(request.condition.pattern, "u");
    if (!/\(\?<condition>/u.test(request.condition.pattern)) throw new Error(`Condition pattern ${String(pattern)} needs a named group "condition".`);
  }
  return request;
}

/** Native content for one reference: the record (Agent SDK: its document), then the locator's JSON pointer. */
function contentResolver(evidence: RetainedBehaviorEvidence) {
  const agentSdk = evidence.dataset.adapter.harness === "claude-agent-sdk";
  const records = new Map(evidence.capture.records.map(({ reference, record }) =>
    [`${reference.artifactId}\0${reference.recordLocator}`, agentSdk ? (record as { document: unknown }).document : record]));
  return (reference: NativeEvidenceReference): { status: "resolved"; value: unknown } | { status: "missing-record" | "bad-pointer" } => {
    const marker = reference.recordLocator.indexOf("#");
    const base = marker === -1 ? reference.recordLocator : reference.recordLocator.slice(0, marker);
    const key = `${reference.artifactId}\0${base === "" ? "#" : base}`;
    if (!records.has(key)) return { status: "missing-record" };
    let current = records.get(key);
    for (const segment of (marker === -1 ? "" : reference.recordLocator.slice(marker + 1)).split("/").slice(1)) {
      const token = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
      if (Array.isArray(current)) current = current[Number(token)];
      else if (current !== null && typeof current === "object") current = (current as Record<string, unknown>)[token];
      else return { status: "bad-pointer" };
      if (current === undefined) return { status: "bad-pointer" };
    }
    return { status: "resolved", value: current };
  };
}

function eventRow(event: UniformEvent, index: number, resolve: ReturnType<typeof contentResolver>): Row {
  const key = `${event.attemptId}/${event.id}`;
  const attrs = event.attributes as Record<string, unknown>;
  const refs = event.content.status === "known" ? event.content.value : [];
  const resolved: unknown[] = [];
  let resolution = refs.length ? "resolved" : "no-content";
  for (const ref of refs) {
    const result = resolve(ref.nativeReference);
    if (result.status === "resolved") resolved.push(result.value);
    else resolution = result.status;
  }
  const text = resolved.length ? flattenText(resolved).join("\n") : "";
  const contentJson = resolved.length ? JSON.stringify(resolved) : null;
  const parent = event.relations.parent;
  const toolName = str(attrs.toolName) ?? (event.family === "tool" ? str(attrs.name) : null) ?? (event.actor.kind === "tool" ? event.actor.id ?? null : null);
  return {
    event_key: key, event_id: event.id, attempt_id: event.attemptId, run_id: event.runId, dataset_index: index, family: event.family,
    phase: event.phase, actor_kind: event.actor.kind, actor_id: event.actor.id ?? null, scope_kind: event.scope.kind, scope_id: event.scope.id ?? null,
    harness: event.source.harness, native_type: event.source.nativeType,
    native_event_type: str(attrs.eventType) ?? str(attrs.itemType) ?? str(attrs.method) ?? event.source.nativeType,
    native_artifact: event.source.nativeReference.artifactId, native_locator: event.source.nativeReference.recordLocator,
    order_domain: event.nativeOrder.status === "known" ? event.nativeOrder.domain : null,
    order_value: event.nativeOrder.status === "known" ? event.nativeOrder.value : null,
    event_time: known(event.nativeTime), t_rel_seconds: null, role: str(attrs.role), tool_name: toolName,
    tool_call_id: str(attrs.toolCallId) ?? str(attrs.callId) ?? (event.family === "tool" ? str(attrs.itemId) : null),
    is_error: typeof attrs.isError === "boolean" ? attrs.isError : null,
    parent_event_key: parent.status === "known" && parent.value ? `${event.attemptId}/${parent.value}` : null,
    attributes_json: JSON.stringify(attrs), content_status: event.content.status, content_ref_count: refs.length, content_resolution: resolution,
    text: text || null, text_chars: text.length, text_sha256: text ? sha256(text) : null, content_json: contentJson,
    content_json_chars: contentJson?.length ?? 0,
  };
}

async function writeTables(tables: Record<string, Row[]>, directory: string) {
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "ebo-atlas-tables-"));
  const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
  const connection = await db.connect();
  const quote = (s: string) => `'${s.replace(/'/gu, "''")}'`;
  try {
    const out: AtlasBundleManifest["tables"] = {};
    for (const [name, columns] of Object.entries(ATLAS_TABLES)) {
      const rows = tables[name] ?? [];
      const ndjson = join(staging, `${name}.ndjson`);
      writeFileSync(ndjson, rows.map((row) => JSON.stringify(Object.fromEntries(columns.map(([column]) => [column, row[column] ?? null])))).join("\n"));
      const path = join(directory, `${name}.parquet`);
      const spec = `{${columns.map(([column, type]) => `${column}: ${quote(type)}`).join(", ")}}`;
      const select = rows.length
        ? `SELECT ${columns.map(([column]) => column).join(", ")} FROM read_json(${quote(ndjson)}, format = 'newline_delimited', columns = ${spec}, maximum_object_size = 1073741824)`
        : `SELECT ${columns.map(([column, type]) => `CAST(NULL AS ${type}) AS ${column}`).join(", ")} WHERE false`;
      await connection.run(`COPY (${select}) TO ${quote(path)} (FORMAT parquet, COMPRESSION zstd)`);
      out[name] = { path: `tables/${name}.parquet`, rows: rows.length, sha256: sha256(readFileSync(path)) };
    }
    return out;
  } finally {
    connection.closeSync();
    db.closeSync();
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function buildAtlasBundle(requestPath: string, outputRoot: string, options: { now?: () => Date } = {}): Promise<AtlasBundleManifest> {
  const request = readRequest(requestPath);
  if (existsSync(outputRoot) && readdirSync(outputRoot).length) throw new Error(`Atlas bundle output ${outputRoot} is not empty; choose a new directory.`);
  const base = dirname(resolve(requestPath));
  const condition = request.condition ? new RegExp(request.condition.pattern, "u") : undefined;
  const tables: Record<string, Row[]> = Object.fromEntries(Object.keys(ATLAS_TABLES).map((name) => [name, []]));
  const cohorts: AtlasBundleManifest["cohorts"] = [];
  const attempts = new Map<string, { entry: CorpusIndexEntry; bundleRoot: string; cohorts: Set<string> }>();
  const observationSets = new Map<string, StructuralObservationSet>();
  const assertions = new Map<string, { assertion: BehaviorAssertion; digest: string; review: string; cohorts: Set<string> }>();
  mkdirSync(join(outputRoot, "reports"), { recursive: true });

  for (const cohort of request.cohorts) {
    const atlasPath = resolve(base, cohort.atlasRequest);
    const source: AtlasSource = await loadAtlas(atlasPath);
    const view: AtlasView = await queryAtlas(source);
    for (const entry of source.input.corpusEntries.filter(({ manifestKind }) => manifestKind === "run")) {
      const bundleRoot = resolve(source.corpusRoot, dirname(entry.manifestPath));
      // Cohorts may carry their own corpus copies: one attempt, one manifest digest, whichever copy is read.
      const known = attempts.get(entry.attemptId!) ?? { entry, bundleRoot, cohorts: new Set<string>() };
      if (known.entry.manifestDigest !== entry.manifestDigest) throw new Error(`Attempt ${entry.attemptId!} has two different run manifests across cohorts.`);
      known.cohorts.add(cohort.id);
      attempts.set(entry.attemptId!, known);
    }
    for (const { document } of source.input.observationSets) {
      const previous = observationSets.get(document.attemptId);
      if (previous && canonicalizeMetadata(previous) !== canonicalizeMetadata(document)) throw new Error(`Attempt ${document.attemptId} has two different observation sets.`);
      observationSets.set(document.attemptId, document);
    }
    for (const c of source.cases.filter((x) => x.assertion && x.assertionDigest)) {
      const original = source.input.assertions.find(({ document }) => `sha256:${digestMetadata(document).value}` === c.assertionDigest)!.document;
      const entry = assertions.get(original.id) ?? { assertion: original, digest: c.assertionDigest!, review: c.review, cohorts: new Set<string>() };
      if (entry.digest !== c.assertionDigest) throw new Error(`Assertion ${original.id} differs between cohorts.`);
      entry.cohorts.add(cohort.id);
      assertions.set(original.id, entry);
    }
    for (const group of view.report.groups) for (const behavior of group.behaviors ?? []) for (const a of behavior.assertions) {
      tables.assessment_cohorts!.push({ assertion_id: a.id, cohort_id: cohort.id, included: a.included, disputed: a.disputed, review_outcome: a.reviewOutcome });
    }
    const report = { schemaVersion: "ebo.atlas-bundle-report/v1", cohort: cohort.id, title: view.title, mode: view.mode, generatedAt: view.generatedAt,
      sourceDigest: view.sourceDigest, cohortDigest: view.cohortDigest, sourceAttempts: view.sourceAttempts, matchingCases: view.matchingCases, report: view.report };
    writeFileSync(join(outputRoot, "reports", `${cohort.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
    cohorts.push({ id: cohort.id, title: view.title, sourceDigest: view.sourceDigest, cohortDigest: view.cohortDigest,
      attempts: source.input.corpusEntries.filter(({ manifestKind }) => manifestKind === "run").length, assertions: source.input.assertions.length, report: `reports/${cohort.id}.json` });
    tables.cohorts!.push({ cohort_id: cohort.id, title: view.title, atlas_request: relative(base, atlasPath), report_mode: view.mode,
      cohort_digest: view.cohortDigest, source_digest: view.sourceDigest, report_generated_at: view.generatedAt, source_attempts: view.sourceAttempts,
      matching_cases: view.matchingCases, group_by: JSON.stringify(source.aggregation.groupBy), operator_narrative: source.request.operatorNarrative ?? null });
  }

  const eventKeys = new Set<string>();
  for (const [attemptId, { entry, bundleRoot, cohorts: memberOf }] of [...attempts].sort(([a], [b]) => a.localeCompare(b))) {
    const evidence = await createRetainedBehaviorEvidence(bundleRoot);
    const resolveContent = contentResolver(evidence);
    const rows = evidence.dataset.events.map((event, index) => eventRow(event, index, resolveContent));
    const times = rows.map(({ event_time }) => event_time).filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t))).sort((a, b) => Date.parse(a) - Date.parse(b));
    const first = times[0], last = times.at(-1);
    for (const row of rows) {
      if (eventKeys.has(String(row.event_key))) throw new Error(`Duplicate event key ${String(row.event_key)}.`);
      eventKeys.add(String(row.event_key));
      if (first && typeof row.event_time === "string") row.t_rel_seconds = (Date.parse(row.event_time) - Date.parse(first)) / 1000;
      tables.events!.push(row);
    }
    for (const event of evidence.dataset.events) for (const relation of event.relations.known) {
      tables.event_relations!.push({ src_event_key: `${attemptId}/${event.id}`, kind: relation.kind, dst_event_key: `${attemptId}/${relation.eventId}`, attempt_id: attemptId });
    }
    const name = basename(bundleRoot);
    tables.attempts!.push({ attempt_id: attemptId, run_id: entry.runId ?? null, bundle_id: entry.bundleId ?? null, model_id: entry.modelId ?? null,
      model_provider: entry.modelProvider ?? null, harness_id: entry.harnessId ?? null, harness_version: entry.harnessVersion ?? null, task_id: entry.taskId ?? null,
      fixture_id: entry.fixtureId ?? null, trial_id: entry.trialId ?? null,
      condition: condition?.exec(name)?.groups?.condition ?? `${entry.modelId ?? "unavailable"} · ${entry.harnessId ?? "unavailable"}`,
      assessment_mode: entry.assessmentMode ?? null, capture_qualification: entry.captureQualification ?? null, terminal_state: entry.terminalState ?? null,
      failure_class: entry.failureClass ?? null, stop_reason: entry.stopReason ?? null, adapter_id: evidence.dataset.adapter.id, adapter_version: evidence.dataset.adapter.version,
      dataset_digest: observationSets.get(attemptId)?.normalization.datasetDigest ?? null, manifest_digest: entry.manifestDigest ?? null,
      bundle_root: relative(base, bundleRoot), event_count: evidence.dataset.events.length, native_record_count: evidence.coverage.records.total,
      unmapped_record_count: evidence.coverage.records.unmapped, first_event_time: first ?? null, last_event_time: last ?? null,
      native_span_seconds: first && last ? (Date.parse(last) - Date.parse(first)) / 1000 : null });
    for (const cohortId of [...memberOf].sort()) tables.attempt_cohorts!.push({ attempt_id: attemptId, cohort_id: cohortId });
  }

  for (const [attemptId, set] of observationSets) {
    for (const observation of set.observations) {
      const value = observation.value as { status?: string; value?: unknown; unit?: string };
      const { denominator } = observation;
      const sources = observation.sourceEventIds;
      tables.observations!.push({ observation_id: observation.id, attempt_id: attemptId, run_id: set.runId, extractor_id: observation.extractor.id,
        extractor_version: observation.extractor.version, definition: observation.definition, value_status: value.status ?? null,
        value_json: JSON.stringify(value.value ?? null), value_num: typeof value.value === "number" ? value.value : null, unit: value.unit ?? null,
        denominator_scope: denominator.scope, denominator_value: denominator.value, denominator_unit: denominator.unit,
        source_record_count: observation.sourceRecordCount, source_event_count: sources.length });
      for (const eventId of sources) tables.observation_sources!.push({ observation_id: observation.id, attempt_id: attemptId, event_id: eventId, event_key: `${attemptId}/${eventId}` });
    }
    for (const occurrence of set.occurrences ?? []) {
      tables.occurrences!.push({ occurrence_id: occurrence.id, attempt_id: attemptId, type: occurrence.type, rule_id: occurrence.rule.id, rule_version: occurrence.rule.version,
        heuristic: occurrence.rule.heuristic, first_event_key: `${attemptId}/${occurrence.eventIds[0]!}`, event_count: occurrence.eventIds.length,
        event_keys: JSON.stringify(occurrence.eventIds.map((id) => `${attemptId}/${id}`)), attributes_json: JSON.stringify(occurrence.attributes) });
    }
  }

  for (const { assertion, digest, review } of [...assertions.values()].sort((a, b) => a.assertion.id.localeCompare(b.assertion.id))) {
    const j = assertion.judgment;
    tables.assessments!.push({ assertion_id: assertion.id, attempt_id: assertion.attemptId, run_id: assertion.runId, category_id: assertion.behavior.categoryId,
      dimension_id: assertion.behavior.dimensionId, vocabulary_version: assertion.behavior.vocabularyVersion, rubric_id: assertion.rubric.id, rubric_version: assertion.rubric.version,
      evaluator_id: assertion.evaluator.id, evaluator_version: assertion.evaluator.version, evaluator_config_digest: assertion.evaluator.configurationDigest ?? null,
      disposition: j.disposition, assessment: j.disposition === "assessed" ? j.assessment : null, confidence: j.disposition === "assessed" ? j.confidence?.value ?? null : null,
      confidence_scale: j.disposition === "assessed" ? j.confidence?.scale ?? null : null, review, rationale: j.rationale ?? null,
      alternative_explanation: j.alternativeExplanation ?? null, assertion_digest: digest, dataset_digest: assertion.dataset.digest,
      citation_count: j.citations.length, claim_count: j.claims?.length ?? 0 });
    j.citations.forEach((citation, ordinal) => {
      const key = `${assertion.attemptId}/${citation.eventId}`;
      tables.citations!.push({ assertion_id: assertion.id, ordinal, attempt_id: assertion.attemptId, event_id: citation.eventId, event_key: key,
        occurrence_id: citation.occurrenceId ?? null, native_artifact: citation.nativeReference.artifactId, native_locator: citation.nativeReference.recordLocator,
        resolved: eventKeys.has(key) });
    });
    (j.claims ?? []).forEach((claim, ordinal) => {
      tables.claims!.push({ assertion_id: assertion.id, claim_id: claim.id, ordinal, text: claim.text, workspace: claim.workspace,
        citation_event_keys: JSON.stringify(claim.citations.map(({ eventId }) => `${assertion.attemptId}/${eventId}`)) });
    });
  }

  const edges = tables.edges!;
  const edge = (src_type: string, src_id: unknown, rel: unknown, dst_type: string, dst_id: unknown) => edges.push({ src_type, src_id: String(src_id), rel: String(rel), dst_type, dst_id: String(dst_id) });
  for (const r of tables.attempt_cohorts!) edge("attempt", r.attempt_id, "member-of", "cohort", r.cohort_id);
  for (const r of tables.events!) {
    edge("event", r.event_key, "part-of", "attempt", r.attempt_id);
    if (r.parent_event_key) edge("event", r.event_key, "child-of", "event", r.parent_event_key);
  }
  for (const r of tables.event_relations!) edge("event", r.src_event_key, r.kind, "event", r.dst_event_key);
  for (const r of tables.assessments!) edge("assessment", r.assertion_id, "about", "attempt", r.attempt_id);
  for (const r of tables.citations!) edge("assessment", r.assertion_id, "cites", "event", r.event_key);
  for (const r of tables.observations!) edge("observation", r.observation_id, "about", "attempt", r.attempt_id);
  for (const r of tables.observation_sources!) edge("observation", r.observation_id, "derived-from", "event", r.event_key);
  for (const r of tables.occurrences!) {
    edge("occurrence", r.occurrence_id, "about", "attempt", r.attempt_id);
    for (const key of JSON.parse(String(r.event_keys)) as string[]) edge("occurrence", r.occurrence_id, "derived-from", "event", key);
  }

  const tableIndex = await writeTables(tables, join(outputRoot, "tables"));
  const files = [...readdirSync(join(outputRoot, "reports")).map((f) => ({ path: `reports/${f}`, role: "cohort-report" })),
    ...Object.values(tableIndex).map(({ path }) => ({ path, role: "table" }))]
    .map(({ path, role }) => ({ path, role, bytes: statSync(join(outputRoot, path)).size, sha256: sha256(readFileSync(join(outputRoot, path))) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: AtlasBundleManifest = {
    schemaVersion: "ebo.atlas-bundle/v1", id: request.id, title: request.title, builder: ATLAS_BUNDLE_BUILDER, tablesVersion: ATLAS_TABLES_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(), request: { digest: `sha256:${digestMetadata(request).value}` },
    cohorts, tables: tableIndex, files,
  };
  const errors = validateArtifact("atlas bundle", manifest);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Recompute every listed file's size and digest; report changed, missing and unlisted files. */
export function verifyAtlasBundle(root: string): { ok: boolean; changed: string[]; missing: string[]; unlisted: string[] } {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as AtlasBundleManifest;
  const errors = validateArtifact("atlas bundle", manifest);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  const listed = new Set(manifest.files.map(({ path }) => path));
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const present = walk("").map((p) => p.replace(/\\/gu, "/")).filter((p) => p !== "manifest.json");
  const missing = manifest.files.filter(({ path }) => !existsSync(join(root, path))).map(({ path }) => path);
  const changed = manifest.files.filter(({ path, bytes, sha256: digest }) => existsSync(join(root, path))
    && (statSync(join(root, path)).size !== bytes || sha256(readFileSync(join(root, path))) !== digest)).map(({ path }) => path);
  const unlisted = present.filter((p) => !listed.has(p));
  return { ok: !missing.length && !changed.length && !unlisted.length, changed, missing, unlisted };
}
