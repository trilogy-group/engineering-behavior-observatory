import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  buildCorpusIndex,
  createPortableRunBundleExport,
  packPortableExport,
  queryCorpusIndex,
  readCorpusIndex,
  readPortableRunBundleExport,
  unpackPortableExport,
  validateCorpusIndex,
  writeCorpusIndex,
  type PortableExportPolicy,
} from "../src/index.js";
import { main } from "../src/cli.js";

const fixtures = resolve("test/fixtures/run-bundles");
const policy: PortableExportPolicy = {
  sharingClass: "partner",
  maxArtifactBytes: 16 * 1024,
  maxStringBytes: 8 * 1024,
};

test("builds, queries, and validates a deterministic mixed corpus index", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-corpus-"));
  const corpus = join(root, "corpus");
  const indexPath = join(root, "index.jsonl");
  try {
    for (const name of ["complete", "task-failed", "interrupted", "telemetry-incomplete"]) {
      cpSync(join(fixtures, name), join(corpus, "runs", name), { recursive: true });
    }
    await createPortableRunBundleExport({
      sourceRoot: join(corpus, "runs", "complete"),
      destinationRoot: join(corpus, "exports", "complete"),
      policy,
    });

    const first = buildCorpusIndex(corpus);
    writeCorpusIndex(indexPath, first);
    const firstBytes = readFileSync(indexPath);
    writeCorpusIndex(indexPath, buildCorpusIndex(corpus));

    assert.deepEqual(readFileSync(indexPath), firstBytes);
    assert.equal(first.filter(({ manifestKind }) => manifestKind === "run").length, 4);
    assert.equal(queryCorpusIndex(first, { failureClass: "task" })[0]?.attemptId, "attempt-task-failed-1");
    assert.equal(queryCorpusIndex(first, { verifierStatus: "failed" })[0]?.attemptId, "attempt-task-failed-1");
    assert.equal(queryCorpusIndex(first, { failureClass: "infrastructure" })[0]?.attemptId, "attempt-interrupted-1");
    assert.equal(queryCorpusIndex(first, { exportStatus: "ready" }).length, 1);
    assert.equal(queryCorpusIndex(first, { runId: "run-complete" })[0]?.attemptNumber, 1);
    const indexed = readCorpusIndex(indexPath);
    assert.deepEqual(validateCorpusIndex(corpus, indexed), []);
    assert.ok(validateCorpusIndex(corpus, [...indexed, indexed[0]!]).some(({ kind }) => kind === "duplicate"));
    const stale = structuredClone(indexed);
    stale.find(({ manifestKind }) => manifestKind === "run")!.taskId = "stale-task";
    assert.ok(validateCorpusIndex(corpus, stale).some(({ kind }) => kind === "stale"));

    const missingManifestPath = join(corpus, "runs", "interrupted", "manifest.json");
    const missingManifestBytes = readFileSync(missingManifestPath);
    unlinkSync(missingManifestPath);
    assert.ok(validateCorpusIndex(corpus, indexed).some(({ kind }) => kind === "missing"));
    writeFileSync(missingManifestPath, missingManifestBytes);

    unlinkSync(join(corpus, "runs", "complete", "session.jsonl"));
    const missing = validateCorpusIndex(corpus, indexed);
    assert.ok(missing.some(({ kind, message }) => kind === "evidence" && /session\.jsonl|session/i.test(message)));

    const manifestPath = join(corpus, "runs", "task-failed", "manifest.json");
    writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}\n`);
    assert.ok(validateCorpusIndex(corpus, indexed).some(({ kind }) => kind === "digest-mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable archives are deterministic and contain only approved export files", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-portable-archive-"));
  const source = join(root, "source");
  const portable = join(root, "portable");
  const firstArchive = join(root, "first.tar.gz");
  const secondArchive = join(root, "second.tar.gz");
  const unpacked = join(root, "unpacked");
  try {
    cpSync(join(fixtures, "complete"), source, { recursive: true });
    const manifest = await createPortableRunBundleExport({ sourceRoot: source, destinationRoot: portable, policy });
    const longPath = `evidence/${"a".repeat(200)}/${"b".repeat(100)}`;
    const originalPath = manifest.artifacts[0]!.relativePath;
    mkdirSync(join(portable, dirname(longPath)), { recursive: true });
    renameSync(join(portable, originalPath), join(portable, longPath));
    manifest.artifacts[0]!.relativePath = longPath;
    writeFileSync(join(portable, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(portable, "restricted.txt"), "must not be packed");

    packPortableExport(portable, firstArchive);
    packPortableExport(portable, secondArchive);
    assert.deepEqual(readFileSync(firstArchive), readFileSync(secondArchive));
    assert.match(execFileSync(process.platform === "win32" ? "tar" : "/usr/bin/tar", ["-tzf", firstArchive], { encoding: "utf8" }), /bundle\/manifest\.json/);

    unpackPortableExport(firstArchive, unpacked);
    assert.equal(existsSync(join(unpacked, "restricted.txt")), false);
    assert.deepEqual(await readPortableRunBundleExport(unpacked, policy), manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable archive packing rejects a blocked export manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-blocked-archive-"));
  try {
    cpSync(join(fixtures, "complete", "export"), root, { recursive: true });
    assert.throws(() => packPortableExport(root, join(root, "blocked.tar.gz")), /ready or exported/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corpus CLI builds, queries, and validates the local index", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-corpus-cli-"));
  const corpus = join(root, "corpus");
  const indexPath = join(root, "index.jsonl");
  try {
    cpSync(join(fixtures, "task-failed"), join(corpus, "task-failed"), { recursive: true });
    let output = "";
    const write = (message: string) => { output += message; };
    assert.equal(main(["corpus", "build", corpus, indexPath], write), 0);
    assert.match(output, /Built 1 corpus index entry/);
    output = "";
    assert.equal(main(["corpus", "query", indexPath, "--failure-class", "task"], write), 0);
    assert.match(output, /attempt-task-failed-1/);
    output = "";
    assert.equal(main(["corpus", "validate", corpus, indexPath], write), 0);
    assert.match(output, /current/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
