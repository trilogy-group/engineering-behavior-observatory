// EBO run monitor client: renders ebo.monitor-snapshot/0.1 frames from /events (SSE).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const usd = (v, d = 2) => (v == null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const int = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
const big = (v) => (v == null ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));
const dur = (ms) => {
  if (ms == null) return "—";
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const short = (m) => String(m ?? "").split("/").pop();

// Harness colors: the Atlas categorical slots in fixed order, assigned by first appearance in the campaign (probes,
// then attempts) and never cycled; a seventh harness falls back to the neutral slot.
const SLOTS = ["var(--cat-inspect)", "var(--cat-edit)", "var(--cat-read)", "var(--cat-vcs)", "var(--cat-shell)", "var(--cat-check)"];
let HARNESSES = [];
const hcolor = (h) => SLOTS[HARNESSES.indexOf(h)] ?? "var(--cat-other)";
const STATES = [["pending", "pending"], ["running", "running"], ["quiet", "running, no response > 2 min"], ["ok", "completed, qualified"], ["gaps", "completed, qualified with gaps"], ["failed", "failed or stopped"]];

function stateOf(a) {
  if (!a || a.state === "pending") return "pending";
  if (a.state === "running") return a.quiet ? "quiet" : "running";
  if (a.taskAssessment?.status === "failed") return "failed";
  if (a.spend?.budgetStopped || (a.exitCode != null && a.exitCode !== 0) || a.state === "failed" || a.state === "stopped" || (a.terminal && a.terminal.state !== "completed")) return "failed";
  if (a.qualification === "qualified") return "ok";
  if (a.qualification === "qualified-with-gaps") return "gaps";
  if (a.qualification === "unqualified") return "failed";
  return a.state === "failed" ? "failed" : "ok";
}
const stateLabel = (a) => a?.taskAssessment?.status === "failed" ? "task failure" : ({ pending: "pending", running: "running", quiet: "quiet", ok: a?.qualification ?? "done", gaps: "with gaps", failed: a?.terminal?.state ?? a?.state ?? "failed" })[stateOf(a)];

let snap = null, selected = null, lastFrame = 0;

// ---------- theme ----------
$("theme").addEventListener("click", () => {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  r.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("ebo-monitor-theme", r.dataset.theme); } catch {}
});

// ---------- connection ----------
function connect() {
  const es = new EventSource("events");
  es.onmessage = (e) => {
    snap = JSON.parse(e.data); lastFrame = Date.now();
    for (const a of [...snap.probes, ...snap.attempts]) if (!HARNESSES.includes(a.harness)) HARNESSES.push(a.harness);
    render();
  };
  es.onerror = () => { $("live-dot").dataset.live = "0"; };
}
setInterval(() => { if (snap) heartbeat(); }, 1000);
function heartbeat() {
  const age = Date.now() - lastFrame, dataAge = snap.lastWrite ? Date.now() - snap.lastWrite : null;
  const live = age < 6000;
  $("live-dot").dataset.live = live ? "1" : "0";
  $("updated").textContent = live ? `last activity ${dataAge == null ? "—" : dur(dataAge)} ago` : `monitor disconnected ${dur(age)}`;
  if (snap.deadline) { const left = snap.deadline - Date.now(); $("deadline").textContent = left > 0 ? dur(left) : "passed"; }
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = dur(Date.now() - Number(el.dataset.since));
}

// ---------- render ----------
function render() {
  const s = snap, c = s.config, t = s.totals;
  $("campaign").textContent = s.campaign;
  $("stage").textContent = s.stage ? `· ${s.stage}` : "";
  const runnerGone = s.state === "running" && s.pidAlive === false;
  const pill = $("state-pill");
  pill.textContent = runnerGone ? "runner not alive" : s.note ? `${s.state} · ${s.note}` : s.state;
  pill.dataset.state = runnerGone ? "offline" : s.state;
  $("format").textContent = s.format;

  // summary strip
  const atts = s.attempts;
  $("done").textContent = t.finished; $("planned").textContent = c.plannedAttempts;
  $("progress").innerHTML = atts.map((a) => `<i data-s="${stateOf(a)}" title="${esc(`${short(a.model)} · ${a.harness} #${a.replicate}: ${stateLabel(a)}`)}"></i>`).join("");
  $("progress-legend").textContent = `${t.running} running · ${t.pending} pending · concurrency ${t.running}/${c.maxConcurrent ?? "—"}`;
  $("charged").textContent = usd(t.chargedUsd);
  $("charged-sub").textContent = `+${usd(t.reservedUsd)} reserved in flight · probes ${usd(t.probeChargedUsd)}`;
  if (t.estimatedUsd) $("charged-sub").textContent += ` · ${usd(t.estimatedUsd)} estimated usage, not included`;
  if (c.currentCreditUsd != null || c.creditAtStartUsd != null) {
    const live = c.currentCreditUsd != null;
    const left = live ? c.currentCreditUsd : c.creditAtStartUsd - t.chargedUsd;
    $("credit-label").textContent = live ? "Account credit" : "Account credit (est.)";
    $("credit").textContent = usd(left);
    $("credit-bar").style.width = `${Math.max(0, Math.min(100, (left / Math.max(left, c.creditAtStartUsd ?? 0, 1)) * 100))}%`;
    const pendingBudget = atts.filter((a) => a.state === "pending" && a.budgetUsd).reduce((n, a) => n + a.budgetUsd, 0);
    const updated = c.creditUpdatedAt ? `Updated ${new Date(c.creditUpdatedAt).toLocaleTimeString()}` : "Update time unavailable";
    const stale = c.creditRefreshFailed === true || (c.creditUpdatedAt && Date.now() - c.creditUpdatedAt > 90000);
    // A live balance without a refresh timestamp or refresh result cannot be shown as current.
    const unknown = live && !stale && (c.creditUpdatedAt == null || c.creditRefreshFailed == null);
    const creditInfo = [live ? "Refreshes every 30s" : "Estimated from starting credit", ...(stale ? ["Stale; refresh unavailable"] : []), ...(unknown ? ["Refresh status unknown"] : []), ...(pendingBudget > left ? [`Below ${usd(pendingBudget, 0)} of pending budgets`] : [])].join(" · ");
    const creditSub = $("credit-sub");
    // Keep the focused trigger mounted across live snapshots.
    if (!creditSub.querySelector(".credit-info")) creditSub.innerHTML = `<span class="credit-time"></span> <span class="credit-info"><button type="button" aria-label="Account credit details" aria-describedby="credit-tooltip">ⓘ</button><span id="credit-tooltip" role="tooltip"></span></span>`;
    creditSub.querySelector(".credit-time").textContent = live ? updated : `of ${usd(c.creditAtStartUsd)} at start`;
    creditSub.querySelector("button").classList.toggle("warn", !!stale || unknown || pendingBudget > left);
    $("credit-tooltip").textContent = creditInfo;
  }
  $("deadline-sub").textContent = s.deadline ? `${new Date(s.deadline).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} · running ${dur(Date.now() - s.startedAt)}` : "";
  $("requests").textContent = int(t.requests);
  const tok = atts.reduce((o, a) => { if (a.tokens) { o.p += a.tokens.prompt; o.c += a.tokens.cached; o.o += a.tokens.completion; } return o; }, { p: 0, c: 0, o: 0 });
  $("requests-sub").textContent = `${big(tok.p)} prompt · ${tok.p ? Math.round((tok.c / tok.p) * 100) : 0}% cached · ${big(tok.o)} out`;

  renderMatrix(); renderRunning(); renderSpend(); renderProbes(); renderLog(); renderDetail();
  heartbeat();
}

function renderMatrix() {
  const atts = snap.attempts, models = [...new Set(atts.map((a) => a.model))];
  const reps = [...new Set(atts.map((a) => a.replicate))].sort((a, b) => a - b);
  let html = `<table class="mx"><thead><tr><th></th>${reps.map((r) => `<th>replicate ${r}</th>`).join("")}</tr></thead><tbody>`;
  for (const m of models) {
    html += `<tr><th class="model" colspan="${reps.length + 1}">${esc(m)}</th></tr>`;
    for (const h of [...new Set(atts.filter((a) => a.model === m).map((a) => a.harness))]) {
      html += `<tr><th><span class="sw" style="background:${hcolor(h)}"></span>${esc(h)}</th>`;
      for (const r of reps) {
        const a = atts.find((x) => x.model === m && x.harness === h && x.replicate === r);
        if (!a) { html += `<td class="muted">—</td>`; continue; }
        const st = stateOf(a);
        const meta = !a || st === "pending" ? (a?.budgetUsd ? `budget ${usd(a.budgetUsd, 0)}` : "no budget cap") : `${a.spend?.estimated ? "~" : ""}${usd(a.spend?.chargedUsd)} · ${dur(a.elapsedMs)}`;
        html += `<td><button type="button" data-s="${st}" ${a?.id ? `data-id="${esc(a.id)}"` : "disabled"} aria-pressed="${a?.id && a.id === selected}"><span class="st">${esc(stateLabel(a))}</span><span class="meta">${meta}</span></button></td>`;
      }
      html += "</tr>";
    }
  }
  $("matrix").innerHTML = html + "</tbody></table>";
  $("matrix-note").textContent = `${atts.length} planned`;
  $("state-legend").innerHTML = STATES.map(([k, l]) => `<li data-s="${k}"><i></i>${l}</li>`).join("");
}

function sparkline(points, color, { area = null, unit = "tokens" } = {}) {
  if (points.length < 2) return `<svg viewBox="0 0 200 54"><text x="0" y="30" fill="var(--text-muted)" font-size="11">waiting for requests</text></svg>`;
  const W = 200, H = 54, xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const step = niceStep((Math.max(...ys, ...(area ?? []).map((p) => p[1])) || 1) / 2), y1 = step * 2;
  const X = (x) => ((x - x0) / (x1 - x0 || 1)) * W, Y = (y) => 6 + (1 - y / y1) * (H - 12);
  const ticks = [y1, step, 0];
  const label = (v) => unit === "usd" ? usd(v, Math.max(2, Math.min(6, -Math.floor(Math.log10(step))))) : big(v);
  const axis = `<div class="spark-axis" aria-hidden="true">${ticks.map((v) => `<span>${label(v)}</span>`).join("")}</div>`;
  const grid = ticks.map((v) => `<line class="grid-line" x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" vector-effect="non-scaling-stroke"/>`).join("");
  const line = (ps) => ps.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const areaPath = area ? `<path d="${line(area)}L${X(area.at(-1)[0])},${Y(0)}L${X(area[0][0])},${Y(0)}Z" fill="color-mix(in srgb, ${color} 18%, transparent)"/>` : "";
  return `<div class="spark-chart">${axis}<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${unit === "usd" ? "Cumulative cost in dollars" : "Context and cached tokens"}, scale 0 to ${esc(label(y1))}">${grid}${areaPath}<path d="${line(points)}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg></div>`;
}

function renderRunning() {
  const running = snap.attempts.filter((a) => a.state === "running");
  $("running-note").textContent = `${running.length} of ${snap.config.maxConcurrent ?? "—"} slots`;
  if (!running.length) { $("running").innerHTML = `<p class="empty">Nothing running.</p>`; return; }
  $("running").innerHTML = running.map((a) => {
    const st = stateOf(a), color = hcolor(a.harness);
    const wall = a.maxWallClockMs ? a.elapsedMs / a.maxWallClockMs : null;
    const budget = a.budgetUsd ? (a.spend?.chargedUsd ?? 0) / a.budgetUsd : null;
    const req = a.requests;
    const ctx = req.map((r) => [r[0], r[2] ?? 0]), cached = req.map((r) => [r[0], r[4] ?? 0]);
    let cum = 0; const cost = req.map((r) => [r[0], (cum += r[5] ?? 0)]);
    const last = a.spend?.lastResponseAt;
    return `<article class="run" data-id="${esc(a.id)}" tabindex="0" aria-label="${esc(a.id)}">
      <div class="run-h"><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color}"></span><b>${esc(a.harness)}</b><span class="muted">${esc(short(a.model))} · #${a.replicate}</span><span class="id">${esc(a.id)}</span>
        <span class="badge" data-s="${st}">${st === "quiet" ? "quiet" : "live"} · last response <span data-since="${last ?? ""}">${last ? dur(Date.now() - last) : "—"}</span> ago</span></div>
      <div class="bars">
        <div class="bar-row"><div class="lbl"><span>Wall clock</span><span>${dur(a.elapsedMs)} / ${dur(a.maxWallClockMs)}</span></div><div class="meter"><i style="width:${Math.min(100, (wall ?? 0) * 100)}%" class="${wall > 0.85 ? "hot" : ""}"></i></div></div>
        <div class="bar-row"><div class="lbl"><span>Spend</span><span>${usd(a.spend?.chargedUsd)}${a.budgetUsd ? ` / ${usd(a.budgetUsd, 0)}` : " · no cap"}</span></div><div class="meter"><i style="width:${budget == null ? 0 : Math.min(100, budget * 100)}%" class="${budget > 0.85 ? "hot" : ""}"></i></div></div>
      </div>
      <div class="facts"><span><b>${int(a.spend?.requests)}</b> requests</span><span><b>${a.native.toolCalls ?? "n/a"}</b> tool calls</span><span><b>${int(a.native.lines)}</b> native records</span><span><b>${big(a.tokens.prompt)}</b> prompt tokens, ${a.tokens.prompt ? Math.round((a.tokens.cached / a.tokens.prompt) * 100) : 0}% cached</span>${a.spend?.accountingErrors ? `<span class="warn">${a.spend.accountingErrors} accounting errors</span>` : ""}</div>
      <div class="spark">
        <figure><figcaption>Context per request (prompt tokens, cached shaded) · last ${big(ctx.at(-1)?.[1])}</figcaption>${sparkline(ctx, color, { area: cached })}</figure>
        <figure><figcaption>Cumulative cost · ${usd(cost.at(-1)?.[1] ?? 0)}</figcaption>${sparkline(cost, color, { unit: "usd" })}</figure>
      </div>
    </article>`;
  }).join("");
}

function renderSpend() {
  const series = [...snap.attempts.filter((a) => a.requests?.length)];
  const el = $("spend-chart");
  // Color encodes harness, line pattern encodes model (fixed order from the campaign's model list).
  const models = snap.config.models ?? [...new Set(snap.attempts.map((a) => a.model))];
  const swatch = (dash) => `<svg width="26" height="10" aria-hidden="true" style="vertical-align:-1px;margin-right:5px"><line x1="1" x2="25" y1="5" y2="5" stroke="var(--text-secondary)" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ""}/></svg>`;
  $("harness-legend").innerHTML = `<li class="muted">Harness</li>` + HARNESSES.map((h) => `<li><i style="--c:${hcolor(h)}"></i>${esc(h)}</li>`).join("") +
    `<li class="muted legend-gap">Model</li>` + models.map((m, i) => `<li>${swatch(DASHES[i % DASHES.length])}${esc(m)}</li>`).join("");
  if (!series.length) { el.innerHTML = `<p class="empty">No model requests yet.</p>`; return; }
  const W = el.clientWidth || 900, H = 240, L = 48, R = 12, T = 8, B = 22;
  const t0 = snap.startedAt ?? Math.min(...series.map((a) => a.requests[0][1])), t1 = Math.max(Date.now(), t0 + 60_000);
  const lines = series.map((a) => { let c = 0; return { a, pts: [[a.startedAt ?? a.requests[0][1], 0], ...a.requests.map((r) => [r[1], (c += r[5] ?? 0)])] }; });
  const ymax = Math.max(1, ...lines.map((l) => l.pts.at(-1)[1])) * 1.1;
  const X = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R), Y = (v) => T + (1 - v / ymax) * (H - T - B);
  const step = niceStep(ymax / 4);
  let g = "";
  for (let v = 0; v <= ymax; v += step) g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${usd(v, v < 10 ? 2 : 0)}</text>`;
  const tstep = niceTime((t1 - t0) / 6);
  for (let t = Math.ceil(t0 / tstep) * tstep; t <= t1; t += tstep) g += `<text x="${X(t)}" y="${H - 6}" text-anchor="middle">${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>`;
  const paths = lines.map(({ a, pts }) => {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("") + (a.state === "running" ? `L${X(Date.now()).toFixed(1)},${Y(pts.at(-1)[1]).toFixed(1)}` : "");
    const end = pts.at(-1);
    return `<path d="${d}" fill="none" stroke="${hcolor(a.harness)}" stroke-width="2" ${dashFor(a.model) ? `stroke-dasharray="${dashFor(a.model)}"` : ""} data-id="${esc(a.id)}"/>` +
      `<text x="${Math.min(X(a.state === "running" ? Date.now() : end[0]) + 4, W - R)}" y="${Y(end[1]) - 4}" text-anchor="end" style="fill:var(--text-secondary)">${esc(`${a.harness} · ${short(a.model)} #${a.replicate} ${usd(end[1])}`)}</text>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative charged dollars per attempt over time">${g}<line class="axis-line" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>${paths}</svg>`;
}
const DASHES = ["", "6 4", "2 3", "10 3 2 3"];
const dashFor = (m) => { const ms = snap.config.models ?? []; const i = ms.indexOf(m); return DASHES[(i < 0 ? 0 : i) % DASHES.length]; };
const niceStep = (x) => { const p = 10 ** Math.floor(Math.log10(x || 1)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= x) ?? p * 10; };
const niceTime = (ms) => [60e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3].find((s) => s >= ms) ?? 21600e3;

function renderProbes() {
  const ps = snap.probes;
  const passed = ps.filter((p) => p.passed).length;
  $("probes-note").textContent = `${passed}/${ps.length} passed · ${usd(snap.totals.probeChargedUsd)}`;
  $("probes").innerHTML = `<thead><tr><th>Harness</th><th>Model</th><th>Capture</th><th class="n">Cost</th><th class="n">Requests</th><th class="n">Tool calls</th><th class="n">Time</th></tr></thead><tbody>` +
    ps.map((p) => `<tr data-id="${esc(p.id)}"><td><span class="sw" style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${hcolor(p.harness)}"></span>${esc(p.harness)}</td><td>${esc(short(p.model))}</td><td><span class="q" data-s="${stateOf(p)}">${esc(p.qualification ?? p.state)}</span></td><td class="n">${usd(p.spend?.chargedUsd, 3)}</td><td class="n">${int(p.spend?.requests)}</td><td class="n">${p.native.toolCalls ?? "n/a"}</td><td class="n">${dur(p.elapsedMs)}</td></tr>`).join("") + "</tbody>";
}

function renderLog() {
  const items = [...snap.transitions].reverse();
  const started = [...snap.attempts, ...snap.probes].filter((a) => a.startedAt).sort((a, b) => b.startedAt - a.startedAt).slice(0, 12)
    .map((a) => ({ at: a.endedAt ?? a.startedAt, text: `<code>${esc(a.id)}</code> ${a.endedAt ? `ended: ${esc(stateLabel(a))}` : "started"}` }));
  const rows = items.length ? items.map((x) => ({ at: x.at, text: `<code>${esc(x.id)}</code> ${esc(x.from)} → <b>${esc(x.to)}</b>` })) : started;
  $("log").innerHTML = rows.map((r) => `<li><time>${clock(r.at)}</time><span>${r.text}</span></li>`).join("") || `<li><span class="muted">No activity yet.</span></li>`;
}

function renderDetail() {
  const a = [...snap.attempts, ...snap.probes].find((x) => x.id && x.id === selected) ?? snap.attempts.find((x) => x.state === "running");
  if (!a) { $("detail").innerHTML = `<p class="empty">Select an attempt.</p>`; return; }
  $("detail-note").textContent = a.id === selected ? "selected" : "first running attempt";
  const rows = [
    ["Attempt", `<code>${esc(a.id)}</code>`], ["Harness · model", `${esc(a.harness)} · ${esc(a.model)} · ${esc(a.api)}`],
    ["State", `<span class="q" data-s="${stateOf(a)}">${esc(stateLabel(a))}</span>${a.terminal ? ` · terminal ${esc(a.terminal.state)}, failure ${esc(a.terminal.failureClass)}` : ""}`],
    ...(a.taskAssessment ? [["Task assessment", `${esc(a.taskAssessment.status)} · ${esc(a.taskAssessment.reasonCode)}: ${esc(a.taskAssessment.reason)}`]] : []),
    ["Started", a.startedAt ? `${clock(a.startedAt)} · ${dur(a.elapsedMs)}${a.maxWallClockMs ? ` of ${dur(a.maxWallClockMs)}` : ""}` : "—"],
    [a.spend?.estimated ? "Estimated" : "Charged", `${usd(a.spend?.chargedUsd, 4)}${a.spend?.reservedUsd ? ` + ${usd(a.spend.reservedUsd)} reserved` : ""}${a.budgetUsd ? ` · budget ${usd(a.budgetUsd, 0)}` : " · no budget cap"}${a.spend?.budgetStopped ? ' · <span class="warn">budget stop</span>' : ""}`],
    ["Requests", `${int(a.spend?.requests)} · last response ${a.spend?.lastResponseAt ? clock(a.spend.lastResponseAt) : "—"}`],
    ["Tokens", `${big(a.tokens?.prompt)} prompt (${big(a.tokens?.cached)} cached) · ${big(a.tokens?.completion)} completion · ${big(a.tokens?.reasoning)} reasoning`],
    ["Capture", `${esc(a.qualification ?? "not qualified yet")}${a.captureState ? ` · live state ${esc(a.captureState)}` : ""}`],
    ["Native records", `${int(a.native?.lines)} · ${a.native?.toolCalls ?? "n/a"} tool calls`],
    ["Directory", a.directory ? `<code>${esc(a.directory)}</code>` : "—"],
  ];
  const types = a.native?.types ?? [], tmax = Math.max(1, ...types.map((t) => t[1]));
  $("detail").innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` +
    (types.length ? `<div class="types"><h3>Native event types (names only)</h3>${types.map(([t, n]) => `<div class="type-row"><code>${esc(t)}</code><div class="b" style="width:${(n / tmax) * 100}%"></div><span class="n">${int(n)}</span></div>`).join("")}</div>` : "");
}

// selection
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-id]");
  if (!el || !snap) return;
  selected = el.dataset.id; renderMatrix(); renderDetail();
  if (matchMedia("(max-width: 1000px)").matches) $("detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches?.(".run")) e.target.click(); });
addEventListener("resize", () => snap && renderSpend());
connect();
