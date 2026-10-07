// Cluster × arm panel: how each arm's units distribute over behavior clusters, under the cloud's current filter.
// Exploratory numbers (computed in the browser over the frozen unit table); not certified EBO aggregates.
import type { Coordinator } from "@uwdata/mosaic-core";
import { describable, provide, register, run, target } from "./registry";

type Row = Record<string, any>;
export const rowsOf = (t: any): Row[] =>
  (t?.toArray?.() ?? []).map((r: any) => {
    const o = r.toJSON ? r.toJSON() : r;
    for (const k of Object.keys(o)) if (typeof o[k] === "bigint") o[k] = Number(o[k]);
    return o;
  });

interface Cell { arm: string; o: number; e: number; nArm: number; k: number; kArm: number; share: number; ratio: number; z: number }
interface ClusterRow { id: number; family: string; label: string; size: number; familySize: number; cells: Cell[]; maxAbsZ: number }

const FAMILIES = ["all", "messages", "episodes", "tools"] as const;
const fmtPct = (x: number) => (x >= 0.1 ? (x * 100).toFixed(0) : x >= 0.01 ? (x * 100).toFixed(1) : (x * 100).toFixed(2)) + "%";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class ClusterArmPanel {
  private predicate: string | null = null;
  private rows: ClusterRow[] = [];
  private arms: { arm: string; kArm: number; nArmTotal: number; byFamily: Record<string, number> }[] = [];
  private family: (typeof FAMILIES)[number] = "all";
  private sort: "difference" | "size" = "difference";
  private selected: number | null = null;
  private strata = 1;                       // distinct harnesses in the study
  private stratify = false;                 // expected counts pooled within the same harness
  private seq = 0;
  private strataChecked = false;
  private tip: HTMLDivElement;

  constructor(private root: HTMLElement, private coordinator: Coordinator, private onHighlight: (ids: number[] | null) => void,
              private onOpenLanes?: (clusterId: number, label: string) => Promise<void> | void) {
    this.tip = document.createElement("div");
    this.tip.className = "tip";
    this.tip.hidden = true;
    document.body.appendChild(this.tip);
    const none = { type: "object", properties: {}, additionalProperties: false };
    register<{ family: (typeof FAMILIES)[number] }>({ name: "setClusterFamily", description: "Show clusters of one unit family (or all).",
      args: { type: "object", required: ["family"], properties: { family: { enum: [...FAMILIES] } }, additionalProperties: false },
      run: ({ family }) => { this.family = family; this.render(); return `Clusters × arm shows ${family} clusters.`; } });
    register<{ sort: "difference" | "size" }>({ name: "setClusterSort", description: "Sort clusters by the largest arm difference or by size.",
      args: { type: "object", required: ["sort"], properties: { sort: { enum: ["difference", "size"] } }, additionalProperties: false },
      run: ({ sort }) => { this.sort = sort; this.render(); return `Clusters sorted by ${sort}.`; } });
    register<{ withinHarness: boolean }>({ name: "setClusterBaseline", description: "Compute expected counts from arms on the same harness, or from all arms.",
      args: { type: "object", required: ["withinHarness"], properties: { withinHarness: { type: "boolean" } }, additionalProperties: false },
      run: async ({ withinHarness }) => { this.stratify = withinHarness; await this.refresh(); return `Expected counts from ${withinHarness ? "arms on the same harness" : "all arms"}.`; } });
    register<{ id: number | null }>({ name: "selectCluster", description: "Select a cluster row (highlights its units in the cloud); null clears.",
      args: { type: "object", required: ["id"], properties: { id: { type: ["integer", "null"] } }, additionalProperties: false },
      run: async ({ id }) => { await this.select(id); return id === null ? "Cleared the cluster selection." : `Selected cluster ${id}.`; } });
    register({ name: "showClusterInLanes", description: "Show the selected cluster in the swimlanes.", args: none,
      run: async () => { const r = this.rows.find((x) => x.id === this.selected); if (r) await this.onOpenLanes?.(r.id, r.label); return r ? `Swimlanes focus cluster ${r.id}.` : "No cluster selected."; } });
    register({ name: "exportClusterTable", description: "Download the cluster × arm table as CSV.", args: none, readOnly: true,
      run: () => { this.downloadCsv(); return "Downloaded clusters-by-arm.csv."; } });
    provide({ key: "clusters", get: () => ({ family: this.family, sort: this.sort, withinHarness: this.stratify, selected: this.selected }),
      apply: async (st: { family: (typeof FAMILIES)[number]; sort: "difference" | "size"; withinHarness: boolean; selected: number | null }) => {
        const refresh = st.withinHarness !== this.stratify;
        this.family = st.family; this.sort = st.sort; this.stratify = st.withinHarness;
        if (refresh) await this.refresh(); else this.render();
        await this.select(st.selected);
      } });
    describable("clusters", this);
  }

  /** The cluster × arm table currently shown: O, E, z per cell, from the same query the panel renders. */
  describe() {
    const rows = this.visibleRows();
    return {
      summary: `${rows.length} ${this.family === "all" ? "" : this.family + " "}clusters, ${rows.filter((r) => r.maxAbsZ >= 3).length} with an arm at |z| ≥ 3, ${this.predicate ? "inside the cloud selection" : "all units"}; expected counts from ${this.stratify ? "arms on the same harness" : "all arms"}. Exploratory.`,
      data: { family: this.family, filtered: this.predicate !== null, rows: rows.map((r) => ({ cluster: r.id, label: r.label, family: r.family, units: r.size,
        cells: r.cells.map((c) => ({ arm: c.arm, observed: c.o, expected: Number(c.e.toFixed(3)), z: Number(c.z.toFixed(3)), attempts: c.k, attemptsInArm: c.kArm })) })) },
    };
  }

  async setPredicate(predicate: string | null) {
    this.predicate = predicate && predicate.trim() ? predicate : null;
    await this.refresh();
  }

  private where() {
    return this.predicate ? `(${this.predicate})` : "TRUE";
  }

  private async refresh() {
    const seq = ++this.seq;
    const where = this.where();
    if (this.strata === 1 && !this.strataChecked) {
      this.strataChecked = true;
      this.strata = rowsOf(await this.coordinator.query(`SELECT count(DISTINCT harness_id) AS n FROM units`))[0]?.n ?? 1;
      this.stratify = this.strata > 1;   // compare models on the same harness by default
    }
    const stratum = this.stratify ? "coalesce(harness_id, '')" : "''";
    // Expected counts are pooled over the arms of the same family (and, when stratified, the same harness):
    // E = n(cluster, stratum) · n(arm, family) / n(family, stratum). Arms are assumed to belong to one stratum.
    const sql = `
      WITH pop AS (SELECT family, cluster_id, cluster_label, condition, attempt_id, ${stratum} AS stratum FROM units WHERE ${where}),
      f  AS (SELECT family, stratum, count(*) AS n_f FROM pop GROUP BY ALL),
      fa AS (SELECT family, stratum, condition, count(*) AS n_fa FROM pop GROUP BY ALL),
      cl AS (SELECT family, cluster_id, any_value(cluster_label) AS label, count(*) AS n_total FROM pop WHERE cluster_id >= 0 GROUP BY ALL),
      cs AS (SELECT cluster_id, stratum, count(*) AS n_c FROM pop WHERE cluster_id >= 0 GROUP BY ALL),
      ca AS (SELECT cluster_id, condition, count(*) AS o, count(DISTINCT attempt_id) AS k FROM pop WHERE cluster_id >= 0 GROUP BY ALL),
      arm AS (SELECT condition, count(DISTINCT attempt_id) AS k_arm FROM pop GROUP BY ALL)
      SELECT cl.family, cl.cluster_id, cl.label, cl.n_total, coalesce(cs.n_c, 0) AS n_c, f.n_f, fa.condition, fa.n_fa,
             coalesce(ca.o, 0) AS o, coalesce(ca.k, 0) AS k, arm.k_arm
      FROM cl JOIN fa ON fa.family = cl.family
      JOIN f ON f.family = fa.family AND f.stratum = fa.stratum
      LEFT JOIN arm ON arm.condition = fa.condition
      LEFT JOIN cs ON cs.cluster_id = cl.cluster_id AND cs.stratum = fa.stratum
      LEFT JOIN ca ON ca.cluster_id = cl.cluster_id AND ca.condition = fa.condition
      ORDER BY cl.cluster_id, fa.condition`;
    // Denominators follow the current scope: attempts and units inside the cloud selection (per family for the header).
    const armSql = `SELECT condition AS arm, count(DISTINCT attempt_id) FILTER (WHERE ${where}) AS k_arm,
                           count(*) FILTER (WHERE ${where}) AS n_arm,
                           count(*) FILTER (WHERE ${where} AND family = 'messages') AS n_messages,
                           count(*) FILTER (WHERE ${where} AND family = 'episodes') AS n_episodes,
                           count(*) FILTER (WHERE ${where} AND family = 'tools') AS n_tools FROM units GROUP BY ALL ORDER BY arm`;
    const [res, armRes] = await Promise.all([this.coordinator.query(sql), this.coordinator.query(armSql)]);
    if (seq !== this.seq) return; // a newer filter arrived
    this.arms = rowsOf(armRes).map((r) => ({ arm: r.arm, kArm: r.k_arm, nArmTotal: r.n_arm,
      byFamily: { all: r.n_arm, messages: r.n_messages, episodes: r.n_episodes, tools: r.n_tools } }));
    const byCluster = new Map<number, ClusterRow>();
    for (const r of rowsOf(res)) {
      let row = byCluster.get(r.cluster_id);
      if (!row) {
        row = { id: r.cluster_id, family: r.family, label: r.label ?? "(unlabelled)", size: r.n_total, familySize: r.n_f, cells: [], maxAbsZ: 0 };
        byCluster.set(r.cluster_id, row);
      }
      // Expected count if this arm's units spread over clusters like the pooled arms (same family, same stratum) do.
      const e = (r.n_c * r.n_fa) / r.n_f;
      const p = r.n_c / r.n_f, q = r.n_fa / r.n_f;
      const v = e * (1 - p) * (1 - q);
      const z = v > 0 ? (r.o - e) / Math.sqrt(v) : 0;            // adjusted standardized residual
      row.cells.push({ arm: r.condition, o: r.o, e, nArm: r.n_fa, k: r.k, kArm: r.k_arm ?? 0, share: r.n_fa ? r.o / r.n_fa : 0, ratio: e ? r.o / e : 0, z });
      row.maxAbsZ = Math.max(row.maxAbsZ, Math.abs(z));
    }
    this.rows = [...byCluster.values()];
    this.render();
  }

  private visibleRows() {
    const rows = this.rows.filter((r) => this.family === "all" || r.family === this.family);
    return rows.sort((a, b) => (this.sort === "size" ? b.size - a.size : b.maxAbsZ - a.maxAbsZ || b.size - a.size));
  }

  private render() {
    const rows = this.visibleRows();
    const arms = this.arms.map((a) => a.arm);
    const strong = rows.filter((r) => r.maxAbsZ >= 3).length;
    this.root.innerHTML = `
      <div class="panel-head">
        <div>
          <h2>Clusters × arm</h2>
          <p class="sub">${rows.length} clusters · ${strong} with an arm at |z| ≥ 3 · ${this.predicate ? "filtered by the cloud selection" : "all units"}</p>
        </div>
        <div class="controls">
          <div class="seg" role="radiogroup" aria-label="Unit family">
            ${FAMILIES.map((f) => `<button role="radio" aria-checked="${f === this.family}" data-family="${f}" ${target("setClusterFamily", f)}>${f}</button>`).join("")}
          </div>
          ${this.strata > 1 ? `<label class="field">Expected from
            <select data-stratify ${target("setClusterBaseline")}>
              <option value="1" ${this.stratify ? "selected" : ""}>arms on the same harness</option>
              <option value="0" ${this.stratify ? "" : "selected"}>all arms</option>
            </select>
          </label>` : ""}
          <label class="field">Sort
            <select data-sort ${target("setClusterSort")}>
              <option value="difference" ${this.sort === "difference" ? "selected" : ""}>Largest arm difference</option>
              <option value="size" ${this.sort === "size" ? "selected" : ""}>Cluster size</option>
            </select>
          </label>
          ${this.onOpenLanes ? `<button class="btn" data-open-lanes ${target("showClusterInLanes")} ${this.selected == null ? "disabled" : ""} title="Select a cluster row first">Show in swimlanes →</button>` : ""}
          <button class="btn" data-csv ${target("exportClusterTable")}>CSV</button>
        </div>
      </div>
      <p class="legend">
        Each cell: share of that arm's units <em>in the same family</em> that fall in the cluster, then units · attempts with ≥1 unit here / attempts of the arm${this.predicate ? " inside the cloud selection" : ""}.
        Fill: <span class="sw pos"></span> over- / <span class="sw neg"></span> under-represented vs. the pooled arms${this.stratify ? " <em>on the same harness</em>" : ""} (observed ÷ expected), drawn only where |z| ≥ 2; ▲▼ mark |z| ≥ 3.
        Exploratory: units within an attempt are not independent, so read the attempt counts before the percentages.
      </p>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr>
            <th scope="col" class="c-label">Cluster</th><th scope="col">Family</th><th scope="col" class="num">Units</th>
            ${this.arms.map((a) => `<th scope="col" class="arm"><span class="arm-name">${esc(a.arm)}</span><span class="arm-meta">${(a.byFamily[this.family] ?? a.nArmTotal).toLocaleString()} ${this.family === "all" ? "" : this.family + " "}units · ${a.kArm} attempts${this.predicate ? " in selection" : ""}</span></th>`).join("")}
          </tr></thead>
          <tbody>
            ${rows.map((r) => this.rowHtml(r, arms)).join("")}
          </tbody>
        </table>
        ${rows.length ? "" : `<p class="empty">No clustered units match the current cloud filter.</p>`}
      </div>`;
    this.bind();
  }

  private rowHtml(r: ClusterRow, arms: string[]) {
    const cells = arms.map((arm) => {
      const c = r.cells.find((x) => x.arm === arm);
      if (!c) return `<td class="cell na">—</td>`;
      const lr = c.ratio > 0 ? Math.log2(c.ratio) : -2;
      const t = Math.abs(c.z) >= 2 ? Math.min(1, Math.abs(lr) / 2) : 0;
      const fill = t > 0 ? `--t:${(0.15 + 0.6 * t).toFixed(2)}` : "--t:0";
      const dir = c.z >= 3 ? "▲" : c.z <= -3 ? "▼" : "";
      return `<td class="cell ${c.z > 0 ? "pos" : "neg"}" style="${fill}" data-cluster="${Number(r.id)}" data-arm="${esc(arm)}">
        <span class="share">${fmtPct(c.share)} <span class="dir">${dir}</span></span>
        <span class="meta">${c.o.toLocaleString()} units · ${c.k}/${c.kArm} attempts</span></td>`;
    }).join("");
    return `<tr data-cluster="${Number(r.id)}" ${target("selectCluster", r.id)} class="${this.selected === r.id ? "selected" : ""}" tabindex="0" aria-selected="${this.selected === r.id}">
      <th scope="row" class="c-label" title="${esc(r.label)}"><span class="lbl">${esc(r.label.replace(/`/g, ""))}</span></th>
      <td><span class="fam ${String(r.family ?? "").replace(/[^A-Za-z0-9_-]/g, "_")}">${esc(r.family)}</span></td>
      <td class="num">${r.size.toLocaleString()}</td>${cells}</tr>`;
  }

  private bind() {
    this.root.querySelectorAll<HTMLButtonElement>("[data-family]").forEach((b) =>
      b.addEventListener("click", () => run("setClusterFamily", { family: b.dataset.family })));
    this.root.querySelector<HTMLSelectElement>("[data-sort]")!.addEventListener("change", (e) => run("setClusterSort", { sort: (e.target as HTMLSelectElement).value }));
    this.root.querySelector("[data-csv]")!.addEventListener("click", () => run("exportClusterTable"));
    this.root.querySelector<HTMLSelectElement>("[data-stratify]")?.addEventListener("change", (e) => run("setClusterBaseline", { withinHarness: (e.target as HTMLSelectElement).value === "1" }));
    this.root.querySelector("[data-open-lanes]")?.addEventListener("click", () => run("showClusterInLanes"));
    this.root.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach((tr) => {
      const act = () => { const id = Number(tr.dataset.cluster); run("selectCluster", { id: this.selected === id ? null : id }); };
      tr.addEventListener("click", act);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
    });
    this.root.querySelectorAll<HTMLTableCellElement>("td.cell[data-cluster]").forEach((td) => {
      td.addEventListener("pointerenter", (e) => this.showTip(td, e));
      td.addEventListener("pointermove", (e) => this.moveTip(e));
      td.addEventListener("pointerleave", () => (this.tip.hidden = true));
    });
  }

  private async select(id: number | null) {
    this.selected = id;
    this.root.querySelectorAll("tbody tr").forEach((tr) => {
      const on = Number((tr as HTMLElement).dataset.cluster) === this.selected;
      tr.classList.toggle("selected", on);
      tr.setAttribute("aria-selected", String(on));
    });
    const open = this.root.querySelector<HTMLButtonElement>("[data-open-lanes]");
    if (open) open.disabled = this.selected === null;
    try {
      if (this.selected === null) return this.onHighlight(null);
      const res = await this.coordinator.query(`SELECT row_id FROM units WHERE cluster_id = ${this.selected} AND ${this.where()}`);
      this.onHighlight(rowsOf(res).map((r) => r.row_id));
    } catch (err) {
      console.warn("[ebo-atlas] highlight failed", err);
    }
  }

  private showTip(td: HTMLElement, e: PointerEvent) {
    const r = this.rows.find((x) => x.id === Number(td.dataset.cluster));
    const c = r?.cells.find((x) => x.arm === td.dataset.arm);
    if (!r || !c) return;
    this.tip.innerHTML = `<div class="tip-title">${esc(r.label.replace(/`/g, ""))}</div>
      <div class="tip-arm">${esc(c.arm)}</div>
      <table>
        <tr><td>Units in cluster</td><td>${c.o.toLocaleString()} of ${c.nArm.toLocaleString()} ${r.family} units (${fmtPct(c.share)})</td></tr>
        <tr><td>Expected if pooled${this.stratify ? " (same harness)" : ""}</td><td>${c.e.toFixed(1)}</td></tr>
        <tr><td>Observed ÷ expected</td><td>${c.ratio.toFixed(2)}×</td></tr>
        <tr><td>Adjusted residual z</td><td>${c.z.toFixed(2)}</td></tr>
        <tr><td>Attempts</td><td>${c.k} of ${c.kArm} have ≥1 unit here</td></tr>
      </table>`;
    this.tip.hidden = false;
    this.moveTip(e);
  }

  private moveTip(e: PointerEvent) {
    const pad = 14, w = this.tip.offsetWidth, h = this.tip.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    this.tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  private downloadCsv() {
    const head = ["cluster_id", "family", "label", "units", "arm", "observed", "expected_" + (this.stratify ? "within_harness" : "pooled"), "share_of_arm_family", "observed_over_expected", "z", "attempts_with_unit", "attempts_in_arm", "filter"];
    const lines = [head.join(",")];
    for (const r of this.visibleRows()) for (const c of r.cells)
      lines.push([r.id, r.family, JSON.stringify(r.label), r.size, JSON.stringify(c.arm), c.o, c.e.toFixed(3), c.share.toFixed(5), c.ratio.toFixed(4), c.z.toFixed(3), c.k, c.kArm, JSON.stringify(this.predicate ?? "")].join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    a.download = "clusters-by-arm.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
