import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
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

export type ArchiveLimits = {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxMembers: number;
};

export type ArchiveMeasurements = {
  compressedBytes: number;
  expandedBytes: number;
  memberCount: number;
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
  preAdmissionDigest: Digest | null;
  reviewRecordDigest: Digest | null;
  resolvedReviewRecordDigest: Digest | null;
  reviewRecordPreAdmissionDigest: Digest | null;
  referenceSolutionDigest: Digest | null;
  resolvedReferenceSolutionDigest: Digest | null;
  verifierDigest: Digest;
  resolvedVerifierDigest: Digest;
  admission: {
    status: "proposed" | "admitted" | "rejected";
    reviewedAt: string | null;
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
  schemaVersion: "ebo.experiment/v1";
  id: string;
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

export function assertNoSelectedSymlinks(
  entries: readonly ArchiveEntry[],
  includePaths: readonly string[],
  archiveEntries: readonly ArchiveEntry[],
): void {
  const archiveByPath = new Map<string, string>();
  const destinations = new Map<string, string>();

  if (entries.length === 0) {
    throw new Error("No archive entries were selected.");
  }

  for (const archiveEntry of archiveEntries) {
    const archivePath = canonicalArchiveMemberPath(archiveEntry.path).toLowerCase();

    if (!isSafeArchiveMemberPath(archiveEntry.path) || archiveByPath.has(archivePath)) {
      throw new Error(`Archive entry "${archiveEntry.path}" is unsafe or collides with another archive member.`);
    }
    archiveByPath.set(archivePath, archiveEntry.kind);
  }

  for (const entry of entries) {
    const destination = canonicalArchiveMemberPath(entry.path).toLowerCase();

    if (!["file", "directory"].includes(entry.kind) || !isSafeArchiveMemberPath(entry.path)
        || (entry.kind === "file" && entry.path.endsWith("/"))) {
      throw new Error(`Selected archive entry "${entry.path}" is unsafe.`);
    }
    if (destinations.has(destination)) {
      throw new Error(`Selected archive entry "${entry.path}" collides with another selected destination.`);
    }
    if (archiveByPath.get(destination) !== entry.kind) {
      throw new Error(`Selected archive entry "${entry.path}" does not match its archive member kind.`);
    }
    destinations.set(destination, entry.kind);
  }

  const archivePaths = [...archiveByPath.keys()].sort();
  const includePathSet = new Set<string>();

  for (const includePath of includePaths) {
    const canonicalIncludePath = canonicalArchiveMemberPath(includePath).toLowerCase();
    if (!isSafeArchiveMemberPath(includePath) || !hasPathOrDescendant(archivePaths, canonicalIncludePath)) {
      throw new Error(`Archive include path "${includePath}" selected no entries.`);
    }
    includePathSet.add(canonicalIncludePath);
  }

  for (const archivePath of archivePaths) {
    if (isWithinAllowlist(archivePath, includePathSet) && !destinations.has(archivePath)) {
      throw new Error(`Archive include path omitted selected entry "${archivePath}".`);
    }
  }

  for (const [path, kind] of destinations) {
    if (!isWithinAllowlist(path, includePathSet)) {
      throw new Error(`Selected archive entry "${path}" is outside the declared allowlist.`);
    }
    if (hasFileAncestor(path, destinations)) {
      throw new Error(`Selected archive entry "${path}" collides with a file destination.`);
    }
  }
}

export function assertArchiveMeasurements(limits: ArchiveLimits, measurements: ArchiveMeasurements): void {
  if (measurements.compressedBytes > limits.maxCompressedBytes
      || measurements.expandedBytes > limits.maxExpandedBytes
      || measurements.memberCount > limits.maxMembers) {
    throw new Error("Sanitized archive exceeds its declared materialization limits.");
  }
}

export function resolveBundleConfiguration(bundleRoot: string, locator: string): string {
  return resolveBundleRegularFile(bundleRoot, locator, "Configuration locator");
}

export function resolveTaskArchive(bundleRoot: string, source: ArtifactReference): string {
  const archivePath = resolveBundleRegularFile(bundleRoot, source.locator, "Task archive locator");
  const resolvedDigest: Digest = {
    algorithm: "sha256",
    value: createHash("sha256").update(readFileSync(archivePath)).digest("hex"),
  };

  if (source.digest.algorithm !== resolvedDigest.algorithm || source.digest.value !== resolvedDigest.value) {
    throw new Error("Task archive digest does not match its source reference.");
  }

  return archivePath;
}

function resolveBundleRegularFile(bundleRoot: string, locator: string, label: string): string {
  if (!isSafeArchiveMemberPath(locator)) {
    throw new Error(`${label} "${locator}" is unsafe.`);
  }

  const resolvedRoot = realpathSync(bundleRoot);
  let selectedPath = resolvedRoot;

  const segments = locator.split("/");
  for (const [index, segment] of segments.entries()) {
    selectedPath = resolve(selectedPath, segment);
    const entry = lstatSync(selectedPath);
    if (!isContained(resolvedRoot, selectedPath) || entry.isSymbolicLink()) {
      throw new Error(`${label} "${locator}" escapes its bundle root.`);
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      throw new Error(`${label} "${locator}" is not a regular file.`);
    }
  }

  const resolvedPath = realpathSync(selectedPath);
  if (!isContained(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} "${locator}" escapes its bundle root.`);
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
      packet.preAdmissionDigest === null
    )) {
      throw new Error(`Task packet "${taskId}" review is missing its pre-admission digest.`);
    }
    if (packet.admission.status === "admitted") {
      assertRfc3339Timestamp(packet.admission.reviewedAt);
      assertEqualDigests(`Task packet "${taskId}" review record`, packet.reviewRecordDigest, packet.resolvedReviewRecordDigest);
      assertEqualDigests(
        `Task packet "${taskId}" reviewed pre-admission packet`,
        packet.preAdmissionDigest,
        packet.reviewRecordPreAdmissionDigest,
      );
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
    if (
      packet.verifierDigest.algorithm !== packet.resolvedVerifierDigest.algorithm
      || packet.verifierDigest.value !== packet.resolvedVerifierDigest.value
    ) {
      throw new Error(`Task packet "${taskId}" verifier digest does not match its resolved bytes.`);
    }
    if (packet.referenceSolutionDigest !== null || packet.resolvedReferenceSolutionDigest !== null) {
      assertEqualDigests(
        `Task packet "${taskId}" reference solution`,
        packet.referenceSolutionDigest,
        packet.resolvedReferenceSolutionDigest,
      );
    }
  }
}

function assertEqualDigests(label: string, expected: Digest | null, resolved: Digest | null): void {
  if (expected === null || resolved === null
      || expected.algorithm !== resolved.algorithm || expected.value !== resolved.value) {
    throw new Error(`${label} digest does not match its resolved bytes.`);
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
    && /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9.][A-Za-z0-9._\/-]*$/.test(path);
}

function canonicalArchiveMemberPath(path: string): string {
  return posix.normalize(path).replace(/\/+$/, "");
}

function isWithinAllowlist(path: string, includePaths: ReadonlySet<string>): boolean {
  for (let boundary = path.length; boundary >= 0; boundary = path.lastIndexOf("/", boundary - 1)) {
    if (includePaths.has(path.slice(0, boundary))) return true;
    if (boundary === 0) return false;
  }

  return false;
}

function hasFileAncestor(path: string, destinations: ReadonlyMap<string, string>): boolean {
  for (let boundary = path.lastIndexOf("/"); boundary > 0; boundary = path.lastIndexOf("/", boundary - 1)) {
    if (destinations.get(path.slice(0, boundary)) === "file") return true;
  }

  return false;
}

function hasPathOrDescendant(paths: readonly string[], path: string): boolean {
  let low = 0;
  let high = paths.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (paths[middle]! < path) low = middle + 1;
    else high = middle;
  }

  const candidate = paths[low];
  return candidate === path || candidate?.startsWith(`${path}/`) === true;
}

function assertRfc3339Timestamp(value: string | null): void {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/);

  if (match === null || match === undefined) {
    throw new Error("Admitted task packet review must have an RFC 3339 timestamp.");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error("Admitted task packet review must have an RFC 3339 timestamp.");
  }
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
