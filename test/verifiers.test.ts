import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chmod, link, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  digestBytes,
  digestWorkspace,
  executeVerifier,
  readVerifiedArtifact,
  serializeVerifierResult,
  validateArtifact,
  writeVerifierResult,
  type CompleteVerifierResult,
  type VerifierNotRunResult,
  type VerifierResult,
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
    assert.equal(result.verifier?.locator, verifier.locator);
    assert.equal(result.verifier?.digest, `sha256:${verifier.digest.value}`);
    assert.equal(result.workspace.digest, workspaceDigest);
    assert.match(result.workspace.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(Number.isSafeInteger(result.durationMs), true);
    assert.equal(result.assertions[0]?.id, "workspace-isolation");
    assert.equal(result.assertions[0]?.status, "passed");
    assert.equal(result.diagnostics.length, 2);
    assert.equal(result.diagnostics[0]?.stream, "stdout");
    assert.equal(result.diagnostics[1]?.stream, "stderr");
    assert.equal(result.diagnostics[1]?.truncated, false);
    assert.equal((await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8")), "a useful diagnostic");
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("preserves ESM verifier module semantics", async () => {
  const root = await createRoots();
  try {
    const bytes = Buffer.from(`
      import process from "node:process";
      process.stdout.write(JSON.stringify({ assertions: [{ id: "esm", status: "passed" }] }));
    `);
    await writeFile(join(root.verifier, "verifier.mjs"), bytes, { mode: 0o600 });
    const result = await run(root, { locator: "verifier.mjs", digest: digestBytes(bytes) });

    assert.equal(result.status, "passed");
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("evaluates a private workspace snapshot", async () => {
  const root = await createRoots();
  const sourceFile = join(root.workspace, "candidate.txt");
  try {
    await writeFile(sourceFile, "before");
    const workspaceFingerprint = await digestWorkspace(root.workspace);
    const verifier = await addVerifier(root.verifier, `
      const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(${JSON.stringify(sourceFile)}, "after");
      const snapshotValue = fs.readFileSync(path.join(process.argv[2], "candidate.txt"), "utf8");
      process.stdout.write(JSON.stringify({ assertions: [
        { id: "snapshot-is-stable", status: snapshotValue === "before" ? "passed" : "failed" },
      ] }));
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "passed");
    assert.match(result.workspace.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(await readFile(sourceFile, "utf8"), "after");
    assert.notEqual(await digestWorkspace(root.workspace), workspaceFingerprint);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("includes executable modes in workspace fingerprints", async () => {
  const root = await createRoots();
  const executable = join(root.workspace, "tool.sh");
  try {
    await writeFile(executable, "#!/bin/sh\n");
    const readableFingerprint = await digestWorkspace(root.workspace);
    await chmod(executable, 0o755);
    const executableFingerprint = await digestWorkspace(root.workspace);
    const timestamp = new Date(Date.now() - 60_000);
    await utimes(executable, timestamp, timestamp);
    const timestampFingerprint = await digestWorkspace(root.workspace);
    await chmod(root.workspace, 0o555);
    const rootModeFingerprint = await digestWorkspace(root.workspace);

    assert.notEqual(executableFingerprint, readableFingerprint);
    assert.notEqual(timestampFingerprint, executableFingerprint);
    assert.notEqual(rootModeFingerprint, executableFingerprint);
  } finally {
    await chmod(root.workspace, 0o755);
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects hard-linked workspace files", async () => {
  const root = await createRoots();
  try {
    const original = join(root.workspace, "original.txt");
    await writeFile(original, "shared");
    await link(original, join(root.workspace, "alias.txt"));

    await assert.rejects(digestWorkspace(root.workspace), /hard-linked file/);
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
    assert.match(result.error ?? "", /contradicts/);
    assert.equal(await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8"), "");
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
    assert.match(result.error ?? "", /invalid.*assertion/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("returns a verifier error for undeclared assertion fields", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "extra-field", status: "passed", error: "unexpected" }] }));
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "error");
    assert.deepEqual(result.assertions, []);
    assert.match(result.error ?? "", /invalid.*assertion/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("returns a verifier error for a non-string assertion status", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "bad-status", status: ["passed"] }] }));
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "error");
    assert.deepEqual(result.assertions, []);
    assert.match(result.error ?? "", /invalid.*assertion/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects duplicate JSON object keys in verifier output", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write('{"assertions":[{"id":"duplicate-key","status":"failed","status":"passed"}]}');
    `);
    const result = await run(root, verifier);

    assert.equal(result.status, "error");
    assert.deepEqual(result.assertions, []);
    assert.match(result.error ?? "", /duplicate JSON/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects arbitrary verifier commands before execution", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "unused", status: "passed" }] }));
    `);
    await assert.rejects(
      run(root, verifier, { command: join(root.parent, "missing-command") }),
      /pinned Node runtime/,
    );
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects launcher arguments that replace the staged verifier", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "unused", status: "passed" }] }));
    `);
    await assert.rejects(
      run(root, verifier, {
        command: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ assertions: [{ id: 'bypass', status: 'passed' }] }))"],
      }),
      /launcher arguments cannot replace/,
    );
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("strips Node preload options from the verifier environment", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "preload-stripped", status: process.env.NODE_OPTIONS === undefined ? "passed" : "failed" }] }));
    `);
    const result = await run(root, verifier, {
      env: {
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: "--eval=process.exit(1)",
        LD_PRELOAD: "/missing/preload.dylib",
        DYLD_INSERT_LIBRARIES: "/missing/injected.dylib",
      },
    });

    assert.equal(result.status, "passed");
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("keeps verifier staging outside a workspace-local temp directory", async () => {
  const root = await createRoots();
  const previousTempDirectory = process.env.TMPDIR;
  process.env.TMPDIR = root.workspace;
  try {
    const verifier = await addVerifier(root.verifier, `
      const fs = require("node:fs");
      const outsideWorkspace = !fs.realpathSync(process.argv[1]).startsWith(fs.realpathSync(process.argv[2]));
      process.stdout.write(JSON.stringify({ assertions: [{ id: "staging-isolation", status: outsideWorkspace ? "passed" : "failed" }] }));
    `);
    const result = await run(root, verifier);
    assert.equal(result.status, "passed");
  } finally {
    if (previousTempDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTempDirectory;
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects an artifact root inside the workspace before creating it", async () => {
  const root = await createRoots();
  const artifactRoot = join(root.workspace, "bundle-output");
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "should-not-run", status: "passed" }] }));
    `);
    await assert.rejects(() => executeVerifier({
      bundleId: "bundle-test",
      verifierRoot: root.verifier,
      verifier,
      workspacePath: root.workspace,
      workspaceFingerprint: workspaceDigest,
      workspace: { artifactId: "workspace", digest: workspaceDigest, fingerprint: workspaceDigest },
      artifactRoot,
    }), /Artifact and workspace roots/);
    assert.equal(existsSync(artifactRoot), false);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects a workspace fingerprint that does not match evaluated bytes", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "should-not-run", status: "passed" }] }));
    `);
    await assert.rejects(() => executeVerifier({
      bundleId: "bundle-test",
      verifierRoot: root.verifier,
      verifier,
      workspacePath: root.workspace,
      workspaceFingerprint: workspaceDigest,
      workspace: { artifactId: "workspace", digest: workspaceDigest, fingerprint: workspaceDigest },
      artifactRoot: root.artifact,
    }), /does not match the evaluated workspace/);
    assert.equal(existsSync(join(root.artifact, "diagnostics")), false);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("returns a structured error when diagnostic setup fails", async () => {
  const root = await createRoots();
  try {
    const occupiedPath = join(root.artifact, "occupied");
    await writeFile(occupiedPath, "not a directory");
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "should-not-run", status: "passed" }] }));
    `);
    const result = await run(root, verifier, { diagnosticDirectory: "occupied" });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /directory|regular file|setup|exists/i);
    assert.deepEqual(result.assertions, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects overlong execution identifiers before starting", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "should-not-run", status: "passed" }] }));
    `);
    await assert.rejects(() => executeVerifier({
      bundleId: "x".repeat(257),
      verifierRoot: root.verifier,
      verifier,
      workspacePath: root.workspace,
      workspaceFingerprint: workspaceDigest,
      workspace: { artifactId: "workspace", digest: workspaceDigest, fingerprint: workspaceDigest },
      artifactRoot: root.artifact,
    }), /Bundle ID/);
    await assert.rejects(() => executeVerifier({
      bundleId: "bundle-test",
      verifierRoot: root.verifier,
      verifier,
      workspacePath: root.workspace,
      workspaceFingerprint: workspaceDigest,
      workspace: { artifactId: "x".repeat(257), digest: workspaceDigest, fingerprint: workspaceDigest },
      artifactRoot: root.artifact,
    }), /Workspace reference/);
    await assert.rejects(() => executeVerifier({
      bundleId: "bundle-test",
      verifierRoot: root.verifier,
      verifier,
      workspacePath: root.workspace,
      workspaceFingerprint: workspaceDigest,
      workspace: { artifactId: "workspace", digest: workspaceDigest, fingerprint: workspaceDigest },
      artifactRoot: root.artifact,
      timeoutMs: 2_147_483_648,
    }), /timeout/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("classifies timeout, crash, and malformed output as verifier errors", async (t) => {
  const cases = [
    {
      name: "timeout",
      source: `process.stderr.write("before-timeout"); setTimeout(() => {}, 10000);`,
      options: { timeoutMs: 1_000 },
      check: async (result: CompleteVerifierResult, root: Roots) => {
        const diagnostic = await readFile(join(root.artifact, diagnosticPath(result, "stderr")), "utf8");
        assert.match(diagnostic, /before-timeout/);
        assert.doesNotMatch(diagnostic, /timed out/);
        assert.match(result.error ?? "", /timed out/);
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
        result.error ?? "",
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

test("settles timeout when a detached descendant inherits verifier pipes", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      }).unref();
      process.exit(0);
    `);
    const result = await Promise.race([
      run(root, verifier, { timeoutMs: 50 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout did not settle")), 1_000)),
    ]);

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /timed out/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
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
    assert.match(result.error ?? "", /stdout exceeded/);
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
    } as unknown as VerifierResult), /contradicts/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      status: "failed",
      exitCode: undefined,
      assertions: [{ id: "serializable", status: "failed" }],
    } as unknown as VerifierResult), /contradicts/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      exitCode: 1,
    } as unknown as VerifierResult), /must be equal to constant|must be 0/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      assertions: [{ id: "serializable", status: "failed" }],
    } as unknown as VerifierResult), /must be equal to constant|must be valid/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      assertions: [
        { id: "serializable", status: "passed" },
        { id: "serializable", status: "passed" },
      ],
    } as unknown as VerifierResult), /unique/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      diagnostics: [result.diagnostics[0]!, { ...result.diagnostics[0]!, truncated: true }],
    } as unknown as VerifierResult), /diagnostic locators must be unique/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      diagnostics: [result.diagnostics[0]!, { ...result.diagnostics[1]!, stream: "stdout", locator: "other.log" }],
    } as unknown as VerifierResult), /diagnostic streams must be unique/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      diagnostics: [{ ...result.diagnostics[0]!, locator: "Logs" }, { ...result.diagnostics[1]!, locator: "logs/stdout.log" }],
    } as unknown as VerifierResult), /diagnostic locators must be unique and non-overlapping/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      error: "unexpected coordinator error",
    } as unknown as VerifierResult), /must NOT be valid/);
    assert.throws(() => serializeVerifierResult({
      ...result,
      status: "error",
      error: "raw coordinator error",
      errorRedacted: true,
    } as unknown as VerifierResult), /must be equal to constant|must be valid/);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("represents a not-run verifier without a workspace", () => {
  const result: VerifierNotRunResult = {
    schemaVersion: "verifier-result/v1" as const,
    bundleId: "bundle-test",
    status: "not-run" as const,
    assertions: [{ id: "not-started", status: "not-run" as const }],
  };

  assert.doesNotThrow(() => serializeVerifierResult(result));
  assert.throws(() => serializeVerifierResult({ ...result, durationMs: 0 } as unknown as VerifierResult), /must NOT be valid|durationMs/);
  assert.throws(() => serializeVerifierResult({
    ...result,
    diagnostics: [{
      locator: "diagnostics.log",
      digest: `sha256:${"a".repeat(64)}`,
      sizeBytes: 0,
      truncated: false,
    }],
  } as unknown as VerifierResult), /more than 0|must NOT be valid/);
  assert.throws(() => serializeVerifierResult({
    ...result,
    assertions: [{ id: "not-started", status: "passed" }],
  } as unknown as VerifierResult), /must be equal to constant|must be valid/);
});

test("represents a pre-workspace verifier error without inventing a workspace", () => {
  assert.doesNotThrow(() => serializeVerifierResult({
    schemaVersion: "verifier-result/v1",
    bundleId: "bundle-error",
    status: "error",
    error: "verifier was not started",
    assertions: [],
  }));
  assert.throws(() => serializeVerifierResult({
    schemaVersion: "verifier-result/v1",
    bundleId: "bundle-error",
    status: "error",
    assertions: [],
  } as unknown as VerifierResult), /required property.*error|error/);
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

test("counts Unicode assertion IDs by code point", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "🙂".repeat(200), status: "passed" }] }));
    `);
    const result = await run(root, verifier);
    assert.equal(result.status, "passed");
    assert.equal([...result.assertions[0]!.id].length, 200);
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

test("terminates a background descendant before returning a result", async () => {
  const root = await createRoots();
  const marker = join(root.workspace, "descendant-marker");
  try {
    const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "leaked"), 500);`;
    const verifier = await addVerifier(root.verifier, `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" }).unref();
      process.stdout.write(JSON.stringify({ assertions: [{ id: "background-clean", status: "passed" }] }));
    `);
    const result = await run(root, verifier);
    await new Promise((resolve) => setTimeout(resolve, 700));

    assert.equal(result.status, "passed");
    assert.equal(existsSync(marker), false);
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

test("rejects result paths that collide with diagnostics", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "path-safe", status: "passed" }] }));
    `);
    const result = await run(root, verifier);
    const diagnostic = result.diagnostics[0]!;

    await assert.rejects(
      writeVerifierResult(root.artifact, diagnostic.locator, result),
      /collides with a diagnostic/,
    );
    await assert.rejects(
      writeVerifierResult(root.artifact, diagnostic.locator.toUpperCase(), result),
      /collides with a diagnostic/,
    );
    await assert.rejects(
      writeVerifierResult(root.artifact, "Logs", {
        ...result,
        diagnostics: [{ ...diagnostic, locator: "logs/stdout.log" }],
      }),
      /collides with a diagnostic/,
    );
    await assert.rejects(
      writeVerifierResult(root.artifact, "manifest.json", result),
      /reserved manifest path/,
    );
    await assert.rejects(
      writeVerifierResult(root.artifact, "manifest.json/verifier.json", result),
      /reserved manifest path/,
    );
    await assert.rejects(
      writeVerifierResult(root.artifact, "verifier.json", {
        ...result,
        diagnostics: [{ ...diagnostic, locator: "manifest.json/stdout.log" }],
      }),
      /reserved manifest path/,
    );
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("rejects diagnostic directories in the reserved manifest namespace", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "reserved", status: "passed" }] }));
    `);
    await assert.rejects(
      run(root, verifier, { diagnosticDirectory: "manifest.json" }),
      /reserved manifest path/,
    );
    await assert.rejects(
      run(root, verifier, { diagnosticDirectory: "Manifest.json/diagnostics" }),
      /reserved manifest path/,
    );
    assert.equal(existsSync(join(root.artifact, "manifest.json")), false);
  } finally {
    await rm(root.parent, { force: true, recursive: true });
  }
});

test("does not replace an existing verifier result", async () => {
  const root = await createRoots();
  try {
    const verifier = await addVerifier(root.verifier, `
      process.stdout.write(JSON.stringify({ assertions: [{ id: "no-clobber", status: "passed" }] }));
    `);
    const result = await run(root, verifier);
    const firstDigest = await writeVerifierResult(root.artifact, "verifier.json", result);

    await assert.rejects(
      writeVerifierResult(root.artifact, "verifier.json", result),
      /already exists/,
    );
    assert.deepEqual(await readVerifiedArtifact(root.artifact, "verifier.json", firstDigest), Buffer.from(serializeVerifierResult(result)));
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
  options: { timeoutMs?: number; maxOutputBytes?: number; command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv; diagnosticDirectory?: string } = {},
): Promise<CompleteVerifierResult> {
  const workspaceFingerprint = await digestWorkspace(root.workspace);
  const workspace = {
    artifactId: "workspace",
    digest: workspaceDigest,
    fingerprint: workspaceFingerprint,
  };
  return executeVerifier({
    bundleId: "bundle-test",
    verifierRoot: root.verifier,
    verifier,
    workspacePath: root.workspace,
    workspaceFingerprint,
    workspace,
    artifactRoot: root.artifact,
    ...options,
  });
}

function diagnosticPath(result: CompleteVerifierResult, stream: "stdout" | "stderr"): string {
  const diagnostic = result.diagnostics.find((item) => item.locator.endsWith(`${stream}.log`));
  assert.ok(diagnostic);
  return diagnostic.locator;
}
