export type Digest = {
  algorithm: "sha256";
  value: string;
};

export type ArtifactReference = {
  locator: string;
  digest: Digest;
};

export type ArchiveEntry = {
  path: string;
  kind: "file" | "directory" | "symlink";
};

export type TaskCondition = {
  packetRef: {
    locator: string;
    digest: Digest;
  };
};

export type TaskConditionSet = Record<string, TaskCondition>;

export type ResolvedTaskPacket = {
  digest: Digest;
  admission: {
    status: "proposed" | "admitted" | "rejected";
  };
};

export type DeclaredOrder = {
  taskIds: string[];
  modelIds: string[];
  harnessIds: string[];
};

export type DeclaredMatrixCell = {
  taskId: string;
  modelId: string;
  harnessId: string;
  trialIndex: number;
};

export type ExperimentConfiguration = {
  modelSet: Record<string, { configurationRef: ArtifactReference }>;
  harnessSet: Record<string, {
    configurationRef: ArtifactReference;
    nativeLimitsRef: ArtifactReference;
    nativeToolPolicyRef: ArtifactReference;
  }>;
  captureProfile: ArtifactReference;
  ordering: {
    strategy: "declared" | "permuted";
    permutationAlgorithmRef?: ArtifactReference;
  };
};

export function assertDeclaredOrder(
  conditionSets: {
    taskSet: Record<string, unknown>;
    modelSet: Record<string, unknown>;
    harnessSet: Record<string, unknown>;
  },
  declaredOrder: DeclaredOrder,
): void {
  assertExactIds("task", declaredOrder.taskIds, conditionSets.taskSet);
  assertExactIds("model", declaredOrder.modelIds, conditionSets.modelSet);
  assertExactIds("harness", declaredOrder.harnessIds, conditionSets.harnessSet);
}

export function declaredMatrixCells(
  declaredOrder: DeclaredOrder,
  trialCount: number,
): DeclaredMatrixCell[] {
  const cells: DeclaredMatrixCell[] = [];

  for (const taskId of declaredOrder.taskIds) {
    for (const modelId of declaredOrder.modelIds) {
      for (const harnessId of declaredOrder.harnessIds) {
        for (let trialIndex = 1; trialIndex <= trialCount; trialIndex += 1) {
          cells.push({ taskId, modelId, harnessId, trialIndex });
        }
      }
    }
  }

  return cells;
}

export function assertNoSelectedSymlinks(entries: readonly ArchiveEntry[]): void {
  const link = entries.find((entry) => entry.kind === "symlink");

  if (link !== undefined) {
    throw new Error(`Selected archive entry "${link.path}" is a symlink.`);
  }
}

export function assertControlledPerturbationDigest(
  reference: ArtifactReference,
  resolvedDigest: Digest,
): void {
  if (
    reference.digest.algorithm !== resolvedDigest.algorithm
    || reference.digest.value !== resolvedDigest.value
  ) {
    throw new Error("Controlled perturbation digest does not match its reference.");
  }
}

export function assertResolvedExperimentConfigurationDigests(
  experiment: ExperimentConfiguration,
  resolvedDigests: Record<string, Digest>,
): void {
  for (const [modelId, condition] of Object.entries(experiment.modelSet)) {
    assertResolvedDigest(`model "${modelId}"`, condition.configurationRef, resolvedDigests);
  }
  for (const [harnessId, condition] of Object.entries(experiment.harnessSet)) {
    assertResolvedDigest(`harness "${harnessId}"`, condition.configurationRef, resolvedDigests);
    assertResolvedDigest(`harness limits "${harnessId}"`, condition.nativeLimitsRef, resolvedDigests);
    assertResolvedDigest(`harness tool policy "${harnessId}"`, condition.nativeToolPolicyRef, resolvedDigests);
  }
  assertResolvedDigest("capture profile", experiment.captureProfile, resolvedDigests);

  if (experiment.ordering.strategy === "permuted") {
    if (experiment.ordering.permutationAlgorithmRef === undefined) {
      throw new Error("Permuted experiment is missing its permutation algorithm reference.");
    }
    assertResolvedDigest("permutation algorithm", experiment.ordering.permutationAlgorithmRef, resolvedDigests);
  }
}

export function assertAdmittedTaskPackets(
  taskSet: TaskConditionSet,
  resolvedPackets: Record<string, ResolvedTaskPacket>,
): void {
  const packetDigests = new Set<string>();

  for (const [taskId, condition] of Object.entries(taskSet)) {
    const packetDigest = `${condition.packetRef.digest.algorithm}:${condition.packetRef.digest.value}`;

    if (packetDigests.has(packetDigest)) {
      throw new Error(`Task packet "${taskId}" duplicates a packet digest.`);
    }
    packetDigests.add(packetDigest);

    if (!Object.hasOwn(resolvedPackets, taskId)) {
      throw new Error(`Task packet "${taskId}" did not resolve.`);
    }
    const packet = resolvedPackets[taskId]!;

    if (
      packet.digest.algorithm !== condition.packetRef.digest.algorithm
      || packet.digest.value !== condition.packetRef.digest.value
    ) {
      throw new Error(`Task packet "${taskId}" digest does not match its reference.`);
    }
    if (packet.admission.status !== "admitted") {
      throw new Error(`Task packet "${taskId}" is not admitted.`);
    }
  }
}

function assertResolvedDigest(
  label: string,
  reference: ArtifactReference,
  resolvedDigests: Record<string, Digest>,
): void {
  if (!Object.hasOwn(resolvedDigests, reference.locator)) {
    throw new Error(`${label} did not resolve.`);
  }

  const resolvedDigest = resolvedDigests[reference.locator]!;
  if (
    reference.digest.algorithm !== resolvedDigest.algorithm
    || reference.digest.value !== resolvedDigest.value
  ) {
    throw new Error(`${label} digest does not match its reference.`);
  }
}

function assertExactIds(
  kind: string,
  declaredIds: string[],
  conditions: Record<string, unknown>,
): void {
  const conditionIds = new Set(Object.keys(conditions));
  const declaredIdSet = new Set(declaredIds);

  if (
    declaredIds.length !== conditionIds.size
    || declaredIdSet.size !== conditionIds.size
    || declaredIds.some((id) => !conditionIds.has(id))
  ) {
    throw new Error(`Declared ${kind} IDs must exactly match the condition set.`);
  }
}
