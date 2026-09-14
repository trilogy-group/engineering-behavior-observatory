import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact, type ArtifactValidationError } from "../artifacts.js";
import {
  assertDeclaredOrder,
  declaredMatrixCells,
  type ArtifactReference,
  type DeclaredMatrixCell,
  type Digest,
  type ExperimentOrdering,
} from "../contracts.js";
import { formatErrors } from "../task-packets.js";
import type { FrozenTaskIdentity } from "../scheduler.js";
import { admissionLocatorOf, freezeLocatorOf, readHarborStudyJson, statusHarborTask } from "./study.js";
import type { AssessmentMode } from "../contracts.js";
import type { HarborAdapter } from "./adapter.js";

export const HARBOR_EXPERIMENT_SCHEMA_VERSION = "ebo.experiment/v2";
export const HARBOR_RUN_QUEUE_SCHEMA_VERSION = "ebo.run-queue/v2";

/** Discriminated task source: a Harbor task or a legacy v1 task packet. */
export type TaskSourceCondition =
  | {
      kind: "harbor-task";
      taskSourceId: string;
      /** Optional pinned content digest; when present it must match the frozen study identity. */
      harborDigest?: string;
      /** Optional assessment-mode pin; when present it must match the admission record. */
      assessmentMode?: AssessmentMode;
      snapshotLocator?: string;
    }
  | {
      kind: "legacy-task-packet";
      packetRef: ArtifactReference;
      freezeLocator?: string;
    };

export type HarborExecutionProfile = "smol" | "docker" | "local-fs-test";

export type ExperimentConfigurationV2 = {
  schemaVersion: typeof HARBOR_EXPERIMENT_SCHEMA_VERSION;
  id: string;
  taskSet: Record<string, TaskSourceCondition>;
  modelSet: Record<string, { configurationRef: ArtifactReference }>;
  harnessSet: Record<string, {
    configurationRef: ArtifactReference;
    nativeLimitsRef: ArtifactReference;
    nativeToolPolicyRef: ArtifactReference;
  }>;
  trialCount: number;
  coordinatorBudget: { maxWallClockMs: number };
  captureProfile: ArtifactReference;
  ordering: ExperimentOrdering;
  execution?: {
    environmentProfile?: HarborExecutionProfile;
    workerRef?: ArtifactReference;
    environmentRef?: ArtifactReference;
    contextPolicy?: "fresh" | "resume-requested" | "imported-trajectory";
  };
};

export type FrozenHarborTaskIdentity = {
  kind: "harbor-task";
  id: string;
  taskSourceId: string;
  harborDigest: string;
  assessmentMode: AssessmentMode;
  snapshotLocator: string;
  admissionLocator: string;
  admissionDigest: Digest;
  freezeLocator: string;
  freezeDigest: Digest;
  resolutionDigest: Digest;
};

export type RunQueueEntryTask = FrozenHarborTaskIdentity | (FrozenTaskIdentity & { kind?: "legacy-task-packet" });

export type RunQueueEntryV2 = DeclaredMatrixCell & {
  runId: string;
  task: RunQueueEntryTask;
  model: {
    id: string;
    configurationRef: ArtifactReference;
  };
  harness: {
    id: string;
    configurationRef: ArtifactReference;
    nativeLimitsRef: ArtifactReference;
    nativeToolPolicyRef: ArtifactReference;
  };
  configuration: {
    model: ArtifactReference;
    harness: ArtifactReference;
    nativeLimits: ArtifactReference;
    nativeToolPolicy: ArtifactReference;
  };
  trial: { index: number };
};

export type RunQueueV2 = {
  schemaVersion: typeof HARBOR_RUN_QUEUE_SCHEMA_VERSION;
  experimentId: string;
  experimentDigest: Digest;
  schedulingDigest: Digest;
  captureProfile: ArtifactReference;
  coordinatorBudget: { maxWallClockMs: number };
  execution: {
    environmentProfile: HarborExecutionProfile;
    workerRef?: ArtifactReference;
    environmentRef?: ArtifactReference;
    contextPolicy: "fresh" | "resume-requested" | "imported-trajectory";
  };
  matrix: {
    taskIds: string[];
    modelIds: string[];
    harnessIds: string[];
    trialCount: number;
  };
  seed: string;
  entries: RunQueueEntryV2[];
};

export type CompileHarborRunQueueOptions = {
  studyRoot?: string;
  /** Frozen legacy identities for `legacy-task-packet` conditions. */
  legacyFrozenTasks?: Record<string, FrozenTaskIdentity>;
  /** Adapter override for tests and offline verification. */
  adapter?: HarborAdapter;
};

export type ReadHarborRunQueueOptions = {
  adapter?: HarborAdapter;
  studyRoot?: string;
  legacyFrozenTasks?: Record<string, FrozenTaskIdentity>;
};

/**
 * Compile a versioned run queue whose task set may mix Harbor tasks and
 * legacy task packets. Harbor tasks resolve through the study governance
 * path: admission must exist and the freeze status must be `frozen`.
 */
export async function compileHarborRunQueue(
  experiment: ExperimentConfigurationV2,
  options: CompileHarborRunQueueOptions = {},
): Promise<RunQueueV2> {
  const errors = validateArtifact("experiment.json", experiment);
  if (errors.length > 0) throw new Error(formatErrors(errors));
  assertV2Semantics(experiment);

  const experimentDigest = digestMetadata(experiment);
  const environmentProfile = experiment.execution?.environmentProfile ?? "smol";
  const contextPolicy = experiment.execution?.contextPolicy ?? "fresh";
  const matrix = {
    taskIds: experiment.ordering.strategy === "declared" ? [...experiment.ordering.declaredOrder.taskIds] : Object.keys(experiment.taskSet).sort(),
    modelIds: experiment.ordering.strategy === "declared" ? [...experiment.ordering.declaredOrder.modelIds] : Object.keys(experiment.modelSet).sort(),
    harnessIds: experiment.ordering.strategy === "declared" ? [...experiment.ordering.declaredOrder.harnessIds] : Object.keys(experiment.harnessSet).sort(),
    trialCount: experiment.trialCount,
  };
  const schedulingDigest = digestMetadata({
    experimentDigest,
    captureProfile: experiment.captureProfile,
    coordinatorBudget: experiment.coordinatorBudget,
    matrix,
    seed: experiment.ordering.seed,
    environmentProfile,
    contextPolicy,
    workerRef: experiment.execution?.workerRef ?? null,
    ...(experiment.execution?.environmentRef ? { environmentRef: experiment.execution.environmentRef } : {}),
  });

  const tasks = new Map<string, RunQueueEntryTask>();
  for (const [taskId, condition] of Object.entries(experiment.taskSet)) {
    tasks.set(taskId, await resolveTaskIdentity(taskId, condition, options));
  }

  const entries: RunQueueEntryV2[] = [...declaredMatrixCells(
    { taskIds: matrix.taskIds, modelIds: matrix.modelIds, harnessIds: matrix.harnessIds },
    experiment.trialCount,
  )].map((cell) => {
    const task = tasks.get(cell.taskId)!;
    const modelCondition = experiment.modelSet[cell.modelId]!;
    const harnessCondition = experiment.harnessSet[cell.harnessId]!;
    const model = { id: cell.modelId, configurationRef: modelCondition.configurationRef };
    const harness = { id: cell.harnessId, ...harnessCondition };
    return {
      ...cell,
      runId: harborRunId(experiment.id, experimentDigest, schedulingDigest, task, model, harness, cell.trialIndex),
      task,
      model,
      harness,
      configuration: {
        model: model.configurationRef,
        harness: harness.configurationRef,
        nativeLimits: harness.nativeLimitsRef,
        nativeToolPolicy: harness.nativeToolPolicyRef,
      },
      trial: { index: cell.trialIndex },
    };
  });

  const queue: RunQueueV2 = {
    schemaVersion: HARBOR_RUN_QUEUE_SCHEMA_VERSION,
    experimentId: experiment.id,
    experimentDigest,
    schedulingDigest,
    captureProfile: experiment.captureProfile,
    coordinatorBudget: experiment.coordinatorBudget,
    execution: { environmentProfile, contextPolicy, ...(experiment.execution?.workerRef ? { workerRef: experiment.execution.workerRef } : {}), ...(experiment.execution?.environmentRef ? { environmentRef: experiment.execution.environmentRef } : {}) },
    matrix,
    seed: experiment.ordering.seed,
    entries,
  };
  const queueErrors = await validateHarborRunQueue(queue, options);
  if (queueErrors.length > 0) throw new Error(formatErrors(queueErrors));
  return queue;
}

export async function validateHarborRunQueue(
  queue: unknown,
  options: ReadHarborRunQueueOptions = {},
  artifact = "run-queue.json",
): Promise<ArtifactValidationError[]> {
  if (typeof queue === "object" && queue !== null && !Array.isArray(queue)
      && (queue as { schemaVersion?: unknown }).schemaVersion !== HARBOR_RUN_QUEUE_SCHEMA_VERSION) {
    return [queueV2Error(artifact, "/schemaVersion", `Expected ${HARBOR_RUN_QUEUE_SCHEMA_VERSION}.`)];
  }
  const errors = validateArtifact(artifact, queue);
  if (errors.length > 0) return errors;
  if (typeof queue !== "object" || queue === null || Array.isArray(queue)) {
    return [queueV2Error(artifact, "/", "Run queue must be an object.")];
  }
  const runQueue = queue as unknown as RunQueueV2;
  const semantic: ArtifactValidationError[] = [];

  if (!sameDigest(runQueue.schedulingDigest, digestMetadata({
    experimentDigest: runQueue.experimentDigest,
    captureProfile: runQueue.captureProfile,
    coordinatorBudget: runQueue.coordinatorBudget,
    matrix: runQueue.matrix,
    seed: runQueue.seed,
    environmentProfile: runQueue.execution.environmentProfile,
    contextPolicy: runQueue.execution.contextPolicy,
    workerRef: runQueue.execution.workerRef ?? null,
    ...(runQueue.execution.environmentRef ? { environmentRef: runQueue.execution.environmentRef } : {}),
  }))) {
    semantic.push(queueV2Error(artifact, "/schedulingDigest", "Scheduling digest does not match the persisted queue policy."));
  }

  const runIds = new Set<string>();
  const cells = new Set<string>();
  const taskCompositions = new Map<string, string>();
  for (const [index, entry] of runQueue.entries.entries()) {
    const field = `/entries/${index}`;
    if (runIds.has(entry.runId)) semantic.push(queueV2Error(artifact, `${field}/runId`, `Duplicate run ID "${entry.runId}".`));
    runIds.add(entry.runId);
    const cellKey = `${entry.taskId}\u0000${entry.modelId}\u0000${entry.harnessId}\u0000${entry.trialIndex}`;
    if (cells.has(cellKey)) semantic.push(queueV2Error(artifact, field, "Duplicate matrix cell."));
    cells.add(cellKey);
    if (entry.task.id !== entry.taskId || entry.model.id !== entry.modelId || entry.harness.id !== entry.harnessId) {
      semantic.push(queueV2Error(artifact, field, "Entry identities do not match their dimension IDs."));
    }
    if (entry.trial.index !== entry.trialIndex) {
      semantic.push(queueV2Error(artifact, `${field}/trial`, "Trial identity does not match trialIndex."));
    }
    if (digestMetadata(entry.configuration).value !== digestMetadata({
      model: entry.model.configurationRef, harness: entry.harness.configurationRef,
      nativeLimits: entry.harness.nativeLimitsRef, nativeToolPolicy: entry.harness.nativeToolPolicyRef,
    }).value) {
      semantic.push(queueV2Error(artifact, `${field}/configuration`, "Execution references differ from the frozen model and harness condition."));
    }
    const composition = entry.task.kind === "harbor-task" ? entry.task.harborDigest : `${entry.task.packetRef.digest.algorithm}:${entry.task.packetRef.digest.value}`;
    const existing = taskCompositions.get(entry.taskId);
    if (existing !== undefined && existing !== composition) {
      semantic.push(queueV2Error(artifact, `${field}/task`, `Task "${entry.taskId}" resolves to multiple content identities.`));
    }
    taskCompositions.set(entry.taskId, composition);
    if (entry.runId !== harborRunId(runQueue.experimentId, runQueue.experimentDigest, runQueue.schedulingDigest, entry.task, entry.model, entry.harness, entry.trialIndex)) {
      semantic.push(queueV2Error(artifact, `${field}/runId`, "Run ID does not match its frozen cell identities."));
    }
    if (entry.task.kind === "harbor-task") {
      if (options.studyRoot === undefined) continue;
      try {
        const expected = await resolveTaskIdentity(entry.taskId, { kind: "harbor-task", taskSourceId: entry.task.taskSourceId }, options);
        if (digestMetadata(expected).value !== digestMetadata(entry.task).value) {
          semantic.push(queueV2Error(artifact, field + "/task", "Frozen admission, assessment mode or resolution differs from its queue reference."));
        }
      } catch (error) {
        semantic.push(queueV2Error(artifact, field + "/task", error instanceof Error ? error.message : String(error)));
      }
    } else {
      const expected = options.legacyFrozenTasks?.[entry.taskId];
      if (expected !== undefined && (expected.packetRef.digest.value !== entry.task.packetRef.digest.value
          || expected.aggregateDigest.value !== entry.task.aggregateDigest.value)) {
        semantic.push(queueV2Error(artifact, `${field}/task`, "Legacy frozen task identity does not match the supplied freeze record."));
      }
    }
  }

  try {
    const expectedCells = [...declaredMatrixCells(runQueue.matrix, runQueue.matrix.trialCount)].map(
      (cell) => `${cell.taskId}\u0000${cell.modelId}\u0000${cell.harnessId}\u0000${cell.trialIndex}`,
    );
    const expectedSet = new Set(expectedCells);
    if (expectedSet.size !== cells.size || [...expectedSet].some((key) => !cells.has(key))) {
      semantic.push(queueV2Error(artifact, "/entries", "Run queue cells do not match its persisted matrix."));
    }
  } catch (error) {
    semantic.push(queueV2Error(artifact, "/matrix", error instanceof Error ? error.message : "Persisted matrix is invalid."));
  }
  return semantic;
}

export async function readHarborRunQueue(path: string, options: ReadHarborRunQueueOptions = {}): Promise<RunQueueV2> {
  const { readBoundedFile } = await import("../scheduler.js");
  const bytes = readBoundedFile(path, "Run queue");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  const queue = JSON.parse(text) as unknown;
  const errors = await validateHarborRunQueue(queue, options, path);
  if (errors.length > 0) throw new Error(formatErrors(errors));
  return queue as RunQueueV2;
}

/** Version-aware queue reader: dispatches on schemaVersion and keeps v1 validation intact. */
export async function readRunQueueVersioned(path: string, options: { bundleRoot?: string; studyRoot?: string; adapter?: HarborAdapter } = {}): Promise<RunQueueV2 | import("../scheduler.js").RunQueue> {
  const { readBoundedFile, readRunQueue } = await import("../scheduler.js");
  const bytes = readBoundedFile(path, "Run queue");
  const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { schemaVersion?: string };
  if (document.schemaVersion === HARBOR_RUN_QUEUE_SCHEMA_VERSION) {
    return readHarborRunQueue(path, options.adapter === undefined
      ? { studyRoot: options.studyRoot }
      : { studyRoot: options.studyRoot, adapter: options.adapter });
  }
  return readRunQueue(path, undefined, options.bundleRoot === undefined ? {} : { bundleRoot: options.bundleRoot });
}

function assertV2Semantics(experiment: ExperimentConfigurationV2): void {
  if (experiment.ordering.strategy !== "sequential" && experiment.ordering.strategy !== "declared") {
    throw new Error("ebo.experiment/v2 currently supports only the sequential ordering strategy; compile a v1 queue for legacy permutation flows.");
  }
  if ("declaredOrder" in experiment.ordering && experiment.ordering.declaredOrder !== undefined) {
    assertDeclaredOrder(experiment, experiment.ordering.declaredOrder);
  }
  const taskCount = Object.keys(experiment.taskSet).length;
  const modelCount = Object.keys(experiment.modelSet).length;
  const harnessCount = Object.keys(experiment.harnessSet).length;
  for (const count of [taskCount, modelCount, harnessCount, experiment.trialCount]) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Experiment dimensions and trial count must be positive integers.");
  }
  if (taskCount * modelCount * harnessCount * experiment.trialCount > 100_000) {
    throw new Error("Run matrix exceeds the local queue limit of 100000 entries.");
  }
  const profiles = new Set(["smol", "docker", "local-fs-test"]);
  if (experiment.execution?.environmentProfile !== undefined && !profiles.has(experiment.execution.environmentProfile)) {
    throw new Error(`Unknown environment profile "${experiment.execution.environmentProfile}".`);
  }
  if (experiment.execution?.contextPolicy === "resume-requested") {
    throw new Error("resume-requested context policy is not supported by any current adapter; it must be rejected before candidate execution.");
  }
  if (experiment.execution?.contextPolicy === "imported-trajectory") {
    throw new Error("imported-trajectory context policy is outside the initial execution profile.");
  }
}

async function resolveTaskIdentity(
  taskId: string,
  condition: TaskSourceCondition,
  options: CompileHarborRunQueueOptions,
): Promise<RunQueueEntryTask> {
  if (condition.kind === "legacy-task-packet") {
    const supplied = options.legacyFrozenTasks?.[taskId];
    if (supplied === undefined) {
      throw new Error(`Legacy task "${taskId}" requires a supplied frozen identity in compileHarborRunQueue.`);
    }
    return { ...supplied, kind: "legacy-task-packet" };
  }
  if (options.studyRoot === undefined) {
    throw new Error(`Harbor task "${taskId}" requires a study root to resolve its frozen identity.`);
  }
  const status = await statusHarborTask(options.studyRoot, condition.taskSourceId, options.adapter === undefined ? {} : { adapter: options.adapter });
  if (status.status !== "frozen") {
    throw new Error(`Harbor task "${taskId}" (${condition.taskSourceId}) is ${status.status}; admit and freeze it before scheduling.`);
  }
  const admission = readHarborStudyJson(options.studyRoot, admissionLocatorOf(condition.taskSourceId)) as {
    harborTask: { digest: string };
    resolution: { resolutionDigest: Digest };
    assessmentMode: AssessmentMode;
    admissionDigest: Digest;
  };
  const freeze = readHarborStudyJson(options.studyRoot, freezeLocatorOf(condition.taskSourceId)) as {
    harborTask: { digest: string };
    freezeDigest: Digest;
    resolutionDigest: Digest;
    snapshotLocator: string;
    assessmentMode: AssessmentMode;
  };
  if ((condition.harborDigest !== undefined && admission.harborTask.digest !== condition.harborDigest)
      || (condition.harborDigest !== undefined && freeze.harborTask.digest !== condition.harborDigest)) {
    throw new Error(`Harbor task "${taskId}" content changed from the experiment reference (${condition.harborDigest ?? admission.harborTask.digest}).`);
  }
  if (condition.assessmentMode !== undefined && admission.assessmentMode !== condition.assessmentMode) {
    throw new Error(`Harbor task "${taskId}" assessment mode "${admission.assessmentMode}" does not match the experiment condition "${condition.assessmentMode}".`);
  }
  if (condition.snapshotLocator !== undefined && condition.snapshotLocator !== freeze.snapshotLocator) {
    throw new Error(`Harbor task "${taskId}" snapshot differs from the experiment reference.`);
  }
  return {
    kind: "harbor-task",
    id: taskId,
    taskSourceId: condition.taskSourceId,
    harborDigest: freeze.harborTask.digest,
    assessmentMode: admission.assessmentMode,
    snapshotLocator: freeze.snapshotLocator,
    admissionLocator: admissionLocatorOf(condition.taskSourceId),
    admissionDigest: admission.admissionDigest,
    freezeLocator: freezeLocatorOf(condition.taskSourceId),
    freezeDigest: freeze.freezeDigest,
    resolutionDigest: freeze.resolutionDigest,
  };
}

export function harborRunId(
  experimentId: string,
  experimentDigest: Digest,
  schedulingDigest: Digest,
  task: RunQueueEntryTask,
  model: RunQueueEntryV2["model"],
  harness: RunQueueEntryV2["harness"],
  trialIndex: number,
): string {
  return `run-${digestMetadata({
    queueSchema: HARBOR_RUN_QUEUE_SCHEMA_VERSION,
    experimentId,
    experimentDigest,
    schedulingDigest,
    task,
    model,
    harness,
    trialIndex,
  }).value}`;
}

function sameDigest(left: Digest | undefined, right: Digest | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.algorithm === right.algorithm && left.value === right.value;
}

function queueV2Error(artifact: string, field: string, message: string): ArtifactValidationError {
  return { artifact, schemaVersion: HARBOR_RUN_QUEUE_SCHEMA_VERSION, field, message };
}
