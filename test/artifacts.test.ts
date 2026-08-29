import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertUniqueArtifactIdentities,
  canonicalizeMetadata,
  digestBytes,
  digestMetadata,
  readVerifiedArtifact,
  validateArtifact,
  verifyDigest,
  writeMetadataAtomically,
} from "../src/artifacts.js";
import { main } from "../src/cli.js";

const repositoryRoot = new URL("../../", import.meta.url);
const fixturePath = (path: string) => new URL(`tests/fixtures/${path}`, repositoryRoot).pathname;
const runFixturePath = (path: string) => new URL(`test/fixtures/run-bundles/${path}`, repositoryRoot).pathname;

test("canonical metadata and binary payloads have stable, distinct digests", () => {
  assert.equal(canonicalizeMetadata({ z: [true, null], a: { b: 2, a: 1 } }), '{"a":{"a":1,"b":2},"z":[true,null]}');
  assert.deepEqual(digestMetadata({ b: 2, a: 1 }), digestMetadata({ a: 1, b: 2 }));

  const original = Buffer.from([0, 1, 2]);
  const changed = Buffer.from([0, 1, 3]);
  const digest = digestBytes(original);
  assert.notDeepEqual(digest, digestBytes(changed));
  assert.equal(verifyDigest(original, digest), true);
  assert.equal(verifyDigest(changed, digest), false);
  assert.throws(() => canonicalizeMetadata({ invalid: Number.NaN }), /finite JSON numbers/);
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.throws(() => canonicalizeMetadata(cyclic), /cycles/);
});

test("artifact paths reject traversal and symlinks while preserving verified bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "ebo-artifacts-outside-"));
  const bytes = Buffer.from("native evidence");
  const digest = digestBytes(bytes);

  try {
    await mkdir(join(root, "evidence"));
    await writeFile(join(root, "evidence", "session.json"), bytes);
    await writeFile(join(outside, "outside.json"), bytes);
    await symlink(join(outside, "outside.json"), join(root, "evidence", "linked.json"));

    assert.deepEqual(await readVerifiedArtifact(root, "evidence/session.json", digest), bytes);
    await writeFile(join(root, "evidence", "session.json"), Buffer.from("native evidencf"));
    await assert.rejects(readVerifiedArtifact(root, "evidence/session.json", digest), /digest does not match/);
    await writeFile(join(root, "evidence", "session.json"), bytes);
    await assert.rejects(readVerifiedArtifact(root, "../outside.json", digest), /unsafe/);
    await assert.rejects(writeMetadataAtomically(root, join(outside, "metadata.json"), {}), /unsafe/);
    await assert.rejects(readVerifiedArtifact(root, "evidence/linked.json", digest), /escapes/);
    await assert.rejects(writeMetadataAtomically(root, "../metadata.json", {}), /unsafe/);
    await assert.rejects(writeMetadataAtomically(root, "evidence/linked.json", {}), /isolated regular file/);
  } finally {
    await Promise.all([rm(root, { force: true, recursive: true }), rm(outside, { force: true, recursive: true })]);
  }
});

test("atomic metadata writes retain the previous valid file when interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-metadata-"));
  const controller = new AbortController();

  try {
    const previous = await writeMetadataAtomically(root, "metadata.json", { state: "previous" });
    const writing = writeMetadataAtomically(root, "metadata.json", { state: "next" }, controller.signal);
    queueMicrotask(() => controller.abort());
    await assert.rejects(writing, /interrupted/);
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", previous), Buffer.from('{"state":"previous"}'));

    const current = await writeMetadataAtomically(root, "metadata.json", { state: "next" });
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", current), Buffer.from('{"state":"next"}'));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("validation reports schema versions, fields, duplicate identities, and fixture results", () => {
  const packet = JSON.parse(readFileSync(fixturePath("task-packet.valid.v1.json"), "utf8"));
  const runManifest = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));

  assert.deepEqual(validateArtifact("packet.json", packet), []);
  assert.deepEqual(validateArtifact("run/manifest.json", runManifest), []);
  packet.agentInput.prompt = " ";
  assert.deepEqual(validateArtifact("packet.json", packet)[0], {
    artifact: "packet.json",
    schemaVersion: "ebo.task-packet/v1",
    field: "/agentInput/prompt",
    message: 'must match pattern ".*\\S.*"',
  });
  runManifest.evidence.push({ ...runManifest.evidence[0] });
  assert.match(validateArtifact("run/manifest.json", runManifest).map((error) => error.message).join("\n"), /Duplicate artifact identity/);
  assert.throws(() => assertUniqueArtifactIdentities([{ id: "one", relativePath: "a.json" }, { id: "two", relativePath: "A.json" }]), /Duplicate artifact path/);

  let output = "";
  assert.equal(main(["validate", fixturePath("task-packet.valid.v1.json"), runFixturePath("complete/manifest.json")], (message) => (output += message)), 0);
  assert.equal(output, "Validated 2 artifact(s).\n");
});
