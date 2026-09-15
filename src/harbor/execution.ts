import { join, resolve } from "node:path";

import type { AssessmentMode, Digest } from "../contracts.js";
import { createHarborAdapter, type HarborAdapter } from "./adapter.js";
import { resolveHarborTask, type HarborTaskResolution } from "./tasks.js";
import { harborStudyPaths, statusHarborTask } from "./study.js";
import type { HarborExecutionProfile, RunQueueV2 } from "./queue.js";

/** Prepared per-step instruction surface delivered to one native harness loop. */
export type PreparedHarborStep = {
  index: number;
  name: string | null;
  effectiveInstruction: string;
  instructionDigest: Digest;
  minReward: number | Record<string, number> | null;
  verifierTimeoutSec: number;
};

export type PreparedHarborExecution = {
  run: { id: string; taskId: string; modelId: string; harnessId: string; trialIndex?: number; attemptId?: string };
  task: {
    taskSourceId: string;
    harborDigest: string;
    assessmentMode: AssessmentMode;
    snapshotDirectory: string;
    resolutionDigest: Digest;
  };
  steps: PreparedHarborStep[];
  environment: {
    profile: HarborExecutionProfile;
    provider: string;
    containerized: boolean;
    enforcement: "microvm" | "docker" | "none";
    dockerImage: string | null;
    networkMode: string;
  };
  verifier: {
    requested: boolean;
    environmentMode: string | null;
    timeoutSec: number;
    /** Aggregate policy declared by the task; execution derives per-step rewards through Harbor. */
    multiStepRewardStrategy: "mean" | "final";
  };
  budget: { coordinatorWallClockMs: number };
  evidence: {
    attemptRoot: string;
    harborDir: string;
    stepsDir: string;
    workspaceDir: string;
    eboDir: string;
  };
};

export class HarborPreflightError extends Error {
  public readonly reasonCode: string;
  public constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "HarborPreflightError";
    this.reasonCode = reasonCode;
  }
}

export type PrepareHarborExecutionOptions = {
  studyRoot: string;
  entry: RunQueueV2["entries"][number];
  attemptRoot: string;
  execution: { environmentProfile: HarborExecutionProfile; contextPolicy: string };
  coordinatorWallClockMs?: number;
  adapter?: HarborAdapter;
  signal?: AbortSignal;
};

/**
 * The shared prepared-task/execution boundary (MIGRATION_SPEC.md §8.1). The
 * admitted Harbor task is resolved once into immutable step instructions and
 * an environment/verifier plan that every native harness adapter consumes.
 * All capability gates fire here, before any candidate code runs.
 */
export async function prepareHarborExecution(options: PrepareHarborExecutionOptions): Promise<PreparedHarborExecution> {
  const adapter = options.adapter ?? await createHarborAdapter();
  const { entry } = options;
  if (entry.task.kind !== "harbor-task") {
    throw new HarborPreflightError("legacy-task-entry", "Legacy task-packet entries must use the existing v1 runner path.");
  }
  if (options.signal?.aborted) throw new HarborPreflightError("aborted", "Execution was aborted before preparation.");
  if (options.execution.contextPolicy === "resume-requested") {
    // A14: native conversation resume is capability-gated. No adapter in the
    // pinned set exposes a validated resume-through-Harbor public API, so the
    // request fails here, before any candidate call.
    throw new HarborPreflightError(
      "unsupported-resume",
      "Native conversation resumption across Harbor steps is unsupported by every current adapter; rejecting before candidate execution.",
    );
  }
  if (options.execution.contextPolicy === "imported-trajectory") {
    throw new HarborPreflightError("unsupported-imported-trajectory", "Imported source trajectories are outside the initial execution profile.");
  }

  const paths = harborStudyPaths(options.studyRoot);
  const status = await statusHarborTask(options.studyRoot, entry.task.taskSourceId, { adapter });
  if (status.status !== "frozen") {
    throw new HarborPreflightError("task-not-frozen", `Harbor task "${entry.task.taskSourceId}" is ${status.status}; runs require the frozen state.`);
  }

  const resolution = await resolveHarborTask(join(paths.snapshotsRoot, entry.task.taskSourceId), {
    assessmentMode: entry.task.assessmentMode,
    adapter,
  });
  if (resolution.resolutionDigest.value !== entry.task.resolutionDigest.value) {
    throw new HarborPreflightError("task-changed", "Resolved task semantics changed from the frozen queue reference.");
  }
  if (resolution.harborDigest !== entry.task.harborDigest) {
    throw new HarborPreflightError("task-changed", "Harbor task digest changed from the frozen queue reference.");
  }
  return finishPreparation(adapter, options, { profile: options.execution.environmentProfile, contextPolicy: "fresh" }, resolution);
}

async function finishPreparation(
  adapter: HarborAdapter,
  options: PrepareHarborExecutionOptions,
  execution: { profile: HarborExecutionProfile; contextPolicy: "fresh" },
  resolution: HarborTaskResolution,
): Promise<PreparedHarborExecution> {
  const entry = options.entry;
  if (execution.profile === "docker") {
    // A19/A22: the Docker-backed profile fails preflight with a typed reason
    // when the daemon is unavailable; it never silently falls back.
    const preflight = await adapter.dockerPreflight();
    if (!preflight.available) {
      throw new HarborPreflightError(
        "environment-prerequisite-missing",
        `The Docker-backed Harbor execution profile requires a working Docker daemon (${preflight.reason ?? "unknown reason"}). Install or start Docker, or declare the explicitly non-containerized "local-fs-test" profile for deterministic integration coverage.`,
      );
    }
  }

  const harborTask = entry.task.kind === "harbor-task"
    ? entry.task
    : (() => { throw new HarborPreflightError("legacy-task-entry", "Legacy task-packet entries must use the existing v1 runner path."); })();
  const attemptRoot = resolve(options.attemptRoot);
  const prepared: PreparedHarborExecution = {
    run: { id: entry.runId, taskId: entry.taskId, modelId: entry.modelId, harnessId: entry.harnessId, trialIndex: entry.trial.index },
    task: {
      taskSourceId: harborTask.taskSourceId,
      harborDigest: harborTask.harborDigest,
      assessmentMode: harborTask.assessmentMode,
      snapshotDirectory: join(harborStudyPaths(options.studyRoot).snapshotsRoot, harborTask.taskSourceId),
      resolutionDigest: resolution.resolutionDigest,
    },
    steps: resolution.instructions.map((instruction, index) => {
      const step = resolution.steps[index];
      return {
        index: index + 1,
        name: instruction.step,
        effectiveInstruction: instruction.instruction,
        instructionDigest: instruction.digest,
        minReward: step?.minReward ?? null,
        verifierTimeoutSec: step?.verifierTimeoutSec ?? resolution.verifier.timeoutSec,
      };
    }),
    environment: {
      profile: execution.profile,
      provider: execution.profile === "smol" ? "smol.harbor:SmolEnvironment" : execution.profile === "docker" ? "harbor-docker" : "ebo-local-fs-test",
      containerized: execution.profile === "docker",
      enforcement: execution.profile === "smol" ? "microvm" : execution.profile === "docker" ? "docker" : "none",
      dockerImage: resolution.environment.dockerImage,
      networkMode: resolution.environment.networkMode,
    },
    verifier: {
      requested: harborTask.assessmentMode === "verified",
      environmentMode: resolution.verifier.environmentMode,
      timeoutSec: resolution.verifier.timeoutSec,
      multiStepRewardStrategy: resolution.multiStepRewardStrategy ?? "mean",
    },
    budget: { coordinatorWallClockMs: options.coordinatorWallClockMs ?? Number.MAX_SAFE_INTEGER },
    evidence: {
      attemptRoot,
      harborDir: join(attemptRoot, "harbor"),
      stepsDir: join(attemptRoot, "steps"),
      workspaceDir: join(attemptRoot, "workspace"),
      eboDir: join(attemptRoot, "ebo"),
    },
  };
  return prepared;
}
