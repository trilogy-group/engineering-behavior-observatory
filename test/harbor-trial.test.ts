import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { digestBytes } from "../src/artifacts.js";
import { invokeTrial, runOfficialHarborTrial } from "../src/harbor/official-trial.js";
import type { HarborAdapter } from "../src/harbor/adapter.js";
import type { HarborStepExecution } from "../src/harbor/runner.js";

test("Harbor child output is bounded on disk, including multibyte stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-harbor-output-"));
  const script = join(root, "emit.cjs");
  await writeFile(script, `require('node:fs').writeSync(2, 'é'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000);`);
  const result = await invokeTrial(process.execPath, script, "unused", undefined, 5000);
  assert.equal(result.interrupted, true);
  assert.equal((await stat(join(root, "stderr.log"))).size, 4 * 1024 * 1024);
  assert.equal(Buffer.byteLength(result.stderr), 4 * 1024 * 1024);
});

test("Harbor child stdout retains split UTF-8 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-harbor-utf8-"));
  const script = join(root, "emit.cjs");
  await writeFile(script, `process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 30);`);
  const result = await invokeTrial(process.execPath, script, "unused", undefined, 5000);
  assert.equal(result.stdout, "é");
  assert.equal(result.interrupted, false);
});

async function trialFixture() {
  const root = await mkdtemp(join(tmpdir(), "ebo-harbor-trial-"));
  const attempt = join(root, "attempt");
  const ref = async (locator: string, content: string) => {
    await writeFile(join(root, locator), content);
    return { locator, digest: digestBytes(Buffer.from(content)) };
  };
  const archive = await ref("worker.tgz", "test archive; not executed");
  const workerRef = await ref("worker.json", JSON.stringify({ schemaVersion: "ebo.harbor-worker-runtime/v1", archive, node: "node", entrypoint: "worker.js", environmentKeys: [] }));
  const environmentRef = await ref("environment.json", JSON.stringify({ schemaVersion: "ebo.smol-environments/v1", platform: "linux/arm64", runtimeArchiveDigest: archive.digest.value }));
  const config = await ref("config.json", "{}");
  const digest = config.digest;
  const task = { taskSourceId: "task", harborDigest: digest.value, assessmentMode: "observational" as const, snapshotDirectory: root, resolutionDigest: digest };
  const prepared = {
    run: { id: "run", taskId: "task", modelId: "model", harnessId: "pi-sdk" }, task,
    steps: [{ index: 1, name: null, effectiveInstruction: "Do work", instructionDigest: digest, minReward: null, verifierTimeoutSec: 10 }],
    environment: { profile: "smol" as const, provider: "smol", containerized: false, enforcement: "microvm" as const, dockerImage: null, networkMode: "public" },
    verifier: { requested: false, environmentMode: null, timeoutSec: 10, multiStepRewardStrategy: "mean" as const },
    budget: { coordinatorWallClockMs: 5000 },
    evidence: { attemptRoot: attempt, harborDir: join(attempt, "harbor"), stepsDir: join(attempt, "steps"), workspaceDir: join(attempt, "workspace"), eboDir: join(attempt, "ebo") },
  };
  const entry = {
    runId: "run", taskId: "task", modelId: "model", harnessId: "pi-sdk", trialIndex: 1,
    task: { ...task, kind: "harbor-task" as const, id: "task", snapshotLocator: "task", admissionLocator: "admission", admissionDigest: digest, freezeLocator: "freeze", freezeDigest: digest },
    model: { id: "model", configurationRef: config }, harness: { id: "pi-sdk", configurationRef: config, nativeLimitsRef: config, nativeToolPolicyRef: config },
    configuration: { model: config, harness: config, nativeLimits: config, nativeToolPolicy: config }, trial: { index: 1 },
  };
  const queue = {
    schemaVersion: "ebo.run-queue/v2" as const, experimentId: "experiment", experimentDigest: digest, schedulingDigest: digest,
    matrix: { taskIds: ["task"], modelIds: ["model"], harnessIds: ["pi-sdk"], trialCount: 1 }, seed: "test",
    captureProfile: config, coordinatorBudget: { maxWallClockMs: 5000 },
    ordering: { strategy: "sequential" as const, seed: "test" }, execution: { environmentProfile: "smol" as const, contextPolicy: "fresh" as const, workerRef, environmentRef }, entries: [entry],
  };
  return { root, attempt, prepared, entry, queue, studyRoot: root, attemptId: "attempt" };
}

test("Harbor staging failure retains an explicit unqualified attempt", async () => {
  const input = await trialFixture();
  input.entry.configuration.model = { ...input.entry.configuration.model, locator: "missing.json" };
  const adapter = { describePrerequisites: async () => { throw new Error("must not launch"); } } as unknown as HarborAdapter;
  const result = await runOfficialHarborTrial({ ...input, adapter });
  assert.equal(result.terminal.state, "failed");
  assert.equal(result.captureQualification, "unqualified");
  const saved = JSON.parse(await readFile(join(input.prepared.evidence.eboDir, "manifest.json"), "utf8"));
  assert.equal(saved.attemptId, "attempt");
  assert.match(saved.error, /missing.json/);
  await assert.rejects(stat(join(input.attempt, "harbor/worker-runtime.tgz")), { code: "ENOENT" });
});

test("Harbor wrapper preserves native terminal and classification through its error envelope", async t => {
  for (const [terminal, classification] of [
    [{ state: "stopped", failureClass: "none", stopReason: "budget" }, "budget-stop"],
    [{ state: "interrupted", failureClass: "none", stopReason: "external" }, "interrupted"],
    [{ state: "failed", failureClass: "task", stopReason: "none" }, "task-failure"],
  ] as const) await t.test(classification, async () => {
    const input = await trialFixture();
    const native: HarborStepExecution = { terminal, classification, qualification: "qualified", bundleLocator: "bundle/manifest.json" };
    const executable = join(input.root, "trial.cjs");
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ agent_result: {}, exception_info: 'native terminal' }));\n`, { mode: 0o700 });
    const adapter = { describePrerequisites: async () => {
      const bundle = join(input.attempt, "steps/1/bundle");
      await mkdir(bundle, { recursive: true });
      await writeFile(join(bundle, "manifest.json"), JSON.stringify({ bundleId: "bundle", run: { id: "run", assessmentMode: "observational" }, attempt: { id: "attempt" }, evidence: [] }));
      await writeFile(join(input.attempt, "steps/1/worker-finished.json"), JSON.stringify(native));
      await mkdir(join(input.attempt, "harbor/trials/attempt"), { recursive: true });
      await writeFile(join(input.attempt, "harbor/trials/attempt/lock.json"), "{}");
      return { python: executable, version: null, docker: null };
    } } as unknown as HarborAdapter;
    const result = await runOfficialHarborTrial({ ...input, adapter });
    assert.deepEqual(result.terminal, terminal);
    assert.equal(result.classification, classification);
    const joined = JSON.parse(await readFile(join(input.attempt, "steps/1/bundle/manifest.json"), "utf8"));
    assert.equal(joined.evidence[0].id, "harbor-result");
    assert.equal((await stat(join(input.attempt, "steps/1/bundle/manifest.json"))).mode & 0o777, 0o600);
  });
});
