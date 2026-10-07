// P3: judge assessments (behavior × arm matrix), claims, and the evidence drawer (assessment → cited units → native
// records; attempt audit; unit native records). Data from p3/build.py and p3/claims.py under data/<study>/p3/.
// Matrix counts are computed in the browser from the assessment records (exploratory) and compared with the EBO Atlas
// report tallies where the study has them (certified).
import { cls, esc, fmtDur, num } from "./lanes";
import { describable, provide, register, run, target, type Json } from "./registry";

/** What the drawer shows, as data: enough to reopen it exactly (state round-trip, undo, links). */
export type DrawerView =
  | { kind: "unit"; attemptId: string; row: number }
  | { kind: "assessment"; id: string }
  | { kind: "audit"; attemptId: string }
  | { kind: "chains"; attemptId: string }
  | { kind: "compare"; attemptId: string; chain: number }
  | { kind: "failures"; title: string; items: { attemptId: string; row: number }[] };

export const OUTCOMES = ["constructive", "mixed", "adverse", "context-dependent", "abstained"] as const;
const OUT_SHORT: Record<string, string> = { constructive: "C", mixed: "M", adverse: "A", "context-dependent": "Ctx", abstained: "Abst" };

export interface NativeRec { artifact: string; locator: string; path?: string; resolved: boolean; sha256?: string; chars?: number; truncated?: boolean; text?: string; part?: string; event_key?: string }
export interface Citation { link?: string | null; ordinal: number; event_key: string; resolved_event: boolean; row_id: number | null; unit_kind: string | null; step: number | null; seq: number | null; native: NativeRec }
export interface Assessment {
  id: string; attempt_id: string; short: string; condition: string; task_id: string; trial_id: string; category: string; dimension: string;
  outcome: string; disposition: string; confidence: number | null; rationale: string | null; alternative: string | null; review: string | null;
  evaluator: string; rubric: string; cohorts: Record<string, { included?: boolean; disputed?: boolean; review?: string }>; source: string; citations: Citation[];
}
export interface AttemptMeta { attempt_id: string; short: string; condition: string; task_id: string; trial_id: string; harness_id: string; model_id: string; terminal_state: string; failure_class: string; cohorts: string[]; bundle: string; native_span_seconds: number | null;
  native_record_count?: number | null; unmapped_record_count?: number | null; event_count?: number | null; event_types?: Record<string, number>; units?: number; tool_calls?: number }
interface CertCell { group: Record<string, string>; category: string; counts: Record<string, number>; denominator: number; assertions: string[]; conditions?: string[] }
export interface AssessDoc {
  study: string; cohorts: { id: string; title: string; certified: boolean; report: string | null }[]; attempts: AttemptMeta[]; assessments: Assessment[];
  certified: Record<string, { source: string; generated_at: string; group_by: string[]; cells: CertCell[] }>; notes: string[];
}
interface Run { row_id: number; seq: number; step: number; t_ms: number | null; status: string | null; kinds?: string[]; exit_code?: number | null; output_redirected?: boolean; command?: string; how?: string; paths?: string[]; detected?: string }
interface AuditAttempt {
  attempt_id: string; short: string; condition: string; trial_id: string; cohorts: string[]; steps: number; changes: Run[]; checks: Run[];
  last: Record<string, null | { last: Run; last_ok: Run | null; runs: number; changes_after: number; first_change_after: Run | null }>;
  final: null | { row_id: number; seq: number; text: string; chars: number; claims: { text: string; kinds: string[] }[] };
  verdicts: { kind: string; status: string; text: string }[];
  failure_chains: { tool: string; failures: number[]; first_step: number; t_ms: number | null; next_same_tool: number | null; next_ok: boolean | null; signature: string | null }[];
  notes: string[];
}
export interface AuditDoc { attempts: Record<string, AuditAttempt> }
interface ClaimNumber { id: string; label: string; value: number; kind: string; computed: number; ok: boolean; how: string }
interface Claim { id: string; type: string; text: string; source_section: string; cohort?: string; caveat?: string; numbers: ClaimNumber[]; support: { id: string; short: string; condition: string; trial_id: string; dimension: string; outcome: string; citations: number }[]; citations_resolved: number; citations_total: number; ok: boolean }
export interface ClaimsDoc { source: { file: string; title: string; also?: string[] }; number_kinds: Record<string, string>; claims: Claim[]; validated: boolean; failures: string[] }

export interface EvidenceHooks { highlight: (rows: number[] | null) => void; showInLanes: (attemptId: string, row?: number | null) => void }

const SHOW_MAX = 200_000;   // rendering safeguard for very long native lines (the data itself is never truncated)
const fmtT = (ms: number | null | undefined) => (ms == null ? "—" : fmtDur(ms));
const outChip = (o: string) => `<span class="oc oc-${cls(o)}">${esc(o)}</span>`;
const short = (h?: string) => (h ? h.slice(0, 12) : "");

/** Right-side drawer for evidence. One view at a time; Back returns to the previous view. */
export class Drawer {
  el: HTMLElement;
  private stack: { view: DrawerView; title: string; render: () => string; bind?: (el: HTMLElement) => void }[] = [];
  constructor() {
    this.el = document.createElement("aside");
    this.el.className = "drawer";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Evidence");
    try { if (localStorage.getItem("ebo-drawer-wide")) this.el.classList.add("wide"); } catch { /* ignore */ }
    document.body.appendChild(this.el);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && !this.el.hidden) run("closeDrawer"); });
  }
  get views(): DrawerView[] { return this.stack.map((v) => v.view); }
  get wide() { return this.el.classList.contains("wide"); }
  setWide(on: boolean) { this.el.classList.toggle("wide", on); try { localStorage.setItem("ebo-drawer-wide", on ? "1" : ""); } catch { /* ignore */ } this.draw(); }
  back() { this.stack.pop(); this.draw(); }
  open(view: DrawerView, title: string, render: () => string, bind?: (el: HTMLElement) => void, replace = false) {
    if (replace) this.stack.pop();
    this.stack.push({ view, title, render, bind });
    this.draw();
  }
  private draw() {
    const v = this.stack.at(-1);
    if (!v) { this.el.hidden = true; return; }
    this.el.hidden = false;
    this.el.innerHTML = `<div class="dr-head">
        ${this.stack.length > 1 ? `<button class="btn" data-back ${target("drawerBack")} title="Back to ${esc(this.stack.at(-2)!.title)}">← Back</button>` : ""}
        <h3>${esc(v.title)}</h3><button class="btn" data-wide ${target("setDrawerWide")} title="Reading mode: widen the drawer">${this.el.classList.contains("wide") ? "Narrow" : "Wide"}</button><button class="btn" data-close ${target("closeDrawer")} aria-label="Close">✕</button></div>
      <div class="dr-body">${v.render()}</div>`;
    this.el.querySelector("[data-close]")!.addEventListener("click", () => run("closeDrawer"));
    this.el.querySelector("[data-wide]")!.addEventListener("click", () => run("setDrawerWide", { wide: !this.wide }));
    this.el.querySelector("[data-back]")?.addEventListener("click", () => run("drawerBack"));
    v.bind?.(this.el.querySelector<HTMLElement>(".dr-body")!);
    this.el.querySelectorAll<HTMLButtonElement>("[data-full]").forEach((b) => b.addEventListener("click", () => run("showFullRecord", { sha256: b.dataset.full })));
    this.el.querySelector<HTMLElement>(".dr-body")!.scrollTop = 0;
  }
  /** Display the complete text of a long native record already in the drawer (display only; data is never cut). */
  showFull(sha256: string) {
    const b = this.el.querySelector<HTMLButtonElement>(`[data-full="${CSS.escape(sha256)}"]`);
    const t = this.el.querySelector<HTMLTemplateElement>(`template[data-full-text="${CSS.escape(sha256)}"]`);
    const pre = b?.closest("p")?.previousElementSibling as HTMLElement | null;
    if (b && t && pre) { pre.textContent = t.innerHTML.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"); b.closest("p")!.remove(); return true; }
    return false;
  }
  close() { this.stack = []; this.el.hidden = true; }
}


/** Shared evidence access: native records per attempt (lazy), assessments, audits, drill-down views. */
export class Evidence {
  private native = new Map<string, Promise<any>>();
  readonly byId: Map<string, Assessment>;
  readonly meta: Map<string, AttemptMeta>;
  /** Units cited by any judgment (P3 links snapshot citations to units too, which the P1 `cited` flag misses). */
  readonly citedRows: Set<number>;
  constructor(private base: string, readonly doc: AssessDoc, readonly audit: AuditDoc | null, readonly drawer: Drawer, readonly hooks: EvidenceHooks) {
    this.byId = new Map(doc.assessments.map((a) => [a.id, a]));
    this.meta = new Map(doc.attempts.map((a) => [a.attempt_id, a]));
    this.citedRows = new Set(doc.assessments.flatMap((a) => a.citations.map((c) => c.row_id).filter((r): r is number => r != null)));
    const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", required, properties, additionalProperties: false });
    const attempt = { attemptId: { type: "string" } };
    register<{ id: string }>({ name: "openAssessment", description: "Open a judge assessment: rationale, alternative explanation and cited native records.", args: obj({ id: { type: "string" } }),
      run: ({ id }) => { this.openAssessment(id); return `Opened assessment ${id}.`; } });
    register<{ attemptId: string; row: number }>({ name: "openUnit", description: "Open the native records of one behavior unit.", args: obj({ ...attempt, row: { type: "integer" } }),
      run: async ({ attemptId, row }) => { await this.openUnit(attemptId, row); return `Opened unit row ${row} of attempt ${attemptId.slice(0, 8)}.`; } });
    register<{ attemptId: string }>({ name: "openAudit", description: "Open an attempt's audit: checks vs source changes vs final claims, failure chains, final message.", args: obj(attempt),
      run: ({ attemptId }) => { this.openAudit(attemptId); return `Opened the audit of attempt ${attemptId.slice(0, 8)}.`; } });
    register<{ attemptId: string }>({ name: "openChains", description: "Open an attempt's failure chains.", args: obj(attempt),
      run: ({ attemptId }) => { this.openChains(attemptId); return `Opened the failure chains of attempt ${attemptId.slice(0, 8)}.`; } });
    register<{ attemptId: string; chain: number }>({ name: "openCompare", description: "Compare a failure chain's last failed call with the next call of the same tool.", args: obj({ ...attempt, chain: { type: "integer", minimum: 0 } }),
      run: async ({ attemptId, chain }) => { await this.openCompare(attemptId, chain); return `Compared failure chain ${chain + 1} of attempt ${attemptId.slice(0, 8)}.`; } });
    register<{ attemptId: string; rows: number[] }>({ name: "openChainAt", description: "Open the failure chain containing these units (or the attempt's chains).", args: obj({ ...attempt, rows: { type: "array", items: { type: "integer" } } }),
      run: async ({ attemptId, rows }) => { await this.openChainAt(attemptId, rows); return `Opened the failure chain at attempt ${attemptId.slice(0, 8)}.`; } });
    register<{ title: string; items: { attemptId: string; row: number }[] }>({ name: "openFailureGroup", description: "Open failed calls that share a tool and error, across attempts.",
      args: obj({ title: { type: "string" }, items: { type: "array", items: obj({ attemptId: { type: "string" }, row: { type: "integer" } }) } }),
      run: ({ title, items }) => { this.hooks.highlight(items.map(({ row }) => row)); this.openFailures(title, items); return `Opened and highlighted ${items.length} failed calls: ${title}.`; } });
    register({ name: "closeDrawer", description: "Close the evidence drawer.", args: obj({}), run: () => { this.drawer.close(); return "Closed the drawer."; } });
    register({ name: "drawerBack", description: "Go back to the previous drawer view.", args: obj({}), run: () => { this.drawer.back(); return "Went back in the drawer."; } });
    register<{ wide: boolean }>({ name: "setDrawerWide", description: "Widen (reading mode) or narrow the drawer.", args: obj({ wide: { type: "boolean" } }),
      run: ({ wide }) => { this.drawer.setWide(wide); return wide ? "Drawer widened." : "Drawer narrowed."; } });
    register<{ sha256: string }>({ name: "showFullRecord", description: "Show the complete text of a long native record in the drawer.", args: obj({ sha256: { type: "string" } }), readOnly: true,
      run: ({ sha256 }) => (this.drawer.showFull(sha256) ? "Showing the full record." : "That record is not open.") });
    register<{ rows: number[] | null }>({ name: "highlightRows", description: "Highlight units (row ids) in the cloud; null clears.", args: obj({ rows: { type: ["array", "null"], items: { type: "integer" } } }),
      run: ({ rows }) => { this.hooks.highlight(rows); return rows ? `Highlighted ${rows.length} units in the cloud.` : "Cleared the highlight."; } });
    provide({ key: "drawer", get: () => ({ views: this.drawer.views as unknown as Json, wide: this.drawer.wide }),
      apply: async (st: { views: DrawerView[]; wide: boolean }) => {
        this.drawer.close();
        if (st.wide !== this.drawer.wide) this.drawer.el.classList.toggle("wide", st.wide);
        for (const view of st.views) await this.reopen(view);
      } });
    describable("drawer", { describe: () => this.describeDrawer() });
  }

  /** Reopen a drawer view from its description. */
  async reopen(view: DrawerView) {
    if (view.kind === "unit") await this.openUnit(view.attemptId, view.row);
    else if (view.kind === "assessment") this.openAssessment(view.id);
    else if (view.kind === "audit") this.openAudit(view.attemptId);
    else if (view.kind === "chains") this.openChains(view.attemptId);
    else if (view.kind === "compare") await this.openCompare(view.attemptId, view.chain);
    else this.openFailures(view.title, view.items);
  }

  private describeDrawer() {
    const view = this.drawer.views.at(-1);
    if (!view) return { summary: "The drawer is closed.", data: null };
    if (view.kind === "assessment") {
      const a = this.byId.get(view.id);
      return { summary: a ? `Assessment ${a.dimension} for ${this.attemptLabel(a.attempt_id)}: ${a.outcome}, ${a.citations.length} citations.` : `Assessment ${view.id}.`,
        data: a ? { view, outcome: a.outcome, confidence: a.confidence, rationale: a.rationale, alternative: a.alternative,
          citations: a.citations.map((c) => ({ artifact: c.native.artifact, locator: c.native.locator, resolved: c.native.resolved, row: c.row_id })) } as unknown as Json : (view as unknown as Json) };
    }
    if (view.kind === "audit" || view.kind === "chains" || view.kind === "compare") {
      const A = this.audit?.attempts[view.attemptId];
      return { summary: `${view.kind} of ${this.attemptLabel(view.attemptId)}${A ? `: ${A.checks.length} captured checks, ${A.changes.length} source changes, ${A.failure_chains.length} failure chains` : ""}.`,
        // The chains themselves, so a reader (or an assistant) can answer from describe() what the drawer shows.
        data: { view, verdicts: A?.verdicts ?? [], failureChains: A?.failure_chains.length ?? null,
          chains: (A?.failure_chains ?? []).map((f) => ({ tool: f.tool, failures: f.failures.length, firstStep: f.first_step, tMs: f.t_ms, signature: f.signature, nextOk: f.next_ok, nextRow: f.next_same_tool })) } as unknown as Json };
    }
    return { summary: `${view.kind} view in the drawer.`, data: view as unknown as Json };
  }
  nativeOf(attemptId: string) {
    if (!this.native.has(attemptId)) this.native.set(attemptId, fetch(`${this.base}/native/${attemptId}.json`).then((r) => (r.ok ? r.json() : null)));
    return this.native.get(attemptId)!;
  }
  attemptLabel(id: string) {
    const m = this.meta.get(id);
    return m ? `${m.condition} · trial ${m.trial_id} · ${m.short}${m.cohorts.length ? ` · ${m.cohorts.join(", ")}` : ""}` : id;
  }
  assessmentsOf(attemptId: string) { return this.doc.assessments.filter((a) => a.attempt_id === attemptId); }

  recordHtml(r: NativeRec) {
    if (!r.resolved) return `<div class="rec"><div class="rec-h">${esc(r.artifact)} ${esc(r.locator)} · <b>not resolved</b></div></div>`;
    let body = r.text ?? "";
    if (!r.truncated) { try { body = JSON.stringify(JSON.parse(body), null, 1); } catch { /* not JSON */ } }
    return `<div class="rec"><div class="rec-h"><b>${esc(r.part ?? "")}</b> ${esc(r.path ?? r.artifact)} <span class="mono">${esc(r.locator)}</span>
      · ${typeof r.chars === "number" ? r.chars.toLocaleString() : "—"} chars${r.truncated ? " (middle omitted)" : ""} · sha256 <span class="mono" title="${esc(r.sha256 ?? "")}">${short(r.sha256)}…</span></div>
      ${body.length > SHOW_MAX ? `<pre class="rec-t">${esc(body.slice(0, SHOW_MAX))}</pre><p class="small muted">Showing the first ${SHOW_MAX.toLocaleString()} of ${body.length.toLocaleString()} chars (display only; the record is complete). <button class="link" data-full="${esc(r.sha256 ?? "")}">Show full record</button></p><template data-full-text="${esc(r.sha256 ?? "")}">${esc(body)}</template>`
        : `<pre class="rec-t">${esc(body)}</pre>`}</div>`;
  }

  /** Native records of one unit (a lane mark, a citation, an audit row). */
  async openUnit(attemptId: string, row: number, title?: string, replace = false) {
    const nat = await this.nativeOf(attemptId);
    const u = nat?.units?.[String(row)];
    const cites = this.assessmentsOf(attemptId).filter((a) => a.citations.some((c) => c.row_id === row));
    this.drawer.open({ kind: "unit", attemptId, row }, title ?? `Record · ${this.attemptLabel(attemptId)}`, () => `
      <p class="dr-meta">${esc(this.attemptLabel(attemptId))} · unit row ${num(row)}${u ? ` · <span class="mono">${esc(u.unit_id)}</span>` : ""}</p>
      <div class="dr-actions"><button class="btn" data-lanes ${target("focusAttempt", attemptId)}>Show in swimlanes</button> <button class="btn" data-cloud ${target("highlightRows", `unit:${row}`)}>Highlight in cloud</button> <button class="btn" data-audit ${target("openAudit", attemptId)}>Attempt audit</button></div>
      ${cites.length ? `<p>Cited by: ${cites.map((a) => `<button class="link" data-assess="${esc(a.id)}" ${target("openAssessment", a.id)}>${esc(a.dimension)} · ${outChip(a.outcome)}</button>`).join(" ")}</p>` : ""}
      <h4>Native records</h4>
      ${u ? u.parts.map((p: NativeRec) => this.recordHtml(p)).join("") + (u.omitted_parts ? `<p class="muted">${num(u.omitted_parts)} more native lines for this unit not shown (long stream).</p>` : "") +
        (u.hook_copies_omitted ? `<p class="muted">${num(u.hook_copies_omitted)} hook record(s) repeating this call/result not shown.</p>` : "")
        : nat ? `<p class="muted">No native record for this unit (episodes summarize many records; open a tool or message instead).</p>`
              : `<p class="muted">Native records are not part of this packet variant (withheld under policy; their digests are listed in the packet manifest).</p>`}
      <p class="muted small">Native lines are read from the corpus file named above; the SHA-256 is of the full line. Long lines keep their head and tail.</p>`,
      (el) => {
        el.querySelector("[data-lanes]")!.addEventListener("click", () => run("focusAttempt", { attemptId, row }));
        el.querySelector("[data-cloud]")!.addEventListener("click", () => run("highlightRows", { rows: [row] }));
        el.querySelector("[data-audit]")!.addEventListener("click", () => run("openAudit", { attemptId }));
        el.querySelectorAll<HTMLElement>("[data-assess]").forEach((b) => b.addEventListener("click", () => run("openAssessment", { id: b.dataset.assess })));
      }, replace);
  }

  openAssessment(id: string) {
    const a = this.byId.get(id);
    if (!a) return;
    const coh = Object.entries(a.cohorts).map(([c, v]) => `${c}${v.included === false ? " (excluded)" : ""}${v.disputed ? " (disputed)" : ""}`).join(", ");
    this.drawer.open({ kind: "assessment", id }, `Assessment · ${a.dimension}`, () => `
      <p class="dr-meta">${esc(this.attemptLabel(a.attempt_id))}</p>
      <p class="dr-big">${outChip(a.outcome)} <b>${esc(a.dimension)}</b>${a.confidence != null ? ` · confidence ${num(a.confidence)}` : ""}</p>
      <dl class="kv"><dt>Evaluator</dt><dd>${esc(a.evaluator)}</dd><dt>Rubric</dt><dd>${esc(a.rubric)}</dd>
        <dt>Review</dt><dd>${esc(a.review ?? "unreviewed (model proposal)")}</dd><dt>Cohorts</dt><dd>${esc(coh || "—")}</dd>
        <dt>Assertion</dt><dd class="mono small">${esc(a.id)}</dd></dl>
      <h4>Judge's rationale</h4><p class="prose">${esc(a.rationale ?? (a.outcome === "abstained" ? "The judge abstained." : "—"))}</p>
      ${a.alternative ? `<h4>Alternative explanation (judge)</h4><p class="prose">${esc(a.alternative)}</p>` : ""}
      <h4>Cited evidence (${a.citations.length})</h4>
      <p class="muted small">Each citation is a native record the judge pointed to. Open it to read the line; the unit links it to the swimlanes and cloud.</p>
      <ol class="cites">${a.citations.map((c) => `<li>
        ${c.row_id != null ? `<button class="link" data-row="${num(c.row_id)}" ${target("openUnit", `${a.attempt_id}:${c.row_id}`)}>${esc(c.unit_kind ?? "unit")}${c.step ? ` · step ${num(c.step)}` : ""}${c.seq != null ? ` · unit #${num(c.seq)}` : ""}</button>${c.link && c.link !== "event" ? ` <span class="muted small" title="The cited record is not one of the unit's own events; linked to the ${c.link === "time" ? "nearest unit in time (≤5 s)" : "nearest preceding unit in the same native file"}">≈ linked by ${esc(c.link)}</span>` : ""}` : `<span class="muted">not linked to a unit</span>`}
        <span class="mono small">${esc(c.native.artifact)} ${esc(c.native.locator)}</span>
        ${c.native.resolved ? `<span class="ok">resolved</span>` : `<span class="bad">unresolved</span>`}
        <details><summary>native line</summary>${this.recordHtml({ ...c.native, part: "" })}</details></li>`).join("")}</ol>
      <div class="dr-actions"><button class="btn" data-lanes ${target("focusAttempt", a.attempt_id)}>Show attempt in swimlanes</button> <button class="btn" data-cloud ${target("highlightRows", `cited:${a.id}`)}>Highlight cited units in cloud</button> <button class="btn" data-audit ${target("openAudit", a.attempt_id)}>Attempt audit</button></div>`,
      (el) => {
        el.querySelectorAll<HTMLElement>("button[data-row]").forEach((b) => b.addEventListener("click", () => { if (b.dataset.row) run("openUnit", { attemptId: a.attempt_id, row: Number(b.dataset.row) }); }));
        el.querySelector("[data-lanes]")!.addEventListener("click", () => run("focusAttempt", { attemptId: a.attempt_id, row: null }));
        el.querySelector("[data-cloud]")!.addEventListener("click", () => run("highlightRows", { rows: a.citations.map((c) => c.row_id).filter((r): r is number => r != null) }));
        el.querySelector("[data-audit]")!.addEventListener("click", () => run("openAudit", { attemptId: a.attempt_id }));
      });
  }

  openAudit(attemptId: string) {
    const A = this.audit?.attempts[attemptId];
    const m = this.meta.get(attemptId);
    if (!A || !m) return;
    const runCell = (r: Run | null | undefined) => r ? `<button class="link" data-row="${num(r.row_id)}" ${target("openUnit", `${attemptId}:${r.row_id}`)}>step ${num(r.step)}</button> · ${fmtT(r.t_ms)}${r.status === "error" ? ` · <span class="bad">failed</span>` : ""}${r.exit_code != null ? ` · exit ${num(r.exit_code)}` : ""}${r.output_redirected ? ` · <span class="muted">output redirected</span>` : ""}` : `<span class="muted">none captured</span>`;
    const finalHtml = () => {
      if (!A.final) return `<p class="muted">No final assistant message captured.</p>`;
      let t = esc(A.final.text);
      for (const c of A.final.claims) { const s = esc(c.text); if (s && t.includes(s)) t = t.split(s).join(`<mark>${s}</mark>`); }
      return `<p class="muted small">${typeof A.final.chars === "number" ? A.final.chars.toLocaleString() : "—"} chars · <button class="link" data-row="${num(A.final.row_id)}" ${target("openUnit", `${attemptId}:${A.final.row_id}`)}>open native record</button> · highlighted: lines that name a check with a pass word</p><pre class="rec-t final">${t}</pre>`;
    };
    const asm = this.assessmentsOf(attemptId);
    this.drawer.open({ kind: "audit", attemptId }, `Audit · trial ${m.trial_id} ${m.short}`, () => `
      <dl class="kv"><dt>Attempt</dt><dd class="mono small">${esc(m.attempt_id)}</dd><dt>Arm</dt><dd>${esc(m.condition)} (${esc(m.harness_id)} · ${esc(m.model_id)})</dd>
        <dt>Task / trial</dt><dd>${esc(m.task_id)} · trial ${esc(m.trial_id)}</dd><dt>Cohorts</dt><dd>${esc(m.cohorts.join(", ") || "—")}</dd>
        <dt>Terminal</dt><dd>${esc(m.terminal_state)}${m.failure_class && m.failure_class !== "none" ? ` (${esc(m.failure_class)})` : ""}</dd>
        <dt>Steps</dt><dd>${num(A.steps)} actions (tool calls + compactions)</dd></dl>
      ${asm.length ? `<p>Judge: ${asm.map((a) => `<button class="link" data-assess="${esc(a.id)}" ${target("openAssessment", a.id)}>${esc(a.dimension)} ${outChip(a.outcome)}</button>`).join(" ")}</p>` : ""}
      <h4>Final claims vs captured checks</h4>
      ${A.verdicts.length ? `<ul class="verdicts">${A.verdicts.map((v) => `<li class="v-${cls(v.status)}"><b>${esc(v.status.replace(/-/g, " "))}</b> · ${esc(v.text)}</li>`).join("")}</ul>` : `<p class="muted">No check is both claimed and out of date, and no unclaimed check is stale.</p>`}
      <table class="grid audit"><thead><tr><th>Check</th><th>Last run</th><th>Last passing run</th><th class="num">Runs</th><th>Source changes after last run</th></tr></thead><tbody>
      ${(["typecheck", "lint", "test", "build"] as const).map((k) => { const L = A.last[k]; return `<tr><th scope="row">${k}</th><td>${runCell(L?.last)}</td><td>${runCell(L?.last_ok)}</td><td class="num">${num(L?.runs ?? 0)}</td>
        <td>${L ? (L.changes_after ? `<b>${num(L.changes_after)}</b> · first <button class="link" data-row="${num(L.first_change_after!.row_id)}" ${target("openUnit", `${attemptId}:${L.first_change_after!.row_id}`)}>step ${num(L.first_change_after!.step)}</button> ${esc((L.first_change_after!.paths ?? []).slice(0, 2).join(", "))}` : "0") : "—"}</td></tr>`; }).join("")}
      </tbody></table>
      <details><summary>All captured checks (${A.checks.length})</summary><ol class="runs">${A.checks.map((c) => `<li><button class="link" data-row="${num(c.row_id)}" ${target("openUnit", `${attemptId}:${c.row_id}`)}>step ${num(c.step)}</button> ${fmtT(c.t_ms)} · ${esc((c.kinds ?? []).join(" + "))}${c.status === "error" ? ` · <span class="bad">failed</span>` : ""} <code>${esc(c.command ?? "")}</code></li>`).join("")}</ol></details>
      <details><summary>All source changes (${A.changes.length})</summary><ol class="runs">${A.changes.map((c) => `<li><button class="link" data-row="${num(c.row_id)}" ${target("openUnit", `${attemptId}:${c.row_id}`)}>step ${num(c.step)}</button> ${fmtT(c.t_ms)} · ${esc(c.how ?? "")} · ${esc((c.paths ?? []).join(", "))}</li>`).join("")}</ol></details>
      <h4>Final message (full)</h4>${finalHtml()}
      <h4>Failure chains (${A.failure_chains.length})</h4>
      ${A.failure_chains.length ? `<table class="grid audit"><thead><tr><th>Step</th><th>Tool</th><th class="num">Failures</th><th>Error</th><th>Next call of that tool</th></tr></thead><tbody>
        ${A.failure_chains.map((f, i) => `<tr><td><button class="link" data-row="${num(f.failures[0])}" ${target("openUnit", `${attemptId}:${f.failures[0]}`)}>step ${num(f.first_step)}</button> ${fmtT(f.t_ms)}</td><td>${esc(f.tool)}</td><td class="num">${f.failures.length}</td>
          <td class="small">${esc(f.signature ?? "")}</td><td>${f.next_same_tool != null ? `<button class="link" data-row="${num(f.next_same_tool)}" ${target("openUnit", `${attemptId}:${f.next_same_tool}`)}>${f.next_ok === null ? "outcome unavailable" : f.next_ok ? "succeeded" : "failed"}</button> · <button class="link" data-compare="${i}" ${target("openCompare", `${attemptId}:${i}`)}>compare failed vs next</button>` : "none"}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No failed tool calls captured.</p>`}
      <h4>How this audit is computed</h4><ul class="small">${A.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      <div class="dr-actions"><button class="btn" data-lanes ${target("focusAttempt", attemptId)}>Show in swimlanes</button></div>`,
      (el) => {
        el.querySelectorAll<HTMLElement>("button[data-row]").forEach((b) => b.addEventListener("click", () => run("openUnit", { attemptId, row: Number(b.dataset.row) })));
        el.querySelectorAll<HTMLElement>("[data-assess]").forEach((b) => b.addEventListener("click", () => run("openAssessment", { id: b.dataset.assess })));
        el.querySelectorAll<HTMLElement>("[data-compare]").forEach((b) => b.addEventListener("click", () => run("openCompare", { attemptId, chain: Number(b.dataset.compare) })));
        el.querySelector("[data-lanes]")!.addEventListener("click", () => run("focusAttempt", { attemptId, row: null }));
      });
  }

  chainsOf(attemptId: string) { return this.audit?.attempts[attemptId]?.failure_chains ?? []; }

  /** From a red failure-chain mark: open the comparison for the chain containing one of these units, else the list. */
  async openChainAt(attemptId: string, rows: number[]) {
    const i = this.chainsOf(attemptId).findIndex((c) => c.failures.some((r) => rows.includes(r)) || (c.next_same_tool != null && rows.includes(c.next_same_tool)));
    if (i >= 0) await this.openCompare(attemptId, i); else this.openChains(attemptId);
  }

  /** All failure chains of one attempt, each with its error and a comparison of the failed call with the next call. */
  openChains(attemptId: string) {
    const chains = this.chainsOf(attemptId);
    this.drawer.open({ kind: "chains", attemptId }, `Failure chains · ${this.attemptLabel(attemptId)}`, () => `
      <p class="dr-meta">${esc(this.attemptLabel(attemptId))} · ${chains.length} chain(s): one or more consecutive failed calls of a tool, then the next call of that tool.</p>
      ${chains.length ? `<table class="grid audit"><thead><tr><th>Step</th><th>Tool</th><th class="num">Failed calls</th><th>Error</th><th>Next call of that tool</th></tr></thead><tbody>
        ${chains.map((f, i) => `<tr><td>step ${num(f.first_step)} · ${fmtT(f.t_ms)}</td><td class="mono">${esc(f.tool)}</td><td class="num">${f.failures.length}</td><td class="small">${esc(f.signature ?? "—")}</td>
          <td>${f.next_same_tool != null ? `${f.next_ok === null ? `<span class="muted">outcome unavailable</span>` : f.next_ok ? `<span class="ok">succeeded</span>` : `<span class="bad">failed</span>`} · <button class="btn" data-compare="${i}" ${target("openCompare", `${attemptId}:${i}`)}>Compare failed vs next</button>` : "none"}</td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No failed tool calls captured in this attempt.</p>`}
      <div class="dr-actions"><button class="btn" data-audit ${target("openAudit", attemptId)}>Attempt audit</button> <button class="btn" data-lanes ${target("focusAttempt", attemptId)}>Show in swimlanes</button></div>`,
      (el) => {
        el.querySelectorAll<HTMLElement>("[data-compare]").forEach((b) => b.addEventListener("click", () => run("openCompare", { attemptId, chain: Number(b.dataset.compare) })));
        el.querySelector("[data-audit]")!.addEventListener("click", () => run("openAudit", { attemptId }));
        el.querySelector("[data-lanes]")!.addEventListener("click", () => run("focusAttempt", { attemptId, row: null }));
      });
  }

  /** Failed calls sharing a tool and error signature, across attempts (from the Totals view). */
  openFailures(title: string, items: { attemptId: string; row: number }[]) {
    const groups = new Map<string, number[]>();
    for (const it of items) (groups.get(it.attemptId) ?? groups.set(it.attemptId, []).get(it.attemptId)!).push(it.row);
    const rows = [...groups.entries()].map(([aid, rs]) => {
      const chains = this.chainsOf(aid).filter((c) => c.failures.some((r) => rs.includes(r)));
      return { aid, rs, chains };
    });
    this.drawer.open({ kind: "failures", title, items }, title, () => `
      <p class="dr-meta">${items.length} failed call(s) in ${groups.size} attempt(s). Each chain: consecutive failures of the tool, then the next call of that tool.</p>
      <table class="grid audit"><thead><tr><th>Attempt</th><th class="num">Failed calls</th><th>Chains (first step · failures · next call)</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${esc(this.attemptLabel(r.aid))}</td><td class="num">${r.rs.length}</td><td>${r.chains.map((c, j) =>
        `<div>step ${num(c.first_step)} · ${c.failures.length} failed · ${c.next_same_tool != null ? (c.next_ok === null ? `<span class="muted">next outcome unavailable</span>` : c.next_ok ? `<span class="ok">next succeeded</span>` : `<span class="bad">next failed</span>`) : "no later call"} <button class="btn" data-cmp="${i}:${j}" ${target("openCompare", `${r.aid}:${this.chainsOf(r.aid).indexOf(c)}`)}>Compare failed vs next</button></div>`).join("")}</td></tr>`).join("")}
      </tbody></table>`,
      (el) => el.querySelectorAll<HTMLElement>("[data-cmp]").forEach((b) => b.addEventListener("click", () => {
        const [i, j] = b.dataset.cmp!.split(":").map(Number); run("openCompare", { attemptId: rows[i].aid, chain: this.chainsOf(rows[i].aid).indexOf(rows[i].chains[j]) });
      })));
  }

  /** Failed call(s) next to the next call of the same tool: arguments and results side by side. */
  async openCompare(attemptId: string, chain: number) {
    const f = this.chainsOf(attemptId)[chain];
    if (!f) return;
    const nat = await this.nativeOf(attemptId);
    const parts = (row: number | null): NativeRec[] => (row == null ? [] : nat?.units?.[String(row)]?.parts ?? []);
    const recs = (row: number | null) => (row == null ? `<p class="muted">none</p>` : parts(row).map((p) => this.recordHtml(p)).join(""));
    // Arguments and result text pulled out of the native lines (complete lines only; long lines: see the raw records)
    const find = (o: any, keys: string[]): any => {
      if (!o || typeof o !== "object") return undefined;
      for (const k of keys) if (k in o) return o[k];
      for (const v of Object.values(o)) { const r = find(v, keys); if (r !== undefined) return r; }
      return undefined;
    };
    const pick = (row: number | null, side: "call" | "result") => {
      for (const p of parts(row)) {
        if (!p.text || p.truncated || !(p.part ?? "").includes(side === "call" ? "call" : "result")) continue;
        try {
          const o = JSON.parse(p.text);
          const v = side === "call" ? find(o, ["args", "input", "arguments", "command"]) : find(o, ["result", "content", "aggregatedOutput", "output"]);
          if (v !== undefined) return typeof v === "string" ? v : JSON.stringify(v, null, 1);
        } catch { /* not JSON */ }
      }
      return null;
    };
    const last = f.failures.at(-1)!, next = f.next_same_tool;
    // per-argument JSON type and size: a string where an array is expected is often the whole story
    const shape = (v: string | null): Record<string, string> | null => {
      if (!v) return null;
      let o: any; try { o = JSON.parse(v); } catch { return null; }
      if (!o || typeof o !== "object" || Array.isArray(o)) return null;
      const t = (x: any) => typeof x === "string" ? `string (${x.length.toLocaleString()} chars)` : Array.isArray(x) ? `array of ${x.length} ${x.length && typeof x[0] === "object" ? "object" : "item"}${x.length === 1 ? "" : "s"}` : x && typeof x === "object" ? `object (${Object.keys(x).length} keys)` : typeof x;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, t(x)]));
    };
    const argF = pick(last, "call"), argN = pick(next, "call");
    const sf = shape(argF), sn = shape(argN);
    const keys = [...new Set([...Object.keys(sf ?? {}), ...Object.keys(sn ?? {})])];
    const pathOf = (v: string | null) => { try { const o = v ? JSON.parse(v) : null; return o?.path ?? o?.file_path ?? null; } catch { return null; } };
    const pf = pathOf(argF), pn = pathOf(argN);
    const box = (t: string | null) => t == null ? `<p class="muted small">Not extractable from a complete line; see the raw records below.</p>` : `<pre class="rec-t">${esc(t.length > 6000 ? t.slice(0, 6000) + "\n…" : t)}</pre>`;
    const judge = this.assessmentsOf(attemptId).filter((a) => a.dimension === "error-recognition-recovery");
    this.drawer.open({ kind: "compare", attemptId, chain }, `Failure chain · ${f.tool} · step ${num(f.first_step)}`, () => `
      <p class="dr-meta">${esc(this.attemptLabel(attemptId))} · ${f.failures.length} consecutive failed ${esc(f.tool)} call(s) from step ${num(f.first_step)} (${fmtT(f.t_ms)})${f.signature ? ` · <span class="mono small">${esc(f.signature)}</span>` : ""}</p>
      <p class="muted small">Observed in the native records (not the judge's reading). Left: the last failed call of the chain; right: the next call of the same tool.</p>
      ${keys.length ? `<table class="grid audit"><thead><tr><th>Argument</th><th>Last failed call</th><th>Next call</th></tr></thead><tbody>${keys.map((k) => `<tr><td class="mono">${esc(k)}</td><td>${esc(sf?.[k] ?? "—")}</td><td>${esc(sn?.[k] ?? "—")}</td></tr>`).join("")}</tbody></table>` : ""}
      ${pf && pn && pf !== pn ? `<p class="small"><b>Different target:</b> the failed call targets <span class="mono">${esc(pf)}</span>, the next call <span class="mono">${esc(pn)}</span>; the next call's success does not show the failed change was later applied.</p>` : ""}
      <div class="compare">
        <div><h4>Last failed call · arguments</h4>${box(argF)}<h4>Result</h4>${box(pick(last, "result"))}</div>
        <div><h4>Next ${esc(f.tool)} call (${next == null ? "none" : f.next_ok === null ? "outcome unavailable" : f.next_ok ? "succeeded" : "failed"}) · arguments</h4>${box(argN)}<h4>Result</h4>${box(pick(next, "result"))}</div>
      </div>
      ${judge.length ? `<h4>Judge on recovery in this attempt (model proposal, sampled evidence)</h4>${judge.map((a) => `<p>${outChip(a.outcome)} <button class="link" data-assess="${esc(a.id)}" ${target("openAssessment", a.id)}>open judgment</button></p><p class="prose small">${esc((a.rationale ?? "").slice(0, 600))}${(a.rationale ?? "").length > 600 ? "…" : ""}</p>`).join("")}` : ""}
      <details><summary>Raw native records: last failed call and next call</summary><div class="compare"><div>${recs(last)}</div><div>${recs(next)}</div></div></details>
      ${f.failures.length > 1 ? `<details><summary>Earlier failed calls in this chain (${f.failures.length - 1})</summary>${f.failures.slice(0, -1).map((r) => recs(r)).join("")}</details>` : ""}
      <div class="dr-actions"><button class="btn" data-chains ${target("openChains", attemptId)}>All failure chains of this attempt</button> <button class="btn" data-lanes ${target("focusAttempt", attemptId)}>Show in swimlanes</button></div>`,
      (el) => {
        el.querySelectorAll<HTMLElement>("[data-assess]").forEach((b) => b.addEventListener("click", () => run("openAssessment", { id: b.dataset.assess })));
        el.querySelector("[data-chains]")!.addEventListener("click", () => run("openChains", { attemptId }));
        el.querySelector("[data-lanes]")!.addEventListener("click", () => run("focusAttempt", { attemptId, row: last }));
      });
  }
}

/** Behavior × arm matrix with outcome counts, denominators, certified vs exploratory marks, and the judgment list. */
export class MatrixPanel {
  private cohort: string;
  private task = "all";
  private sel: { cat: string; arm: string } | null = null;
  constructor(private root: HTMLElement, private ev: Evidence) {
    const certified = ev.doc.cohorts.filter((c) => c.certified);
    this.cohort = certified[0]?.id ?? "all";
    const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", required, properties, additionalProperties: false });
    register<{ cohort: string }>({ name: "setMatrixCohort", description: "Count assessments of one cohort (or all attempts).", args: obj({ cohort: { type: "string" } }),
      run: ({ cohort }) => { this.cohort = cohort; this.sel = null; this.render(); return `Assessments show ${cohort === "all" ? "all attempts" : `cohort ${cohort}`}.`; } });
    register<{ task: string }>({ name: "setMatrixTask", description: "Count assessments of one task (or all tasks).", args: obj({ task: { type: "string" } }),
      run: ({ task }) => { this.task = task; this.sel = null; this.render(); return `Assessments show ${task === "all" ? "all tasks" : task}.`; } });
    register<{ category: string | null; arm?: string }>({ name: "selectMatrixCell", description: "List the judgments of one behavior × arm cell; category null shows all.",
      args: obj({ category: { type: ["string", "null"] }, arm: { type: "string" } }, ["category"]),
      run: ({ category, arm }) => { this.sel = category === null || arm === undefined ? null : { cat: category, arm }; this.render(); return this.sel ? `Listing ${category} × ${arm}.` : "Listing all judgments."; } });
    provide({ key: "assessments", get: () => ({ cohort: this.cohort, task: this.task, cell: this.sel ? { category: this.sel.cat, arm: this.sel.arm } : null }),
      apply: (st: { cohort: string; task: string; cell: { category: string; arm: string } | null }) => { this.cohort = st.cohort; this.task = st.task; this.sel = st.cell ? { cat: st.cell.category, arm: st.cell.arm } : null; this.render(); } });
    describable("assessments", this);
    this.render();
  }

  /** The behavior × arm counts currently shown, with their certified/exploratory status. */
  describe() {
    const pool = this.pool(), arms = this.arms(), cats = this.cats();
    const cells = cats.flatMap((cat) => arms.map((arm) => {
      const xs = pool.filter((a) => a.category === cat && a.condition === arm);
      const counts: Record<string, number> = Object.fromEntries(OUTCOMES.map((o) => [o, xs.filter((a) => a.outcome === o).length]));
      const unknown = xs.filter((a) => !(OUTCOMES as readonly string[]).includes(a.outcome)).length;
      if (unknown) counts.unknown = unknown;
      const cert = this.certCell(cat, arm);
      return { category: cat, arm, judgments: xs.length, counts, certified: cert ? OUTCOMES.every((o) => (cert.counts[o] ?? 0) === counts[o]) && cert.denominator === xs.length : false };
    }));
    return { summary: `${pool.length} judgments, ${this.cohort === "all" ? "all attempts" : `cohort ${this.cohort}`}${this.task !== "all" ? `, task ${this.task}` : ""}.`, data: { cohort: this.cohort, task: this.task, cells } };
  }
  private pool() {
    // Agreeing judge reruns of one attempt and behavior count once, as in the certified report; disagreeing ones stay.
    const seen = new Set<string>();
    return this.ev.doc.assessments.filter((a) => (this.cohort === "all" || (a.cohorts[this.cohort] && a.cohorts[this.cohort].included !== false))
      && (this.task === "all" || a.task_id === this.task))
      .filter((a) => { const k = `${a.attempt_id}\0${a.category}\0${a.outcome}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  private arms() { return [...new Set(this.ev.doc.attempts.map((a) => a.condition))].sort(); }
  private cats() { return [...new Set(this.ev.doc.assessments.map((a) => a.category))].sort(); }
  private certCell(cat: string, arm: string) {
    const c = this.ev.doc.certified[this.cohort];
    if (!c) return null;
    const m = this.ev.doc.attempts.find((x) => x.condition === arm);
    if (!m) return null;
    // EBO bundles record each cell's arms. Only cells covering this arm alone are comparable with it; report groups
    // partition attempts, so the arm's cells (one per task, say) add up to the arm's certified counts.
    if (c.cells.some((x) => x.conditions)) {
      const own = c.cells.filter((x) => x.category === cat && x.conditions?.length === 1 && x.conditions[0] === arm && (this.task === "all" || x.group.task === this.task));
      if (!own.length || (this.task !== "all" && !own.every((x) => "task" in x.group))) return null;
      const counts: Record<string, number> = {};
      for (const x of own) for (const [k, v] of Object.entries(x.counts)) counts[k] = (counts[k] ?? 0) + v;
      return { group: own[0]!.group, category: cat, counts, denominator: own.reduce((sum, x) => sum + x.denominator, 0), assertions: own.flatMap((x) => x.assertions), conditions: [arm] };
    }
    if (this.task !== "all") return null;
    return c.cells.find((x) => x.category === cat && (x.group.model ?? m.model_id) === m.model_id && (x.group.harness ?? m.harness_id) === m.harness_id && (!x.group.task || x.group.task === m.task_id)) ?? null;
  }
  render() {
    const pool = this.pool(), arms = this.arms(), cats = this.cats();
    const tasks = [...new Set(this.ev.doc.attempts.map((a) => a.task_id))].sort();
    const attemptsIn = (arm: string) => this.ev.doc.attempts.filter((a) => a.condition === arm && (this.cohort === "all" || a.cohorts.includes(this.cohort)) && (this.task === "all" || a.task_id === this.task)).length;
    const anyCert = Object.keys(this.ev.doc.certified).length > 0;
    const cell = (cat: string, arm: string) => {
      const xs = pool.filter((a) => a.category === cat && a.condition === arm);
      const n = xs.length, k = attemptsIn(arm);
      if (!k) return `<td class="mx na">—</td>`;
      const counts = Object.fromEntries(OUTCOMES.map((o) => [o, xs.filter((a) => a.outcome === o).length]));
      const unknown = xs.filter((a) => !(OUTCOMES as readonly string[]).includes(a.outcome)).length;
      const cert = this.certCell(cat, arm);
      let mark = `<span class="tag-x" title="Computed in the browser from the judge assertions">exploratory</span>`;
      if (cert) {
        const same = OUTCOMES.every((o) => (cert.counts[o] ?? 0) === counts[o]) && cert.denominator === n;
        mark = same ? `<span class="tag-c" title="Matches the EBO Atlas report tally for cohort ${esc(this.cohort)}">EBO certified</span>`
          : `<span class="tag-d" title="EBO report: ${esc(JSON.stringify(cert.counts))} of ${cert.denominator}">differs from EBO</span>`;
      }
      const bar = OUTCOMES.map((o) => counts[o] ? `<span class="sb oc-${o}" style="flex:${counts[o]}"></span>` : "").join("");
      const txt = [...OUTCOMES.filter((o) => counts[o]).map((o) => `${counts[o]} ${OUT_SHORT[o]}`), ...(unknown ? [`${unknown} unknown outcome`] : [])].join(" · ") || "0";
      const on = this.sel && this.sel.cat === cat && this.sel.arm === arm ? " on" : "";
      return `<td class="mx${on}" data-cat="${esc(cat)}" data-arm="${esc(arm)}" ${target("selectMatrixCell", `${cat}|${arm}`)} tabindex="0" title="${esc(OUTCOMES.map((o) => `${o}: ${counts[o]}`).join(", "))}">
        <div class="sbar" aria-hidden="true">${bar}</div><span class="mx-n">${txt}</span>
        <span class="meta">${n} judgment${n === 1 ? "" : "s"} · ${k} attempt${k === 1 ? "" : "s"} in arm</span>${mark}</td>`;
    };
    const list = this.sel ? pool.filter((a) => a.category === this.sel!.cat && a.condition === this.sel!.arm) : pool;
    this.root.innerHTML = `
      <div class="panel-head"><div><h2>Assessments</h2>
        <p class="sub">${pool.length} judgments (one per attempt × behavior dimension) · ${this.cohort === "all" ? "all attempts" : `cohort ${esc(this.cohort)}`}${this.task !== "all" ? ` · ${esc(this.task)}` : ""}</p></div>
        <div class="controls">
          <label class="field">Cohort <select data-cohort ${target("setMatrixCohort")}>${this.ev.doc.cohorts.map((c) => `<option value="${esc(c.id)}" ${c.id === this.cohort ? "selected" : ""}>${esc(c.id)}${c.certified ? " (EBO report)" : ""}</option>`).join("")}<option value="all" ${this.cohort === "all" ? "selected" : ""}>all attempts</option></select></label>
          ${tasks.length > 1 ? `<label class="field">Task <select data-task ${target("setMatrixTask")}><option value="all">all tasks</option>${tasks.map((t) => `<option ${t === this.task ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>` : ""}
        </div></div>
      <p class="legend">Cells count judge assessments: one per attempt and behavior dimension, not cited units.
        <span class="lg"><span class="sw oc-constructive"></span>constructive</span> <span class="lg"><span class="sw oc-mixed"></span>mixed</span>
        <span class="lg"><span class="sw oc-adverse"></span>adverse</span> <span class="lg"><span class="sw oc-context-dependent"></span>context-dependent</span>
        <span class="lg"><span class="sw oc-abstained"></span>abstained (no rating)</span>.
        ${anyCert ? "<b>EBO certified</b>: the cell equals the tally in the EBO Atlas report for the chosen cohort; <b>exploratory</b>: computed here." : "This study has no EBO Atlas report, so every number here is <b>exploratory</b> (computed from the judge assertions)."}
        Judgments are unreviewed model proposals over sampled evidence. Click a cell for its judgments; click a judgment for rationale and cited native records.</p>
      <div class="p3-split">
        <div class="table-wrap mx-wrap"><table class="grid mxt"><thead><tr><th scope="col">Behavior</th>${arms.map((a) => `<th scope="col" class="arm"><span class="arm-name">${esc(a)}</span></th>`).join("")}</tr></thead>
          <tbody>${cats.map((c) => `<tr><th scope="row" class="c-label">${esc(c)}</th>${arms.map((a) => cell(c, a)).join("")}</tr>`).join("")}</tbody></table></div>
        <div class="table-wrap jl-wrap"><p class="sub">${this.sel ? `${esc(this.sel.cat)} × ${esc(this.sel.arm)} · <button class="link" data-clear ${target("selectMatrixCell", "all")}>show all</button>` : "All judgments"} (${list.length})</p>
          <table class="grid jl"><thead><tr><th>Arm</th><th>Task</th><th>Trial</th><th>Attempt</th><th>Behavior</th><th>Outcome</th><th class="num">Conf.</th><th class="num">Cites</th><th>Rationale (start)</th></tr></thead>
          <tbody>${list.map((a) => `<tr data-id="${esc(a.id)}" ${target("openAssessment", a.id)} tabindex="0"><td>${esc(a.condition)}</td><td>${esc(a.task_id)}</td><td>${esc(a.trial_id)}</td><td class="mono">${esc(a.short)}</td><td>${esc(a.dimension)}</td>
            <td>${outChip(a.outcome)}</td><td class="num">${a.confidence == null ? "—" : num(a.confidence)}</td><td class="num">${a.citations.length}</td><td class="small">${esc((a.rationale ?? "").slice(0, 140))}${(a.rationale ?? "").length > 140 ? "…" : ""}</td></tr>`).join("")}</tbody></table></div>
      </div>`;
    this.root.querySelector<HTMLSelectElement>("[data-cohort]")!.addEventListener("change", (e) => run("setMatrixCohort", { cohort: (e.target as HTMLSelectElement).value }));
    this.root.querySelector<HTMLSelectElement>("[data-task]")?.addEventListener("change", (e) => run("setMatrixTask", { task: (e.target as HTMLSelectElement).value }));
    this.root.querySelector("[data-clear]")?.addEventListener("click", () => run("selectMatrixCell", { category: null }));
    this.root.querySelectorAll<HTMLElement>("td.mx[data-cat]").forEach((td) => {
      const act = () => { const on = this.sel && this.sel.cat === td.dataset.cat && this.sel.arm === td.dataset.arm; run("selectMatrixCell", on ? { category: null } : { category: td.dataset.cat, arm: td.dataset.arm }); };
      td.addEventListener("click", act);
      td.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
    });
    this.root.querySelectorAll<HTMLElement>("table.jl tbody tr").forEach((tr) => {
      const act = () => run("openAssessment", { id: tr.dataset.id });
      tr.addEventListener("click", act);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") act(); });
    });
  }
}

/** Claims rebuilt from a report: text, numbers with how they were computed, supporting judgments → evidence. */
export class ClaimsPanel {
  focused: string | null = null;
  constructor(private root: HTMLElement, private doc: ClaimsDoc | null, private ev: Evidence) {
    describable("claims", { describe: () => ({ summary: this.doc?.claims.length ? `${this.doc.claims.length} claims, validation ${this.doc.validated ? "passed" : "failed"}${this.focused ? `, ${this.focused} in focus` : ""}.` : "No claims in this bundle.",
      data: { focused: this.focused, claims: (this.doc?.claims ?? []).map((c) => ({ id: c.id, text: c.text, ok: c.ok, numbers: c.numbers.map((n) => ({ label: n.label, value: n.value, computed: n.computed, kind: n.kind, ok: n.ok })) })) } as unknown as Json }) });
    this.render();
  }
  render() {
    const d = this.doc;
    if (!d || !d.claims.length) { this.root.innerHTML = `<div class="panel-head"><div><h2>Claims</h2><p class="sub">No claims have been rebuilt for this study yet.</p></div></div>`; return; }
    this.root.innerHTML = `<div class="panel-head"><div><h2>Claims</h2>
      <p class="sub">${d.claims.length} claims from <span class="mono">${esc(d.source.file)}</span> · validation ${d.validated ? `<span class="ok">passed</span>: every number recomputes and every cited native line re-hashes` : `<span class="bad">failed</span>`}</p></div></div>
      <p class="legend">Number kinds: ${Object.entries(d.number_kinds).map(([k, v]) => `<b>${esc(k)}</b> = ${esc(v)}`).join(" · ")}</p>
      <div class="table-wrap claims">${d.claims.map((c) => `<article class="claim" id="claim-${esc(c.id)}">
        <h3><span class="cid">${esc(c.id)}</span> ${esc(c.text)} ${c.ok ? `<span class="ok">✓ resolves</span>` : `<span class="bad">✕ fails</span>`}</h3>
        <p class="muted small">${esc(c.type)} · source section: ${esc(c.source_section)}${c.cohort ? ` · cohort ${esc(c.cohort)}` : ""}</p>
        <table class="grid nums"><thead><tr><th>Number</th><th class="num">Stated</th><th class="num">Computed</th><th>Kind</th><th>How</th></tr></thead><tbody>
          ${c.numbers.map((n) => `<tr><td>${esc(n.label)}</td><td class="num">${num(n.value)}</td><td class="num">${num(n.computed)}${n.ok ? "" : ` <span class="bad">≠</span>`}</td><td><span class="tag-${n.kind === "certified" ? "c" : "x"}">${esc(n.kind)}</span></td><td class="mono small">${esc(n.how)}</td></tr>`).join("")}
        </tbody></table>
        <p>Supporting judgments (${c.support.length}) · cited native records ${num(c.citations_resolved)}/${num(c.citations_total)} resolved:</p>
        <ul class="sup">${c.support.map((s) => `<li><button class="link" data-assess="${esc(s.id)}" ${target("openAssessment", s.id)}>${esc(s.condition)} · trial ${esc(s.trial_id)} · ${esc(s.short)} · ${esc(s.dimension)}</button> ${outChip(s.outcome)} · ${num(s.citations)} citations</li>`).join("")}</ul>
        ${c.caveat ? `<p class="caveat">${esc(c.caveat)}</p>` : ""}</article>`).join("")}</div>`;
    this.root.querySelectorAll<HTMLElement>("[data-assess]").forEach((b) => b.addEventListener("click", () => run("openAssessment", { id: b.dataset.assess })));
    if (this.focused) this.focus(this.focused);
  }
  focus(id: string | null) {
    this.focused = id;
    this.root.querySelectorAll(".claim.on").forEach((x) => x.classList.remove("on"));
    const el = id === null ? null : this.root.querySelector<HTMLElement>(`#claim-${CSS.escape(id)}`);
    if (!el) return;
    el.classList.add("on");
    el.scrollIntoView({ block: "start" });
  }
}
