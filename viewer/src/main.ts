// EBO Atlas viewer: Embedding Atlas + EBO panels on one Mosaic coordinator over DuckDB-WASM.
// Data: one Atlas bundle (ebo.atlas-bundle/v1) at ?bundle=<url> (default ./bundle/, as `ebo atlas serve` and packets
// lay it out). Other parameters: labels=facet|auto, color=<column>|none, panel=<tab>.
// Everything that changes on screen goes through the command registry (registry.ts); the state serializes to the URL.
import "./tokens.css";
import "./style.css";
import * as duckdb from "@duckdb/duckdb-wasm";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import { Coordinator, wasmConnector } from "@uwdata/mosaic-core";
import { EmbeddingAtlas } from "embedding-atlas";
import { ClusterArmPanel, rowsOf } from "./enrichment";
import { SwimlanesPanel, type LanesData } from "./lanes";
import { STOP_WORDS } from "./stopwords";
import { ClaimsPanel, Drawer, Evidence, MatrixPanel, type AssessDoc, type AuditDoc, type ClaimsDoc, type DrawerView } from "./p3";
import { FiguresPanel, type ViewsDoc } from "./views";
import { tableFromJSON, tableToIPC } from "apache-arrow";
import {
  decodeState, describable, describe, encodeState, getState, listCommands, provide, register, run, setState, subscribe, target,
  type CommandEvent, type Json,
} from "./registry";

const params = new URLSearchParams(location.search);
const bundleUrl = new URL(params.get("bundle") ?? "./bundle/", location.href).href.replace(/\/?$/, "/");
const labelMode = params.get("labels") ?? "facet";
const colorBy = params.get("color") ?? "condition"; // any column name; "none" for uncolored points
const TABS = ["clusters", "lanes", "assessments", "claims", "figures"] as const;
type Tab = (typeof TABS)[number];
const initialPanel = (TABS as readonly string[]).includes(params.get("panel") ?? "") ? params.get("panel") as Tab : "clusters";

const statusEl = document.getElementById("status")!;
const status = (msg: string, error = false) => {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", error);
};
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
const file = (name: string) => new URL(name, bundleUrl).href;
const getJson = async <T,>(name: string): Promise<T | null> => { try { const r = await fetch(file(name)); return r.ok ? await r.json() : null; } catch { return null; } };

/** The exception-handling DuckDB-WASM build only: every browser with WebGPU (which the cloud needs) supports it. */
async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  const worker = new Worker(ehWorker, { type: "module" });
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(ehWasm);
  return db;
}

interface BundleManifest { schemaVersion?: string; title?: string; study?: { id?: string; title?: string } }

async function main() {
  const manifest = await getJson<BundleManifest>("manifest.json");
  const title = manifest?.title ?? manifest?.study?.title ?? "Atlas bundle";
  document.getElementById("bundle-title")!.textContent = title;
  document.title = `${title} · EBO Atlas`;

  status("Starting DuckDB…");
  const db = await initDuckDB();
  const coordinator = new Coordinator(wasmConnector({ duckdb: db }));

  status("Loading units…");
  // Arrow IPC needs no DuckDB extensions, so the viewer also works offline and from packets opened on disk.
  const resp = await fetch(file("units.arrow"));
  if (!resp.ok) throw new Error(`units.arrow not found in the bundle at ${bundleUrl}`);
  const conn = await db.connect();
  await conn.insertArrowFromIPCStream(new Uint8Array(await resp.arrayBuffer()), { name: "units", create: true });
  await conn.close();

  // Embedding Atlas labels are { x, y, content, level, priority }; labels.json stores the text as `text`.
  let labels: { x: number; y: number; content: string; level?: number; priority?: number }[] | null = null;
  if (labelMode === "facet") {
    const raw = await getJson<{ x: number; y: number; text?: string; content?: string; level?: number; priority?: number }[]>("labels.json");
    labels = raw?.length ? raw.map((l) => ({ x: l.x, y: l.y, content: (l.content ?? l.text ?? "").replace(/`/g, ""), level: l.level ?? 0, priority: l.priority ?? 0 })) : null;
  }
  const n = rowsOf(await coordinator.query(`SELECT count(*) AS n FROM units`))[0].n;
  status(`${Number(n).toLocaleString()} units${labels ? " · facet labels" : " · auto labels"}`);

  // bottom panel: tabs over the shared table
  const host = document.getElementById("panel")!;
  const tabLabels: Record<Tab, string> = { clusters: "Clusters × arm", lanes: "Swimlanes", assessments: "Assessments", claims: "Claims", figures: "Figures" };
  host.innerHTML = `
    <div class="tabs" role="tablist" aria-label="Panels">
      ${TABS.map((t) => `<button role="tab" id="tab-${t}" data-tab="${t}" ${target("openTab", t)} aria-controls="body-${t}">${tabLabels[t]}</button>`).join("")}
      <button class="focus-btn" data-focus ${target("setPanelFocus")} title="Reading mode: shrink the cloud so the panel gets the window">Expand panel</button>
    </div>
    ${TABS.map((t) => `<div class="tab-body" id="body-${t}" role="tabpanel" aria-labelledby="tab-${t}"></div>`).join("")}`;
  const highlight = (ids: number[] | null) => atlas.update({ highlight: ids });
  const lanesData = await getJson<LanesData>("lanes.json");
  const [assessDoc, auditDoc, claimsDoc, viewsDoc] = await Promise.all([
    getJson<AssessDoc>("assessments.json"), getJson<AuditDoc>("audit.json"), getJson<ClaimsDoc>("claims.json"), getJson<ViewsDoc>("views.json")]);
  if (assessDoc) {
    // the `assessments` host table view specs may query
    const rows = assessDoc.assessments.map((x) => ({ id: x.id, attempt_id: x.attempt_id, condition: x.condition, task_id: x.task_id, trial_id: x.trial_id,
      dimension: x.dimension, outcome: x.outcome, confidence: x.confidence ?? null, citations: x.citations.length,
      in_primary: Boolean(x.cohorts?.primary && x.cohorts.primary.included !== false) }));
    const c2 = await db.connect();
    // IPC bytes, not a Table object: DuckDB-WASM bundles its own apache-arrow
    await c2.insertArrowFromIPCStream(tableToIPC(tableFromJSON(rows), "stream"), { name: "assessments", create: true });
    await c2.close();
  }

  let tab: Tab = "clusters";
  const lanes = lanesData ? new SwimlanesPanel(document.getElementById("body-lanes")!, coordinator, lanesData, highlight) : null;
  if (!lanes) document.getElementById("body-lanes")!.innerHTML = `<p class="empty pad">This bundle has no swimlane data (lanes.json).</p>`;
  let lanesLoaded = false;
  const drawer = new Drawer();
  const ev = assessDoc ? new Evidence(bundleUrl.replace(/\/$/, ""), assessDoc, auditDoc, drawer, {
    highlight: (rows) => highlight(rows),
    showInLanes: (attemptId, row) => { run("focusAttempt", { attemptId, row: row ?? null }); },
  }) : null;
  if (lanes) lanes.ev = ev;
  if (ev) new MatrixPanel(document.getElementById("body-assessments")!, ev);
  else document.getElementById("body-assessments")!.innerHTML = `<p class="empty pad">This bundle has no assessments (assessments.json).</p>`;
  const claimsPanel = ev ? new ClaimsPanel(document.getElementById("body-claims")!, claimsDoc, ev) : null;
  if (!ev) document.getElementById("body-claims")!.innerHTML = `<p class="empty pad">This bundle has no claims.</p>`;
  const figures = viewsDoc?.views.length ? new FiguresPanel(document.getElementById("body-figures")!, coordinator, viewsDoc, claimsDoc) : null;
  if (!figures) {
    document.getElementById("body-figures")!.innerHTML = `<p class="empty pad">This bundle has no view specs (views.json).</p>`;
    describable("figures", { describe: () => ({ summary: "This bundle has no view specs.", data: { views: [] } }) });
  }
  if (!lanes) describable("lanes", { describe: () => ({ summary: "This bundle has no swimlane data.", data: { lanes: [] } }) });
  if (!ev) for (const key of ["assessments", "claims", "drawer"]) describable(key, { describe: () => ({ summary: "This bundle has no assessments.", data: null }) });

  const showTab = async (name: Tab) => {
    tab = name;
    host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => { const on = b.dataset.tab === name; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; });
    host.querySelectorAll<HTMLElement>(".tab-body").forEach((d) => (d.hidden = d.id !== `body-${name}`));
    if (name === "figures") await figures?.render();
    if (name === "lanes" && lanes && !lanesLoaded) { lanesLoaded = true; await lanes.load(); }
    else if (name === "lanes" && lanes) lanes.render();
  };
  const layout = document.querySelector(".layout")!;
  const focusButton = host.querySelector<HTMLButtonElement>("[data-focus]")!;
  const setPanelFocus = (on: boolean) => {
    layout.classList.toggle("focus-panel", on);
    focusButton.textContent = on ? "Show cloud" : "Expand panel";
  };

  // ---- shell commands ----
  const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", required, properties, additionalProperties: false });
  register<{ tab: Tab }>({ name: "openTab", description: "Open a panel tab.", args: obj({ tab: { enum: [...TABS] } }),
    run: async ({ tab: t }) => { await showTab(t); return `Opened the ${tabLabels[t]} tab.`; } });
  register<{ on: boolean }>({ name: "setPanelFocus", description: "Reading mode: give the panel the window (on) or show the cloud (off).", args: obj({ on: { type: "boolean" } }),
    run: ({ on }) => { setPanelFocus(on); return on ? "Panel expanded." : "Cloud shown."; } });
  register<{ attemptId: string; row?: number | null }>({ name: "focusAttempt", description: "Show one attempt in the swimlanes, optionally selecting a unit (row id).",
    args: obj({ attemptId: { type: "string" }, row: { type: ["integer", "null"] } }, ["attemptId"]),
    run: async ({ attemptId, row }) => { if (!lanes) return "This bundle has no swimlanes."; await showTab("lanes"); await lanes.focusAttempt(attemptId, row ?? null); return `Swimlanes show attempt ${attemptId.slice(0, 8)}.`; } });
  register<{ id: string | null }>({ name: "focusClaim", description: "Open the claims tab on one claim; null clears the focus.", args: obj({ id: { type: ["string", "null"] } }),
    run: async ({ id }) => { await showTab("claims"); claimsPanel?.focus(id); return id ? `Claim ${id} in focus.` : "Cleared the claim focus."; } });
  register<{ id: string | null }>({ name: "focusView", description: "Open the figures tab on one view spec; null clears the focus.", args: obj({ id: { type: ["string", "null"] } }),
    run: async ({ id }) => { await showTab("figures"); await figures?.focus(id); return id ? `Figure ${id} in focus.` : "Cleared the figure focus."; } });
  provide({ key: "shell", get: () => ({ tab, focusPanel: layout.classList.contains("focus-panel") }),
    apply: async (st: { tab: Tab; focusPanel: boolean }) => { setPanelFocus(st.focusPanel); await showTab(st.tab); } });
  provide({ key: "claims", get: () => ({ focused: claimsPanel?.focused ?? null }), apply: (st: { focused: string | null }) => { claimsPanel?.focus(st.focused); } });
  provide({ key: "figures", get: () => ({ focused: figures?.focused ?? null }), apply: async (st: { focused: string | null }) => { await figures?.focus(st.focused); } });

  host.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
    b.addEventListener("click", () => run("openTab", { tab: b.dataset.tab }));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = TABS.indexOf(b.dataset.tab as Tab);
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      run("openTab", { tab: next }).then(() => host.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)!.focus());
    });
  });
  focusButton.addEventListener("click", () => run("setPanelFocus", { on: !layout.classList.contains("focus-panel") }));

  // ---- the cloud: Embedding Atlas registers its own tools (chart state: viewport, brush, legend; SQL; screenshots) ----
  type EaTool = { name: string; description: string; inputSchema: Record<string, unknown>; execute: (input: any, agent: unknown) => Promise<any> };
  let eaTools: EaTool[] = [];
  let atlasState: Record<string, any> = {};
  const panel = new ClusterArmPanel(document.getElementById("body-clusters")!, coordinator, highlight,
    lanes ? async (id, label) => { await showTab("lanes"); await lanes.focusCluster(id, label); } : undefined);
  const atlas = new EmbeddingAtlas(document.getElementById("atlas")!, {
    coordinator,
    // No `features` list: it pushed the per-column count charts below the fold and truncated long tags.
    data: { table: "units", id: "row_id", projection: { x: "x", y: "y" }, neighbors: "neighbors", text: "embed_text" },
    colorScheme: dark() ? "dark" : "light",
    embeddingViewConfig: { autoLabelStopWords: STOP_WORDS },
    embeddingViewLabels: labels,
    defaultChartsConfig: {
      // shallow-merged over the default embedding spec, so data must be complete
      embedding: { data: { x: "x", y: "y", text: "embed_text", neighbors: "neighbors", category: colorBy === "none" ? null : colorBy } },
      include: ["condition", "task_id", "unit_kind", "tool_kind", "check_kind", "status", "harness_id", "trial_id", "cited_assessments", "cluster_label", "embed_text"],
    },
    onPredicateChange: (predicate) => { panel.setPredicate(predicate); lanes?.setPredicate(predicate); },
    onStateChange: (state) => { atlasState = state as Record<string, any>; },
    modelContext: { provideContext: (context: { tools?: EaTool[] }) => { eaTools = context.tools ?? []; } },
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => atlas.update({ colorScheme: dark() ? "dark" : "light" }));
  const eaTool = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = eaTools.find((t) => t.name === name);
    if (!tool) throw new Error(`Embedding Atlas tool ${name} is not available.`);
    return tool.execute(input, null);
  };
  const embeddingChartId = () => Object.entries(atlasState.charts ?? {}).find(([, spec]) => (spec as { type?: string }).type === "embedding")?.[0];
  const cloudState = () => { const id = embeddingChartId(); return id ? (atlasState.chartStates?.[id] ?? {}) : {}; };
  const setCloudState = async (patch: Record<string, unknown>) => {
    const id = embeddingChartId();
    if (!id) throw new Error("The embedding chart is not ready.");
    const next = Object.fromEntries(Object.entries({ ...cloudState(), ...patch }).filter(([, v]) => v !== null && v !== undefined));
    await eaTool("chart_set_state", { id, state: next });
    await new Promise((r) => setTimeout(r, 50));
  };
  const point = obj({ x: { type: "number" }, y: { type: "number" } });
  register<{ x: number; y: number; scale: number }>({ name: "setViewport", description: "Pan and zoom the cloud: center (x, y) in data units and scale (data units to [-1, 1]).",
    args: obj({ x: { type: "number" }, y: { type: "number" }, scale: { type: "number", exclusiveMinimum: 0 } }),
    run: async ({ x, y, scale }) => { await setCloudState({ viewport: { x, y, scale } }); return `Cloud viewport at (${x.toFixed(2)}, ${y.toFixed(2)}), scale ${scale.toFixed(2)}.`; } });
  register<{ rectangle?: { xMin: number; yMin: number; xMax: number; yMax: number }; polygon?: { x: number; y: number }[] }>({ name: "selectRange",
    description: "Brush the cloud with a rectangle or a lasso polygon in data units; every linked panel filters to it.",
    args: { type: "object", properties: { rectangle: obj({ xMin: { type: "number" }, yMin: { type: "number" }, xMax: { type: "number" }, yMax: { type: "number" } }), polygon: { type: "array", minItems: 3, items: point } }, additionalProperties: false },
    run: async ({ rectangle, polygon }) => { await setCloudState({ brush: rectangle ?? polygon ?? null }); return rectangle ? "Brushed a rectangle in the cloud." : "Brushed a lasso in the cloud."; } });
  register({ name: "clearSelection", description: "Clear the cloud brush and highlight.", args: obj({}),
    run: async () => { await setCloudState({ brush: null }); highlight(null); return "Cleared the cloud selection."; } });
  register<{ categories: string[] }>({ name: "setLegendSelection", description: "Select color-legend categories in the cloud (empty clears).", args: obj({ categories: { type: "array", items: { type: "string" } } }),
    run: async ({ categories }) => { await setCloudState({ legend: categories.length ? { selection: categories } : null }); return categories.length ? `Legend selection: ${categories.join(", ")}.` : "Cleared the legend selection."; } });
  register<{ tool: string; input?: Record<string, unknown> }>({ name: "cloudTool", description: "Run one of Embedding Atlas's own tools (see listCloudTools), e.g. chart_set_state or data_query.",
    args: obj({ tool: { type: "string" }, input: { type: "object" } }, ["tool"]),
    run: async ({ tool, input }) => { const result = await eaTool(tool, input ?? {}); lastCloudResult = result; return `Ran Embedding Atlas tool ${tool}.`; } });
  let lastCloudResult: unknown = null;
  provide({ key: "cloud", get: () => {
      const st = cloudState();
      return { viewport: st.viewport ?? null, brush: st.brush ?? null, legend: st.legend?.selection ?? null } as Json;
    },
    apply: async (st: { viewport: unknown; brush: unknown; legend: string[] | null }) => {
      if (!embeddingChartId()) return;
      await setCloudState({ viewport: st.viewport, brush: st.brush, legend: st.legend?.length ? { selection: st.legend } : null });
    } });

  register<{ fraction: number }>({ name: "setSplit", description: "Share of the window height given to the cloud (0.25-0.85).", args: obj({ fraction: { type: "number", minimum: 0.25, maximum: 0.85 } }),
    run: ({ fraction }) => { setSplit(fraction); return `Cloud takes ${Math.round(fraction * 100)}% of the height.`; } });
  await panel.setPredicate(null);
  await showTab(initialPanel === "lanes" && !lanes ? "clusters" : initialPanel);
  setupSplitter();

  // ---- URL: the state serializes to the fragment ----
  // Fragment grammar shared with packet pages: #claim=C3 · #assessment=<assertion id> · #record=<attempt id>:<row id>
  // · #audit=<attempt id> · #chains=<attempt id> · #attempt=<attempt id> · #view=<view id> · #state=<encoded state>.
  const legacy = (event: CommandEvent): string | null => {
    const a = event.args as Record<string, any>;
    switch (event.command) {
      case "openAssessment": return `assessment=${a.id}`;
      case "openUnit": return `record=${a.attemptId}:${a.row}`;
      case "openAudit": return `audit=${a.attemptId}`;
      case "openChains": return `chains=${a.attemptId}`;
      case "focusAttempt": return a.row == null ? `attempt=${a.attemptId}` : `record=${a.attemptId}:${a.row}`;
      case "focusClaim": return a.id ? `claim=${a.id}` : null;
      case "focusView": return a.id ? `view=${a.id}` : null;
      default: return null;
    }
  };
  let writing = false;
  subscribe((event) => {
    if (event.source === "url") return;
    const fragment = legacy(event) ?? `state=${encodeState(getState())}`;
    writing = true;
    try { history.replaceState(null, "", `${location.pathname}${location.search}#${fragment}`); } catch { /* ignore */ }
    writing = false;
  });
  const applyFragment = async () => {
    if (writing) return;
    const m = location.hash.match(/^#(claim|assessment|record|audit|chains|attempt|view|state)=(.+)$/);
    if (!m) return;
    const [, kind, raw] = m, val = decodeURIComponent(raw);
    if (kind === "state") { await setState(decodeState(val), "url"); return; }
    if (kind === "view") { await run("focusView", { id: val }, "url"); return; }
    if (kind === "claim") { await run("focusClaim", { id: val }, "url"); return; }
    if (!ev) return;
    if (kind === "assessment") { await run("openTab", { tab: "assessments" }, "url"); await run("openAssessment", { id: val }, "url"); }
    else if (kind === "audit") await run("openAudit", { attemptId: val }, "url");
    else if (kind === "chains") { await run("focusAttempt", { attemptId: val, row: null }, "url"); await run("openChains", { attemptId: val }, "url"); }
    else if (kind === "attempt") await run("focusAttempt", { attemptId: val, row: null }, "url");
    else if (kind === "record") {
      const i = val.lastIndexOf(":"), attemptId = val.slice(0, i), row = Number(val.slice(i + 1));
      await run("focusAttempt", { attemptId, row }, "url"); await run("openUnit", { attemptId, row }, "url");
    }
  };
  await applyFragment();
  addEventListener("hashchange", () => { applyFragment(); });

  // ---- the programmatic surface: tests and a later Agent Mode use the same commands as the controls ----
  (window as any).ebo = {
    run: (name: string, args?: Record<string, unknown>) => run(name, args ?? {}, "assistant"),
    commands: listCommands,
    getState, setState: (state: Record<string, Json>) => setState(state, "assistant"),
    encodeState, decodeState, describe, subscribe,
    listCloudTools: () => eaTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    cloudResult: () => lastCloudResult,
    drawerViews: (): DrawerView[] => drawer.views,
    ready: true,
  };
  document.body.dataset.eboReady = "1";
}

/** Layout preference (kept in local storage, not in the shared state). */
function setSplit(frac: number) {
  const layout = document.querySelector(".layout") as HTMLElement;
  const f = Math.min(0.85, Math.max(0.25, frac));
  layout.style.setProperty("--atlas-frac", String(f));
  try { localStorage.setItem("ebo-atlas-split", String(f)); } catch { /* storage unavailable */ }
}

function setupSplitter() {
  const layout = document.querySelector(".layout") as HTMLElement;
  const splitter = document.getElementById("splitter")!;
  splitter.setAttribute("data-ebo-target", "setSplit");
  splitter.setAttribute("data-ebo-command", "setSplit");
  const set = (frac: number) => run("setSplit", { fraction: Math.min(0.85, Math.max(0.25, frac)) });
  try { const s = localStorage.getItem("ebo-atlas-split"); if (s) setSplit(Number(s)); } catch { /* ignore */ }
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    const rect = layout.getBoundingClientRect();
    const move = (ev: PointerEvent) => set((ev.clientY - rect.top) / rect.height);
    const up = () => { splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", up); };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });
  splitter.addEventListener("keydown", (e) => {
    const cur = Number(getComputedStyle(layout).getPropertyValue("--atlas-frac")) || 0.5;
    if (e.key === "ArrowUp") set(cur - 0.05);
    if (e.key === "ArrowDown") set(cur + 0.05);
  });
}

main().catch((e) => {
  console.error(e);
  status(`Failed to load: ${e?.message ?? e}`, true);
});
