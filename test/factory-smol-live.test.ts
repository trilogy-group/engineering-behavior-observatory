import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createHarborAdapter, prepareHarborAdmission, preAdmissionDigestOf, admitHarborTask, freezeHarborTask,
  compileHarborRunQueue, runHarborBackedQueueEntry, digestBytes, createRetainedBehaviorEvidence,
  createPortableRunBundleExport, readPortableRunBundleExport, FACTORY_CONTRACT_DIGEST } from "../src/index.js";

test("live Factory Harbor Smol trial retains a verified tool task and sanitized export", {
  skip: process.env.EBO_LIVE_FACTORY_SMOL !== "1", timeout: 900_000,
}, async t => {
  const byok = process.env.EBO_LIVE_FACTORY_ROUTE === "byok";
  const credential = byok ? "FIREWORKS_API_KEY" : "FACTORY_API_KEY";
  for (const name of [credential, "EBO_HARBOR_RUNTIME", "EBO_SMOL_IMAGE", "EBO_SMOL_LIBKRUN_SHA256", "EBO_LIVE_FACTORY_MODEL"]) assert.ok(process.env[name], `${name} required`);
  const root = mkdtempSync(join(tmpdir(), "ebo-factory-smol-")), study = join(root, "study"), task = join(root, "task");
  t.diagnostic(`Retained live evidence: ${root}`);
  const put = (path: string, value: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  const ref = (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)), locator = `config/${name}.json`;
    put(join(study, locator), bytes); return { locator, digest: digestBytes(bytes) };
  };
  put(join(task, "task.toml"), `schema_version = "1.4"
multi_step_reward_strategy = "final"
artifacts = ["/workspace"]
[environment]
os = "linux"
workdir = "/workspace"
cpus = 2
memory_mb = 4096
[verifier]
environment_mode = "separate"
[[steps]]
name = "proof"
`);
  put(join(task, "environment/Dockerfile"), "FROM node:24.19.0-bookworm-slim\nRUN mkdir /workspace\nWORKDIR /workspace\n");
  put(join(task, "instruction.md"), "Synthetic capture qualification. Use a native file or shell tool to create /workspace/capture-proof.txt containing exactly EBO_FACTORY_OK, then reply DONE. Do nothing else.");
  put(join(task, "steps/proof/instruction.md"), "Create /workspace/capture-proof.txt containing exactly EBO_FACTORY_OK using a native tool, then reply DONE.");
  put(join(task, "steps/proof/tests/Dockerfile"), "FROM node:24.19.0-bookworm-slim\nCOPY . /tests\n");
  put(join(task, "steps/proof/tests/test.sh"), "#!/bin/sh\nset -eu\ntest \"$(cat /workspace/capture-proof.txt)\" = EBO_FACTORY_OK\nprintf 1 > /logs/verifier/reward.txt\n");
  const adapter = await createHarborAdapter(), proposal = await prepareHarborAdmission(study, task, { adapter, assessmentMode: "verified" });
  const id = proposal.record.taskSourceId;
  put(join(study, "governance/reviews/harbor", `${id}.json`), JSON.stringify({ schemaVersion: "ebo.harbor-review/v1", taskSourceId: id,
    preAdmissionDigest: preAdmissionDigestOf(proposal.record), decision: "admitted", reviewedAt: new Date().toISOString(), reviewedBy: "live-capture-qualification" }));
  await admitHarborTask(study, id, { adapter }); await freezeHarborTask(study, id, { adapter });
  const archive = { locator: "config/worker.tgz", digest: digestBytes(readFileSync(process.env.EBO_HARBOR_RUNTIME!)) };
  mkdirSync(join(study, "config"), { recursive: true }); copyFileSync(process.env.EBO_HARBOR_RUNTIME!, join(study, archive.locator));
  const workerRef = ref("worker", { schemaVersion: "ebo.harbor-worker-runtime/v1", archive, node: "node", entrypoint: "dist/src/harbor/worker.js", environmentKeys: [credential] });
  const build = JSON.parse(readFileSync(join(dirname(process.env.EBO_HARBOR_RUNTIME!), "image-build.json"), "utf8"));
  const binding = { image: process.env.EBO_SMOL_IMAGE!, recipeDigest: build.recipeDigest, baseImageDigest: build.baseImageDigest };
  const environmentRef = ref("environments", { schemaVersion: "ebo.smol-environments/v1", platform: "linux/arm64", runtimeArchiveDigest: archive.digest.value,
    libkrunSha256: process.env.EBO_SMOL_LIBKRUN_SHA256, tasks: { [id]: { agent: binding, graders: { proof: binding } } } });
  const schemaVersion = "ebo.factory-config/v1";
  const model = { schemaVersion, kind: "model", provider: byok ? "fireworks" : "factory", model: process.env.EBO_LIVE_FACTORY_MODEL!,
    reasoningEffort: process.env.EBO_LIVE_FACTORY_EFFORT ?? "low", credentialEnv: credential,
    ...(byok ? { route: { kind: "byok", provider: "generic-chat-completion-api", baseUrl: "https://api.fireworks.ai/inference/v1", maxOutputTokens: 4096 } } : {}) };
  const queue = await compileHarborRunQueue({ schemaVersion: "ebo.experiment/v2", id: "factory-live-smol",
    taskSet: { task: { kind: "harbor-task", taskSourceId: id } }, modelSet: { model: { configurationRef: ref("model", model) } },
    harnessSet: { "factory-droid": { configurationRef: ref("harness", { schemaVersion, kind: "harness", adapter: "factory-droid",
      executable: "/opt/ebo/factory-cli/node_modules/.bin/droid", version: "0.238.0", sdkVersion: "0.9.1", contractDigest: FACTORY_CONTRACT_DIGEST }),
      nativeLimitsRef: ref("limits", { schemaVersion, kind: "native-limits", shutdownGraceMs: 2000 }),
      nativeToolPolicyRef: ref("tools", { schemaVersion, kind: "native-tool-policy", autonomyLevel: "off", permissionDecision: "proceed_once" }) } },
    captureProfile: ref("capture", { schemaVersion, kind: "capture-profile" }), trialCount: 1,
    coordinatorBudget: { maxWallClockMs: 180_000 }, ordering: { strategy: "sequential", seed: "factory-live" },
    execution: { environmentProfile: "smol", contextPolicy: "fresh", workerRef, environmentRef },
  }, { studyRoot: study, adapter });
  const queuePath = join(root, "queue.json"); put(queuePath, JSON.stringify(queue));
  const owner = spawn(process.execPath, [resolve("dist/src/cli.js"), "harbor", "environment", "serve", study, queuePath], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>(done => owner.once("close", done));
  // Diagnostics remain in the restricted evidence directory, never printed with credentials.
  owner.stderr.on("data", chunk => { appendFileSync(join(root, "owner-stderr.log"), chunk, { mode: 0o600 }); });
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("Smol preparation readiness timeout; inspect retained owner diagnostics.")), 600_000);
      let output = ""; owner.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes('"state": "ready"')) { clearTimeout(timer); done(); } });
      owner.once("close", () => { clearTimeout(timer); fail(new Error("Smol owner exited before readiness.")); });
      owner.once("error", error => { clearTimeout(timer); fail(error); });
    });
    const summary = await runHarborBackedQueueEntry({ studyRoot: study, queuePath, runId: queue.entries[0]!.runId, outputRoot: join(root, "attempts"), adapter });
    assert.equal(summary.terminal.state, "completed");
    assert.equal(summary.completedSteps, 1);
    assert.deepEqual(summary.verifierAggregate, { reward: 1 });
    const bundle = join(summary.bundlePath, "steps/1/bundle");
    assert.ok((await createRetainedBehaviorEvidence(bundle)).dataset.events.some(e => e.family === "tool"));
    const policy = { sharingClass: "partner" as const, maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 65536, sensitiveValues: [process.env[credential]!] };
    await createPortableRunBundleExport({ sourceRoot: bundle, destinationRoot: join(root, "export"), policy });
    await readPortableRunBundleExport(join(root, "export"), policy);
  } finally { owner.kill("SIGTERM"); assert.equal(await exited, 0, "Smol owner cleanup failed; inspect retained diagnostics."); }
});
