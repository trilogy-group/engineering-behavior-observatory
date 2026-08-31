import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
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
const heuristicSecret = "unseeded-password-value-98765";
const databaseUrl = "postgres://user:password@private.example/database";
const clientSecret = "client-secret-value-12345";
const privateKey = "private-key-value-12345";
const secretAccessKey = "aws-secret-value-12345";
const credentialsJson = "credential-json-value-12345";

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
        attemptId: "attempt-complete-1",
        tool_result: "x".repeat(200),
        apiKey: token,
        path: join(homedir(), "private", "result.txt"),
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
      "workspace.patch": `${readFileSync(join(fixtureRoot, "workspace.patch"), "utf8")}+${homedir()}/private/result.txt ${userInfo().username} ${token} password=\"${heuristicSecret}\" client_secret=\"${clientSecret}\"\n`,
    });
    const sourceBefore = snapshot(source);
    const policy: PortableExportPolicy = {
      sharingClass: "public",
      maxArtifactBytes: 4096,
      maxStringBytes: 48,
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
    assert.equal(session.session_id, manifest.correlations.sessionId);
    assert.equal(hook.session_id, manifest.correlations.sessionId);
    assert.equal(telemetry.traceId, manifest.correlations.traceId);
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
  evidence: Array<{
    digest: `sha256:${string}`;
    kind: string;
    mediaType: string;
    relativePath: string;
    sharingClass: string;
    sizeBytes: number;
  }>;
};
