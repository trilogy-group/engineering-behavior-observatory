import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { digestBytes, createRetainedBehaviorEvidence, PINNED_PI_SDK_VERSION } from "../src/index.js";
import { runHarborWorker, type HarborWorkerInput } from "../src/harbor/worker.js";
import { startProvider } from "./harbor-provider-worker.js";

test("worker uses the real Pi SDK, captures evidence and drains without a Harbor scheduler", async () => {
 const root = mkdtempSync(join(tmpdir(), "ebo-harbor-native-"));
 const workspace = join(root, "workspace"), config = join(root, "config");
 mkdirSync(workspace); mkdirSync(config);
 writeFileSync(join(workspace, "seed.txt"), "seed\n");
 const prompt = "Create a text file for this step.";
 const digest = digestBytes(Buffer.from(prompt));
 const input: HarborWorkerInput = {
  prepared: {
   run: { id: "run-conformance", attemptId: "attempt-conformance", taskId: "task", modelId: "synthetic-model", harnessId: "pi-sdk", trialIndex: 1 },
   task: { taskSourceId: "harbor-conformance", harborDigest: digest.value, assessmentMode: "observational", snapshotDirectory: "/host-only-task", resolutionDigest: digest },
   steps: [{ index: 1, name: null, effectiveInstruction: prompt, instructionDigest: digest, minReward: null, verifierTimeoutSec: 10 }],
   environment: { profile: "local-fs-test", provider: "test", containerized: false, enforcement: "none", dockerImage: null, networkMode: "public" },
   verifier: { requested: false, environmentMode: null, timeoutSec: 10, multiStepRewardStrategy: "mean" }, budget: { coordinatorWallClockMs: 10000 },
   evidence: { attemptRoot: root, harborDir: root, stepsDir: root, workspaceDir: workspace, eboDir: root },
  }, configuration: {} as HarborWorkerInput["configuration"], configurationRoot: config, instruction: prompt, stepIndex: 1, workspacePath: workspace, outputRoot: join(root, "evidence"), maxWallClockMs: 10000,
 };
 const server = startProvider(input);
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 const oldKey = process.env.PI_SYNTHETIC_API_KEY;
 process.env.PI_SYNTHETIC_API_KEY = "synthetic-offline";
 try {
  for (const [key, file] of Object.entries({ model: "model", harness: "harness", nativeLimits: "limits", nativeToolPolicy: "tools", captureProfile: "capture" })) {
   const value = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/pi/configs", file + ".json"), "utf8"));
   if (key === "model") value.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
   if (key === "harness") value.version = PINNED_PI_SDK_VERSION;
   const bytes = Buffer.from(JSON.stringify(value));
   writeFileSync(join(config, file + ".json"), bytes);
   input.configuration[key as keyof typeof input.configuration] = { locator: file + ".json", digest: digestBytes(bytes) };
  }
  const result = await runHarborWorker(input);
  assert.equal(result.terminal.state, "completed", JSON.stringify(result));
  assert.equal(result.qualification, "qualified");
  assert.equal(readFileSync(join(workspace, "step-1.txt"), "utf8"), "done\n");
  const bundle = join(input.outputRoot, "bundle");
  const evidence = await createRetainedBehaviorEvidence(bundle);
  assert.ok(evidence.dataset.events.some(e=>e.family === "tool"));
  assert.ok(readFileSync(join(bundle, "workspace.patch"), "utf8").includes("step-1.txt"));
  await assert.rejects(runHarborWorker({ ...input, instruction: "tampered" }), /different from the frozen/);
  await assert.rejects(runHarborWorker({ ...input, outputRoot: join(workspace, "..hidden/evidence") }), /outside/);
 } finally {
  if (oldKey === undefined) delete process.env.PI_SYNTHETIC_API_KEY; else process.env.PI_SYNTHETIC_API_KEY = oldKey;
  server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
