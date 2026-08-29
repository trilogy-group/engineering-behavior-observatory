import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  digestBytes,
  executeVerifier,
  readVerifiedArtifact,
  serializeVerifierResult,
  validateArtifact,
  writeVerifierResult,
  type CompleteVerifierResult,
} from "../src/index.js";

const workspaceDigest = `sha256:${"a".repeat(64)}`;

test("executes a verifier outside the agent workspace and preserves diagnostics", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      const fs = require("node:fs");
      const outsideWorkspace = !fs.realpathSync(process.argv[1]).startsWith(fs.realpathSync(process.argv[2]));
      process.stderr.write("a useful diagnostic");
      process.stdout.write(JSON.stringify({ assertions: [
        { id: "workspace-isolation", status: outsideWorkspace ? "passed" : "failed" },
      ] }));
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "passed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.assertions[0]?.id, "workspace-isolation");
    assert.equal(result.assertions[0]?.status, "passed");
    assert.equal(result.diagnostics.length, 2);
    assert.equal(result.diagnostics[1]?.truncated, false);
    assert.equal((await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8")), "a useful diagnostic");
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("preserves failed assertions as a task failure", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [
        { id: "first", status: "passed" },
        { id: "second", status: "failed" },
      ] }));
      process.exitCode = 1;
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "failed");
    assert.deepEqual(result.assertions, [
      { id: "first", status: "passed" },
      { id: "second", status: "failed" },
    ]);
    assert.equal(result.exitCode, 1);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("classifies failed assertions with a zero exit as verifier errors", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "contradiction", status: "failed" }] }));
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "error");
    assert.deepEqual(result.assertions, [{ id: "contradiction", status: "failed" }]);
    assert.match(await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8"), /contradicts/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("returns a verifier error for an oversized assertion ID", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "x".repeat(257), status: "passed" }] }));
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "error");
    assert.deepEqual(result.assertions, []);
    assert.match(await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8"), /invalid.*assertion/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("classifies timeout, crash, and malformed output as verifier errors", async (t) => {
  const cases = [
    {
      name: "timeout",
      source: `process.stderr.write("before-timeout"); setTimeout(() => {}, 10000);`,
      options: { timeoutMs: 150 },
      check: async (result: CompleteVerifierResult, root: Roots) => {
        const diagnostic = await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8");
        assert.match(diagnostic, /before-timeout/);
        assert.match(diagnostic, /timed out/);
      },
    },
    {
      name: "crash",
      source: `throw new Error("verifier crashed");`,
      options: {},
      check: async (result: CompleteVerifierResult) => assert.equal(result.exitCode, 1),
    },
    {
      name: "malformed output",
      source: `process.stdout.write("not-json");`,
      options: {},
      check: async (result: CompleteVerifierResult, root: Roots) => assert.match(
        await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8"),
        /invalid|Unexpected token/i,
      ),
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, async () => {
      const root = await createRoots();
      try {
        const verifier = await addVerifier(root.verifier, item.source);
        const result = await run(root, verifier, item.options);
        assert.equal(result.status, "error");
        await item.check(result, root);
      } finally {
        await rm(root.parent, { force: true, recursive: true });
      }
    });
  }
});

test("bounds oversized diagnostics without losing a valid result", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stderr.write("x".repeat(200));
      process.stdout.write(JSON.stringify({ assertions: [{ id: "small-result", status: "passed" }] }));
    `);
    const result = await run(root, verifier, { maxOutputBytes: 128 });

    assert.equal(result.status, "passed");
    const stderr = result.diagnostics.find((diagnostic) => diagnostic.locator.endsWith("stderr.log"));
    assert.ok(stderr);
    assert.equal(stderr.sizeBytes, 128);
    assert.equal(stderr.truncated, true);
    assert.equal((await readFile(join(root.artifact, stderr.locator))).length, 128);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects truncated verifier protocol output", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      const result = JSON.stringify({ assertions: [{ id: "truncated", status: "passed" }] });
      process.stdout.write(result + "x".repeat(200));
    `);
    const result = await run(root, verifier, { maxOutputBytes: 128 });

    assert.equal(result.status, "error");
    assert.equal(result.diagnostics.find((diagnostic) => diagnostic.locator.endsWith("stdout.log"))?.truncated, true);
    assert.match(await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8"), /stdout exceeded/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects contradictory failed results in public serializers", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "serializable", status: "passed" }] }));
    `);
    const result = await run(root, verifier);
    assert.throws(() => serializeVerifierResult({
      ...result,
      status: "failed",
      exitCode: 0,
      assertions: [{ id: "serializable", status: "failed" }],
    }), /contradicts/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      status: "failed",
      exitCode: undefined,
      assertions: [{ id: "serializable", status: "failed" }],
    }), /contradicts/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      assertions: [
        { id: "serializable", status: "passed" },
        { id: "serializable", status: "passed" },
      ],
    }), /unique/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("represents a not-run verifier without a workspace", () => {
  const result = {
    schemaVersion: "verifier-result/v1" as const,
    bundleId: "bundle-test",
    status: "not-run" as const,
    durationMs: 0,
    assertions: [{ id: "not-started", status: "not-run" as const }],
    diagnostics: [],
  };

  assert.doesNotThrow(() => serializeVerifierResult(result));
});

test("accepts existing v1 results without optional execution fields", () => {
  assert.doesNotThrow(() => serializeVerifierResult({
    schemaVersion: "verifier-result/v1",
    bundleId: "bundle-legacy",
    status: "passed",
    exitCode: 0,
    workspace: { artifactId: "workspace", digest: workspaceDigest },
    assertions: [{ id: "legacy", status: "passed" }],
  }));
});

test("uses POSIX separators in diagnostic locators", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "portable", status: "passed" }] }));
    `);
    const result = await run(root, verifier);
    assert.ok(result.diagnostics.every((diagnostic) => !diagnostic.locator.includes("\\")));
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("terminates a verifier descendant on timeout", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: ["ignore", "inherit", "inherit"] });
      setTimeout(() => {}, 10000);
    `);
    const result = await Promise.race([
      run(root, verifier, { timeoutMs: 50 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("descendant was not terminated")), 2_000)),
    ]);

    assert.equal(result.status, "error");
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("uses distinct diagnostic paths for repeated executions", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stderr.write(process.env.DIAGNOSTIC ?? "first");
      process.stdout.write(JSON.stringify({ assertions: [{ id: "repeatable", status: "passed" }] }));
    `);
    const first = await run(root, verifier, { maxOutputBytes: 128 });
    const second = await run(root, verifier, { maxOutputBytes: 128 });

    assert.notEqual(first.diagnostics[0]?.locator, second.diagnostics[0]?.locator);
    await writeVerifierResult(root.artifact, "first.json", first);
    await writeVerifierResult(root.artifact, "second.json", second);
    assert.equal(await readFile(join(root.artifact, first.diagnostics[1]!.locator), "utf8"), "first");
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("serializes a result that validates against the run-bundle schema", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "serializable", status: "passed" }] }));
    `);
    const result = await run(root, verifier);
    const digest = await writeVerifierResult(root.artifact, "verifier.json", result);
    const bytes = await readVerifiedArtifact(root.artifact, "verifier.json", digest);

    assert.deepEqual(validateArtifact("verifier.json", JSON.parse(bytes.toString("utf8"))), []);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

type Roots = {
  parent: string;
  verifier: string;
  workspace: string;
  artifact: string;
};

async function createRoots(): Promise<Roots> {
  const parent = await mkdtemp(join(tmpdir(), "ebo-verifier-test-"));
  const verifier = join(parent, "restricted");
  const workspace = join(parent, "workspace");
  const artifact = join(parent, "bundle");
  await Promise.all([mkdir(verifier), mkdir(workspace), mkdir(artifact)]);
  return { parent, verifier, workspace, artifact };
}

async function addVerifier(root: string, source: string): Promise<{ locator: string; digest: ReturnType<typeof digestBytes> }> {
  const bytes = Buffer.from(source);
  await writeFile(join(root, "verifier.js"), bytes, { mode: 0o600 });
  return { locator: "verifier.js", digest: digestBytes(bytes) };
}

async function run(
  root: Roots,
  verifier: { locator: string; digest: ReturnType<typeof digestBytes> },
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<CompleteVerifierResult> {
  return executeVerifier({
    bundleId: "bundle-test",
    verifierRoot: root.verifier,
    verifier,
    workspacePath: root.workspace,
    workspace: { artifactId: "workspace", digest: workspaceDigest },
    artifactRoot: root.artifact,
    ...options,
  });
}

function diagnosticPath(result: CompleteVerifierResult, stream: "stdout" | "stderr"): string {
  const diagnostic = result.diagnostics.find((item) => item.locator.endsWith(`${stream}.log`));
  assert.ok(diagnostic);
  return diagnostic.locator;
}
