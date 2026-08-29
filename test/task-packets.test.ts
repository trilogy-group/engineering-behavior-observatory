import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  writeMetadataAtomicallyIfAbsentSync,
  type TaskPacket,
} from "../src/index.js";
import { closeBundleRoot, openBundleRoot } from "../src/contracts.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = (name: string) => join(repositoryRoot, "tests", "fixtures", name);
const currentProcessStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trim();

function packetFixture(name = "task-packet.valid.v1.json"): TaskPacket {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as TaskPacket;
}

function createBundle(packet = packetFixture()): { root: string; packet: TaskPacket } {
  const root = mkdtempSync(join(tmpdir(), "ebo-task-packet-"));
  const components = {
    fixture: Buffer.from("fixture bytes"),
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

test("freezing a packet is idempotent and keeps the model projection private", () => {
  const { root, packet } = createBundle();
  try {
    const cwd = process.cwd();
    const first = freezeTaskPacket(root, "packet.json");
    assert.equal(process.cwd(), cwd);
    const second = freezeTaskPacket(root, "packet.json");
    assert.deepEqual(second, first);
    assert.equal(first.components.prompt.algorithm, "sha256");
    assert.equal(first.components.fixture!.value, digestBytes(Buffer.from("fixture bytes")).value);
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

test("create-if-absent metadata writes remain readable through the artifact API", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-readable-metadata-"));
  try {
    const written = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", written.digest), Buffer.from('{"state":"ready"}'));
    assert.deepEqual(resolveBundleArtifact(root, { locator: "metadata.json", digest: written.digest }), Buffer.from('{"state":"ready"}'));
    const plain = Buffer.from("plain artifact");
    writeFileSync(join(root, "plain.json"), plain);
    linkSync(join(root, "plain.json"), join(root, "plain-alias"));
    const plainDigest = digestBytes(plain);
    await assert.rejects(readVerifiedArtifact(root, "plain.json", plainDigest), /not an isolated regular file/);
    assert.throws(() => resolveBundleArtifact(root, { locator: "plain.json", digest: plainDigest }), /not an isolated regular file/);
    for (const suffix of [".quarantine", ".recovered"]) {
      const unownedPath = join(root, `unowned${suffix.slice(1)}.json`);
      writeFileSync(unownedPath, plain);
      linkSync(unownedPath, `${unownedPath}${suffix}`);
      await assert.rejects(
        readVerifiedArtifact(root, `unowned${suffix.slice(1)}.json`, plainDigest),
        /not an isolated regular file/,
      );
      assert.throws(
        () => resolveBundleArtifact(root, { locator: `unowned${suffix.slice(1)}.json`, digest: plainDigest }),
        /not an isolated regular file/,
      );
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication recovers interrupted quarantine staging", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-staging-recovery-"));
  const staging = join(root, "metadata.json.quarantine");
  const marker = `${staging}.marker`;
  const binding = `${marker}.binding.tmp`;
  const metadata = { state: "ready" };
  try {
    writeFileSync(staging, "partial");
    chmodSync(staging, 0o600);
    const stagingIdentity = lstatSync(staging);
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".11111111-1111-4111-8111-111111111111.tmp",
      attemptId: "11111111-1111-4111-8111-111111111111",
      ownerPid: 999999999,
      ownerStart: "dead",
    }));
    chmodSync(marker, 0o600);
    writeFileSync(binding, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".11111111-1111-4111-8111-111111111111.tmp",
      attemptId: "11111111-1111-4111-8111-111111111111",
      ownerPid: 999999999,
      ownerStart: "dead",
      stagingIdentity: { dev: stagingIdentity.dev, ino: stagingIdentity.ino },
    }));
    chmodSync(binding, 0o600);
    const result = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", metadata);
    assert.equal(result.created, true);
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", result.digest), Buffer.from('{"state":"ready"}'));
    assert.equal(existsSync(staging), true);
    assert.equal(readdirSync(root).some((name) => name.endsWith(".failed")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves a replacement staging path during recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-replaced-staging-recovery-"));
  const quarantine = join(root, "metadata.json.quarantine");
  const marker = `${quarantine}.marker`;
  const staging = join(root, ".cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp");
  const binding = `${marker}.binding`;
  const bindingTemporary = `${binding}.tmp`;
  try {
    writeFileSync(quarantine, "old staging bytes");
    chmodSync(quarantine, 0o600);
    const quarantineIdentity = lstatSync(quarantine);
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp",
      attemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ownerPid: 999999999,
      ownerStart: "dead",
    }));
    chmodSync(marker, 0o600);
    writeFileSync(bindingTemporary, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp",
      attemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ownerPid: 999999999,
      ownerStart: "dead",
      stagingIdentity: { dev: quarantineIdentity.dev, ino: quarantineIdentity.ino },
    }));
    chmodSync(bindingTemporary, 0o600);
    linkSync(bindingTemporary, binding);
    writeFileSync(staging, "unrelated replacement");
    chmodSync(staging, 0o600);
    const result = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.equal(result.created, true);
    assert.equal(readFileSync(staging, "utf8"), "unrelated replacement");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves unbound dead-owner staging", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-unbound-staging-recovery-"));
  const staging = join(root, "metadata.json.quarantine");
  const marker = `${staging}.marker`;
  try {
    writeFileSync(staging, "partial");
    chmodSync(staging, 0o600);
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".55555555-5555-4555-8555-555555555555.tmp",
      attemptId: "55555555-5555-4555-8555-555555555555",
      ownerPid: 999999999,
      ownerStart: "dead",
    }));
    chmodSync(marker, 0o600);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied/,
    );
    assert.equal(existsSync(staging), true);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication recovers a marker-only interruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-marker-only-recovery-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".22222222-2222-4222-8222-222222222222.tmp",
      attemptId: "22222222-2222-4222-8222-222222222222",
      ownerPid: 999999999,
      ownerStart: "dead",
    }));
    chmodSync(marker, 0o600);
    const result = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.equal(result.created, true);
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", result.digest), Buffer.from('{"state":"ready"}'));
    assert.equal(readdirSync(root).some((name) => name.endsWith(".failed")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves an unowned partial marker sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-partial-marker-recovery-"));
  const markerTemporary = join(root, "metadata.json.quarantine.marker.tmp");
  try {
    writeFileSync(markerTemporary, "{");
    chmodSync(markerTemporary, 0o600);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied/,
    );
    assert.equal(readFileSync(markerTemporary, "utf8"), "{");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves an unowned partial binding sidecar", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-partial-binding-recovery-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  const bindingTemporary = `${marker}.binding.tmp`;
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".99999999-9999-4999-8999-999999999999.tmp",
      attemptId: "99999999-9999-4999-8999-999999999999",
      ownerPid: 999999999,
      ownerStart: "dead",
    }));
    chmodSync(marker, 0o600);
    writeFileSync(bindingTemporary, "{");
    chmodSync(bindingTemporary, 0o600);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied|EEXIST|binding/,
    );
    assert.equal(readFileSync(bindingTemporary, "utf8"), "{");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication rejects a FIFO binding sidecar without blocking", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-fifo-binding-recovery-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  const bindingTemporary = `${marker}.binding.tmp`;
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".dddddddd-dddd-4ddd-8ddd-dddddddddddd.tmp",
      attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ownerPid: 999999999,
      ownerStart: "dead",
    }));
    chmodSync(marker, 0o600);
    execFileSync("mkfifo", [bindingTemporary]);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied|EEXIST|binding/,
    );
    assert.equal(lstatSync(bindingTemporary).isFIFO(), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves unowned binding sidecars during marker recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-unowned-binding-recovery-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  const binding = `${marker}.binding`;
  const bindingTemporary = `${binding}.tmp`;
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".88888888-8888-4888-8888-888888888888.tmp",
      attemptId: "88888888-8888-4888-8888-888888888888",
      ownerPid: 999999999,
      ownerStart: "dead",
    }));
    chmodSync(marker, 0o600);
    writeFileSync(binding, "unrelated binding");
    writeFileSync(bindingTemporary, "unrelated binding temp");
    chmodSync(binding, 0o600);
    chmodSync(bindingTemporary, 0o600);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied|binding/,
    );
    assert.equal(readFileSync(binding, "utf8"), "unrelated binding");
    assert.equal(readFileSync(bindingTemporary, "utf8"), "unrelated binding temp");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves a newer binding during marker recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-binding-recovery-race-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  const staging = join(root, ".bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp");
  const binding = `${marker}.binding`;
  const bindingTemporary = `${binding}.tmp`;
  const markerRecord = {
    schemaVersion: "ebo.publication-staging/v1",
    relativePath: "metadata.json",
    stagingPath: ".bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp",
    attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ownerPid: 999999999,
    ownerStart: "dead",
  };
  const originalOpenSync = fs.openSync;
  let replaced = false;
  fs.openSync = ((path: fs.PathLike, ...args: Parameters<typeof originalOpenSync> extends [fs.PathLike, ...infer Rest] ? Rest : never) => {
    const descriptor = originalOpenSync(path, ...args);
    if (!replaced && typeof path === "string" && path === "metadata.json.quarantine.marker.binding.tmp") {
      replaced = true;
      fs.unlinkSync(binding);
      writeFileSync(binding, "new publisher binding");
      chmodSync(binding, 0o600);
    }
    return descriptor;
  }) as typeof originalOpenSync;
  syncBuiltinESMExports();
  try {
    writeFileSync(marker, JSON.stringify(markerRecord));
    chmodSync(marker, 0o600);
    writeFileSync(staging, "staging bytes");
    chmodSync(staging, 0o600);
    const stagingIdentity = lstatSync(staging);
    writeFileSync(bindingTemporary, JSON.stringify({
      ...markerRecord,
      stagingIdentity: { dev: stagingIdentity.dev, ino: stagingIdentity.ino },
    }));
    chmodSync(bindingTemporary, 0o600);
    linkSync(bindingTemporary, binding);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied|binding|changed/,
    );
    assert.equal(replaced, true);
    assert.equal(readFileSync(binding, "utf8"), "new publisher binding");
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication does not recover a live staging marker", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-live-marker-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".33333333-3333-4333-8333-333333333333.tmp",
      attemptId: "33333333-3333-4333-8333-333333333333",
      ownerPid: process.pid,
      ownerStart: currentProcessStart,
    }));
    chmodSync(marker, 0o600);
    assert.throws(() => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }), /ENOENT|already occupied/);
    assert.equal(readFileSync(marker, "utf8").includes("33333333-3333-4333-8333-333333333333"), true);
    assert.equal(readdirSync(root).some((name) => name.endsWith(".failed")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication recovers a marker with a reused PID", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-reused-pid-marker-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".44444444-4444-4444-8444-444444444444.tmp",
      attemptId: "44444444-4444-4444-8444-444444444444",
      ownerPid: process.pid,
      ownerStart: "different-process-start",
    }));
    chmodSync(marker, 0o600);
    const result = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.equal(result.created, true);
    assert.equal(readdirSync(root).some((name) => name.endsWith(".failed")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication recovers an unknown-start marker after owner death", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-unknown-start-marker-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp",
      attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerPid: 999999999,
      ownerStart: "unknown",
    }));
    chmodSync(marker, 0o600);
    const result = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.equal(result.created, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves unrecognized quarantine staging", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-staging-ownership-"));
  const staging = join(root, "metadata.json.quarantine");
  try {
    writeFileSync(staging, "not ours");
    chmodSync(staging, 0o600);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied/,
    );
    assert.equal(readFileSync(staging, "utf8"), "not ours");
    assert.deepEqual(readdirSync(root), ["metadata.json.quarantine"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves a pre-existing staging marker", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-marker-collision-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  try {
    writeFileSync(marker, "durable marker");
    chmodSync(marker, 0o600);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /EEXIST|already exists|marker/,
    );
    assert.equal(readFileSync(marker, "utf8"), "durable marker");
    assert.equal(existsSync(join(root, "metadata.json")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves a pre-existing staging binding", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-binding-collision-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  const binding = join(root, "metadata.json.quarantine.marker.binding");
  try {
    writeFileSync(binding, "durable binding");
    chmodSync(binding, 0o600);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied|binding/,
    );
    assert.equal(readFileSync(binding, "utf8"), "durable binding");
    assert.equal(existsSync(join(root, "metadata.json")), false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication moves the marker sidecar after staging-open failure", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-staging-open-failure-"));
  const originalOpenSync = fs.openSync;
  let injected = false;
  fs.openSync = ((path: fs.PathLike, ...args: Parameters<typeof originalOpenSync> extends [fs.PathLike, ...infer Rest] ? Rest : never) => {
    if (!injected && typeof path === "string" && /^\.[0-9a-f-]{36}\.tmp$/.test(path)) {
      injected = true;
      const error = new Error("injected staging-open failure") as NodeJS.ErrnoException;
      error.code = "EMFILE";
      throw error;
    }
    return originalOpenSync(path, ...args);
  }) as typeof originalOpenSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /injected staging-open failure/,
    );
    assert.equal(injected, true);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker")), false);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker.tmp")), false);
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".failed")).length, 2);
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication rejects a raced binding inode", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-binding-link-race-"));
  const originalLinkSync = fs.linkSync;
  let replaced = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!replaced && typeof existingPath === "string" && existingPath === "metadata.json.quarantine.marker.binding.tmp"
        && typeof newPath === "string" && newPath === "metadata.json.quarantine.marker.binding") {
      fs.unlinkSync(existingPath);
      writeFileSync(existingPath, "replacement binding");
      chmodSync(existingPath, 0o600);
      replaced = true;
    }
    return originalLinkSync(existingPath, newPath);
  }) as typeof originalLinkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /changed during linking|changed during failure preservation/,
    );
    assert.equal(replaced, true);
    assert.equal(readFileSync(join(root, "metadata.json.quarantine.marker.binding"), "utf8"), "replacement binding");
    assert.equal(existsSync(join(root, "metadata.json")), false);
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves marker temp after installation identity failure", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-marker-installation-failure-"));
  const originalLinkSync = fs.linkSync;
  let markerUnlinked = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    const result = originalLinkSync(existingPath, newPath);
    if (!markerUnlinked && typeof existingPath === "string" && existingPath === "metadata.json.quarantine.marker.tmp"
        && typeof newPath === "string" && newPath === "metadata.json.quarantine.marker") {
      markerUnlinked = true;
      fs.unlinkSync(newPath);
    }
    return result;
  }) as typeof originalLinkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /changed during installation|ENOENT/,
    );
    assert.equal(markerUnlinked, true);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker")), false);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker.tmp")), false);
    assert.equal(readdirSync(root).filter((name) => name.endsWith(".failed")).length, 1);
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves its marker on staging-name collision", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-staging-name-collision-"));
  const originalOpenSync = fs.openSync;
  let occupied = false;
  fs.openSync = ((path: fs.PathLike, ...args: Parameters<typeof originalOpenSync> extends [fs.PathLike, ...infer Rest] ? Rest : never) => {
    if (!occupied && typeof path === "string" && /^\.[0-9a-f-]{36}\.tmp$/.test(path)) {
      occupied = true;
      writeFileSync(path, "unowned staging");
      chmodSync(path, 0o600);
    }
    return originalOpenSync(path, ...args);
  }) as typeof originalOpenSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /staging entry is already occupied/,
    );
    assert.equal(occupied, true);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker")), false);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker.tmp")), false);
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication fails closed when marker ownership is unverifiable", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-unknown-owner-marker-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  const originalPath = process.env.PATH;
  try {
    writeFileSync(marker, JSON.stringify({
      schemaVersion: "ebo.publication-staging/v1",
      relativePath: "metadata.json",
      stagingPath: ".77777777-7777-4777-8777-777777777777.tmp",
      attemptId: "77777777-7777-4777-8777-777777777777",
      ownerPid: process.pid,
      ownerStart: "unverifiable-owner-start",
    }));
    chmodSync(marker, 0o600);
    process.env.PATH = "/ebo/no-such-process-tools";
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /ENOENT|already occupied/,
    );
    assert.equal(existsSync(marker), true);
    assert.equal(readdirSync(root).some((name) => name.endsWith(".failed")), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication rejects a nonregular staging marker", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-nonregular-marker-"));
  const marker = join(root, "metadata.json.quarantine.marker");
  try {
    execFileSync("mkfifo", [marker]);
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /already occupied|regular file/,
    );
    assert.equal(lstatSync(marker).isFIFO(), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("generic publication reserves space for quarantine staging", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-publication-path-limit-"));
  const locator = "a".repeat(250);
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, locator, { state: "ready" }),
      /including quarantine staging/,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication returns the winner after a link-time race", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-link-winner-race-"));
  const payload = "x".repeat(8 * 1024 * 1024);
  const expectedBytes = Buffer.from(JSON.stringify({ payload }));
  const originalLinkSync = fs.linkSync;
  let destinationLinkAttempted = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!destinationLinkAttempted && typeof existingPath === "string" && existingPath === "metadata.json.quarantine"
        && typeof newPath === "string" && newPath === "metadata.json") {
      destinationLinkAttempted = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    return originalLinkSync(existingPath, newPath);
  }) as typeof originalLinkSync;
  syncBuiltinESMExports();
  const winner = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const source = path.join(root, "metadata.json.quarantine");
const destination = path.join(root, "metadata.json");
process.stdout.write("ready\\n");
function race() {
  try {
    fs.linkSync(source, destination);
    process.stdout.write("linked\\n");
    return;
  } catch {}
  setImmediate(race);
}
race();`,
      root,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await once(winner.stdout!, "data");
    const result = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { payload });
    assert.equal(result.created, false);
    assert.deepEqual(result.digest, digestBytes(expectedBytes));
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", result.digest), expectedBytes);
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
    if (winner.exitCode === null) {
      winner.kill();
      await once(winner, "exit").catch(() => undefined);
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication preserves its attempt when a raced winner disappears", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-vanished-winner-"));
  const originalLinkSync = fs.linkSync;
  let injected = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!injected && typeof existingPath === "string" && existingPath === "metadata.json.quarantine"
        && typeof newPath === "string" && newPath === "metadata.json") {
      injected = true;
      const error = new Error("injected vanished winner") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
    return originalLinkSync(existingPath, newPath);
  }) as typeof originalLinkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" }),
      /ENOENT/,
    );
    assert.equal(injected, true);
    assert.equal(existsSync(join(root, "metadata.json")), false);
    assert.equal(existsSync(join(root, "metadata.json.quarantine")), false);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker")), false);
    assert.equal(existsSync(join(root, "metadata.json.quarantine.marker.tmp")), false);
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
  }
  try {
    const retry = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.equal(retry.created, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent publication restores a deleted completed destination", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-deleted-destination-"));
  try {
    const first = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    unlinkSync(join(root, "metadata.json"));
    const retry = writeMetadataAtomicallyIfAbsentSync(root, "metadata.json", { state: "ready" });
    assert.equal(retry.created, false);
    assert.deepEqual(retry.digest, first.digest);
    assert.deepEqual(readFileSync(join(root, "metadata.json"), "utf8"), '{"state":"ready"}');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("publication never overwrites an existing quarantine artifact", () => {
  const { root } = createBundle();
  const quarantine = join(root, "packet.json.freeze.json.quarantine");
  try {
    writeFileSync(quarantine, "preserve me");
    assert.throws(() => freezeTaskPacket(root, "packet.json"), /already occupied/);
    assert.equal(readFileSync(quarantine, "utf8"), "preserve me");
    assert.equal(existsSync(join(root, "packet.json.freeze.json")), false);
    assert.equal(readdirSync(root).some((name) => /^\.[0-9a-f-]+\.tmp$/.test(name)), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status rejects a freeze with an unaccounted hard link", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  const extraLink = join(root, "unexpected-freeze-link");
  try {
    freezeTaskPacket(root, "packet.json");
    linkSync(freezePath, extraLink);
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.ok(status.errors.some((error) => /not an isolated regular file/.test(error.message)));
    assert.equal(existsSync(extraLink), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("publication rejects a synchronized temporary-file mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-publication-race-"));
  const payload = "x".repeat(8 * 1024 * 1024);
  const metadata = { payload };
  const expectedBytes = Buffer.from(JSON.stringify(metadata));
  const mutator = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const target = path.join(root, "published.json.quarantine");
process.stdout.write("ready\\n");
function mutate() {
  try {
    const descriptor = fs.openSync(target, fs.constants.O_RDWR);
    const stat = fs.fstatSync(descriptor);
    if (stat.size > 0) fs.writeSync(descriptor, Buffer.from("!"), 0, 1, 0);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  } catch {}
  setImmediate(mutate);
}
mutate();`,
      root,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const stopMutator = async (): Promise<void> => {
    if (mutator.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (mutator.exitCode === null) mutator.kill("SIGKILL");
        resolve();
      }, 1_000);
      mutator.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      mutator.kill();
    });
    mutator.stdout?.destroy();
  };
  try {
    await once(mutator.stdout!, "data");
    writeFileSync(join(root, "unrelated.txt"), "keep");
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "published.json", metadata),
      /changed while it was being published/,
    );
    assert.equal(readFileSync(join(root, "unrelated.txt"), "utf8"), "keep");
    assert.equal(existsSync(join(root, "published.json")), false);
    assert.equal(existsSync(join(root, "published.json.quarantine")), false);
    await stopMutator();
    const retry = writeMetadataAtomicallyIfAbsentSync(root, "published.json", metadata);
    assert.equal(retry.created, true);
    assert.deepEqual(await readVerifiedArtifact(root, "published.json", retry.digest), expectedBytes);
  } finally {
    await stopMutator();
    rmSync(root, { force: true, recursive: true });
  }
});

test("status recovers an interrupted freeze-record hard link", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  let temporaryLink = "";
  try {
    freezeTaskPacket(root, "packet.json");
    const marker = JSON.parse(readFileSync(`${freezePath}.quarantine.marker`, "utf8")) as { stagingPath: string };
    temporaryLink = join(root, marker.stagingPath);
    unlinkSync(`${freezePath}.quarantine`);
    assert.ok(lstatSync(freezePath).nlink >= 2);
    assert.equal(statusTaskPacket(root, "packet.json").status, "frozen");
    assert.equal(existsSync(temporaryLink), true);
  } finally {
    if (temporaryLink !== "") {
      try {
        unlinkSync(temporaryLink);
      } catch {
        // The helper process may already have removed the transient link.
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("status preserves an existing recovered alias", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  const temporaryLink = join(root, ".66666666-6666-4666-8666-666666666666.tmp");
  const recoveredAlias = `${freezePath}.recovered`;
  try {
    freezeTaskPacket(root, "packet.json");
    unlinkSync(`${freezePath}.quarantine`);
    linkSync(freezePath, temporaryLink);
    writeFileSync(recoveredAlias, "preserve this alias");
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.equal(readFileSync(recoveredAlias, "utf8"), "preserve this alias");
    assert.equal(existsSync(temporaryLink), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status recovers an interrupted nested freeze link within its parent", () => {
  const { root } = createBundle();
  const freezeLocator = "nested/freeze.json";
  let temporaryLink = "";
  try {
    freezeTaskPacket(root, "packet.json", freezeLocator);
    const freezePath = join(root, freezeLocator);
    const marker = JSON.parse(readFileSync(`${freezePath}.quarantine.marker`, "utf8")) as { stagingPath: string };
    temporaryLink = join(root, "nested", marker.stagingPath);
    unlinkSync(`${freezePath}.quarantine`);
    assert.equal(statusTaskPacket(root, "packet.json", freezeLocator).status, "frozen");
    assert.equal(existsSync(temporaryLink), true);
  } finally {
    if (temporaryLink !== "") {
      try {
        unlinkSync(temporaryLink);
      } catch {
        // The helper process may already have removed the transient link.
      }
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("status rejects an unowned temporary alias when quarantine is present", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  const temporaryName = ".55555555-5555-4555-8555-555555555555.tmp";
  const quarantinePath = `${freezePath}.quarantine`;
  try {
    freezeTaskPacket(root, "packet.json");
    linkSync(freezePath, join(root, temporaryName));
    renameSync(join(root, temporaryName), quarantinePath);
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.equal(existsSync(join(root, temporaryName)), true);
    assert.equal(existsSync(quarantinePath), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status reads a valid freeze in a large parent directory", () => {
  const { root } = createBundle();
  try {
    freezeTaskPacket(root, "packet.json");
    for (let index = 0; index < 4_097; index += 1) writeFileSync(join(root, `valid-entry-${index}`), "");
    assert.equal(statusTaskPacket(root, "packet.json").status, "frozen");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status bounds orphan-link recovery directory scans", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  const temporaryLink = join(root, ".33333333-3333-4333-8333-333333333333.tmp");
  try {
    freezeTaskPacket(root, "packet.json");
    unlinkSync(`${freezePath}.quarantine`);
    linkSync(freezePath, temporaryLink);
    for (let index = 0; index < 4_097; index += 1) writeFileSync(join(root, `scan-entry-${index}`), "");
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.ok(status.errors.some((error) => /recovery directory exceeds its entry limit/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status does not remove an unrelated dot-tmp hard link", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  const unrelatedLink = join(root, ".deadbeef.tmp");
  try {
    freezeTaskPacket(root, "packet.json");
    unlinkSync(`${freezePath}.quarantine`);
    linkSync(freezePath, unrelatedLink);
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.equal(existsSync(unrelatedLink), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("recovery never removes a freeze destination that resembles a temporary name", () => {
  const { root } = createBundle();
  const freezeLocator = ".44444444-4444-4444-8444-444444444444.tmp";
  const freezePath = join(root, freezeLocator);
  const extraLink = join(root, "freeze-durable-link");
  try {
    freezeTaskPacket(root, "packet.json", freezeLocator);
    unlinkSync(`${freezePath}.quarantine`);
    linkSync(freezePath, extraLink);
    const status = statusTaskPacket(root, "packet.json", freezeLocator);
    assert.equal(status.status, "invalid");
    assert.equal(existsSync(freezePath), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("quarantine-shaped freeze destinations remain readable", () => {
  const { root } = createBundle();
  const freezeLocator = "freeze.quarantine-77777777-7777-4777-8777-777777777777";
  try {
    freezeTaskPacket(root, "packet.json", freezeLocator);
    assert.equal(statusTaskPacket(root, "packet.json", freezeLocator).status, "frozen");
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

  const validWithQuarantine = Array.from({ length: 5 }, () => "a".repeat(180)).join("/");
  assert.equal(defaultFreezeLocator(validWithQuarantine), `${validWithQuarantine}.freeze.json`);

  const nearLimit = Array.from({ length: 5 }, () => "a".repeat(188)).join("/");
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

test("freeze preserves only failed evidence when inputs drift before publication", () => {
  const { root, packet } = createBundle();
  const originalLinkSync = fs.linkSync;
  let mutated = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    const result = originalLinkSync(existingPath, newPath);
    if (!mutated && typeof newPath === "string" && newPath === "packet.json.freeze.json.quarantine") {
      mutated = true;
      packet.agentInput.prompt = "A changed prompt after staging.";
      writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    }
    return result;
  }) as typeof originalLinkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => freezeTaskPacket(root, "packet.json"), /Task packet changed|pre-admission digest/);
    assert.equal(mutated, true);
    assert.equal(existsSync(join(root, "packet.json.freeze.json")), false);
    assert.equal(existsSync(join(root, "packet.json.freeze.json.quarantine")), false);
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("freeze preserves only failed evidence when inputs drift after publication", () => {
  const { root, packet } = createBundle();
  const originalLinkSync = fs.linkSync;
  let mutated = false;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    const result = originalLinkSync(existingPath, newPath);
    if (!mutated && typeof existingPath === "string" && existingPath === "packet.json.freeze.json.quarantine"
        && typeof newPath === "string" && newPath === "packet.json.freeze.json") {
      mutated = true;
      packet.agentInput.prompt = "A changed prompt after publication.";
      writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    }
    return result;
  }) as typeof originalLinkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => freezeTaskPacket(root, "packet.json"), /Task packet changed|pre-admission digest/);
    assert.equal(mutated, true);
    assert.equal(existsSync(join(root, "packet.json.freeze.json")), false);
  } finally {
    fs.linkSync = originalLinkSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("failure preservation leaves a raced replacement at its source path", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-preservation-replacement-"));
  const originalRenameSync = fs.renameSync;
  let replaced = false;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!replaced && oldPath === "published.json") {
      replaced = true;
      unlinkSync(oldPath);
      writeFileSync(oldPath, "newer replacement");
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof originalRenameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(
        root,
        "published.json",
        { state: "ready" },
        undefined,
        undefined,
        () => { throw new Error("injected post-publication failure"); },
      ),
      /injected post-publication failure/,
    );
    assert.equal(replaced, true);
    assert.equal(readFileSync(join(root, "published.json"), "utf8"), "newer replacement");
    assert.equal(readdirSync(root).some((name) => name.endsWith(".failed")), true);
  } finally {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
    rmSync(root, { force: true, recursive: true });
  }
});

test("failure preservation retains and blocks a raced directory replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-preservation-directory-"));
  const originalRenameSync = fs.renameSync;
  let replaced = false;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (!replaced && oldPath === "published.json") {
      replaced = true;
      unlinkSync(oldPath);
      mkdirSync(oldPath);
      writeFileSync(join(oldPath, "keep.txt"), "keep this directory");
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof originalRenameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(
        root,
        "published.json",
        { state: "ready" },
        undefined,
        undefined,
        () => { throw new Error("injected post-publication failure"); },
      ),
      /injected post-publication failure/,
    );
    assert.equal(replaced, true);
    assert.equal(lstatSync(join(root, "published.json")).isDirectory(), true);
    const failedDirectories = readdirSync(root).filter((name) => name.endsWith(".failed")
      && lstatSync(join(root, name)).isDirectory());
    assert.equal(failedDirectories.length, 1);
    assert.equal(readFileSync(join(root, failedDirectories[0]!, "keep.txt"), "utf8"), "keep this directory");
    assert.throws(
      () => writeMetadataAtomicallyIfAbsentSync(root, "published.json", { state: "retry" }),
      /not an isolated regular file/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
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
