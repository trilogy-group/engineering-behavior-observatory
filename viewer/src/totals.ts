// Totals view of the swimlanes panel: for the chosen task, (1) all-arm totals by action category and by tool name with
// per-attempt means and ranges, and (2) what happens in the N actions after an anchor (compaction or failed call)
// compared with the rest of each attempt. Exploratory: computed in the browser over the unit table.
import { CATS, esc, type LaneMeta, type Unit } from "./lanes";
import type { Evidence } from "./p3";
import { run, target } from "./registry";

export interface TotalsState { anchor: "compaction" | "failure"; n: number }

// lanes.ts imports this module, so CATS is read lazily (not at module load)
const rows = () => [...CATS.map((c) => ({ key: c.key as string, label: c.label })), { key: "compaction", label: "compaction" }];
const pct = (x: number) => (x * 100).toFixed(0) + "%";
const isAction = (u: Unit) => u.unit_kind === "tool" || u.unit_kind === "compaction";
const catOf = (u: Unit) => (u.unit_kind === "compaction" ? "compaction" : u.cat);

function stats(xs: number[]) {
  const n = xs.length, sum = xs.reduce((a, b) => a + b, 0);
  return { sum, mean: n ? sum / n : 0, min: n ? Math.min(...xs) : 0, max: n ? Math.max(...xs) : 0 };
}

/** Actions within `n` after each anchor (deduplicated), per attempt. */
function windows(actions: Unit[], anchor: TotalsState["anchor"], n: number) {
  const post = new Set<number>(); let anchors = 0;
  actions.forEach((u, i) => {
    const hit = anchor === "compaction" ? u.unit_kind === "compaction" : u.unit_kind === "tool" && u.status === "error";
    if (!hit) return;
    anchors++;
    for (let j = i + 1; j <= Math.min(actions.length - 1, i + n); j++) if (actions[j].unit_kind === "tool") post.add(actions[j].row_id);
  });
  return { post, anchors };
}

export function renderTotals(view: HTMLElement, task: string, lanes: LaneMeta[], byLane: Map<string, Unit[]>, st: TotalsState,
                             onHighlight: (rows: number[] | null) => void, ev: Evidence | null = null) {
  const arms = [...new Set(lanes.map((l) => l.condition))].sort();
  const lanesOf = (arm: string) => lanes.filter((l) => l.condition === arm);
  const acts = (id: string) => (byLane.get(id) ?? []).filter(isAction);

  // (1) totals by category and by tool
  const catCount = (id: string, key: string) => acts(id).filter((u) => catOf(u) === key).length;
  const cell = (xs: number[]) => { const s = stats(xs); return `<td class="num"><b>${s.sum.toLocaleString()}</b><span class="meta">${s.mean.toFixed(0)} / attempt · ${s.min}–${s.max}</span></td>`; };
  const toolNames = [...new Set(lanes.flatMap((l) => acts(l.attempt_id).filter((u) => u.unit_kind === "tool").map((u) => u.tool_name ?? "tool")))];
  const toolTotal = (name: string) => lanes.reduce((a, l) => a + acts(l.attempt_id).filter((u) => u.tool_name === name).length, 0);
  toolNames.sort((a, b) => toolTotal(b) - toolTotal(a));
  const tbl1 = `<table class="grid tot"><thead><tr><th>Action category</th>${arms.map((a) => `<th class="num">${esc(a)}<span class="meta">${lanesOf(a).length} attempts</span></th>`).join("")}</tr></thead><tbody>
    ${rows().map((r) => `<tr><th scope="row"><span class="sw cat-${r.key === "compaction" ? "comp" : r.key}"></span> ${esc(r.label)}</th>${arms.map((a) => cell(lanesOf(a).map((l) => catCount(l.attempt_id, r.key)))).join("")}</tr>`).join("")}
    <tr class="sum"><th scope="row">all actions</th>${arms.map((a) => cell(lanesOf(a).map((l) => acts(l.attempt_id).length))).join("")}</tr>
    <tr><th scope="row">failed tool calls</th>${arms.map((a) => cell(lanesOf(a).map((l) => acts(l.attempt_id).filter((u) => u.status === "error").length))).join("")}</tr>
    </tbody></table>`;
  const tbl2 = `<table class="grid tot"><thead><tr><th>Tool (native name)</th>${arms.map((a) => `<th class="num">${esc(a)}</th>`).join("")}</tr></thead><tbody>
    ${toolNames.slice(0, 12).map((t) => `<tr><th scope="row" class="mono">${esc(t)}</th>${arms.map((a) => cell(lanesOf(a).map((l) => acts(l.attempt_id).filter((u) => u.tool_name === t).length))).join("")}</tr>`).join("")}
    </tbody></table>`;

  // (2) after-anchor windows vs the rest
  const keys = CATS.map((c) => c.key as string);
  const winRows = arms.map((a) => {
    let post: Unit[] = [], rest: Unit[] = [], anchors = 0;
    const per = lanesOf(a).map((l) => {
      const A = acts(l.attempt_id), w = windows(A, st.anchor, st.n);
      anchors += w.anchors;
      const tools = A.filter((u) => u.unit_kind === "tool");
      const p = tools.filter((u) => w.post.has(u.row_id)), r = tools.filter((u) => !w.post.has(u.row_id));
      post = post.concat(p); rest = rest.concat(r);
      return { l, anchors: w.anchors, p, r };
    });
    return { a, anchors, post, rest, per };
  });
  const share = (us: Unit[], k: string) => (us.length ? us.filter((u) => u.cat === k).length / us.length : NaN);
  const dcell = (p: Unit[], r: Unit[], k: string) => {
    const sp = share(p, k), sr = share(r, k);
    if (!p.length || Number.isNaN(sp)) return `<td class="num muted">—</td>`;
    const d = (sp - sr) * 100, w = Math.min(40, Math.abs(d) * 1.2);
    return `<td class="num" title="${esc(k)}: ${pct(sp)} in windows vs ${pct(sr)} elsewhere">${pct(sp)} <span class="muted">vs ${pct(sr)}</span>
      <span class="dbar"><span class="${d >= 0 ? "pos" : "neg"}" style="width:${w.toFixed(0)}px"></span> ${d >= 0 ? "+" : ""}${d.toFixed(0)} pp</span></td>`;
  };
  const tbl3 = `<table class="grid tot win"><thead><tr><th>Arm / attempt</th><th class="num">Anchors</th><th class="num">Tool calls in windows / elsewhere</th>${keys.map((k) => `<th class="num"><span class="sw cat-${k}"></span> ${esc(k)}</th>`).join("")}</tr></thead><tbody>
    ${winRows.map((w) => `<tr class="arm-row" data-arm="${esc(w.a)}" ${target("highlightRows", `window:${w.a}`)} tabindex="0"><th scope="row">${esc(w.a)}</th><td class="num">${w.anchors}</td><td class="num">${w.post.length} / ${w.rest.length}</td>${keys.map((k) => dcell(w.post, w.rest, k)).join("")}</tr>
      ${w.per.map((x) => `<tr class="att-row" data-att="${esc(x.l.attempt_id)}" ${target("highlightRows", `window:${x.l.attempt_id}`)} tabindex="0"><td class="indent">trial ${esc(x.l.trial_id)} <span class="mono muted">${esc(x.l.attempt_id.slice(0, 8))}</span></td><td class="num">${x.anchors}</td><td class="num">${x.p.length} / ${x.r.length}</td>${keys.map((k) => dcell(x.p, x.r, k)).join("")}</tr>`).join("")}`).join("")}
    </tbody></table>`;

  // (3) failures by tool and error signature, across arms (same signature, different models)
  const sigOf = (u: Unit) => `${u.tool_name ?? "tool"} · ${((u.error_signature ?? "").split("\n")[0].trim().slice(0, 70)) || "failed (no message)"}`;
  const fails = lanes.flatMap((l) => acts(l.attempt_id).filter((u) => u.unit_kind === "tool" && u.status === "error"));
  const sigs = [...new Set(fails.map(sigOf))].sort((a, b) => fails.filter((u) => sigOf(u) === b).length - fails.filter((u) => sigOf(u) === a).length);
  const failCell = (arm: string, sig: string) => {
    const us = fails.filter((u) => u.condition === arm && sigOf(u) === sig);
    const k = new Set(us.map((u) => u.attempt_id)).size;
    return us.length ? `<td class="num fail-cell" data-arm="${esc(arm)}" data-sig="${esc(sig)}" ${target("openFailureGroup", `${arm}|${sig}`)} tabindex="0" title="Click: the failure chains with this error"><b>${us.length}</b><span class="meta">${k} of ${lanesOf(arm).length} attempts</span></td>` : `<td class="num muted">0</td>`;
  };
  const tbl4 = `<table class="grid tot"><thead><tr><th>Tool · error (first line)</th>${arms.map((a) => `<th class="num">${esc(a)}</th>`).join("")}</tr></thead><tbody>
    ${sigs.slice(0, 15).map((g) => `<tr><th scope="row" class="mono small">${esc(g)}</th>${arms.map((a) => failCell(a, g)).join("")}</tr>`).join("")}
    </tbody></table>${sigs.length > 15 ? `<p class="muted small">${sigs.length - 15} rarer signatures not shown.</p>` : ""}`;

  // (4) recording grain: native records -> mapped events (by type) -> units -> tool calls; usage coverage
  const meta = (id: string) => ev?.meta.get(id);
  const mean = (xs: (number | null | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const fmt = (x: number | null) => (x == null ? "—" : x.toLocaleString());
  const topTypes = (arm: string) => {
    const tot = new Map<string, number>();
    for (const l of lanesOf(arm)) for (const [k, v] of Object.entries(meta(l.attempt_id)?.event_types ?? {})) tot.set(k, (tot.get(k) ?? 0) + v);
    const n = lanesOf(arm).length || 1;
    return [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${Math.round(v / n).toLocaleString()}`).join("<br>");
  };
  const usage = (arm: string) => {
    const ls = lanesOf(arm), withU = ls.filter((l) => l.usage_semantics !== "none");
    return `${withU.length} of ${ls.length} attempts${withU.length ? ` · ${esc([...new Set(withU.map((l) => l.usage_semantics))].join(", "))}` : ""}${withU.length < ls.length ? ` · <span class="no-usage">${ls.length - withU.length} with no usage recorded (not zero)</span>` : ""}`;
  };
  const tbl5 = ev ? `<table class="grid tot"><thead><tr><th>Per attempt (mean)</th>${arms.map((a) => `<th class="num">${esc(a)}</th>`).join("")}</tr></thead><tbody>
    <tr><th scope="row">native records written by the harness</th>${arms.map((a) => `<td class="num">${fmt(mean(lanesOf(a).map((l) => meta(l.attempt_id)?.native_record_count)))}</td>`).join("")}</tr>
    <tr><th scope="row">… of which not mapped to events</th>${arms.map((a) => `<td class="num">${fmt(mean(lanesOf(a).map((l) => meta(l.attempt_id)?.unmapped_record_count)))}</td>`).join("")}</tr>
    <tr><th scope="row">normalized events</th>${arms.map((a) => `<td class="num">${fmt(mean(lanesOf(a).map((l) => meta(l.attempt_id)?.event_count)))}</td>`).join("")}</tr>
    <tr><th scope="row">largest event types</th>${arms.map((a) => `<td class="num small">${topTypes(a)}</td>`).join("")}</tr>
    <tr><th scope="row">behavior units (no episodes)</th>${arms.map((a) => `<td class="num">${fmt(mean(lanesOf(a).map((l) => meta(l.attempt_id)?.units)))}</td>`).join("")}</tr>
    <tr class="sum"><th scope="row">tool calls (logical operations)</th>${arms.map((a) => `<td class="num"><b>${fmt(mean(lanesOf(a).map((l) => meta(l.attempt_id)?.tool_calls)))}</b></td>`).join("")}</tr>
    <tr><th scope="row">token usage recorded</th>${arms.map((a) => `<td class="num small">${usage(a)}</td>`).join("")}</tr>
    </tbody></table>` : `<p class="muted">No attempt metadata (run p3/build.py).</p>`;

  view.innerHTML = `<div class="totals">
    <p class="legend">All arms on <b>${esc(task)}</b>, every attempt (the arm filter and cloud selection do not apply). Each cell: total over the arm's attempts, then mean per attempt and the range across attempts. Actions = tool calls + compactions; categories as in the lane legend (shell commands that write source files count as edit / write). Exploratory.</p>
    <div class="tot-grid"><div><h3>By action category</h3>${tbl1}</div><div><h3>By tool</h3>${tbl2}</div></div>
    <h3>Failures by tool and error</h3>
    <p class="legend">Failed tool calls grouped by tool and the first line of the error (paths and numbers masked), per arm: count, then attempts with at least one. Click a count for those failure chains: the failed call next to the next call of the same tool, arguments and results from the native records.</p>
    ${fails.length ? tbl4 : `<p class="empty">No failed tool calls on this task.</p>`}
    <h3>Recording grain: native records → events → units → tool calls</h3>
    <p class="legend">How much each harness writes per attempt, and what is left after normalization: native records (lines the harness logged, including streaming chunks and progress updates), the normalized events EBO maps them to (largest types shown), behavior units, and tool calls (one per logical operation). Compare activity on the tool-call row, not on raw records. Token usage: attempts with recorded usage; "no usage recorded" means not measured, not zero.</p>
    ${tbl5}
    <h3>What happens after
      <select data-anchor ${target("setTotalsAnchor")}><option value="compaction" ${st.anchor === "compaction" ? "selected" : ""}>each compaction</option><option value="failure" ${st.anchor === "failure" ? "selected" : ""}>each failed tool call</option></select>
      — the next <select data-n ${target("setTotalsWindow")}>${[5, 10, 20, 50].map((n) => `<option ${n === st.n ? "selected" : ""}>${n}</option>`).join("")}</select> actions vs the rest of the attempt</h3>
    <p class="legend">Share of tool calls in each category inside the windows vs elsewhere in the same attempts; bars show the difference in percentage points (blue = more in the windows, red = fewer). Overlapping windows are counted once. Attempts without anchors have no windows. Click an arm or attempt row to highlight its window tool calls in the cloud.</p>
    ${winRows.every((w) => !w.anchors) ? `<p class="empty">No ${st.anchor === "compaction" ? "compactions" : "failed tool calls"} on this task.</p>` : tbl3}
  </div>`;
  view.querySelector<HTMLSelectElement>("[data-anchor]")!.addEventListener("change", (e) => run("setTotalsAnchor", { anchor: (e.target as HTMLSelectElement).value }));
  view.querySelector<HTMLSelectElement>("[data-n]")!.addEventListener("change", (e) => run("setTotalsWindow", { n: Number((e.target as HTMLSelectElement).value) }));
  view.querySelectorAll<HTMLElement>("td.fail-cell").forEach((td) => {
    const act = () => {
      const us = fails.filter((u) => u.condition === td.dataset.arm && sigOf(u) === td.dataset.sig);
      onHighlight(us.map((u) => u.row_id));
      run("openFailureGroup", { title: `${td.dataset.arm} · ${td.dataset.sig}`, items: us.map((u) => ({ attemptId: u.attempt_id, row: u.row_id })) });
    };
    td.addEventListener("click", act);
    td.addEventListener("keydown", (e) => { if (e.key === "Enter") act(); });
  });
  view.querySelectorAll<HTMLElement>("tr.arm-row, tr.att-row").forEach((tr) => {
    const act = () => {
      const w = winRows.find((x) => x.a === tr.dataset.arm) ?? null;
      const rows = w ? w.post.map((u) => u.row_id) : winRows.flatMap((x) => x.per).find((x) => x.l.attempt_id === tr.dataset.att)?.p.map((u) => u.row_id) ?? [];
      view.querySelectorAll("tr.on").forEach((x) => x.classList.remove("on")); tr.classList.add("on");
      run("highlightRows", { rows: rows.length ? rows : null });
    };
    tr.addEventListener("click", act);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") act(); });
  });
}
