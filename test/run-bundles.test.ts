import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createRunBundleAssembler,
  digestWorkspaceTree,
  inspectRetainedArtifact,
  validateArtifact,
  validateRunManifestEvidence,
  type CapturedWorkspaceOutcome,
  type ClaudeAgentSdkAttemptEvidence,
  type RunBundleAssembler,
  type RunBundleDefinition,
  type RunManifest,
} from "../src/index.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;
const SHA_C = `sha256:${"c".repeat(64)}` as const;
const SHA_D = `sha256:${"d".repeat(64)}` as const;

type OutcomeCase = {
  name: string;
  terminal: RunManifest["terminal"];
  verifier?: "passed" | "failed";
  telemetry: boolean;
  qualification: "qualified" | "incomplete";
  timingStatus: "available" | "not-checked";
};

for (const scenario of [
  {
    name: "complete",
    terminal: { state: "completed", failureClass: "none", stopReason: "none", workspaceArtifactId: "workspace" },
    verifier: "passed",
    telemetry: true,
    qualification: "qualified",
    timingStatus: "available",
  },
  {
    name: "task-failed",
    terminal: { state: "failed", failureClass: "task", stopReason: "none", workspaceArtifactId: "workspace" },
    verifier: "failed",
    telemetry: true,
    qualification: "qualified",
    timingStatus: "available",
  },
  {
    name: "infrastructure-failed",
    terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none" },
    telemetry: true,
    qualification: "incomplete",
    timingStatus: "available",
  },
  {
    name: "capture-incomplete",
    terminal: { state: "completed", failureClass: "none", stopReason: "none", workspaceArtifactId: "workspace" },
    verifier: "passed",
    telemetry: true,
    qualification: "incomplete",
    timingStatus: "not-checked",
  },
] satisfies OutcomeCase[]) {
  test(`assembles a schema-valid ${scenario.name} run bundle`, async () => {
    const root = mkdtempSync(join(tmpdir(), `ebo-run-bundle-${scenario.name}-`));
    try {
      const bundleRoot = join(root, "bundle");
      const assembler = await createRunBundleAssembler(definition(bundleRoot, scenario.name));
      await retainSemanticEvidence(assembler, bundleRoot, scenario.name);
      if (scenario.telemetry) await retainUsage(
        assembler,
        scenario.name === "capture-incomplete" ? "not-checked" : "received",
      );

      let workspace: CapturedWorkspaceOutcome | undefined;
      if (scenario.verifier !== undefined) {
        const fixture = createWorkspaceFixture(root);
        workspace = await assembler.captureWorkspaceOutcome({
          startPath: fixture.start,
          finalPath: fixture.final,
        });
        await retainVerifier(assembler, scenario.name, scenario.verifier, workspace);
      }

      const manifest = await assembler.finalize({ terminal: scenario.terminal });
      assert.deepEqual(assertBundleValid(bundleRoot), manifest);
      const reportDescriptor = manifest.evidence.find((descriptor) => descriptor.kind === "capture-report")!;
      const report = JSON.parse(readFileSync(join(bundleRoot, reportDescriptor.relativePath), "utf8")) as {
        qualification: string;
        capabilities: { timingResource: { status: string } };
        semanticEvidenceKinds: string[];
      };
      assert.equal(report.qualification, scenario.qualification);
      assert.equal(report.capabilities.timingResource.status, scenario.timingStatus);
      assert.deepEqual(report.semanticEvidenceKinds, ["session", "hook"]);
      assert.equal(JSON.stringify(manifest).includes("persistence"), false);
      assert.equal(JSON.stringify(manifest).includes("input_tokens"), false, "usage remains in native evidence, not manifest attributes");
      if (scenario.telemetry) {
        const telemetry = manifest.evidence.find((descriptor) => descriptor.kind === "telemetry")!;
        const document = JSON.parse(readFileSync(join(bundleRoot, telemetry.relativePath), "utf8")) as {
          attemptId: string;
          telemetry: { receipt: { status: string } };
          usage: { source: string; totalCostUsd: number };
        };
        assert.equal(document.attemptId, manifest.attempt.id);
        assert.equal(document.telemetry.receipt.status, scenario.timingStatus === "not-checked" ? "not-checked" : "received");
        assert.equal(manifest.run.native?.traceId, `trace-${manifest.attempt.id}`);
        assert.deepEqual(document.usage, {
          source: "sdk-result",
          totalCostUsd: 0.25,
          numTurns: 1,
          mainLoop: { input_tokens: 3, output_tokens: 5 },
          byModel: { "claude-test": { inputTokens: 3, outputTokens: 5, costUSD: 0.25 } },
        });
      }
      if (workspace !== undefined) assert.equal(workspace.descriptor.fingerprint, workspace.fingerprint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("workspace patch capture does not start Git background maintenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-maintenance-"));
  const trace = join(root, "git-trace.jsonl");
  const previous = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    const fixture = createWorkspaceFixture(root, true);
    const bundleRoot = join(root, "bundle");
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "maintenance"));
    const outcome = await assembler.captureWorkspaceOutcome({ startPath: fixture.start, finalPath: fixture.final });
    assert.equal(outcome.format, "patch");
    assertBundleValid(bundleRoot);
    const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv?: string[] });
    assert.equal(events.some(({ argv }) => argv?.includes("maintenance") || argv?.includes("gc")), false,
      "temporary capture repositories must not start background writers that race cleanup");
  } finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure after every evidence stage retains a valid partial bundle", async () => {
  for (let completedStages = 0; completedStages <= 5; completedStages += 1) {
    const root = mkdtempSync(join(tmpdir(), `ebo-run-bundle-stage-${completedStages}-`));
    try {
      const bundleRoot = join(root, "bundle");
      const assembler = await createRunBundleAssembler(definition(bundleRoot, `stage-${completedStages}`));
      const fixture = createWorkspaceFixture(root);
      let workspace: CapturedWorkspaceOutcome | undefined;
      const stages = [
        async () => retainSession(assembler, bundleRoot, `stage-${completedStages}`),
        async () => retainHooks(assembler, bundleRoot, `stage-${completedStages}`),
        async () => retainUsage(assembler),
        async () => { workspace = await assembler.captureWorkspaceOutcome({ startPath: fixture.start, finalPath: fixture.final }); },
        async () => retainVerifier(assembler, `stage-${completedStages}`, "passed", workspace!),
      ];
      for (const stage of stages.slice(0, completedStages)) await stage();

      await assert.rejects(assembler.finalize({
        terminal: { state: "completed", failureClass: "none", stopReason: "none", workspaceArtifactId: "missing-workspace" },
      }), /Terminal workspace|terminal/i);

      const retained = assertBundleValid(bundleRoot);
      assert.equal(retained.terminal.state, "interrupted");
      assert.equal(retained.evidence.length, completedStages + 1);
      for (const descriptor of retained.evidence) {
        const inspected = await inspectRetainedArtifact(bundleRoot, descriptor.relativePath);
        assert.equal(`sha256:${inspected.digest.value}`, descriptor.digest);
        assert.equal(inspected.sizeBytes, descriptor.sizeBytes);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("workspace patches reproduce the final content and executable-mode tree digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-patch-"));
  try {
    const bundleRoot = join(root, "bundle");
    const fixture = createWorkspaceFixture(root, true);
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "patch"));
    const captured = await assembler.captureWorkspaceOutcome({ startPath: fixture.start, finalPath: fixture.final });
    assert.equal(captured.format, "patch");
    const applied = join(root, "applied");
    cpSync(fixture.start, applied, { recursive: true, preserveTimestamps: true });
    const appliedPatch = spawnSync("git", ["apply", "--binary", join(bundleRoot, captured.descriptor.relativePath)], {
      cwd: applied,
      encoding: "utf8",
    });
    assert.equal(appliedPatch.status, 0, appliedPatch.stderr);
    assert.equal(await digestWorkspaceTree(applied), captured.treeDigest);
    assert.equal(await digestWorkspaceTree(fixture.final), captured.treeDigest);
    assert.notEqual(await digestWorkspaceTree(fixture.start), captured.treeDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace outcome excludes declared transient directory names", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-filtered-patch-"));
  const gitConfiguration = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
    .map((name) => [name, process.env[name]] as const);
  try {
    const bundleRoot = join(root, "bundle");
    const fixture = createWorkspaceFixture(root, true);
    mkdirSync(join(fixture.final, "node_modules"));
    symlinkSync("../changed.txt", join(fixture.final, "node_modules", "linked-package"));
    mkdirSync(join(fixture.final, "coverage"));
    writeFileSync(join(fixture.final, "coverage", "summary.json"), "generated\n");
    mkdirSync(join(fixture.final, "legitimate"));
    writeFileSync(join(fixture.final, "legitimate", "coverage"), "must remain observable\n");
    writeFileSync(join(fixture.start, ".gitignore"), "ignored.bin\ngenerated/\n");
    writeFileSync(join(fixture.final, ".gitignore"), "ignored.bin\nnew-outcome.txt\n");
    mkdirSync(join(fixture.final, "generated"));
    writeFileSync(join(fixture.final, "generated", "cache.txt"), "generated\n");
    writeFileSync(join(fixture.final, "new-outcome.txt"), "must remain observable\n");
    if (process.platform !== "win32") {
      writeFileSync(join(fixture.final, "node_modules\\result.txt"), "backslash is not a POSIX separator\n");
    }
    const ambientExcludes = join(root, "ambient-excludes");
    writeFileSync(ambientExcludes, "ambient-only.txt\n");
    writeFileSync(join(fixture.final, "ambient-only.txt"), "must ignore ambient Git configuration\n");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.excludesFile";
    process.env.GIT_CONFIG_VALUE_0 = ambientExcludes;
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "filtered-patch"));
    const captured = await assembler.captureWorkspaceOutcome({
      startPath: fixture.start,
      finalPath: fixture.final,
      excludeDirectoryNames: ["node_modules", "coverage"],
      respectGitignore: true,
      omitEmptyDirectories: true,
    }, async (projectedPath) => {
      assert.equal(statSync(projectedPath, { bigint: true }).mtimeNs, statSync(fixture.final, { bigint: true }).mtimeNs);
      assert.equal(
        statSync(join(projectedPath, "legitimate"), { bigint: true }).mtimeNs,
        statSync(join(fixture.final, "legitimate"), { bigint: true }).mtimeNs,
      );
      if (process.platform !== "win32") {
        assert.equal(readFileSync(join(projectedPath, "node_modules\\result.txt"), "utf8"), "backslash is not a POSIX separator\n");
      }
    });
    assert.equal(captured.format, "patch");
    const patch = readFileSync(join(bundleRoot, captured.descriptor.relativePath), "utf8");
    assert.match(patch, /changed\.txt/u);
    assert.match(patch, /diff --git a\/new-outcome\.txt b\/new-outcome\.txt/u);
    assert.match(patch, /diff --git a\/ambient-only\.txt b\/ambient-only\.txt/u);
    assert.match(patch, /diff --git a\/legitimate\/coverage b\/legitimate\/coverage/u);
    assert.match(patch, /diff --git a\/ignored\.bin b\/ignored\.bin[\s\S]*deleted file mode/u);
    assert.doesNotMatch(patch, /node_modules\/|coverage\/summary|generated\/cache/u);
  } finally {
    for (const [name, value] of gitConfiguration) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace outcome omits empty directories without another projection filter", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-empty-directory-"));
  try {
    const bundleRoot = join(root, "bundle");
    const fixture = createWorkspaceFixture(root);
    mkdirSync(join(fixture.final, "empty"));
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "empty-directory"));
    const captured = await assembler.captureWorkspaceOutcome({
      startPath: fixture.start,
      finalPath: fixture.final,
      omitEmptyDirectories: true,
    });
    assert.equal(captured.format, "patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace projection rejects hard-linked source evidence before copying it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-projected-hard-link-"));
  try {
    const fixture = createWorkspaceFixture(root);
    linkSync(join(fixture.final, "changed.txt"), join(fixture.final, "linked.txt"));
    const assembler = await createRunBundleAssembler(definition(join(root, "bundle"), "projected-hard-link"));
    await assert.rejects(assembler.captureWorkspaceOutcome({
      startPath: fixture.start,
      finalPath: fixture.final,
      omitEmptyDirectories: true,
    }), /hard-linked file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("falls back to a bounded standard snapshot when a patch cannot preserve the tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-snapshot-"));
  try {
    const bundleRoot = join(root, "bundle");
    const fixture = createWorkspaceFixture(root);
    mkdirSync(join(fixture.final, "empty"));
    chmodSync(join(fixture.final, "changed.txt"), 0o666);
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "snapshot"));
    const captured = await assembler.captureWorkspaceOutcome({ startPath: fixture.start, finalPath: fixture.final });
    assert.equal(captured.format, "snapshot");
    assert.equal(captured.descriptor.mediaType, "application/gzip");
    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    const extraction = spawnSync("tar", ["-xzpf", join(bundleRoot, captured.descriptor.relativePath), "-C", extracted], {
      encoding: "utf8",
    });
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.equal(await digestWorkspaceTree(join(extracted, "workspace")), captured.treeDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized patch falls back to a bounded compressible snapshot", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-large-patch-"));
  try {
    const bundleRoot = join(root, "bundle");
    const fixture = createWorkspaceFixture(root);
    writeFileSync(join(fixture.final, "changed.txt"), Buffer.alloc(64 * 1024 * 1024, 0x61));
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "large-patch"));
    const captured = await assembler.captureWorkspaceOutcome({ startPath: fixture.start, finalPath: fixture.final });
    assert.equal(captured.format, "snapshot");
    assert.ok(captured.descriptor.sizeBytes < 64 * 1024 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage-only evidence keeps telemetry capture explicitly missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-usage-only-"));
  try {
    const bundleRoot = join(root, "bundle");
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "usage-only"));
    await assembler.writeAgentSdkTelemetry({
      evidence: {
        usage: {
          source: "sdk-result",
          totalCostUsd: 0.25,
          numTurns: 1,
          mainLoop: { input_tokens: 3, output_tokens: 5 },
          byModel: {},
        },
      } as unknown as Pick<ClaudeAgentSdkAttemptEvidence, "telemetry" | "usage">,
    });
    const manifest = assertBundleValid(bundleRoot);
    const report = JSON.parse(readFileSync(join(
      bundleRoot,
      manifest.evidence.find((descriptor) => descriptor.kind === "capture-report")!.relativePath,
    ), "utf8")) as { capabilities: { timingResource: { status: string } }; missingEvidence: Array<{ kind: string }> };
    assert.equal(report.capabilities.timingResource.status, "missing");
    assert.ok(report.missingEvidence.some((entry) => entry.kind === "telemetry"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed telemetry write does not poison a confirmed retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-bundle-telemetry-retry-"));
  try {
    const bundleRoot = join(root, "bundle");
    const assembler = await createRunBundleAssembler(definition(bundleRoot, "telemetry-retry"));
    mkdirSync(join(bundleRoot, "telemetry"));
    writeFileSync(join(bundleRoot, "telemetry", "agent-sdk.json"), "occupied");
    await assert.rejects(assembler.writeAgentSdkTelemetry({
      evidence: {
        usage: {
          source: "sdk-result",
          totalCostUsd: 0.25,
          numTurns: 1,
          mainLoop: { input_tokens: 3, output_tokens: 5 },
          byModel: {},
        },
      } as unknown as Pick<ClaudeAgentSdkAttemptEvidence, "telemetry" | "usage">,
    }), /already exists/);
    await assembler.writeAgentSdkTelemetry({
      relativePath: "telemetry/confirmed.json",
      evidence: {
        telemetry: { receipt: { status: "received", signals: ["traces", "metrics", "logs"] } },
      } as unknown as Pick<ClaudeAgentSdkAttemptEvidence, "telemetry" | "usage">,
    });
    const manifest = assertBundleValid(bundleRoot);
    const report = JSON.parse(readFileSync(join(
      bundleRoot,
      manifest.evidence.find((descriptor) => descriptor.kind === "capture-report")!.relativePath,
    ), "utf8")) as { capabilities: { timingResource: { status: string } }; missingEvidence: Array<{ kind: string }> };
    assert.equal(report.capabilities.timingResource.status, "available");
    assert.equal(report.missingEvidence.some((entry) => ["telemetry", "telemetry-receipt"].includes(entry.kind)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function definition(bundleRoot: string, suffix: string): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-${suffix}`,
    run: {
      id: `run-${suffix}`,
      assessmentMode: "verified",
      task: { id: "task-example" },
      fixture: { id: "fixture-example", digest: SHA_A },
      model: { provider: "anthropic", id: "claude-test" },
      harness: { id: "agent-sdk", version: "1.0.0" },
      runtime: [{ source: "anthropic", name: "agent-sdk", version: "1.0.0" }],
    },
    attempt: { id: `attempt-${suffix}`, number: 1 },
    configuration: { digest: SHA_B, budgetDigest: SHA_C, toolPolicyDigest: SHA_D },
  };
}

async function retainSemanticEvidence(assembler: RunBundleAssembler, bundleRoot: string, suffix: string): Promise<void> {
  await retainSession(assembler, bundleRoot, suffix);
  await retainHooks(assembler, bundleRoot, suffix);
}

async function retainSession(assembler: RunBundleAssembler, bundleRoot: string, suffix: string): Promise<void> {
  writeFileSync(join(bundleRoot, "session.jsonl"), `${JSON.stringify({ type: "result", session_id: `session-${suffix}` })}\n`);
  await assembler.registerArtifact({
    id: "session",
    source: "native-session",
    kind: "session",
    mediaType: "application/x-ndjson",
    sharingClass: "restricted",
    relativePath: "session.jsonl",
    nativeReference: { type: "session", id: `session-${suffix}` },
  });
}

async function retainHooks(assembler: RunBundleAssembler, bundleRoot: string, suffix: string): Promise<void> {
  writeFileSync(join(bundleRoot, "hooks.jsonl"), `${JSON.stringify({ type: "PostToolUse", session_id: `session-${suffix}` })}\n`);
  await assembler.registerArtifact({
    id: "hooks",
    source: "native-hooks",
    kind: "hook",
    mediaType: "application/x-ndjson",
    sharingClass: "restricted",
    relativePath: "hooks.jsonl",
    nativeReference: { type: "hook-stream", id: `hooks-${suffix}` },
  });
}

async function retainUsage(
  assembler: RunBundleAssembler,
  receiptStatus: "received" | "not-checked" = "received",
): Promise<void> {
  await assembler.writeAgentSdkTelemetry({
    evidence: {
      telemetry: {
        receipt: receiptStatus === "received"
          ? { status: "received", signals: ["traces", "metrics", "logs"] }
          : { status: "not-checked", signals: [], reason: "no-receipt-check" },
      },
      usage: {
        source: "sdk-result",
        totalCostUsd: 0.25,
        numTurns: 1,
        mainLoop: { input_tokens: 3, output_tokens: 5 },
        byModel: { "claude-test": { inputTokens: 3, outputTokens: 5, costUSD: 0.25 } },
      },
    } as unknown as Pick<ClaudeAgentSdkAttemptEvidence, "telemetry" | "usage">,
    traceId: `trace-${assembler.attempt.id}`,
  });
}

async function retainVerifier(
  assembler: RunBundleAssembler,
  suffix: string,
  status: "passed" | "failed",
  workspace: CapturedWorkspaceOutcome,
): Promise<void> {
  await assembler.writeJsonArtifact({
    id: "verifier",
    source: "ebo-verifier",
    kind: "verifier",
    mediaType: "application/json",
    sharingClass: "restricted",
    relativePath: "verifier.json",
  }, {
    schemaVersion: "verifier-result/v1",
    bundleId: `bundle-${suffix}`,
    status,
    exitCode: status === "passed" ? 0 : 1,
    workspace: {
      artifactId: workspace.descriptor.id,
      digest: workspace.descriptor.digest,
      fingerprint: workspace.fingerprint,
    },
    assertions: [{ id: "task", status }],
  });
}

function createWorkspaceFixture(root: string, binary = false): { start: string; final: string } {
  const start = join(root, "start");
  const final = join(root, "final");
  mkdirSync(start);
  writeFileSync(join(start, "changed.txt"), "before\n");
  writeFileSync(join(start, "deleted.txt"), "remove me\n");
  writeFileSync(join(start, "mode.sh"), "#!/bin/sh\nexit 0\n");
  if (binary) {
    writeFileSync(join(start, ".gitignore"), "ignored.bin\n");
    writeFileSync(join(start, "ignored.bin"), Buffer.from([0, 1]));
  }
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  writeFileSync(join(final, "changed.txt"), "after\n");
  rmSync(join(final, "deleted.txt"));
  writeFileSync(join(final, binary ? "added.bin" : "added.txt"), binary ? Buffer.from([0, 1, 2, 0xff]) : "added\n");
  if (binary) writeFileSync(join(final, "ignored.bin"), Buffer.from([2, 3]));
  chmodSync(join(final, "mode.sh"), 0o755);
  return { start, final };
}

function assertBundleValid(bundleRoot: string): RunManifest {
  const manifest = JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as RunManifest;
  assert.deepEqual(validateArtifact("manifest.json", manifest), []);
  assert.deepEqual(validateRunManifestEvidence("manifest.json", manifest, bundleRoot), []);
  for (const descriptor of manifest.evidence) {
    if (descriptor.kind === "capture-report" || descriptor.kind === "verifier") {
      assert.deepEqual(validateArtifact(descriptor.relativePath, JSON.parse(readFileSync(join(bundleRoot, descriptor.relativePath), "utf8"))), []);
    }
  }
  return manifest;
}
