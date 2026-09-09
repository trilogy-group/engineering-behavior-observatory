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
const outputRoot = join(root, ".ebo", "releases", pkg.version);
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
let stage = "preflight";
writeResult({ schemaVersion: "ebo.release-acceptance-result/v1", release: { name: pkg.name, version: pkg.version }, status: "running", stage });

try {
  if (output("git", ["status", "--porcelain", "--untracked-files=all"]).trim() !== "") {
    throw new Error("Release acceptance requires a clean source tree.");
  }
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

  stage = "build-and-test";
  run("npm", ["run", "build"]);
  run("npm", ["run", "typecheck"]);
  const { containsPortableLocalHomePath, containsPortableSecretPattern } = await import("../dist/src/exports.js");
  const tests = readdirSync(join(root, "dist", "test"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join("dist", "test", name));
  run(process.execPath, ["--test", "--test-concurrency=1", ...tests]);
  checkLinks(root);

  stage = "package";
  const temporary = mkdtempSync(join(tmpdir(), "ebo-release-acceptance-"));
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
    const tracked = new Set(output("git", ["ls-files", "-z"]).split("\0").filter(Boolean));
    const unbound = first.files.filter(({ path }) => !path.startsWith("dist/") && !tracked.has(path));
    if (unbound.length > 0) throw new Error(`Package contains inputs not bound to the source commit: ${unbound.map(({ path }) => path).join(", ")}.`);
    checkPackageLinks(first.files);
    for (const { path } of first.files) {
      const source = join(root, path);
      if (!existsSync(source) || statSync(source).isDirectory()) continue;
      const text = readFileSync(source, "utf8");
      const mediaType = path.endsWith(".jsonl") ? "application/x-ndjson"
        : path.endsWith(".json") ? "application/json"
          : /\.(?:[cm]?js|[cm]?ts)$/u.test(path) ? "application/javascript" : "text/plain";
      if (containsPortableLocalHomePath(text) || containsPortableSecretPattern(text, mediaType)) {
        throw new Error(`Package file ${path} contains a local identifier or secret-like value.`);
      }
    }

    writeFileSync(join(outputRoot, first.filename), firstBytes);
    writeFileSync(join(outputRoot, "SHA256SUMS"), `${digest}  ${first.filename}\n`);
    writeResult({
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
    });
    process.stdout.write(`Release acceptance passed: ${relative(root, outputRoot)}/${first.filename}\nsha256:${digest}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} catch (error) {
  writeResult({ schemaVersion: "ebo.release-acceptance-result/v1", release: { name: pkg.name, version: pkg.version }, status: "failed", stage });
  throw error;
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
  const result = spawnSync("npm", ["pack", "--json", "--silent", "--pack-destination", destination], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "npm pack failed.");
  const packed = JSON.parse(result.stdout)[0];
  if (!packed?.filename || !Array.isArray(packed.files)) throw new Error("npm pack returned an incomplete manifest.");
  return packed;
}

function checkLinks(directory) {
  for (const file of markdownFiles(directory)) {
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

function checkPackageLinks(files) {
  const included = new Set(files.map(({ path }) => path));
  for (const path of included) {
    if (!path.endsWith(".md")) continue;
    const file = join(root, path);
    let fenced = false;
    for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
      if (/^\s*```/u.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = match[1].trim().replace(/^<|>$/gu, "").split("#", 1)[0];
        if (!target || /^(?:https?:|mailto:)/u.test(target)) continue;
        const packagedTarget = relative(root, resolve(dirname(file), decodeURIComponent(target)));
        if (!included.has(packagedTarget)) throw new Error(`Broken packaged link in ${path}:${index + 1}: ${match[1]}.`);
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
  return /^(?:\.agents|\.ebo|\.git|\.opensymphony|test|tests|workspaces|run-bundles|exports)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]*)?(?:\/|$)|(?:^|\/)(?:credentials?|restricted)(?:\/|$)|\.(?:key|pem)$/u.test(path);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeResult(result) {
  writeFileSync(join(outputRoot, "acceptance-result.json"), `${JSON.stringify(result, null, 2)}\n`);
}
