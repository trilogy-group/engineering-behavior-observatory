import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { digestWorkspace } from "./verifiers.js";
import {
  isSafeArtifactRelativePath,
  readTaskArchive,
  resolveTaskArchive,
  type Digest,
  type TaskArchiveEntry,
} from "./contracts.js";
import { assertTaskPacketAdmitted, statusTaskPacket, type TaskPacket } from "./task-packets.js";

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const EPOCH_SECONDS = 0;

export type WorkspaceSetupStep = (workspacePath: string) => void | Promise<void>;

export type WorkspaceMaterializationOptions = {
  bundleRoot: string;
  packetLocator: string;
  attemptId?: string;
  workspaceParent?: string;
  /** Alias for workspaceParent retained for callers that name the base directory a root. */
  workspaceRoot?: string;
  freezeLocator?: string;
  retainOnFailure?: boolean;
  setup?: WorkspaceSetupStep | readonly WorkspaceSetupStep[];
  setupSteps?: readonly WorkspaceSetupStep[];
};

export type WorkspaceMaterialization = {
  attemptId: string;
  packetId: string;
  packetDigest: Digest;
  fixtureDigest: Digest;
  /** The digest declared by the frozen fixture, before any harness execution. */
  startingDigest: Digest;
  workspacePath: string;
  /** Alias for workspacePath for callers that use path-oriented lifecycle code. */
  path: string;
  workspaceFingerprint: string | null;
  /** Alias for workspaceFingerprint used by workspace evidence callers. */
  workspaceDigest: string | null;
  status: "ready" | "failed" | "cleaned";
  state: "ready" | "failed" | "cleaned";
  retainOnFailure: boolean;
  retained: boolean;
  error?: string;
  cleanup: (outcome?: "success" | "failure") => Promise<void>;
};

/**
 * Materialize one admitted, frozen task packet into an isolated attempt path.
 * Only selected regular files and directories from the verified archive enter
 * the workspace; restricted packet components never do.
 */
export async function materializeWorkspace(
  options: WorkspaceMaterializationOptions,
): Promise<WorkspaceMaterialization> {
  const attemptId = options.attemptId ?? randomUUID();
  assertAttemptId(attemptId);

  const freeze = statusTaskPacket(options.bundleRoot, options.packetLocator, options.freezeLocator);
  if (freeze.status !== "frozen") {
    throw new Error(`Task packet "${options.packetLocator}" is not frozen (${freeze.status}).`);
  }
  if (freeze.packetDigest === null) throw new Error("Frozen task packet is missing its packet digest.");
  const inspection = assertTaskPacketAdmitted(options.bundleRoot, options.packetLocator);
  const packet = inspection.packet as TaskPacket;
  if (inspection.packetDigest === null || !sameDigest(inspection.packetDigest, freeze.packetDigest)) {
    throw new Error(`Frozen task packet "${options.packetLocator}" changed before materialization.`);
  }

  const source = packet.agentInput.fixture.source;
  const archive = resolveTaskArchive(options.bundleRoot, source, source.limits.maxCompressedBytes);
  const entries = readTaskArchive(archive, source.limits, packet.agentInput.fixture.materializer.includePaths);
  assertModelVisibleEntries(entries);
  assertFrozenSnapshot(options, freeze.packetDigest, freeze.aggregateDigest);

  const bundleRoot = await realpath(options.bundleRoot);
  const parent = await prepareWorkspaceParent(options.workspaceParent ?? options.workspaceRoot ?? tmpdir(), bundleRoot);
  const workspacePath = await realpath(await mkdtemp(join(parent, `ebo-${attemptId}-`)));
  if (!isDisjoint(bundleRoot, workspacePath)) {
    await rm(workspacePath, { force: true, recursive: true });
    throw new Error("Workspace and task-bundle roots must be separate.");
  }

  const retainOnFailure = options.retainOnFailure === true;
  let result: WorkspaceMaterialization | undefined;
  try {
    await chmod(workspacePath, DIRECTORY_MODE);
    for (const entry of entries) await materializeEntry(workspacePath, entry);
    await runSetup(options.setup, options.setupSteps, workspacePath);
    await normalizeWorkspace(workspacePath);
    const workspaceFingerprint = await digestWorkspace(workspacePath);
    result = createResult({
      attemptId,
      packet,
      packetDigest: freeze.packetDigest,
      sourceDigest: source.digest,
      workspacePath,
      workspaceFingerprint,
      retainOnFailure,
      retained: true,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    const rootIsSafe = await isSafeWorkspaceRoot(workspacePath) && await isSafeWorkspaceTree(workspacePath);
    if (!retainOnFailure || !rootIsSafe) {
      await rm(workspacePath, { force: true, recursive: true });
    }
    result = createResult({
      attemptId,
      packet,
      packetDigest: freeze.packetDigest,
      sourceDigest: source.digest,
      workspacePath,
      workspaceFingerprint: null,
      retainOnFailure,
      retained: retainOnFailure && rootIsSafe,
      status: "failed",
      error: message,
    });
    return result;
  }
}

export async function cleanupWorkspace(
  materialization: WorkspaceMaterialization,
  outcome: "success" | "failure" = materialization.state === "failed" ? "failure" : "success",
): Promise<void> {
  if (materialization.state === "cleaned") return;
  if (outcome === "failure" && materialization.retainOnFailure && materialization.retained) return;
  await rm(materialization.workspacePath, { force: true, recursive: true });
  materialization.status = "cleaned";
  materialization.state = "cleaned";
  materialization.retained = false;
}

function createResult(input: {
  attemptId: string;
  packet: TaskPacket;
  packetDigest: Digest;
  sourceDigest: Digest;
  workspacePath: string;
  workspaceFingerprint: string | null;
  retainOnFailure: boolean;
  retained: boolean;
  status?: "ready" | "failed";
  error?: string;
}): WorkspaceMaterialization {
  const result: WorkspaceMaterialization = {
    attemptId: input.attemptId,
    packetId: input.packet.id,
    packetDigest: input.packetDigest,
    fixtureDigest: input.sourceDigest,
    startingDigest: input.sourceDigest,
    workspacePath: input.workspacePath,
    path: input.workspacePath,
    workspaceFingerprint: input.workspaceFingerprint,
    workspaceDigest: input.workspaceFingerprint,
    status: input.status ?? "ready",
    state: input.status ?? "ready",
    retainOnFailure: input.retainOnFailure,
    retained: input.retained,
    ...(input.error === undefined ? {} : { error: input.error }),
    cleanup: async (outcome) => cleanupWorkspace(result, outcome),
  };
  return result;
}

async function prepareWorkspaceParent(parent: string, bundleRoot: string): Promise<string> {
  const absolute = resolve(parent);
  if (isContained(bundleRoot, await resolveFuturePath(absolute))) {
    throw new Error("Workspace parent must be outside the task-bundle root.");
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const resolved = await realpath(absolute);
  if (isContained(bundleRoot, resolved)) {
    throw new Error("Workspace parent must be outside the task-bundle root.");
  }
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Workspace parent is not a directory.");
  }
  return resolved;
}

async function resolveFuturePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(await resolveFuturePath(parent), basename(path));
  }
}

async function materializeEntry(root: string, entry: TaskArchiveEntry): Promise<void> {
  assertSafeWorkspacePath(root, entry.path);
  if (entry.kind === "directory") {
    await ensureDirectory(root, entry.path);
    return;
  }
  if (entry.kind !== "file") throw new Error(`Archive entry "${entry.path}" is unsafe.`);

  await ensureDirectory(root, posix.dirname(entry.path));
  const destination = resolve(root, entry.path);
  const mode = normalizedFileMode(entry.mode);
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(entry.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(destination, mode);
}

async function ensureDirectory(root: string, relativePath: string): Promise<void> {
  if (relativePath === ".") return;
  assertSafeWorkspacePath(root, relativePath);
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    try {
      await mkdir(current, { mode: DIRECTORY_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Workspace destination "${relativePath}" crosses a symbolic link.`);
    }
    await chmod(current, DIRECTORY_MODE);
  }
}

async function normalizeWorkspace(root: string): Promise<void> {
  await normalizeDirectory(root, "");
  await chmod(root, DIRECTORY_MODE);
  await utimes(root, EPOCH_SECONDS, EPOCH_SECONDS);
}

async function normalizeDirectory(directory: string, relativeDirectory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (relativePath.split("/", 1)[0]?.toLowerCase() === "restricted") {
      throw new Error(`Restricted packet content cannot enter the workspace: "${relativePath}".`);
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Workspace contains a symbolic link at "${relativePath}".`);
    if (metadata.isDirectory()) {
      await normalizeDirectory(path, relativePath);
      await chmod(path, DIRECTORY_MODE);
      await utimes(path, EPOCH_SECONDS, EPOCH_SECONDS);
    } else if (metadata.isFile()) {
      if (metadata.nlink > 1) throw new Error(`Workspace contains a hard-linked file at "${relativePath}".`);
      await chmod(path, normalizedFileMode(metadata.mode));
      await utimes(path, EPOCH_SECONDS, EPOCH_SECONDS);
    } else {
      throw new Error(`Workspace contains an unsupported entry at "${relativePath}".`);
    }
  }
}

async function runSetup(
  setup: WorkspaceMaterializationOptions["setup"],
  setupSteps: readonly WorkspaceSetupStep[] | undefined,
  workspacePath: string,
): Promise<void> {
  const steps = setup === undefined ? [] : typeof setup === "function" ? [setup] : [...setup];
  for (const step of [...steps, ...(setupSteps ?? [])]) {
    if (typeof step !== "function") throw new Error("Workspace setup steps must be functions.");
    await step(workspacePath);
  }
}

function assertModelVisibleEntries(entries: readonly TaskArchiveEntry[]): void {
  for (const entry of entries) {
    const first = entry.path.split("/", 1)[0]?.toLowerCase();
    if (first === "restricted") {
      throw new Error(`Restricted packet content cannot enter the workspace: "${entry.path}".`);
    }
  }
}

function assertSafeWorkspacePath(root: string, relativePath: string): void {
  if (relativePath === ".") return;
  if (!isSafeArtifactRelativePath(relativePath)) throw new Error(`Workspace path "${relativePath}" is unsafe.`);
  const destination = resolve(root, relativePath);
  if (!isContained(root, destination)) throw new Error(`Workspace path "${relativePath}" escapes its root.`);
}

async function isSafeWorkspaceRoot(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && (await realpath(path)) === path;
  } catch {
    return false;
  }
}

async function isSafeWorkspaceTree(directory: string, relativeDirectory = ""): Promise<boolean> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativePath.split("/", 1)[0]?.toLowerCase() === "restricted") return false;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) return false;
      if (metadata.isDirectory()) {
        if (!await isSafeWorkspaceTree(path, relativePath)) return false;
      } else if (!metadata.isFile() || metadata.nlink > 1) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function assertAttemptId(attemptId: string): void {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("Workspace attempt ID is unsafe.");
}

function normalizedFileMode(mode: number): number {
  return FILE_MODE | (mode & 0o111 ? 0o100 : 0);
}

function sameDigest(left: Digest, right: Digest): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function assertFrozenSnapshot(
  options: WorkspaceMaterializationOptions,
  packetDigest: Digest,
  aggregateDigest: Digest | null,
): void {
  const current = statusTaskPacket(options.bundleRoot, options.packetLocator, options.freezeLocator);
  if (current.status !== "frozen" || current.packetDigest === null || !sameDigest(current.packetDigest, packetDigest)
      || (aggregateDigest !== null && (current.aggregateDigest === null || !sameDigest(current.aggregateDigest, aggregateDigest)))) {
    throw new Error(`Frozen task packet "${options.packetLocator}" changed before workspace creation.`);
  }
}

function isDisjoint(left: string, right: string): boolean {
  return !isContained(left, right) && !isContained(right, left);
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workspace materialization failed.";
}
