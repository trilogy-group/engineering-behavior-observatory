// Smoke test for the EBO Atlas viewer, driven through its command registry (window.ebo), as a later Agent Mode will.
// Needs a served bundle (`ebo atlas serve --bundle <dir>`) and Playwright with an installed Chrome (channel "chrome").
//   node scripts/smoke.mjs [url] [out.png]
// Env: HEADED=1 shows the window (Chrome on macOS has WebGPU, so the cloud renders; headless usually does not),
//      SCHEME=light|dark, WAIT=ms (load timeout).
// Checks: no page errors; every visible control outside the cloud maps to a registered command; every panel describes
// itself; the viewer state round-trips through the URL for every tab; the cloud viewport and brush are settable and
// readable (when the cloud renders); hostile bundle content (markup in assessment, audit and lane fields) neither runs
// nor injects elements. Prints a JSON report and exits 1 on any failure.
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:13012/";
const out = process.argv[3] ?? "smoke.png";
const browser = await chromium.launch({ channel: process.env.CHANNEL ?? "chrome", headless: !process.env.HEADED });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, colorScheme: process.env.SCHEME ?? "dark" });
const errors = [];
const failures = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" && !/WebGPU|webgpu|404/.test(m.text())) errors.push(m.text().slice(0, 300)); });
const ready = async () => page.waitForFunction(() => document.body.dataset.eboReady === "1", null, { timeout: Number(process.env.WAIT ?? 60000) });

await page.goto(url, { waitUntil: "load" });
await ready();
const report = { status: await page.textContent("#status") };

// Every control in our shell maps to a command (Embedding Atlas's own controls live inside #atlas and use its tools).
const controls = async () => page.evaluate(() => {
  const names = new Set(window.ebo.commands().map((c) => c.name));
  const visible = (el) => el.getClientRects().length > 0 && !el.closest("[hidden]");
  const found = [...document.querySelectorAll("button, select, input, a[href], [role=tab], [tabindex='0']")]
    .filter((el) => !el.closest("#atlas") && !el.closest(".tip") && visible(el));
  return {
    total: found.length,
    missing: found.filter((el) => !el.dataset.eboCommand).map((el) => el.outerHTML.slice(0, 140)),
    unknown: found.filter((el) => el.dataset.eboCommand && !names.has(el.dataset.eboCommand)).map((el) => el.dataset.eboCommand),
  };
});

const tabs = ["clusters", "lanes", "assessments", "claims", "figures"];
report.controls = {};
for (const tab of tabs) {
  await page.evaluate((t) => window.ebo.run("openTab", { tab: t }), tab);
  const c = await controls();
  report.controls[tab] = c.total;
  if (c.missing.length) failures.push({ tab, controlsWithoutCommand: c.missing.slice(0, 5) });
  if (c.unknown.length) failures.push({ tab, unknownCommands: c.unknown });
}

// Panels describe themselves from data.
const described = await page.evaluate(() => window.ebo.describe());
report.describe = Object.fromEntries(Object.entries(described).map(([k, v]) => [k, v.summary]));
for (const key of ["clusters", "lanes", "assessments", "claims", "figures", "drawer"]) if (!(key in described)) failures.push({ describe: `${key} has no describe()` });

// State round-trip through the URL, per tab, with a change in each.
const steps = {
  clusters: [["setClusterSort", { sort: "size" }], ["setClusterFamily", { family: "tools" }]],
  lanes: [["setLaneAxis", { axis: "step" }], ["setLaneRibbon", { ribbon: "cumulative" }]],
  assessments: [["setMatrixCohort", { cohort: "all" }]],
  claims: [],
  figures: [],
};
report.roundTrip = {};
for (const tab of tabs) {
  await page.evaluate((t) => window.ebo.run("openTab", { tab: t }), tab);
  for (const [name, args] of steps[tab]) await page.evaluate(([n, a]) => window.ebo.run(n, a), [name, args]);
  if (tab === "assessments") {
    const first = await page.evaluate(() => document.querySelector("table.jl tbody tr")?.dataset.id ?? null);
    if (first) await page.evaluate((id) => window.ebo.run("openAssessment", { id }), first);
  }
  if (tab === "clusters") await page.evaluate(() => window.ebo.run("setViewport", { x: 0.25, y: -0.5, scale: 0.75 }).catch(() => undefined));
  const before = await page.evaluate(() => window.ebo.getState());
  const encoded = await page.evaluate(() => window.ebo.encodeState(window.ebo.getState()));
  await page.goto(`${url.replace(/#.*$/, "")}#state=${encoded}`, { waitUntil: "load" });
  await ready();
  await page.waitForTimeout(500);
  // A restored cloud state waits for Embedding Atlas to publish its chart; give it the time a reader would.
  await page.waitForFunction((v) => JSON.stringify(window.ebo.getState().cloud?.viewport ?? null) === v, JSON.stringify(before.cloud?.viewport ?? null), { timeout: 15000 }).catch(() => undefined);
  const after = await page.evaluate(() => window.ebo.getState());
  const same = JSON.stringify(before) === JSON.stringify(after);
  report.roundTrip[tab] = same;
  if (!same) failures.push({ roundTrip: tab, before, after });
  await page.evaluate(() => window.ebo.run("closeDrawer"));
}

// Undo restores the state before the last change, including the cloud highlight.
report.undo = await page.evaluate(async () => {
  await window.ebo.run("openTab", { tab: "lanes" });
  const attempt = document.querySelector(".lane-label")?.dataset.lane;
  const before = JSON.stringify(window.ebo.getState().highlight);
  await window.ebo.run("highlightAttempt", { attemptId: attempt });
  const during = window.ebo.getState().highlight.rows?.length ?? 0;
  await window.ebo.run("undo");
  return { highlighted: during, restored: JSON.stringify(window.ebo.getState().highlight) === before };
});
if (!report.undo.highlighted || !report.undo.restored) failures.push({ undo: report.undo });

// A reader's own zoom in the embedding view is recorded: a history entry, an event and the URL.
if (await page.evaluate(() => window.ebo.listCloudTools().length > 0)) {
  const box = await page.locator("#atlas canvas").first().boundingBox().catch(() => null);
  if (box) {
    const before = await page.evaluate(() => { window.__cloudEvents = 0; window.ebo.subscribe((e) => { if (e.command === "cloudChanged") window.__cloudEvents++; }); return JSON.stringify(window.ebo.getState().cloud.viewport); });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({ viewport: JSON.stringify(window.ebo.getState().cloud.viewport), events: window.__cloudEvents, hash: location.hash.slice(0, 7) }));
    await page.evaluate(() => window.ebo.run("undo"));
    const undone = await page.evaluate(() => JSON.stringify(window.ebo.getState().cloud.viewport));
    report.directCloud = { changed: after.viewport !== before, events: after.events, hash: after.hash, undone: undone === before };
    if (report.directCloud.changed && (!report.directCloud.events || !report.directCloud.undone)) failures.push({ directCloud: report.directCloud });
  } else report.directCloud = "no canvas in this browser";
}

// The cloud: viewport and brush settable and readable through commands (needs WebGPU, so HEADED=1 on macOS).
const hasCloud = await page.evaluate(() => window.ebo.listCloudTools().length > 0 && window.ebo.getState().cloud !== undefined);
report.cloudTools = await page.evaluate(() => window.ebo.listCloudTools().map((t) => t.name));
if (hasCloud) {
  try {
    await page.evaluate(() => window.ebo.run("setViewport", { x: 0, y: 0, scale: 0.5 }));
    await page.evaluate(() => window.ebo.run("selectRange", { rectangle: { xMin: -1, yMin: -1, xMax: 1, yMax: 1 } }));
    await page.waitForTimeout(300);
    report.cloud = await page.evaluate(() => window.ebo.getState().cloud);
    if (!report.cloud?.viewport || !report.cloud?.brush) failures.push({ cloud: "viewport or brush not readable after setting", state: report.cloud });
    await page.evaluate(() => window.ebo.run("clearSelection"));
  } catch (e) {
    failures.push({ cloud: String(e?.message ?? e) });
  }
} else report.cloud = "embedding chart not ready (no WebGPU in this browser?)";

// Hostile bundle content: rewrite bundle JSON in flight with markup payloads, then open the views that render them.
const payload = `x"><img data-pwned src=x onerror="window.__pwned=1"><span class="`;
const hostile = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
hostile.on("pageerror", (e) => errors.push(`hostile pageerror: ${e.message}`));
await hostile.route("**/bundle/assessments.json", async (route) => {
  const doc = await (await route.fetch()).json();
  doc.assessments = doc.assessments.map((a) => ({ ...a, outcome: payload, confidence: payload, dimension: payload }));
  await route.fulfill({ json: doc });
});
await hostile.route("**/bundle/audit.json", async (route) => {
  const doc = await (await route.fetch()).json();
  for (const a of Object.values(doc.attempts)) { a.steps = payload; a.verdicts = [{ kind: "test", status: payload, text: payload }]; }
  await route.fulfill({ json: doc });
});
await hostile.route("**/bundle/lanes.json", async (route) => {
  const doc = await (await route.fetch()).json();
  doc.attempts = doc.attempts.map((l) => ({ ...l, tools: payload, errors: payload, compactions: payload }));
  await route.fulfill({ json: doc });
});
await hostile.goto(url.replace(/#.*$/, ""), { waitUntil: "load" });
await hostile.waitForFunction(() => document.body.dataset.eboReady === "1", null, { timeout: Number(process.env.WAIT ?? 60000) });
await hostile.evaluate(async () => {
  await window.ebo.run("openTab", { tab: "assessments" });
  const id = document.querySelector("table.jl tbody tr")?.dataset.id;
  if (id) await window.ebo.run("openAssessment", { id });
  await window.ebo.run("openTab", { tab: "lanes" });
  const attempt = document.querySelector(".lane-label")?.dataset.lane;
  if (attempt) await window.ebo.run("openAudit", { attemptId: attempt });
});
await hostile.waitForTimeout(500);
report.hostile = await hostile.evaluate(() => ({ executed: window.__pwned === 1, injected: document.querySelectorAll("[data-pwned]").length }));
if (report.hostile.executed || report.hostile.injected) failures.push({ hostile: report.hostile });
await hostile.close();

await page.screenshot({ path: out });
console.log(JSON.stringify({ ...report, errors, failures }, null, 2));
await browser.close();
process.exit(errors.length || failures.length ? 1 : 0);
