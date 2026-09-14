import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawn } from "node:child_process";
import { buildCorpusIndex, createHarborAdapter, prepareHarborAdmission, preAdmissionDigestOf, admitHarborTask, freezeHarborTask, compileHarborRunQueue, runHarborBackedQueueEntry, digestBytes, createRetainedBehaviorEvidence, createPortableRunBundleExport, readPortableRunBundleExport } from "../src/index.js";

const runtimeArchive = process.env.EBO_HARBOR_RUNTIME;
const image = process.env.EBO_SMOL_IMAGE;
test("official Harbor Smol Trial runs native Pi capture, fresh steps and verifier policy", { skip: !runtimeArchive || !image, timeout: 900_000 }, async t => {
  const adapter = await createHarborAdapter();
  for (const mode of ["observational", "verified", "threshold", "missing", "setup-failure"] as const) {
    await t.test(mode, async sub => {
      const root = mkdtempSync(join(tmpdir(), "ebo-harbor-smol-"));
      t.diagnostic("Retained conformance evidence: " + root);
      const study = join(root, "study"), task = join(root, "task");
      const put = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
      const ref = (name: string, value: unknown) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        const locator = "config/" + name;
        put(join(study, locator), bytes); return { locator, digest: digestBytes(bytes) };
      };
      put(join(task, "task.toml"), `schema_version = "1.4"
multi_step_reward_strategy = "final"
artifacts = ["/workspace"]
[environment]
os = "linux"
workdir = "/workspace"
cpus = 1
memory_mb = 1024
[verifier]
environment_mode = "separate"
[[steps]]
name = "one"
${mode === "threshold" || mode === "missing" ? "min_reward = 0.5" : ""}
[[steps]]
name = "two"
`);
      put(join(task, "environment/Dockerfile"), "FROM node:24.19.0-bookworm-slim\nRUN mkdir /workspace\nWORKDIR /workspace\n");
      put(join(task, "environment/private-fixture.txt"), "Only uploaded locally, never part of the runtime image.\n");
      put(join(task, "environment/setup.sh"), "#!/bin/sh\nset -eu\ncp private-fixture.txt /workspace/private-fixture.txt\n");
      put(join(task, "instruction.md"), "Work in the existing workspace.");
      for (const name of ["one", "two"]) {
        put(join(task, `steps/${name}/instruction.md`), "Create a text file for this step.");
        if (mode !== "observational") put(join(task, `steps/${name}/tests/Dockerfile`), "FROM node:24.19.0-bookworm-slim\nCOPY . /tests\n");
        if (mode !== "observational") put(join(task, `steps/${name}/tests/test.sh`), "#!/bin/sh\nset -eu\n" + (mode === "missing" ? "exit 0\n" : `test -f /workspace/step-${name === "one" ? "1" : "2"}.txt\nprintf '${mode === "threshold" ? "0" : "1"}' > /logs/verifier/reward.txt\n`));
      }
      if (mode === "setup-failure") put(join(task, "steps/one/workdir/setup.sh"), "#!/bin/sh\nexit 7\n");
      const assessmentMode = mode === "observational" ? "observational" : "verified";
      const proposal = await prepareHarborAdmission(study, task, { adapter, assessmentMode });
      const id = proposal.record.taskSourceId;
      put(join(study, "governance/reviews/harbor", id + ".json"), JSON.stringify({ schemaVersion: "ebo.harbor-review/v1", taskSourceId: id, preAdmissionDigest: preAdmissionDigestOf(proposal.record), decision: "admitted", reviewedAt: "2026-09-13T00:00:00.000Z", reviewedBy: "deterministic-test" }));
      await admitHarborTask(study, id, { adapter }); await freezeHarborTask(study, id, { adapter });
      const configs = Object.fromEntries(["model", "harness", "limits", "tools", "capture"].map(name => [name, JSON.parse(readFileSync(resolve("test/fixtures/pi/configs", name + ".json"), "utf8"))]));
      configs.model.baseUrl = "http://127.0.0.1:18881/v1";
      const archive = { locator: "config/worker.tgz", digest: digestBytes(readFileSync(runtimeArchive!)) };
      mkdirSync(join(study, "config"), { recursive: true });
      copyFileSync(runtimeArchive!, join(study, archive.locator), constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      const workerRef = ref("worker.json", { schemaVersion: "ebo.harbor-worker-runtime/v1", archive, node: "node", entrypoint: "dist/test/harbor-provider-worker.js", environmentKeys: [] });
      const build = JSON.parse(readFileSync(join(dirname(runtimeArchive!), "image-build.json"), "utf8"));
      const binding = { image, recipeDigest: build.recipeDigest, baseImageDigest: build.baseImageDigest };
      const environmentRef = ref("environments.json", { schemaVersion: "ebo.smol-environments/v1", platform: "linux/arm64",
        runtimeArchiveDigest: archive.digest.value, libkrunSha256: process.env.EBO_SMOL_LIBKRUN_SHA256,
        tasks: { [id]: { agent: { ...binding, localSetup: 'setup.sh' }, graders: { one: binding, two: binding } } } });
      const queue = await compileHarborRunQueue({ schemaVersion: "ebo.experiment/v2", id: "smol-conformance", taskSet: { task: { kind: "harbor-task", taskSourceId: id } },
        modelSet: { "synthetic-model": { configurationRef: ref("model.json", configs.model) } },
        harnessSet: { "pi-sdk": { configurationRef: ref("harness.json", configs.harness), nativeLimitsRef: ref("limits.json", configs.limits), nativeToolPolicyRef: ref("tools.json", configs.tools) } },
        captureProfile: ref("capture.json", configs.capture), trialCount: mode === "observational" ? 2 : 1, coordinatorBudget: { maxWallClockMs: 120_000 }, ordering: { strategy: "sequential", seed: "conformance" }, execution: { environmentProfile: "smol", contextPolicy: "fresh", workerRef, environmentRef },
      }, { studyRoot: study, adapter });
      const queuePath = join(root, "queue.json"); put(queuePath, JSON.stringify(queue));
      const owner = spawn(process.execPath, [resolve('dist/src/cli.js'), 'harbor', 'environment', 'serve', study, queuePath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise<number | null>(done => owner.once('close', done));
      let diagnostics = '';
      owner.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
      sub.after(async () => { owner.kill('SIGTERM'); assert.equal(await exited, 0, diagnostics); });
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('Preparation readiness timeout: ' + diagnostics)), 180_000);
        let output = '';
        owner.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('"state": "ready"')) { clearTimeout(timer); done(); } });
        owner.once('close', code => { clearTimeout(timer); fail(new Error('Owner exited ' + code + ': ' + output + diagnostics)); });
      });
      const summary = await runHarborBackedQueueEntry({ studyRoot: study, queuePath, runId: queue.entries[0]!.runId, outputRoot: join(root, "attempts"), adapter });
      if (mode === "observational") {
        const second = await runHarborBackedQueueEntry({ studyRoot: study, queuePath, runId: queue.entries[1]!.runId, outputRoot: join(root, "attempts"), adapter });
        assert.equal(second.terminal.state, 'completed');
        const events = (path: string) => readFileSync(join(path, 'harbor/smol-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const firstBranch = events(summary.bundlePath).find(e => e.state === 'branch-ready');
        const secondBranch = events(second.bundlePath).find(e => e.state === 'branch-ready');
        assert.equal(firstBranch.parent, secondBranch.parent);
        assert.notEqual(firstBranch.child, secondBranch.child);
      }
      t.diagnostic(JSON.stringify(summary));
      const harbor = JSON.parse(readFileSync(join(summary.bundlePath, "harbor/result.json"), "utf8"));
      t.diagnostic(JSON.stringify(harbor));
      if (mode === "setup-failure") { assert.equal(summary.completedSteps, 0); assert.equal(summary.terminal.state, "failed"); return; }
      assert.equal(summary.completedSteps, mode === "threshold" || mode === "missing" ? 1 : 2);
      assert.equal(harbor.step_results[0].agent_result.metadata.ebo_step, 1);
      if (mode === "observational") assert.equal(summary.verifierAggregate, null);
      if (mode === "verified") assert.deepEqual(summary.verifierAggregate, { reward: 1 });
      if (mode === "threshold") assert.deepEqual(summary.verifierAggregate, { reward: 0 });
      if (mode === "missing") assert.equal(summary.verifierAggregate, null);
      const first = join(summary.bundlePath, "steps/1/bundle");
      const manifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8"));
      assert.ok(manifest.evidence.some((e: {id:string}) => e.id === "harbor-result"));
      assert.ok(readdirSync(first).includes("pi-session.jsonl"));
      const evidence = await createRetainedBehaviorEvidence(first);
      assert.ok(evidence.dataset.events.some(event => event.family === "tool"));
      if (summary.completedSteps === 2) {
        const second = JSON.parse(readFileSync(join(summary.bundlePath, "steps/2/bundle/manifest.json"), "utf8"));
        assert.notEqual(manifest.run.native.sessionId, second.run.native.sessionId);
      }
      const policy = { sharingClass: "partner" as const, maxArtifactBytes: 16 * 1024 * 1024, maxStringBytes: 64 * 1024, sensitiveValues: [] };
      const exported = join(root, "portable");
      await createPortableRunBundleExport({ sourceRoot: first, destinationRoot: exported, policy });
      await readPortableRunBundleExport(exported, policy);
      for (const directory of [first, exported]) {
        const entry = buildCorpusIndex(directory)[0]!;
        assert.equal(entry.assessmentMode, assessmentMode);
        assert.equal(entry.captureAssessmentMode, "observational");
        assert.deepEqual(entry.issues, []);
      }
    });
  }
});
