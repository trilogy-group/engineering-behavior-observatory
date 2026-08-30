import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  assertNoDuplicateJsonKeys,
  digestMetadata,
  validateArtifact,
  verifyDigest,
  writeMetadataAtomicallyIfAbsentSync,
  type ArtifactValidationError,
} from "./artifacts.js";
import {
  assertAdmittedTaskPackets,
  assertDeclaredOrder,
  assertResolvedExperimentConfigurationDigests,
  declaredMatrixCells,
  isSafeArtifactRelativePath,
  MAX_CONFIGURATION_BYTES,
  resolveBundleArtifact,
  resolveBundleArtifactDigest,
  type ArtifactReference,
  type DeclaredOrder,
  type DeclaredMatrixCell,
  type Digest,
  type ExperimentConfiguration,
  type ExperimentOrdering,
  type ResolvedTaskPacket,
} from "./contracts.js";
import {
  assertTaskPacketFreezeRecord,
  defaultFreezeLocator,
  formatErrors,
  statusTaskPacket,
  type TaskPacketFreezeRecord,
} from "./task-packets.js";

export type QueueOrderingStrategy = "sequential" | "seeded-shuffle" | "balanced";
export type PermutationAlgorithm = "fisher-yates-v1";
export const MAX_RUN_QUEUE_ENTRIES = 100_000;

export type FrozenTaskIdentity = {
  id: string;
  packetId: string;
  packetRef: ArtifactReference;
  freezeLocator: string;
  aggregateDigest: Digest;
};

export type FrozenTaskInput = TaskPacketFreezeRecord | {
  status?: "frozen";
  packetId: string;
  packetLocator?: string;
  packetDigest: Digest;
  freezeLocator: string;
  aggregateDigest: Digest;
} | {
  status?: "frozen";
  packetId: string;
  packetRef: ArtifactReference;
  freezeLocator: string;
  aggregateDigest: Digest;
};

export type RunQueueEntry = DeclaredMatrixCell & {
  runId: string;
  task: FrozenTaskIdentity;
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

export type RunQueueMatrix = DeclaredOrder & { trialCount: number };

export type RunQueue = {
  schemaVersion: "ebo.run-queue/v1";
  experimentId: string;
  experimentDigest: Digest;
  captureProfile: ArtifactReference;
  coordinatorBudget: { maxWallClockMs: number };
  matrix: RunQueueMatrix;
  seed: string;
  ordering: {
    strategy: QueueOrderingStrategy;
    balanceBy?: "task" | "model" | "harness";
    permutationAlgorithm?: PermutationAlgorithm;
    permutationAlgorithmRef?: ArtifactReference;
  };
  entries: RunQueueEntry[];
};

export type CompileRunQueueOptions = {
  bundleRoot?: string;
  resolvedDigests?: Record<string, Digest>;
  permutationAlgorithm?: unknown;
  permutationAlgorithms?: Record<string, unknown>;
  freezeLocators?: Record<string, string>;
  frozenTasks?: Record<string, FrozenTaskInput>;
  taskFreezeRecords?: Record<string, FrozenTaskInput>;
  taskPackets?: Record<string, FrozenTaskInput>;
  resolvedPackets?: Record<string, ResolvedTaskPacket>;
};

export type ValidateRunQueueOptions = Pick<CompileRunQueueOptions,
  "bundleRoot" | "resolvedDigests" | "frozenTasks" | "taskFreezeRecords" | "taskPackets"
  | "permutationAlgorithm" | "permutationAlgorithms" | "freezeLocators" | "resolvedPackets">;

export type RunQueueInspection = {
  experimentId: string;
  seed: string;
  strategy: QueueOrderingStrategy;
  entryCount: number;
  firstRunId: string | null;
  lastRunId: string | null;
};

export function expandMatrixCells(experiment: ExperimentConfiguration): DeclaredMatrixCell[] {
  assertMatrixSize(experiment);
  const order = matrixOrder(experiment);
  return [...declaredMatrixCells(order, experiment.trialCount)];
}

export function compileRunQueue(
  experiment: ExperimentConfiguration,
  options: CompileRunQueueOptions = {},
): RunQueue {
  const experimentErrors = validateArtifact("experiment.json", experiment);
  if (experimentErrors.length > 0) throw new Error(formatErrors(experimentErrors));
  assertMatrixSize(experiment);

  const ordering = normalizeOrdering(experiment.ordering);
  const experimentDigest = digestMetadata(experiment);
  const resolvedDigests = resolveConfigurationDigests(experiment, options);
  assertResolvedExperimentConfigurationDigests(experiment, resolvedDigests);
  const permutationAlgorithm = resolvePermutationAlgorithm(experiment, options);
  const persistedOrdering = ordering.strategy === "seeded-shuffle"
    ? { ...ordering, permutationAlgorithm }
    : ordering;
  const tasks = resolveFrozenTasks(experiment, options);
  if (options.bundleRoot === undefined) {
    if (options.resolvedPackets === undefined) {
      throw new Error("Resolved admitted task packets are required when no bundle root is supplied.");
    }
    assertAdmittedTaskPackets(experiment.taskSet, options.resolvedPackets);
  } else if (options.resolvedPackets !== undefined) {
    assertAdmittedTaskPackets(experiment.taskSet, options.resolvedPackets);
  }

  const cells = orderCells(
    expandMatrixCells(experiment),
    experiment.ordering,
    permutationAlgorithm,
  );
  const entries = cells.map((cell) => {
    const task = tasks.get(cell.taskId)!;
    const modelCondition = experiment.modelSet[cell.modelId]!;
    const harnessCondition = experiment.harnessSet[cell.harnessId]!;
    const model = { id: cell.modelId, configurationRef: modelCondition.configurationRef };
    const harness = { id: cell.harnessId, ...harnessCondition };
    const configuration = {
      model: model.configurationRef,
      harness: harness.configurationRef,
      nativeLimits: harness.nativeLimitsRef,
      nativeToolPolicy: harness.nativeToolPolicyRef,
    };
    return {
      ...cell,
      runId: runId(experiment.id, experimentDigest, task, model, harness, cell.trialIndex),
      task,
      model,
      harness,
      configuration,
      trial: { index: cell.trialIndex },
    };
  });

  const queue: RunQueue = {
    schemaVersion: "ebo.run-queue/v1",
    experimentId: experiment.id,
    experimentDigest,
    captureProfile: experiment.captureProfile,
    coordinatorBudget: experiment.coordinatorBudget,
    matrix: { ...matrixOrder(experiment), trialCount: experiment.trialCount },
    seed: experiment.ordering.seed,
    ordering: persistedOrdering,
    entries,
  };
  assertValidRunQueue(queue, experiment, "run-queue.json", options);
  return queue;
}

export function writeRunQueue(path: string, queue: RunQueue): Digest {
  assertValidRunQueue(queue);
  const absolutePath = resolve(path);
  const relativePath = basename(absolutePath);
  if (!isSafeArtifactRelativePath(relativePath)) {
    throw new Error(`Run queue path "${relativePath}" is unsafe.`);
  }
  const root = dirname(absolutePath);
  mkdirSync(root, { recursive: true });
  const expected = digestMetadata(queue);
  const published = writeMetadataAtomicallyIfAbsentSync(root, relativePath, queue).digest;
  if (!sameDigest(expected, published)) {
    throw new Error(`Run queue path "${path}" already contains a different queue.`);
  }
  return published;
}

export function readRunQueue(
  path: string,
  experiment?: ExperimentConfiguration,
  options: ValidateRunQueueOptions = {},
): RunQueue {
  const bytes = readFileSync(path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  const queue = JSON.parse(text) as unknown;
  assertValidRunQueue(queue, experiment, path, options);
  return queue as RunQueue;
}

export function validateRunQueue(
  queue: unknown,
  experiment?: ExperimentConfiguration,
  artifact = "run-queue.json",
  options: ValidateRunQueueOptions = {},
): ArtifactValidationError[] {
  let validatedPermutationAlgorithm: PermutationAlgorithm | undefined;
  if (experiment !== undefined) {
    const experimentErrors = validateArtifact("experiment.json", experiment);
    if (experimentErrors.length > 0) return experimentErrors;
    try {
      assertMatrixSize(experiment);
      if (options.bundleRoot !== undefined || options.resolvedDigests !== undefined) {
        assertResolvedExperimentConfigurationDigests(experiment, resolveConfigurationDigests(experiment, options));
      }
      if (canResolvePermutationAlgorithm(options)) {
        validatedPermutationAlgorithm = resolvePermutationAlgorithm(experiment, options);
      }
    } catch (error) {
      return [queueError(artifact, "/experiment", error instanceof Error ? error.message : "Experiment cannot be scheduled.")];
    }
  }
  const errors = validateArtifact(artifact, queue);
  if (errors.length > 0) return errors;
  if (!isRecord(queue)) return [queueError(artifact, "/", "Run queue must be an object.")];
  if (queue.schemaVersion !== "ebo.run-queue/v1") {
    return [queueError(artifact, "/schemaVersion", "Expected an ebo.run-queue/v1 artifact.")];
  }

  const runQueue = queue as unknown as RunQueue;
  const semanticErrors: ArtifactValidationError[] = [];
  if (experiment === undefined && options.bundleRoot !== undefined) {
    semanticErrors.push(...validateQueueBundleRoot(runQueue, options.bundleRoot, artifact));
  }
  const runIds = new Set<string>();
  const cells = new Set<string>();
  const taskIdentities = new Map<string, string>();
  const modelIdentities = new Map<string, string>();
  const harnessIdentities = new Map<string, string>();
  const taskCompositions = new Map<string, string>();
  const modelCompositions = new Map<string, string>();
  const harnessCompositions = new Map<string, string>();
  const locatorDigests = new Map<string, string>();
  checkLocatorDigest(artifact, "/captureProfile", runQueue.captureProfile, locatorDigests, semanticErrors);
  if (runQueue.ordering.permutationAlgorithmRef !== undefined) {
    checkLocatorDigest(artifact, "/ordering/permutationAlgorithmRef", runQueue.ordering.permutationAlgorithmRef, locatorDigests, semanticErrors);
  }
  let expectedTasks: Map<string, FrozenTaskIdentity> | undefined;
  if (experiment !== undefined) {
    if (options.resolvedPackets !== undefined) {
      try {
        assertAdmittedTaskPackets(experiment.taskSet, options.resolvedPackets);
      } catch (error) {
        semanticErrors.push(queueError(artifact, "/entries/task", error instanceof Error ? error.message : "Resolved task packets are not admitted."));
      }
    }
    if (hasFrozenTaskInputs(options)) {
      try {
        if (options.bundleRoot === undefined && options.resolvedPackets === undefined) {
          throw new Error("Resolved admitted task packets are required for API-supplied freeze identities.");
        }
        expectedTasks = resolveFrozenTasks(experiment, provenanceOptions(runQueue, options));
      } catch (error) {
        semanticErrors.push(queueError(artifact, "/entries/task", error instanceof Error ? error.message : "Frozen task records could not be resolved."));
      }
    }
  }
  for (const [index, entry] of runQueue.entries.entries()) {
    const field = `/entries/${index}`;
    if (runIds.has(entry.runId)) {
      semanticErrors.push(queueError(artifact, `${field}/runId`, `Duplicate run ID "${entry.runId}".`));
    }
    runIds.add(entry.runId);
    const cellKey = `${entry.taskId}\u0000${entry.modelId}\u0000${entry.harnessId}\u0000${entry.trialIndex}`;
    if (cells.has(cellKey)) {
      semanticErrors.push(queueError(artifact, field, "Duplicate matrix cell."));
    }
    cells.add(cellKey);
    if (entry.task.id !== entry.taskId || entry.model.id !== entry.modelId || entry.harness.id !== entry.harnessId) {
      semanticErrors.push(queueError(artifact, field, "Entry identities do not match their dimension IDs."));
    }
    if (entry.trial.index !== entry.trialIndex) {
      semanticErrors.push(queueError(artifact, `${field}/trial`, "Trial identity does not match trialIndex."));
    }
    if (!sameReference(entry.configuration.model, entry.model.configurationRef)
        || !sameReference(entry.configuration.harness, entry.harness.configurationRef)
        || !sameReference(entry.configuration.nativeLimits, entry.harness.nativeLimitsRef)
        || !sameReference(entry.configuration.nativeToolPolicy, entry.harness.nativeToolPolicyRef)) {
      semanticErrors.push(queueError(artifact, `${field}/configuration`, "Configuration identity does not match its model or harness."));
    }
    checkConditionIdentity(artifact, field, "task", entry.taskId, entry.task, taskIdentities, semanticErrors);
    checkConditionIdentity(artifact, field, "model", entry.modelId, entry.model, modelIdentities, semanticErrors);
    checkConditionIdentity(artifact, field, "harness", entry.harnessId, entry.harness, harnessIdentities, semanticErrors);
    checkCompositionIdentity(artifact, field, "task", entry.taskId, digestIdentity(entry.task.packetRef.digest), taskCompositions, semanticErrors);
    checkCompositionIdentity(artifact, field, "model", entry.modelId, digestIdentity(entry.model.configurationRef.digest), modelCompositions, semanticErrors);
    checkCompositionIdentity(
      artifact,
      field,
      "harness",
      entry.harnessId,
      [entry.harness.configurationRef, entry.harness.nativeLimitsRef, entry.harness.nativeToolPolicyRef]
        .map((reference) => digestIdentity(reference.digest)).join("|"),
      harnessCompositions,
      semanticErrors,
    );
    for (const [label, reference] of [
      ["task", entry.task.packetRef] as const,
      ["model", entry.model.configurationRef] as const,
      ["harness", entry.harness.configurationRef] as const,
      ["harness limits", entry.harness.nativeLimitsRef] as const,
      ["harness tools", entry.harness.nativeToolPolicyRef] as const,
    ]) {
      checkLocatorDigest(artifact, `${field}/${label}`, reference, locatorDigests, semanticErrors);
    }
    if (experiment !== undefined) {
      const taskCondition = experiment.taskSet[entry.taskId];
      const modelCondition = experiment.modelSet[entry.modelId];
      const harnessCondition = experiment.harnessSet[entry.harnessId];
      if (taskCondition === undefined || !sameReference(entry.task.packetRef, taskCondition.packetRef)) {
        semanticErrors.push(queueError(artifact, `${field}/task`, "Task packet reference does not match the experiment."));
      }
      if (modelCondition === undefined || !sameReference(entry.model.configurationRef, modelCondition.configurationRef)) {
        semanticErrors.push(queueError(artifact, `${field}/model`, "Model configuration reference does not match the experiment."));
      }
      if (harnessCondition === undefined
          || !sameReference(entry.harness.configurationRef, harnessCondition.configurationRef)
          || !sameReference(entry.harness.nativeLimitsRef, harnessCondition.nativeLimitsRef)
          || !sameReference(entry.harness.nativeToolPolicyRef, harnessCondition.nativeToolPolicyRef)) {
        semanticErrors.push(queueError(artifact, `${field}/harness`, "Harness configuration references do not match the experiment."));
      }
      const expectedTask = expectedTasks?.get(entry.taskId);
      if (expectedTask !== undefined && !sameFrozenTask(entry.task, expectedTask)) {
        semanticErrors.push(queueError(artifact, `${field}/task`, "Frozen task identity does not match its referenced freeze record."));
      }
    }
    if (entry.runId !== runId(
      runQueue.experimentId,
      runQueue.experimentDigest,
      entry.task,
      entry.model,
      entry.harness,
      entry.trialIndex,
    )) {
      semanticErrors.push(queueError(artifact, `${field}/runId`, "Run ID does not match its frozen cell identities."));
    }
  }

  if (experiment === undefined) {
    try {
      assertMatrixSize(runQueue.matrix);
      const expectedCells = [...declaredMatrixCells(runQueue.matrix, runQueue.matrix.trialCount)];
      const expectedKeys = new Set(expectedCells.map(cellKeyOf));
      const expectedOrder = orderCells(
        expectedCells,
        queueMatrixOrdering(runQueue),
        runQueue.ordering.permutationAlgorithm ?? "fisher-yates-v1",
      ).map(cellKeyOf);
      const actualOrder = runQueue.entries.map(cellKeyOf);
      if (expectedKeys.size !== cells.size || [...expectedKeys].some((key) => !cells.has(key))) {
        semanticErrors.push(queueError(artifact, "/entries", "Run queue cells do not match its persisted matrix."));
      }
      if (expectedOrder.length !== actualOrder.length
          || expectedOrder.some((key, index) => key !== actualOrder[index])) {
        semanticErrors.push(queueError(artifact, "/entries", "Run queue order does not match its persisted ordering policy."));
      }
    } catch (error) {
      semanticErrors.push(queueError(artifact, "/matrix", error instanceof Error ? error.message : "Persisted matrix is too large."));
    }
  }

  if (experiment !== undefined) {
    if (runQueue.experimentId !== experiment.id) {
      semanticErrors.push(queueError(artifact, "/experimentId", "Run queue experiment ID does not match the experiment."));
    }
    if (!sameDigest(runQueue.experimentDigest, digestMetadata(experiment))) {
      semanticErrors.push(queueError(artifact, "/experimentDigest", "Run queue experiment digest does not match the experiment."));
    }
    if (!sameReference(runQueue.captureProfile, experiment.captureProfile)) {
      semanticErrors.push(queueError(artifact, "/captureProfile", "Run queue capture profile does not match the experiment."));
    }
    if (runQueue.coordinatorBudget.maxWallClockMs !== experiment.coordinatorBudget.maxWallClockMs) {
      semanticErrors.push(queueError(artifact, "/coordinatorBudget", "Run queue coordinator budget does not match the experiment."));
    }
    if (!sameMatrix(runQueue.matrix, { ...matrixOrder(experiment), trialCount: experiment.trialCount })) {
      semanticErrors.push(queueError(artifact, "/matrix", "Run queue matrix metadata does not match the experiment."));
    }
    const expectedOrdering = normalizeOrdering(experiment.ordering);
    if (runQueue.seed !== experiment.ordering.seed || runQueue.ordering.strategy !== expectedOrdering.strategy
        || runQueue.ordering.balanceBy !== expectedOrdering.balanceBy
        || !sameOptionalReference(runQueue.ordering.permutationAlgorithmRef, expectedOrdering.permutationAlgorithmRef)
        || (validatedPermutationAlgorithm !== undefined
          && runQueue.ordering.permutationAlgorithm !== validatedPermutationAlgorithm)
        || (expectedOrdering.strategy === "seeded-shuffle" && runQueue.ordering.permutationAlgorithm === undefined)) {
      semanticErrors.push(queueError(artifact, "/ordering", "Run queue ordering does not match the experiment."));
    }
    const expectedCells = new Set(expandMatrixCells(experiment).map(cellKeyOf));
    if (expectedCells.size !== cells.size || [...expectedCells].some((key) => !cells.has(key))) {
      semanticErrors.push(queueError(artifact, "/entries", "Run queue cells do not match the experiment matrix."));
    }
    const expectedOrder = orderCells(
      expandMatrixCells(experiment),
      experiment.ordering,
      validatedPermutationAlgorithm ?? runQueue.ordering.permutationAlgorithm ?? "fisher-yates-v1",
    ).map(cellKeyOf);
    const actualOrder = runQueue.entries.map(cellKeyOf);
    if (expectedOrder.length !== actualOrder.length
        || expectedOrder.some((key, index) => key !== actualOrder[index])) {
      semanticErrors.push(queueError(artifact, "/entries", "Run queue order does not match the experiment ordering policy."));
    }
  }
  return semanticErrors;
}

export function assertValidRunQueue(
  queue: unknown,
  experiment?: ExperimentConfiguration,
  artifact = "run-queue.json",
  options: ValidateRunQueueOptions = {},
): asserts queue is RunQueue {
  const errors = validateRunQueue(queue, experiment, artifact, options);
  if (errors.length > 0) throw new Error(formatErrors(errors));
}

export function inspectRunQueue(queue: RunQueue): RunQueueInspection {
  assertValidRunQueue(queue);
  return {
    experimentId: queue.experimentId,
    seed: queue.seed,
    strategy: queue.ordering.strategy,
    entryCount: queue.entries.length,
    firstRunId: queue.entries[0]?.runId ?? null,
    lastRunId: queue.entries.at(-1)?.runId ?? null,
  };
}

export class LocalRunQueue {
  private position = 0;
  private readonly snapshot: RunQueue;

  public constructor(queue: RunQueue) {
    assertValidRunQueue(queue);
    this.snapshot = structuredClone(queue);
  }

  public get queue(): RunQueue {
    return structuredClone(this.snapshot);
  }

  public get remaining(): number {
    return this.snapshot.entries.length - this.position;
  }

  public next(): RunQueueEntry | undefined {
    if (this.position >= this.snapshot.entries.length) return undefined;
    return structuredClone(this.snapshot.entries[this.position++]);
  }
}

function assertMatrixSize(
  experiment: Pick<ExperimentConfiguration, "taskSet" | "modelSet" | "harnessSet" | "trialCount"> | RunQueueMatrix,
): void {
  let cellCount = 1;
  const dimensions = "taskSet" in experiment
    ? [
      Object.keys(experiment.taskSet).length,
      Object.keys(experiment.modelSet).length,
      Object.keys(experiment.harnessSet).length,
      experiment.trialCount,
    ]
    : [experiment.taskIds.length, experiment.modelIds.length, experiment.harnessIds.length, experiment.trialCount];
  for (const dimension of dimensions) {
    if (cellCount > Math.floor(MAX_RUN_QUEUE_ENTRIES / dimension)) {
      // ponytail: fixed local queue cap; stream to disk if larger matrices become required.
      throw new Error(`Run matrix exceeds the local queue limit of ${MAX_RUN_QUEUE_ENTRIES} entries.`);
    }
    cellCount *= dimension;
  }
}

function matrixOrder(experiment: ExperimentConfiguration): {
  taskIds: string[];
  modelIds: string[];
  harnessIds: string[];
} {
  const declared = "declaredOrder" in experiment.ordering ? experiment.ordering.declaredOrder : undefined;
  if (declared !== undefined) {
    assertDeclaredOrder(experiment, declared);
    return declared;
  }
  return {
    taskIds: Object.keys(experiment.taskSet).sort(),
    modelIds: Object.keys(experiment.modelSet).sort(),
    harnessIds: Object.keys(experiment.harnessSet).sort(),
  };
}

function normalizeOrdering(ordering: ExperimentOrdering): RunQueue["ordering"] {
  switch (ordering.strategy) {
    case "declared":
    case "sequential":
      return { strategy: "sequential" };
    case "permuted":
    case "seeded-shuffle":
      return {
        strategy: "seeded-shuffle",
        ...(ordering.permutationAlgorithmRef === undefined ? {} : { permutationAlgorithmRef: ordering.permutationAlgorithmRef }),
      };
    case "balanced":
    case "balanced-interleaved":
    case "interleaved":
      return { strategy: "balanced", ...(ordering.balanceBy === undefined ? {} : { balanceBy: ordering.balanceBy }) };
  }
}

function queueMatrixOrdering(queue: RunQueue): ExperimentOrdering {
  switch (queue.ordering.strategy) {
    case "sequential":
      return { seed: queue.seed, strategy: "sequential", declaredOrder: queue.matrix };
    case "seeded-shuffle":
      return {
        seed: queue.seed,
        strategy: "seeded-shuffle",
        declaredOrder: queue.matrix,
        ...(queue.ordering.permutationAlgorithmRef === undefined
          ? {}
          : { permutationAlgorithmRef: queue.ordering.permutationAlgorithmRef }),
      };
    case "balanced":
      return {
        seed: queue.seed,
        strategy: "balanced",
        declaredOrder: queue.matrix,
        ...(queue.ordering.balanceBy === undefined ? {} : { balanceBy: queue.ordering.balanceBy }),
      };
  }
}

function resolveConfigurationDigests(
  experiment: ExperimentConfiguration,
  options: CompileRunQueueOptions,
): Record<string, Digest> {
  if (options.bundleRoot === undefined) {
    if (options.resolvedDigests === undefined) {
      throw new Error("Configuration references must be resolved before compiling a run queue.");
    }
    return options.resolvedDigests;
  }

  const references = experimentReferences(experiment);
  const resolved: Record<string, Digest> = {};
  for (const reference of references) {
    resolved[reference.locator] = resolveBundleArtifactDigest(options.bundleRoot, reference);
  }
  return resolved;
}

function resolvePermutationAlgorithm(
  experiment: ExperimentConfiguration,
  options: CompileRunQueueOptions,
): PermutationAlgorithm {
  const reference = "permutationAlgorithmRef" in experiment.ordering
    ? experiment.ordering.permutationAlgorithmRef
    : undefined;
  if (reference === undefined) return "fisher-yates-v1";

  return resolvePermutationDefinition(reference, options);
}

function resolvePermutationDefinition(
  reference: ArtifactReference,
  options: CompileRunQueueOptions,
): PermutationAlgorithm {

  let definition: unknown;
  if (options.bundleRoot !== undefined) {
    const bytes = resolveBundleArtifact(options.bundleRoot, reference, MAX_CONFIGURATION_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateJsonKeys(text);
    definition = JSON.parse(text) as unknown;
  } else {
    definition = options.permutationAlgorithm;
    if (definition === undefined) definition = options.permutationAlgorithms?.[reference.locator];
    if (!(definition instanceof Uint8Array)) {
      throw new Error(`Permutation algorithm "${reference.locator}" must be supplied as verified bytes.`);
    }
    const bytes = Buffer.from(definition);
    if (!verifyDigest(bytes, reference.digest)) {
      throw new Error(`Permutation algorithm "${reference.locator}" digest does not match its reference.`);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateJsonKeys(text);
    definition = JSON.parse(text) as unknown;
  }
  if (definition === undefined) {
    throw new Error(`Permutation algorithm "${reference.locator}" content must be supplied before scheduling.`);
  }

  const name = typeof definition === "string"
    ? definition
    : isRecord(definition)
      ? definition.algorithm ?? definition.name ?? definition.id ?? definition.kind
      : undefined;
  if (name === "fisher-yates-v1") return "fisher-yates-v1";
  throw new Error(`Unsupported permutation algorithm "${String(name)}".`);
}

function canResolvePermutationAlgorithm(options: ValidateRunQueueOptions): boolean {
  return options.bundleRoot !== undefined
    || options.permutationAlgorithm !== undefined
    || options.permutationAlgorithms !== undefined;
}

function validateQueueBundleRoot(
  queue: RunQueue,
  bundleRoot: string,
  artifact: string,
): ArtifactValidationError[] {
  const errors: ArtifactValidationError[] = [];
  const references = new Map<string, ArtifactReference>();
  const addReference = (reference: ArtifactReference) => references.set(
    `${reference.locator}\u0000${digestIdentity(reference.digest)}`,
    reference,
  );
  addReference(queue.captureProfile);
  for (const entry of queue.entries) {
    addReference(entry.model.configurationRef);
    addReference(entry.harness.configurationRef);
    addReference(entry.harness.nativeLimitsRef);
    addReference(entry.harness.nativeToolPolicyRef);
  }
  if (queue.ordering.permutationAlgorithmRef !== undefined) addReference(queue.ordering.permutationAlgorithmRef);
  for (const [index, reference] of [...references.values()].entries()) {
    try {
      resolveBundleArtifactDigest(bundleRoot, reference);
    } catch (error) {
      errors.push(queueError(artifact, `/references/${index}`, error instanceof Error ? error.message : "Reference could not be resolved."));
    }
  }

  const observed = new Map<string, FrozenTaskIdentity | Error>();
  for (const [index, entry] of queue.entries.entries()) {
    const key = `${entry.task.packetRef.locator}\u0000${entry.task.freezeLocator}`;
    let resolved = observed.get(key);
    if (resolved === undefined) {
      try {
        const status = statusTaskPacket(bundleRoot, entry.task.packetRef.locator, entry.task.freezeLocator);
        if (status.status !== "frozen" || status.packetId === null || status.packetDigest === null || status.aggregateDigest === null) {
          const details = status.errors.length > 0 ? ` ${formatErrors(status.errors)}` : "";
          resolved = new Error(`Task packet is not frozen.${details}`);
        } else if (!sameDigest(status.packetDigest, entry.task.packetRef.digest)) {
          resolved = new Error("Task packet digest does not match its queue reference.");
        } else {
          resolved = {
            id: entry.task.id,
            packetId: status.packetId,
            packetRef: entry.task.packetRef,
            freezeLocator: status.freezeLocator,
            aggregateDigest: status.aggregateDigest,
          };
        }
      } catch (error) {
        resolved = error instanceof Error ? error : new Error("Task packet freeze could not be resolved.");
      }
      observed.set(key, resolved);
    }
    if (resolved instanceof Error || !sameFrozenTask(entry.task, resolved)) {
      errors.push(queueError(artifact, `/entries/${index}/task`, resolved instanceof Error
        ? resolved.message
        : "Frozen task identity does not match its referenced freeze record."));
    }
  }

  if (queue.ordering.strategy === "seeded-shuffle" && queue.ordering.permutationAlgorithmRef !== undefined) {
    try {
      const algorithm = resolvePermutationDefinition(queue.ordering.permutationAlgorithmRef, { bundleRoot });
      if (queue.ordering.permutationAlgorithm !== algorithm) {
        errors.push(queueError(artifact, "/ordering", "Persisted permutation algorithm does not match its referenced artifact."));
      }
    } catch (error) {
      errors.push(queueError(artifact, "/ordering/permutationAlgorithmRef", error instanceof Error ? error.message : "Permutation algorithm could not be resolved."));
    }
  }
  return errors;
}

function experimentReferences(experiment: ExperimentConfiguration): ArtifactReference[] {
  return [
    ...Object.values(experiment.modelSet).map((condition) => condition.configurationRef),
    ...Object.values(experiment.harnessSet).flatMap((condition) => [
      condition.configurationRef,
      condition.nativeLimitsRef,
      condition.nativeToolPolicyRef,
    ]),
    experiment.captureProfile,
    ...("permutationAlgorithmRef" in experiment.ordering && experiment.ordering.permutationAlgorithmRef !== undefined
      ? [experiment.ordering.permutationAlgorithmRef]
      : []),
  ];
}

function resolveFrozenTasks(
  experiment: ExperimentConfiguration,
  options: CompileRunQueueOptions,
): Map<string, FrozenTaskIdentity> {
  const supplied = options.frozenTasks ?? options.taskFreezeRecords ?? options.taskPackets;
  const tasks = new Map<string, FrozenTaskIdentity>();
  const packetDigests = new Set<string>();

  for (const [taskId, condition] of Object.entries(experiment.taskSet)) {
    const suppliedInput = supplied?.[taskId] ?? supplied?.[condition.packetRef.locator];
  const identity = options.bundleRoot !== undefined
      ? frozenTaskFromBundle(
        options.bundleRoot,
        taskId,
        condition.packetRef.locator,
        condition.packetRef,
        options.freezeLocators?.[taskId] ?? freezeLocatorOf(suppliedInput),
      )
      : frozenTaskFromInput(taskId, condition.packetRef, suppliedInput, options.freezeLocators?.[taskId]);
    if (packetDigests.has(digestIdentity(identity.packetRef.digest))) {
      throw new Error(`Task packet "${taskId}" duplicates a packet digest.`);
    }
    packetDigests.add(digestIdentity(identity.packetRef.digest));
    tasks.set(taskId, identity);
  }
  if (options.bundleRoot === undefined && supplied === undefined) {
    throw new Error("Every task packet must have a frozen task-packet record before scheduling.");
  }
  return tasks;
}

function provenanceOptions(
  queue: RunQueue,
  options: ValidateRunQueueOptions,
): ValidateRunQueueOptions {
  if (options.bundleRoot === undefined || hasExplicitFrozenTaskInputs(options)) return options;
  const frozenTasks = Object.fromEntries(queue.entries.map((entry) => [entry.taskId, {
    status: "frozen" as const,
    packetId: entry.task.packetId,
    packetLocator: entry.task.packetRef.locator,
    packetDigest: entry.task.packetRef.digest,
    freezeLocator: entry.task.freezeLocator,
    aggregateDigest: entry.task.aggregateDigest,
  }]));
  return { ...options, frozenTasks };
}

function frozenTaskFromBundle(
  bundleRoot: string,
  taskId: string,
  packetLocator: string,
  packetRef: ArtifactReference,
  freezeLocator?: string,
): FrozenTaskIdentity {
  const status = statusTaskPacket(bundleRoot, packetLocator, freezeLocator ?? defaultFreezeLocator(packetLocator));
  if (status.status !== "frozen" || status.packetId === null || status.packetDigest === null || status.aggregateDigest === null) {
    const details = status.errors.length > 0 ? ` ${formatErrors(status.errors)}` : "";
    throw new Error(`Task packet "${taskId}" is not frozen.${details}`);
  }
  if (!sameDigest(status.packetDigest, packetRef.digest)) {
    throw new Error(`Task packet "${taskId}" freeze digest does not match its experiment reference.`);
  }
  return {
    id: taskId,
    packetId: status.packetId,
    packetRef,
    freezeLocator: status.freezeLocator,
    aggregateDigest: status.aggregateDigest,
  };
}

function freezeLocatorOf(input: FrozenTaskInput | undefined): string | undefined {
  return isRecord(input) && "freezeLocator" in input && typeof input.freezeLocator === "string"
    ? input.freezeLocator
    : undefined;
}

function frozenTaskFromInput(
  taskId: string,
  packetRef: ArtifactReference,
  input: FrozenTaskInput | undefined,
  freezeLocatorOverride?: string,
): FrozenTaskIdentity {
  if (input === undefined) {
    throw new Error(`Task packet "${taskId}" has no frozen record.`);
  }
  if (!("schemaVersion" in input) || input.schemaVersion !== "ebo.task-packet-freeze/v1") {
    throw new Error(`Task packet "${taskId}" requires a complete freeze record when no bundle root is supplied.`);
  }
  assertTaskPacketFreezeRecord(input);
  if ("status" in input && input.status !== undefined && input.status !== "frozen") {
    throw new Error(`Task packet "${taskId}" is ${input.status}, not frozen.`);
  }
  const record = input as Partial<TaskPacketFreezeRecord> & Partial<Omit<FrozenTaskIdentity, "id">>;
  const packetLocator = record.packetLocator ?? record.packetRef?.locator ?? packetRef.locator;
  const packetDigest = record.packetDigest ?? record.packetRef?.digest;
  const packetId = record.packetId;
  const freezeLocator = freezeLocatorOverride ?? record.freezeLocator
    ?? (typeof packetLocator === "string" ? defaultFreezeLocator(packetLocator) : undefined);
  const aggregateDigest = record.aggregateDigest;
  if (typeof packetLocator !== "string" || packetDigest === undefined || typeof packetId !== "string"
      || typeof freezeLocator !== "string" || aggregateDigest === undefined) {
    throw new Error(`Task packet "${taskId}" has an incomplete frozen record.`);
  }
  if (packetLocator !== packetRef.locator || !sameDigest(packetDigest, packetRef.digest)) {
    throw new Error(`Task packet "${taskId}" freeze record does not match its experiment reference.`);
  }
  if (!isSafeArtifactRelativePath(freezeLocator)) {
    throw new Error(`Task packet "${taskId}" freeze locator is unsafe.`);
  }
  return { id: taskId, packetId, packetRef, freezeLocator, aggregateDigest };
}

function orderCells(
  cells: DeclaredMatrixCell[],
  ordering: ExperimentOrdering,
  permutationAlgorithm: PermutationAlgorithm = "fisher-yates-v1",
): DeclaredMatrixCell[] {
  switch (ordering.strategy) {
    case "declared":
    case "sequential":
      return cells;
    case "permuted":
    case "seeded-shuffle":
      return shuffle(cells, ordering.seed, permutationAlgorithm);
    case "balanced":
    case "balanced-interleaved":
    case "interleaved":
      return interleave(cells, ordering.balanceBy ?? "model");
  }
}

function shuffle<T>(values: T[], seed: string, algorithm: PermutationAlgorithm): T[] {
  if (algorithm !== "fisher-yates-v1") throw new Error(`Unsupported permutation algorithm "${algorithm}".`);
  const shuffled = [...values];
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0) || 0x9e3779b9;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const swap = state % (index + 1);
    [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
  }
  return shuffled;
}

function interleave(cells: DeclaredMatrixCell[], dimension: "task" | "model" | "harness"): DeclaredMatrixCell[] {
  const groups = new Map<string, DeclaredMatrixCell[]>();
  for (const cell of cells) {
    const id = dimension === "task" ? cell.taskId : dimension === "model" ? cell.modelId : cell.harnessId;
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [cell]);
    else group.push(cell);
  }
  const keys = [...groups.keys()];
  const positions = new Map(keys.map((key) => [key, 0]));
  const ordered: DeclaredMatrixCell[] = [];
  let remaining = cells.length;
  while (remaining > 0) {
    for (const key of keys) {
      const group = groups.get(key)!;
      const index = positions.get(key)!;
      if (index >= group.length) continue;
      ordered.push(group[index]!);
      positions.set(key, index + 1);
      remaining -= 1;
    }
  }
  return ordered;
}

function runId(
  experimentId: string,
  experimentDigest: Digest,
  task: FrozenTaskIdentity,
  model: RunQueueEntry["model"],
  harness: RunQueueEntry["harness"],
  trialIndex: number,
): string {
  return `run-${digestMetadata({ experimentId, experimentDigest, task, model, harness, trialIndex }).value}`;
}

function queueError(artifact: string, field: string, message: string): ArtifactValidationError {
  return { artifact, schemaVersion: "ebo.run-queue/v1", field, message };
}

function checkConditionIdentity(
  artifact: string,
  field: string,
  label: string,
  id: string,
  identity: unknown,
  identities: Map<string, string>,
  errors: ArtifactValidationError[],
): void {
  const signature = digestMetadata(identity).value;
  const previous = identities.get(id);
  if (previous === undefined) identities.set(id, signature);
  else if (previous !== signature) {
    errors.push(queueError(artifact, `${field}/${label}`, `Conflicting ${label} identity for condition ID "${id}".`));
  }
}

function checkCompositionIdentity(
  artifact: string,
  field: string,
  label: string,
  id: string,
  signature: string,
  compositions: Map<string, string>,
  errors: ArtifactValidationError[],
): void {
  const previous = compositions.get(signature);
  if (previous === undefined) compositions.set(signature, id);
  else if (previous !== id) {
    errors.push(queueError(artifact, `${field}/${label}`, `Duplicate ${label} composition for condition IDs "${previous}" and "${id}".`));
  }
}

function checkLocatorDigest(
  artifact: string,
  field: string,
  reference: ArtifactReference,
  locators: Map<string, string>,
  errors: ArtifactValidationError[],
): void {
  const locator = reference.locator.toLowerCase();
  const signature = digestIdentity(reference.digest);
  const previous = locators.get(locator);
  if (previous === undefined) locators.set(locator, signature);
  else if (previous !== signature) {
    errors.push(queueError(artifact, field, `Locator "${reference.locator}" is bound to conflicting digests.`));
  }
}

function cellKeyOf(cell: DeclaredMatrixCell): string {
  return `${cell.taskId}\u0000${cell.modelId}\u0000${cell.harnessId}\u0000${cell.trialIndex}`;
}

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return left.locator === right.locator && sameDigest(left.digest, right.digest);
}

function sameMatrix(left: RunQueueMatrix, right: RunQueueMatrix): boolean {
  return left.trialCount === right.trialCount
    && sameIdList(left.taskIds, right.taskIds)
    && sameIdList(left.modelIds, right.modelIds)
    && sameIdList(left.harnessIds, right.harnessIds);
}

function sameIdList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameFrozenTask(left: FrozenTaskIdentity, right: FrozenTaskIdentity): boolean {
  return left.id === right.id
    && left.packetId === right.packetId
    && sameReference(left.packetRef, right.packetRef)
    && left.freezeLocator === right.freezeLocator
    && sameDigest(left.aggregateDigest, right.aggregateDigest);
}

function sameOptionalReference(left: ArtifactReference | undefined, right: ArtifactReference | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameReference(left, right);
}

function sameDigest(left: Digest, right: Digest): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function digestIdentity(digest: Digest): string {
  return `${digest.algorithm}:${digest.value}`;
}

function hasFrozenTaskInputs(options: ValidateRunQueueOptions): boolean {
  return options.bundleRoot !== undefined
    || options.frozenTasks !== undefined
    || options.taskFreezeRecords !== undefined
    || options.taskPackets !== undefined;
}

function hasExplicitFrozenTaskInputs(options: ValidateRunQueueOptions): boolean {
  return options.frozenTasks !== undefined
    || options.taskFreezeRecords !== undefined
    || options.taskPackets !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
