import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";

import { ownPointer } from "./atlas-bundle.js";

/**
 * Claims and view specs in an Atlas bundle. Claims are authored by the study (never generated) and validated here:
 * every number recomputes to its stated value, every supporting assessment exists and every cited native line still
 * hashes to its recorded SHA-256, and every cited view exists. View specs (an EBO envelope around a Mosaic JSON spec)
 * get a receipt: their query recomputed with DuckDB over the same host tables the viewer builds, canonicalized and
 * hashed exactly as the browser does, so the viewer can show that its numbers match the build.
 */
export const VIEW_SPEC_FORMAT = "ebo.view-spec/0.1 (Mosaic JSON spec 0.32)";

type Num = { id: string; label: string; value: number; kind: "certified" | "judge" | "lab";
  expr: { cohort: string; where?: Record<string, string>; outcome: string } | { report: { cohort: string; pointer: string } } | { sql: string }
    | { audit: { model: string; harness: string; kind: string; status: string[] } } };
export type ClaimsSource = { study: string; source: { file: string; title: string; also?: string[] }; number_kinds: Record<string, string>;
  claims: Array<{ id: string; type: string; text: string; source_section: string; cohort?: string; caveat?: string; numbers: Num[]; support?: string[]; support_sql?: string; views?: string[] }> };

type CertifiedCell = { group: Record<string, string>; category: string; counts: Record<string, number>; denominator: number };
type AssessmentDoc = { id: string; attempt_id: string; short: string; condition: string; trial_id: string | null; dimension: string; outcome: string;
  citations: Array<{ event_key: string; native: { resolved: boolean; path?: string; locator: string; sha256?: string } }> };
type AuditDoc = { short: string; trial_id: string | null; cohorts: string[]; verdicts: Array<{ kind: string; status: string }> };

/** Canonical rows: keys sorted, whole numbers as integers, compact UTF-8 JSON (the browser applies the same rule). */
export function canonicalRows(rows: ReadonlyArray<Record<string, unknown>>): string {
  const value = (x: unknown) => (typeof x === "bigint" ? Number(x) : typeof x === "number" && Number.isInteger(x) ? Math.trunc(x) : x);
  return JSON.stringify(rows.map((r) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, value(r[k])]))));
}

async function rowsOf(connection: DuckDBConnection, sql: string): Promise<Array<Record<string, unknown>>> {
  return (await connection.runAndReadAll(sql)).getRowObjectsJS() as Array<Record<string, unknown>>;
}

function pointer(document: unknown, path: string): unknown {
  return ownPointer(document, path.split("/").slice(1).map((t) => t.replace(/~1/gu, "/").replace(/~0/gu, "~")));
}

export async function validateClaims(source: ClaimsSource, context: {
  connection: DuckDBConnection; certified: Record<string, { cells: CertifiedCell[] }>; reports: Record<string, unknown>;
  assessments: readonly AssessmentDoc[]; audits: Record<string, AuditDoc>; attempts: Record<string, { model_id: string | null; harness_id: string | null }>;
  viewIds: ReadonlySet<string>; recordSha256: (path: string, locator: string) => string | undefined;
}) {
  const failures: string[] = [];
  const ids = source.claims.map(({ id }) => id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) failures.push(`${id}: claim ids must be unique`);
  const byId = new Map(context.assessments.map((a) => [a.id, a]));
  const claims = [];
  for (const claim of source.claims) {
    const support = claim.support ?? (await rowsOf(context.connection, claim.support_sql!)).map((r) => String(Object.values(r)[0]));
    await context.connection.run("CREATE OR REPLACE TEMP TABLE support AS SELECT * FROM assessments WHERE false");
    if (support.length) await context.connection.run(`INSERT INTO support SELECT * FROM assessments WHERE assertion_id IN (${support.map((s) => `'${s.replace(/'/gu, "''")}'`).join(", ")})`);
    const numbers = [];
    for (const n of claim.numbers) {
      let computed: number, how: string;
      const e = n.expr;
      if ("report" in e) {
        const v = pointer(context.reports[e.report.cohort], e.report.pointer);
        computed = typeof v === "number" ? v : Number.NaN;
        how = `report ${e.report.cohort} at ${e.report.pointer}`;
      } else if ("cohort" in e) {
        // Every filter key must be the behavior category or a dimension the cohort's report groups by.
        const cells = context.certified[e.cohort]?.cells ?? [];
        const unsupported = Object.keys(e.where ?? {}).filter((k) => k !== "category" && !cells.every((c) => k in c.group));
        if (unsupported.length) failures.push(`${claim.id}.${n.id}: cohort ${e.cohort} is not grouped by ${unsupported.join(", ")}`);
        // A selector that matches no cell, or an outcome the report does not have, is unavailable, never a zero.
        const matching = cells.filter((c) => Object.entries(e.where ?? {}).every(([k, v]) => (k === "category" ? c.category === v : c.group[k] === v)));
        const knownOutcome = e.outcome === "*denominator" || cells.some((c) => e.outcome in c.counts);
        if (!unsupported.length && !matching.length) failures.push(`${claim.id}.${n.id}: no report cell of cohort ${e.cohort} matches ${JSON.stringify(e.where ?? {})}`);
        if (!knownOutcome) failures.push(`${claim.id}.${n.id}: cohort ${e.cohort} reports no outcome ${e.outcome}`);
        computed = unsupported.length || !matching.length || !knownOutcome ? Number.NaN
          : matching.reduce((sum, c) => sum + (e.outcome === "*denominator" ? c.denominator : c.counts[e.outcome] ?? 0), 0);
        how = `cohort report ${e.cohort}, ${JSON.stringify(e.where ?? {})}, outcome ${e.outcome}`;
      } else if ("sql" in e) {
        const rows = await rowsOf(context.connection, e.sql);
        computed = Number(Object.values(rows[0] ?? {})[0] ?? Number.NaN);
        how = e.sql;
      } else {
        const q = e.audit;
        const hits = Object.entries(context.audits).filter(([aid, a]) => context.attempts[aid]?.model_id === q.model && context.attempts[aid]?.harness_id === q.harness
          && a.verdicts.some((v) => v.kind === q.kind && q.status.includes(v.status)) && (!claim.cohort || a.cohorts.includes(claim.cohort)));
        computed = hits.length;
        how = `audit verdicts ${JSON.stringify(q)}: ${hits.map(([, a]) => `${a.short} (trial ${a.trial_id ?? "?"})`).join(", ")}`;
      }
      const ok = computed === n.value;
      if (!ok) failures.push(`${claim.id}.${n.id}: stated ${n.value}, computed ${Number.isNaN(computed) ? "unavailable" : computed}`);
      numbers.push({ id: n.id, label: n.label, value: n.value, kind: n.kind, computed: Number.isNaN(computed) ? null : computed, ok, how });
    }
    for (const view of claim.views ?? []) if (!context.viewIds.has(view)) failures.push(`${claim.id}: cites view ${view}, which this bundle does not have`);
    let resolved = 0, total = 0;
    const supportRows = [];
    for (const id of support) {
      const a = byId.get(id);
      if (!a) { failures.push(`${claim.id}: supporting assessment ${id} is not in this bundle`); continue; }
      for (const c of a.citations) {
        total++;
        const digest = c.native.resolved && c.native.path ? context.recordSha256(c.native.path, c.native.locator) : undefined;
        if (digest !== undefined && digest === c.native.sha256) resolved++;
        else failures.push(`${claim.id}: citation ${c.event_key} of ${id} does not resolve to its native line`);
      }
      supportRows.push({ id, attempt_id: a.attempt_id, short: a.short, condition: a.condition, trial_id: a.trial_id, dimension: a.dimension, outcome: a.outcome, citations: a.citations.length });
    }
    const { numbers: _n, support: _s, support_sql: _q, ...rest } = claim;
    claims.push({ ...rest, numbers, support: supportRows, citations_resolved: resolved, citations_total: total,
      ok: numbers.every((n) => n.ok) && resolved === total && supportRows.length === support.length && (claim.views ?? []).every((v) => context.viewIds.has(v)) });
  }
  return { study: source.study, source: source.source, number_kinds: source.number_kinds, claims, validated: failures.length === 0, failures };
}

type ViewSpec = { id: string; title: string; description: string; tables: string[]; population: string; numbers: "certified" | "exploratory"; query: string; spec: { data?: Record<string, string> } };

/** Validate view-spec envelopes in a directory and attach each view's receipt. Fails on an invalid envelope or query. */
export async function buildViews(directory: string, connection: DuckDBConnection, study: string) {
  const views = [];
  const seen = new Set<string>();
  for (const file of readdirSync(directory).filter((f) => f.endsWith(".json")).sort()) {
    const v = JSON.parse(readFileSync(join(directory, file), "utf8")) as ViewSpec;
    const missing = ["id", "title", "description", "tables", "population", "numbers", "query", "spec"].filter((k) => !(k in v));
    if (missing.length) throw new Error(`${file}: view spec is missing ${missing.join(", ")}.`);
    if (seen.has(v.id) || !/^view-[a-z0-9-]+$/u.test(v.id) || basename(file, ".json") !== v.id) throw new Error(`${file}: a view id must be unique, match view-[a-z0-9-]+ and the file name.`);
    seen.add(v.id);
    if (!["certified", "exploratory"].includes(v.numbers) || v.tables.some((t) => !["units", "assessments"].includes(t))) throw new Error(`${file}: numbers must be certified or exploratory; tables units or assessments.`);
    const prefix = v.id.replace(/-/gu, "_");
    const bad = Object.keys(v.spec.data ?? {}).filter((k) => !k.startsWith(prefix));
    if (bad.length) throw new Error(`${file}: spec data names must start with ${prefix}: ${bad.join(", ")}.`);
    for (const [name, sql] of Object.entries(v.spec.data ?? {})) await connection.run(`CREATE OR REPLACE TEMP VIEW ${name} AS ${sql}`);
    const canonical = canonicalRows(await rowsOf(connection, v.query));
    views.push({ ...v, rows: JSON.parse(canonical) as unknown, rows_sha256: createHash("sha256").update(canonical).digest("hex") });
  }
  return { study, format: VIEW_SPEC_FORMAT, views };
}
