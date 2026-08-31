import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  type CapturedWorkspacePatch,
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
  missingEvidence?: Array<{
    kind: string;
    reason: "not-checked";
    affects: ["timing-resource"];
  }>;
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
    missingEvidence: [{ kind: "telemetry-receipt", reason: "not-checked", affects: ["timing-resource"] }],
  },
] satisfies OutcomeCase[]) {
  test(`assembles a schema-valid ${scenario.name} run bundle`, async () => {
    const root = mkdtempSync(join(tmpdir(), `ebo-run-bundle-${scenario.name}-`));
    try {
      const bundleRoot = join(root, "bundle");
      const assembler = await createRunBundleAssembler(definition(bundleRoot, scenario.name));
      await retainSemanticEvidence(assembler, bundleRoot, scenario.name);
      if (scenario.telemetry) await retainUsage(assembler);

      let workspace: CapturedWorkspacePatch | undefined;
      if (scenario.verifier !== undefined) {
        const fixture = createWorkspaceFixture(root);
        workspace = await assembler.captureWorkspacePatch({
          startPath: fixture.start,
          finalPath: fixture.final,
        });
        await retainVerifier(assembler, scenario.name, scenario.verifier, workspace);
      }

      const manifest = await assembler.finalize({
        terminal: scenario.terminal,
        ...(scenario.missingEvidence === undefined ? {} : { missingEvidence: scenario.missingEvidence }),
      });
      assert.deepEqual(assertBundleValid(bundleRoot), manifest);
      const reportDescriptor = manifest.evidence.find((descriptor) => descriptor.kind === "capture-report")!;
      const report = JSON.parse(readFileSync(join(bundleRoot, reportDescriptor.relativePath), "utf8")) as {
        qualification: string;
        capabilities: { timingResource: { status: string } };
      };
      assert.equal(report.qualification, scenario.qualification);
      assert.equal(report.capabilities.timingResource.status, scenario.timingStatus);
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
        assert.equal(document.telemetry.receipt.status, "received");
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

test("a failure after every evidence stage retains a valid partial bundle", async () => {
  for (let completedStages = 0; completedStages <= 5; completedStages += 1) {
    const root = mkdtempSync(join(tmpdir(), `ebo-run-bundle-stage-${completedStages}-`));
    try {
      const bundleRoot = join(root, "bundle");
      const assembler = await createRunBundleAssembler(definition(bundleRoot, `stage-${completedStages}`));
      const fixture = createWorkspaceFixture(root);
      let workspace: CapturedWorkspacePatch | undefined;
      const stages = [
        async () => retainSession(assembler, bundleRoot, `stage-${completedStages}`),
        async () => retainHooks(assembler, bundleRoot, `stage-${completedStages}`),
        async () => retainUsage(assembler),
        async () => { workspace = await assembler.captureWorkspacePatch({ startPath: fixture.start, finalPath: fixture.final }); },
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
    const captured = await assembler.captureWorkspacePatch({ startPath: fixture.start, finalPath: fixture.final });
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

function definition(bundleRoot: string, suffix: string): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-${suffix}`,
    run: {
      id: `run-${suffix}`,
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

async function retainUsage(assembler: RunBundleAssembler): Promise<void> {
  await assembler.writeAgentSdkTelemetry({
    evidence: {
      telemetry: {
        receipt: { status: "received", signals: ["traces", "metrics", "logs"] },
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
  workspace: CapturedWorkspacePatch,
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
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  writeFileSync(join(final, "changed.txt"), "after\n");
  rmSync(join(final, "deleted.txt"));
  writeFileSync(join(final, binary ? "added.bin" : "added.txt"), binary ? Buffer.from([0, 1, 2, 0xff]) : "added\n");
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
