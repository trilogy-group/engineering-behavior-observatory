import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATLAS_FILTERS, type AtlasView } from "./atlas.js";

/** Native Grafana panels backed by the maintained Infinity JSON data source. */
export function atlasDashboards(view: AtlasView, atlasUrl = view.atlasUrl ?? "http://127.0.0.1:13011") {
  const query = ATLAS_FILTERS.map((key) => `${key}=\${${key}:percentencode}`).join("&");
  const datasource = { type: "yesoreyeram-infinity-datasource", uid: "ebo-atlas-derived" };
  const organize = (names: string[]) => [{ id: "organize", options: { indexByName: Object.fromEntries(names.map((name, index) => [name, index])) } }];
  const variables = ATLAS_FILTERS.map((name) => name === "q" ? { name, label: "Search case evidence", type: "textbox", query: "", current: { text: "", value: "" } } : {
    name, label: name, type: "custom", query: (view.filterOptions[name] ?? []).map((value) => value.replaceAll(",", "\\,")).join(","),
    multi: false, includeAll: true, allValue: "$__all", current: { text: "All", value: "$__all" },
    options: [{ text: "All", value: "$__all", selected: true }, ...(view.filterOptions[name] ?? []).map((value) => ({ text: value, value, selected: false }))],
  });
  const target = (path: string, columns: string[]) => ({ refId: "A", datasource, type: "json", source: "url", url: `${atlasUrl}${path}?${query}`, url_options: { method: "GET", data: "", headers: [], params: [] }, parser: "backend", format: "table", root_selector: "", columns: columns.map((selector) => ({ selector, text: selector, type: ["numerator", "denominator"].includes(selector) ? "number" : "string" })) });
  return ["overview", "behavior"].map((kind) => ({
    uid: `ebo-atlas-${kind}`, title: `EBO | ${kind === "overview" ? "Cohort overview" : "Behavior Atlas"}`, schemaVersion: 39, version: 1, editable: false,
    tags: ["ebo", "derived", "restricted-local"], timezone: "utc", refresh: "", time: { from: "now-1h", to: "now" },
    description: "Rebuildable EBO-derived cohort queries. Not a live capture monitor. No composite score or causal inference.",
    templating: { list: variables },
    links: [{ type: "link", title: "Evidence workbench / export cohort report", url: `${atlasUrl}/?${query}`, targetBlank: true }, { type: "link", title: kind === "overview" ? "Behavior Atlas" : "Cohort overview", url: `/d/ebo-atlas-${kind === "overview" ? "behavior" : "overview"}`, includeVars: true }],
    panels: [
      { id: 1, type: "text", title: "Evidence and population boundaries", gridPos: { x: 0, y: 0, w: 24, h: 4 }, options: { mode: "markdown", content: "### EBO · Research workbench\nNative evidence remains authoritative. Filters select attempts through matching cases; all judgments on selected attempts remain in metrics. **Proposed is not human-confirmed.** Numerators, denominators and exclusions are shown together. The Grafana time picker affects Tempo only, not the frozen EBO cohort. Use the evidence workbench for review lineage, cited records and standalone report/PDF export." } },
      { id: 2, type: "table", title: kind === "overview" ? "Selected cohort metrics · exact counts and exclusions" : "Confirmed behavior distributions · opposite assessments remain separate", gridPos: { x: 0, y: 4, w: 24, h: 13 }, datasource,
        transformations: organize(kind === "overview" ? ["group", "metric", "status", "numerator", "denominator", "unit", "exclusions", "cohortDigest"] : ["group", "category", "dimension", "assessment", "status", "numerator", "denominator", "unit", "exclusions", "rubric", "evaluator", "vocabulary", "cohortDigest"]),
        targets: [target(kind === "overview" ? "/api/metrics" : "/api/behaviors", kind === "overview" ? ["group", "metric", "status", "numerator", "denominator", "unit", "exclusions", "cohortDigest"] : ["group", "category", "dimension", "rubric", "evaluator", "assessment", "status", "numerator", "denominator", "unit", "exclusions", "cohortDigest"])],
        fieldConfig: { defaults: { custom: { inspect: true, filterable: true }, links: [{ title: "Inspect selected cohort evidence", url: `${atlasUrl}/?${query}`, targetBlank: true }] }, overrides: [] }, options: { showHeader: true, cellHeight: "sm" } },
      ...(kind === "behavior" ? [{ id: 4, type: "barchart", title: "Confirmed assessment counts · denominators and exclusions in table above", description: "Counts, not model quality scores. Unavailable values remain null. Exact populations and exclusions are in the behavior table.", gridPos: { x: 0, y: 17, w: 24, h: 10 }, datasource, targets: [target("/api/behavior-chart", ["label", "count"])], options: { orientation: "horizontal", showValue: "always", stacking: "none", legend: { showLegend: false } }, fieldConfig: { defaults: { unit: "short", min: 0 }, overrides: [] } }] : []),
      { id: 3, type: "table", title: "Searchable cases · inspect in Atlas", gridPos: { x: 0, y: kind === "behavior" ? 27 : 17, w: 24, h: 10 }, datasource,
        transformations: organize(["runId", "attemptId", "model", "harness", "task", "trial", "category", "assessment", "review", "href"]),
        targets: [target("/api/cases", ["runId", "attemptId", "model", "harness", "task", "trial", "category", "assessment", "review", "href"])],
        fieldConfig: { defaults: { custom: { filterable: true }, links: [{ title: "Open case and cited evidence", url: "${__data.fields.href}", targetBlank: true }] }, overrides: [] }, options: { showHeader: true, cellHeight: "sm" } },
    ],
  }));
}

export async function writeAtlasGrafana(outputRoot: string, view: AtlasView): Promise<void> {
  const root = join(outputRoot, "grafana");
  for (const directory of ["dashboards", "provisioning/dashboards", "provisioning/datasources"]) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  for (const dashboard of atlasDashboards(view)) await writeFile(join(root, "dashboards", `${dashboard.uid}.json`), JSON.stringify(dashboard, null, 2), { mode: 0o600 });
  await writeFile(join(root, "provisioning/dashboards/atlas.yaml"), "apiVersion: 1\nproviders:\n  - name: ebo-atlas\n    folder: EBO Atlas\n    type: file\n    disableDeletion: true\n    options:\n      path: ${EBO_ATLAS_DASHBOARDS}\n", { mode: 0o600 });
  await writeFile(join(root, "provisioning/datasources/atlas.yaml"), `apiVersion: 1\ndatasources:\n  - name: EBO Atlas derived data\n    uid: ebo-atlas-derived\n    type: yesoreyeram-infinity-datasource\n    access: proxy\n    editable: false\n    jsonData:\n      allowedHosts:\n        - ${view.atlasUrl ?? "http://127.0.0.1:13011"}\n`, { mode: 0o600 });
  await writeFile(join(root, "grafana.ini"), `[server]\nhttp_addr = 127.0.0.1\nhttp_port = ${new URL(view.grafanaUrl ?? "http://127.0.0.1:13010").port || "80"}\n[auth.anonymous]\nenabled = true\norg_role = Viewer\n[auth]\ndisable_login_form = true\n[analytics]\nreporting_enabled = false\ncheck_for_updates = false\ncheck_for_plugin_updates = false\n[plugins]\npreinstall_disabled = true\npreinstall_auto_update = false\n`, { mode: 0o600 });
}
