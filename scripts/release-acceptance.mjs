import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifestPath = join(root, "release", pkg.version, "reproducibility.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (process.version !== `v${pkg.engines.node}`) {
  throw new Error(`Release acceptance requires Node ${pkg.engines.node}; found ${process.version}.`);
}
if (manifest.release.name !== pkg.name || manifest.release.version !== pkg.version) {
  throw new Error("Reproducibility manifest does not match package identity.");
}

for (const [path, expected] of Object.entries(manifest.fixtures)) {
  const actual = sha256(readFileSync(join(root, path)));
  if (actual !== expected) throw new Error(`Fixture digest mismatch for ${path}: ${actual}.`);
}

run("npm", ["run", "build"]);
run("npm", ["run", "typecheck"]);
const tests = readdirSync(join(root, "dist", "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("dist", "test", name));
run(process.execPath, ["--test", "--test-concurrency=1", ...tests]);
checkLinks();

const temporary = mkdtempSync(join(tmpdir(), "ebo-release-acceptance-"));
const outputRoot = join(root, ".ebo", "releases", pkg.version);
try {
  const first = pack(join(temporary, "first"));
  const second = pack(join(temporary, "second"));
  const firstBytes = readFileSync(join(temporary, "first", first.filename));
  const secondBytes = readFileSync(join(temporary, "second", second.filename));
  const digest = sha256(firstBytes);
  if (!firstBytes.equals(secondBytes)) throw new Error("Repeated npm packs were not byte-identical.");
  if (first.files.some(({ path }) => forbiddenPackagePath(path))) {
    throw new Error("Package contains restricted evidence, test fixtures, credentials, or orchestration state.");
  }
  for (const { path } of first.files) {
    const source = join(root, path);
    if (!existsSync(source) || statSync(source).isDirectory()) continue;
    const bytes = readFileSync(source);
    if (/ghp_[A-Za-z0-9]{30,}|-----BEGIN (?:ENCRYPTED |PGP )?PRIVATE KEY-----/u.test(bytes.toString("utf8"))) {
      throw new Error(`Package file ${path} contains a secret-like value.`);
    }
  }

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, first.filename), firstBytes);
  writeFileSync(join(outputRoot, "SHA256SUMS"), `${digest}  ${first.filename}\n`);
  const result = {
    schemaVersion: "ebo.release-acceptance-result/v1",
    release: manifest.release,
    status: "passed",
    sourceCommit: output("git", ["rev-parse", "HEAD"]).trim(),
    node: process.version.slice(1),
    npm: output("npm", ["--version"]).trim(),
    fixtureManifest: relative(root, manifestPath),
    fixtureCount: Object.keys(manifest.fixtures).length,
    documentationLinks: "passed",
    tests: "passed",
    deterministicPackage: true,
    package: { filename: first.filename, sha256: digest, sizeBytes: firstBytes.length, files: first.files.length },
  };
  writeFileSync(join(outputRoot, "acceptance-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`Release acceptance passed: ${relative(root, outputRoot)}/${first.filename}\nsha256:${digest}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed.`);
  return result.stdout;
}

function pack(destination) {
  mkdirSync(destination);
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", destination], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "npm pack failed.");
  const packed = JSON.parse(result.stdout)[0];
  if (!packed?.filename || !Array.isArray(packed.files)) throw new Error("npm pack returned an incomplete manifest.");
  return packed;
}

function checkLinks() {
  for (const file of markdownFiles(root)) {
    let fenced = false;
    for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
      if (/^\s*```/u.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = match[1].trim().replace(/^<|>$/gu, "").split("#", 1)[0];
        if (!target || /^(?:https?:|mailto:)/u.test(target)) continue;
        const resolved = resolve(dirname(file), decodeURIComponent(target));
        if (!existsSync(resolved)) throw new Error(`Broken documentation link in ${relative(root, file)}:${index + 1}: ${match[1]}.`);
      }
    }
  }
}

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".ebo", "dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function forbiddenPackagePath(path) {
  return /^(?:\.agents|\.ebo|\.env|\.git|\.opensymphony|test|tests|workspaces|run-bundles|exports)(?:\/|$)|(?:^|\/)(?:credentials?|restricted)(?:\/|$)|\.(?:key|pem)$/u.test(path);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
