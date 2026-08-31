import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createPortableRunBundleExport,
  readPortableRunBundleExport,
  validateArtifact,
  type PortableExportManifest,
  type PortableExportPolicy,
  type RunManifest,
} from "../src/index.js";

const fixtureRoot = resolve("test/fixtures/run-bundles/complete");
const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
const heuristicSecret = "correct horse battery staple";
const databaseUrl = "postgres://user:password@private.example/database";
const clientSecret = "client-secret-value-12345";
const privateKey = "private-key-value-12345";
const secretAccessKey = "aws-secret-value-12345";
const credentialsJson = "credential-json-value-12345";
const genericToken = "generic-token-value-12345";
const privateKeyBlock = "-----BEGIN PRIVATE KEY-----\ncHJpdmF0ZS1rZXktbWF0ZXJpYWw=\n-----END PRIVATE KEY-----";
const encryptedPrivateKeyBlock = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nZW5jcnlwdGVkLWtleS1tYXRlcmlhbA==\n-----END ENCRYPTED PRIVATE KEY-----";
const pgpPrivateKeyBlock = "-----BEGIN PGP PRIVATE KEY BLOCK-----\ncGdwLWtleS1tYXRlcmlhbA==\n-----END PGP PRIVATE KEY BLOCK-----";

test("exports a sanitized public M2 bundle without mutating its source", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-export-"));
  const source = join(root, "source");
  const destination = join(root, "portable");
  const environmentSecret = "environment-secret-value-12345";
  const previousSecret = process.env.EBO_TEST_EXPORT_SECRET;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.EBO_TEST_EXPORT_SECRET = environmentSecret;
  process.env.DATABASE_URL = databaseUrl;

  try {
    stageSource(source, {
      "session.jsonl": `${JSON.stringify({
        type: "assistant.message",
        id: "session-complete-1",
        session_id: "session-complete-1",
        runId: "run-complete",
        attemptId: "a",
        status: "available",
        tool_result: "x".repeat(200),
        apiKey: token,
        path: join(homedir(), "private", "result.txt"),
        user: userInfo().username,
        metadata: {},
        input: {},
        thinking: "hidden chain of thought",
        environmentSecret,
        note: databaseUrl,
        client_secret: clientSecret,
        private_key: privateKey,
        secret_access_key: secretAccessKey,
        credentialsJson,
      })}\n`,
      "hooks.jsonl": `${JSON.stringify({
        type: "PostToolUse",
        id: "hook-complete-1",
        session_id: "session-complete-1",
      })}\n`,
      "telemetry/trace.json": `${JSON.stringify({ traceId: "trace-complete-1" })}\n`,
      "workspace.patch": `${readFileSync(join(fixtureRoot, "workspace.patch"), "utf8")}+${homedir()}/private/result.txt /workspace/acme/private-repo /mnt/builds/customer username=${userInfo().username} ${token} password=\"${heuristicSecret}\" client_secret=\"${clientSecret}\"\n`,
    });
    const sourceManifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as SourceManifest;
    sourceManifest.attempt.id = "a";
    writeFileSync(join(source, "manifest.json"), `${JSON.stringify(sourceManifest)}\n`);
    const sourceBefore = snapshot(source);
    const policy: PortableExportPolicy = {
      sharingClass: "public",
      maxArtifactBytes: 4096,
      maxStringBytes: 8,
      sensitiveValues: [token],
    };

    const manifest = await createPortableRunBundleExport({ sourceRoot: source, destinationRoot: destination, policy });
    const readback = await readPortableRunBundleExport(destination, policy);
    const portableBytes = snapshot(destination);
    const allText = [...portableBytes.values()].map((bytes) => bytes.toString("utf8")).join("\n");

    assert.deepEqual(readback, manifest);
    assert.deepEqual(snapshot(source), sourceBefore);
    assert.deepEqual(validateArtifact("manifest.json", manifest), []);
    assert.equal(manifest.status, "ready");
    assert.equal(manifest.sharingClass, "public");
    assert.equal(manifest.artifacts.length, 6);
    assert.deepEqual(manifest.excludedArtifacts, [{ artifactId: "export-manifest", reason: "source-export-manifest" }]);
    assert.ok(manifest.transformations.some(({ action }) => action === "truncated"));
    for (const forbidden of [
      token,
      heuristicSecret,
      environmentSecret,
      databaseUrl,
      clientSecret,
      privateKey,
      secretAccessKey,
      credentialsJson,
      homedir(),
      "/workspace/acme/private-repo",
      "/mnt/builds/customer",
      userInfo().username,
      "hidden chain of thought",
      "run-complete",
      "attempt-complete-1",
      "session-complete-1",
      "trace-complete-1",
    ]) {
      assert.equal(allText.includes(forbidden), false, `portable tree leaked ${forbidden}`);
    }

    const session = firstJsonlRecord(destination, manifest, "session");
    const hook = firstJsonlRecord(destination, manifest, "hook");
    const telemetry = jsonArtifact(destination, manifest, "telemetry");
    assert.equal(session.runId, manifest.correlations.runId);
    assert.equal(session.attemptId, manifest.correlations.attemptId);
    assert.equal(session.status, "available");
    assert.equal(String(session.tool_result).length, 8);
    assert.equal(session.user, "[LOCAL_USER]");
    assert.deepEqual(session.metadata, {});
    assert.deepEqual(session.input, {});
    assert.equal(session.session_id, manifest.correlations.sessionId);
    assert.equal(hook.session_id, manifest.correlations.sessionId);
    assert.equal(telemetry.traceId, manifest.correlations.traceId);
    assert.equal(jsonArtifact(destination, manifest, "verifier").schemaVersion, "verifier-result/v1");
    assert.equal(jsonArtifact(destination, manifest, "capture-report").schemaVersion, "capture-report/v1");
  } finally {
    if (previousSecret === undefined) delete process.env.EBO_TEST_EXPORT_SECRET;
    else process.env.EBO_TEST_EXPORT_SECRET = previousSecret;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on unknown inputs and a final secret-scan finding", async (t) => {
  await t.test("unknown sharing classification", async () => {
    await assertBlocked((manifest) => {
      manifest.evidence[0]!.sharingClass = "unknown";
    }, /unknown sharing classification/i);
  });

  await t.test("unsupported kind/media pair", async () => {
    await assertBlocked((manifest) => {
      manifest.evidence[0]!.mediaType = "text/plain";
    }, /media type|manifest/i);
  });

  await t.test("final scan finding", async () => {
    const root = mkdtempSync(join(tmpdir(), "ebo-export-scan-"));
    const source = join(root, "source");
    const destination = join(root, "portable");
    try {
      stageSource(source);
      await assert.rejects(
        createPortableRunBundleExport({
          sourceRoot: source,
          destinationRoot: destination,
          policy: policy({ sensitiveValues: ["export-manifest/v1"] }),
        }),
        /secret scan/i,
      );
      assert.equal(existsSync(destination), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("sanitizes untruncated text evidence and preserves pre-existing destinations", async (t) => {
  await t.test("text evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "ebo-export-text-"));
    const source = join(root, "source");
    const destination = join(root, "portable");
    try {
      stageSource(source, {
        "workspace.patch": `${readFileSync(join(fixtureRoot, "workspace.patch"), "utf8")}
+/workspace/acme/private-repo
+session-complete-1
+password="${heuristicSecret}"
+token="${genericToken}"
+refresh_token=${genericToken}
+id_token='${genericToken}'
+Authorization: Basic dXNlcjpwYXNzd29yZA==
+${privateKeyBlock}
+${encryptedPrivateKeyBlock}
+${pgpPrivateKeyBlock}
`,
      });
      const exportPolicy = policy({ maxArtifactBytes: 16_384, maxStringBytes: 8192 });
      const manifest = await createPortableRunBundleExport({ sourceRoot: source, destinationRoot: destination, policy: exportPolicy });
      const workspace = manifest.artifacts.find(({ kind }) => kind === "workspace")!;
      const text = readFileSync(join(destination, workspace.relativePath), "utf8");

      for (const forbidden of [
        "/workspace/acme/private-repo",
        "session-complete-1",
        heuristicSecret,
        genericToken,
        "cHJpdmF0ZS1rZXktbWF0ZXJpYWw=",
        "BEGIN PRIVATE KEY",
        "END PRIVATE KEY",
        "ZW5jcnlwdGVkLWtleS1tYXRlcmlhbA==",
        "cGdwLWtleS1tYXRlcmlhbA==",
        "dXNlcjpwYXNzd29yZA==",
      ]) assert.equal(text.includes(forbidden), false, `portable text leaked ${forbidden}`);
      assert.ok(text.includes(String(manifest.correlations.sessionId)));
      assert.ok(text.includes("[REDACTED_SECRET]"));
      assert.ok(text.includes("[LOCAL_PATH]"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("pre-existing destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "ebo-export-existing-"));
    const destination = join(root, "portable");
    const source = join(destination, "source");
    const marker = join(destination, "keep.txt");
    try {
      mkdirSync(destination);
      writeFileSync(marker, "keep");
      stageSource(source);
      await assert.rejects(
        createPortableRunBundleExport({ sourceRoot: source, destinationRoot: destination, policy: policy() }),
        /exist|EEXIST/i,
      );
      assert.equal(readFileSync(marker, "utf8"), "keep");
      assert.equal(existsSync(join(source, "manifest.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("exports verifier diagnostic sidecars with portable references", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-export-diagnostic-"));
  const source = join(root, "source");
  const destination = join(root, "portable");
  const exportPolicy = policy({ maxArtifactBytes: 16_384, maxStringBytes: 8192 });
  try {
    stageSource(source);
    const sourceManifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as SourceManifest;
    replaceArtifact(source, sourceManifest, "telemetry/trace.json", Buffer.from(JSON.stringify({
      traceId: "trace-complete-1",
      diagnostics: [{ locator: "telemetry-only" }],
    })));
    const diagnosticPath = "diagnostics/verifier.stderr.txt";
    const diagnosticBytes = Buffer.from(`password="${heuristicSecret}"\nuseful diagnostic\n`);
    mkdirSync(join(source, "diagnostics"));
    writeFileSync(join(source, diagnosticPath), diagnosticBytes);
    const verifier = JSON.parse(readFileSync(join(source, "verifier.json"), "utf8")) as Record<string, unknown>;
    verifier.diagnostics = [{
      stream: "stderr",
      locator: diagnosticPath,
      digest: `sha256:${createHash("sha256").update(diagnosticBytes).digest("hex")}`,
      sizeBytes: diagnosticBytes.length,
      truncated: false,
    }];
    replaceArtifact(source, sourceManifest, "verifier.json", Buffer.from(`${JSON.stringify(verifier)}\n`));
    writeFileSync(join(source, "manifest.json"), `${JSON.stringify(sourceManifest)}\n`);

    const manifest = await createPortableRunBundleExport({ sourceRoot: source, destinationRoot: destination, policy: exportPolicy });
    const verifierArtifact = manifest.artifacts.find(({ kind }) => kind === "verifier")!;
    const diagnosticArtifact = manifest.artifacts.find(({ kind }) => kind === "diagnostic")!;
    const portableVerifier = jsonArtifact(destination, manifest, "verifier");
    const portableTelemetry = jsonArtifact(destination, manifest, "telemetry");
    const diagnostic = (portableVerifier.diagnostics as Array<Record<string, unknown>>)[0]!;

    assert.equal(diagnostic.locator, diagnosticArtifact.relativePath);
    assert.equal(diagnostic.digest, diagnosticArtifact.digest);
    assert.equal(diagnostic.sizeBytes, diagnosticArtifact.sizeBytes);
    assert.deepEqual(portableTelemetry.diagnostics, [{ locator: "telemetry-only" }]);
    assert.deepEqual(diagnosticArtifact.diagnosticSource, {
      verifierId: verifierArtifact.id,
      stream: "stderr",
      locatorDigest: `sha256:${createHash("sha256").update(diagnosticPath).digest("hex")}`,
      sizeBytes: diagnosticBytes.length,
    });
    assert.equal(readFileSync(join(destination, diagnosticArtifact.relativePath), "utf8").includes(heuristicSecret), false);

    const sourceDigest = diagnosticArtifact.sourceDigest;
    diagnosticArtifact.sourceDigest = `sha256:${"e".repeat(64)}`;
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(
      readPortableRunBundleExport(destination, exportPolicy, sourceManifest as unknown as RunManifest, source),
      /source diagnostic reference/i,
    );
    diagnosticArtifact.sourceDigest = sourceDigest;
    diagnostic.locator = "missing/diagnostic.txt";
    const tamperedBytes = Buffer.from(JSON.stringify(portableVerifier));
    writeFileSync(join(destination, verifierArtifact.relativePath), tamperedBytes);
    verifierArtifact.digest = `sha256:${createHash("sha256").update(tamperedBytes).digest("hex")}`;
    verifierArtifact.sizeBytes = tamperedBytes.length;
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(readPortableRunBundleExport(destination, exportPolicy), /diagnostic reference/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readback rejects a corrupted portable artifact and source reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-export-corrupt-"));
  const source = join(root, "source");
  const destination = join(root, "portable");
  const exportPolicy = policy();
  try {
    stageSource(source);
    const manifest = await createPortableRunBundleExport({ sourceRoot: source, destinationRoot: destination, policy: exportPolicy });
    const sourceManifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as RunManifest;
    const invalidReference = structuredClone(manifest);
    invalidReference.artifacts[0]!.sourceArtifactId = "missing-source";
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(invalidReference));
    await assert.rejects(readPortableRunBundleExport(destination, exportPolicy, sourceManifest), /source reference/i);

    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest));
    appendFileSync(join(destination, manifest.artifacts[0]!.relativePath), "corruption");
    await assert.rejects(readPortableRunBundleExport(destination, exportPolicy), /digest|size/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function policy(overrides: Partial<PortableExportPolicy> = {}): PortableExportPolicy {
  return { sharingClass: "partner", maxArtifactBytes: 4096, maxStringBytes: 128, ...overrides };
}

async function assertBlocked(
  mutate: (manifest: SourceManifest) => void,
  expected: RegExp,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ebo-export-blocked-"));
  const source = join(root, "source");
  const destination = join(root, "portable");
  try {
    stageSource(source);
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")) as SourceManifest;
    mutate(manifest);
    writeFileSync(join(source, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      createPortableRunBundleExport({ sourceRoot: source, destinationRoot: destination, policy: policy() }),
      expected,
    );
    assert.equal(existsSync(destination), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stageSource(root: string, replacements: Record<string, string> = {}): void {
  cpSync(fixtureRoot, root, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SourceManifest;
  for (const [relativePath, content] of Object.entries(replacements)) {
    replaceArtifact(root, manifest, relativePath, Buffer.from(content));
  }
  if (replacements["workspace.patch"] !== undefined) {
    const workspace = manifest.evidence.find((entry) => entry.relativePath === "workspace.patch")!;
    const verifier = JSON.parse(readFileSync(join(root, "verifier.json"), "utf8")) as {
      workspace: { digest: string };
    };
    verifier.workspace.digest = workspace.digest;
    replaceArtifact(root, manifest, "verifier.json", Buffer.from(`${JSON.stringify(verifier)}\n`));
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
}

function replaceArtifact(root: string, manifest: SourceManifest, relativePath: string, bytes: Buffer): void {
  writeFileSync(join(root, relativePath), bytes);
  const descriptor = manifest.evidence.find((entry) => entry.relativePath === relativePath)!;
  descriptor.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  descriptor.sizeBytes = bytes.length;
}

function snapshot(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }) as Dirent[]) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, relativePath);
      else files.set(relativePath, readFileSync(path));
    }
  };
  visit(root);
  return files;
}

function firstJsonlRecord(
  root: string,
  manifest: PortableExportManifest,
  kind: PortableExportManifest["artifacts"][number]["kind"],
): Record<string, unknown> {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind)!;
  return JSON.parse(readFileSync(join(root, artifact.relativePath), "utf8").trim().split("\n")[0]!) as Record<string, unknown>;
}

function jsonArtifact(
  root: string,
  manifest: PortableExportManifest,
  kind: PortableExportManifest["artifacts"][number]["kind"],
): Record<string, unknown> {
  const artifact = manifest.artifacts.find((entry) => entry.kind === kind)!;
  return JSON.parse(readFileSync(join(root, artifact.relativePath), "utf8")) as Record<string, unknown>;
}

type SourceManifest = {
  attempt: { id: string };
  evidence: Array<{
    digest: `sha256:${string}`;
    kind: string;
    mediaType: string;
    relativePath: string;
    sharingClass: string;
    sizeBytes: number;
  }>;
};
