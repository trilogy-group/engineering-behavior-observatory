import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
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

export type VerifierWorkspace = {
  artifactId: string;
  digest: string;
};

export type DiagnosticReference = {
  locator: string;
  digest: string;
  sizeBytes: number;
  truncated: boolean;
};

export type VerifierResult = {
  schemaVersion: "verifier-result/v1";
  bundleId: string;
  status: "passed" | "failed" | "error" | "not-run";
  durationMs: number;
  exitCode?: number;
  workspace: VerifierWorkspace;
  assertions: VerifierAssertion[];
  diagnostics: DiagnosticReference[];
};

export type ExecuteVerifierOptions = {
  bundleId: string;
  verifierRoot: string;
  verifier: ArtifactReference;
  workspacePath: string;
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
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Execute a digest-pinned verifier in a private staging directory.
 *
 * The verifier receives the staged implementation path followed by the
 * evaluated workspace path. Its stdout is the assertion JSON protocol; stderr
 * is retained as bounded diagnostic evidence.
 */
export async function executeVerifier(options: ExecuteVerifierOptions): Promise<VerifierResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  validateOptions(options, timeoutMs, maxOutputBytes);

  const workspacePath = await realpath(options.workspacePath);
  const verifierRoot = await realpath(options.verifierRoot);
  const artifactRoot = await prepareRoot(options.artifactRoot);
  assertDisjointRoots(workspacePath, verifierRoot, "Verifier and workspace roots");
  assertDisjointRoots(workspacePath, artifactRoot, "Artifact and workspace roots");
  assertDisjointRoots(verifierRoot, artifactRoot, "Verifier and artifact roots");

  const diagnosticDirectory = options.diagnosticDirectory ?? "diagnostics";
  if (!isSafeArtifactRelativePath(diagnosticDirectory)) {
    throw new Error(`Diagnostic directory "${diagnosticDirectory}" is unsafe.`);
  }

  let stdout: CapturedOutput = emptyOutput();
  let stderr: CapturedOutput = emptyOutput();
  let exitCode: number | undefined;
  let status: VerifierResult["status"] = "error";
  let assertions: VerifierAssertion[] = [];
  let internalError: string | undefined;
  let stagingRoot: string | undefined;

  try {
    const verifierBytes = await readVerifiedArtifact(verifierRoot, options.verifier.locator, options.verifier.digest);
    stagingRoot = await mkdtemp(join(tmpdir(), "ebo-verifier-"));
    const stagedVerifier = join(stagingRoot, "verifier");
    await writePrivateFile(stagedVerifier, verifierBytes);

    const processResult = await runProcess(
      options.command ?? process.execPath,
      [...(options.args ?? []), stagedVerifier, workspacePath],
      workspacePath,
      options.env,
      timeoutMs,
      maxOutputBytes,
    );
    stdout = processResult.stdout;
    stderr = processResult.stderr;
    exitCode = processResult.exitCode;
    if (processResult.error !== undefined) internalError = processResult.error;

    try {
      assertions = parseAssertions(stdout.bytes);
    } catch (error) {
      internalError = error instanceof Error ? error.message : "Verifier output is invalid.";
    }

    if (internalError === undefined && processResult.signal === undefined && exitCode !== undefined) {
      if (assertions.some((assertion) => assertion.status === "failed")) {
        status = "failed";
      } else if (exitCode === 0 && assertions.every((assertion) => assertion.status === "passed")) {
        status = "passed";
      } else {
        internalError = "Verifier exit status contradicts its assertions.";
      }
    }
    if (processResult.timedOut) internalError = `Verifier timed out after ${timeoutMs} ms.`;
    else if (processResult.signal !== undefined) internalError = `Verifier terminated by ${processResult.signal}.`;
  } catch (error) {
    internalError = error instanceof Error ? error.message : "Verifier could not be executed.";
  } finally {
    if (stagingRoot !== undefined) await rm(stagingRoot, { force: true, recursive: true });
  }

  if (internalError !== undefined) {
    stderr = appendDiagnostic(stderr, internalError, maxOutputBytes);
    status = "error";
  }

  const diagnostics = await writeDiagnostics(artifactRoot, diagnosticDirectory, stdout, stderr);
  const result: VerifierResult = {
    schemaVersion: "verifier-result/v1",
    bundleId: options.bundleId,
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(exitCode === undefined ? {} : { exitCode }),
    workspace: options.workspace,
    assertions,
    diagnostics,
  };
  assertVerifierResult(result, "verifier-result");
  return result;
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
  for (const diagnostic of result.diagnostics) {
    const bytes = await readVerifiedArtifact(artifactRoot, diagnostic.locator, {
      algorithm: "sha256",
      value: diagnostic.digest.slice("sha256:".length),
    });
    if (bytes.length !== diagnostic.sizeBytes) {
      throw new Error(`Diagnostic "${diagnostic.locator}" size does not match its result reference.`);
    }
  }
  return writeMetadataAtomically(artifactRoot, relativePath, result);
}

function validateOptions(options: ExecuteVerifierOptions, timeoutMs: number, maxOutputBytes: number): void {
  if (options.bundleId.trim() === "") throw new Error("Bundle ID must not be blank.");
  if (options.workspace.artifactId.trim() === "" || !/^sha256:[a-f0-9]{64}$/.test(options.workspace.digest)) {
    throw new Error("Workspace reference is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Verifier timeout must be a positive safe integer.");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`Verifier output limit must be between 0 and ${MAX_OUTPUT_BYTES} bytes.`);
  }
}

async function prepareRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return realpath(root);
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
};

type ProcessResult = {
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
): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd,
    env: overrides === undefined ? { PATH: process.env.PATH ?? "" } : cleanEnvironment(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = capture(child.stdout, maxOutputBytes);
  const stderr = capture(child.stderr, maxOutputBytes);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();

  return new Promise<ProcessResult>((resolveProcess) => {
    let error: string | undefined;
    child.once("error", (cause) => {
      error = cause.message;
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      resolveProcess({
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

function capture(stream: NodeJS.ReadableStream | null, limit: number): Promise<CapturedOutput> {
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
      }
      truncated ||= retained.length < bytes.length;
    });
    stream.once("error", () => {
      if (!settled) {
        settled = true;
        resolveCapture({ bytes: Buffer.concat(chunks), truncated: true });
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

function appendDiagnostic(output: CapturedOutput, message: string, limit: number): CapturedOutput {
  const prefix = Buffer.from(`${message}\n`);
  const bytes = Buffer.concat([prefix, output.bytes]).subarray(0, limit);
  return { bytes, truncated: output.truncated || bytes.length < prefix.length + output.bytes.length };
}

function parseAssertions(bytes: Buffer): VerifierAssertion[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.assertions) || parsed.assertions.length === 0) {
    throw new Error("Verifier output must contain a non-empty assertions array.");
  }
  const identifiers = new Set<string>();
  return parsed.assertions.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === ""
        || !["passed", "failed", "not-run"].includes(String(value.status)) || identifiers.has(value.id)) {
      throw new Error("Verifier output contains an invalid or duplicate assertion.");
    }
    identifiers.add(value.id);
    return { id: value.id, status: value.status as VerifierAssertionStatus };
  });
}

async function writeDiagnostics(
  artifactRoot: string,
  directory: string,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
): Promise<DiagnosticReference[]> {
  return Promise.all([
    writeDiagnostic(artifactRoot, join(directory, "stdout.log"), stdout),
    writeDiagnostic(artifactRoot, join(directory, "stderr.log"), stderr),
  ]);
}

async function writeDiagnostic(root: string, locator: string, output: CapturedOutput): Promise<DiagnosticReference> {
  if (!isSafeArtifactRelativePath(locator)) throw new Error(`Diagnostic locator "${locator}" is unsafe.`);
  const rootPath = await realpath(root);
  const { parent, path } = await prepareDiagnosticPath(rootPath, locator);
  const temporaryPath = join(parent, `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(output.bytes);
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
  const digest = digestBytes(output.bytes);
  return {
    locator,
    digest: `sha256:${digest.value}`,
    sizeBytes: output.bytes.length,
    truncated: output.truncated,
  };
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
