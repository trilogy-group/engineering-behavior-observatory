import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { digestBytes, digestMetadata, writeMetadataAtomically } from "../artifacts.js";
import type { AssessmentMode, Digest } from "../contracts.js";
import { createHarborAdapter, HarborAdapterError, HARBOR_PACKAGE_PIN, type HarborAdapter, type HarborIdentity, type HarborInstruction, type HarborTaskLockJson } from "./adapter.js";

/** EBO execution-profile restriction: links are rejected during Harbor ingestion. */
export const HARBOR_PATH_POLICY_VERSION = "ebo.harbor-path-policy/v2";
export const HARBOR_SNAPSHOT_MANIFEST_SCHEMA_VERSION = "ebo.harbor-snapshot-manifest/v1";
export const MAX_HARBOR_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_HARBOR_SNAPSHOT_FILES = 20_000;
export const MAX_HARBOR_PATH_LENGTH = 2048;
const MAX_HARBOR_SEGMENT_LENGTH = 255;

export type HarborEnvironmentProfile = {
  os: string;
  dockerImage: string | null;
  cpus: number | null;
  memoryMb: number | null;
  gpus: number | null;
  tpu: boolean;
  networkMode: string;
  allowInternet: boolean | null;
  mcpServerCount: number;
  composeServices: string[] | null;
  buildTimeoutSec: number;
  workdir: string | null;
};

export type HarborStepSummary = {
  name: string;
  minReward: number | Record<string, number> | null;
  verifierTimeoutSec: number;
  agentTimeoutSec: number | null;
};

export type HarborVerifierProfile = {
  timeoutSec: number;
  environmentMode: string | null;
  collectCount: number;
  hasSharedSteps?: boolean;
};

export type HarborTaskSummary = {
  name: string;
  shortName: string;
  version: string | null;
  schemaVersion: string;
  hasSteps: boolean;
  steps: HarborStepSummary[];
  metadataKeys: string[];
  environment: HarborEnvironmentProfile;
  verifier: HarborVerifierProfile;
  hasSolution: boolean;
  hasTests: boolean;
  multiStepRewardStrategy: "mean" | "final" | null;
};

export type HarborUnsupportedReasonCode =
  | "unsupported-windows-os"
  | "unsupported-gpu"
  | "unsupported-tpu"
  | "unsupported-mcp-services"
  | "unsupported-compose-sidecars"
  | "unsupported-shared-multistep-verifier";

export type HarborTaskInspection = {
  classification: "valid" | "invalid" | "unsupported";
  reasonCode: string | null;
  reason: string | null;
  unsupported: HarborUnsupportedReasonCode[];
  summary: HarborTaskSummary | null;
  identity: HarborIdentity | null;
  instructions: HarborInstruction[] | null;
  taskLock: HarborTaskLockJson | null;
  harborPackageVersion: string;
};

export type HarborResolvedInstruction = {
  step: string | null;
  instruction: string;
  digest: Digest;
};

export type HarborTaskResolution = {
  sourceKind: "harbor-task";
  /** EBO-safe internal identifier derived from the Harbor content digest. */
  taskSourceId: string;
  /** Official Harbor TaskLock digest, `sha256:<hex>`. */
  harborDigest: string;
  harborName: string;
  harborVersion: string | null;
  harborType: HarborTaskLockJson["type"];
  taskSchemaVersion: string;
  harborPackageVersion: string;
  assessmentMode: AssessmentMode;
  steps: HarborStepSummary[];
  environment: HarborEnvironmentProfile;
  verifier: HarborVerifierProfile;
  multiStepRewardStrategy: "mean" | "final" | null;
  instructions: HarborResolvedInstruction[];
  packaging: HarborIdentity;
  /** Digest over the resolution content excluding absolute paths; stable under relocation. */
  resolutionDigest: Digest;
};

export type HarborSnapshotManifest = {
  schemaVersion: typeof HARBOR_SNAPSHOT_MANIFEST_SCHEMA_VERSION;
  taskSourceId: string;
  harborDigest: string;
  harborName: string;
  harborVersion: string | null;
  harborType: HarborTaskLockJson["type"];
  taskSchemaVersion: string;
  harborPackageVersion: string;
  pathPolicy: typeof HARBOR_PATH_POLICY_VERSION;
  snapshotLocator: string;
  sourceLocator: string | null;
  copyDigest: Digest;
  packaging: { includedFiles: string[]; excludedFiles: string[] };
  assessmentMode: AssessmentMode;
};

export type HarborSnapshot = {
  manifest: HarborSnapshotManifest;
  taskDirectory: string;
};

export type InspectHarborTaskOptions = {
  assessmentMode?: AssessmentMode;
  adapter?: HarborAdapter;
  extraInstructions?: readonly string[];
};

/**
 * Path policy v2 for Harbor task trees. Broader than the v1 archive policy
 * because ordinary Harbor filenames may contain spaces and punctuation, but
 * still rejects traversal, separators, control characters, and Windows
 * reserved device names before any materialization.
 */
export function isSafeHarborRelativePath(path: string): boolean {
  if (path === "" || path.length > MAX_HARBOR_PATH_LENGTH || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (segment.length > MAX_HARBOR_SEGMENT_LENGTH) return false;
    if (segment.endsWith(".") || segment.endsWith(" ")) return false;
    if (segment.toLowerCase() === ".git") return false;
    if (/[\u0000-\u001f\u007f]/.test(segment)) return false;
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) return false;
  }
  return true;
}

export function harborTaskSourceId(harborDigest: string): string {
  const hex = harborDigest.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Harbor digest "${harborDigest}" is malformed.`);
  return `harbor-${hex.slice(0, 16)}`;
}

export function toDigest(prefixed: string): Digest {
  const hex = prefixed.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Harbor digest "${prefixed}" is malformed.`);
  return { algorithm: "sha256", value: hex };
}

export function toPrefixedDigest(digest: Digest): string {
  if (digest.algorithm !== "sha256") throw new Error(`Unsupported digest algorithm "${digest.algorithm}".`);
  return `sha256:${digest.value}`;
}

/**
 * Inspect one Harbor task directory through the pinned official package and
 * classify it as valid, invalid, or valid-but-unsupported for EBO's initial
 * execution profile. Distinct machine-readable reason codes preserve the
 * difference between a schema-invalid task and a supported-schema task whose
 * capabilities exceed the profile (MIGRATION_SPEC.md §7).
 */
export async function inspectHarborTask(taskDir: string, options: InspectHarborTaskOptions = {}): Promise<HarborTaskInspection> {
  const adapter = options.adapter ?? await createHarborAdapter();
  const assessmentMode: AssessmentMode = options.assessmentMode ?? "observational";
  const disableVerification = assessmentMode === "observational";
  const unsupported: HarborUnsupportedReasonCode[] = [];

  let summary: HarborTaskSummary;
  try {
    summary = await inspectSummary(adapter, taskDir, disableVerification);
  } catch (error) {
    if (error instanceof HarborAdapterError && error.kind === "task-invalid") {
      return {
        classification: "invalid",
        reasonCode: "task-invalid",
        reason: error.message,
        unsupported: [],
        summary: null,
        identity: null,
        instructions: null,
        taskLock: null,
        harborPackageVersion: HARBOR_PACKAGE_PIN,
      };
    }
    throw error;
  }

  if (summary.environment.os === "windows") unsupported.push("unsupported-windows-os");
  if ((summary.environment.gpus ?? 0) > 0) unsupported.push("unsupported-gpu");
  if (summary.environment.tpu) unsupported.push("unsupported-tpu");
  if (summary.environment.mcpServerCount > 0) unsupported.push("unsupported-mcp-services");
  if (summary.environment.composeServices !== null && summary.environment.composeServices.length > 1) {
    unsupported.push("unsupported-compose-sidecars");
  }
  if (assessmentMode === "verified" && summary.hasSteps && summary.verifier.hasSharedSteps !== false) {
    unsupported.push("unsupported-shared-multistep-verifier");
  }

  if (assessmentMode === "verified" && !summary.hasTests && !summary.hasSteps) {
    return {
      classification: "invalid",
      reasonCode: "verifier-missing-tests",
      reason: "Verified assessment requires the task's verifier surface; the official Task validation rejects this task when verification is enabled.",
      unsupported,
      summary,
      identity: null,
      instructions: null,
      taskLock: null,
      harborPackageVersion: HARBOR_PACKAGE_PIN,
    };
  }

  if (unsupported.length > 0) {
    return {
      classification: "unsupported",
      reasonCode: unsupported[0]!,
      reason: describeUnsupported(unsupported),
      unsupported,
      summary,
      identity: null,
      instructions: null,
      taskLock: null,
      harborPackageVersion: HARBOR_PACKAGE_PIN,
    };
  }

  const [identity, instructions, lock] = await Promise.all([
    adapter.identity(taskDir),
    adapter.instructions(taskDir, { disableVerification, extraInstructions: options.extraInstructions }),
    adapter.lock(taskDir),
  ]);

  return {
    classification: "valid",
    reasonCode: null,
    reason: null,
    unsupported: [],
    summary,
    identity,
    instructions,
    taskLock: lock.taskLock,
    harborPackageVersion: HARBOR_PACKAGE_PIN,
  };
}

/** Resolve a valid Harbor task into the typed, relocation-stable resolution EBO admits and freezes. */
export async function resolveHarborTask(taskDir: string, options: InspectHarborTaskOptions = {}): Promise<HarborTaskResolution> {
  const inspection = await inspectHarborTask(taskDir, options);
  if (inspection.classification !== "valid" || inspection.summary === null || inspection.identity === null
      || inspection.instructions === null || inspection.taskLock === null) {
    throw new HarborAdapterError(
      inspection.classification === "unsupported" ? inspection.reasonCode ?? "unsupported" : inspection.reasonCode ?? "task-invalid",
      inspection.reason ?? "Harbor task could not be resolved.",
    );
  }
  const assessmentMode: AssessmentMode = options.assessmentMode ?? "observational";
  const resolved: HarborTaskResolution = {
    sourceKind: "harbor-task",
    taskSourceId: harborTaskSourceId(inspection.identity.digest),
    harborDigest: inspection.identity.digest.startsWith("sha256:") ? inspection.identity.digest : `sha256:${inspection.identity.digest}`,
    harborName: inspection.taskLock.name,
    harborVersion: inspection.taskLock.version,
    harborType: inspection.taskLock.type,
    taskSchemaVersion: inspection.summary.schemaVersion,
    harborPackageVersion: inspection.harborPackageVersion,
    assessmentMode,
    steps: inspection.summary.steps,
    environment: inspection.summary.environment,
    verifier: inspection.summary.verifier,
    multiStepRewardStrategy: inspection.summary.multiStepRewardStrategy,
    instructions: inspection.instructions.map((entry) => ({
      step: entry.step,
      instruction: entry.instruction,
      digest: { algorithm: "sha256", value: entry.sha256 },
    })),
    packaging: inspection.identity,
    resolutionDigest: { algorithm: "sha256", value: "" },
  };
  resolved.resolutionDigest = digestMetadata(resolutionContent(resolved));
  return resolved;
}

/**
 * Snapshot an inspected Harbor task tree into `<snapshotsRoot>/<taskSourceId>`
 * and record the packaging manifest beside it. The snapshot is an ordinary,
 * unmodified Harbor task directory: an ordinary Harbor installation can use
 * it directly, and the identity recomputed from the snapshot must equal the
 * admitted identity (A03/A05).
 */
export async function snapshotHarborTask(
  taskDir: string,
  snapshotsRoot: string,
  options: InspectHarborTaskOptions & { sourceLocator?: string } = {},
): Promise<HarborSnapshot> {
  const resolution = await resolveHarborTask(taskDir, options);
  const manifestLocator = `${resolution.taskSourceId}.snapshot-manifest.json`;
  const snapshotRoot = join(resolve(snapshotsRoot), resolution.taskSourceId);
  const manifestPath = join(resolve(snapshotsRoot), manifestLocator);
  if (resolve(snapshotsRoot) === snapshotRoot) throw new Error("Snapshot destination collides with the snapshots root.");

  if (directoryExists(snapshotRoot) || fileExists(manifestPath)) {
    const retained = await verifyHarborSnapshot(snapshotsRoot, resolution.taskSourceId, options);
    if (retained.manifest.harborDigest !== resolution.harborDigest) {
      throw new Error(`Snapshot "${resolution.taskSourceId}" already retains different Harbor content (${retained.manifest.harborDigest}).`);
    }
    return retained;
  }

  mkdirSync(resolve(snapshotsRoot), { recursive: true });
  mkdirSync(snapshotRoot);
  let published = false;
  try {
    const copyDigest = copyTaskTree(taskDir, snapshotRoot);
    const manifest: HarborSnapshotManifest = {
      schemaVersion: HARBOR_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
      taskSourceId: resolution.taskSourceId,
      harborDigest: resolution.harborDigest,
      harborName: resolution.harborName,
      harborVersion: resolution.harborVersion,
      harborType: resolution.harborType,
      taskSchemaVersion: resolution.taskSchemaVersion,
      harborPackageVersion: resolution.harborPackageVersion,
      pathPolicy: HARBOR_PATH_POLICY_VERSION,
      snapshotLocator: `${resolution.taskSourceId}/`,
      sourceLocator: options.sourceLocator ?? null,
      copyDigest,
      packaging: { includedFiles: resolution.packaging.includedFiles, excludedFiles: resolution.packaging.excludedFiles },
      assessmentMode: resolution.assessmentMode,
    };

    const verified = await resolveHarborTask(snapshotRoot, options);
    if (verified.harborDigest !== resolution.harborDigest) {
      throw new Error(`Snapshot identity "${verified.harborDigest}" does not match the resolved identity "${resolution.harborDigest}".`);
    }
    if (verified.resolutionDigest.value !== resolution.resolutionDigest.value) {
      throw new Error("Snapshot resolution differs from the source resolution; the snapshot is not a faithful copy.");
    }

    mkdirSync(resolve(snapshotsRoot), { recursive: true });
    await writeMetadataAtomically(resolve(snapshotsRoot), manifestLocator, manifest, undefined, { overwrite: false });
    published = true;
    const retained = await verifyHarborSnapshot(snapshotsRoot, resolution.taskSourceId, options);
    if (retained.manifest.copyDigest.value !== manifest.copyDigest.value
        || retained.manifest.harborDigest !== manifest.harborDigest) {
      throw new Error("Snapshot manifest changed immediately after publication.");
    }
    return retained;
  } catch (error) {
    if (!published) rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Validate an existing snapshot: recompute identity and resolution from the
 * snapshot bytes through the official package and bind them to the recorded
 * manifest. Relocating the identical tree preserves the identity (A05).
 */
export async function verifyHarborSnapshot(
  snapshotsRoot: string,
  taskSourceId: string,
  options: InspectHarborTaskOptions = {},
): Promise<HarborSnapshot> {
  if (!/^[a-z0-9-]+$/.test(taskSourceId)) throw new Error(`Snapshot identifier "${taskSourceId}" is malformed.`);
  const root = resolve(snapshotsRoot);
  const taskDirectory = join(root, taskSourceId);
  const manifestPath = join(root, `${taskSourceId}.snapshot-manifest.json`);
  const manifest = readJsonManifest(manifestPath);
  if (manifest.taskSourceId !== taskSourceId) throw new Error("Snapshot manifest identifier does not match its locator.");
  const resolution = await resolveHarborTask(taskDirectory, { ...options, assessmentMode: manifest.assessmentMode });
  if (resolution.harborDigest !== manifest.harborDigest || resolution.taskSourceId !== manifest.taskSourceId) {
    throw new Error(`Snapshot "${taskSourceId}" content changed from its recorded Harbor identity.`);
  }
  const copyDigest = digestTree(taskDirectory);
  if (copyDigest.value !== manifest.copyDigest.value) {
    throw new Error(`Snapshot "${taskSourceId}" bytes changed from its recorded copy digest.`);
  }
  return { manifest, taskDirectory };
}

function resolutionContent(resolution: HarborTaskResolution): unknown {
  // Absolute paths and source locators are excluded: the resolution identity
  // is a content identity, so relocating an identical tree preserves it.
  return {
    sourceKind: resolution.sourceKind,
    taskSourceId: resolution.taskSourceId,
    harborDigest: resolution.harborDigest,
    // harborName is deliberately excluded: for local tasks Harbor derives it
    // from the directory basename, and TaskLock equality is digest-only. The
    // digest is the content identity (MIGRATION_SPEC.md D2, A05).
    harborVersion: resolution.harborVersion,
    harborType: resolution.harborType,
    taskSchemaVersion: resolution.taskSchemaVersion,
    harborPackageVersion: resolution.harborPackageVersion,
    assessmentMode: resolution.assessmentMode,
    steps: resolution.steps,
    environment: resolution.environment,
    verifier: resolution.verifier,
    multiStepRewardStrategy: resolution.multiStepRewardStrategy,
    instructions: resolution.instructions.map((instruction) => ({ step: instruction.step, digest: instruction.digest })),
    packaging: { includedFiles: resolution.packaging.includedFiles, excludedFiles: resolution.packaging.excludedFiles },
  };
}

async function inspectSummary(adapter: HarborAdapter, taskDir: string, disableVerification: boolean): Promise<HarborTaskSummary> {
  const inspect = await adapter.inspect(taskDir, { disableVerification });
  return {
    name: inspect.name,
    shortName: inspect.shortName,
    version: inspect.version,
    schemaVersion: inspect.schemaVersion,
    hasSteps: inspect.hasSteps,
    steps: inspect.steps.map((step) => ({
      name: step.name,
      minReward: step.minReward,
      verifierTimeoutSec: step.verifierTimeoutSec,
      agentTimeoutSec: step.agentTimeoutSec,
    })),
    metadataKeys: inspect.metadataKeys,
    environment: {
      os: inspect.environment.os,
      dockerImage: inspect.environment.dockerImage,
      cpus: inspect.environment.cpus,
      memoryMb: inspect.environment.memoryMb,
      gpus: inspect.environment.gpus,
      tpu: inspect.environment.tpu,
      networkMode: inspect.environment.networkMode,
      allowInternet: inspect.environment.allowInternet,
      mcpServerCount: inspect.environment.mcpServerCount,
      composeServices: inspect.environment.composeServices,
      buildTimeoutSec: inspect.environment.buildTimeoutSec,
      workdir: inspect.environment.workdir,
    },
    verifier: inspect.verifier,
    hasSolution: inspect.hasSolution,
    hasTests: inspect.hasTests,
    multiStepRewardStrategy: inspect.multiStepRewardStrategy,
  };
}

export async function inspectHarborTaskSummary(
  taskDir: string,
  options: InspectHarborTaskOptions = {},
): Promise<HarborTaskSummary> {
  const adapter = options.adapter ?? await createHarborAdapter();
  return inspectSummary(adapter, taskDir, (options.assessmentMode ?? "observational") === "observational");
}

function describeUnsupported(reasons: readonly HarborUnsupportedReasonCode[]): string {
  const labels: Record<HarborUnsupportedReasonCode, string> = {
    "unsupported-windows-os": "Windows task environments are outside the initial execution profile",
    "unsupported-gpu": "GPU resources are outside the initial execution profile",
    "unsupported-tpu": "TPU resources are outside the initial execution profile",
    "unsupported-mcp-services": "Arbitrary MCP services are outside the initial execution profile",
    "unsupported-compose-sidecars": "Compose sidecar services are outside the initial execution profile",
    "unsupported-shared-multistep-verifier": "Verified multi-step tasks require separate verifiers: shared verification leaves hidden tests visible to later candidate steps",
  };
  return `${reasons.map((reason) => labels[reason]).join("; ")}. The task files are preserved unchanged and remain usable by an ordinary Harbor installation.`;
}

function copyTaskTree(sourceRoot: string, destinationRoot: string): Digest {
  let totalBytes = 0;
  let fileCount = 0;

  const walk = (source: string, destination: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      const relativePath = relativePathBetween(destinationRoot, destinationPath);
      if (!isSafeHarborRelativePath(relativePath)) {
        throw new HarborAdapterError(
          "path-policy-restricted",
          `Harbor task entry "${relativePath}" is rejected by ${HARBOR_PATH_POLICY_VERSION}. EBO's admission profile rejects all task-tree links and unsafe names; adjust the task directory or admit it with an ordinary Harbor installation.`,
        );
      }
      const stats = lstatSync(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new HarborAdapterError(
          "path-policy-restricted",
          `Harbor task entry "${relativePath}" is a symbolic link; ${HARBOR_PATH_POLICY_VERSION} rejects links as an EBO profile restriction even where Harbor permits internal links.`,
        );
      }
      if (stats.isDirectory()) {
        mkdirSync(destinationPath, { recursive: true });
        walk(sourcePath, destinationPath);
        continue;
      }
      if (!stats.isFile()) {
        throw new HarborAdapterError(
          "path-policy-restricted",
          `Harbor task entry "${relativePath}" is a special file, which the EBO snapshot policy rejects.`,
        );
      }
      if (++fileCount > MAX_HARBOR_SNAPSHOT_FILES) {
        throw new HarborAdapterError("task-too-large", `Harbor task exceeds the snapshot limit of ${MAX_HARBOR_SNAPSHOT_FILES} files.`);
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_HARBOR_SNAPSHOT_BYTES) {
        throw new HarborAdapterError("task-too-large", `Harbor task exceeds the snapshot limit of ${MAX_HARBOR_SNAPSHOT_BYTES} bytes.`);
      }
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
      // Preserve the executable bit only; Harbor task inputs are otherwise
      // read as plain bytes and the snapshot must remain byte-identical.
      chmodSync(destinationPath, (stats.mode & 0o111) === 0 ? 0o644 & ~process.umask() : 0o755 & ~process.umask());
    }
  };

  mkdirSync(destinationRoot, { recursive: true });
  walk(resolve(sourceRoot), destinationRoot);
  return digestTree(destinationRoot);
}

function digestTree(root: string): Digest {
  const hash = createHash("sha256");
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  walk(root);
  paths.sort();
  for (const path of paths) {
    const relativePath = relativePathBetween(root, path);
    hash.update(`${relativePath}\0${(statSync(path).mode & 0o111) !== 0 ? "x" : "-"}\0${digestFile(path).value}\n`);
  }
  return { algorithm: "sha256", value: hash.digest("hex") };
}

function digestFile(path: string): Digest {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      if (read < chunk.length) break;
    }
    return { algorithm: "sha256", value: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function relativePathBetween(root: string, path: string): string {
  const relative = path.split(sep).filter((segment) => segment !== "");
  const rootSegments = resolve(root).split(sep).filter((segment) => segment !== "");
  return relative.slice(rootSegments.length).join("/");
}

function readJsonManifest(path: string): HarborSnapshotManifest {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = statSync(path).size;
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read === 0) throw new Error(`Snapshot manifest "${path}" was truncated while being read.`);
      offset += read;
    }
    const manifest = JSON.parse(bytes.toString("utf8")) as HarborSnapshotManifest;
    if (manifest.schemaVersion !== HARBOR_SNAPSHOT_MANIFEST_SCHEMA_VERSION) {
      throw new Error(`Snapshot manifest "${path}" has unsupported schema version "${manifest.schemaVersion}".`);
    }
    return manifest;
  } finally {
    closeSync(descriptor);
  }
}

function directoryExists(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export { digestBytes as digestHarborBytes };
