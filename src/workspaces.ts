import { createHash, randomUUID } from "node:crypto";
import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  opendirSync,
  renameSync,
  rmdirSync,
  readSync,
  rmSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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

/**
 * Process primitives owned by one setup invocation. Child processes started
 * here are placed in a private process group and reaped before setup returns.
 */
export type WorkspaceSetupContext = {
  spawn: (command: string, args?: readonly string[], options?: SpawnOptions) => ChildProcess;
};

export type WorkspaceSetupStep = (
  workspacePath: string,
  context: WorkspaceSetupContext,
) => void | Promise<void>;

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
  workspaceRemoved: boolean;
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
    materializeEntries(workspacePath, workspaceIdentity, entries);
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
      workspaceRemoved: false,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    let rootIsSafe = false;
    if (workspaceIdentity !== undefined) {
      try {
        if (await isOwnedWorkspaceRoot(workspacePath, workspaceIdentity)) {
          normalizeWorkspace(workspacePath, workspaceIdentity);
          rootIsSafe = await isSafeWorkspaceRoot(workspacePath, workspaceIdentity)
            && await isSafeWorkspaceTree(workspacePath);
        }
      } catch {
        rootIsSafe = false;
      }
    }
    let workspaceRemoved = false;
    if (!retainOnFailure || !rootIsSafe) {
      workspaceRemoved = removeWorkspaceIfOwned(workspacePath, workspaceIdentity);
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
      workspaceRemoved,
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
  if (materialization.state === "failed" && !materialization.retained && materialization.workspaceRemoved) {
    materialization.status = "cleaned";
    materialization.state = "cleaned";
    return;
  }
  if (!removeWorkspaceIfOwned(materialization.workspacePath, materialization.workspaceIdentity)) {
    throw new Error("Workspace root changed before cleanup.");
  }
  materialization.status = "cleaned";
  materialization.state = "cleaned";
  materialization.retained = false;
  materialization.workspaceRemoved = true;
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
  workspaceRemoved: boolean;
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
    workspaceRemoved: input.workspaceRemoved,
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

function materializeEntries(
  root: string,
  expectedIdentity: WorkspaceIdentity,
  entries: readonly TaskArchiveEntry[],
): void {
  const originalCwd = process.cwd();
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameIdentity(fstatSync(rootFd), expectedIdentity)) throw new Error("Workspace root changed before extraction.");
    // Keep extraction synchronous. Relative opens stay anchored to the
    // verified root directory descriptor, and concurrent materializers cannot
    // interleave this short process-global cwd section.
    process.chdir(root);
    const cwdFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(fstatSync(cwdFd), expectedIdentity)) {
        throw new Error("Workspace root changed before extraction.");
      }
      for (const entry of entries) materializeEntryFromCwd(root, entry);
    } finally {
      closeSync(cwdFd);
    }
  } finally {
    process.chdir(originalCwd);
    closeSync(rootFd);
  }
}

function materializeEntryFromCwd(root: string, entry: TaskArchiveEntry): void {
  const entryPath = entry.kind === "directory" ? entry.path.replace(/\/+$/, "") : entry.path;
  assertSafeWorkspacePath(root, entryPath);
  const parts = entryPath.split("/");
  const directoryParts = entry.kind === "directory" ? parts : parts.slice(0, -1);
  for (const segment of directoryParts) enterMaterializationDirectory(root, segment);
  try {
    if (entry.kind === "directory") return;
    if (entry.kind !== "file") throw new Error(`Archive entry "${entry.path}" is unsafe.`);
    const name = parts.at(-1);
    if (name === undefined || name.length === 0) throw new Error(`Archive entry "${entry.path}" is unsafe.`);
    const mode = normalizedFileMode(entry.mode);
    const fileFd = openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      for (let offset = 0; offset < entry.bytes.length;) {
        const written = writeSync(fileFd, entry.bytes, offset, entry.bytes.length - offset);
        if (written <= 0) throw new Error(`Archive entry "${entry.path}" could not be written.`);
        offset += written;
      }
      fsyncSync(fileFd);
      fchmodSync(fileFd, mode);
    } finally {
      closeSync(fileFd);
    }
  } finally {
    for (let index = directoryParts.length - 1; index >= 0; index -= 1) process.chdir("..");
  }
}

function enterMaterializationDirectory(root: string, segment: string): void {
  if (!isSafeArtifactRelativePath(segment)) throw new Error(`Workspace path "${segment}" is unsafe.`);
  let metadata;
  try {
    metadata = lstatSync(segment);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(segment, { mode: DIRECTORY_MODE });
    metadata = lstatSync(segment);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Workspace destination "${segment}" crosses a symbolic link.`);
  }
  const childFd = openSync(segment, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const childIdentity = fstatSync(childFd);
    if (!sameIdentity(metadata, childIdentity)) throw new Error(`Workspace directory "${segment}" changed during extraction.`);
    const alias = `.ebo-materialize-${randomUUID()}`;
    try {
      lstatSync(alias);
      throw new Error(`Workspace extraction alias already exists: "${alias}".`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(segment, alias);
    let moved = true;
    try {
      if (!sameIdentity(childIdentity, lstatSync(alias))) {
        throw new Error(`Workspace directory "${segment}" changed during extraction.`);
      }
      process.chdir(alias);
      const enteredFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(childIdentity, fstatSync(enteredFd)) || !isContained(root, realpathSync("."))) {
          throw new Error(`Workspace directory "${segment}" changed during extraction.`);
        }
      } finally {
        closeSync(enteredFd);
      }
      let destinationAbsent = false;
      try {
        lstatSync(join("..", segment));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") destinationAbsent = true;
        else throw error;
      }
      if (!destinationAbsent) throw new Error(`Workspace destination "${segment}" changed during extraction.`);
      renameSync(join("..", alias), join("..", segment));
      moved = false;
    } finally {
      if (moved) {
        try {
          if (sameIdentity(childIdentity, lstatSync(join("..", alias)))) {
            let destinationAbsent = false;
            try {
              lstatSync(join("..", segment));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") destinationAbsent = true;
              else throw error;
            }
            if (destinationAbsent) renameSync(join("..", alias), join("..", segment));
          }
        } catch {
          // The caller will fail closed and remove only the original root.
        }
      }
    }
  } finally {
    closeSync(childFd);
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

function normalizeWorkspace(root: string, expectedIdentity: WorkspaceIdentity): void {
  assertWorkspaceRoot(root, expectedIdentity);
  try {
    normalizeDirectory(root, root, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    normalizeUnreadableDirectory(root, expectedIdentity);
    normalizeDirectory(root, root, "");
  }
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
    fchmodSync(directoryFd, DIRECTORY_MODE);
    const entries = readDirectoryEntries(directory, directoryFd);
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (relativePath.split("/", 1)[0]?.toLowerCase() === "restricted") {
        throw new Error(`Restricted packet content cannot enter the workspace: "${relativePath}".`);
      }
      const current = lstatSync(path);
      const childFd = openChildSync(
        path,
        entry.isDirectory(),
        current.isDirectory() ? DIRECTORY_MODE : normalizedFileMode(current.mode),
      );
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

function openChildSync(path: string, directory: boolean, normalizeMode?: number): number {
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
    if ((error as NodeJS.ErrnoException).code === "EACCES" && normalizeMode !== undefined) {
      return normalizeUnreadableChild(path, directory, current, normalizeMode);
    }
    throw error;
  }
}

function normalizeUnreadableDirectory(path: string, expected: WorkspaceIdentity): void {
  const parent = dirname(path);
  const name = basename(path);
  const alias = `.ebo-root-normalize-${randomUUID()}`;
  const originalCwd = process.cwd();
  const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let moved = false;
  try {
    if (!sameIdentity(fstatSync(parentFd), lstatSync(parent))) {
      throw new Error(`Workspace parent "${parent}" changed during normalization.`);
    }
    process.chdir(parent);
    if (!sameIdentity(fstatSync(parentFd), lstatSync("."))) {
      throw new Error(`Workspace parent "${parent}" changed during normalization.`);
    }
    try {
      lstatSync(alias);
      throw new Error(`Workspace normalization alias already exists: "${alias}".`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(name, alias);
    moved = true;
    const movedMetadata = lstatSync(alias);
    if (!movedMetadata.isDirectory() || movedMetadata.isSymbolicLink() || !sameIdentity(movedMetadata, expected)) {
      throw new Error(`Workspace root changed during normalization.`);
    }
    chmodSync(alias, DIRECTORY_MODE);
    const opened = openSync(alias, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(fstatSync(opened), expected)) throw new Error(`Workspace root changed during normalization.`);
    } finally {
      closeSync(opened);
    }
    renameSync(alias, name);
    moved = false;
    const restored = lstatSync(name);
    if (!restored.isDirectory() || restored.isSymbolicLink() || !sameIdentity(restored, expected)) {
      throw new Error(`Workspace root changed during normalization.`);
    }
  } finally {
    if (moved) {
      try {
        if (sameIdentity(lstatSync(alias), expected)) {
          let destinationAbsent = false;
          try {
            lstatSync(name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") destinationAbsent = true;
            else throw error;
          }
          if (destinationAbsent) renameSync(alias, name);
        }
      } catch {
        // Preserve the original failure and let the root cleanup gate decide.
      }
    }
    process.chdir(originalCwd);
    closeSync(parentFd);
  }
}

function normalizeUnreadableChild(
  path: string,
  directory: boolean,
  expected: import("node:fs").Stats,
  mode: number,
): number {
  const parent = dirname(path);
  const name = basename(path);
  const alias = `.ebo-normalize-${randomUUID()}`;
  const originalCwd = process.cwd();
  const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let moved = false;
  let childFd: number | undefined;
  try {
    if (!sameIdentity(fstatSync(parentFd), lstatSync(parent))) {
      throw new Error(`Workspace parent "${parent}" changed during normalization.`);
    }
    // This synchronous section keeps relative rename/chmod/open operations
    // on the verified parent descriptor without allowing concurrent JS calls
    // to interleave the process-global cwd.
    process.chdir(parent);
    if (!sameIdentity(fstatSync(parentFd), lstatSync("."))) {
      throw new Error(`Workspace parent "${parent}" changed during normalization.`);
    }
    try {
      lstatSync(alias);
      throw new Error(`Workspace normalization alias already exists: "${alias}".`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(name, alias);
    moved = true;
    const movedMetadata = lstatSync(alias);
    if (movedMetadata.isSymbolicLink() || !sameIdentity(movedMetadata, expected)) {
      throw new Error(`Workspace entry "${path}" changed during normalization.`);
    }
    chmodSync(alias, mode);
    childFd = openSync(
      alias,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0),
    );
    const opened = fstatSync(childFd);
    if (!sameIdentity(opened, expected)) throw new Error(`Workspace entry "${path}" changed during normalization.`);
    renameSync(alias, name);
    moved = false;
    const restored = lstatSync(name);
    if (restored.isSymbolicLink() || !sameIdentity(restored, expected)) {
      throw new Error(`Workspace entry "${path}" changed during normalization.`);
    }
    const result = childFd;
    childFd = undefined;
    return result;
  } finally {
    if (childFd !== undefined) closeSync(childFd);
    if (moved) {
      try {
        const current = lstatSync(alias);
        if (sameIdentity(current, expected)) {
          let destinationAbsent = false;
          try {
            lstatSync(name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") destinationAbsent = true;
            else throw error;
          }
          if (destinationAbsent) renameSync(alias, name);
        }
      } catch {
        // Preserve the original failure and let the root-level cleanup gate
        // decide whether the partial tree is still safe to retain.
      }
    }
    process.chdir(originalCwd);
    closeSync(parentFd);
  }
}

function readDirectoryEntries(directory: string, directoryFd: number): import("node:fs").Dirent[] {
  const alias = join(dirname(directory), `.ebo-enumeration-${randomUUID()}`);
  let moved = false;
  let handle: ReturnType<typeof opendirSync> | undefined;
  let expected: ReturnType<typeof fstatSync> | undefined;
  let parentFd: number | undefined;
  let parentExpected: ReturnType<typeof fstatSync> | undefined;
  try {
    expected = fstatSync(directoryFd);
    if (!sameIdentity(expected, lstatSync(directory))) {
      throw new Error(`Workspace directory "${directory}" changed during traversal.`);
    }
    parentFd = openSync(dirname(directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    parentExpected = fstatSync(parentFd);
    if (!sameIdentity(parentExpected, lstatSync(dirname(directory)))) {
      throw new Error(`Workspace parent "${dirname(directory)}" changed during traversal.`);
    }
    // Node's public Dir API does not expose its descriptor. Temporarily move
    // the already-verified inode to a private, unique pathname so opendirSync
    // opens that inode, then restore the public path while retaining the
    // handle. A raced replacement makes restoration or identity validation
    // fail closed instead of enumerating an unbound pathname.
    try {
      lstatSync(alias);
      throw new Error(`Workspace enumeration alias already exists: "${alias}".`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(directory, alias);
    moved = true;
    if (!sameIdentity(expected, lstatSync(alias))) {
      throw new Error(`Workspace directory "${directory}" changed during traversal.`);
    }
    handle = opendirSync(alias);
    if (!sameIdentity(expected, lstatSync(alias))) {
      throw new Error(`Workspace directory "${directory}" changed during traversal.`);
    }
    renameSync(alias, directory);
    moved = false;
    // Renaming a child updates the parent directory's mtime. Restore the
    // opened directory's timestamp so the operation stays digest-neutral.
    futimesSync(directoryFd, expected.atime, expected.mtime);
    if (parentFd !== undefined && parentExpected !== undefined) {
      futimesSync(parentFd, parentExpected.atime, parentExpected.mtime);
    }
    if (!sameIdentity(expected, lstatSync(directory))) {
      throw new Error(`Workspace directory "${directory}" changed during traversal.`);
    }
    const entries: import("node:fs").Dirent[] = [];
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (!sameIdentity(expected, fstatSync(directoryFd)) || !sameIdentity(expected, lstatSync(directory))) {
        throw new Error(`Workspace directory "${directory}" changed during traversal.`);
      }
      entries.push(entry);
    }
    if (!sameIdentity(expected, fstatSync(directoryFd)) || !sameIdentity(expected, lstatSync(directory))) {
      throw new Error(`Workspace directory "${directory}" changed during traversal.`);
    }
    return entries;
  } finally {
    handle?.closeSync();
    if (moved) {
      let aliasIsOwned = false;
      try {
        aliasIsOwned = expected !== undefined && sameIdentity(expected, lstatSync(alias));
      } catch {
        aliasIsOwned = false;
      }
      if (aliasIsOwned) {
        let destinationAbsent = false;
        try {
          lstatSync(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") destinationAbsent = true;
          else throw error;
        }
        if (destinationAbsent) {
          try {
            renameSync(alias, directory);
          } catch {
            if (expected !== undefined) {
              removeWorkspaceIfOwned(alias, { dev: Number(expected.dev), ino: Number(expected.ino) });
            }
          }
        } else if (expected !== undefined) {
          // Do not overwrite a raced replacement at the public path.
          removeWorkspaceIfOwned(alias, { dev: Number(expected.dev), ino: Number(expected.ino) });
        }
      }
    }
    if (parentFd !== undefined) closeSync(parentFd);
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
          hash.update(`file\0${relativePath}\0${metadata.mode & 0o7777n}\0${workspaceTimestamp(metadata)}\0${size}\0`);
          const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
          for (let offset = 0; offset < size;) {
            const read = readSync(childFd, bytes, 0, Math.min(bytes.length, size - offset), offset);
            if (read === 0) throw new Error(`Workspace file "${relativePath}" changed during fingerprinting.`);
            hash.update(bytes.subarray(0, read));
            offset += read;
          }
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
  const children = new Map<number, ChildProcess>();
  let spawnError: Error | undefined;
  let contextOpen = true;
  const context: WorkspaceSetupContext = {
    spawn(command, args, options) {
      if (!contextOpen) throw new Error("Workspace setup context is closed.");
      const child = spawnOwnedProcess(command, args, options);
      child.once("error", (error: unknown) => {
        spawnError = error instanceof Error ? error : new Error("Workspace setup child failed.");
      });
      if (child.pid !== undefined) children.set(child.pid, child);
      return child;
    },
  };
  try {
    for (const step of allSteps) {
      if (typeof step !== "function") throw new Error("Workspace setup steps must be functions.");
      await step(workspacePath, context);
    }
  } finally {
    contextOpen = false;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await reapSetupChildren(children);
    if (spawnError !== undefined) throw new Error(`Workspace setup child failed: ${spawnError.message}`);
  }
}

function spawnOwnedProcess(
  command: string,
  args: readonly string[] | undefined,
  options: SpawnOptions | undefined,
): ChildProcess {
  const ownedOptions = { ...options, detached: true };
  return args === undefined
    ? spawnProcess(command, ownedOptions) as ChildProcess
    : spawnProcess(command, args, ownedOptions) as ChildProcess;
}

async function reapSetupChildren(children: ReadonlyMap<number, ChildProcess>): Promise<void> {
  const waits: Array<Promise<void>> = [];
  for (const [pid, child] of children) {
    try {
      // A detached child is the leader of its own process group. Killing the
      // group also covers descendants that outlive their direct parent.
      process.kill(-pid, "SIGKILL");
    } catch {
      // The setup child may have exited between the process snapshot and kill.
    }
    waits.push(waitForChildExit(child).then(() => waitForProcessGroupExit(pid)));
  }
  await Promise.all(waits);
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Workspace setup process group did not terminate.");
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

async function isOwnedWorkspaceRoot(path: string, expected: WorkspaceIdentity): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink()
      && metadata.dev === expected.dev && metadata.ino === expected.ino
      && (await realpath(path)) === path;
  } catch {
    return false;
  }
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
    if (metadata.isSymbolicLink()) return false;
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
        if (removeQuarantinedWorkspace(quarantine, expected)) return true;
      }
      if (sameIdentity(moved, { dev: expected.dev, ino: expected.ino })) {
        try {
          lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") renameSync(quarantine, path);
        }
      }
      return false;
    } finally {
      closeSync(parentHandle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return expected === undefined;
    throw error;
  }
}

function removeQuarantinedWorkspace(path: string, expected: WorkspaceIdentity): boolean {
  let rootFd: number;
  try {
    rootFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") return false;
    try {
      normalizeUnreadableDirectory(path, expected);
      rootFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      return false;
    }
  }
  const originalCwd = process.cwd();
  try {
    if (!sameIdentity(fstatSync(rootFd), expected)) return false;
    process.chdir(path);
    const cwdFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(fstatSync(cwdFd), expected)) return false;
      removeDirectoryContentsFromCwd();
    } finally {
      closeSync(cwdFd);
    }
    process.chdir(originalCwd);
    const current = lstatSync(path);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, expected)) return false;
    rmdirSync(path);
    return true;
  } catch {
    return false;
  } finally {
    process.chdir(originalCwd);
    closeSync(rootFd);
  }
}

function removeDirectoryContentsFromCwd(): void {
  const handle = opendirSync(".");
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      removeDirectoryEntryFromCwd(entry.name, entry.isDirectory());
    }
  } finally {
    handle.closeSync();
  }
}

function removeDirectoryEntryFromCwd(name: string, directory: boolean): void {
  const current = lstatSync(name);
  if (current.isSymbolicLink()) {
    moveAndUnlinkFromCwd(name, current);
    return;
  }
  if (!current.isDirectory() && !current.isFile()) {
    moveAndUnlinkFromCwd(name, current);
    return;
  }
  const childFd = openChildSync(name, directory);
  try {
    const opened = fstatSync(childFd);
    if (!sameIdentity(current, opened)) throw new Error(`Workspace entry "${name}" changed during cleanup.`);
    if (opened.isDirectory()) moveAndRemoveDirectoryFromCwd(name, opened);
    else moveAndUnlinkFromCwd(name, opened);
  } finally {
    closeSync(childFd);
  }
}

function moveAndUnlinkFromCwd(name: string, expected: { dev: number; ino: number }): void {
  const alias = `.ebo-clean-${randomUUID()}`;
  try {
    lstatSync(alias);
    throw new Error(`Workspace cleanup alias already exists: "${alias}".`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  renameSync(name, alias);
  const moved = lstatSync(alias);
  if (!sameIdentity(moved, expected)) throw new Error(`Workspace entry "${name}" changed during cleanup.`);
  const final = lstatSync(alias);
  if (!sameIdentity(final, expected)) throw new Error(`Workspace entry "${name}" changed during cleanup.`);
  unlinkSync(alias);
}

function moveAndRemoveDirectoryFromCwd(
  name: string,
  expected: { dev: number; ino: number },
): void {
  const alias = `.ebo-clean-${randomUUID()}`;
  try {
    lstatSync(alias);
    throw new Error(`Workspace cleanup alias already exists: "${alias}".`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  renameSync(name, alias);
  let entered = false;
  try {
    if (!sameIdentity(lstatSync(alias), expected)) throw new Error(`Workspace entry "${name}" changed during cleanup.`);
    process.chdir(alias);
    entered = true;
    const cwdFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameIdentity(fstatSync(cwdFd), expected)) throw new Error(`Workspace entry "${name}" changed during cleanup.`);
      removeDirectoryContentsFromCwd();
    } finally {
      closeSync(cwdFd);
    }
  } finally {
    if (entered) process.chdir("..");
  }
  const final = lstatSync(join(".", alias));
  if (!final.isDirectory() || final.isSymbolicLink() || !sameIdentity(final, expected)) {
    throw new Error(`Workspace entry "${name}" changed during cleanup.`);
  }
  rmdirSync(alias);
}

function assertAttemptId(attemptId: string): void {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("Workspace attempt ID is unsafe.");
}

function normalizedFileMode(mode: number): number {
  return FILE_MODE | (mode & 0o100 ? 0o100 : 0);
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
