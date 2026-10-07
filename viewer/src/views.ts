// Figures: EBO view-spec envelopes around Mosaic JSON specs (views/<study>/*.json → data/<study>/views.json by
// the bundle's views.json). Each view renders live on the shared coordinator, recomputes its receipt query in DuckDB-WASM
// and compares it with the build. `exportFigure` downloads a rendered figure as standalone SVG.
import type { Coordinator } from "@uwdata/mosaic-core";
import { parseSpec, astToDOM } from "@uwdata/mosaic-spec";
import { createAPIContext } from "@uwdata/vgplot";
import { rowsOf } from "./enrichment";
import { esc } from "./lanes";
import type { ClaimsDoc } from "./p3";
import { describable, register, run, target, type Json } from "./registry";

export interface ViewSpec {
  id: string; title: string; description: string; tables: string[]; population: string; numbers: "certified" | "exploratory";
  query: string; spec: any; rows: Record<string, unknown>[]; rows_sha256: string;
}
export interface ViewsDoc { study: string; format: string; views: ViewSpec[] }

/** Design-token color references in view specs: `<scheme>:<name>` with the scheme "token" and a DESIGN.md token name. */
const COLOR_REFERENCE = /^(?<scheme>[a-z]+):(?<name>[a-z0-9-]+)$/u;

/** Replace design-token references with the token's current value (Plot needs concrete colors). */
function resolveTokens(x: any): any {
  const ref = typeof x === "string" ? COLOR_REFERENCE.exec(x)?.groups : undefined;
  if (ref?.scheme === "token") return getComputedStyle(document.documentElement).getPropertyValue(`--${ref.name}`).trim() || x;
  if (Array.isArray(x)) return x.map(resolveTokens);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolveTokens(v)]));
  return x;
}

/** Same normalization as p4/views.py: whole floats as ints, keys sorted, compact JSON. */
function canon(rows: Record<string, unknown>[]) {
  const v = (x: unknown) => (typeof x === "bigint" ? Number(x) : typeof x === "number" && Number.isInteger(x) ? Math.trunc(x) : x);
  return JSON.stringify(rows.map((r) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, v(r[k])]))));
}
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class FiguresPanel {
  private api: any;
  private rendered: Promise<void> | null = null;
  private receipts = new Map<string, { status: "match" | "differ" | "failed" | "pending"; rows?: number; error?: string }>();
  focused: string | null = null;
  constructor(private root: HTMLElement, private coordinator: Coordinator, private doc: ViewsDoc, private claims: ClaimsDoc | null) {
    this.api = createAPIContext({ coordinator });
    register<{ id: string }>({ name: "exportFigure", description: "Download a rendered figure as standalone SVG.",
      args: { type: "object", required: ["id"], properties: { id: { enum: doc.views.map((v) => v.id) } }, additionalProperties: false }, readOnly: true,
      run: async ({ id }) => { await this.render(); return this.download(id) ? `Downloaded ${id}.svg.` : `Figure ${id} has not rendered.`; } });
    describable("figures", { describe: () => ({ summary: `${doc.views.length} view specs; receipts: ${[...this.receipts.values()].filter((r) => r.status === "match").length} match the build.`,
      data: { focused: this.focused, views: doc.views.map((v) => ({ id: v.id, title: v.title, numbers: v.numbers, population: v.population, receipt: (this.receipts.get(v.id) ?? { status: "pending" }) as unknown as Json, rows: v.rows as unknown as Json })) } as unknown as Json }) });
  }

  private download(id: string) {
    const view = this.doc.views.find((v) => v.id === id);
    const host = this.root.querySelector<HTMLElement>(`[data-plot="${CSS.escape(id)}"]`);
    const fig = host?.querySelector("svg") ? host.firstElementChild : null;
    if (!view || !fig) return false;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([standaloneSvg(fig, view.title)], { type: "image/svg+xml" }));
    a.download = `${id}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }
  citedBy(id: string) { return (this.claims?.claims ?? []).filter((c: any) => (c.views ?? []).includes(id)).map((c) => c.id); }

  render(): Promise<void> {
    this.rendered ??= this.draw();
    return this.rendered;
  }

  private async draw() {
    this.root.innerHTML = `<div class="panel-head"><div><h2>Figures</h2>
      <p class="sub">${this.doc.views.length} view specs · ${esc(this.doc.format)} · each renders live from its spec and recomputes its numbers here</p></div></div>
      <div class="table-wrap figs">${this.doc.views.map((v) => `<article class="fig" id="fig-${esc(v.id)}">
        <h3>${esc(v.title)} <span class="tag-${v.numbers === "certified" ? "c" : "x"}">${esc(v.numbers)}</span></h3>
        <p class="small">${esc(v.description)}</p><p class="muted small">Population: ${esc(v.population)}</p>
        <div class="fig-plot" data-plot="${esc(v.id)}"><span class="muted">rendering…</span></div>
        <p class="small"><span class="receipt" data-receipt="${esc(v.id)}">checking numbers…</span>${this.citedBy(v.id).length ? ` · cited by ${this.citedBy(v.id).map((c) => `<span class="mono">${esc(c)}</span>`).join(", ")}` : ""}
          · <span class="mono muted">${esc(v.id)}</span> · <button class="link" data-export="${esc(v.id)}" ${target("exportFigure", v.id)}>Save SVG</button></p>
        <details><summary>Numbers (receipt query and rows)</summary><pre class="rec-t">${esc(v.query)}</pre><div class="fig-rows" data-rows="${esc(v.id)}"></div></details>
        <details><summary>Spec (Mosaic JSON)</summary><pre class="rec-t">${esc(JSON.stringify(v.spec, null, 1))}</pre></details>
      </article>`).join("")}</div>`;
    this.root.querySelectorAll<HTMLButtonElement>("[data-export]").forEach((b) => b.addEventListener("click", () => run("exportFigure", { id: b.dataset.export })));
    for (const v of this.doc.views) {
      const host = this.root.querySelector<HTMLElement>(`[data-plot="${CSS.escape(v.id)}"]`)!;
      try {
        const { element } = await astToDOM(parseSpec(resolveTokens(v.spec)), { api: this.api });
        host.replaceChildren(element);
      } catch (e: any) {
        host.innerHTML = `<p class="bad">Spec failed to render: ${esc(String(e?.message ?? e))}</p>`;
      }
      // receipt: recompute the view's numbers and compare with the build
      const rec = this.root.querySelector<HTMLElement>(`[data-receipt="${CSS.escape(v.id)}"]`)!;
      try {
        const rows = rowsOf(await this.coordinator.query(v.query));
        const same = (await sha256(canon(rows))) === v.rows_sha256;
        this.receipts.set(v.id, { status: same ? "match" : "differ", rows: rows.length });
        rec.innerHTML = same ? `<span class="ok">✓ numbers recomputed here match the build (${rows.length} rows)</span>`
          : `<span class="bad">✕ numbers recomputed here differ from the build</span>`;
        const cols = Object.keys(rows[0] ?? {});
        this.root.querySelector<HTMLElement>(`[data-rows="${CSS.escape(v.id)}"]`)!.innerHTML =
          `<table class="grid audit"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(String(r[c]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      } catch (e: any) {
        rec.innerHTML = `<span class="bad">✕ receipt query failed: ${esc(String(e?.message ?? e))}</span>`;
        this.receipts.set(v.id, { status: "failed", error: String(e?.message ?? e) });
      }
    }
    await new Promise((r) => setTimeout(r, 300));       // let plots settle after their data arrives
  }
  async focus(id: string | null) {
    this.focused = id;
    if (id === null && !this.rendered) return;
    await this.render();
    this.root.querySelectorAll(".fig.on").forEach((x) => x.classList.remove("on"));
    const el = id === null ? null : this.root.querySelector<HTMLElement>(`#fig-${CSS.escape(id)}`);
    if (!el) return;
    el.classList.add("on"); el.scrollIntoView({ block: "start" });
  }
}

/** One standalone SVG for a rendered figure: the plot SVG(s), then the HTML swatch legend redrawn as SVG. */
function standaloneSvg(fig: Element, title: string) {
  const isSwatch = (el: Element) => !!el.closest('[class*="-swatch"]');
  const svgs = (fig.tagName.toLowerCase() === "svg" ? [fig as SVGSVGElement] : [...fig.querySelectorAll<SVGSVGElement>("svg")]).filter((s) => !isSwatch(s) && !s.parentElement?.closest("svg"));
  const parts = svgs.map((s) => ({ s, w: Number(s.getAttribute("width")) || s.getBoundingClientRect().width, h: Number(s.getAttribute("height")) || s.getBoundingClientRect().height }));
  const fg = getComputedStyle(document.documentElement).getPropertyValue("--text-primary").trim() || "#000";
  const muted = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#777";
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim() || "#fff";
  let y = 0, body = "";
  for (const p of parts) {
    const c = p.s.cloneNode(true) as SVGSVGElement;
    c.setAttribute("y", String(y)); c.setAttribute("x", "0");
    body += new XMLSerializer().serializeToString(c); y += p.h + 4;
  }
  // legend: one row of swatches with labels (wraps at the figure width)
  const items = [...fig.querySelectorAll('span[class$="-swatch"]')].filter((e) => e.querySelector("svg")).map((e) => ({ fill: e.querySelector("svg")!.getAttribute("fill") ?? muted, label: (e.textContent ?? "").trim() }));
  const W = Math.max(320, ...parts.map((p) => p.w));
  if (items.length) {
    let x = 0; y += 8;
    for (const it of items) {
      const w = 22 + it.label.length * 6.4 + 14;
      if (x + w > W) { x = 0; y += 20; }
      body += `<rect x="${x}" y="${y}" width="12" height="12" rx="2" fill="${esc(it.fill)}" stroke="${esc(muted)}" stroke-width="0.75"/><text x="${x + 18}" y="${y + 10}" font-size="11" fill="${esc(fg)}">${esc(it.label)}</text>`;
      x += w;
    }
    y += 20;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" style="color:${fg};background:${bg};font-family:system-ui,sans-serif"><title>${esc(title)}</title><rect width="100%" height="100%" fill="${bg}"/>${body}</svg>`;
}
