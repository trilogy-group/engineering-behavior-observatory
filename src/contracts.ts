import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import type { TaskPacketFreezeRecord } from "./task-packets.js";

export type Digest = {
  algorithm: "sha256";
  value: string;
};

export type ArtifactReference = {
  locator: string;
  digest: Digest;
};

export type BundleRootHandle = {
  path: string;
  descriptor: number;
};

export type ArchiveEntry = {
  path: string;
  kind: string;
};

export type TaskArchiveEntry = ArchiveEntry & {
  bytes: Buffer;
  mode: number;
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

export const MAX_CONFIGURATION_BYTES = 1_048_576;
const MAX_ARCHIVE_PATH_COMPONENTS = 64;
const MAX_ARCHIVE_PATH_LENGTH = 960;
const TAR_BLOCK_BYTES = 512;
const MAX_TAR_OVERHEAD_PER_MEMBER = 4096;
export type TaskCondition = {
  packetRef: {
    locator: string;
    digest: Digest;
  };
};

export type TaskConditionSet = Record<string, TaskCondition>;

export type ControlledPerturbationDeclaration =
  | { status: "referenced"; digest: Digest }
  | { status: "not-applied" | "unsupported" };

export type ReferenceSolutionDeclaration =
  | { status: "referenced"; digest: Digest }
  | { status: "not-provided" | "unsupported" };

export type ResolvedTaskPacket = {
  /** Packet identity retained by the admission resolver for freeze binding. */
  packetId?: string;
  /** Resolved task-packet component digests retained for freeze binding. */
  promptDigest?: Digest;
  fixtureDigest?: Digest | null;
  digest: Digest;
  preAdmissionDigest: Digest | null;
  reviewRecordDigest: Digest | null;
  resolvedReviewRecordDigest: Digest | null;
  reviewRecordPreAdmissionDigest: Digest | null;
  controlledPerturbation: {
    declaration: ControlledPerturbationDeclaration;
    resolvedDigest: Digest | null;
  };
  referenceSolution: {
    declaration: ReferenceSolutionDeclaration;
    resolvedDigest: Digest | null;
  };
  verifierDigest: Digest;
  resolvedVerifierDigest: Digest;
  admission: {
    status: "proposed" | "admitted" | "rejected";
    reviewedAt: string | null;
  };
  /** Complete freeze evidence admitted alongside this packet resolution. */
  freezeRecord?: TaskPacketFreezeRecord;
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

export type ExperimentOrdering =
  | { seed: string; strategy: "declared"; declaredOrder: DeclaredOrder }
  | { seed: string; strategy: "sequential"; declaredOrder?: DeclaredOrder }
  | {
      seed: string;
      strategy: "permuted" | "seeded-shuffle";
      declaredOrder?: DeclaredOrder;
      permutationAlgorithmRef?: ArtifactReference;
    }
  | {
      seed: string;
      strategy: "balanced" | "balanced-interleaved" | "interleaved";
      declaredOrder?: DeclaredOrder;
      balanceBy?: "task" | "model" | "harness";
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
  ordering: ExperimentOrdering;
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
  assertPositiveSafeInteger(trialCount, "Trial count");

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
  archiveEntries?: readonly ArchiveEntry[],
): void {
  if (archiveEntries === undefined && includePaths.some((includePath) => {
    const canonicalIncludePath = canonicalArchiveMemberPath(includePath);
    return entries.some((entry) => {
      const archivePath = canonicalArchiveMemberPath(entry.path);
      return archivePath.startsWith(`${canonicalIncludePath}/`)
        || (entry.kind === "directory" && archivePath === canonicalIncludePath);
    });
  })) {
    throw new Error("Directory includes require an authoritative archive enumeration.");
  }

  const authoritativeEntries = archiveEntries ?? entries;
  const archiveByPath = new Map<string, string>();
  const destinations = new Map<string, string>();
  const destinationCollisionPaths = new Map<string, string>();
  const directoryPrefixes = new Map<string, string>();

  if (entries.length === 0) {
    throw new Error("No archive entries were selected.");
  }

  for (const archiveEntry of authoritativeEntries) {
    const archivePath = canonicalArchiveMemberPath(archiveEntry.path);

    if (!isSafeArtifactRelativePath(archiveEntry.path)
        || (archiveEntry.kind === "file" && archiveEntry.path.endsWith("/"))
        || archiveByPath.has(archivePath)) {
      throw new Error(`Archive entry "${archiveEntry.path}" is unsafe or collides with another archive member.`);
    }
    archiveByPath.set(archivePath, archiveEntry.kind);
  }

  for (const entry of entries) {
    const destination = canonicalArchiveMemberPath(entry.path);
    const collisionPath = destination.toLowerCase();

    if (!["file", "directory"].includes(entry.kind) || !isSafeArtifactRelativePath(entry.path)
        || (entry.kind === "file" && entry.path.endsWith("/"))) {
      throw new Error(`Selected archive entry "${entry.path}" is unsafe.`);
    }
    if (destinationCollisionPaths.has(collisionPath)) {
      throw new Error(`Selected archive entry "${entry.path}" collides with another selected destination.`);
    }
    if (archiveByPath.get(destination) !== entry.kind) {
      throw new Error(`Selected archive entry "${entry.path}" does not match its archive member kind.`);
    }
    destinations.set(destination, entry.kind);
    destinationCollisionPaths.set(collisionPath, entry.kind);
    assertCaseConsistentDirectoryPrefixes(destination, entry.kind, directoryPrefixes);
  }

  const archivePaths = [...archiveByPath.keys()].sort();
  const includePathSet = new Set<string>();

  for (const includePath of includePaths) {
    const canonicalIncludePath = canonicalArchiveMemberPath(includePath);
    if (!isSafeArtifactRelativePath(includePath) || !hasPathOrDescendant(archivePaths, canonicalIncludePath)) {
      throw new Error(`Archive include path "${includePath}" selected no entries.`);
    }
    includePathSet.add(canonicalIncludePath);
  }

  for (const archivePath of archivePaths) {
    if (isWithinAllowlist(archivePath, includePathSet) && !destinations.has(archivePath)) {
      throw new Error(`Archive include path omitted selected entry "${archivePath}".`);
    }
  }

  for (const path of destinations.keys()) {
    if (!isWithinAllowlist(path, includePathSet)) {
      throw new Error(`Selected archive entry "${path}" is outside the declared allowlist.`);
    }
    if (hasFileAncestor(path.toLowerCase(), destinationCollisionPaths)) {
      throw new Error(`Selected archive entry "${path}" collides with a file destination.`);
    }
  }
}

export function assertArchiveMeasurements(limits: ArchiveLimits, measurements: ArchiveMeasurements): void {
  if (![limits.maxCompressedBytes, limits.maxExpandedBytes, limits.maxMembers]
    .every((value) => Number.isSafeInteger(value) && value >= 1)) {
    throw new Error("Sanitized archive limits must be positive safe integers.");
  }
  if (![measurements.compressedBytes, measurements.expandedBytes, measurements.memberCount]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Sanitized archive measurements must be nonnegative safe integers.");
  }
  if (measurements.compressedBytes > limits.maxCompressedBytes
      || measurements.expandedBytes > limits.maxExpandedBytes
      || measurements.memberCount > limits.maxMembers) {
    throw new Error("Sanitized archive exceeds its declared materialization limits.");
  }
}

export function validateTaskArchive(
  bytes: Uint8Array,
  limits: ArchiveLimits,
  includePaths: readonly string[],
): void {
  readTaskArchive(bytes, limits, includePaths);
}

export function readTaskArchive(
  bytes: Uint8Array,
  limits: ArchiveLimits,
  includePaths: readonly string[],
): TaskArchiveEntry[] {
  if (![limits.maxCompressedBytes, limits.maxExpandedBytes, limits.maxMembers]
    .every((value) => Number.isSafeInteger(value) && value >= 1)) {
    throw new Error("Sanitized archive limits must be positive safe integers.");
  }
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw new Error("Sanitized archive exceeds its declared materialization limits.");
  }

  let archive: Buffer;
  try {
    archive = gunzipSync(Buffer.from(bytes), { maxOutputLength: archiveInspectionLimit(limits) });
  } catch {
    throw new Error("Sanitized task archive is not a valid gzip stream or exceeds the inspection limit.");
  }
  const parsed = parseTarArchive(archive, limits.maxMembers);
  assertArchiveMeasurements(limits, {
    compressedBytes: bytes.byteLength,
    expandedBytes: parsed.expandedBytes,
    memberCount: parsed.entries.length,
  });
  const selected = parsed.entries.filter((entry) => includePaths.some((includePath) => {
    const selectedPath = canonicalArchiveMemberPath(includePath);
    const entryPath = canonicalArchiveMemberPath(entry.path);
    return entryPath === selectedPath || entryPath.startsWith(`${selectedPath}/`);
  }));
  assertNoSelectedSymlinks(selected, includePaths, parsed.entries);
  return selected;
}

export function resolveBundleConfiguration(
  bundleRoot: string,
  reference: ArtifactReference,
  maxBytes = MAX_CONFIGURATION_BYTES,
  rootHandle?: BundleRootHandle,
): Buffer {
  assertPositiveSafeInteger(maxBytes, "Configuration maximum bytes");
  const root = rootHandle ?? openBundleRoot(bundleRoot);
  const ownsRoot = rootHandle === undefined;
  try {
    return readVerifiedBundleFile(
      openBundleRegularFile(bundleRoot, reference.locator, "Configuration locator", root),
      reference,
      "Configuration",
      maxBytes,
      root,
      bundleRoot,
    );
  } finally {
    if (ownsRoot) closeBundleRoot(root);
  }
}

export function resolveTaskArchive(
  bundleRoot: string,
  source: ArtifactReference,
  maxCompressedBytes: number,
  rootHandle?: BundleRootHandle,
): Buffer {
  assertPositiveSafeInteger(maxCompressedBytes, "Task archive maximum compressed bytes");
  const root = rootHandle ?? openBundleRoot(bundleRoot);
  const ownsRoot = rootHandle === undefined;
  try {
    return readVerifiedBundleFile(
      openBundleRegularFile(bundleRoot, source.locator, "Task archive locator", root),
      source,
      "Task archive",
      maxCompressedBytes,
      root,
      bundleRoot,
    );
  } finally {
    if (ownsRoot) closeBundleRoot(root);
  }
}

export function resolveBundleArtifact(
  bundleRoot: string,
  reference: ArtifactReference,
  maxBytes?: number,
  rootHandle?: BundleRootHandle,
): Buffer {
  const root = rootHandle ?? openBundleRoot(bundleRoot);
  const ownsRoot = rootHandle === undefined;
  try {
    return readVerifiedBundleFile(
      openBundleRegularFile(bundleRoot, reference.locator, "Artifact locator", root),
      reference,
      "Artifact",
      maxBytes,
      root,
      bundleRoot,
    );
  } finally {
    if (ownsRoot) closeBundleRoot(root);
  }
}

export function resolveBundleArtifactDigest(
  bundleRoot: string,
  reference: ArtifactReference,
  rootHandle?: BundleRootHandle,
): Digest {
  const root = rootHandle ?? openBundleRoot(bundleRoot);
  const ownsRoot = rootHandle === undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openBundleRegularFile(bundleRoot, reference.locator, "Artifact locator", root);
    const opened = fstatSync(descriptor);
    const openedTimes = fstatSync(descriptor, { bigint: true });
    const size = opened.size;
    if (!opened.isFile() || !isReadableBundleFile(resolve(root.path, reference.locator), opened)
        || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Artifact is not an isolated regular file.");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < size;) {
      const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (read === 0) throw new Error("Artifact changed while its digest was being read.");
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailing, 0, 1, size) !== 0) {
      throw new Error("Artifact changed while its digest was being read.");
    }
    const completed = fstatSync(descriptor);
    const completedTimes = fstatSync(descriptor, { bigint: true });
    if (!completed.isFile() || !isReadableBundleFile(resolve(root.path, reference.locator), completed)
        || completed.dev !== opened.dev || completed.ino !== opened.ino
        || completed.size !== size || completedTimes.mtimeNs !== openedTimes.mtimeNs
        || completedTimes.ctimeNs !== openedTimes.ctimeNs) {
      throw new Error("Artifact changed while its digest was being read.");
    }
    assertBundleRootHandle(root, bundleRoot, reference.locator);
    const current = lstatSync(assertBundlePathWithoutLinks(root.path, reference.locator, "Artifact locator"));
    if (current.dev !== completed.dev || current.ino !== completed.ino) {
      throw new Error("Artifact changed after bundle-root verification.");
    }
    const resolvedDigest: Digest = { algorithm: "sha256", value: hash.digest("hex") };
    if (reference.digest.algorithm !== resolvedDigest.algorithm || reference.digest.value !== resolvedDigest.value) {
      throw new Error("Artifact digest does not match its source reference.");
    }
    return resolvedDigest;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (ownsRoot) closeBundleRoot(root);
  }
}

export function openBundleRoot(bundleRoot: string): BundleRootHandle {
  const path = realpathSync(bundleRoot);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const root = { path, descriptor };
  try {
    assertBundleRootHandle(root, bundleRoot, "bundle root");
    return root;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function closeBundleRoot(root: BundleRootHandle): void {
  closeSync(root.descriptor);
}

function readVerifiedBundleFile(
  descriptor: number,
  reference: ArtifactReference,
  label: string,
  maxBytes?: number,
  root?: BundleRootHandle,
  bundleRoot?: string,
): Buffer {
  try {
    const opened = fstatSync(descriptor);
    const openedTimes = fstatSync(descriptor, { bigint: true });
    const size = opened.size;
    if (!opened.isFile() || !isReadableBundleFile(root === undefined ? undefined : resolve(root.path, reference.locator), opened)
        || !Number.isSafeInteger(size) || size < 0
        || (maxBytes !== undefined && size > maxBytes)) {
      throw new Error(`${label} exceeds its maximum bytes.`);
    }
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read === 0) throw new Error(`${label} changed while it was being read.`);
      offset += read;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailing, 0, 1, size) !== 0) {
      throw new Error(`${label} changed while it was being read.`);
    }
    const completed = fstatSync(descriptor);
    const completedTimes = fstatSync(descriptor, { bigint: true });
    if (!completed.isFile() || !isReadableBundleFile(root === undefined ? undefined : resolve(root.path, reference.locator), completed)
        || completed.dev !== opened.dev || completed.ino !== opened.ino
        || completed.size !== size || completedTimes.mtimeNs !== openedTimes.mtimeNs
        || completedTimes.ctimeNs !== openedTimes.ctimeNs
        || (maxBytes !== undefined && completed.size > maxBytes)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    if (root !== undefined && bundleRoot !== undefined) {
      assertBundleRootHandle(root, bundleRoot, reference.locator);
      const current = lstatSync(assertBundlePathWithoutLinks(root.path, reference.locator, `${label} locator`));
      if (current.dev !== completed.dev || current.ino !== completed.ino) {
        throw new Error(`${label} changed after bundle-root verification.`);
      }
    }
    const resolvedDigest: Digest = {
      algorithm: "sha256",
      value: createHash("sha256").update(bytes).digest("hex"),
    };

    if (reference.digest.algorithm !== resolvedDigest.algorithm || reference.digest.value !== resolvedDigest.value) {
      throw new Error(`${label} digest does not match its source reference.`);
    }

    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function openBundleRegularFile(
  bundleRoot: string,
  locator: string,
  label: string,
  root: BundleRootHandle,
): number {
  if (!isSafeArtifactRelativePath(locator)) {
    throw new Error(`${label} "${locator}" is unsafe.`);
  }

  assertBundleRootHandle(root, bundleRoot, locator);
  let descriptor: number | undefined;
  const originalCwd = process.cwd();
  let changedCwd = false;
  try {
    // Node does not expose openat. Keep the verified root/parent directory as
    // the process cwd while opening each next component with O_NOFOLLOW; once
    // chdir has entered a verified directory, later lookups are inode-relative.
    process.chdir(root.path);
    changedCwd = true;
    if (!sameFileIdentity(fstatSync(root.descriptor), lstatSync("."))) {
      throw new Error(`${label} "${locator}" bundle root changed during verification.`);
    }
    let currentPath = root.path;
    const segments = locator.split("/");
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      let childDescriptor: number;
      try {
        childDescriptor = openSync(segment, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          throw new Error(`${label} "${locator}" escapes its declared root.`);
        }
        throw error;
      }
      try {
        const openedDirectory = fstatSync(childDescriptor);
        const namedDirectory = lstatSync(segment);
        if (!openedDirectory.isDirectory() || namedDirectory.isSymbolicLink()
            || !sameFileIdentity(openedDirectory, namedDirectory)) {
          throw new Error(`${label} "${locator}" crosses a symbolic link.`);
        }
        process.chdir(segment);
        const currentDirectory = lstatSync(".");
        if (!sameFileIdentity(openedDirectory, currentDirectory)) {
          throw new Error(`${label} "${locator}" parent changed during verification.`);
        }
        currentPath = resolve(currentPath, segment);
      } finally {
        closeSync(childDescriptor);
      }
    }
    const leaf = segments[segments.length - 1]!;
    try {
      descriptor = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new Error(`${label} "${locator}" escapes its declared root.`);
      }
      throw error;
    }
    let opened = fstatSync(descriptor);
    const current = lstatSync(leaf);
    if (opened.nlink > 1) {
      removeInterruptedPublicationLink(resolve(currentPath, leaf), opened);
      opened = fstatSync(descriptor);
    }
    if (!opened.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current)
        || !isReadableBundleFile(resolve(currentPath, leaf), opened)) {
      throw new Error(`${label} "${locator}" is not an isolated regular file.`);
    }
    assertBundleRootHandle(root, root.path, locator);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  } finally {
    if (changedCwd) process.chdir(originalCwd);
  }
}

function assertBundleRootHandle(root: BundleRootHandle, bundleRoot: string, locator: string): void {
  let requestedRoot: string;
  try {
    requestedRoot = realpathSync(bundleRoot);
  } catch {
    throw new Error(`Artifact path "${locator}" bundle root changed during verification.`);
  }
  const opened = fstatSync(root.descriptor);
  const current = lstatSync(root.path);
  if (requestedRoot !== root.path || !opened.isDirectory() || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`Artifact path "${locator}" bundle root changed during verification.`);
  }
}

function assertBundlePathWithoutLinks(bundleRoot: string, locator: string, label: string): string {
  let selectedPath = bundleRoot;
  const segments = locator.split("/");

  for (const [index, segment] of segments.entries()) {
    selectedPath = resolve(selectedPath, segment);
    const entry = lstatSync(selectedPath);
    if (!isContained(bundleRoot, selectedPath) || entry.isSymbolicLink()) {
      throw new Error(`${label} "${locator}" escapes its bundle root.`);
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      throw new Error(`${label} "${locator}" is not an isolated regular file.`);
    }
  }

  return selectedPath;
}

function isReadableBundleFile(
  path: string | undefined,
  target: { dev: number; ino: number; nlink: number },
): boolean {
  if (target.nlink !== 1) return false;
  if (path === undefined) return true;
  try {
    const current = lstatSync(path);
    return current.nlink === 1 && current.isFile() && !current.isSymbolicLink() && sameFileIdentity(current, target);
  } catch {
    return false;
  }
}

export function removeInterruptedPublicationLink(path: string, target: { dev: number; ino: number }): void {
  for (const name of readdirSync(dirname(path))) {
    if (!/^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(name)) continue;
    const temporaryPath = resolve(dirname(path), name);
    if (temporaryPath === path) continue;
    try {
      const candidate = lstatSync(temporaryPath);
      if (candidate.isFile() && sameFileIdentity(candidate, target)) unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  const references: ArtifactReference[] = [];
  for (const [modelId, condition] of Object.entries(experiment.modelSet)) {
    const identity = digestIdentity(condition.configurationRef.digest);
    if (modelDigests.has(identity)) throw new Error(`Model "${modelId}" duplicates a configuration digest.`);
    modelDigests.add(identity);
    references.push(condition.configurationRef);
    assertResolvedDigest(`model "${modelId}"`, condition.configurationRef, resolvedDigests);
  }
  for (const [harnessId, condition] of Object.entries(experiment.harnessSet)) {
    const identity = [condition.configurationRef, condition.nativeLimitsRef, condition.nativeToolPolicyRef]
      .map((reference) => digestIdentity(reference.digest)).join("|");
    if (harnessCompositions.has(identity)) throw new Error(`Harness "${harnessId}" duplicates a composition.`);
    harnessCompositions.add(identity);
    references.push(condition.configurationRef, condition.nativeLimitsRef, condition.nativeToolPolicyRef);
    assertResolvedDigest(`harness "${harnessId}"`, condition.configurationRef, resolvedDigests);
    assertResolvedDigest(`harness limits "${harnessId}"`, condition.nativeLimitsRef, resolvedDigests);
    assertResolvedDigest(`harness tool policy "${harnessId}"`, condition.nativeToolPolicyRef, resolvedDigests);
  }
  references.push(experiment.captureProfile);
  assertResolvedDigest("capture profile", experiment.captureProfile, resolvedDigests);

  if (experiment.ordering.strategy === "permuted" && experiment.ordering.permutationAlgorithmRef === undefined) {
    throw new Error("Permuted experiment is missing its permutation algorithm reference.");
  }
  if ("permutationAlgorithmRef" in experiment.ordering
      && experiment.ordering.permutationAlgorithmRef !== undefined) {
    references.push(experiment.ordering.permutationAlgorithmRef);
    assertResolvedDigest("permutation algorithm", experiment.ordering.permutationAlgorithmRef, resolvedDigests);
  }
  references.push(...Object.values(experiment.taskSet).map((condition) => condition.packetRef));
  assertDistinctBundleLocators(references);
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
    if (packet.controlledPerturbation.declaration.status === "referenced") {
      assertEqualDigests(
        `Task packet "${taskId}" controlled perturbation`,
        packet.controlledPerturbation.declaration.digest,
        packet.controlledPerturbation.resolvedDigest,
      );
    } else if (packet.controlledPerturbation.resolvedDigest !== null) {
      throw new Error(`Task packet "${taskId}" has resolved an unavailable controlled perturbation.`);
    }
    if (packet.referenceSolution.declaration.status === "referenced") {
      assertEqualDigests(
        `Task packet "${taskId}" reference solution`,
        packet.referenceSolution.declaration.digest,
        packet.referenceSolution.resolvedDigest,
      );
    } else if (packet.referenceSolution.resolvedDigest !== null) {
      throw new Error(`Task packet "${taskId}" has resolved an unavailable reference solution.`);
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

function assertDistinctBundleLocators(references: readonly ArtifactReference[]): void {
  const locators = new Map<string, string>();
  const descendantPrefixes = new Set<string>();

  for (const reference of references) {
    const locator = reference.locator.toLowerCase();
    const existing = locators.get(locator);
    if (existing !== undefined && existing !== reference.locator) {
      throw new Error(`Bundle locator "${reference.locator}" case-aliases "${existing}".`);
    }
    if (existing !== undefined) continue;
    if (descendantPrefixes.has(locator)) {
      throw new Error(`Bundle locator "${reference.locator}" aliases a descendant reference.`);
    }
    for (let boundary = locator.lastIndexOf("/"); boundary > 0; boundary = locator.lastIndexOf("/", boundary - 1)) {
      if (locators.has(locator.slice(0, boundary))) {
        throw new Error(`Bundle locator "${reference.locator}" aliases an ancestor reference.`);
      }
      descendantPrefixes.add(locator.slice(0, boundary));
    }
    locators.set(locator, reference.locator);
  }
}

function digestIdentity(digest: Digest): string {
  return `${digest.algorithm}:${digest.value}`;
}

export function isSafeArtifactRelativePath(path: string): boolean {
  const segments = path.split("/");

  return path === posix.normalize(path)
    && path.length <= MAX_ARCHIVE_PATH_LENGTH
    && /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-][A-Za-z0-9._\/-]*$/.test(path)
    && segments.length <= MAX_ARCHIVE_PATH_COMPONENTS
    && !segments.some((segment) => segment.length > 255 || segment.endsWith(".") || segment.toLowerCase() === ".git"
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment));
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function parseTarArchive(bytes: Buffer, maxMembers: number): { entries: TaskArchiveEntry[]; expandedBytes: number } {
  const entries: TaskArchiveEntry[] = [];
  let expandedBytes = 0;
  let offset = 0;
  let pendingPath: string | undefined;
  let pendingPax: { path?: string; size?: number } | undefined;

  while (offset + TAR_BLOCK_BYTES <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((value) => value === 0)) {
      if (bytes.subarray(offset).every((value) => value === 0)) return { entries, expandedBytes };
      throw new Error("Sanitized task archive has nonzero data after its end marker.");
    }
    verifyTarHeaderChecksum(header);
    const headerSize = parseTarOctal(header.subarray(124, 136), "size");
    const dataOffset = offset + TAR_BLOCK_BYTES;
    const paddedSize = headerSize + ((TAR_BLOCK_BYTES - (headerSize % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
    if (!Number.isSafeInteger(paddedSize) || dataOffset + paddedSize > bytes.length) {
      throw new Error("Sanitized task archive contains a truncated member.");
    }
    const data = bytes.subarray(dataOffset, dataOffset + headerSize);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "L") {
      pendingPath = readTarText(data);
      offset = dataOffset + paddedSize;
      continue;
    }
    if (type === "K") {
      offset = dataOffset + paddedSize;
      continue;
    }
    if (type === "x") {
      pendingPax = parsePaxAttributes(data);
      offset = dataOffset + paddedSize;
      continue;
    }
    if (type === "X") {
      throw new Error("Sanitized task archive contains an unsupported uppercase local PAX header.");
    }
    if (type === "g") {
      throw new Error("Sanitized task archive contains an unsupported global PAX header.");
    }

    const rawName = readTarText(header.subarray(0, 100));
    const prefix = readTarText(header.subarray(345, 500));
    const magic = readTarText(header.subarray(257, 263));
    const version = readTarText(header.subarray(263, 265));
    if (magic !== "" && magic !== "ustar" && magic !== "ustar ") {
      throw new Error("Sanitized task archive contains an unsupported TAR header format.");
    }
    if (prefix !== "" && !(magic === "ustar" && version === "00")) {
      throw new Error("Sanitized task archive contains a TAR prefix without USTAR magic.");
    }
    const headerPath = prefix === "" ? rawName : `${prefix}/${rawName}`;
    const path = pendingPax?.path ?? pendingPath ?? headerPath;
    if (pendingPax?.size !== undefined && pendingPax.size !== headerSize) {
      throw new Error("Sanitized task archive PAX size does not match TAR member framing.");
    }
    const size = pendingPax?.size ?? headerSize;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Sanitized task archive contains an invalid member size.");
    const kind = tarEntryKind(type);
    entries.push({ path, kind, bytes: data, mode: parseTarMode(header.subarray(100, 108)) });
    if (entries.length > maxMembers) throw new Error("Sanitized archive exceeds its declared materialization limits.");
    if (kind === "file") {
      if (!Number.isSafeInteger(expandedBytes + size)) throw new Error("Sanitized task archive exceeds safe expanded size.");
      expandedBytes += size;
    }
    pendingPath = undefined;
    pendingPax = undefined;
    offset = dataOffset + paddedSize;
  }
  throw new Error("Sanitized task archive is not a complete TAR stream.");
}

function archiveInspectionLimit(limits: ArchiveLimits): number {
  const overhead = MAX_TAR_OVERHEAD_PER_MEMBER * (limits.maxMembers + 2);
  const limit = limits.maxExpandedBytes + overhead;
  if (!Number.isSafeInteger(limit)) throw new Error("Sanitized archive inspection limit is not a safe integer.");
  return limit;
}

function verifyTarHeaderChecksum(header: Buffer): void {
  const expected = parseTarOctal(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) throw new Error("Sanitized task archive contains an invalid TAR header checksum.");
}

function parseTarOctal(field: Uint8Array, label: string): number {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(field).replace(/\0.*$/s, "");
  const text = raw.replace(/^ +| +$/g, "");
  if (text === "" || !/^[0-7]+$/.test(text)) throw new Error(`Sanitized task archive contains an invalid TAR ${label}.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`Sanitized task archive contains an unsafe TAR ${label}.`);
  return value;
}

function parseTarMode(field: Uint8Array): number {
  const raw = new TextDecoder("ascii", { fatal: true }).decode(field).replace(/\0.*$/s, "");
  const text = raw.replace(/^ +| +$/g, "");
  if (text === "") return 0o644;
  if (!/^[0-7]+$/.test(text)) throw new Error("Sanitized task archive contains an invalid TAR mode.");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Sanitized task archive contains an unsafe TAR mode.");
  return value;
}

function readTarText(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end < 0 ? bytes.length : end));
}

function parsePaxAttributes(bytes: Uint8Array): { path?: string; size?: number } {
  const attributes: { path?: string; size?: number } = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(0x20, offset);
    if (space <= offset) throw new Error("Sanitized task archive contains an invalid PAX header.");
    const lengthText = new TextDecoder("ascii", { fatal: true }).decode(bytes.subarray(offset, space));
    if (!/^[0-9]+$/.test(lengthText)) throw new Error("Sanitized task archive contains an invalid PAX record length.");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > bytes.length) {
      throw new Error("Sanitized task archive contains an invalid PAX record length.");
    }
    const record = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(space + 1, offset + length));
    const equals = record.indexOf("=");
    if (equals <= 0 || !record.endsWith("\n")) throw new Error("Sanitized task archive contains an invalid PAX record.");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1, -1);
    if (/^(?:GNU\.sparse(?:\.|$)|SCHILY\.(?:sparse(?:\.|$)|realsize$)|SUN\.holesdata$)/.test(key)) {
      throw new Error("Sanitized task archive contains unsupported sparse PAX metadata.");
    }
    if (key === "path") attributes.path = value;
    if (key === "size") {
      if (!/^[0-9]+$/.test(value)) throw new Error("Sanitized task archive contains an invalid PAX size.");
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("Sanitized task archive contains an invalid PAX size.");
      attributes.size = size;
    }
    offset += length;
  }
  return attributes;
}

function tarEntryKind(type: string): string {
  switch (type) {
    case "\0":
    case "0":
      return "file";
    case "5":
      return "directory";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "3":
      return "character-device";
    case "4":
      return "block-device";
    case "6":
      return "fifo";
    case "7":
      return "contiguous-file";
    default:
      return "special";
  }
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

function assertCaseConsistentDirectoryPrefixes(path: string, kind: string, prefixes: Map<string, string>): void {
  const segments = path.split("/");
  const directoryCount = kind === "directory" ? segments.length : segments.length - 1;
  let prefix = "";

  for (let index = 0; index < directoryCount; index += 1) {
    prefix = index === 0 ? segments[index]! : `${prefix}/${segments[index]!}`;
    const key = prefix.toLowerCase();
    const existing = prefixes.get(key);
    if (existing !== undefined && existing !== prefix) {
      throw new Error(`Selected archive entry "${path}" has a case-inconsistent ancestor.`);
    }
    prefixes.set(key, prefix);
  }
}

function hasPathOrDescendant(paths: readonly string[], path: string): boolean {
  const exact = lowerBound(paths, path);
  const descendant = lowerBound(paths, `${path}/`);

  return paths[exact] === path || paths[descendant]?.startsWith(`${path}/`) === true;
}

function lowerBound(paths: readonly string[], path: string): number {
  let low = 0;
  let high = paths.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (paths[middle]! < path) low = middle + 1;
    else high = middle;
  }

  return low;
}

function assertRfc3339Timestamp(value: string | null): void {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/);

  if (match === null || match === undefined) {
    throw new Error("Admitted task packet review must have an RFC 3339 timestamp.");
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetSign, offsetHourText, offsetMinuteText] = match;
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
      || hour > 23 || minute > 59 || second > 60 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error("Admitted task packet review must have an RFC 3339 timestamp.");
  }
  if (second === 60) {
    const offsetMinutes = offsetSign === undefined ? 0
      : (offsetSign === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
    const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, 59) - offsetMinutes * 60_000);
    const utcDate = `${instant.getUTCFullYear()}-${String(instant.getUTCMonth() + 1).padStart(2, "0")}-${String(instant.getUTCDate()).padStart(2, "0")}`;

    if (instant.getUTCHours() !== 23 || instant.getUTCMinutes() !== 59 || !KNOWN_LEAP_SECOND_DATES.has(utcDate)) {
      throw new Error("Admitted task packet review must have an RFC 3339 timestamp.");
    }
  }
}

// Update when IERS announces a future UTC leap second.
const KNOWN_LEAP_SECOND_DATES = new Set([
  "1972-06-30", "1972-12-31", "1973-12-31", "1974-12-31", "1975-12-31", "1976-12-31", "1977-12-31",
  "1978-12-31", "1979-12-31", "1981-06-30", "1982-06-30", "1983-06-30", "1985-06-30", "1987-12-31",
  "1989-12-31", "1990-12-31", "1992-06-30", "1993-06-30", "1994-06-30", "1995-12-31", "1997-06-30",
  "1998-12-31", "2005-12-31", "2008-12-31", "2012-06-30", "2015-06-30", "2016-12-31",
]);

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
