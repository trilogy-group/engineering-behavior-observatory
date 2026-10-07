// Aligned diff of two attempts: LCS over their action signatures (tool category + command head, plus the target
// for reads and edits; compactions included, free-text messages excluded). Divergent runs are where one attempt did
// something the other did not at that point in the shared sequence.
import { CATS, cls, esc, fmtDur, num, unitTitle, type LaneMeta, type SwimlanesPanel, type Unit } from "./lanes";
import { run, target } from "./registry";

export type Op = { t: "=" | "-" | "+"; a?: Unit; b?: Unit };
export interface Segment { i0: number; i1: number; a: Unit[]; b: Unit[] }
export interface AlignResult { ops: Op[]; nA: number; nB: number; matched: number; segments: Segment[] }

const actions = (us: Unit[]) => us.filter((u) => u.unit_kind === "tool" || u.unit_kind === "compaction");
export const signature = (u: Unit) => u.unit_kind === "compaction" ? "compaction"
  : `${u.cat}:${u.command_head || u.tool_kind || "?"}${u.cat === "edit" || u.cat === "read" ? ":" + (u.target ?? "") : ""}`;

export function alignLanes(laneA: Unit[], laneB: Unit[]): AlignResult {
  const A = actions(laneA), B = actions(laneB);
  const dict = new Map<string, number>();
  const code = (u: Unit) => { const s = signature(u); if (!dict.has(s)) dict.set(s, dict.size); return dict.get(s)!; };
  const a = A.map(code), b = B.map(code), n = a.length, m = b.length, W = m + 1;
  const L = new Uint16Array((n + 1) * (m + 1));               // L[i][j] = LCS of a[i:], b[j:]
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: "=", a: A[i++], b: B[j++] }); }
    else if (j < m && (i >= n || L[i * W + j + 1] >= L[(i + 1) * W + j])) ops.push({ t: "+", b: B[j++] });
    else ops.push({ t: "-", a: A[i++] });
  }
  // divergent stretches: maximal runs of non-matching actions (either side), kept when >= 3 actions, in sequence order
  const segments: Segment[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "=") { k++; continue; }
    let e = k;
    while (e + 1 < ops.length && ops[e + 1].t !== "=") e++;
    const seg = ops.slice(k, e + 1);
    const sa = seg.filter((o) => o.t === "-").map((o) => o.a!), sb = seg.filter((o) => o.t === "+").map((o) => o.b!);
    if (sa.length + sb.length >= 3) segments.push({ i0: k, i1: e, a: sa, b: sb });
    k = e + 1;
  }
  return { ops, nA: n, nB: m, matched: L[0], segments };
}

const summarize = (us: Unit[]) => {
  if (!us.length) return `<span class="muted">—</span>`;
  const c = new Map<string, number>();
  for (const u of us) c.set(unitTitle(u), (c.get(unitTitle(u)) ?? 0) + 1);
  return [...c].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `<code>${esc(k)}</code>×${v}`).join(" ") + (c.size > 3 ? ` <span class="muted">+${c.size - 3}</span>` : "");
};
const catCounts = (us: Unit[]) => { const c: Record<string, number> = {}; for (const u of actions(us)) c[u.unit_kind === "compaction" ? "compaction" : u.cat] = (c[u.unit_kind === "compaction" ? "compaction" : u.cat] ?? 0) + 1; return c; };

export function renderDiff(view: HTMLElement, A: LaneMeta, B: LaneMeta, r: AlignResult, panel: SwimlanesPanel, zoom = 1) {
  const laneA = r.ops.filter((o) => o.a).map((o) => o.a!), laneB = r.ops.filter((o) => o.b).map((o) => o.b!);
  const t0A = Math.min(...laneA.filter((u) => u.t0_ms != null).map((u) => u.t0_ms!)), t0B = Math.min(...laneB.filter((u) => u.t0_ms != null).map((u) => u.t0_ms!));
  const sim = r.nA + r.nB ? (2 * r.matched) / (r.nA + r.nB) : 0;
  const big = new Set(r.segments.map((s, n) => [n, s.a.length + s.b.length]).sort((x, y) => y[1] - x[1]).slice(0, 5).map((x) => x[0]));
  const ca = catCounts(laneA), cb = catCounts(laneB);
  const keys = [...CATS.map((c) => c.key as string), "compaction"].filter((k) => ca[k] || cb[k]);
  const maxC = Math.max(1, ...keys.map((k) => Math.max(ca[k] ?? 0, cb[k] ?? 0)));
  const W = Math.max(600, (view.clientWidth - 40) * zoom), cw = W / Math.max(1, r.ops.length);
  const segIndex = new Map<number, number>(); r.segments.forEach((s, n) => { for (let i = s.i0; i <= s.i1; i++) segIndex.set(i, n); });
  let strip = "";
  r.ops.forEach((o, i) => {
    const x = (i * cw).toFixed(2), w = Math.max(0.8, cw - (cw > 3 ? 0.6 : 0)).toFixed(2);
    if (o.a) strip += `<rect class="m-tool cat-${o.a.unit_kind === "compaction" ? "comp" : cls(o.a.cat)}${o.t === "=" ? " matched" : ""}" data-row="${num(o.a.row_id)}" x="${x}" y="16" width="${w}" height="18"/>`;
    if (o.b) strip += `<rect class="m-tool cat-${o.b.unit_kind === "compaction" ? "comp" : cls(o.b.cat)}${o.t === "=" ? " matched" : ""}" data-row="${num(o.b.row_id)}" x="${x}" y="52" width="${w}" height="18"/>`;
  });
  r.segments.forEach((s, n) => {
    const x = s.i0 * cw, w = Math.max(2, (s.i1 - s.i0 + 1) * cw);
    strip += `<rect class="seg-band" data-seg="${n}" x="${x.toFixed(1)}" y="38" width="${w.toFixed(1)}" height="10" rx="2"/>`;
    if (w >= 9) strip += `<text class="seg-num" x="${(x + w / 2).toFixed(1)}" y="47" text-anchor="middle">${n + 1}</text>`;
  });
  view.innerHTML = `
    <div class="diff">
     <div class="diff-head">
      <div class="diff-summary">
        <div><span class="diff-tag">A</span> ${esc(A.condition)} · trial ${esc(A.trial_id)} · ${r.nA} actions · ${fmtDur(A.t_end_ms - A.t_start_ms)}</div>
        <div><span class="diff-tag b">B</span> ${esc(B.condition)} · trial ${esc(B.trial_id)} · ${r.nB} actions · ${fmtDur(B.t_end_ms - B.t_start_ms)}</div>
        <div class="diff-sim"><b>${(sim * 100).toFixed(0)}%</b> of actions align (${r.matched} shared in order) · ${r.segments.length} divergent stretches ≥ 3 actions, listed in sequence order; the largest are bold</div>
      </div>
      <div class="diff-cats">
        <table><thead><tr><th>Category</th><th class="num">A</th><th class="num">B</th><th>B − A</th></tr></thead><tbody>
        ${keys.map((k) => { const d = (cb[k] ?? 0) - (ca[k] ?? 0), w = Math.abs(d) / maxC * 80;
          return `<tr><td><span class="sw cat-${k === "compaction" ? "comp" : cls(k)}"></span> ${esc(k)}</td><td class="num">${ca[k] ?? 0}</td><td class="num">${cb[k] ?? 0}</td>
            <td class="dbar"><span class="${d >= 0 ? "pos" : "neg"}" style="width:${w.toFixed(0)}px"></span> ${d > 0 ? "+" : ""}${d}</td></tr>`; }).join("")}
        </tbody></table>
      </div>
      <div class="diff-strip-wrap" aria-label="Aligned action sequences">
        <svg width="${W}" height="76" class="diff-strip">
          <text x="0" y="12" class="ax-t">A — shared actions faded, A-only at full color</text>
          ${strip}
        </svg>
        <div class="ax-t diff-b-label">B — B-only at full color · numbered bands are the stretches listed below</div>
      </div>
     </div>
     <div class="seg-scroll">
      <table class="grid seg-table">
        <thead><tr><th>#</th><th>Where</th><th>A did</th><th>B did</th><th class="num">Size</th></tr></thead>
        <tbody>${r.segments.map((s, n) => {
          const fa = s.a[0], fb = s.b[0];
          return `<tr data-seg="${n}" ${target("selectDiffStretch", n)} tabindex="0" class="${big.has(n) ? "big" : ""}"><td>${n + 1}</td>
            <td>${((s.i0 / r.ops.length) * 100).toFixed(0)}% in · A ${fa?.t0_ms != null ? fmtDur(fa.t0_ms - t0A) : "—"} · B ${fb?.t0_ms != null ? fmtDur(fb.t0_ms - t0B) : "—"}</td>
            <td>${s.a.length} · ${summarize(s.a)}</td><td>${s.b.length} · ${summarize(s.b)}</td><td class="num">${s.a.length + s.b.length}</td></tr>`;
        }).join("")}</tbody>
      </table>
      ${r.segments.length ? "" : `<p class="empty">The two action sequences align completely.</p>`}
     </div>
    </div>`;
  const svg = view.querySelector<SVGElement>(".diff-strip")!;
  const byRow = new Map<number, Unit>(); for (const o of r.ops) { if (o.a) byRow.set(o.a.row_id, o.a); if (o.b) byRow.set(o.b.row_id, o.b); }
  svg.addEventListener("pointermove", (e) => { const row = (e.target as Element).getAttribute("data-row"); const u = row ? byRow.get(Number(row)) : null; if (u) panel.showTip(u, e); else panel.hideTip(); });
  svg.addEventListener("pointerleave", () => panel.hideTip());
  const pickSeg = (n: number) => {
    const s = r.segments[n];
    view.querySelectorAll(".seg-table tr.selected, .seg-band.on").forEach((x) => x.classList.remove("selected", "on"));
    view.querySelector(`.seg-table tr[data-seg="${n}"]`)?.classList.add("selected");
    const band = view.querySelector<SVGRectElement>(`.seg-band[data-seg="${n}"]`);
    band?.classList.add("on");
    const wrap = view.querySelector<HTMLElement>(".diff-strip-wrap")!;
    if (band) wrap.scrollLeft = Math.max(0, Number(band.getAttribute("x")) - wrap.clientWidth / 3);
    view.querySelector(`.seg-table tr[data-seg="${n}"]`)?.scrollIntoView({ block: "nearest" });
    panel.highlight([...s.a, ...s.b].map((u) => u.row_id));
  };
  view.querySelectorAll<HTMLElement>(".seg-table tr[data-seg]").forEach((tr) => {
    tr.addEventListener("click", () => run("selectDiffStretch", { index: Number(tr.dataset.seg) }));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run("selectDiffStretch", { index: Number(tr.dataset.seg) }); } });
  });
  svg.addEventListener("click", (e) => { const seg = (e.target as Element).getAttribute("data-seg"); if (seg) run("selectDiffStretch", { index: Number(seg) }); });
  if (panel.stretch != null && r.segments[panel.stretch]) pickSeg(panel.stretch);
}
