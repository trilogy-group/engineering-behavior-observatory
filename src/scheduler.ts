import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  assertNoDuplicateJsonKeys,
  digestMetadata,
  validateArtifact,
  writeMetadataAtomicallyIfAbsentSync,
  type ArtifactValidationError,
} from "./artifacts.js";
import {
  assertAdmittedTaskPackets,
  assertDeclaredOrder,
  assertResolvedExperimentConfigurationDigests,
  declaredMatrixCells,
  isSafeArtifactRelativePath,
  resolveBundleArtifact,
  resolveBundleArtifactDigest,
  type ArtifactReference,
  type DeclaredMatrixCell,
  type Digest,
  type ExperimentConfiguration,
  type ExperimentOrdering,
  type ResolvedTaskPacket,
} from "./contracts.js";
import {
  defaultFreezeLocator,
  formatErrors,
  statusTaskPacket,
  type TaskPacketFreezeRecord,
} from "./task-packets.js";

export type QueueOrderingStrategy = "sequential" | "seeded-shuffle" | "balanced";
export type PermutationAlgorithm = "fisher-yates-v1";

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

export type RunQueue = {
  schemaVersion: "ebo.run-queue/v1";
  experimentId: string;
  experimentDigest: Digest;
  captureProfile: ArtifactReference;
  seed: string;
  ordering: {
    strategy: QueueOrderingStrategy;
    balanceBy?: "task" | "model" | "harness";
    permutationAlgorithmRef?: ArtifactReference;
  };
  entries: RunQueueEntry[];
};

export type CompileRunQueueOptions = {
  bundleRoot?: string;
  resolvedDigests?: Record<string, Digest>;
  permutationAlgorithm?: unknown;
  permutationAlgorithms?: Record<string, unknown>;
  frozenTasks?: Record<string, FrozenTaskInput>;
  taskFreezeRecords?: Record<string, FrozenTaskInput>;
  taskPackets?: Record<string, FrozenTaskInput>;
  resolvedPackets?: Record<string, ResolvedTaskPacket>;
};

export type RunQueueInspection = {
  experimentId: string;
  seed: string;
  strategy: QueueOrderingStrategy;
  entryCount: number;
  firstRunId: string | null;
  lastRunId: string | null;
};

export function expandMatrixCells(experiment: ExperimentConfiguration): DeclaredMatrixCell[] {
  const order = matrixOrder(experiment);
  return [...declaredMatrixCells(order, experiment.trialCount)];
}

export function compileRunQueue(
  experiment: ExperimentConfiguration,
  options: CompileRunQueueOptions = {},
): RunQueue {
  const experimentErrors = validateArtifact("experiment.json", experiment);
  if (experimentErrors.length > 0) throw new Error(formatErrors(experimentErrors));

  const ordering = normalizeOrdering(experiment.ordering);
  const resolvedDigests = resolveConfigurationDigests(experiment, options);
  assertResolvedExperimentConfigurationDigests(experiment, resolvedDigests);
  const permutationAlgorithm = resolvePermutationAlgorithm(experiment, options);
  const tasks = resolveFrozenTasks(experiment, options);
  if (options.resolvedPackets !== undefined) {
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
      runId: runId(experiment.id, task, model, harness, cell.trialIndex),
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
    experimentDigest: digestMetadata(experiment),
    captureProfile: experiment.captureProfile,
    seed: experiment.ordering.seed,
    ordering,
    entries,
  };
  assertValidRunQueue(queue, experiment);
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

export function readRunQueue(path: string, experiment?: ExperimentConfiguration): RunQueue {
  const bytes = readFileSync(path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  const queue = JSON.parse(text) as unknown;
  assertValidRunQueue(queue, experiment, path);
  return queue as RunQueue;
}

export function validateRunQueue(
  queue: unknown,
  experiment?: ExperimentConfiguration,
  artifact = "run-queue.json",
): ArtifactValidationError[] {
  const errors = validateArtifact(artifact, queue);
  if (errors.length > 0) return errors;
  if (!isRecord(queue)) return [queueError(artifact, "/", "Run queue must be an object.")];

  const runQueue = queue as unknown as RunQueue;
  const semanticErrors: ArtifactValidationError[] = [];
  const runIds = new Set<string>();
  const cells = new Set<string>();
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
    }
    if (entry.runId !== runId(runQueue.experimentId, entry.task, entry.model, entry.harness, entry.trialIndex)) {
      semanticErrors.push(queueError(artifact, `${field}/runId`, "Run ID does not match its frozen cell identities."));
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
    const expectedOrdering = normalizeOrdering(experiment.ordering);
    if (runQueue.seed !== experiment.ordering.seed || runQueue.ordering.strategy !== expectedOrdering.strategy
        || runQueue.ordering.balanceBy !== expectedOrdering.balanceBy
        || !sameOptionalReference(runQueue.ordering.permutationAlgorithmRef, expectedOrdering.permutationAlgorithmRef)) {
      semanticErrors.push(queueError(artifact, "/ordering", "Run queue ordering does not match the experiment."));
    }
    const expectedCells = new Set(expandMatrixCells(experiment).map(cellKeyOf));
    if (expectedCells.size !== cells.size || [...expectedCells].some((key) => !cells.has(key))) {
      semanticErrors.push(queueError(artifact, "/entries", "Run queue cells do not match the experiment matrix."));
    }
    const expectedOrder = orderCells(expandMatrixCells(experiment), experiment.ordering, "fisher-yates-v1").map(cellKeyOf);
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
): asserts queue is RunQueue {
  const errors = validateRunQueue(queue, experiment, artifact);
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

  public constructor(public readonly queue: RunQueue) {
    assertValidRunQueue(queue);
  }

  public get remaining(): number {
    return this.queue.entries.length - this.position;
  }

  public next(): RunQueueEntry | undefined {
    if (this.position >= this.queue.entries.length) return undefined;
    return this.queue.entries[this.position++];
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

  let definition: unknown = options.permutationAlgorithm;
  if (definition === undefined) definition = options.permutationAlgorithms?.[reference.locator];
  if (definition === undefined && options.bundleRoot !== undefined) {
    const bytes = resolveBundleArtifact(options.bundleRoot, reference);
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
  if (name === "fisher-yates-v1" || name === "fisher-yates") return "fisher-yates-v1";
  throw new Error(`Unsupported permutation algorithm "${String(name)}".`);
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
    const identity = options.bundleRoot !== undefined
      ? frozenTaskFromBundle(options.bundleRoot, taskId, condition.packetRef.locator, condition.packetRef)
      : frozenTaskFromInput(taskId, condition.packetRef, supplied?.[taskId] ?? supplied?.[condition.packetRef.locator]);
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

function frozenTaskFromBundle(
  bundleRoot: string,
  taskId: string,
  packetLocator: string,
  packetRef: ArtifactReference,
): FrozenTaskIdentity {
  const status = statusTaskPacket(bundleRoot, packetLocator);
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

function frozenTaskFromInput(
  taskId: string,
  packetRef: ArtifactReference,
  input: FrozenTaskInput | undefined,
): FrozenTaskIdentity {
  if (input === undefined) {
    throw new Error(`Task packet "${taskId}" has no frozen record.`);
  }
  if ("status" in input && input.status !== undefined && input.status !== "frozen") {
    throw new Error(`Task packet "${taskId}" is ${input.status}, not frozen.`);
  }
  const record = input as Partial<TaskPacketFreezeRecord> & Partial<Omit<FrozenTaskIdentity, "id">>;
  const packetLocator = record.packetLocator ?? record.packetRef?.locator ?? packetRef.locator;
  const packetDigest = record.packetDigest ?? record.packetRef?.digest;
  const packetId = record.packetId;
  const freezeLocator = record.freezeLocator
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
  task: FrozenTaskIdentity,
  model: RunQueueEntry["model"],
  harness: RunQueueEntry["harness"],
  trialIndex: number,
): string {
  return `run-${digestMetadata({ experimentId, task, model, harness, trialIndex }).value}`;
}

function queueError(artifact: string, field: string, message: string): ArtifactValidationError {
  return { artifact, schemaVersion: "ebo.run-queue/v1", field, message };
}

function cellKeyOf(cell: DeclaredMatrixCell): string {
  return `${cell.taskId}\u0000${cell.modelId}\u0000${cell.harnessId}\u0000${cell.trialIndex}`;
}

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return left.locator === right.locator && sameDigest(left.digest, right.digest);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
