import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  validateRunManifestEvidence,
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
  assert.throws(() => canonicalizeMetadata(new Array(1)), /holes/);
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

    const interruptedLink = join(root, ".00000000-0000-4000-8000-000000000000.tmp");
    await link(join(root, "metadata.json"), interruptedLink);
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", previous), Buffer.from('{"state":"previous"}'));
    await assert.rejects(readFile(interruptedLink), /ENOENT/);

    const current = await writeMetadataAtomically(root, "metadata.json", { state: "next" });
    assert.deepEqual(await readVerifiedArtifact(root, "metadata.json", current), Buffer.from('{"state":"next"}'));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI rejects non-UTF-8 JSON bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-utf8-"));
  const artifact = join(root, "packet.json");
  const bytes = Buffer.from(readFileSync(fixturePath("task-packet.valid.v1.json")));
  const prompt = bytes.indexOf(Buffer.from('"prompt": "')) + '"prompt": "'.length;
  bytes[prompt] = 0xff;

  try {
    await writeFile(artifact, bytes);
    let output = "";
    assert.equal(main(["validate", artifact], (message) => (output += message)), 1);
    assert.match(output, /encoded data/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI rejects duplicate keys in a standalone verifier result", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-duplicate-verifier-"));
  const artifact = join(root, "verifier.json");

  try {
    await writeFile(artifact, Buffer.from('{"schemaVersion":"verifier-result/v1","bundleId":"bundle-test","status":"failed","status":"passed","assertions":[]}'));
    let output = "";
    assert.equal(main(["validate", artifact], (message) => (output += message)), 1);
    assert.match(output, /duplicate JSON object keys/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("CLI verifies run evidence and correlates ready exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-cli-bundle-"));
  const manifestPath = join(root, "manifest.json");
  const completeManifest = runFixturePath("complete/manifest.json");
  const completeExport = runFixturePath("complete/export/manifest.json");

  try {
    await writeFile(manifestPath, readFileSync(completeManifest));
    let output = "";
    assert.equal(main(["validate", manifestPath], (message) => (output += message)), 1);
    assert.match(output, /evidence/);

    const invalidExport = JSON.parse(readFileSync(completeExport, "utf8"));
    invalidExport.status = "ready";
    invalidExport.artifactIds = ["missing-artifact"];
    const invalidExportPath = join(root, "export.json");
    await writeFile(invalidExportPath, JSON.stringify(invalidExport));
    output = "";
    assert.equal(main(["validate", completeManifest, invalidExportPath], (message) => (output += message)), 1);
    assert.match(output, /Export cannot include artifact/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("validation reports schema versions, fields, duplicate identities, and fixture results", () => {
  const packet = JSON.parse(readFileSync(fixturePath("task-packet.valid.v1.json"), "utf8"));
  const runManifest = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));

  assert.deepEqual(validateArtifact("packet.json", packet), []);
  assert.deepEqual(validateArtifact("run/manifest.json", runManifest), []);
  const failedVerifier = JSON.parse(readFileSync(runFixturePath("task-failed/verifier.json"), "utf8"));
  delete failedVerifier.exitCode;
  assert.notDeepEqual(validateArtifact("verifier.json", failedVerifier), []);
  failedVerifier.exitCode = 0;
  assert.notDeepEqual(validateArtifact("verifier.json", failedVerifier), []);
  failedVerifier.exitCode = 1;
  failedVerifier.assertions.push({ id: "example-check", status: "failed" });
  assert.match(validateArtifact("verifier.json", failedVerifier).map((error) => error.message).join("\n"), /assertion IDs must be unique/);
  packet.agentInput.prompt = " ";
  assert.deepEqual(validateArtifact("packet.json", packet)[0], {
    artifact: "packet.json",
    schemaVersion: "ebo.task-packet/v1",
    field: "/agentInput/prompt",
    message: 'must match pattern ".*\\S.*"',
  });
  runManifest.evidence.push({ ...runManifest.evidence[0] });
  assert.match(validateArtifact("run/manifest.json", runManifest).map((error) => error.message).join("\n"), /Duplicate artifact identity/);
  assert.throws(() => assertUniqueArtifactIdentities([{ id: "one", relativePath: "a.json" }, { id: "two", relativePath: "A.json" }]), /collides/);
  assert.throws(() => assertUniqueArtifactIdentities([{ id: "one", relativePath: "evidence" }, { id: "two", relativePath: "evidence/session.json" }]), /collides/);

  const selfRetry = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  selfRetry.attempt.retryOf = selfRetry.attempt.id;
  assert.match(validateArtifact("run/manifest.json", selfRetry).map((error) => error.message).join("\n"), /Retry lineage/);
  const reusedDigest = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  const session = reusedDigest.evidence.find((entry: { kind: string }) => entry.kind === "session");
  const telemetry = reusedDigest.evidence.find((entry: { kind: string }) => entry.kind === "telemetry");
  telemetry.digest = session.digest;
  assert.match(validateArtifact("run/manifest.json", reusedDigest).map((error) => error.message).join("\n"), /across evidence classes/);
  const overwrittenManifest = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  overwrittenManifest.evidence[0].relativePath = "manifest.json";
  assert.match(validateArtifact("run/manifest.json", overwrittenManifest).map((error) => error.message).join("\n"), /containing manifest/);
  const selfSanitized = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  const source = selfSanitized.evidence.find((entry: { kind: string }) => entry.kind === "session");
  const sanitized = { ...source, id: "sanitized-session", digest: `sha256:${"f".repeat(64)}`, relativePath: "sanitized/session.json", sharingClass: "partner", sanitizedFrom: { artifactId: "sanitized-session", digest: source.digest } };
  delete sanitized.nativeReference;
  selfSanitized.evidence.push(sanitized);
  assert.match(validateArtifact("run/manifest.json", selfSanitized).map((error) => error.message).join("\n"), /provenance cannot contain a cycle/);
  const nativeMismatch = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  nativeMismatch.run.native.sessionId = "other-session";
  assert.match(validateArtifact("run/manifest.json", nativeMismatch).map((error) => error.message).join("\n"), /sessionId does not match/);
  const workspaceMismatch = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  workspaceMismatch.terminal.workspaceArtifactId = "other-workspace";
  assert.match(validateArtifact("run/manifest.json", workspaceMismatch).map((error) => error.message).join("\n"), /Terminal workspace/);
  const runtimeMismatch = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  runtimeMismatch.run.runtime = [{ source: "other", name: "other", version: "other" }];
  assert.match(validateArtifact("run/manifest.json", runtimeMismatch).map((error) => error.message).join("\n"), /not represented/);
  const multiHop = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  const multiHopSource = multiHop.evidence.find((entry: { kind: string }) => entry.kind === "session");
  const intermediate = { ...multiHopSource, id: "intermediate-session", digest: `sha256:${"e".repeat(64)}`, relativePath: "internal/session.json", sharingClass: "internal", sanitizedFrom: { artifactId: multiHopSource.id, digest: multiHopSource.digest } };
  delete intermediate.nativeReference;
  multiHop.evidence.push(intermediate, { ...intermediate, id: "shared-session", digest: `sha256:${"d".repeat(64)}`, relativePath: "shared/session.json", sharingClass: "partner", sanitizedFrom: { artifactId: intermediate.id, digest: intermediate.digest } });
  assert.match(validateArtifact("run/manifest.json", multiHop).map((error) => error.message).join("\n"), /does not preserve/);
  const reorderedNative = JSON.parse(readFileSync(runFixturePath("complete/manifest.json"), "utf8"));
  const nativeSource = reorderedNative.evidence.find((entry: { kind: string }) => entry.kind === "session");
  const nativeIntermediate = { ...nativeSource, id: "native-intermediate", digest: `sha256:${"c".repeat(64)}`, relativePath: "internal/native-session.json", sharingClass: "internal", nativeReference: { id: nativeSource.nativeReference.id, type: nativeSource.nativeReference.type }, sanitizedFrom: { artifactId: nativeSource.id, digest: nativeSource.digest } };
  const nativeShared = { ...nativeIntermediate, id: "native-shared", digest: `sha256:${"b".repeat(64)}`, relativePath: "shared/native-session.json", sharingClass: "partner", sanitizedFrom: { artifactId: nativeIntermediate.id, digest: nativeIntermediate.digest } };
  delete nativeShared.nativeReference;
  reorderedNative.evidence.push(nativeIntermediate, nativeShared);
  assert.doesNotMatch(validateArtifact("run/manifest.json", reorderedNative).map((error) => error.message).join("\n"), /does not preserve/);

  let output = "";
  assert.equal(main(["validate", fixturePath("task-packet.valid.v1.json"), runFixturePath("complete/manifest.json")], (message) => (output += message)), 0);
  assert.equal(output, "Validated 2 artifact(s).\n");
});

test("validates nested verifier diagnostics against retained bundle bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-nested-diagnostics-"));
  try {
    await cp(runFixturePath("complete"), root, { recursive: true });
    const manifestPath = join(root, "manifest.json");
    const verifierPath = join(root, "verifier.json");
    const diagnosticPath = join(root, "diagnostics.log");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const verifier = JSON.parse(readFileSync(verifierPath, "utf8"));
    const diagnosticBytes = Buffer.from("nested verifier diagnostic");
    await writeFile(diagnosticPath, diagnosticBytes);
    const nestedDiagnostic = {
      stream: "stderr",
      locator: "diagnostics.log",
      digest: `sha256:${digestBytes(diagnosticBytes).value}`,
      sizeBytes: diagnosticBytes.length,
      truncated: false,
    };
    verifier.diagnostics = [nestedDiagnostic];
    const verifierDescriptor = manifest.evidence.find((entry: { kind: string }) => entry.kind === "verifier");
    const retainVerifier = async (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      await writeFile(verifierPath, bytes);
      verifierDescriptor.digest = `sha256:${digestBytes(bytes).value}`;
      verifierDescriptor.sizeBytes = bytes.length;
    };
    await retainVerifier(verifier);

    assert.deepEqual(validateRunManifestEvidence("manifest.json", manifest, root), []);
    await retainVerifier({
      ...verifier,
      diagnostics: [{ ...nestedDiagnostic, locator: "Manifest.json/stdout.log" }],
    });
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /alias retained evidence paths/,
    );
    await retainVerifier(verifier);
    const noDiagnosticsVerifier = { ...verifier };
    delete noDiagnosticsVerifier.diagnostics;
    await retainVerifier({ ...noDiagnosticsVerifier, bundleId: "another-bundle" });
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /bundleId.*containing run manifest/,
    );
    await retainVerifier({ ...verifier, bundleId: "another-bundle" });
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /bundleId.*containing run manifest/,
    );
    await retainVerifier({ ...verifier, workspace: { ...verifier.workspace, artifactId: "missing-workspace" } });
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /retained workspace evidence/,
    );
    await retainVerifier({ ...verifier, workspace: { ...verifier.workspace, digest: `sha256:${"f".repeat(64)}` } });
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /workspace digest.*retained workspace evidence/,
    );
    await retainVerifier(verifier);
    const originalTerminal = manifest.terminal;
    await retainVerifier({ ...verifier, status: "error", error: "verifier infrastructure failed", assertions: [] });
    manifest.terminal = { ...originalTerminal, state: "completed" };
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /Completed runs require a passed verifier bound to the terminal workspace/,
    );
    await retainVerifier(verifier);
    manifest.terminal = { ...originalTerminal, state: "failed", failureClass: "task" };
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /Task-failed runs require a failed verifier bound to the terminal workspace/,
    );
    manifest.terminal = originalTerminal;
    await writeFile(diagnosticPath, "tampered");
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /Diagnostic|digest/,
    );
    await writeFile(diagnosticPath, diagnosticBytes);
    const duplicateVerifierBytes = Buffer.from('{"schemaVersion":"verifier-result/v1","status":"failed","status":"passed"}');
    await writeFile(verifierPath, duplicateVerifierBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(duplicateVerifierBytes).value}`;
    verifierDescriptor.sizeBytes = duplicateVerifierBytes.length;
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /duplicate JSON object keys/,
    );
    verifier.diagnostics = [{ locator: 42 }];
    const malformedVerifierBytes = Buffer.from(JSON.stringify(verifier));
    await writeFile(verifierPath, malformedVerifierBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(malformedVerifierBytes).value}`;
    verifierDescriptor.sizeBytes = malformedVerifierBytes.length;
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /required property|must be string/,
    );
    const unreadableVerifierBytes = Buffer.from("{");
    await writeFile(verifierPath, unreadableVerifierBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(unreadableVerifierBytes).value}`;
    verifierDescriptor.sizeBytes = unreadableVerifierBytes.length;
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /Verifier artifact could not be parsed/,
    );
    await writeFile(diagnosticPath, diagnosticBytes);
    const workspaceDescriptor = manifest.evidence.find((entry: { kind: string }) => entry.kind === "workspace");
    const workspaceBytes = readFileSync(join(root, workspaceDescriptor.relativePath));
    verifier.diagnostics[0] = {
      stream: "stderr",
      locator: workspaceDescriptor.relativePath,
      digest: workspaceDescriptor.digest,
      sizeBytes: workspaceBytes.length,
      truncated: false,
    };
    const aliasedVerifierBytes = Buffer.from(JSON.stringify(verifier));
    await writeFile(verifierPath, aliasedVerifierBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(aliasedVerifierBytes).value}`;
    verifierDescriptor.sizeBytes = aliasedVerifierBytes.length;
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /alias retained evidence/,
    );
    await writeFile(diagnosticPath, diagnosticBytes);
    verifier.diagnostics = [nestedDiagnostic];
    const firstVerifierBytes = Buffer.from(JSON.stringify(verifier));
    await writeFile(verifierPath, firstVerifierBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(firstVerifierBytes).value}`;
    verifierDescriptor.sizeBytes = firstVerifierBytes.length;
    await writeFile(join(root, "second-verifier.json"), firstVerifierBytes);
    manifest.evidence.push({ ...verifierDescriptor, id: "second-verifier", relativePath: "second-verifier.json" });
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /alias retained evidence/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("binds terminal verifier outcomes to the named workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-terminal-binding-"));
  try {
    await cp(runFixturePath("complete"), root, { recursive: true });
    const manifestPath = join(root, "manifest.json");
    const verifierPath = join(root, "verifier.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const verifier = JSON.parse(readFileSync(verifierPath, "utf8"));
    const workspace = manifest.evidence.find((entry: { kind: string }) => entry.kind === "workspace");
    const verifierDescriptor = manifest.evidence.find((entry: { kind: string }) => entry.kind === "verifier");
    const workspaceBytes = readFileSync(join(root, workspace.relativePath));
    const secondWorkspace = {
      ...workspace,
      id: "workspace-b",
      relativePath: "workspace-b.patch",
    };
    await writeFile(join(root, secondWorkspace.relativePath), workspaceBytes);
    manifest.evidence.push(secondWorkspace);
    verifier.workspace = { artifactId: secondWorkspace.id, digest: secondWorkspace.digest };
    const verifierBytes = Buffer.from(JSON.stringify(verifier));
    await writeFile(verifierPath, verifierBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(verifierBytes).value}`;
    verifierDescriptor.sizeBytes = verifierBytes.length;

    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /terminal workspace/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("does not qualify terminal outcomes from sanitized verifier copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-sanitized-verifier-"));
  try {
    await cp(runFixturePath("complete"), root, { recursive: true });
    const manifestPath = join(root, "manifest.json");
    const verifierPath = join(root, "verifier.json");
    const sanitizedVerifierPath = join(root, "sanitized-verifier.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const sourceVerifierDescriptor = manifest.evidence.find((entry: { kind: string }) => entry.kind === "verifier");
    const sourceVerifier = JSON.parse(readFileSync(verifierPath, "utf8"));
    sourceVerifier.status = "error";
    sourceVerifier.error = "verifier infrastructure failed";
    sourceVerifier.assertions = [];
    const sourceBytes = Buffer.from(JSON.stringify(sourceVerifier));
    await writeFile(verifierPath, sourceBytes);
    sourceVerifierDescriptor.digest = `sha256:${digestBytes(sourceBytes).value}`;
    sourceVerifierDescriptor.sizeBytes = sourceBytes.length;

    const sanitizedVerifier = JSON.parse(readFileSync(runFixturePath("complete/verifier.json"), "utf8"));
    const sanitizedBytes = Buffer.from(JSON.stringify(sanitizedVerifier));
    await writeFile(sanitizedVerifierPath, sanitizedBytes);
    manifest.evidence.push({
      ...sourceVerifierDescriptor,
      id: "sanitized-verifier",
      relativePath: "sanitized-verifier.json",
      digest: `sha256:${digestBytes(sanitizedBytes).value}`,
      sizeBytes: sanitizedBytes.length,
      sharingClass: "partner",
      sanitizedFrom: { artifactId: sourceVerifierDescriptor.id, digest: sourceVerifierDescriptor.digest },
    });

    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /passed verifier bound to the terminal workspace/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("binds verifier results to the configured verifier reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verifier-binding-"));
  try {
    await cp(runFixturePath("complete"), root, { recursive: true });
    const manifestPath = join(root, "manifest.json");
    const verifierPath = join(root, "verifier.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const verifierDescriptor = manifest.evidence.find((entry: { kind: string }) => entry.kind === "verifier");
    const verifierReference = {
      locator: "restricted/verifier.js",
      digest: `sha256:${"a".repeat(64)}`,
    };
    manifest.run.verifier = verifierReference;
    const verifier = JSON.parse(readFileSync(verifierPath, "utf8"));
    verifier.verifier = verifierReference;
    const verifierBytes = Buffer.from(JSON.stringify(verifier));
    await writeFile(verifierPath, verifierBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(verifierBytes).value}`;
    verifierDescriptor.sizeBytes = verifierBytes.length;

    assert.deepEqual(validateRunManifestEvidence("manifest.json", manifest, root), []);
    verifier.verifier = { ...verifierReference, digest: `sha256:${"b".repeat(64)}` };
    const mismatchedBytes = Buffer.from(JSON.stringify(verifier));
    await writeFile(verifierPath, mismatchedBytes);
    verifierDescriptor.digest = `sha256:${digestBytes(mismatchedBytes).value}`;
    verifierDescriptor.sizeBytes = mismatchedBytes.length;
    assert.match(
      validateRunManifestEvidence("manifest.json", manifest, root).map((error) => error.message).join("\n"),
      /Verifier execution reference must match the run configuration/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
