#!/usr/bin/env node
// DESIGN.md -> viewer/src/tokens.css. Lints with the pinned @google/design.md CLI, exports DTCG, and writes CSS custom
// properties: colors as --<name> (a `-dark` sibling becomes the dark-mode value of --<name>), typography as
// --font-<name> / --size-<name> / --weight-<name> / --lh-<name> / --ls-<name>, rounded as --r-<name>, spacing as --s-<name>.
// Usage: npm run tokens --workspace viewer   (needs network once for npx)
//        node viewer/design/build-tokens.mjs <DESIGN.md> <tokens.css>   (another design file, e.g. the project site)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = "@google/design.md@0.4.0";
const here = dirname(fileURLToPath(import.meta.url));
const [srcArg, outArg] = process.argv.slice(2);
const src = srcArg ? resolve(srcArg) : join(here, "DESIGN.md");
const out = outArg ? resolve(outArg) : join(here, "..", "src", "tokens.css");
const run = (...args) => execFileSync("npx", ["-y", CLI, ...args, src], { encoding: "utf8" });

const lint = JSON.parse(run("lint", "--format", "json"));
const bad = lint.findings.filter((f) => f.severity !== "info");
if (lint.summary.errors) { console.error(lint.findings); process.exit(1); }
const dtcg = JSON.parse(run("export", "--format", "dtcg"));

const dim = (v) => (typeof v === "object" && v ? `${v.value}${v.unit}` : v);
const light = [], dark = [];
for (const [name, tok] of Object.entries(dtcg.color ?? {})) {
  if (name.startsWith("$")) continue;
  const hex = tok.$value?.hex ?? tok.$value;
  if (name.endsWith("-dark")) dark.push(`  --${name.slice(0, -5)}: ${hex};`);
  else light.push(`  --${name}: ${hex};`);
}
const other = [];
for (const [name, tok] of Object.entries(dtcg.typography ?? {})) {
  if (name.startsWith("$")) continue;
  const v = tok.$value ?? {};
  const fam = Array.isArray(v.fontFamily) ? v.fontFamily.join(", ") : v.fontFamily;
  const size = typeof v.fontSize === "object" ? `${v.fontSize.value}${v.fontSize.unit}` : v.fontSize;
  if (fam) other.push(`  --font-${name}: ${fam};`);
  if (size) other.push(`  --size-${name}: ${size};`);
  if (v.fontWeight != null) other.push(`  --weight-${name}: ${v.fontWeight};`);
  if (v.lineHeight != null) other.push(`  --lh-${name}: ${typeof v.lineHeight === "object" ? v.lineHeight.value : v.lineHeight};`);
  if (v.letterSpacing != null) other.push(`  --ls-${name}: ${dim(v.letterSpacing)};`);
}
for (const group of ["rounded", "spacing", "dimension"]) {
  for (const [name, tok] of Object.entries(dtcg[group] ?? {})) {
    if (name.startsWith("$") || typeof tok !== "object") continue;
    if (tok.$value === undefined) { // nested group (e.g. dimension.rounded.sm)
      for (const [n2, t2] of Object.entries(tok)) if (!n2.startsWith("$")) other.push(`  --${group === "dimension" ? name.slice(0, 1) : group[0]}-${n2}: ${dim(t2.$value)};`);
    } else other.push(`  --${group === "rounded" ? "r" : "s"}-${name}: ${dim(tok.$value)};`);
  }
}
const origin = srcArg ? relative(process.cwd(), src) : "design/DESIGN.md";
const css = `/* GENERATED from ${origin} by ${srcArg ? "viewer/design/" : "design/"}${basename(fileURLToPath(import.meta.url))} (${CLI}); do not edit. */
:root {
  color-scheme: light;
${light.join("\n")}
${other.join("\n")}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${dark.map((l) => "  " + l).join("\n")}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
${dark.join("\n")}
}
`;
writeFileSync(out, css);
console.log(`tokens.css: ${light.length} colors, ${dark.length} dark overrides, ${other.length} other tokens; lint warnings: ${bad.length}`);
