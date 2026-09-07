import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact, validateRunManifestEvidence } from "./artifacts.js";
import {
  captureCodexAppServer,
  CODEX_ADAPTER_VERSION,
  CODEX_APP_SERVER_VERSION,
  CODEX_DEFAULT_SHUTDOWN_GRACE_MS,
  CODEX_HARNESS,
  describeAndValidateCodexDataset,
  type CodexAppServerCapture,
  type CodexAppServerConfiguration,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexSandbox,
  type CodexTelemetrySignal,
} from "./codex.js";
import { isSafeArtifactRelativePath, resolveBundleConfiguration, type ArtifactReference } from "./contracts.js";
import {
  createAttemptIdentity,
  createRunIdentity,
  executeRunAttempt,
  type RunAttemptResult,
  type TerminalRecord,
  type VerifierExecutionContext,
  type WorkspaceCoordinator,
  type WorkspaceExecutionResult,
} from "./lifecycle.js";
import type { AdapterCoverageReport, NormalizedDataset } from "./normalization-integrity.js";
import {
  createRunBundleAssembler,
  qualifyRunBundle,
  type CaptureMissingEvidence,
  type CaptureQualificationReport,
  type CaptureQualificationStatus,
  type CapturedWorkspaceOutcome,
  type RunBundleDefinition,
  type RunManifest,
} from "./run-bundles.js";
import { readBoundedFile, readRunQueue, type RunQueueEntry } from "./scheduler.js";
import { assertTaskPacketAdmitted, formatErrors, type TaskPacket } from "./task-packets.js";
import { executeVerifier, type VerifierResult } from "./verifiers.js";
import { cleanupWorkspace, materializeWorkspace } from "./workspaces.js";

export const CODEX_CONFIG_SCHEMA_VERSION = "ebo.codex-config/v1";
export const CODEX_CONTRACT_DIGEST = "sha256:844b52d4a5a8cda58794e28b3b119c3a3d20a588b7db83209c298bec62704092";
const execFileAsync = promisify(execFile);
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type CodexModelConfiguration = {
  schemaVersion: typeof CODEX_CONFIG_SCHEMA_VERSION;
  kind: "model";
  provider: "openai";
  model: string;
  effort: CodexReasoningEffort;
};

export type CodexHarnessConfiguration = {
  schemaVersion: typeof CODEX_CONFIG_SCHEMA_VERSION;
  kind: "harness";
  adapter: typeof CODEX_HARNESS;
  executable: string;
  version: typeof CODEX_APP_SERVER_VERSION;
  contractDigest: `sha256:${string}`;
};

export type CodexNativeLimitsConfiguration = {
  schemaVersion: typeof CODEX_CONFIG_SCHEMA_VERSION;
  kind: "native-limits";
  shutdownGraceMs?: number;
};

export type CodexNativeToolPolicyConfiguration = {
  schemaVersion: typeof CODEX_CONFIG_SCHEMA_VERSION;
  kind: "native-tool-policy";
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandbox;
};

export type CodexCaptureProfileConfiguration = {
  schemaVersion: typeof CODEX_CONFIG_SCHEMA_VERSION;
  kind: "capture-profile";
  telemetrySignals?: CodexTelemetrySignal[];
  workspaceOutcome?: {
    excludeDirectoryNames: string[];
    respectGitignore?: boolean;
    omitEmptyDirectories?: boolean;
  };
};

export type CodexConfigurationRecord = CodexModelConfiguration | CodexHarnessConfiguration
  | CodexNativeLimitsConfiguration | CodexNativeToolPolicyConfiguration | CodexCaptureProfileConfiguration;
export type CodexConfigurationKind = CodexConfigurationRecord["kind"];

export type CaptureCodexAppServerVerifier = (
  context: VerifierExecutionContext,
  workspace: CapturedWorkspaceOutcome,
  workspacePath: string,
) => VerifierResult | Promise<VerifierResult>;

export type CaptureCodexAppServerRunOptions = {
  definition: RunBundleDefinition;
  startingWorkspacePath: string;
  workspace: WorkspaceCoordinator;
  configuration: CodexAppServerConfiguration;
  prompt: string;
  verifier?: CaptureCodexAppServerVerifier;
  workspaceOutcomeExcludedDirectoryNames?: readonly string[];
  workspaceOutcomeRespectsGitignore?: boolean;
  workspaceOutcomeOmitsEmptyDirectories?: boolean;
  signal?: AbortSignal;
  maxWallClockMs?: number;
  shutdownGraceMs?: number;
  capture?: typeof captureCodexAppServer;
};

export type CaptureCodexAppServerRunResult = {
  attempt: RunAttemptResult;
  manifest: RunManifest;
  qualification: CaptureQualificationReport;
  capture?: CodexAppServerCapture;
  normalized?: NormalizedDataset;
  coverage?: AdapterCoverageReport;
};

/** Execute and retain one caller-configured Codex app-server attempt without scheduling or retrying it. */
export async function captureCodexAppServerRun(
  options: CaptureCodexAppServerRunOptions,
): Promise<CaptureCodexAppServerRunResult> {
  if (options.definition.run.harness.id !== CODEX_HARNESS) {
    throw new Error(`Codex run harness must be ${CODEX_HARNESS}.`);
  }
  if (options.definition.run.model.id !== options.configuration.model) {
    throw new Error("The declared model must match the Codex app-server configuration.");
  }
  const shutdownGraceMs = options.shutdownGraceMs ?? CODEX_DEFAULT_SHUTDOWN_GRACE_MS;
  const assembler = await createRunBundleAssembler(withPinnedRuntime(options.definition));
  let workspace: WorkspaceExecutionResult | undefined;
  let workspaceOutcome: CapturedWorkspaceOutcome | undefined;
  let workspaceOutcomePromise: Promise<CapturedWorkspaceOutcome> | undefined;
  let verifierResult: VerifierResult | undefined;
  let capture: CodexAppServerCapture | undefined;
  let nativeEvidenceRegistered = false;

  const captureWorkspace = async (context?: VerifierExecutionContext): Promise<CapturedWorkspaceOutcome> => {
    if (workspaceOutcome !== undefined) return workspaceOutcome;
    if (workspace?.status !== "ready" || workspace.path === undefined || workspace.artifactId === undefined) {
      throw new Error("Codex capture requires a ready retained workspace before outcome packaging.");
    }
    workspaceOutcomePromise ??= assembler.captureWorkspaceOutcome({
      startPath: options.startingWorkspacePath,
      finalPath: workspace.path,
      id: workspace.artifactId,
      source: "codex-workspace-outcome",
      ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : {
        excludeDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames,
      }),
      ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : {
        respectGitignore: options.workspaceOutcomeRespectsGitignore,
      }),
      ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : {
        omitEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories,
      }),
    }, context === undefined || options.verifier === undefined ? undefined : async (path, outcome) => {
      verifierResult = await options.verifier!(context, outcome, path);
    });
    workspaceOutcome = await workspaceOutcomePromise;
    return workspaceOutcome;
  };

  const registerNativeEvidence = async (): Promise<void> => {
    if (nativeEvidenceRegistered || capture === undefined) return;
    if (await nonempty(`${assembler.bundleRoot}/session.jsonl`)) {
      await assembler.registerArtifact({
        id: "session",
        source: CODEX_HARNESS,
        kind: "session",
        mediaType: "application/x-ndjson",
        sharingClass: "restricted",
        relativePath: "session.jsonl",
        ...(capture.threadId === undefined ? {} : { nativeReference: { type: "session", id: capture.threadId } }),
      });
    }
    await assembler.writeJsonArtifact({
      id: "telemetry",
      source: CODEX_HARNESS,
      kind: "telemetry",
      mediaType: "application/json",
      sharingClass: "restricted",
      relativePath: "telemetry/codex.json",
    }, capture.telemetry);
    nativeEvidenceRegistered = true;
  };

  const coordinatedWorkspace: WorkspaceCoordinator = {
    setup: async (context) => {
      workspace = await options.workspace.setup(context);
      return workspace;
    },
    cleanup: async (context) => {
      if (workspace?.status === "ready") await captureWorkspace();
      await options.workspace.cleanup?.(context);
    },
  };
  const run = createRunIdentity({
    id: options.definition.run.id,
    taskId: options.definition.run.task.id,
    modelId: options.definition.run.model.id,
    harnessId: options.definition.run.harness.id,
  });
  const attemptIdentity = createAttemptIdentity(
    options.definition.run.id,
    options.definition.attempt.number,
    options.definition.attempt.id,
    options.definition.attempt.retryOf,
  );
  const performCapture = options.capture ?? captureCodexAppServer;
  const attempt = await executeRunAttempt({
    run,
    assessmentMode: options.definition.run.assessmentMode,
    attempt: attemptIdentity,
    workspace: coordinatedWorkspace,
    harness: async ({ signal, registerShutdown }) => {
      if (workspace?.status !== "ready" || workspace.path === undefined) throw new Error("Codex run requires a ready workspace.");
      capture = await performCapture({
        runId: options.definition.run.id,
        attemptId: options.definition.attempt.id,
        workspacePath: workspace.path,
        prompt: options.prompt,
        configuration: options.configuration,
        evidencePath: `${assembler.bundleRoot}/session.jsonl`,
        signal,
        registerShutdown,
        shutdownGraceMs,
      });
      if (capture.terminalStatus === "completed") {
        return { status: "completed", completionEvidence: capture.terminal, evidence: durableCaptureEvidence(capture) };
      }
      if (capture.terminalStatus === "interrupted") {
        return { status: "interrupted", reason: "Codex turn was interrupted.", evidence: durableCaptureEvidence(capture) };
      }
      return {
        status: "failed",
        failureClass: "infrastructure",
        reason: capture.gaps.find(({ kind }) => kind === "capture-error")?.detail ?? `Codex turn ended as ${String(capture.terminalStatus)}.`,
        evidence: durableCaptureEvidence(capture),
      };
    },
    ...(options.verifier === undefined ? {} : {
      verifier: async (context) => {
        await captureWorkspace(context);
        if (verifierResult === undefined) throw new Error("Codex verifier did not return a result.");
        await assembler.writeJsonArtifact({
          id: "verifier",
          source: "ebo-verifier",
          kind: "verifier",
          mediaType: "application/json",
          sharingClass: "restricted",
          relativePath: "verifier.json",
        }, verifierResult);
        return { status: verifierResult.status, ...(verifierResult.error === undefined ? {} : { error: verifierResult.error }), evidence: verifierResult };
      },
    }),
    evidence: { flush: registerNativeEvidence },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxWallClockMs === undefined ? {} : { maxWallClockMs: options.maxWallClockMs }),
    shutdownGraceMs,
  });
  if (workspace?.status === "ready") await captureWorkspace().catch(() => undefined);
  await registerNativeEvidence();

  const missingEvidence: CaptureMissingEvidence[] = [];
  if (capture?.threadId === undefined) missingEvidence.push({
    kind: "session-identity", reason: "not-collected", affects: ["semantic"], detail: "Codex did not return an owned thread identity.",
  });
  for (const gap of capture?.gaps ?? []) missingEvidence.push({
    kind: gap.kind,
    reason: gap.kind === "interrupt-acknowledgement" ? "process-interrupted" : "not-collected",
    affects: [gap.kind.includes("telemetry") ? "timing-resource" : "semantic"],
    detail: gap.detail,
  });
  const receipt = capture?.telemetry.telemetry.receipt;
  if (receipt?.status !== "received") missingEvidence.push({
    kind: "telemetry-receipt",
    reason: receipt?.status === "not-checked" ? "not-checked" : "not-collected",
    affects: ["timing-resource"],
    detail: receipt === undefined ? "Codex telemetry evidence was not produced." : `Codex OTLP receipt is ${receipt.status}.`,
  });
  missingEvidence.push({
    kind: "child-history",
    reason: "not-checked",
    affects: ["semantic"],
    detail: "Child histories are not claimed unless explicit native delegation identities are collected.",
  });
  const qualificationOptions = {
    startingWorkspacePath: options.startingWorkspacePath,
    semanticEvidenceKinds: ["session"] as const,
    relatedSessionIds: [] as const,
    ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : {
      workspaceOutcomeExcludedDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames,
    }),
    ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : {
      workspaceOutcomeRespectsGitignore: options.workspaceOutcomeRespectsGitignore,
    }),
    ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : {
      workspaceOutcomeOmitsEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories,
    }),
  };
  const terminal = structuredClone(attempt.terminal);
  if (workspaceOutcome === undefined) delete terminal.workspaceArtifactId;
  const manifest = await assembler.finalize({ terminal, missingEvidence, qualification: qualificationOptions });
  const qualification = await qualifyRunBundle(assembler.bundleRoot, qualificationOptions);
  if (capture === undefined || capture.threadId === undefined) return { attempt, manifest, qualification, capture };
  const { dataset, coverage } = await describeAndValidateCodexDataset(capture);
  return { attempt, manifest, qualification, capture, normalized: dataset, coverage };
}

export type RunCodexQueueEntryOptions = {
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot?: string;
  attemptId?: string;
  signal?: AbortSignal;
  probeRuntime?: (executable: string) => Promise<{ path: string; version: string }>;
  /** Test-only executable prefix; never serialized or exposed as a CLI flag. */
  executableArgs?: readonly string[];
  capture?: typeof captureCodexAppServer;
};

export type CodexRunSummary = {
  runId: string;
  attemptId: string;
  bundlePath: string;
  terminal: TerminalRecord;
  classification: RunAttemptResult["classification"]["kind"];
  captureQualification: CaptureQualificationStatus;
  assessmentMode: TaskPacket["assessmentMode"];
  threadId?: string;
  turnId?: string;
  normalizedEvents: number;
  unmappedNativeRecords: number;
  retainedWorkspacePath?: string;
};

/** Execute exactly one persisted frozen queue entry through the pinned Codex app-server adapter. */
export async function runCodexQueueEntry(options: RunCodexQueueEntryOptions): Promise<CodexRunSummary> {
  const bundleRoot = resolve(options.bundleRoot);
  const queue = readRunQueue(options.queuePath, undefined, { bundleRoot });
  const matches = queue.entries.filter((entry) => entry.runId === options.runId);
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? `Run "${options.runId}" is not in the queue.` : `Run "${options.runId}" matches more than one queue entry.`);
  const entry = matches[0]!;
  const model = resolveCodexConfigurationRecord(bundleRoot, entry.configuration.model, "model");
  const harness = resolveCodexConfigurationRecord(bundleRoot, entry.configuration.harness, "harness");
  const limits = resolveCodexConfigurationRecord(bundleRoot, entry.configuration.nativeLimits, "native-limits");
  const toolPolicy = resolveCodexConfigurationRecord(bundleRoot, entry.configuration.nativeToolPolicy, "native-tool-policy");
  const captureProfile = resolveCodexConfigurationRecord(bundleRoot, queue.captureProfile, "capture-profile");
  if (entry.harness.id !== CODEX_HARNESS) throw new Error(`Queue harness must be ${CODEX_HARNESS}.`);
  const runtime = await (options.probeRuntime ?? probeCodexRuntime)(harness.executable);
  if (runtime.version !== `codex-cli ${harness.version}`) {
    throw new Error(`Codex ${harness.version} is required; received ${runtime.version}.`);
  }

  const inspection = assertTaskPacketAdmitted(bundleRoot, entry.task.packetRef.locator);
  const packet = inspection.packet as TaskPacket;
  if (inspection.packetDigest === null || inspection.packetDigest.value !== entry.task.packetRef.digest.value
      || inspection.packetDigest.algorithm !== entry.task.packetRef.digest.algorithm) {
    throw new Error(`Task packet "${entry.task.packetRef.locator}" changed from its frozen queue reference.`);
  }
  const attemptId = options.attemptId ?? randomUUID();
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("Attempt ID must be one safe path component.");
  const outputRoot = resolve(options.outputRoot);
  const destination = join(outputRoot, entry.runId, attemptId);
  const fromOutput = relative(outputRoot, destination);
  if (fromOutput === "" || isAbsolute(fromOutput) || fromOutput === ".." || fromOutput.startsWith(`..${sep}`)) {
    throw new Error("Attempt destination escapes the selected output root.");
  }
  if (await exists(destination)) throw new Error(`Attempt destination "${destination}" already exists and is never replaced.`);

  const workspace = await materializeWorkspace({
    bundleRoot,
    packetLocator: entry.task.packetRef.locator,
    freezeLocator: entry.task.freezeLocator,
    ...(options.workspaceRoot === undefined ? {} : { workspaceParent: options.workspaceRoot }),
  });
  if (workspace.status !== "ready") throw new Error(`Workspace materialization failed: ${workspace.error ?? "unknown failure"}`);
  let baselineRoot: string | undefined;
  let captureStarted = false;
  try {
    baselineRoot = await mkdtemp(join(tmpdir(), "ebo-codex-baseline-"));
    const startingWorkspacePath = join(baselineRoot, "workspace");
    await cp(workspace.path, startingWorkspacePath, { recursive: true, preserveTimestamps: true, force: false });
    const verifierReference = packet.assessmentMode === "verified" ? packet.restricted.verifier : undefined;
    const verifierFormat = verifierReference?.locator.toLowerCase().endsWith(".mjs") ? "module" : "commonjs";
    const definition = buildDefinition(queue.captureProfile, entry, packet, destination, attemptId, model, harness, verifierFormat);
    const result = await captureCodexAppServerRun({
      definition,
      startingWorkspacePath,
      workspace: {
        setup: () => {
          captureStarted = true;
          return { status: "ready", path: workspace.path, artifactId: "workspace", retained: true };
        },
        cleanup: () => cleanupWorkspace(workspace),
      },
      configuration: {
        executable: runtime.path,
        ...(options.executableArgs === undefined ? {} : { executableArgs: options.executableArgs }),
        version: harness.version,
        provider: model.provider,
        model: model.model,
        effort: model.effort,
        approvalPolicy: toolPolicy.approvalPolicy,
        sandbox: toolPolicy.sandbox,
        ...(captureProfile.telemetrySignals === undefined ? {} : {
          telemetry: { signals: captureProfile.telemetrySignals },
        }),
      },
      prompt: packet.agentInput.prompt,
      ...(verifierReference === undefined ? {} : {
        verifier: (context, outcome, projectedPath) => executeVerifier({
          bundleId: definition.bundleId,
          verifierRoot: bundleRoot,
          verifier: verifierReference,
          workspacePath: projectedPath,
          workspaceFingerprint: outcome.fingerprint,
          workspace: { artifactId: outcome.descriptor.id, digest: outcome.descriptor.digest, fingerprint: outcome.fingerprint },
          artifactRoot: destination,
          moduleFormat: verifierFormat,
          signal: context.signal,
        }),
      }),
      maxWallClockMs: queue.coordinatorBudget.maxWallClockMs,
      ...(limits.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: limits.shutdownGraceMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.capture === undefined ? {} : { capture: options.capture }),
      ...(captureProfile.workspaceOutcome === undefined ? {} : {
        workspaceOutcomeExcludedDirectoryNames: captureProfile.workspaceOutcome.excludeDirectoryNames,
        ...(captureProfile.workspaceOutcome.respectGitignore === undefined ? {} : {
          workspaceOutcomeRespectsGitignore: captureProfile.workspaceOutcome.respectGitignore,
        }),
        ...(captureProfile.workspaceOutcome.omitEmptyDirectories === undefined ? {} : {
          workspaceOutcomeOmitsEmptyDirectories: captureProfile.workspaceOutcome.omitEmptyDirectories,
        }),
      }),
    });
    const manifest = reopenManifest(destination);
    return {
      runId: entry.runId,
      attemptId,
      bundlePath: destination,
      terminal: manifest.terminal,
      classification: result.attempt.classification.kind,
      captureQualification: result.qualification.status,
      assessmentMode: packet.assessmentMode,
      ...(result.capture?.threadId === undefined ? {} : { threadId: result.capture.threadId }),
      ...(result.capture?.turnId === undefined ? {} : { turnId: result.capture.turnId }),
      normalizedEvents: result.normalized?.events.length ?? 0,
      unmappedNativeRecords: result.normalized?.unmapped.length ?? 0,
      ...(workspace.state === "ready" ? { retainedWorkspacePath: workspace.path } : {}),
    };
  } finally {
    if (baselineRoot !== undefined) await rm(baselineRoot, { recursive: true, force: true });
    if (!captureStarted && workspace.state === "ready") await cleanupWorkspace(workspace).catch(() => undefined);
  }
}

type CodexConfigurationByKind = {
  model: CodexModelConfiguration;
  harness: CodexHarnessConfiguration;
  "native-limits": CodexNativeLimitsConfiguration;
  "native-tool-policy": CodexNativeToolPolicyConfiguration;
  "capture-profile": CodexCaptureProfileConfiguration;
};

export function resolveCodexConfigurationRecord<Kind extends CodexConfigurationKind>(
  bundleRoot: string,
  reference: ArtifactReference,
  kind: Kind,
): CodexConfigurationByKind[Kind] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(resolveBundleConfiguration(bundleRoot, reference));
  assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== CODEX_CONFIG_SCHEMA_VERSION || value.kind !== kind) {
    throw configError(reference, `must declare ${CODEX_CONFIG_SCHEMA_VERSION} kind ${kind}`);
  }
  validateConfiguration(value, kind, reference);
  return value as CodexConfigurationByKind[Kind];
}

async function probeCodexRuntime(executable: string): Promise<{ path: string; version: string }> {
  if (!isAbsolute(executable)) throw new Error("Codex harness executable must be an absolute path.");
  const path = await realpath(executable);
  const { stdout } = await execFileAsync(path, ["--version"], { encoding: "utf8", timeout: 5_000 });
  return { path, version: stdout.trim() };
}

function validateConfiguration(record: Record<string, unknown>, kind: CodexConfigurationKind, reference: ArtifactReference): void {
  if (kind === "model") {
    keys(record, ["schemaVersion", "kind", "provider", "model", "effort"], ["provider", "model", "effort"], reference);
    if (record.provider !== "openai") throw configError(reference, "provider must be openai");
    requiredText(record.model, "model", reference);
    if (!["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(String(record.effort))) throw configError(reference, "effort is invalid");
  } else if (kind === "harness") {
    keys(record, ["schemaVersion", "kind", "adapter", "executable", "version", "contractDigest"], ["adapter", "executable", "version", "contractDigest"], reference);
    if (record.adapter !== CODEX_HARNESS || record.version !== CODEX_APP_SERVER_VERSION) throw configError(reference, "adapter or version is not pinned");
    requiredText(record.executable, "executable", reference);
    if (!isAbsolute(record.executable as string)) throw configError(reference, "executable must be absolute");
    if (record.contractDigest !== CODEX_CONTRACT_DIGEST) throw configError(reference, `contractDigest must be ${CODEX_CONTRACT_DIGEST}`);
  } else if (kind === "native-limits") {
    keys(record, ["schemaVersion", "kind", "shutdownGraceMs"], [], reference);
    if (record.shutdownGraceMs !== undefined && (!Number.isSafeInteger(record.shutdownGraceMs) || (record.shutdownGraceMs as number) < 1)) throw configError(reference, "shutdownGraceMs must be positive");
  } else if (kind === "native-tool-policy") {
    keys(record, ["schemaVersion", "kind", "approvalPolicy", "sandbox"], ["approvalPolicy", "sandbox"], reference);
    if (!["untrusted", "on-request", "never"].includes(String(record.approvalPolicy))) throw configError(reference, "approvalPolicy is invalid");
    if (!["read-only", "workspace-write", "danger-full-access"].includes(String(record.sandbox))) throw configError(reference, "sandbox is invalid");
  } else {
    keys(record, ["schemaVersion", "kind", "telemetrySignals", "workspaceOutcome"], [], reference);
    if (record.telemetrySignals !== undefined && (!Array.isArray(record.telemetrySignals)
        || new Set(record.telemetrySignals).size !== record.telemetrySignals.length
        || record.telemetrySignals.some((signal) => !["logs", "traces", "metrics"].includes(String(signal))))) {
      throw configError(reference, "telemetrySignals is invalid");
    }
    if (record.workspaceOutcome !== undefined) validateWorkspaceOutcome(record.workspaceOutcome, reference);
  }
}

function validateWorkspaceOutcome(value: unknown, reference: ArtifactReference): void {
  if (!isRecord(value)) throw configError(reference, "workspaceOutcome must be an object");
  keys(value, ["excludeDirectoryNames", "respectGitignore", "omitEmptyDirectories"], ["excludeDirectoryNames"], reference);
  if (!Array.isArray(value.excludeDirectoryNames) || value.excludeDirectoryNames.some((name) => typeof name !== "string"
      || name.includes("/") || !isSafeArtifactRelativePath(name))) throw configError(reference, "workspace exclusions are invalid");
  for (const flag of ["respectGitignore", "omitEmptyDirectories"] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw configError(reference, `${flag} must be boolean`);
  }
}

function buildDefinition(
  captureProfile: ArtifactReference,
  entry: RunQueueEntry,
  packet: TaskPacket,
  bundleRoot: string,
  attemptId: string,
  model: CodexModelConfiguration,
  harness: CodexHarnessConfiguration,
  verifierFormat: "commonjs" | "module",
): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-${attemptId}`,
    run: {
      id: entry.runId,
      assessmentMode: packet.assessmentMode,
      task: { id: entry.task.id },
      fixture: { id: packet.agentInput.fixture.source.locator, digest: `sha256:${packet.agentInput.fixture.source.digest.value}` },
      model: { provider: model.provider, id: model.model },
      harness: { id: CODEX_HARNESS, version: harness.version },
      runtime: [
        { source: "OpenAI", name: "codex-app-server", version: harness.version },
        { source: "EBO", name: "codex-adapter", version: CODEX_ADAPTER_VERSION },
      ],
      ...(packet.assessmentMode === "verified" ? {
        verifier: { locator: packet.restricted.verifier.locator, digest: `sha256:${packet.restricted.verifier.digest.value}`, format: verifierFormat },
      } : {}),
    },
    attempt: { id: attemptId, number: 1 },
    configuration: {
      digest: `sha256:${digestMetadata({ model: entry.configuration.model, harness: entry.configuration.harness, captureProfile }).value}`,
      budgetDigest: `sha256:${entry.configuration.nativeLimits.digest.value}`,
      toolPolicyDigest: `sha256:${entry.configuration.nativeToolPolicy.digest.value}`,
    },
  };
}

function withPinnedRuntime(definition: RunBundleDefinition): RunBundleDefinition {
  return {
    ...structuredClone(definition),
    run: {
      ...structuredClone(definition.run),
      harness: { id: CODEX_HARNESS, version: CODEX_APP_SERVER_VERSION },
      runtime: definition.run.runtime.filter(({ name }) => !["codex-app-server", "codex-adapter"].includes(name)).concat([
        { source: "OpenAI", name: "codex-app-server", version: CODEX_APP_SERVER_VERSION },
        { source: "EBO", name: "codex-adapter", version: CODEX_ADAPTER_VERSION },
      ]),
    },
  };
}

function durableCaptureEvidence(capture: CodexAppServerCapture): Record<string, unknown> {
  return {
    qualification: capture.qualification,
    ...(capture.threadId === undefined ? {} : { threadId: capture.threadId }),
    ...(capture.turnId === undefined ? {} : { turnId: capture.turnId }),
    ...(capture.terminalStatus === undefined ? {} : { terminalStatus: capture.terminalStatus }),
    gaps: capture.gaps,
    process: {
      status: capture.process.status,
      partial: capture.process.partial,
      termination: capture.process.termination,
      stdoutFrames: capture.process.stdoutFrames,
      exitCode: capture.process.launch.exitCode,
      signal: capture.process.launch.signal,
      stderrSizeBytes: capture.process.stderr.sizeBytes,
      stderrTruncated: capture.process.stderr.truncated,
    },
  };
}

function reopenManifest(bundleRoot: string): RunManifest {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest"));
  assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  const errors = [...validateArtifact("manifest.json", value), ...validateRunManifestEvidence("manifest.json", value, bundleRoot)];
  if (errors.length > 0) throw new Error(`Retained run manifest failed validation:\n${formatErrors(errors)}`);
  return value as RunManifest;
}

async function nonempty(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function keys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], reference: ArtifactReference): void {
  const set = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !set.has(key));
  if (unexpected !== undefined) throw configError(reference, `contains unknown field "${unexpected}"`);
  const missing = required.find((key) => record[key] === undefined);
  if (missing !== undefined) throw configError(reference, `is missing "${missing}"`);
}

function requiredText(value: unknown, field: string, reference: ArtifactReference): void {
  if (typeof value !== "string" || value.trim() === "") throw configError(reference, `${field} must be nonempty`);
}

function configError(reference: ArtifactReference, detail: string): Error {
  return new Error(`Codex configuration "${reference.locator}" ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
