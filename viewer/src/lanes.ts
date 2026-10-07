// Swimlanes: one lane per attempt for a task, grouped by arm. Tool calls on a time (or step) axis, messages as
// ticks, errors / failure chains / judge citations / compactions as markers, and a token ribbon (context per model
// request, or cumulative tokens) where per-turn usage exists. Shares the cloud's DuckDB table and filter; clicking a mark highlights it in the cloud.
// Two lanes can be aligned (diff.ts) and the task exported as a Chrome trace for Perfetto (trace.ts).
import type { Coordinator } from "@uwdata/mosaic-core";
import { rowsOf } from "./enrichment";
import { alignLanes, renderDiff } from "./diff";
import { downloadTrace } from "./trace";
import type { Evidence } from "./p3";
import { renderTotals, type TotalsState } from "./totals";
import { describable, provide, register, run, target } from "./registry";

export interface LaneMeta {
  attempt_id: string; task_id: string; condition: string; trial_id: string; harness_id: string; model_id: string;
  terminal_state: string; failure_class: string; capture_qualification: string; t_start_ms: number; t_end_ms: number;
  units: number; tools: number; errors: number; compactions: number; cited_units: number;
  usage_semantics: "per-turn" | "per-turn (native)" | "final-only" | "none"; tokens_total: number | null; cost_usd: number | null; context_max: number | null;
}
export interface LanesData { attempts: LaneMeta[]; usage: Record<string, [number, number][]>; context?: Record<string, [number, number][]> }
export interface Unit {
  row_id: number; attempt_id: string; seq: number; unit_kind: string; subkind: string | null; tool_kind: string | null; tool_name: string | null;
  check_kind: string | null; error_signature: string | null; command_head: string | null; target: string | null; status: string | null;
  t0_ms: number | null; t1_ms: number | null; timed: boolean; cluster_id: number; cluster_label: string | null;
  cited: boolean; occ: string; text: string; duration_seconds: number | null; condition: string; cat: string;
}

// Action categories in fixed categorical order (dataviz palette slots 1-6; validated light + dark), then neutral.
export const CATS = [
  { key: "inspect", label: "inspect (grep, sed, cat, ls…)" },
  { key: "edit", label: "edit / write (incl. shell writes)" },
  { key: "read", label: "read tool" },
  { key: "check", label: "check (test, build, typecheck, lint)" },
  { key: "shell", label: "other shell" },
  { key: "vcs", label: "git / vcs" },
  { key: "other", label: "other tools" },
] as const;
export const CAT_SQL = `CASE WHEN unit_kind <> 'tool' THEN unit_kind
  WHEN tool_kind IN ('edit', 'write') OR len(coalesce(writes, []::VARCHAR[])) > 0 THEN 'edit' WHEN tool_kind = 'read' THEN 'read'
  WHEN check_kind IN ('test', 'build', 'typecheck', 'lint', 'format') THEN 'check'
  WHEN check_kind = 'inspect' THEN 'inspect' WHEN check_kind = 'vcs' THEN 'vcs'
  WHEN tool_kind = 'shell' THEN 'shell' ELSE 'other' END`;
const FAILURE_OCC = ["failure-then-same-tool", "failure-then-other-tool", "consecutive-failure", "response-to-failure"];

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** A class-name token from bundle data: anything outside [A-Za-z0-9_-] becomes "_" (bundle content is untrusted). */
export const cls = (s: unknown) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
/** A number from bundle data for markup; anything else renders as NaN, never as markup. */
export const num = (x: unknown) => String(Number(x));
const fmtTok = (n: number | null) => n == null ? "" : n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n);
export const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}:${String(r).padStart(2, "0")}`;
};
export const unitTitle = (u: Unit) => u.unit_kind === "tool" ? (u.command_head || u.tool_kind || "tool") + (u.target ? ` ${u.target}` : "") : u.unit_kind;

const LABEL_W = 300, LANE_H = 64, GROUP_H = 26, AXIS_H = 26;
const ROW = { msg: [2, 8], tool: [11, 29], ribbon: [31, 42], mark: [44, 54] } as const;

export class SwimlanesPanel {
  private task: string;
  private axis: "time" | "step" = "time";
  private zoom = 1;
  private ribbon: "context" | "cumulative" | "off" = "context";
  private armFilter = "all";
  private units: Unit[] = [];
  private byLane = new Map<string, Unit[]>();
  private predicate: string | null = null;
  private predSet: Set<number> | null = null;
  private focus: { id: number; label: string } | null = null;
  private picked: string[] = [];           // attempt ids chosen for the diff (max 2)
  private mode: "lanes" | "diff" | "totals" = "lanes";
  private totals: TotalsState = { anchor: "compaction", n: 10 };
  private selectedRow: number | null = null;
  stretch: number | null = null;           // selected divergent stretch in the diff view
  private tip: HTMLDivElement;
  private seq = 0;
  private tasks: string[];

  ev: Evidence | null = null;               // P3 evidence (native records, audits); optional

  constructor(private root: HTMLElement, private coordinator: Coordinator, private data: LanesData,
              private onHighlight: (ids: number[] | null) => void) {
    this.tasks = [...new Set(data.attempts.map((a) => a.task_id))].sort();
    this.task = this.tasks[0];
    this.tip = document.createElement("div");
    this.tip.className = "tip"; this.tip.hidden = true;
    document.body.appendChild(this.tip);
    new ResizeObserver(() => { if (this.units.length && this.mode === "lanes") this.drawPlot(); }).observe(root);
    const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", required, properties, additionalProperties: false });
    register<{ task: string }>({ name: "setLaneTask", description: "Show the swimlanes of one task.", args: obj({ task: { enum: this.tasks } }),
      run: async ({ task }) => { this.task = task; this.picked = []; this.mode = "lanes"; if (this.armFilter !== "all" && !this.arms().includes(this.armFilter)) this.armFilter = "all"; await this.load(); return `Swimlanes show task ${task}.`; } });
    register<{ arm: string }>({ name: "setLaneArm", description: "Show one arm's attempts (or all arms).", args: obj({ arm: { type: "string" } }),
      run: ({ arm }) => { this.armFilter = arm; this.render(); return `Swimlanes show ${arm === "all" ? "all arms" : arm}.`; } });
    register<{ axis: "time" | "step" }>({ name: "setLaneAxis", description: "Lay lanes out by elapsed time or by action order.", args: obj({ axis: { enum: ["time", "step"] } }),
      run: ({ axis }) => { this.axis = axis; this.render(); return `Swimlane axis: ${axis}.`; } });
    register<{ ribbon: "context" | "cumulative" | "off" }>({ name: "setLaneRibbon", description: "Token ribbon: context per request, cumulative tokens, or off.", args: obj({ ribbon: { enum: ["context", "cumulative", "off"] } }),
      run: ({ ribbon }) => { this.ribbon = ribbon; this.render(); return `Token ribbon: ${ribbon}.`; } });
    register<{ zoom: number }>({ name: "setLaneZoom", description: "Horizontal zoom of the swimlanes (1-24).", args: obj({ zoom: { type: "integer", minimum: 1, maximum: 24 } }),
      run: ({ zoom }) => { this.zoom = zoom; if (this.mode === "lanes") this.drawPlot(); else this.render(); return `Swimlane zoom ${zoom}×.`; } });
    register<{ mode: "lanes" | "diff" | "totals" }>({ name: "setLaneMode", description: "Show lanes, the aligned diff of the two picked lanes, or all-arm totals.", args: obj({ mode: { enum: ["lanes", "diff", "totals"] } }),
      run: ({ mode }) => { this.mode = mode === "diff" && this.picked.length !== 2 ? "lanes" : mode; this.render(); return `Swimlanes mode: ${this.mode}.`; } });
    register<{ attemptId: string }>({ name: "toggleLanePick", description: "Pick or unpick a lane for the aligned diff (two at most).", args: obj({ attemptId: { type: "string" } }),
      run: ({ attemptId }) => { this.picked = this.picked.includes(attemptId) ? this.picked.filter((p) => p !== attemptId) : [...this.picked, attemptId].slice(-2); this.render(); return `Picked lanes: ${this.picked.length}.`; } });
    register({ name: "clearLaneClusterFocus", description: "Stop emphasizing a cluster in the swimlanes.", args: obj({}),
      run: () => { this.focus = null; this.render(); return "Cleared the cluster focus."; } });
    register({ name: "exportTrace", description: "Download the task's lanes as a Chrome trace for ui.perfetto.dev.", args: obj({}), readOnly: true,
      run: () => { downloadTrace(this.task, this.lanes(), this.byLane, this.data.usage, this.data.context); return "Downloaded the trace."; } });
    register<{ row: number | null }>({ name: "selectLaneUnit", description: "Select a unit in the swimlanes (highlights it in the cloud and opens its native records); null clears.", args: obj({ row: { type: ["integer", "null"] } }),
      run: async ({ row }) => { await this.selectUnit(row); return row === null ? "Cleared the unit selection." : `Selected unit row ${row}.`; } });
    register<{ attemptId: string }>({ name: "highlightAttempt", description: "Highlight one attempt's units in the cloud.", args: obj({ attemptId: { type: "string" } }),
      run: ({ attemptId }) => { this.onHighlight((this.byLane.get(attemptId) ?? []).map((u) => u.row_id)); return `Highlighted attempt ${attemptId.slice(0, 8)} in the cloud.`; } });
    register<{ anchor: TotalsState["anchor"] }>({ name: "setTotalsAnchor", description: "In totals, look at what follows each compaction or each failed call.", args: obj({ anchor: { enum: ["compaction", "failure"] } }),
      run: ({ anchor }) => { this.totals = { ...this.totals, anchor }; this.mode = "totals"; this.render(); return `Totals anchor: ${anchor}.`; } });
    register<{ n: number }>({ name: "setTotalsWindow", description: "In totals, the number of actions after each anchor.", args: obj({ n: { enum: [5, 10, 20, 50] } }),
      run: ({ n }) => { this.totals = { ...this.totals, n }; this.mode = "totals"; this.render(); return `Totals window: ${n} actions.`; } });
    register<{ index: number | null }>({ name: "selectDiffStretch", description: "Select a divergent stretch in the aligned diff (highlights its actions); null clears.", args: obj({ index: { type: ["integer", "null"] } }),
      run: ({ index }) => { this.stretch = index; if (this.mode === "diff") this.render(); return index === null ? "Cleared the stretch." : `Selected stretch ${index + 1}.`; } });
    provide({ key: "lanes", get: () => ({ task: this.task, arm: this.armFilter, axis: this.axis, ribbon: this.ribbon, zoom: this.zoom, mode: this.mode, picked: [...this.picked],
        cluster: this.focus ? { id: this.focus.id, label: this.focus.label } : null, row: this.selectedRow, totals: { ...this.totals }, stretch: this.stretch }),
      apply: async (st: { task: string; arm: string; axis: "time" | "step"; ribbon: "context" | "cumulative" | "off"; zoom: number; mode: "lanes" | "diff" | "totals"; picked: string[];
        cluster: { id: number; label: string } | null; row: number | null; totals: TotalsState; stretch: number | null }) => {
        const reload = st.task !== this.task || !this.units.length;
        Object.assign(this, { task: st.task, armFilter: st.arm, axis: st.axis, ribbon: st.ribbon, zoom: st.zoom, mode: st.mode, picked: [...st.picked], focus: st.cluster, totals: { ...st.totals }, stretch: st.stretch });
        if (reload) await this.load(); else this.render();
        await this.selectUnit(st.row, false);
      } });
    describable("lanes", this);
  }

  /** What the swimlanes show: visible attempts with their totals, failures and usage source. */
  describe() {
    const lanes = this.lanes();
    return {
      summary: `${lanes.length} attempts of task ${this.task}${this.armFilter === "all" ? "" : ` in arm ${this.armFilter}`}, ${this.mode} view, ${this.axis} axis${this.focus ? `, cluster ${this.focus.id} emphasized` : ""}.`,
      data: { task: this.task, arm: this.armFilter, mode: this.mode, lanes: lanes.map((l) => ({ attemptId: l.attempt_id, condition: l.condition, trial: l.trial_id, terminal: l.terminal_state,
        durationMs: l.t_end_ms - l.t_start_ms, tools: l.tools, errors: l.errors, compactions: l.compactions, citedUnits: l.cited_units, failureChains: this.ev?.chainsOf(l.attempt_id).length ?? null,
        usage: l.usage_semantics, tokens: l.tokens_total })) },
    };
  }

  private async selectUnit(row: number | null, open = true) {
    this.selectedRow = row;
    const svg = this.root.querySelector<SVGElement>(".lanes-svg");
    svg?.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
    if (row != null) svg?.querySelectorAll(`[data-row="${row}"]`).forEach((n) => n.classList.add("sel"));
    this.onHighlight(row == null ? null : [row]);
    const u = row == null ? undefined : this.unitByRow(row);
    if (open && row != null && u && this.ev) await this.ev.openUnit(u.attempt_id, row, `Record · ${unitTitle(u)}`);
  }

  lanes(): LaneMeta[] {
    return this.data.attempts.filter((a) => a.task_id === this.task && (this.armFilter === "all" || a.condition === this.armFilter));
  }
  arms(): string[] { return [...new Set(this.data.attempts.filter((a) => a.task_id === this.task).map((a) => a.condition))].sort(); }

  async load() {
    const seq = ++this.seq;
    const res = await this.coordinator.query(`
      SELECT row_id, attempt_id, seq, unit_kind, subkind, tool_kind, tool_name, check_kind, error_signature, command_head, target, status,
             t0_ms, t1_ms, timed, cluster_id, cluster_label, coalesce(cited, false) AS cited,
             coalesce(array_to_string(occurrences, ','), '') AS occ, left(embed_text, 280) AS text,
             duration_seconds, condition, ${CAT_SQL} AS cat
      FROM units WHERE task_id = '${this.task.replace(/'/g, "''")}' AND unit_kind IN ('tool', 'message', 'compaction', 'episode')
      ORDER BY attempt_id, seq`);
    if (seq !== this.seq) return;
    this.units = rowsOf(res) as Unit[];
    this.byLane = new Map();
    for (const u of this.units) (this.byLane.get(u.attempt_id) ?? this.byLane.set(u.attempt_id, []).get(u.attempt_id)!).push(u);
    await this.refreshPredicate();
  }

  async setPredicate(p: string | null) {
    this.predicate = p && p.trim() ? p : null;
    if (this.units.length) await this.refreshPredicate();
  }

  private async refreshPredicate() {
    const seq = ++this.seq;
    if (this.predicate) {
      const res = await this.coordinator.query(`SELECT row_id FROM units WHERE task_id = '${this.task.replace(/'/g, "''")}' AND (${this.predicate})`);
      if (seq !== this.seq) return;
      this.predSet = new Set(rowsOf(res).map((r) => r.row_id));
    } else this.predSet = null;
    this.render();
  }

  /** Called from the cluster × arm panel: emphasize one cluster; switch to the task where it is most common if absent here. */
  async focusCluster(id: number, label: string) {
    this.focus = { id, label };
    const res = await this.coordinator.query(`SELECT task_id, count(*) AS n FROM units WHERE cluster_id = ${id} GROUP BY 1 ORDER BY n DESC`);
    const counts = rowsOf(res);
    if (counts.length && !counts.some((c) => c.task_id === this.task)) { this.task = counts[0].task_id; this.mode = "lanes"; await this.load(); }
    else this.render();
  }

  /** From the evidence drawer: show one attempt (its task and arm) and select a unit. */
  async focusAttempt(attemptId: string, row?: number | null) {
    const lane = this.data.attempts.find((a) => a.attempt_id === attemptId);
    if (!lane) return;
    this.mode = "lanes";
    this.armFilter = lane.condition;
    this.selectedRow = row ?? null;
    if (row == null) this.onHighlight(null);
    if (lane.task_id !== this.task) { this.task = lane.task_id; await this.load(); } else this.render();
    if (row != null) {
      const el = this.root.querySelector<SVGElement>(`.lanes-svg [data-row="${row}"]`);
      const plot = this.root.querySelector<HTMLElement>(".lanes-plot");
      if (el && plot) { const x = Number(el.getAttribute("x") ?? el.getAttribute("x1") ?? 0); plot.scrollLeft = Math.max(0, x - plot.clientWidth / 3); }
      this.onHighlight([row]);
    }
    this.root.querySelector(`.lane-label[data-lane="${CSS.escape(attemptId)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private emphasized(u: Unit) {
    return (!this.predSet || this.predSet.has(u.row_id)) && (!this.focus || u.cluster_id === this.focus.id);
  }

  render() {
    this.tip.hidden = true;                    // a tooltip from the previous view must not outlive it
    const lanes = this.lanes();
    const focusN = this.focus ? this.units.filter((u) => u.cluster_id === this.focus!.id).length : 0;
    this.root.innerHTML = `
      <div class="panel-head">
        <div>
          <h2>Swimlanes</h2>
          <p class="sub">${this.mode === "totals" ? `Totals: all ${this.data.attempts.filter((a) => a.task_id === this.task).length} attempts in every arm (arm filter and cloud selection not applied)` : `${lanes.length} attempts`} · ${esc(this.task)} · ${this.axis === "time" ? "elapsed time from each attempt's first unit" : "action order"}${this.predicate ? " · dimmed outside the cloud selection" : ""}
          ${this.focus ? ` · <span class="chip">cluster: ${esc(this.focus.label.replace(/`/g, ""))} (${focusN}) <button class="chip-x" data-unfocus ${target("clearLaneClusterFocus")} aria-label="Clear cluster focus">×</button></span>` : ""}</p>
        </div>
        <div class="controls">
          <label class="field">Task <select data-task ${target("setLaneTask")}>${this.tasks.map((t) => `<option ${t === this.task ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
          <label class="field">Arm <select data-arm ${target("setLaneArm")}><option value="all">All arms</option>${this.arms().map((a) => `<option ${a === this.armFilter ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
          <div class="seg" role="radiogroup" aria-label="X axis">
            <button role="radio" aria-checked="${this.axis === "time"}" data-axis="time" ${target("setLaneAxis", "time")}>Time</button><button role="radio" aria-checked="${this.axis === "step"}" data-axis="step" ${target("setLaneAxis", "step")}>Steps</button>
          </div>
          <label class="field">Ribbon <select data-ribbon ${target("setLaneRibbon")}>${(["context", "cumulative", "off"] as const).map((r) => `<option value="${r}" ${r === this.ribbon ? "selected" : ""}>${r === "context" ? "Context per request" : r === "cumulative" ? "Cumulative tokens" : "Off"}</option>`).join("")}</select></label>
          <label class="field">Zoom <input type="range" min="1" max="24" step="1" value="${this.zoom}" data-zoom ${target("setLaneZoom")} aria-label="Horizontal zoom"></label>
          <button class="btn" data-diff ${target("setLaneMode", "diff")} ${this.picked.length === 2 || this.mode === "diff" ? "" : "disabled"} title="Pick two lanes with their checkboxes">${this.mode === "diff" ? "Back to lanes" : `Align ${this.picked.length}/2`}</button>
          <button class="btn" data-totals ${target("setLaneMode", "totals")} title="All-arm totals for this task and what follows compactions or failures">${this.mode === "totals" ? "Back to lanes" : "Totals"}</button>
          <button class="btn" data-trace ${target("exportTrace")} title="Chrome trace JSON for ui.perfetto.dev">Trace</button>
        </div>
      </div>
      <p class="legend lanes-legend">
        ${CATS.map((c) => `<span class="lg"><span class="sw cat-${c.key}"></span>${c.label}</span>`).join("")}
        <span class="lg"><span class="tick-msg"></span>message</span>
        <span class="lg"><span class="mk-err">✕</span>error</span>
        <span class="lg"><span class="band-fail"></span>failure chain (click it, or ✕ n in the lane header)</span>
        <span class="lg"><span class="band-rep"></span>repeated operation</span>
        <span class="lg"><span class="mk-cite">▾</span>cited by the judge</span>
        <span class="lg"><span class="mk-comp">┆</span>compaction</span>
        <span class="lg muted">Lane header: duration = first to last captured unit of the attempt (not the harness's own run time) · tools = tool calls · attempt id and cohort · token usage source ("no usage recorded" is not zero) · Audit = checks vs source changes vs final claims</span>
        <span class="lg"><span class="sw ribbon"></span>${this.ribbon === "context" ? "context tokens per model request (scaled to the largest shown)" : this.ribbon === "cumulative" ? "cumulative tokens (scaled to the largest shown)" : "token ribbon off"}</span>
      </p>
      <div class="lanes-view"></div>`;
    this.bindHead();
    if (this.mode === "diff" && this.picked.length === 2) this.drawDiff();
    else if (this.mode === "totals") this.drawTotals();
    else { this.mode = "lanes"; this.drawPlot(); }
  }

  private bindHead() {
    const q = <T extends Element>(s: string) => this.root.querySelector<T>(s)!;
    // keep the arm when the new task has it (setLaneTask)
    q<HTMLSelectElement>("[data-task]").addEventListener("change", (e) => run("setLaneTask", { task: (e.target as HTMLSelectElement).value }));
    q<HTMLSelectElement>("[data-ribbon]").addEventListener("change", (e) => run("setLaneRibbon", { ribbon: (e.target as HTMLSelectElement).value }));
    q<HTMLSelectElement>("[data-arm]").addEventListener("change", (e) => run("setLaneArm", { arm: (e.target as HTMLSelectElement).value }));
    this.root.querySelectorAll<HTMLButtonElement>("[data-axis]").forEach((b) => b.addEventListener("click", () => run("setLaneAxis", { axis: b.dataset.axis })));
    q<HTMLInputElement>("[data-zoom]").addEventListener("input", (e) => run("setLaneZoom", { zoom: Number((e.target as HTMLInputElement).value) }));
    q<HTMLButtonElement>("[data-diff]").addEventListener("click", () => run("setLaneMode", { mode: this.mode === "diff" ? "lanes" : "diff" }));
    q<HTMLButtonElement>("[data-totals]").addEventListener("click", () => run("setLaneMode", { mode: this.mode === "totals" ? "lanes" : "totals" }));
    q<HTMLButtonElement>("[data-trace]").addEventListener("click", () => run("exportTrace"));
    this.root.querySelector("[data-unfocus]")?.addEventListener("click", () => run("clearLaneClusterFocus"));
  }

  private plotWidth() {
    const view = this.root.querySelector<HTMLElement>(".lanes-view");
    return Math.max(400, ((view?.clientWidth ?? 1200) - LABEL_W - 28) * this.zoom);
  }

  private drawPlot() {
    const view = this.root.querySelector<HTMLElement>(".lanes-view");
    if (!view) return;
    const lanes = this.lanes();
    const W = this.plotWidth();
    const groups = new Map<string, LaneMeta[]>();
    for (const l of lanes) (groups.get(l.condition) ?? groups.set(l.condition, []).get(l.condition)!).push(l);

    // x scales: time = elapsed since the lane's first unit, shared domain so lanes compare; step = action index.
    const laneStart = (id: string) => Math.min(...(this.byLane.get(id) ?? []).filter((u) => u.t0_ms != null).map((u) => u.t0_ms!));
    // Steps = actions (tool calls + compactions), the same numbering as the audit, the diff and tooltips; messages sit between them.
    const steps = (id: string) => (this.byLane.get(id) ?? []).filter((u) => u.unit_kind === "tool" || u.unit_kind === "compaction");
    const maxDur = Math.max(1, ...lanes.map((l) => Math.max(...(this.byLane.get(l.attempt_id) ?? []).map((u) => u.t1_ms ?? 0)) - laneStart(l.attempt_id)));
    const maxSteps = Math.max(1, ...lanes.map((l) => steps(l.attempt_id).length));
    const series = (id: string) => this.ribbon === "context" ? this.data.context?.[id] : this.ribbon === "cumulative" ? this.data.usage[id] : undefined;
    const maxTok = Math.max(1, ...lanes.map((l) => Math.max(0, ...(series(l.attempt_id) ?? []).map((p) => p[1]))));

    let y = 0, labels = "", body = "";
    for (const [cond, ls] of groups) {
      labels += `<div class="lane-group" style="height:${GROUP_H}px" title="${esc(cond)}"><span class="lg-name">${esc(cond)}</span><span class="muted">${ls.length}×</span></div>`;
      body += `<rect x="0" y="${y}" width="${W}" height="${GROUP_H}" class="group-bg"/>`;
      y += GROUP_H;
      for (const l of ls) {
        const us = this.byLane.get(l.attempt_id) ?? [];
        const t0 = laneStart(l.attempt_id);
        const stepIdx = new Map(steps(l.attempt_id).map((u, i) => [u.row_id, i]));
        const sw = W / maxSteps;
        const X = (u: Unit, end = false) => this.axis === "time"
          ? (((end ? u.t1_ms : u.t0_ms) ?? t0) - t0) / maxDur * W
          : ((stepIdx.get(u.row_id) ?? nextStep) + (end ? 1 : 0)) * sw;
        const pickedIdx = this.picked.indexOf(l.attempt_id);
        const tok = [l.cost_usd != null ? `$${l.cost_usd.toFixed(2)}` : "", l.context_max ? `ctx ≤${fmtTok(l.context_max)}` : ""].filter(Boolean).join(" · ");
        const tokTitle = `${l.tokens_total != null ? fmtTok(l.tokens_total) + " tokens processed" : "no token usage reported"}${l.cost_usd != null ? ` · $${l.cost_usd.toFixed(2)}` : ""}${l.context_max ? ` · largest context of one request ${l.context_max.toLocaleString()}` : ""} · usage source: ${l.usage_semantics}`;
        labels += `<div class="lane-label ${pickedIdx >= 0 ? "picked" : ""}" style="height:${LANE_H}px" data-lane="${esc(l.attempt_id)}">
          <label class="pick"><input type="checkbox" data-pick="${esc(l.attempt_id)}" ${target("toggleLanePick", l.attempt_id)} ${pickedIdx >= 0 ? "checked" : ""} aria-label="Select trial ${esc(l.trial_id)} for alignment">${pickedIdx >= 0 ? `<b>${"AB"[pickedIdx]}</b>` : ""}</label>
          <div class="ll-main"><span class="ll-title">trial ${esc(l.trial_id)}${l.terminal_state !== "completed" ? ` <span class="badge">${esc(l.terminal_state)}</span>` : ""} <span class="muted" title="${esc(tokTitle)}">${tok}</span></span>
          <span class="ll-meta">${fmtDur(l.t_end_ms - l.t_start_ms)} · ${num(l.tools)} tools · ${num(l.errors)} err${l.compactions ? ` · <span title="${num(l.compactions)} compactions">┆${num(l.compactions)}</span>` : ""}</span>
          <span class="ll-id" title="${esc(`${l.attempt_id} · cohorts: ${(this.ev?.meta.get(l.attempt_id)?.cohorts ?? []).join(", ") || "—"} · token usage source: ${l.usage_semantics === "none" ? "none recorded (not zero)" : l.usage_semantics}`)}"><span class="mono">${esc(l.attempt_id.slice(0, 8))}</span>${(this.ev?.meta.get(l.attempt_id)?.cohorts ?? []).map((c) => ` <span class="coh">${esc(c)}</span>`).join("")} · ${l.usage_semantics === "none" ? "<span class=\"no-usage\">no usage recorded</span>" : `usage: ${esc(l.usage_semantics)}`}</span></div>
          ${this.ev?.audit && this.ev.chainsOf(l.attempt_id).length ? `<button class="icon-btn fail-btn" data-chains="${esc(l.attempt_id)}" ${target("openChains", l.attempt_id)} title="Failure chains: failed calls and the next call of the same tool">✕ ${this.ev.chainsOf(l.attempt_id).length}</button>` : ""}
          ${this.ev?.audit ? `<button class="icon-btn" data-audit="${esc(l.attempt_id)}" ${target("openAudit", l.attempt_id)} title="Audit: checks vs source changes vs final claims, failure chains, final message">Audit</button>` : ""}
          <button class="icon-btn" data-lane-hl="${esc(l.attempt_id)}" ${target("highlightAttempt", l.attempt_id)} title="Highlight this attempt in the cloud" aria-label="Highlight attempt in cloud">◎</button>
        </div>`;
        body += `<g transform="translate(0,${y})" data-lane="${esc(l.attempt_id)}"><rect x="0" y="0" width="${W}" height="${LANE_H}" class="lane-bg"/>`;
        // token ribbon (behind the tool row)
        const usage = series(l.attempt_id);
        if (usage?.length && this.axis === "time") {
          const [a, b] = ROW.ribbon;
          const pts = usage.map(([t, v]) => `${Math.max(0, (t - t0) / maxDur * W).toFixed(1)},${(b - (v / maxTok) * (b - a)).toFixed(1)}`);
          body += `<path class="ribbon" d="M0,${b} L${pts.join(" L")} L${pts.at(-1)!.split(",")[0]},${b} Z"/>`;
        }
        let failRun: number[] | null = null, failRows: number[] = [];
        const failBand = (r: number[]) => `<rect class="band-fail-svg hit-fail" data-fail="${esc(l.attempt_id)}|${failRows.map(num).join(",")}" x="${r[0].toFixed(1)}" y="${ROW.mark[1] - 4}" width="${Math.max(4, r[1] - r[0]).toFixed(1)}" height="6"><title>Failure chain: click for the failed call vs the next call of that tool</title></rect>`;
        let nextStep = 0;                       // messages on the Steps axis go before the next action
        for (const u of us) {
          if (stepIdx.has(u.row_id)) nextStep = stepIdx.get(u.row_id)! + 1;
          const dim = this.emphasized(u) ? "" : " dim";
          const sel = u.row_id === this.selectedRow ? " sel" : "";
          if (u.unit_kind === "episode") continue;
          const x0 = X(u), x1 = Math.max(X(u, true), x0 + (this.axis === "time" ? 1.5 : Math.max(1, sw - (sw > 3 ? 1 : 0))));
          if (u.unit_kind === "message") {
            body += `<rect class="m-msg${dim}${sel}" data-row="${num(u.row_id)}" x="${x0.toFixed(1)}" y="${ROW.msg[0]}" width="1.5" height="${ROW.msg[1] - ROW.msg[0]}"/>`;
            body += `<rect class="hit" data-row="${num(u.row_id)}" x="${(x0 - 2.5).toFixed(1)}" y="0" width="6.5" height="${ROW.msg[1] + 1}"/>`;
          } else if (u.unit_kind === "compaction") {
            body += `<line class="m-comp${dim}" data-row="${num(u.row_id)}" x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="0" y2="${LANE_H}"/><rect class="hit" data-row="${num(u.row_id)}" x="${(x0 - 3).toFixed(1)}" y="0" width="6" height="${LANE_H}"/>`;
          } else {
            body += `<rect class="m-tool cat-${cls(u.cat)}${dim}${sel}" data-row="${num(u.row_id)}" x="${x0.toFixed(1)}" y="${ROW.tool[0]}" width="${(x1 - x0).toFixed(1)}" height="${ROW.tool[1] - ROW.tool[0]}" rx="1"/>`;
            if (x1 - x0 < 4) body += `<rect class="hit" data-row="${num(u.row_id)}" x="${(x0 - (4 - (x1 - x0)) / 2).toFixed(1)}" y="${ROW.tool[0]}" width="4" height="${ROW.tool[1] - ROW.tool[0]}"/>`;
            const occ = u.occ ? u.occ.split(",") : [];
            if (occ.some((o) => FAILURE_OCC.includes(o)) || u.status === "error") { if (!failRun) { failRun = [x0, x1]; failRows = []; } failRun[1] = x1; failRows.push(u.row_id); }
            else if (failRun) { body += failBand(failRun); failRun = null; }
            if (occ.includes("repeated-operation")) body += `<rect class="band-rep-svg${dim}" x="${x0.toFixed(1)}" y="${ROW.mark[1]}" width="${Math.max(1.5, x1 - x0).toFixed(1)}" height="2"/>`;
            if (u.status === "error") body += `<text class="m-err${dim}" data-row="${num(u.row_id)}" x="${x0.toFixed(1)}" y="${ROW.mark[0] + 6}">✕</text>`;
          }
          if (u.cited || this.ev?.citedRows.has(u.row_id)) body += `<text class="m-cite${dim}" data-row="${num(u.row_id)}" x="${x0.toFixed(1)}" y="${ROW.msg[1] + 1}">▾</text><rect class="hit" data-row="${num(u.row_id)}" x="${(x0 - 2).toFixed(1)}" y="${ROW.msg[1] - 8}" width="9" height="10"/>`;
        }
        if (failRun) body += failBand(failRun);
        body += `</g>`;
        y += LANE_H;
      }
    }
    // axis
    let axis = "";
    if (this.axis === "time") {
      const mins = maxDur / 60000, cands = [1, 2, 5, 10, 15, 30, 60, 120, 240];
      const step = cands.find((c) => mins / c <= W / 90) ?? 240; // labels at least ~90px apart
      for (let m = 0; m <= mins; m += step) { const x = (m * 60000) / maxDur * W; axis += `<line x1="${x}" x2="${x}" y1="${AXIS_H - 6}" y2="${AXIS_H}" class="ax"/><text x="${x + 3}" y="${AXIS_H - 9}" class="ax-t">${m < 60 ? m + "m" : (m / 60).toFixed(m % 60 ? 1 : 0) + "h"}</text>`; }
    } else {
      const raw = Math.max(1, maxSteps / (W / 90)), p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw)!;
      for (let s = 0; s <= maxSteps; s += step) { const x = (s / maxSteps) * W; axis += `<line x1="${x}" x2="${x}" y1="${AXIS_H - 6}" y2="${AXIS_H}" class="ax"/><text x="${x + 3}" y="${AXIS_H - 9}" class="ax-t">${s}</text>`; }
    }
    const scroll = view.querySelector<HTMLElement>(".lanes-plot")?.scrollLeft ?? 0;
    view.innerHTML = `
      <div class="lanes-grid" style="grid-template-columns:${LABEL_W}px minmax(0, 1fr)">
        <div class="lanes-corner" style="height:${AXIS_H}px">${this.axis === "time" ? "elapsed" : "action #"}</div>
        <div class="lanes-axis" style="height:${AXIS_H}px"><svg width="${W}" height="${AXIS_H}">${axis}</svg></div>
        <div class="lanes-labels">${labels}</div>
        <div class="lanes-plot"><svg width="${W}" height="${y}" class="lanes-svg">${body}</svg></div>
      </div>
      ${lanes.length ? "" : `<p class="empty">No attempts for this task and arm.</p>`}`;
    const plot = view.querySelector<HTMLElement>(".lanes-plot")!, axisEl = view.querySelector<HTMLElement>(".lanes-axis")!;
    const labelsEl = view.querySelector<HTMLElement>(".lanes-labels")!;
    plot.scrollLeft = scroll;
    plot.addEventListener("scroll", () => { axisEl.scrollLeft = plot.scrollLeft; labelsEl.scrollTop = plot.scrollTop; });
    labelsEl.addEventListener("wheel", (e) => { plot.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
    this.bindPlot(view);
  }

  private unitByRow(row: number) { return this.units.find((u) => u.row_id === row); }

  private bindPlot(view: HTMLElement) {
    const svg = view.querySelector<SVGElement>(".lanes-svg")!;
    svg.addEventListener("pointermove", (e) => {
      const row = (e.target as Element).getAttribute?.("data-row");
      if (!row) { this.tip.hidden = true; return; }
      const u = this.unitByRow(Number(row)); if (!u) return;
      this.showTip(u, e);
    });
    svg.addEventListener("pointerleave", () => (this.tip.hidden = true));
    // Marks are delegated: a click runs the same command a script or an assistant would.
    svg.addEventListener("click", (e) => {
      const fail = (e.target as Element).getAttribute?.("data-fail");
      if (fail && this.ev) { const [aid, rows] = fail.split("|"); run("openChainAt", { attemptId: aid, rows: rows.split(",").map(Number) }); return; }
      const row = (e.target as Element).getAttribute?.("data-row");
      if (!row) return;
      const id = Number(row);
      run("selectLaneUnit", { row: this.selectedRow === id ? null : id });
    });
    view.querySelectorAll<HTMLButtonElement>("[data-chains]").forEach((b) => b.addEventListener("click", () => run("openChains", { attemptId: b.dataset.chains })));
    view.querySelectorAll<HTMLButtonElement>("[data-audit]").forEach((b) => b.addEventListener("click", () => run("openAudit", { attemptId: b.dataset.audit })));
    view.querySelectorAll<HTMLInputElement>("[data-pick]").forEach((cb) => cb.addEventListener("change", () => run("toggleLanePick", { attemptId: cb.dataset.pick })));
    view.querySelectorAll<HTMLButtonElement>("[data-lane-hl]").forEach((b) => b.addEventListener("click", () => run("highlightAttempt", { attemptId: b.dataset.laneHl })));
  }

  showTip(u: Unit, e: PointerEvent | MouseEvent) {
    const lane = this.data.attempts.find((a) => a.attempt_id === u.attempt_id);
    const t0 = Math.min(...(this.byLane.get(u.attempt_id) ?? []).filter((x) => x.t0_ms != null).map((x) => x.t0_ms!));
    this.tip.innerHTML = `<div class="tip-title">${esc(unitTitle(u))}</div>
      <div class="tip-arm">${esc(u.condition)} · trial ${esc(lane?.trial_id ?? "?")} · ${esc(u.attempt_id.slice(0, 8))} · ${(() => { const st = (this.byLane.get(u.attempt_id) ?? []).filter((x) => x.unit_kind === "tool" || x.unit_kind === "compaction"); const i = st.findIndex((x) => x.row_id === u.row_id); return i >= 0 ? `step ${i + 1} · ` : ""; })()}unit #${u.seq}</div>
      <table>
        <tr><td>Kind</td><td>${esc(u.unit_kind)}${u.unit_kind === "tool" ? ` · ${esc(u.cat)}` : ""}${u.status ? ` · ${esc(u.status)}` : ""}</td></tr>
        <tr><td>At</td><td>${u.t0_ms != null ? fmtDur(u.t0_ms - t0) : "—"}${u.timed ? "" : " (untimed; placed after the previous unit)"}${u.duration_seconds ? ` · ${u.duration_seconds.toFixed(1)} s` : ""}</td></tr>
        <tr><td>Cluster</td><td>${u.cluster_id >= 0 ? esc((u.cluster_label ?? "").replace(/`/g, "")) : "noise"}</td></tr>
        ${u.occ ? `<tr><td>Occurrences</td><td>${esc(u.occ.replace(/,/g, ", "))}</td></tr>` : ""}
        ${u.cited || this.ev?.citedRows.has(u.row_id) ? `<tr><td>Judge</td><td>cited by ${this.ev ? this.ev.doc.assessments.filter((a) => a.citations.some((c) => c.row_id === u.row_id)).map((a) => `${esc(a.dimension)} (${esc(a.outcome)})`).join(", ") || "an assessment" : "an assessment"}</td></tr>` : ""}
      </table>
      <div class="tip-text">${esc(u.text ?? "")}</div>${this.ev ? `<div class="tip-hint">Click for the native record</div>` : ""}`;
    this.tip.hidden = false;
    const pad = 14, w = this.tip.offsetWidth, h = this.tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    this.tip.style.transform = `translate(${x}px, ${y}px)`;
  }
  hideTip() { this.tip.hidden = true; }

  private drawDiff() {
    const view = this.root.querySelector<HTMLElement>(".lanes-view")!;
    const [a, b] = this.picked.map((id) => this.data.attempts.find((x) => x.attempt_id === id)!);
    const result = alignLanes(this.byLane.get(a.attempt_id) ?? [], this.byLane.get(b.attempt_id) ?? []);
    renderDiff(view, a, b, result, this, this.zoom);
  }

  highlight(ids: number[] | null) { this.onHighlight(ids); }

  private drawTotals() {
    const view = this.root.querySelector<HTMLElement>(".lanes-view")!;
    const all = this.data.attempts.filter((a) => a.task_id === this.task);
    renderTotals(view, this.task, all, this.byLane, this.totals, (rows) => this.onHighlight(rows), this.ev);
  }
}
