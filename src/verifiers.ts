import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import {
  assertNoDuplicateJsonKeys,
  canonicalizeMetadata,
  digestBytes,
  readVerifiedArtifact,
  validateArtifact,
  writeMetadataAtomically,
} from "./artifacts.js";
import { isSafeArtifactRelativePath, type ArtifactReference } from "./contracts.js";

export type VerifierAssertionStatus = "passed" | "failed" | "not-run";

export type VerifierAssertion = {
  id: string;
  status: VerifierAssertionStatus;
};

export type VerifierPassedAssertion = Omit<VerifierAssertion, "status"> & {
  status: "passed";
};

export type VerifierNotRunAssertion = Omit<VerifierAssertion, "status"> & {
  status: "not-run";
};

export type VerifierWorkspace = {
  artifactId: string;
  digest: string;
  fingerprint?: string;
};

export type DiagnosticReference = {
  stream: "stdout" | "stderr";
  locator: string;
  digest: string;
  sizeBytes: number;
  truncated: boolean;
};

export type VerifierExecutionReference = {
  locator: string;
  digest: string;
};

type VerifierResultBase = {
  schemaVersion: "verifier-result/v1";
  bundleId: string;
  durationMs?: number;
  error?: string;
  verifier?: VerifierExecutionReference;
  assertions: VerifierAssertion[];
  diagnostics?: DiagnosticReference[];
};

export type VerifierPassedResult = Omit<VerifierResultBase, "error" | "assertions"> & {
  status: "passed";
  error?: never;
  exitCode?: 0;
  workspace: VerifierWorkspace;
  assertions: VerifierPassedAssertion[];
};

export type VerifierFailedResult = Omit<VerifierResultBase, "error"> & {
  status: "failed";
  error?: never;
  exitCode: number;
  workspace: VerifierWorkspace;
};

export type VerifierRunResult = VerifierPassedResult | VerifierFailedResult | VerifierErrorResult;

export type VerifierErrorResult = VerifierResultBase & {
  status: "error";
  error: string;
  exitCode?: number;
  workspace?: VerifierWorkspace;
};

export type VerifierNotRunResult = Omit<VerifierResultBase, "durationMs" | "diagnostics" | "assertions"> & {
  status: "not-run";
  durationMs?: never;
  diagnostics?: never;
  workspace?: never;
  exitCode?: never;
  assertions: VerifierNotRunAssertion[];
};

export type VerifierResult = VerifierRunResult | VerifierNotRunResult;

type CompleteResultFields = {
  durationMs: number;
  diagnostics: DiagnosticReference[];
};

export type CompleteVerifierResult =
  | (VerifierPassedResult & CompleteResultFields)
  | (VerifierFailedResult & CompleteResultFields)
  | (VerifierErrorResult & CompleteResultFields & { workspace: VerifierWorkspace });

export type ExecuteVerifierOptions = {
  bundleId: string;
  verifierRoot: string;
  verifier: ArtifactReference;
  workspacePath: string;
  workspaceFingerprint: string;
  workspace: VerifierWorkspace;
  artifactRoot: string;
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  diagnosticDirectory?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const RESERVED_MANIFEST_PATHS = new Set(["manifest.json"]);

export async function digestWorkspace(workspacePath: string): Promise<string> {
  const root = await realpath(workspacePath);
  const hash = createHash("sha256");
  hash.update("ebo.workspace/v1\0");
  const metadata = await lstat(root, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Workspace root is not a directory.");
  hash.update(`root\0${metadata.mode & 0o7777n}\0${metadata.mtimeNs}\0`);
  await hashWorkspaceDirectory(root, "", hash);
  return `sha256:${hash.digest("hex")}`;
}

async function hashWorkspaceDirectory(
  directory: string,
  relativeDirectory: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = posix.join(relativeDirectory, entry.name);
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink()) throw new Error(`Workspace contains a symbolic link at "${relativePath}".`);
    if (metadata.isDirectory()) {
      hash.update(`directory\0${relativePath}\0${metadata.mode & 0o7777n}\0${metadata.mtimeNs}\0`);
      await hashWorkspaceDirectory(path, relativePath, hash);
    } else if (metadata.isFile()) {
      if (metadata.nlink > 1n) throw new Error(`Workspace contains a hard-linked file at "${relativePath}".`);
      const bytes = await readFile(path);
      hash.update(`file\0${relativePath}\0${metadata.mode & 0o7777n}\0${metadata.mtimeNs}\0${bytes.length}\0`);
      hash.update(bytes);
    } else {
      throw new Error(`Workspace contains an unsupported entry at "${relativePath}".`);
    }
  }
}

async function restoreWorkspaceTimestamps(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const metadata = await lstat(sourcePath, { bigint: true });
    if (metadata.isSymbolicLink()) throw new Error(`Workspace contains a symbolic link at "${entry.name}".`);
    if (metadata.isDirectory()) {
      await restoreWorkspaceTimestamps(sourcePath, destinationPath);
    } else if (!metadata.isFile()) {
      throw new Error(`Workspace contains an unsupported entry at "${entry.name}".`);
    }
    await utimes(destinationPath, timestampSeconds(metadata.atimeMs), timestampSeconds(metadata.mtimeMs));
  }
  const metadata = await lstat(source, { bigint: true });
  await utimes(destination, timestampSeconds(metadata.atimeMs), timestampSeconds(metadata.mtimeMs));
}

function timestampSeconds(milliseconds: bigint): number {
  return Number(milliseconds) / 1_000 + 0.000001;
}

/**
 * Execute a digest-pinned verifier in a private staging directory.
 *
 * The verifier receives the staged implementation path followed by the
 * evaluated workspace path. Its stdout is the assertion JSON protocol; stderr
 * is retained as bounded diagnostic evidence.
 */
export async function executeVerifier(options: ExecuteVerifierOptions): Promise<CompleteVerifierResult> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  validateOptions(options, timeoutMs, maxOutputBytes);

  const workspacePath = await realpath(options.workspacePath);
  const verifierRoot = await realpath(options.verifierRoot);
  const artifactCandidate = await resolveRootPath(options.artifactRoot);
  assertDisjointRoots(workspacePath, verifierRoot, "Verifier and workspace roots");
  assertDisjointRoots(workspacePath, artifactCandidate, "Artifact and workspace roots");
  assertDisjointRoots(verifierRoot, artifactCandidate, "Verifier and artifact roots");
  if (options.workspaceFingerprint !== await digestWorkspace(workspacePath)) {
    throw new Error("Workspace fingerprint does not match the evaluated workspace.");
  }
  const artifactRoot = await prepareRoot(artifactCandidate);

  const diagnosticDirectory = options.diagnosticDirectory ?? "diagnostics";
  if (!isSafeArtifactRelativePath(diagnosticDirectory)) {
    throw new Error(`Diagnostic directory "${diagnosticDirectory}" is unsafe.`);
  }
  if (hasPortablePathCollision(diagnosticDirectory.toLowerCase(), RESERVED_MANIFEST_PATHS)) {
    throw new Error("Diagnostic directory collides with the reserved manifest path.");
  }
  const executionDiagnosticDirectory = posix.join(diagnosticDirectory, randomUUID());
  const diagnosticSetup = await openDiagnosticFiles(artifactRoot, executionDiagnosticDirectory);
  const diagnosticFiles = diagnosticSetup.files;

  try {
    let stdout: CapturedOutput = emptyOutput();
    let stderr: CapturedOutput = emptyOutput();
    let exitCode: number | undefined;
    let status: CompleteVerifierResult["status"] = "error";
    let assertions: VerifierAssertion[] = [];
    let internalError: string | undefined = diagnosticSetup.error;
    let stagingRoot: string | undefined;
    let evaluatedWorkspaceFingerprint: string | undefined;
    let spawnAttempted = false;

    try {
      if (internalError === undefined) {
        const verifierBytes = await readVerifiedArtifact(verifierRoot, options.verifier.locator, options.verifier.digest);
        stagingRoot = await createStagingRoot(workspacePath);
        const evaluatedWorkspacePath = join(stagingRoot, "workspace");
        await cp(workspacePath, evaluatedWorkspacePath, { recursive: true, force: false, preserveTimestamps: true });
        await restoreWorkspaceTimestamps(workspacePath, evaluatedWorkspacePath);
        if (await digestWorkspace(workspacePath) !== options.workspaceFingerprint) {
          throw new Error("Workspace changed while its private evaluation snapshot was being created.");
        }
        evaluatedWorkspaceFingerprint = await digestWorkspace(evaluatedWorkspacePath);
        const stagedVerifier = join(stagingRoot, "verifier");
        await writePrivateFile(stagedVerifier, verifierBytes);

        const processResult = await runProcess(
          options.command ?? process.execPath,
          [...(options.args ?? []), stagedVerifier, evaluatedWorkspacePath],
          evaluatedWorkspacePath,
          options.env,
          timeoutMs,
          maxOutputBytes,
          diagnosticFiles as [DiagnosticFile, DiagnosticFile],
        );
        stdout = processResult.stdout;
        stderr = processResult.stderr;
        exitCode = processResult.exitCode;
        spawnAttempted = processResult.started;
        if (processResult.error !== undefined) internalError = processResult.error;
        if (stdout.error !== undefined) internalError = combineErrors(internalError, `stdout capture failed: ${stdout.error}`);
        if (stderr.error !== undefined) internalError = combineErrors(internalError, `stderr capture failed: ${stderr.error}`);

        if (internalError === undefined) {
          if (stdout.truncated) {
            internalError = `Verifier stdout exceeded ${maxOutputBytes} bytes.`;
          } else {
            try {
              assertions = parseAssertions(stdout.bytes);
            } catch (error) {
              internalError = error instanceof Error ? error.message : "Verifier output is invalid.";
            }
          }
        }

        if (internalError === undefined && processResult.signal === undefined && exitCode !== undefined) {
          if (assertions.some((assertion) => assertion.status === "failed")) {
            if (exitCode === 0) {
              internalError = "Verifier exit status contradicts its failed assertions.";
            } else {
              status = "failed";
            }
          } else if (exitCode === 0 && assertions.every((assertion) => assertion.status === "passed")) {
            status = "passed";
          } else {
            internalError = "Verifier exit status contradicts its assertions.";
          }
        }
        if (processResult.timedOut) internalError = combineErrors(internalError, `Verifier timed out after ${timeoutMs} ms.`);
        else if (processResult.signal !== undefined) internalError = combineErrors(internalError, `Verifier terminated by ${processResult.signal}.`);
      }
    } catch (error) {
      internalError = error instanceof Error ? error.message : "Verifier could not be executed.";
    } finally {
      if (stagingRoot !== undefined) {
        await rm(stagingRoot, { force: true, recursive: true }).catch((error: unknown) => {
          internalError = combineErrors(internalError, error instanceof Error ? error.message : "Verifier staging cleanup failed.");
        });
      }
    }

    if (internalError !== undefined) status = "error";

    await finalizeDiagnosticFiles(diagnosticFiles);
    if (diagnosticFiles.some((file) => file.error !== undefined)) {
      status = "error";
      internalError = combineErrors(internalError, "Verifier diagnostics could not be persisted.");
    }
    let diagnostics: DiagnosticReference[] = [];
    if (!spawnAttempted) {
      const cleanupError = await removeDiagnosticFiles(artifactRoot, diagnosticFiles);
      if (cleanupError !== undefined) {
        status = "error";
        internalError = combineErrors(internalError, cleanupError);
      }
    } else {
      const references = await Promise.all(diagnosticFiles.map((file, index) =>
        diagnosticReference(artifactRoot, file, index === 0 ? "stdout" : "stderr", index === 0 ? stdout : stderr)));
      if (references.some((reference) => reference === undefined)) {
        status = "error";
        internalError = combineErrors(internalError, "Verifier diagnostics could not be verified.");
      }
      diagnostics = references.flatMap((reference) => reference === undefined ? [] : [reference]);
    }
    const result = {
      schemaVersion: "verifier-result/v1",
      bundleId: options.bundleId,
      status,
      verifier: {
        locator: options.verifier.locator,
        digest: `sha256:${options.verifier.digest.value}`,
      },
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(internalError === undefined ? {} : { error: internalError }),
      ...(exitCode === undefined ? {} : { exitCode }),
      workspace: {
        ...options.workspace,
        ...(evaluatedWorkspaceFingerprint === undefined ? {} : { fingerprint: evaluatedWorkspaceFingerprint }),
      },
      assertions,
      diagnostics,
    } as CompleteVerifierResult;
    assertVerifierResult(result, "verifier-result");
    return result;
  } finally {
    await finalizeDiagnosticFiles(diagnosticFiles);
  }
}

function combineErrors(current: string | undefined, next: string): string {
  return current === undefined ? next : `${current}; ${next}`;
}

export function serializeVerifierResult(result: VerifierResult): string {
  assertVerifierResult(result, "verifier-result");
  return canonicalizeMetadata(result);
}

export async function writeVerifierResult(
  artifactRoot: string,
  relativePath: string,
  result: VerifierResult,
): Promise<{ algorithm: "sha256"; value: string }> {
  assertVerifierResult(result, relativePath);
  const resultLocator = relativePath.toLowerCase();
  if (hasPortablePathCollision(resultLocator, RESERVED_MANIFEST_PATHS)) {
    throw new Error("Verifier result path collides with the reserved manifest path.");
  }
  const diagnosticLocators = new Set((result.diagnostics ?? []).map((diagnostic) => diagnostic.locator.toLowerCase()));
  if ([...diagnosticLocators].some((locator) => hasPortablePathCollision(locator, RESERVED_MANIFEST_PATHS))) {
    throw new Error("Verifier diagnostic locator collides with the reserved manifest path.");
  }
  if (hasPortablePathCollision(resultLocator, diagnosticLocators)) {
    throw new Error("Verifier result path collides with a diagnostic locator.");
  }
  for (const diagnostic of result.diagnostics ?? []) {
    const bytes = await readVerifiedArtifact(artifactRoot, diagnostic.locator, {
      algorithm: "sha256",
      value: diagnostic.digest.slice("sha256:".length),
    });
    if (bytes.length !== diagnostic.sizeBytes) {
      throw new Error(`Diagnostic "${diagnostic.locator}" size does not match its result reference.`);
    }
  }
  return writeMetadataAtomically(artifactRoot, relativePath, result, undefined, { overwrite: false });
}

function validateOptions(options: ExecuteVerifierOptions, timeoutMs: number, maxOutputBytes: number): void {
  if (!isValidIdentifier(options.bundleId)) throw new Error("Bundle ID is invalid.");
  if (!isValidIdentifier(options.workspace.artifactId) || !/^sha256:[a-f0-9]{64}$/.test(options.workspace.digest)) {
    throw new Error("Workspace reference is invalid.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(options.workspaceFingerprint)) {
    throw new Error("Workspace fingerprint is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Verifier timeout must be between 1 and ${MAX_TIMEOUT_MS} ms.`);
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`Verifier output limit must be between 0 and ${MAX_OUTPUT_BYTES} bytes.`);
  }
}

function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && [...value].length <= 256;
}

async function prepareRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return realpath(root);
}

async function resolveRootPath(root: string): Promise<string> {
  const absoluteRoot = resolve(root);
  try {
    return await realpath(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absoluteRoot);
    if (parent === absoluteRoot) return absoluteRoot;
    return resolve(await resolveRootPath(parent), basename(absoluteRoot));
  }
}

async function createStagingRoot(workspacePath: string): Promise<string> {
  const candidates = [
    tmpdir(),
    ...(process.platform === "win32"
      ? (process.env.SystemRoot === undefined ? [] : [join(process.env.SystemRoot, "Temp")])
      : ["/tmp", "/var/tmp"]),
  ];
  let lastError: unknown;

  for (const candidate of new Set(candidates)) {
    let resolvedStagingRoot: string;
    try {
      const candidateRoot = await realpath(candidate);
      if (isContained(workspacePath, candidateRoot)) {
        lastError = new Error("temporary directory candidate is inside the evaluated workspace");
        continue;
      }
      resolvedStagingRoot = await realpath(await mkdtemp(join(candidateRoot, "ebo-verifier-")));
    } catch (error) {
      lastError = error;
      continue;
    }
    if (isContained(workspacePath, resolvedStagingRoot) || isContained(resolvedStagingRoot, workspacePath)) {
      await rm(resolvedStagingRoot, { force: true, recursive: true });
      lastError = new Error("temporary directory is inside the evaluated workspace");
      continue;
    }
    return resolvedStagingRoot;
  }

  throw new Error(`Could not create verifier staging outside the evaluated workspace: ${lastError instanceof Error ? lastError.message : "no separate temporary directory is available."}`);
}

function assertDisjointRoots(left: string, right: string, label: string): void {
  if (isContained(left, right) || isContained(right, left)) {
    throw new Error(`${label} must be separate.`);
  }
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o700);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type CapturedOutput = {
  bytes: Buffer;
  truncated: boolean;
  error?: string;
};

type ProcessResult = {
  started: boolean;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  exitCode?: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  error?: string;
};

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  overrides: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  maxOutputBytes: number,
  diagnosticFiles: readonly DiagnosticFile[],
): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd,
    env: overrides === undefined ? { PATH: process.env.PATH ?? "" } : cleanEnvironment(overrides),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = capture(child.stdout, maxOutputBytes, diagnosticFiles[0]);
  const stderr = capture(child.stderr, maxOutputBytes, diagnosticFiles[1]);
  let started = false;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => termination ??= killProcessTree(child);
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate().catch(() => undefined);
  }, timeoutMs);
  timer.unref();

  return new Promise<ProcessResult>((resolveProcess) => {
    let error: string | undefined;
    child.once("spawn", () => {
      started = true;
    });
    child.once("error", (cause) => {
      error = cause.message;
    });
    child.once("exit", () => {
      void terminate().catch(() => undefined);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      await terminate();
      resolveProcess({
        started,
        stdout: await stdout,
        stderr: await stderr,
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
        timedOut,
        ...(error === undefined ? {} : { error }),
      });
    });
  });
}

async function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolveKiller) => killer.once("close", () => resolveKiller()));
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function capture(stream: NodeJS.ReadableStream | null, limit: number, diagnosticFile?: DiagnosticFile): Promise<CapturedOutput> {
  if (stream === null) return Promise.resolve(emptyOutput());
  return new Promise<CapturedOutput>((resolveCapture) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = bytes.subarray(0, Math.max(0, limit - size));
      if (retained.length > 0) {
        chunks.push(retained);
        size += retained.length;
        if (diagnosticFile !== undefined) queueDiagnosticWrite(diagnosticFile, retained);
      }
      truncated ||= retained.length < bytes.length;
    });
    stream.once("error", (error: unknown) => {
      if (!settled) {
        settled = true;
        resolveCapture({
          bytes: Buffer.concat(chunks),
          truncated,
          error: error instanceof Error ? error.message : "unknown stream error",
        });
      }
    });
    stream.once("end", () => {
      if (!settled) {
        settled = true;
        resolveCapture({ bytes: Buffer.concat(chunks), truncated });
      }
    });
  });
}

function emptyOutput(): CapturedOutput {
  return { bytes: Buffer.alloc(0), truncated: false };
}

function parseAssertions(bytes: Buffer): VerifierAssertion[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  assertNoDuplicateJsonKeys(text);
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["assertions"]) || !Array.isArray(parsed.assertions)
      || parsed.assertions.length === 0) {
    throw new Error("Verifier output must contain a non-empty assertions array.");
  }
  const identifiers = new Set<string>();
  return parsed.assertions.map((value) => {
    if (!isRecord(value) || !hasExactKeys(value, ["id", "status"]) || typeof value.id !== "string"
        || value.id.trim() === "" || [...value.id].length > 256
        || typeof value.status !== "string" || !["passed", "failed", "not-run"].includes(value.status)
        || identifiers.has(value.id)) {
      throw new Error("Verifier output contains an invalid or duplicate assertion.");
    }
    identifiers.add(value.id);
    return { id: value.id, status: value.status as VerifierAssertionStatus };
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

type DiagnosticFile = {
  locator: string;
  handle: Awaited<ReturnType<typeof open>>;
  writes: Promise<void>;
  error?: string;
  closed: boolean;
};

type DiagnosticSetup = {
  files: DiagnosticFile[];
  error?: string;
};

async function openDiagnosticFiles(root: string, directory: string): Promise<DiagnosticSetup> {
  const files: DiagnosticFile[] = [];
  try {
    for (const stream of ["stdout", "stderr"]) {
      const locator = posix.join(directory, `${stream}.log`);
      if (!isSafeArtifactRelativePath(locator)) throw new Error(`Diagnostic locator "${locator}" is unsafe.`);
      const rootPath = await realpath(root);
      const { path } = await prepareDiagnosticPath(rootPath, locator);
      files.push({ locator, handle: await open(path, "wx", 0o600), writes: Promise.resolve(), closed: false });
    }
    return { files };
  } catch (error) {
    await finalizeDiagnosticFiles(files);
    let setupError = error instanceof Error ? error.message : "Verifier diagnostic setup failed.";
    const cleanupError = await removeDiagnosticFiles(root, files);
    if (cleanupError !== undefined) setupError = combineErrors(setupError, cleanupError);
    return {
      files: [],
      error: setupError,
    };
  }
}

async function removeDiagnosticFiles(root: string, files: readonly DiagnosticFile[]): Promise<string | undefined> {
  let error: string | undefined;
  for (const file of files) {
    await rm(resolve(root, file.locator), { force: true }).catch((cleanupError: unknown) => {
      error = combineErrors(error, cleanupError instanceof Error ? cleanupError.message : "Verifier diagnostic cleanup failed.");
    });
  }
  return error;
}

function queueDiagnosticWrite(file: DiagnosticFile, bytes: Uint8Array): void {
  if (bytes.length === 0 || file.closed) return;
  file.writes = file.writes.then(async () => {
    await file.handle.write(bytes);
  }).catch((error: unknown) => {
    file.error = error instanceof Error ? error.message : "Diagnostic write failed.";
  });
}

async function finalizeDiagnosticFiles(files: readonly DiagnosticFile[]): Promise<void> {
  await Promise.all(files.map(async (file) => {
    if (file.closed) return;
    await file.writes;
    await file.handle.sync().catch((error: unknown) => {
      file.error ??= error instanceof Error ? error.message : "Diagnostic flush failed.";
    });
    await file.handle.close().catch((error: unknown) => {
      file.error ??= error instanceof Error ? error.message : "Diagnostic close failed.";
    });
    file.closed = true;
  }));
}

async function diagnosticReference(
  root: string,
  file: DiagnosticFile,
  stream: "stdout" | "stderr",
  output: CapturedOutput,
): Promise<DiagnosticReference | undefined> {
  const digest = digestBytes(output.bytes);
  try {
    const bytes = await readVerifiedArtifact(root, file.locator, digest);
    return {
      stream,
      locator: file.locator,
      digest: `sha256:${digest.value}`,
      sizeBytes: bytes.length,
      truncated: output.truncated,
    };
  } catch {
    return undefined;
  }
}

function hasPortablePathCollision(path: string, existingPaths: ReadonlySet<string>): boolean {
  return [...existingPaths].some((existing) => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`));
}

async function prepareDiagnosticPath(root: string, locator: string): Promise<{ parent: string; path: string }> {
  const segments = locator.split("/");
  let parent = root;

  for (const segment of segments.slice(0, -1)) {
    parent = resolve(parent, segment);
    await mkdir(parent, { recursive: true });
    const entry = await lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Diagnostic locator "${locator}" crosses a symbolic link.`);
    }
  }

  const path = resolve(parent, segments.at(-1)!);
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Diagnostic locator "${locator}" is not an isolated regular file.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { parent, path };
}

function assertVerifierResult(result: VerifierResult, artifact: string): void {
  if (new Set(result.assertions.map((assertion) => assertion.id)).size !== result.assertions.length) {
    throw new Error("Verifier assertion IDs must be unique.");
  }
  if (result.status === "failed" && (result.exitCode === undefined || result.exitCode === 0)
      && result.assertions.some((assertion) => assertion.status === "failed")) {
    throw new Error("Verifier exit status contradicts its failed assertions.");
  }
  const errors = validateArtifact(artifact, result);
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `${error.field}: ${error.message}`).join("; "));
  }
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
