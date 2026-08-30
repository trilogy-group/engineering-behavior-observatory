import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  renameSync,
  rmdirSync,
  readSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from "node:path";

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
let setupQueue = Promise.resolve();

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
  workspaceIdentity?: WorkspaceIdentity;
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
  const createdWorkspace = createWorkspace(parent, attemptId);
  let workspacePath = createdWorkspace.path;
  if (!isDisjoint(bundleRoot, workspacePath)) {
    removeWorkspaceIfOwned(workspacePath, createdWorkspace.identity);
    throw new Error("Workspace and task-bundle roots must be separate.");
  }

  const retainOnFailure = options.retainOnFailure === true;
  let workspaceIdentity: WorkspaceIdentity | undefined = createdWorkspace.identity;
  let result: WorkspaceMaterialization | undefined;
  try {
    workspaceIdentity = await readWorkspaceRootIdentity(workspacePath);
    await chmod(workspacePath, DIRECTORY_MODE);
    for (const entry of entries) await materializeEntry(workspacePath, entry);
    workspacePath = sealWorkspace(workspacePath, join(parent.path, `.ebo-${attemptId}-sealed-${randomUUID()}`), workspaceIdentity);
    await runSetup(options.setup, options.setupSteps, workspacePath);
    normalizeWorkspace(workspacePath, workspaceIdentity);
    assertWorkspaceRoot(workspacePath, workspaceIdentity);
    const workspaceFingerprint = digestMaterializedWorkspace(workspacePath, workspaceIdentity);
    assertWorkspaceRoot(workspacePath, workspaceIdentity);
    const settledFingerprint = digestMaterializedWorkspace(workspacePath, workspaceIdentity);
    if (workspaceFingerprint !== settledFingerprint) {
      throw new Error("Workspace changed while its final fingerprint was settling.");
    }
    result = createResult({
      attemptId,
      packet,
      packetDigest: freeze.packetDigest,
      sourceDigest: source.digest,
      workspacePath,
      workspaceIdentity,
      workspaceFingerprint,
      retainOnFailure,
      retained: true,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    const rootIsSafe = workspaceIdentity !== undefined
      && await isSafeWorkspaceRoot(workspacePath, workspaceIdentity)
      && await isSafeWorkspaceTree(workspacePath);
    if (!retainOnFailure || !rootIsSafe) {
      removeWorkspaceIfOwned(workspacePath, workspaceIdentity);
    }
    result = createResult({
      attemptId,
      packet,
      packetDigest: freeze.packetDigest,
      sourceDigest: source.digest,
      workspacePath,
      workspaceIdentity,
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
  if (!removeWorkspaceIfOwned(materialization.workspacePath, materialization.workspaceIdentity)) {
    throw new Error("Workspace root changed before cleanup.");
  }
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
  workspaceIdentity?: WorkspaceIdentity;
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
    ...(input.workspaceIdentity === undefined ? {} : { workspaceIdentity: input.workspaceIdentity }),
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

type WorkspaceParent = WorkspaceIdentity & { path: string };

async function prepareWorkspaceParent(parent: string, bundleRoot: string): Promise<WorkspaceParent> {
  const absolute = await resolveFuturePath(resolve(parent));
  const created: Array<{ path: string; dev: number; ino: number }> = [];
  const filesystemRoot = parse(absolute).root;
  let current = filesystemRoot;
  try {
    for (const segment of absolute.slice(filesystemRoot.length).split(sep).filter(Boolean)) {
      current = join(current, segment);
      let metadata;
      try {
        metadata = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current, { mode: 0o700 });
        metadata = await lstat(current);
        created.push({ path: current, dev: metadata.dev, ino: metadata.ino });
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Workspace parent cannot cross a symbolic link or non-directory.");
      }
      const resolved = await realpath(current);
      if (resolved !== current || isContained(bundleRoot, resolved)) {
        throw new Error("Workspace parent must be outside the task-bundle root.");
      }
    }
    const metadata = await lstat(current);
    return { path: current, dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    for (const entry of created.reverse()) {
      try {
        const metadata = await lstat(entry.path);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()
            && metadata.dev === entry.dev && metadata.ino === entry.ino) {
          rmdirSync(entry.path);
        }
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw error;
  }
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

function createWorkspace(parent: WorkspaceParent, attemptId: string): { path: string; identity: WorkspaceIdentity } {
  const parentFd = openSync(parent.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const originalCwd = process.cwd();
  let createdPath: string | undefined;
  try {
    // This synchronous section has no await points, so concurrent callers cannot
    // interleave cwd changes while mkdtemp is anchored to parentFd's directory.
    process.chdir(parent.path);
    if (!sameIdentity(fstatSync(parentFd), lstatSync("."))) {
      throw new Error("Workspace parent changed before attempt creation.");
    }
    createdPath = mkdtempSync(`ebo-${attemptId}-`);
    if (!sameIdentity(fstatSync(parentFd), lstatSync("."))) {
      throw new Error("Workspace parent changed during attempt creation.");
    }
    const metadata = lstatSync(createdPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Workspace root is not a directory.");
    }
    return { path: realpathSync(createdPath), identity: { dev: metadata.dev, ino: metadata.ino } };
  } catch (error) {
    if (createdPath !== undefined) rmSync(createdPath, { force: true, recursive: true });
    throw error;
  } finally {
    process.chdir(originalCwd);
    closeSync(parentFd);
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
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

function sealWorkspace(path: string, destination: string, expected: WorkspaceIdentity): string {
  const current = lstatSync(path);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected)) {
    throw new Error("Workspace root changed before sealing.");
  }
  renameSync(path, destination);
  try {
    const sealed = lstatSync(destination);
    if (!sealed.isDirectory() || sealed.isSymbolicLink() || !sameIdentity(sealed, expected)) {
      if (sealed.isSymbolicLink()) rmSync(destination, { force: true });
      throw new Error("Workspace root changed during sealing.");
    }
    return realpathSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Workspace root disappeared during sealing.");
    }
    throw error;
  }
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

function normalizeWorkspace(root: string, expectedIdentity: WorkspaceIdentity): void {
  assertWorkspaceRoot(root, expectedIdentity);
  normalizeDirectory(root, root, "");
  assertWorkspaceRoot(root, expectedIdentity);
}

function normalizeDirectory(
  root: string,
  directory: string,
  relativeDirectory: string,
  verifiedFd?: number,
): void {
  const directoryFd = verifiedFd
    ?? openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const ownsFd = verifiedFd === undefined;
  try {
    assertContainedRealpathSync(root, directory);
    if (!sameIdentity(fstatSync(directoryFd), lstatSync(directory))) {
      throw new Error(`Workspace directory "${relativeDirectory}" changed during materialization.`);
    }
    const entries = readDirectoryEntries(directory, directoryFd);
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativePath.split("/", 1)[0]?.toLowerCase() === "restricted") {
        throw new Error(`Restricted packet content cannot enter the workspace: "${relativePath}".`);
      }
      const current = lstatSync(path);
      const childFd = openChildSync(path, entry.isDirectory());
      try {
        const metadata = fstatSync(childFd);
        assertContainedRealpathSync(root, path);
        if (current.isSymbolicLink() || !sameIdentity(metadata, current)) {
          throw new Error(`Workspace entry "${relativePath}" changed during materialization.`);
        }
        if (metadata.isDirectory()) {
          normalizeDirectory(root, path, relativePath, childFd);
          fchmodSync(childFd, DIRECTORY_MODE);
          futimesSync(childFd, EPOCH_SECONDS, EPOCH_SECONDS);
        } else if (metadata.isFile()) {
          if (metadata.nlink > 1) throw new Error(`Workspace contains a hard-linked file at "${relativePath}".`);
          fchmodSync(childFd, normalizedFileMode(metadata.mode));
          futimesSync(childFd, EPOCH_SECONDS, EPOCH_SECONDS);
        } else {
          throw new Error(`Workspace contains an unsupported entry at "${relativePath}".`);
        }
        const completed = fstatSync(childFd);
        const finalPath = lstatSync(path);
        if (!sameIdentity(metadata, completed) || !sameIdentity(metadata, finalPath)
            || finalPath.isSymbolicLink()) {
          throw new Error(`Workspace entry "${relativePath}" changed during materialization.`);
        }
      } finally {
        closeSync(childFd);
      }
    }
    fchmodSync(directoryFd, DIRECTORY_MODE);
    futimesSync(directoryFd, EPOCH_SECONDS, EPOCH_SECONDS);
  } finally {
    if (ownsFd) closeSync(directoryFd);
  }
}

function openChildSync(path: string, directory: boolean): number {
  const current = lstatSync(path);
  if (current.isSymbolicLink()) throw new Error(`Workspace contains a symbolic link at "${path}".`);
  if (!current.isDirectory() && !current.isFile()) {
    throw new Error(`Workspace contains an unsupported entry at "${path}".`);
  }
  try {
    return openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Workspace contains a symbolic link at "${path}".`);
    }
    throw error;
  }
}

function readDirectoryEntries(directory: string, directoryFd: number): import("node:fs").Dirent[] {
  const handle = opendirSync(directory);
  try {
    if (!sameIdentity(fstatSync(directoryFd), lstatSync(directory))) {
      throw new Error(`Workspace directory "${directory}" changed during traversal.`);
    }
    const entries: import("node:fs").Dirent[] = [];
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) entries.push(entry);
    return entries;
  } finally {
    handle.closeSync();
  }
}

function assertContainedRealpathSync(root: string, path: string): void {
  const resolved = realpathSync(path);
  if (resolved !== path || !isContained(root, resolved)) {
    throw new Error(`Workspace path "${path}" escapes its root.`);
  }
}

function digestMaterializedWorkspace(root: string, expectedIdentity: WorkspaceIdentity): string {
  const hash = createHash("sha256");
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(rootFd, { bigint: true });
    assertWorkspaceRoot(root, expectedIdentity);
    assertContainedRealpathSync(root, root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Workspace root is not a directory.");
    hash.update("ebo.workspace/v1\0");
    hash.update(`root\0${metadata.mode & 0o7777n}\0${workspaceTimestamp(metadata)}\0`);
    hashWorkspaceDirectory(root, root, "", hash, rootFd);
  } finally {
    closeSync(rootFd);
  }
  assertWorkspaceRoot(root, expectedIdentity);
  return `sha256:${hash.digest("hex")}`;
}

function hashWorkspaceDirectory(
  root: string,
  directory: string,
  relativeDirectory: string,
  hash: ReturnType<typeof createHash>,
  verifiedFd?: number,
): void {
  const directoryFd = verifiedFd
    ?? openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const ownsFd = verifiedFd === undefined;
  try {
    assertContainedRealpathSync(root, directory);
    const openedDirectory = fstatSync(directoryFd, { bigint: true });
    if (!openedDirectory.isDirectory() || openedDirectory.isSymbolicLink()) {
      throw new Error(`Workspace directory "${relativeDirectory}" is unsafe.`);
    }
    const entries = readDirectoryEntries(directory, directoryFd);
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativePath.split("/", 1)[0]?.toLowerCase() === "restricted") {
        throw new Error(`Restricted packet content cannot enter the workspace: "${relativePath}".`);
      }
      const current = lstatSync(path, { bigint: true });
      const childFd = openChildSync(path, entry.isDirectory());
      try {
        const metadata = fstatSync(childFd, { bigint: true });
        assertContainedRealpathSync(root, path);
        if (current.isSymbolicLink() || !sameIdentity(metadata, current)) {
          throw new Error(`Workspace entry "${relativePath}" changed during fingerprinting.`);
        }
        if (metadata.isDirectory()) {
          hash.update(`directory\0${relativePath}\0${metadata.mode & 0o7777n}\0${workspaceTimestamp(metadata)}\0`);
          hashWorkspaceDirectory(root, path, relativePath, hash, childFd);
        } else if (metadata.isFile()) {
          if (metadata.nlink > 1n) throw new Error(`Workspace contains a hard-linked file at "${relativePath}".`);
          const size = Number(metadata.size);
          if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Workspace file "${relativePath}" is too large.`);
          const bytes = Buffer.alloc(size);
          for (let offset = 0; offset < size;) {
            const read = readSync(childFd, bytes, offset, size - offset, offset);
            if (read === 0) throw new Error(`Workspace file "${relativePath}" changed during fingerprinting.`);
            offset += read;
          }
          hash.update(`file\0${relativePath}\0${metadata.mode & 0o7777n}\0${workspaceTimestamp(metadata)}\0${bytes.length}\0`);
          hash.update(bytes);
        } else {
          throw new Error(`Workspace contains an unsupported entry at "${relativePath}".`);
        }
        const completed = fstatSync(childFd, { bigint: true });
        const finalPath = lstatSync(path, { bigint: true });
        if (!sameIdentity(metadata, completed) || !sameIdentity(metadata, finalPath)
            || finalPath.isSymbolicLink() || (metadata.isFile() && !sameFileSnapshot(metadata, completed))) {
          throw new Error(`Workspace entry "${relativePath}" changed during fingerprinting.`);
        }
      } finally {
        closeSync(childFd);
      }
    }
  } finally {
    if (ownsFd) closeSync(directoryFd);
  }
}

async function runSetup(
  setup: WorkspaceMaterializationOptions["setup"],
  setupSteps: readonly WorkspaceSetupStep[] | undefined,
  workspacePath: string,
): Promise<void> {
  const steps = setup === undefined ? [] : typeof setup === "function" ? [setup] : [...setup];
  const allSteps = [...steps, ...(setupSteps ?? [])];
  if (allSteps.length === 0) return;
  if (process.platform === "win32") throw new Error("Workspace setup process tracking is unavailable on this platform.");
  let releaseSetup: (() => void) | undefined;
  const previousSetup = setupQueue;
  // ponytail: serialize setup process accounting; per-invocation process
  // groups when concurrent setup throughput matters.
  setupQueue = new Promise<void>((resolve) => { releaseSetup = resolve; });
  await previousSetup;
  let processTreeBefore: Map<number, number> | undefined;
  try {
    processTreeBefore = processTree();
  } catch {
    releaseSetup?.();
    throw new Error("Workspace setup process tracking is unavailable.");
  }
  try {
    for (const step of allSteps) {
      if (typeof step !== "function") throw new Error("Workspace setup steps must be functions.");
      await step(workspacePath);
    }
  } finally {
    if (processTreeBefore !== undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      reapSetupDescendants(processTreeBefore);
    }
    releaseSetup?.();
  }
}

function processTree(): Map<number, number> {
  const output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const tree = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match !== null) tree.set(Number(match[1]), Number(match[2]));
  }
  return tree;
}

function reapSetupDescendants(before: ReadonlyMap<number, number>): void {
  let after: Map<number, number>;
  try {
    after = processTree();
  } catch {
    throw new Error("Workspace setup process tracking is unavailable.");
  }
  const descendants = [...after.keys()].filter((pid) => !before.has(pid) && isDescendant(pid, process.pid, after));
  descendants.sort((left, right) => processDepth(right, after) - processDepth(left, after));
  for (const pid of descendants) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The setup child may have exited between the process snapshot and kill.
    }
  }
}

function isDescendant(pid: number, ancestor: number, tree: ReadonlyMap<number, number>): boolean {
  const seen = new Set<number>();
  for (let current: number | undefined = pid; current !== undefined && !seen.has(current); current = tree.get(current)) {
    if (current === ancestor) return true;
    seen.add(current);
  }
  return false;
}

function processDepth(pid: number, tree: ReadonlyMap<number, number>): number {
  let depth = 0;
  const seen = new Set<number>();
  for (let current: number | undefined = pid; current !== undefined && !seen.has(current); current = tree.get(current)) {
    depth += 1;
    seen.add(current);
  }
  return depth;
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

async function isSafeWorkspaceRoot(path: string, expected: WorkspaceIdentity): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink()
      && (metadata.mode & 0o7777) === DIRECTORY_MODE
      && metadata.dev === expected.dev && metadata.ino === expected.ino
      && (await realpath(path)) === path;
  } catch {
    return false;
  }
}

function isSafeWorkspaceTree(
  directory: string,
  relativeDirectory = "",
  root = directory,
  verifiedFd?: number,
): boolean {
  let directoryFd: number;
  try {
    directoryFd = verifiedFd
      ?? openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  const ownsFd = verifiedFd === undefined;
  try {
    assertContainedRealpathSync(root, directory);
    const directoryMetadata = fstatSync(directoryFd);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) return false;
    for (const entry of readDirectoryEntries(directory, directoryFd)) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativePath.split("/", 1)[0]?.toLowerCase() === "restricted") return false;
      const current = lstatSync(path);
      const childFd = openChildSync(path, entry.isDirectory());
      try {
        const metadata = fstatSync(childFd);
        assertContainedRealpathSync(root, path);
        if (current.isSymbolicLink() || !sameIdentity(metadata, current)) return false;
        if (metadata.isDirectory()) {
          if ((metadata.mode & 0o7777) !== DIRECTORY_MODE
              || !isSafeWorkspaceTree(path, relativePath, root, childFd)) return false;
        } else if (!metadata.isFile() || metadata.nlink > 1
            || (metadata.mode & 0o7777) !== normalizedFileMode(metadata.mode)) {
          return false;
        }
      } finally {
        closeSync(childFd);
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (ownsFd) closeSync(directoryFd);
  }
}

function removeWorkspaceIfOwned(path: string, expected: WorkspaceIdentity | undefined): boolean {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      rmSync(path, { force: true });
      return true;
    }
    if (expected === undefined || !metadata.isDirectory()
        || metadata.dev !== expected.dev || metadata.ino !== expected.ino) return false;

    const parent = dirname(path);
    const quarantine = join(parent, `.${basename(path)}-cleanup-${randomUUID()}`);
    const parentHandle = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(fstatSync(parentHandle), lstatSync(parent))) return false;
      const current = lstatSync(path);
      if (current.isSymbolicLink() || !current.isDirectory()
          || current.dev !== expected.dev || current.ino !== expected.ino) return false;
      renameSync(path, quarantine);
      const moved = lstatSync(quarantine);
      if (moved.isDirectory() && !moved.isSymbolicLink()
          && moved.dev === expected.dev && moved.ino === expected.ino) {
        rmSync(quarantine, { force: true, recursive: true });
        return true;
      }
      if (moved.isSymbolicLink()) {
        rmSync(quarantine, { force: true });
      } else {
        try {
          lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") renameSync(quarantine, path);
          else throw error;
        }
      }
      return false;
    } finally {
      closeSync(parentHandle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function assertAttemptId(attemptId: string): void {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("Workspace attempt ID is unsafe.");
}

function normalizedFileMode(mode: number): number {
  return FILE_MODE | (mode & 0o111 ? 0o100 : 0);
}

type WorkspaceIdentity = { dev: number; ino: number };

async function readWorkspaceRootIdentity(path: string): Promise<WorkspaceIdentity> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Workspace root is not a directory.");
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertWorkspaceRoot(path: string, expected: WorkspaceIdentity): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
    throw new Error("Workspace root changed during materialization.");
  }
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(
  left: { size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): boolean {
  return left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function workspaceTimestamp(metadata: { mtimeNs: bigint; mtimeMs: bigint }): bigint {
  return process.platform === "win32" ? metadata.mtimeMs : metadata.mtimeNs;
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
