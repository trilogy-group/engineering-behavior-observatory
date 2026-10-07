// Dependency upgrade check: for every dependency in package.json, the installed version, the latest release and the newest
// release that is at least MIN_AGE_DAYS old (default 7). Pre-releases are ignored unless installed.
// Usage: node scripts/check-upgrades.mjs [--min-age 7]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argAge = process.argv.indexOf("--min-age");
const MIN_AGE_DAYS = argAge > 0 ? Number(process.argv[argAge + 1]) : 7;
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const now = Date.now(), day = 864e5;
const rows = [];
for (const name of Object.keys(deps)) {
  let times;
  try { times = JSON.parse(execFileSync("npm", ["view", name, "time", "--json"], { encoding: "utf8" })); } catch { continue; }
  let installed = "-";
  try { installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url))).version; } catch { /* not installed */ }
  const rel = Object.entries(times).filter(([v]) => !["created", "modified"].includes(v) && !v.includes("-"))
    .sort((a, b) => new Date(a[1]) - new Date(b[1]));
  const latest = rel.at(-1), safe = rel.filter(([, d]) => now - new Date(d) >= MIN_AGE_DAYS * day).at(-1);
  const ageInstalled = times[installed] ? Math.floor((now - new Date(times[installed])) / day) : null;
  const status = installed.includes("-") ? "pre-release installed"
    : ageInstalled != null && ageInstalled < MIN_AGE_DAYS ? `installed is ${ageInstalled}d old (< ${MIN_AGE_DAYS}d)`
    : safe && safe[0] !== installed ? `upgrade candidate ${safe[0]}` : "current";
  rows.push([name, installed, `${latest?.[0]} (${latest?.[1].slice(0, 10)})`, `${safe?.[0]} (${safe?.[1].slice(0, 10)})`, status]);
}
const w = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), 10));
console.log(["package", "installed", "latest", `newest ≥${MIN_AGE_DAYS}d`].map((h, i) => h.padEnd(w[i])).join("  ") + "  status");
for (const r of rows) console.log(r.slice(0, 4).map((c, i) => c.padEnd(w[i])).join("  ") + "  " + r[4]);
