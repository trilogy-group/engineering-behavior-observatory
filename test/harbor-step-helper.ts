import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestBytes } from "../src/artifacts.js";
import type { HarborStepExecutorInput } from "../src/harbor/runner.js";

export function harborStepFixture(root: string, harnessId: string): HarborStepExecutorInput {
  const workspacePath = join(root, "harbor-workspace"), startingWorkspacePath = join(root, "harbor-baseline");
  for (const directory of [workspacePath, startingWorkspacePath]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "result.txt"), "before\n");
  }
  const instruction = "Update result.txt and stop.", digest = digestBytes(Buffer.from(instruction));
  const step = { index: 1, name: null, effectiveInstruction: instruction, instructionDigest: digest, minReward: null, verifierTimeoutSec: 0 };
  return {
    prepared: {
      run: { id: "harbor-run", attemptId: "harbor-attempt", taskId: "task", modelId: "condition", harnessId },
      task: { taskSourceId: "task", harborDigest: digest.value, assessmentMode: "observational", snapshotDirectory: "", resolutionDigest: digest },
      steps: [step], environment: { profile: "local-fs-test", provider: "fixture", containerized: false, enforcement: "none", dockerImage: null, networkMode: "public" },
      verifier: { requested: false, environmentMode: null, timeoutSec: 0, multiStepRewardStrategy: "mean" }, budget: { coordinatorWallClockMs: 10000 },
      evidence: { attemptRoot: root, harborDir: root, stepsDir: root, workspaceDir: root, eboDir: root },
    }, step, workspacePath, startingWorkspacePath, stepBundleRoot: join(root, "harbor-bundle"), maxWallClockMs: 10000,
  };
}
