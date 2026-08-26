import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

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
  kind: string;
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
  reviewedDigest: Digest | null;
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
  taskSet: TaskConditionSet;
  modelSet: Record<string, { configurationRef: ArtifactReference }>;
  harnessSet: Record<string, {
    configurationRef: ArtifactReference;
    nativeLimitsRef: ArtifactReference;
    nativeToolPolicyRef: ArtifactReference;
  }>;
  trialCount: number;
  coordinatorBudget: { maxWallClockMs: number };
  captureProfile: ArtifactReference;
  ordering:
    | { seed: string; strategy: "declared"; declaredOrder: DeclaredOrder }
    | { seed: string; strategy: "permuted"; permutationAlgorithmRef: ArtifactReference };
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

export function* declaredMatrixCells(
  declaredOrder: DeclaredOrder,
  trialCount: number,
): Generator<DeclaredMatrixCell> {

  for (const taskId of declaredOrder.taskIds) {
    for (const modelId of declaredOrder.modelIds) {
      for (const harnessId of declaredOrder.harnessIds) {
        for (let trialIndex = 1; trialIndex <= trialCount; trialIndex += 1) {
          yield { taskId, modelId, harnessId, trialIndex };
        }
      }
    }
  }

}

export function assertNoSelectedSymlinks(entries: readonly ArchiveEntry[]): void {
  const invalid = entries.find((entry) =>
    !["file", "directory"].includes(entry.kind) || !isSafeArchiveMemberPath(entry.path),
  );

  if (invalid !== undefined) {
    throw new Error(`Selected archive entry "${invalid.path}" is unsafe.`);
  }
}

export function resolveBundleConfiguration(bundleRoot: string, locator: string): string {
  if (!isSafeArchiveMemberPath(locator)) {
    throw new Error(`Configuration locator "${locator}" is unsafe.`);
  }

  const resolvedRoot = realpathSync(bundleRoot);
  let selectedPath = resolvedRoot;

  for (const segment of locator.split("/")) {
    selectedPath = resolve(selectedPath, segment);
    if (!isContained(resolvedRoot, selectedPath) || lstatSync(selectedPath).isSymbolicLink()) {
      throw new Error(`Configuration locator "${locator}" escapes its bundle root.`);
    }
  }

  const resolvedPath = realpathSync(selectedPath);
  if (!isContained(resolvedRoot, resolvedPath)) {
    throw new Error(`Configuration locator "${locator}" escapes its bundle root.`);
  }

  return resolvedPath;
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
  const modelDigests = new Set<string>();
  const harnessCompositions = new Set<string>();
  for (const [modelId, condition] of Object.entries(experiment.modelSet)) {
    const identity = digestIdentity(condition.configurationRef.digest);
    if (modelDigests.has(identity)) throw new Error(`Model "${modelId}" duplicates a configuration digest.`);
    modelDigests.add(identity);
    assertResolvedDigest(`model "${modelId}"`, condition.configurationRef, resolvedDigests);
  }
  for (const [harnessId, condition] of Object.entries(experiment.harnessSet)) {
    const identity = [condition.configurationRef, condition.nativeLimitsRef, condition.nativeToolPolicyRef]
      .map((reference) => digestIdentity(reference.digest)).join("|");
    if (harnessCompositions.has(identity)) throw new Error(`Harness "${harnessId}" duplicates a composition.`);
    harnessCompositions.add(identity);
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

    if (packet.admission.status === "admitted" && (
      packet.reviewedDigest === null
      || packet.reviewedDigest.algorithm !== packet.digest.algorithm
      || packet.reviewedDigest.value !== packet.digest.value
    )) {
      throw new Error(`Task packet "${taskId}" review does not match its digest.`);
    }

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

function digestIdentity(digest: Digest): string {
  return `${digest.algorithm}:${digest.value}`;
}

function isSafeArchiveMemberPath(path: string): boolean {
  return path === posix.normalize(path)
    && /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(path);
}

function isContained(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);

  return pathFromRoot === "" || (
    !isAbsolute(pathFromRoot)
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
  );
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
