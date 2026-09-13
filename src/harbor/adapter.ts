import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, mkdtempSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HARBOR_ADAPTER_PROTOCOL_VERSION, HARBOR_ADAPTER_SCRIPT } from "./adapter-script.js";

/** Exact-version pin of the official Harbor package used for task semantics. */
export const HARBOR_PACKAGE_PIN = "0.23.0";
/** Task schema version observed at the pinned Harbor release (informational; Harbor validates it). */
export const HARBOR_TASK_SCHEMA_VERSION = "1.4";
/** Environment variable that overrides Python interpreter resolution. */
export const EBO_HARBOR_PYTHON = "EBO_HARBOR_PYTHON";
/** Environment variable that overrides the adapter's temp-file strategy for tests. */
export const EBO_HARBOR_ADAPTER_DIR = "EBO_HARBOR_ADAPTER_DIR";

const MAX_ADAPTER_OUTPUT_BYTES = 64 * 1024 * 1024;

export type HarborAdapterErrorKind =
  | "harbor-unavailable"
  | "harbor-version-mismatch"
  | "adapter-protocol"
  | "task-invalid"
  | "environment-prerequisite-missing"
  | (string & {});

export class HarborAdapterError extends Error {
  public readonly kind: HarborAdapterErrorKind;
  public constructor(kind: HarborAdapterErrorKind, message: string) {
    super(message);
    this.name = "HarborAdapterError";
    this.kind = kind;
  }
}

export type HarborVersionInfo = {
  harborVersion: string;
  defaultTaskSchemaVersion: string;
  pythonVersion: string;
};

export type HarborIdentity = {
  digest: string;
  includedFiles: string[];
  excludedFiles: string[];
};

export type HarborInstruction = {
  step: string | null;
  instruction: string;
  sha256: string;
};

export type HarborTaskLockJson = {
  name: string;
  version: string | null;
  type: "local" | "git" | "package";
  digest: string;
  source: string | null;
  path: string | null;
  git_url: string | null;
  git_commit_id: string | null;
};

export type HarborLockResolution = {
  taskLock: HarborTaskLockJson;
  trialLock: Record<string, unknown>;
};

export type HarborDockerPreflight = {
  available: boolean;
  reason: string | null;
};

export type AdapterPython = (arguments_: readonly string[]) => Promise<AdapterRunResult>;

export type AdapterRunResult = { stdout: string; stderr: string; code: number | null };

const scriptDigest = createHash("sha256").update(HARBOR_ADAPTER_SCRIPT, "utf8").digest("hex");
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
let cachedScriptPath: string | undefined;

function materializeAdapterScript(): string {
  if (cachedScriptPath !== undefined) return cachedScriptPath;
  const parent = process.env[EBO_HARBOR_ADAPTER_DIR] ?? mkdtempSync(join(tmpdir(), "ebo-harbor-adapter-"));
  const path = join(parent, `ebo_harbor_adapter_${scriptDigest.slice(0, 16)}.py`);
  const descriptor = openSync(path, "w", 0o600);
  try {
    writeSync(descriptor, HARBOR_ADAPTER_SCRIPT, undefined, "utf8");
    chmodSync(path, 0o600);
  } finally {
    closeSync(descriptor);
  }
  cachedScriptPath = path;
  return path;
}

/** Visible for tests: discard the cached script path so a fresh copy is written. */
export function resetAdapterScriptCache(): void {
  if (cachedScriptPath === undefined) return;
  const path = cachedScriptPath;
  cachedScriptPath = undefined;
  try {
    unlinkSync(path);
  } catch {
    // Best effort only; the file lives in an attempt-owned temp directory.
  }
}

async function defaultPython(arguments_: readonly string[]): Promise<AdapterRunResult> {
  const [command, ...rest] = arguments_;
  if (command === undefined) throw new HarborAdapterError("adapter-protocol", "Python interpreter could not be resolved.");
  return new Promise<AdapterRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, rest, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length <= MAX_ADAPTER_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length <= MAX_ADAPTER_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => rejectPromise(error));
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

function candidateInterpreters(): string[] {
  const candidates: string[] = [];
  const override = process.env[EBO_HARBOR_PYTHON];
  if (override !== undefined && override !== "") candidates.push(override);
  for (const base of [process.cwd(), dirname(moduleDirectory), dirname(dirname(moduleDirectory)), dirname(dirname(dirname(moduleDirectory)))]) {
    candidates.push(join(base, ".harbor-venv", "bin", "python"));
    candidates.push(join(base, ".harbor-venv", "bin", "python3"));
  }
  candidates.push("python3", "python");
  return [...new Set(candidates)];
}

export type HarborAdapter = {
  version(): Promise<HarborVersionInfo>;
  inspect(taskDir: string, options?: { disableVerification?: boolean }): Promise<HarborInspectResult>;
  identity(taskDir: string): Promise<HarborIdentity>;
  instructions(taskDir: string, options?: { disableVerification?: boolean; extraInstructions?: readonly string[] }): Promise<HarborInstruction[]>;
  lock(taskDir: string): Promise<HarborLockResolution>;
  dockerPreflight(): Promise<HarborDockerPreflight>;
  /** Machine-readable prerequisite report used by acceptance evidence. */
  describePrerequisites(): Promise<{ python: string; version: HarborVersionInfo | null; docker: HarborDockerPreflight | null }>;
};

export type HarborInspectResult = {
  name: string;
  shortName: string;
  version: string | null;
  schemaVersion: string;
  hasSteps: boolean;
  steps: Array<{ name: string; minReward: number | Record<string, number> | null; verifierTimeoutSec: number; agentTimeoutSec: number | null }>;
  metadataKeys: string[];
  environment: {
    os: string;
    dockerImage: string | null;
    cpus: number | null;
    memoryMb: number | null;
    storageMb: number | null;
    gpus: number | null;
    gpuTypes: string[] | null;
    tpu: boolean;
    networkMode: string;
    allowInternet: boolean | null;
    mcpServerCount: number;
    composeServices: string[] | null;
    buildTimeoutSec: number;
    workdir: string | null;
  };
  verifier: { timeoutSec: number; environmentMode: string | null; collectCount: number; hasSharedSteps?: boolean };
  hasSolution: boolean;
  hasTests: boolean;
  multiStepRewardStrategy: "mean" | "final" | null;
};

function parseAdapterJson(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HarborAdapterError("adapter-protocol", `Harbor adapter emitted invalid JSON: ${raw.slice(0, 200)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HarborAdapterError("adapter-protocol", "Harbor adapter response must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function runAdapterOperation(
  python: AdapterPython,
  interpreter: string | undefined,
  operation: string,
  arguments_: readonly string[],
  options: { allowFailureKinds?: ReadonlySet<string> } = {},
): Promise<Record<string, unknown>> {
  const scriptPath = materializeAdapterScript();
  const result = await python([interpreter ?? "python3", scriptPath, operation, ...arguments_]);
  const parsed = parseAdapterJson(result.stdout);
  if (result.code === 0) {
    if (parsed.ok !== true) throw new HarborAdapterError("adapter-protocol", `Harbor adapter reported failure with exit code 0 for "${operation}".`);
    return parsed;
  }
  const kind = typeof parsed.errorKind === "string" ? parsed.errorKind : "adapter-protocol";
  const message = typeof parsed.error === "string" ? parsed.error : result.stderr.slice(0, 400) || `Harbor adapter operation "${operation}" failed.`;
  if (options.allowFailureKinds?.has(kind)) return parsed;
  throw new HarborAdapterError(kind, message);
}

export async function createHarborAdapter(python: AdapterPython = defaultPython): Promise<HarborAdapter> {
  let interpreter: string | undefined;
  let version: HarborVersionInfo | null = null;
  let lastError: unknown;
  for (const candidate of candidateInterpreters()) {
    try {
      const parsed = await runAdapterOperation(python, candidate, "version", []);
      const info: HarborVersionInfo = {
        harborVersion: String(parsed.harborVersion ?? ""),
        defaultTaskSchemaVersion: String(parsed.defaultTaskSchemaVersion ?? ""),
        pythonVersion: String(parsed.pythonVersion ?? ""),
      };
      if (info.harborVersion !== HARBOR_PACKAGE_PIN) {
        throw new HarborAdapterError(
          "harbor-version-mismatch",
          `Pinned Harbor ${HARBOR_PACKAGE_PIN} is required; "${candidate}" provides ${info.harborVersion}. ` +
          'Install it with: python3 -m venv .harbor-venv && ./.harbor-venv/bin/pip install harbor==' + HARBOR_PACKAGE_PIN +
          ` (or point ${EBO_HARBOR_PYTHON} at an existing interpreter).`,
        );
      }
      if (Number(parsed.protocol) !== HARBOR_ADAPTER_PROTOCOL_VERSION) {
        throw new HarborAdapterError("adapter-protocol", `Harbor adapter protocol ${String(parsed.protocol)} is not ${HARBOR_ADAPTER_PROTOCOL_VERSION}.`);
      }
      interpreter = candidate;
      version = info;
      break;
    } catch (error) {
      lastError = error;
      if (error instanceof HarborAdapterError && error.kind === "harbor-version-mismatch") throw error;
    }
  }
  if (interpreter === undefined) {
    throw new HarborAdapterError(
      "harbor-unavailable",
      `No Python interpreter with harbor==${HARBOR_PACKAGE_PIN} was found. ` +
      `Install it with: python3 -m venv .harbor-venv && ./.harbor-venv/bin/pip install harbor==${HARBOR_PACKAGE_PIN}. ` +
      `Underlying failure: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  const resolvedInterpreter = interpreter;

  const requireDirectory = (taskDir: string): string => {
    const path = resolve(taskDir);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw new HarborAdapterError("task-invalid", `Harbor task directory "${taskDir}" does not exist.`);
    }
    if (!stats.isDirectory()) throw new HarborAdapterError("task-invalid", `Harbor task directory "${taskDir}" is not a directory.`);
    return path;
  };

  const adapter: HarborAdapter = {
    async version() {
      if (version !== null) return version;
      const parsed = await runAdapterOperation(python, resolvedInterpreter, "version", []);
      version = {
        harborVersion: String(parsed.harborVersion ?? ""),
        defaultTaskSchemaVersion: String(parsed.defaultTaskSchemaVersion ?? ""),
        pythonVersion: String(parsed.pythonVersion ?? ""),
      };
      return version;
    },
    async inspect(taskDir: string, inspectOptions = {}): Promise<HarborInspectResult> {
      const arguments_: string[] = [requireDirectory(taskDir)];
      if (inspectOptions.disableVerification === true) arguments_.push("--disable-verification");
      const parsed = await runAdapterOperation(python, resolvedInterpreter, "inspect", arguments_);
      const environment = parsed.environment as Record<string, unknown>;
      const verifier = parsed.verifier as Record<string, unknown>;
      return {
        name: String(parsed.name ?? ""),
        shortName: String(parsed.shortName ?? ""),
        version: parsed.version === null || parsed.version === undefined ? null : String(parsed.version),
        schemaVersion: String(parsed.schemaVersion ?? ""),
        hasSteps: parsed.hasSteps === true,
        steps: (Array.isArray(parsed.steps) ? parsed.steps : []).map((entry) => {
          const record = entry as Record<string, unknown>;
          return {
            name: String(record.name ?? ""),
            minReward: (record.minReward === null || record.minReward === undefined) ? null : record.minReward as number | Record<string, number>,
            verifierTimeoutSec: Number(record.verifierTimeoutSec ?? 0),
            agentTimeoutSec: record.agentTimeoutSec === null || record.agentTimeoutSec === undefined ? null : Number(record.agentTimeoutSec),
          };
        }),
        metadataKeys: (Array.isArray(parsed.metadataKeys) ? parsed.metadataKeys : []).map(String),
        environment: {
          os: String(environment.os ?? "linux"),
          dockerImage: environment.dockerImage === null || environment.dockerImage === undefined ? null : String(environment.dockerImage),
          cpus: environment.cpus === null || environment.cpus === undefined ? null : Number(environment.cpus),
          memoryMb: environment.memoryMb === null || environment.memoryMb === undefined ? null : Number(environment.memoryMb),
          storageMb: environment.storageMb === null || environment.storageMb === undefined ? null : Number(environment.storageMb),
          gpus: environment.gpus === null || environment.gpus === undefined ? null : Number(environment.gpus),
          gpuTypes: environment.gpuTypes === null || environment.gpuTypes === undefined ? null : (environment.gpuTypes as unknown[]).map(String),
          tpu: environment.tpu === true,
          networkMode: String(environment.networkMode ?? "public"),
          allowInternet: environment.allowInternet === null || environment.allowInternet === undefined ? null : environment.allowInternet === true,
          mcpServerCount: Number(environment.mcpServerCount ?? 0),
          composeServices: environment.composeServices === null || environment.composeServices === undefined
            ? null
            : (environment.composeServices as unknown[]).map(String),
          buildTimeoutSec: Number(environment.buildTimeoutSec ?? 0),
          workdir: environment.workdir === null || environment.workdir === undefined ? null : String(environment.workdir),
        },
        verifier: {
          hasSharedSteps: verifier.hasSharedSteps !== false,
          timeoutSec: Number(verifier.timeoutSec ?? 0),
          environmentMode: verifier.environmentMode === null || verifier.environmentMode === undefined ? null : String(verifier.environmentMode),
          collectCount: Number(verifier.collectCount ?? 0),
        },
        hasSolution: parsed.hasSolution === true,
        hasTests: parsed.hasTests === true,
        multiStepRewardStrategy: parsed.multiStepRewardStrategy === null || parsed.multiStepRewardStrategy === undefined
          ? null
          : (parsed.multiStepRewardStrategy === "final" ? "final" : "mean"),
      };
    },
    async identity(taskDir: string): Promise<HarborIdentity> {
      const parsed = await runAdapterOperation(python, resolvedInterpreter, "identity", [requireDirectory(taskDir)]);
      const included = Array.isArray(parsed.includedFiles) ? parsed.includedFiles.map(String) : [];
      const excluded = Array.isArray(parsed.excludedFiles) ? parsed.excludedFiles.map(String) : [];
      const digest = String(parsed.digest ?? "");
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new HarborAdapterError("adapter-protocol", "Harbor identity digest is malformed.");
      return { digest, includedFiles: included, excludedFiles: excluded };
    },
    async instructions(taskDir: string, instructionOptions = {}) {
      const arguments_: string[] = [requireDirectory(taskDir)];
      if (instructionOptions.disableVerification === true) arguments_.push("--disable-verification");
      for (const extra of instructionOptions.extraInstructions ?? []) {
        arguments_.push("--extra-instruction", extra);
      }
      const parsed = await runAdapterOperation(python, resolvedInterpreter, "instructions", arguments_);
      const instructions = parsed.instructions;
      if (!Array.isArray(instructions)) throw new HarborAdapterError("adapter-protocol", "Harbor instructions response is malformed.");
      return instructions.map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
          step: record.step === null || record.step === undefined ? null : String(record.step),
          instruction: String(record.instruction ?? ""),
          sha256: String(record.sha256 ?? ""),
        };
      });
    },
    async lock(taskDir: string): Promise<HarborLockResolution> {
      const parsed = await runAdapterOperation(python, resolvedInterpreter, "lock", [requireDirectory(taskDir)]);
      const taskLock = parsed.taskLock;
      if (taskLock === null || typeof taskLock !== "object" || Array.isArray(taskLock)) {
        throw new HarborAdapterError("adapter-protocol", "Harbor lock response is malformed.");
      }
      return {
        taskLock: taskLock as unknown as HarborTaskLockJson,
        trialLock: (parsed.trialLock ?? {}) as Record<string, unknown>,
      };
    },
    async dockerPreflight(): Promise<HarborDockerPreflight> {
      const parsed = await runAdapterOperation(python, resolvedInterpreter, "docker-preflight", []);
      return {
        available: parsed.available === true,
        reason: parsed.reason === null || parsed.reason === undefined ? null : String(parsed.reason),
      };
    },
    async describePrerequisites() {
      let docker: HarborDockerPreflight | null = null;
      try {
        docker = await this.dockerPreflight();
      } catch {
        docker = null;
      }
      return { python: resolvedInterpreter, version, docker };
    },
  };
  return adapter;
}
