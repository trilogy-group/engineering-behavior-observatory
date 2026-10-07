import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

import { canonicalizeMetadata, digestMetadata, validateArtifact } from "./artifacts.js";
import { loadAtlas, queryAtlas, type AtlasSource, type AtlasView } from "./atlas.js";
import { Field, List, makeVector, Table, tableToIPC, Utf8, vectorFromArray } from "apache-arrow";
import { buildViews, validateClaims, type ClaimsSource } from "./atlas-claims.js";
import { DEFAULT_FIREWORKS_MODEL, embedTexts, LOCAL_EMBEDDING_MODEL } from "./atlas-embeddings.js";
import { assessmentDoc, attemptEvidence, NativeLines } from "./atlas-evidence.js";
import { laneData, type LaneMeta } from "./atlas-lanes.js";
import { ATLAS_UNITS_VERSION, deriveUnits, type AtlasUnit } from "./atlas-units.js";
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
  /** Study-authored claims (validated, never generated) and a directory of view specs. */
  claims?: string;
  views?: string;
  /**
   * Unit embeddings for the cloud. Local (no network) unless the request names a remote provider: `fireworks` sends
   * each unit's redacted `embed_text` to Fireworks (FIREWORKS_API_KEY) and caches the vectors.
   */
  embeddings?: { provider?: "local" | "fireworks"; model?: string; dimensions?: number; cache?: string };
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
  unitsVersion: typeof ATLAS_UNITS_VERSION;
  /** The cloud's units and their embeddings; the viewer lays them out with Embedding Atlas (UMAP and clustering). */
  cloud: { units: number; embeddings: { file: string; provider: "local" | "fireworks"; model: string; dimensions: number } };
  tables: Record<string, { path: string; rows: number; sha256: `sha256:${string}` }>;
  files: Array<{ path: string; bytes: number; sha256: `sha256:${string}`; role: string }>;
};

type Row = Record<string, string | number | boolean | null | string[]>;
type Column = [name: string, type: "VARCHAR" | "BIGINT" | "DOUBLE" | "BOOLEAN" | "VARCHAR[]"];
const S = "VARCHAR", I = "BIGINT", F = "DOUBLE", B = "BOOLEAN", L = "VARCHAR[]";

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
  units: [["unit_id", S], ["attempt_id", S], ["seq", I], ["unit_kind", S], ["subkind", S], ["role", S], ["episode_id", S], ["model_id", S],
    ["harness_id", S], ["task_id", S], ["trial_id", S], ["condition", S], ["terminal_state", S], ["tool_name", S], ["tool_kind", S],
    ["command", S], ["command_head", S], ["check_kind", S], ["check_kinds", L], ["writes", L], ["target", S], ["status", S], ["exit_code", I],
    ["duration_seconds", F], ["input_chars", I], ["output_chars", I], ["output_lines", I], ["lines_added", I], ["lines_removed", I],
    ["error_signature", S], ["tool_count", I], ["error_count", I], ["t_start", S], ["t_end", S], ["event_count", I], ["first_event_key", S],
    ["cited_assertions", L], ["cited_assessments", L], ["cited", B], ["observation_extractors", L], ["occurrences", L], ["embed", B],
    ["embed_text", S], ["embed_chars", I]],
  unit_events: [["unit_id", S], ["event_key", S], ["part", S]],
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
    // The condition pattern is study configuration (trusted, at most 1000 characters by the request schema).
    const pattern = new RegExp(request.condition.pattern, "u"); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
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
    const tokens = (marker === -1 ? "" : reference.recordLocator.slice(marker + 1)).split("/").slice(1).map((t) => t.replace(/~1/gu, "/").replace(/~0/gu, "~"));
    const value = ownPointer(records.get(key), tokens);
    return value === undefined ? { status: "bad-pointer" } : { status: "resolved", value };
  };
}

/** A JSON pointer over own properties only: a segment such as __proto__ never reaches an inherited object. */
export function ownPointer(value: unknown, tokens: readonly string[]): unknown {
  if (!tokens.length) return value;
  const [token, ...rest] = tokens;
  return value !== null && typeof value === "object" && Object.hasOwn(value, token!) ? ownPointer((value as Record<string, unknown>)[token!], rest) : undefined;
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

/**
 * Rows of the large tables (events with their native content, relations, unit links, edges) go to disk as they are
 * produced; a study's native content can far exceed memory.
 */
const STREAMED = new Set(["events", "event_relations", "observation_sources", "unit_events", "edges"]);
class TableSink {
  readonly staging = mkdtempSync(join(tmpdir(), "ebo-atlas-tables-"));
  private fds = new Map<string, number>();
  readonly counts = new Map<string, number>();
  push(name: string, row: Row) {
    let fd = this.fds.get(name);
    if (fd === undefined) { fd = openSync(join(this.staging, `${name}.ndjson`), "w"); this.fds.set(name, fd); }
    writeSync(fd, `${JSON.stringify(Object.fromEntries(ATLAS_TABLES[name]!.map(([column]) => [column, row[column] ?? null])))}\n`);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }
  close() { for (const fd of this.fds.values()) closeSync(fd); this.fds.clear(); }
}

async function writeTables(tables: Record<string, Row[]>, directory: string, sink: TableSink) {
  mkdirSync(directory, { recursive: true });
  const staging = sink.staging;
  sink.close();
  const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
  const connection = await db.connect();
  const quote = (s: string) => `'${s.replace(/'/gu, "''")}'`;
  try {
    const out: AtlasBundleManifest["tables"] = {};
    for (const [name, columns] of Object.entries(ATLAS_TABLES)) {
      const ndjson = join(staging, `${name}.ndjson`);
      let count: number;
      if (STREAMED.has(name)) count = sink.counts.get(name) ?? 0;
      else {
        // One line at a time: a study's native content can exceed the largest single string V8 allows.
        const rows = tables[name] ?? [];
        const fd = openSync(ndjson, "w");
        try { for (const row of rows) writeSync(fd, `${JSON.stringify(Object.fromEntries(columns.map(([column]) => [column, row[column] ?? null])))}\n`); } finally { closeSync(fd); }
        count = rows.length;
      }
      const path = join(directory, `${name}.parquet`);
      const spec = `{${columns.map(([column, type]) => `${column}: ${quote(type)}`).join(", ")}}`;
      const select = count
        ? `SELECT ${columns.map(([column]) => column).join(", ")} FROM read_json(${quote(ndjson)}, format = 'newline_delimited', columns = ${spec}, maximum_object_size = 1073741824)`
        : `SELECT ${columns.map(([column, type]) => `CAST(NULL AS ${type}) AS ${column}`).join(", ")} WHERE false`;
      await connection.run(`COPY (${select}) TO ${quote(path)} (FORMAT parquet, COMPRESSION zstd)`);
      out[name] = { path: `tables/${name}.parquet`, rows: count, sha256: sha256(readFileSync(path)) };
    }
    return out;
  } finally {
    connection.closeSync();
    db.closeSync();
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Build into a temporary sibling and publish it by rename only after the manifest validates, so a failed build
 * (invalid source, DuckDB, embedding provider) never leaves a partial bundle at the destination.
 */
export async function buildAtlasBundle(requestPath: string, destination: string,
  options: { now?: () => Date; embed?: typeof embedTexts } = {}): Promise<AtlasBundleManifest> {
  const request = readRequest(requestPath);
  if (existsSync(destination) && readdirSync(destination).length) throw new Error(`Atlas bundle output ${destination} is not empty; choose a new directory.`);
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  const outputRoot = mkdtempSync(join(dirname(resolve(destination)), `.${basename(destination)}.partial-`));
  try {
    const manifest = await writeAtlasBundle(request, requestPath, outputRoot, options);
    if (existsSync(destination)) rmSync(destination, { recursive: true });
    renameSync(outputRoot, destination);
    return manifest;
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeAtlasBundle(request: AtlasBundleRequest, requestPath: string, outputRoot: string,
  options: { now?: () => Date; embed?: typeof embedTexts }): Promise<AtlasBundleManifest> {
  const base = dirname(resolve(requestPath));
  const condition = request.condition ? new RegExp(request.condition.pattern, "u") : undefined; // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const tables: Record<string, Row[]> = Object.fromEntries(Object.keys(ATLAS_TABLES).filter((name) => !STREAMED.has(name)).map((name) => [name, []]));
  const sink = new TableSink();
  const stream = (name: string, row: Row) => sink.push(name, row);
  const cohorts: AtlasBundleManifest["cohorts"] = [];
  const attempts = new Map<string, { entry: CorpusIndexEntry; bundleRoot: string; cohorts: Set<string> }>();
  const observationSets = new Map<string, StructuralObservationSet>();
  const assertions = new Map<string, { assertion: BehaviorAssertion; digest: string; review: string; cohorts: Set<string> }>();
  mkdirSync(join(outputRoot, "reports"), { recursive: true });
  mkdirSync(join(outputRoot, "native"), { recursive: true });
  const reports = new Map<string, AtlasView>();

  for (const cohort of request.cohorts) {
    const atlasPath = resolve(base, cohort.atlasRequest);
    const source: AtlasSource = await loadAtlas(atlasPath);
    const view: AtlasView = await queryAtlas(source);
    // Keep the report, not the view's cases (they carry native records for display).
    reports.set(cohort.id, { title: view.title, generatedAt: view.generatedAt, report: view.report } as AtlasView);
    // Members are the attempts the cohort's selection policy keeps (every selected attempt has at least one case),
    // so superseded retries stay out of the cohort as they stay out of its certified report.
    const selected = new Set(view.cases.map(({ attemptId }) => attemptId));
    for (const entry of source.input.corpusEntries.filter(({ manifestKind, attemptId }) => manifestKind === "run" && selected.has(attemptId!))) {
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

  // Units carry which judgments cite them and which structural observations draw on them.
  const citedBy = new Map<string, Array<{ id: string; label: string }>>();
  for (const { assertion } of assertions.values()) {
    const label = `${assertion.behavior.categoryId}:${assertion.judgment.disposition === "assessed" ? assertion.judgment.assessment : "abstained"}`;
    for (const citation of assertion.judgment.citations) {
      const key = `${assertion.attemptId}/${citation.eventId}`;
      citedBy.set(key, [...citedBy.get(key) ?? [], { id: assertion.id, label }]);
    }
  }
  const extractorsOf = new Map<string, Set<string>>();
  for (const [attemptId, set] of observationSets) for (const observation of set.observations) for (const eventId of observation.sourceEventIds) {
    const key = `${attemptId}/${eventId}`;
    extractorsOf.set(key, (extractorsOf.get(key) ?? new Set()).add(observation.extractor.id));
  }
  // With a condition pattern every run bundle must match it; a naming mistake is an error, not a synthesized arm.
  const armOf = (name: string, entry: CorpusIndexEntry) => {
    if (!condition) return `${entry.modelId ?? "unavailable"} · ${entry.harnessId ?? "unavailable"}`;
    const arm = condition.exec(name)?.groups?.condition;
    if (!arm) throw new Error(`Run bundle ${name} does not match the condition pattern ${request.condition!.pattern}.`);
    return arm;
  };
  const eventKeys = new Set<string>();
  const cloud: Array<AtlasUnit & Row & { row_id: number; t0_ms: number | null; t1_ms: number | null; timed: boolean }> = [];
  const audits: Record<string, unknown> = {};
  const lanes: { attempts: LaneMeta[]; usage: Record<string, Array<[number, number]>>; context: Record<string, Array<[number, number]>> } = { attempts: [], usage: {}, context: {} };
  const attemptMeta: unknown[] = [];
  const assessmentDocs: unknown[] = [];
  for (const [attemptId, { entry, bundleRoot, cohorts: memberOf }] of [...attempts].sort(([a], [b]) => a.localeCompare(b))) {
    const evidence = await createRetainedBehaviorEvidence(bundleRoot);
    const resolveContent = contentResolver(evidence);
    const derived = deriveUnits({ attemptId, events: evidence.dataset.events, occurrences: observationSets.get(attemptId)?.occurrences ?? [],
      resolveContent: (reference) => { const r = resolveContent(reference); return r.status === "resolved" ? r.value : undefined; } });
    const linksOf = new Map<string, string[]>();
    for (const link of derived.links) linksOf.set(link.unit_id, [...linksOf.get(link.unit_id) ?? [], link.event_key]);
    for (const unit of derived.units) {
      const keys = unit.unit_kind === "episode" ? derived.units.filter((u) => u.episode_id === unit.unit_id).flatMap((u) => linksOf.get(u.unit_id) ?? []) : linksOf.get(unit.unit_id) ?? [];
      const cites = [...new Map(keys.flatMap((k) => citedBy.get(k) ?? []).map((c) => [c.id, c])).values()].sort((a, b) => a.id.localeCompare(b.id));
      tables.units!.push({ ...unit, model_id: entry.modelId ?? null, harness_id: entry.harnessId ?? null, task_id: entry.taskId ?? null, trial_id: entry.trialId ?? null,
        condition: null, terminal_state: entry.terminalState ?? null, cited_assertions: cites.map(({ id }) => id), cited_assessments: cites.map(({ label }) => label),
        cited: cites.length > 0, observation_extractors: [...new Set(keys.flatMap((k) => [...extractorsOf.get(k) ?? []]))].sort() });
    }
    for (const link of derived.links) stream("unit_events", link);
    // Event rows carry the resolved native content; each is written as soon as it is built, never held.
    const times = evidence.dataset.events.flatMap((e) => (e.nativeTime.status === "known" && Number.isFinite(Date.parse(e.nativeTime.value)) ? [e.nativeTime.value] : []))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const first = times[0], last = times.at(-1);
    for (const [index, event] of evidence.dataset.events.entries()) {
      const row = eventRow(event, index, resolveContent);
      if (eventKeys.has(String(row.event_key))) throw new Error(`Duplicate event key ${String(row.event_key)}.`);
      eventKeys.add(String(row.event_key));
      if (first && typeof row.event_time === "string") row.t_rel_seconds = (Date.parse(row.event_time) - Date.parse(first)) / 1000;
      stream("events", row);
      stream("edges", { src_type: "event", src_id: row.event_key, rel: "part-of", dst_type: "attempt", dst_id: attemptId });
      if (row.parent_event_key) stream("edges", { src_type: "event", src_id: row.event_key, rel: "child-of", dst_type: "event", dst_id: row.parent_event_key });
    }
    for (const event of evidence.dataset.events) for (const relation of event.relations.known) {
      stream("event_relations", { src_event_key: `${attemptId}/${event.id}`, kind: relation.kind, dst_event_key: `${attemptId}/${relation.eventId}`, attempt_id: attemptId });
      stream("edges", { src_type: "event", src_id: `${attemptId}/${event.id}`, rel: relation.kind, dst_type: "event", dst_id: `${attemptId}/${relation.eventId}` });
    }
    const name = basename(bundleRoot);
    tables.attempts!.push({ attempt_id: attemptId, run_id: entry.runId ?? null, bundle_id: entry.bundleId ?? null, model_id: entry.modelId ?? null,
      model_provider: entry.modelProvider ?? null, harness_id: entry.harnessId ?? null, harness_version: entry.harnessVersion ?? null, task_id: entry.taskId ?? null,
      fixture_id: entry.fixtureId ?? null, trial_id: entry.trialId ?? null,
      condition: armOf(name, entry),
      assessment_mode: entry.assessmentMode ?? null, capture_qualification: entry.captureQualification ?? null, terminal_state: entry.terminalState ?? null,
      failure_class: entry.failureClass ?? null, stop_reason: entry.stopReason ?? null, adapter_id: evidence.dataset.adapter.id, adapter_version: evidence.dataset.adapter.version,
      dataset_digest: observationSets.get(attemptId)?.normalization.datasetDigest ?? null, manifest_digest: entry.manifestDigest ?? null,
      bundle_root: relative(base, bundleRoot), event_count: evidence.dataset.events.length, native_record_count: evidence.coverage.records.total,
      unmapped_record_count: evidence.coverage.records.unmapped, first_event_time: first ?? null, last_event_time: last ?? null,
      native_span_seconds: first && last ? (Date.parse(last) - Date.parse(first)) / 1000 : null });
    for (const cohortId of [...memberOf].sort()) tables.attempt_cohorts!.push({ attempt_id: attemptId, cohort_id: cohortId });
    const arm = tables.attempts!.at(-1)!.condition as string;
    for (const unit of tables.units!) if (unit.attempt_id === attemptId) unit.condition = arm;

    // Viewer documents for this attempt: cloud rows, swimlane, audit, native records and assessments.
    const short = attemptId.slice(0, 8);
    const ownUnits = tables.units!.filter((u) => u.attempt_id === attemptId) as unknown as Array<AtlasUnit & Row>;
    let carriedTime: number | null = null;
    const rowsOfAttempt: Array<AtlasUnit & Row & { row_id: number }> = [];
    for (const unit of ownUnits.filter((u) => u.embed).sort((a, b) => Number(a.seq) - Number(b.seq))) {
      const t0 = unit.t_start && Number.isFinite(Date.parse(unit.t_start)) ? Date.parse(unit.t_start) : null;
      const t1 = unit.t_end && Number.isFinite(Date.parse(unit.t_end)) ? Date.parse(unit.t_end) : null;
      const row = { ...unit, row_id: cloud.length, t0_ms: t0 ?? carriedTime, t1_ms: t0 === null ? carriedTime : t1 ?? t0, timed: t0 !== null };
      if (t0 !== null) carriedTime = unit.unit_kind === "episode" ? t0 : t1 ?? t0;
      cloud.push(row);
      rowsOfAttempt.push(row);
    }
    const native = new NativeLines(bundleRoot, relative(base, bundleRoot));
    const contentOf = (event: UniformEvent) => (event.content.status === "known"
      ? event.content.value.map(({ nativeReference }) => resolveContent(nativeReference)).flatMap((r) => (r.status === "resolved" ? [r.value] : [])) : []);
    const evidenceDocs = attemptEvidence({ attemptId, short, condition: arm, trialId: entry.trialId ?? null, cohorts: [...memberOf].sort(), units: rowsOfAttempt,
      links: derived.links, events: evidence.dataset.events, occurrences: observationSets.get(attemptId)?.occurrences ?? [], native, resolveContent: contentOf });
    audits[attemptId] = evidenceDocs.audit;
    writeFileSync(join(outputRoot, "native", `${attemptId}.json`), JSON.stringify(evidenceDocs.native));
    const attemptRow = { attempt_id: attemptId, task_id: entry.taskId ?? null, condition: arm, trial_id: entry.trialId ?? null, harness_id: entry.harnessId ?? null,
      model_id: entry.modelId ?? null, terminal_state: entry.terminalState ?? null, failure_class: entry.failureClass ?? null, capture_qualification: entry.captureQualification ?? null };
    const lane = laneData(attemptRow, rowsOfAttempt, evidence.dataset.events);
    lane.lane.cited_units = rowsOfAttempt.filter((u) => u.cited && u.unit_kind !== "episode").length;
    lanes.attempts.push(lane.lane);
    if (lane.usage) lanes.usage[attemptId] = lane.usage;
    if (lane.context) lanes.context[attemptId] = lane.context;
    const eventTypes: Record<string, number> = {};
    for (const event of evidence.dataset.events) { const k = `${event.family} · ${String(event.attributes.eventType ?? event.attributes.itemType ?? event.attributes.method ?? event.source.nativeType)}`; eventTypes[k] = (eventTypes[k] ?? 0) + 1; }
    attemptMeta.push({ ...attemptRow, short, cohorts: [...memberOf].sort(), bundle: relative(base, bundleRoot), native_span_seconds: tables.attempts!.at(-1)!.native_span_seconds,
      native_record_count: evidence.coverage.records.total, unmapped_record_count: evidence.coverage.records.unmapped, event_count: evidence.dataset.events.length,
      event_types: eventTypes, units: ownUnits.filter((u) => u.unit_kind !== "episode").length, tool_calls: ownUnits.filter((u) => u.unit_kind === "tool").length });
    for (const { assertion, review } of [...assertions.values()].filter(({ assertion: a }) => a.attemptId === attemptId)) {
      const flags = Object.fromEntries(tables.assessment_cohorts!.filter((r) => r.assertion_id === assertion.id)
        .map((r) => [String(r.cohort_id), { included: r.included === true, disputed: r.disputed === true, review: String(r.review_outcome ?? "") }]));
      assessmentDocs.push(assessmentDoc(assertion, { short, condition: arm, taskId: entry.taskId ?? null, trialId: entry.trialId ?? null, review,
        cohorts: Object.keys(flags).length ? flags : Object.fromEntries([...memberOf].map((c) => [c, { included: true }])) }, evidenceDocs.linkCitation, native));
    }
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
      for (const eventId of sources) {
        stream("observation_sources", { observation_id: observation.id, attempt_id: attemptId, event_id: eventId, event_key: `${attemptId}/${eventId}` });
        stream("edges", { src_type: "observation", src_id: observation.id, rel: "derived-from", dst_type: "event", dst_id: `${attemptId}/${eventId}` });
      }
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

  const edge = (src_type: string, src_id: unknown, rel: unknown, dst_type: string, dst_id: unknown) => stream("edges", { src_type, src_id: String(src_id), rel: String(rel), dst_type, dst_id: String(dst_id) });
  for (const r of tables.attempt_cohorts!) edge("attempt", r.attempt_id, "member-of", "cohort", r.cohort_id);
  for (const r of tables.assessments!) edge("assessment", r.assertion_id, "about", "attempt", r.attempt_id);
  for (const r of tables.citations!) edge("assessment", r.assertion_id, "cites", "event", r.event_key);
  for (const r of tables.observations!) edge("observation", r.observation_id, "about", "attempt", r.attempt_id);
  for (const r of tables.occurrences!) {
    edge("occurrence", r.occurrence_id, "about", "attempt", r.attempt_id);
    for (const key of JSON.parse(String(r.event_keys)) as string[]) edge("occurrence", r.occurrence_id, "derived-from", "event", key);
  }

  const tableIndex = await writeTables(tables, join(outputRoot, "tables"), sink);

  // The cloud: units.arrow (Arrow IPC, so DuckDB-WASM needs no extensions) and the embeddings in row order.
  const provider = request.embeddings?.provider ?? "local";
  const embeddingConfig = { provider, model: request.embeddings?.model ?? (provider === "fireworks" ? DEFAULT_FIREWORKS_MODEL : LOCAL_EMBEDDING_MODEL),
    dimensions: request.embeddings?.dimensions ?? 256, cache: resolve(base, request.embeddings?.cache ?? ".atlas-cache/embeddings") };
  const vectors = await (options.embed ?? embedTexts)(cloud.map((u) => u.embed_text), embeddingConfig);
  writeFileSync(join(outputRoot, "embeddings.f32"), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  const strings = (key: string) => cloud.map((u) => (u[key as keyof typeof u] ?? null) as string | null);
  const numbers = (key: string) => cloud.map((u) => (typeof u[key as keyof typeof u] === "number" ? u[key as keyof typeof u] as number : null));
  const lists = (key: string) => vectorFromArray(cloud.map((u) => [...(u[key as keyof typeof u] as string[] ?? [])]), new List(new Field("item", new Utf8(), true)));
  const FAMILY: Record<string, string> = { message: "messages", compaction: "messages", episode: "episodes", tool: "tools" };
  const cloudTable = new Table({
    row_id: makeVector(Int32Array.from(cloud.map((u) => u.row_id))),
    ...Object.fromEntries(["unit_id", "attempt_id", "unit_kind", "subkind", "role", "episode_id", "model_id", "harness_id", "task_id", "trial_id", "condition",
      "terminal_state", "tool_name", "tool_kind", "command_head", "check_kind", "target", "status", "error_signature", "first_event_key", "embed_text"]
      .map((key) => [key, vectorFromArray(strings(key), new Utf8())])),
    family: vectorFromArray(cloud.map((u) => FAMILY[u.unit_kind] ?? "tools"), new Utf8()),
    ...Object.fromEntries(["seq", "exit_code", "duration_seconds", "input_chars", "output_chars", "output_lines", "lines_added", "lines_removed", "tool_count",
      "error_count", "event_count", "t0_ms", "t1_ms"].map((key) => [key, vectorFromArray(numbers(key))])),
    timed: vectorFromArray(cloud.map((u) => u.timed)),
    cited: vectorFromArray(cloud.map((u) => u.cited === true)),
    ...Object.fromEntries(["check_kinds", "writes", "occurrences", "cited_assessments"].map((key) => [key, lists(key)])),
  });
  writeFileSync(join(outputRoot, "units.arrow"), tableToIPC(cloudTable, "stream"));

  writeFileSync(join(outputRoot, "lanes.json"), JSON.stringify(lanes));
  writeFileSync(join(outputRoot, "audit.json"), JSON.stringify({ study: request.id, attempts: audits }));
  const certified = Object.fromEntries([...reports].map(([id, view]) => [id, { source: `reports/${id}.json`, generated_at: view.generatedAt,
    group_by: (view.report.policy as { groupBy?: unknown }).groupBy ?? null,
    cells: view.report.groups.flatMap((group) => (group.behaviors ?? []).map((b) => ({ group: group.dimensions, category: b.behavior.categoryId,
      counts: Object.fromEntries(b.assessments.map((a) => [a.assessment, a.measurement.numerator.value])),
      denominator: Math.max(...b.assessments.map((a) => a.measurement.denominator.value)),
      assertions: b.assertions.filter((a) => a.included).map((a) => a.id) }))) }]));
  const assessmentsDocument = { study: request.id, generated_by: `${ATLAS_BUNDLE_BUILDER.id} ${ATLAS_BUNDLE_BUILDER.version}`,
    outcomes: ["constructive", "mixed", "adverse", "context-dependent", "abstained"],
    cohorts: [...reports].map(([id, view]) => ({ id, title: view.title, report: `reports/${id}.json`, certified: true })),
    attempts: attemptMeta, assessments: assessmentDocs, certified,
    notes: ["Outcome 'abstained' = disposition abstained (no assessment value).",
      "Certified tallies are the cohort aggregation reports in this bundle; counts computed in the viewer are exploratory."] };
  writeFileSync(join(outputRoot, "assessments.json"), JSON.stringify(assessmentsDocument));

  // View receipts over the viewer's host tables; claims over the bundle tables (two connections, as each consumer sees them).
  const quote = (p: string) => `'${p.replace(/'/gu, "''")}'`;
  const tablePath = (name: string) => quote(join(outputRoot, "tables", `${name}.parquet`));
  const extensionsOff = { autoinstall_known_extensions: "false", autoload_known_extensions: "false" };
  let viewIds = new Set<string>();
  if (request.views) {
    const db = await DuckDBInstance.create(":memory:", extensionsOff);
    const c = await db.connect();
    try {
      await c.run(`CREATE TABLE units AS SELECT * FROM ${tablePath("units")} WHERE embed`);
      await c.run(`CREATE TABLE assessments (id VARCHAR, attempt_id VARCHAR, condition VARCHAR, task_id VARCHAR, trial_id VARCHAR, dimension VARCHAR, outcome VARCHAR, confidence DOUBLE, citations BIGINT, in_primary BOOLEAN)`);
      for (const a of assessmentDocs as Array<{ id: string; attempt_id: string; condition: string; task_id: string | null; trial_id: string | null; dimension: string; outcome: string; confidence: number | null; citations: unknown[]; cohorts: Record<string, { included?: boolean }> }>) {
        const prepared = await c.prepare("INSERT INTO assessments VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)");
        prepared.bind([a.id, a.attempt_id, a.condition, a.task_id, a.trial_id, a.dimension, a.outcome, a.confidence, a.citations.length, a.cohorts.primary?.included === true]);
        await prepared.run();
      }
      const views = await buildViews(resolve(base, request.views), c, request.id);
      viewIds = new Set(views.views.map(({ id }) => id));
      writeFileSync(join(outputRoot, "views.json"), JSON.stringify(views));
    } finally { c.closeSync(); db.closeSync(); }
  }
  if (request.claims) {
    const db = await DuckDBInstance.create(":memory:", extensionsOff);
    const c = await db.connect();
    const lines = new Map<string, string[]>();
    try {
      for (const name of ["assessments", "attempts", "assessment_cohorts", "attempt_cohorts", "citations"]) await c.run(`CREATE VIEW ${name} AS SELECT * FROM ${tablePath(name)}`);
      await c.run(`CREATE VIEW units AS SELECT * FROM ${tablePath("units")} WHERE embed`);
      const attemptsById = Object.fromEntries(tables.attempts!.map((a) => [String(a.attempt_id), { model_id: a.model_id as string | null, harness_id: a.harness_id as string | null }]));
      const claims = await validateClaims(JSON.parse(readFileSync(resolve(base, request.claims), "utf8")) as ClaimsSource, {
        connection: c, certified, reports: Object.fromEntries([...reports].map(([id, view]) => [id, { report: view.report }])),
        assessments: assessmentDocs as never, audits: audits as never, attempts: attemptsById, viewIds,
        readLine: (path, locator) => {
          if (!lines.has(path)) { try { lines.set(path, readFileSync(resolve(base, path), "utf8").split("\n")); } catch { lines.set(path, []); } }
          return lines.get(path)![Number(/^line:(\d+)/u.exec(locator)?.[1] ?? 0) - 1];
        },
      });
      writeFileSync(join(outputRoot, "claims.json"), JSON.stringify(claims));
    } finally { c.closeSync(); db.closeSync(); }
  }
  const files = [...readdirSync(join(outputRoot, "reports")).map((f) => ({ path: `reports/${f}`, role: "cohort-report" })),
    ...Object.values(tableIndex).map(({ path }) => ({ path, role: "table" })),
    ...readdirSync(join(outputRoot, "native")).map((f) => ({ path: `native/${f}`, role: "native-records" })),
    ...[["units.arrow", "cloud-units"], ["embeddings.f32", "cloud-embeddings"], ["lanes.json", "swimlanes"], ["audit.json", "audits"], ["assessments.json", "assessments"],
      ["claims.json", "claims"], ["views.json", "view-specs"]].filter(([path]) => existsSync(join(outputRoot, path!))).map(([path, role]) => ({ path: path!, role: role! }))]
    .map(({ path, role }) => ({ path, role, bytes: statSync(join(outputRoot, path)).size, sha256: sha256(readFileSync(join(outputRoot, path))) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: AtlasBundleManifest = {
    schemaVersion: "ebo.atlas-bundle/v1", id: request.id, title: request.title, builder: ATLAS_BUNDLE_BUILDER, tablesVersion: ATLAS_TABLES_VERSION, unitsVersion: ATLAS_UNITS_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(), request: { digest: `sha256:${digestMetadata(request).value}` },
    cloud: { units: cloud.length, embeddings: { file: "embeddings.f32", provider: embeddingConfig.provider, model: embeddingConfig.model, dimensions: embeddingConfig.dimensions } },
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
