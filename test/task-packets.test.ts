import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  admitTaskPacket,
  defaultFreezeLocator,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  inspectTaskPacket,
  MAX_TASK_PACKET_METADATA_BYTES,
  main,
  modelVisibleTaskPacket,
  readVerifiedArtifact,
  resolveBundleArtifact,
  resolveBundleArtifactDigest,
  statusTaskPacket,
  type TaskPacket,
} from "../src/index.js";
import { writeMetadataAtomicallyIfAbsentSync } from "../src/artifacts.js";
import { closeBundleRoot, openBundleRoot } from "../src/contracts.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = (name: string) => join(repositoryRoot, "tests", "fixtures", name);
function tarGzipArchive(entries: Array<{ path: string; bytes: Buffer; type?: string }>): Buffer {
  const blocks = entries.map(({ path, bytes, type = "0" }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
    return Buffer.concat([header, bytes, padding]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function fixtureArchive(): Buffer {
  const entries: Array<{ path: string; bytes: Buffer; type?: string }> = [
    { path: "README.md", bytes: Buffer.from("# fixture\n") },
    { path: "package.json", bytes: Buffer.from("{}\n") },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n") },
  ];
  return tarGzipArchive(entries);
}

function tarNumericWhitespaceArchive(): Buffer {
  const archive = gunzipSync(tarGzipArchive([{ path: "README.md", bytes: Buffer.from("safe") }]));
  archive.write("00000000004\t", 124, "ascii");
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((sum, value) => sum + value, 0);
  archive.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return gzipSync(archive);
}

function tarLegacyPrefixArchive(): Buffer {
  const archive = gunzipSync(tarGzipArchive([{ path: "README.md", bytes: Buffer.from("safe") }]));
  archive.write("legacy-prefix", 345, "ascii");
  archive.fill(0, 257, 263);
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((sum, value) => sum + value, 0);
  archive.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return gzipSync(archive);
}

function tarOldGnuPrefixArchive(): Buffer {
  const archive = gunzipSync(tarGzipArchive([{ path: "README.md", bytes: Buffer.from("safe") }]));
  archive.write("legacy-prefix", 345, "ascii");
  archive.write("ustar ", 257, "ascii");
  archive.write(" \0", 263, "ascii");
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((sum, value) => sum + value, 0);
  archive.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return gzipSync(archive);
}

function packetFixture(name = "task-packet.valid.v1.json"): TaskPacket {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as TaskPacket;
}

function createBundle(packet = packetFixture()): { root: string; packet: TaskPacket } {
  const root = mkdtempSync(join(tmpdir(), "ebo-task-packet-"));
  const components = {
    fixture: fixtureArchive(),
    perturbation: Buffer.from('{"kind":"controlled"}\n'),
    reference: Buffer.from("reference solution\n"),
    verifier: Buffer.from("#!/bin/sh\nexit 0\n"),
    review: Buffer.from('{"decision":"pass"}\n'),
  };
  packet.agentInput.fixture.source.locator = "fixture.bin";
  packet.agentInput.fixture.source.digest = digestBytes(components.fixture);
  if ("reference" in packet.controlledPerturbation) {
    packet.controlledPerturbation.reference.locator = "perturbation.json";
    packet.controlledPerturbation.reference.digest = digestBytes(components.perturbation);
  }
  if ("locator" in packet.restricted.referenceSolution) {
    packet.restricted.referenceSolution.locator = "reference.txt";
    packet.restricted.referenceSolution.digest = digestBytes(components.reference);
  }
  packet.restricted.verifier.locator = "verifier.sh";
  packet.restricted.verifier.digest = digestBytes(components.verifier);
  if (packet.admission.review !== null) {
    packet.admission.review.reviewRecord.locator = "review.json";
    const preAdmission = structuredClone(packet);
    delete (preAdmission as unknown as Record<string, unknown>).admission;
    components.review = Buffer.from(JSON.stringify({
      preAdmissionDigest: digestMetadata(preAdmission),
      decision: packet.admission.status,
      reviewedAt: packet.admission.review!.reviewedAt,
      reviewedBy: packet.admission.review!.reviewedBy,
    }));
    packet.admission.review.reviewRecord.digest = digestBytes(components.review);
  }

  writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
  for (const [name, bytes] of Object.entries(components)) writeFileSync(join(root, `${name}.bin`), bytes);
  writeFileSync(join(root, "perturbation.json"), components.perturbation);
  writeFileSync(join(root, "reference.txt"), components.reference);
  writeFileSync(join(root, "verifier.sh"), components.verifier);
  writeFileSync(join(root, "review.json"), components.review);
  return { root, packet };
}

function replaceFixture(root: string, packet: TaskPacket, bytes: Buffer): void {
  packet.agentInput.fixture.source.digest = digestBytes(bytes);
  writeFileSync(join(root, "fixture.bin"), bytes);
  writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
}

test("freezing a packet is idempotent and keeps the model projection private", () => {
  const { root, packet } = createBundle();
  try {
    const cwd = process.cwd();
    const first = freezeTaskPacket(root, "packet.json");
    assert.equal(process.cwd(), cwd);
    const second = freezeTaskPacket(root, "packet.json");
    assert.deepEqual(second, first);
    assert.equal(first.components.prompt.algorithm, "sha256");
    assert.equal(first.components.fixture!.value, digestBytes(fixtureArchive()).value);
    assert.equal(statusTaskPacket(root, "packet.json").status, "frozen");
    assert.deepEqual(modelVisibleTaskPacket(packet), packet.agentInput);
    assert.doesNotMatch(JSON.stringify(modelVisibleTaskPacket(packet)), /referenceSolution|reviewRecord|verifier/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("freeze keeps a relative bundle root during pre-link validation", () => {
  const { root } = createBundle();
  const bundleRoot = relative(process.cwd(), root);
  try {
    const record = freezeTaskPacket(bundleRoot, "packet.json");
    assert.equal(record.packetLocator, "packet.json");
    assert.equal(statusTaskPacket(bundleRoot, "packet.json").status, "frozen");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});


test("status identifies every frozen component mutation", () => {
  for (const mutation of ["prompt", "fixture", "reference", "verifier", "reviewRecord", "controlledPerturbation"]) {
    const { root, packet } = createBundle();
    try {
      freezeTaskPacket(root, "packet.json");
      if (mutation === "prompt") {
        packet.agentInput.prompt = "A changed prompt.";
        writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
      } else {
        const paths: Record<string, string> = {
          fixture: "fixture.bin",
          reference: "reference.txt",
          verifier: "verifier.sh",
          reviewRecord: "review.json",
          controlledPerturbation: "perturbation.json",
        };
        writeFileSync(join(root, paths[mutation]!), Buffer.from(`changed ${mutation}`));
      }
      const status = statusTaskPacket(root, "packet.json");
      assert.ok(status.mismatches.some((value) => value.endsWith(`.${mutation}`)), `${mutation}: ${JSON.stringify(status)}`);
      assert.notEqual(status.status, "frozen");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("freeze preserves unavailable declaration states", () => {
  const packet = packetFixture();
  packet.restricted.referenceSolution = { status: "unsupported" };
  packet.controlledPerturbation = { status: "not-applied" };
  const { root } = createBundle(packet);
  try {
    const record = freezeTaskPacket(root, "packet.json");
    assert.deepEqual(record.components.reference, { status: "unsupported" });
    assert.deepEqual(record.components.controlledPerturbation, { status: "not-applied" });
    assert.equal(statusTaskPacket(root, "packet.json").status, "frozen");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("admission requires a passing recorded human decision", () => {
  const proposed = createBundle(packetFixture("task-packet.proposed.v1.json"));
  try {
    const result = admitTaskPacket(proposed.root, "packet.json");
    assert.ok(result.errors.some((error) => error.field === "/admission/status"));
    assert.equal(main(["task-packet", "admit", proposed.root, "packet.json"], () => 0), 1);
  } finally {
    rmSync(proposed.root, { force: true, recursive: true });
  }

  const unknown = createBundle();
  try {
    unknown.packet.sharing.classification = "unknown" as TaskPacket["sharing"]["classification"];
    writeFileSync(join(unknown.root, "packet.json"), JSON.stringify(unknown.packet, null, 2));
    assert.ok(admitTaskPacket(unknown.root, "packet.json").errors.some((error) => error.field.includes("classification")));
  } finally {
    rmSync(unknown.root, { force: true, recursive: true });
  }
});

test("admission rejects a review record bound to another packet", () => {
  const { root, packet } = createBundle();
  try {
    const foreign = structuredClone(packet);
    foreign.id = "foreign-packet";
    delete (foreign as unknown as Record<string, unknown>).admission;
    const review = Buffer.from(JSON.stringify({ preAdmissionDigest: digestMetadata(foreign) }));
    writeFileSync(join(root, "review.json"), review);
    packet.admission.review!.reviewRecord.digest = digestBytes(review);
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    const result = admitTaskPacket(root, "packet.json");
    assert.ok(result.errors.some((error) => /pre-admission digest/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("packet inspection rejects duplicate JSON keys before parsing", () => {
  const { root } = createBundle();
  try {
    const packetPath = join(root, "packet.json");
    const text = readFileSync(packetPath, "utf8").replace(
      /("id"\s*:\s*"[^"]+",)/,
      "$1\"id\":\"duplicate\",",
    );
    writeFileSync(packetPath, text);
    const result = inspectTaskPacket(root, "packet.json");
    assert.ok(result.errors.some((error) => /duplicate JSON object keys/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("admission rejects packet decision metadata changed after review", () => {
  for (const mutation of ["status", "reviewedAt", "reviewedBy"] as const) {
    const { root, packet } = createBundle();
    try {
      if (mutation === "status") packet.admission.status = "rejected";
      if (mutation === "reviewedAt") packet.admission.review!.reviewedAt = "2026-08-29T00:00:01Z";
      if (mutation === "reviewedBy") packet.admission.review!.reviewedBy = "another-reviewer";
      writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
      const result = admitTaskPacket(root, "packet.json");
      assert.ok(result.errors.some((error) => /admission decision/.test(error.message)), mutation);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("inspection enforces the fixture compressed-byte limit", () => {
  const { root, packet } = createBundle();
  try {
    packet.agentInput.fixture.source.limits.maxCompressedBytes = 1;
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    const result = admitTaskPacket(root, "packet.json");
    assert.ok(result.errors.some((error) => /exceeds its maximum bytes/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("inspection validates fixture archives before admission", () => {
  const invalidCases: Array<{
    bytes: Buffer;
    expected: RegExp;
    mutate?: (packet: TaskPacket) => void;
  }> = [
    { bytes: Buffer.from("not a gzip archive"), expected: /valid gzip stream/ },
    {
      bytes: fixtureArchive(),
      expected: /No archive entries were selected/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["missing"]; },
    },
    {
      bytes: fixtureArchive(),
      expected: /materialization limits/,
      mutate: (packet) => { packet.agentInput.fixture.source.limits.maxExpandedBytes = 1; },
    },
    {
      bytes: fixtureArchive(),
      expected: /materialization limits/,
      mutate: (packet) => { packet.agentInput.fixture.source.limits.maxMembers = 1; },
    },
    {
      bytes: tarGzipArchive([
        { path: "src", bytes: Buffer.alloc(0), type: "5" },
        { path: "src/link", bytes: Buffer.alloc(0), type: "2" },
      ]),
      expected: /unsafe/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["src"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "PaxHeader", bytes: Buffer.from("10 size=1\n"), type: "x" },
        { path: "README.md", bytes: Buffer.from("0123456789") },
      ]),
      expected: /PAX size/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "GlobalHeader", bytes: Buffer.from("16 path=../evil\n"), type: "g" },
        { path: "README.md", bytes: Buffer.from("safe") },
      ]),
      expected: /unsupported global PAX/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "PaxHeader", bytes: Buffer.from("16 path=../evil\n"), type: "X" },
        { path: "README.md", bytes: Buffer.from("safe") },
      ]),
      expected: /unsupported uppercase local PAX/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "PaxHeader", bytes: Buffer.from("12x path=aa\n"), type: "x" },
        { path: "README.md", bytes: Buffer.from("safe") },
      ]),
      expected: /PAX record length/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "PaxHeader", bytes: Buffer.from("12 size=1e1\n"), type: "x" },
        { path: "README.md", bytes: Buffer.from("0123456789") },
      ]),
      expected: /invalid PAX size/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "PaxHeader", bytes: Buffer.from("27 GNU.sparse.realsize=100\n"), type: "x" },
        { path: "README.md", bytes: Buffer.from("safe") },
      ]),
      expected: /unsupported sparse PAX/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "PaxHeader", bytes: Buffer.from("30 SCHILY.realsize=1000000000\n"), type: "x" },
        { path: "README.md", bytes: Buffer.from("safe") },
      ]),
      expected: /unsupported sparse PAX/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([
        { path: "PaxHeader", bytes: Buffer.from("21 SUN.holesdata=0,1\n"), type: "x" },
        { path: "README.md", bytes: Buffer.from("safe") },
      ]),
      expected: /unsupported sparse PAX/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarGzipArchive([{ path: "README.md\n", bytes: Buffer.from("safe") }]),
      expected: /No archive entries were selected/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarNumericWhitespaceArchive(),
      expected: /invalid TAR size/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarLegacyPrefixArchive(),
      expected: /prefix without USTAR/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
    {
      bytes: tarOldGnuPrefixArchive(),
      expected: /prefix without USTAR/,
      mutate: (packet) => { packet.agentInput.fixture.materializer.includePaths = ["README.md"]; },
    },
  ];

  for (const invalidCase of invalidCases) {
    const { root, packet } = createBundle(packetFixture("task-packet.proposed.v1.json"));
    try {
      invalidCase.mutate?.(packet);
      replaceFixture(root, packet, invalidCase.bytes);
      const result = inspectTaskPacket(root, "packet.json");
      assert.ok(result.errors.some((error) => invalidCase.expected.test(error.message)), JSON.stringify(result));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("inspection honors declared expanded archive limits above 64 MiB", () => {
  const { root, packet } = createBundle(packetFixture("task-packet.proposed.v1.json"));
  const expandedBytes = 65 * 1024 * 1024;
  const archive = tarGzipArchive([{ path: "README.md", bytes: Buffer.alloc(expandedBytes, 0x61) }]);
  try {
    packet.agentInput.fixture.source.limits.maxExpandedBytes = expandedBytes + 1;
    packet.agentInput.fixture.materializer.includePaths = ["README.md"];
    replaceFixture(root, packet, archive);
    const result = inspectTaskPacket(root, "packet.json");
    assert.deepEqual(result.errors, []);
    assert.ok(result.components !== null);
    assert.equal(result.components.fixture?.value, digestBytes(archive).value);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent metadata writes preserve the first freeze", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-freeze-race-"));
  try {
    const first = writeMetadataAtomicallyIfAbsentSync(root, "freeze.json", { winner: "first" });
    const second = writeMetadataAtomicallyIfAbsentSync(root, "freeze.json", { winner: "second" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.digest, first.digest);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "freeze.json"), "utf8")), { winner: "first" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("concurrent publishers observe one complete winner", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-concurrent-publication-"));
  const gate = join(root, "start");
  const moduleUrl = pathToFileURL(join(repositoryRoot, "dist/src/artifacts.js")).href;
  const source = `
    import { existsSync } from "node:fs";
    import { writeMetadataAtomicallyIfAbsentSync } from ${JSON.stringify(moduleUrl)};
    const [root, gate, winner] = process.argv.slice(1);
    while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    process.stdout.write(JSON.stringify(writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { winner })));
  `;
  const run = (winner: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, root, gate, winner], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    return { child, result: once(child, "close").then(([code]) => {
      assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
      return JSON.parse(Buffer.concat(stdout).toString("utf8")) as { created: boolean; digest: unknown };
    }) };
  };

  try {
    const first = run("first");
    const second = run("second");
    await Promise.all([once(first.child, "spawn"), once(second.child, "spawn")]);
    writeFileSync(gate, "go");
    const results = await Promise.all([first.result, second.result]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.deepEqual(results[0]!.digest, results[1]!.digest);
    assert.ok(["first", "second"].includes(JSON.parse(readFileSync(join(root, "metadata.json"), "utf8")).winner));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent metadata writes remain readable through the artifact API", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-readable-metadata-"));
  try {
    const written = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    const staleAlias = join(root, ".00000000-0000-4000-8000-000000000000.tmp");
    linkSync(join(root, "metadata.json"), staleAlias);
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", written.digest), Buffer.from('{"state":"ready"}'));
    assert.equal(existsSync(staleAlias), false);
    linkSync(join(root, "metadata.json"), staleAlias);
    assert.deepEqual(resolveBundleArtifact(root, { locator: "metadata.json", digest: written.digest }), Buffer.from('{"state":"ready"}'));
    assert.equal(existsSync(staleAlias), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("publication callback failures preserve the no-clobber boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-publication-callbacks-"));
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "before.json", { state: "ready" }, undefined, () => {
        throw new Error("before publication");
      }),
      /before publication/,
    );
    assert.equal(existsSync(join(root, "before.json")), false);

    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "after.json", { state: "ready" }, undefined, undefined, () => {
        throw new Error("after publication");
      }),
      /after publication/,
    );
    const digest = digestMetadata({ state: "ready" });
    assert.deepEqual(await readVerifiedArtifact(root, "after.json", digest), Buffer.from('{"state":"ready"}'));
    const retry = writeMetadataAtomicallyIfAbsentSync(root, "after.json", { state: "changed" });
    assert.equal(retry.created, false);
    assert.deepEqual(retry.digest, digest);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("stale unique temporary names do not block publication", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-stale-publication-temp-"));
  const stale = join(root, ".00000000-0000-4000-8000-000000000000.tmp");
  try {
    writeFileSync(stale, "stale");
    const result = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.equal(result.created, true);
    assert.equal(readFileSync(stale, "utf8"), "stale");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});


test("freeze publication rejects a symlinked ancestor", () => {
  const { root } = createBundle();
  const outside = mkdtempSync(join(tmpdir(), "ebo-freeze-outside-"));
  try {
    symlinkSync(outside, join(root, "nested"));
    assert.throws(() => freezeTaskPacket(root, "packet.json", "nested/freeze.json"), /symbolic link/);
    assert.equal(existsSync(join(outside, "freeze.json")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("component resolution stays bound to its verified bundle root", () => {
  const original = createBundle();
  const replacement = createBundle();
  const alias = join(tmpdir(), `ebo-root-alias-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  symlinkSync(original.root, alias);
  const root = openBundleRoot(alias);
  try {
    rmSync(alias, { force: true });
    symlinkSync(replacement.root, alias);
    assert.throws(
      () => resolveBundleArtifactDigest(alias, { locator: "verifier.sh", digest: original.packet.restricted.verifier.digest }, root),
      /bundle root changed/,
    );
  } finally {
    closeBundleRoot(root);
    rmSync(alias, { force: true });
    rmSync(original.root, { force: true, recursive: true });
    rmSync(replacement.root, { force: true, recursive: true });
  }
});

test("bundle reads reject a root replacement during initial CWD setup", () => {
  const original = createBundle();
  const outside = mkdtempSync(join(tmpdir(), "ebo-root-cwd-outside-"));
  const rootHandle = openBundleRoot(original.root);
  const originalLstatSync = fs.lstatSync;
  const mutableFs = fs as unknown as { lstatSync: typeof originalLstatSync };
  let swapped = false;
  mutableFs.lstatSync = ((path: fs.PathLike, ...args: Parameters<typeof originalLstatSync> extends [fs.PathLike, ...infer Rest] ? Rest : never) => {
    const result = originalLstatSync(path, ...args);
    if (!swapped && path === rootHandle.path) {
      swapped = true;
      renameSync(original.root, `${original.root}-original`);
      symlinkSync(outside, original.root);
    }
    return result;
  }) as typeof originalLstatSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => resolveBundleArtifactDigest(original.root, {
        locator: "verifier.sh",
        digest: original.packet.restricted.verifier.digest,
      }, rootHandle),
      /bundle root changed/,
    );
    assert.equal(swapped, true);
  } finally {
    mutableFs.lstatSync = originalLstatSync;
    syncBuiltinESMExports();
    closeBundleRoot(rootHandle);
    rmSync(original.root, { force: true });
    rmSync(`${original.root}-original`, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("bundle reads reject an intermediate directory swap", () => {
  const { root } = createBundle(packetFixture("task-packet.proposed.v1.json"));
  const outside = mkdtempSync(join(tmpdir(), "ebo-read-outside-"));
  const nested = join(root, "nested");
  const originalLstatSync = fs.lstatSync;
  const mutableFs = fs as unknown as { lstatSync: typeof originalLstatSync };
  let swapped = false;
  mkdirSync(nested);
  renameSync(join(root, "packet.json"), join(nested, "packet.json"));
  mutableFs.lstatSync = ((path: fs.PathLike, ...args: Parameters<typeof originalLstatSync> extends [fs.PathLike, ...infer Rest] ? Rest : never) => {
    const result = originalLstatSync(path, ...args);
    if (!swapped && path === "nested") {
      swapped = true;
      renameSync(nested, join(root, "nested-original"));
      symlinkSync(outside, nested);
    }
    return result;
  }) as typeof originalLstatSync;
  syncBuiltinESMExports();
  try {
    const inspection = inspectTaskPacket(root, "nested/packet.json");
    assert.equal(swapped, true);
    assert.ok(inspection.errors.some((error) => /parent changed|symbolic link|escapes/.test(error.message)));
    assert.equal(existsSync(join(outside, "packet.json")), false);
  } finally {
    mutableFs.lstatSync = originalLstatSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("nested freeze-directory preparation does not follow an ancestor link", () => {
  const { root } = createBundle();
  const outside = mkdtempSync(join(tmpdir(), "ebo-freeze-nested-outside-"));
  try {
    symlinkSync(outside, join(root, "nested"));
    assert.throws(() => freezeTaskPacket(root, "packet.json", "nested/inner/freeze.json"), /symbolic link/);
    assert.equal(existsSync(join(outside, "inner", "freeze.json")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("freeze validates its constructed record and bounds the default locator", () => {
  const { root } = createBundle();
  try {
    writeFileSync(join(root, ".packet.json"), readFileSync(join(root, "packet.json")));
    assert.throws(() => freezeTaskPacket(root, ".packet.json", "freeze.json"), /packetLocator/);
    assert.equal(existsSync(join(root, "freeze.json")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }

  const validLocator = Array.from({ length: 5 }, () => "a".repeat(180)).join("/");
  assert.equal(defaultFreezeLocator(validLocator), `${validLocator}.freeze.json`);

  const nearLimit = Array.from({ length: 5 }, () => "a".repeat(190)).join("/");
  assert.throws(() => defaultFreezeLocator(nearLimit), /exceeds safe path limits/);
});

test("status never reports an unadmitted packet as frozen", () => {
  const { root, packet } = createBundle();
  try {
    freezeTaskPacket(root, "packet.json");
    packet.admission.status = "rejected";
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.ok(status.mismatches.includes("packet"));
    assert.ok(status.mismatches.includes("components.reviewRecord"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status reports a malformed freeze record as invalid", () => {
  const { root } = createBundle();
  try {
    writeFileSync(join(root, "packet.json.freeze.json"), "{\n");
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.deepEqual(status.mismatches, ["freeze-record"]);
    assert.equal(status.errors[0]?.schemaVersion, "ebo.task-packet-freeze/v1");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status rejects a document with the wrong freeze-record schema", () => {
  const { root, packet } = createBundle();
  try {
    writeFileSync(join(root, "packet.json.freeze.json"), JSON.stringify(packet));
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.deepEqual(status.mismatches, ["freeze-record"]);
    assert.ok(status.errors.some((error) => /ebo\.task-packet-freeze\/v1/.test(error.message)));
    assert.throws(() => freezeTaskPacket(root, "packet.json"), /ebo\.task-packet-freeze\/v1/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("packet inspection rejects a document with the wrong schema", () => {
  const { root, packet } = createBundle();
  try {
    packet.schemaVersion = "ebo.task-packet-freeze/v1" as TaskPacket["schemaVersion"];
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet));
    const result = admitTaskPacket(root, "packet.json");
    assert.equal(result.packet, null);
    assert.ok(result.errors.some((error) => /ebo\.task-packet\/v1/.test(error.message)));
    assert.equal(statusTaskPacket(root, "packet.json").status, "invalid");
    assert.throws(() => freezeTaskPacket(root, "packet.json"), /ebo\.task-packet\/v1/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("packet and freeze JSON reads enforce the metadata size limit", () => {
  const { root, packet } = createBundle();
  try {
    packet.agentInput.prompt = "x".repeat(MAX_TASK_PACKET_METADATA_BYTES);
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet));
    assert.ok(admitTaskPacket(root, "packet.json").errors.some((error) => /metadata size limit/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }

  const frozen = createBundle();
  try {
    freezeTaskPacket(frozen.root, "packet.json");
    const freezePath = join(frozen.root, "packet.json.freeze.json");
    writeFileSync(freezePath, `${readFileSync(freezePath, "utf8")}${" ".repeat(MAX_TASK_PACKET_METADATA_BYTES)}`);
    const status = statusTaskPacket(frozen.root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.ok(status.errors.some((error) => /metadata size limit/.test(error.message)));
  } finally {
    rmSync(frozen.root, { force: true, recursive: true });
  }
});

test("unrestricted component digests stream without buffering the file", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-streaming-digest-"));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  const expected = digestBytes(bytes);
  try {
    writeFileSync(join(root, "large-verifier.bin"), bytes);
    assert.deepEqual(resolveBundleArtifactDigest(root, { locator: "large-verifier.bin", digest: expected }), expected);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("same-size component rewrites are rejected", () => {
  const { root } = createBundle();
  try {
    freezeTaskPacket(root, "packet.json");
    const verifierPath = join(root, "verifier.sh");
    const original = readFileSync(verifierPath);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 35 ? 36 : 35;
    assert.equal(changed.length, original.length);
    writeFileSync(verifierPath, changed);
    const status = statusTaskPacket(root, "packet.json");
    assert.notEqual(status.status, "frozen");
    assert.ok(status.errors.some((error) => /digest does not match/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status detects a freeze timestamp mutation", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  try {
    freezeTaskPacket(root, "packet.json");
    const record = JSON.parse(readFileSync(freezePath, "utf8")) as { frozenAt: string };
    record.frozenAt = "2026-08-29T00:00:00Z";
    writeFileSync(freezePath, JSON.stringify(record));
    const status = statusTaskPacket(root, "packet.json");
    assert.notEqual(status.status, "frozen");
    assert.ok(status.mismatches.includes("aggregate"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});


test("task-packet CLI exposes validate, freeze, and status", () => {
  const { root } = createBundle();
  try {
    let output = "";
    assert.equal(main(["task-packet", "validate", root, "packet.json"], (message) => (output += message)), 0);
    assert.match(output, /Validated task packet/);
    output = "";
    assert.equal(main(["task-packet", "freeze", root, "packet.json"], (message) => (output += message)), 0);
    assert.match(output, /Frozen task packet.*aggregate sha256:/);
    output = "";
    assert.equal(main(["task-packet", "status", root, "packet.json"], (message) => (output += message)), 0);
    assert.match(output, /Task packet status: frozen/);
    assert.match(output, /Aggregate digest: sha256:/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
