import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact, validateRunManifestEvidence } from "./artifacts.js";
import { isSafeArtifactRelativePath, resolveBundleConfiguration, type ArtifactReference } from "./contracts.js";
import {
  captureFactoryDroid,
  FACTORY_ADAPTER_VERSION,
  FACTORY_CLI_VERSION,
  FACTORY_SDK_VERSION,
  validateFactoryConfiguration,
  probeFactoryRuntime,
  FACTORY_DEFAULT_SHUTDOWN_GRACE_MS,
  FACTORY_HARNESS,
  describeAndValidateFactoryDataset,
  type FactoryCapture,
  type FactoryDroidConfiguration,
  type FactoryPermissionDecision,
  type FactoryAutonomyLevel,
  type FactoryReasoningEffort,
} from "./factory-droid.js";
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

export const FACTORY_CONFIG_SCHEMA_VERSION = "ebo.factory-config/v1";
/** Digest of the versioned SDK/native surface this adapter owns; harness configurations must pin it explicitly. */
export const FACTORY_CONTRACT_DIGEST: `sha256:${string}` = `sha256:${digestMetadata({
  cliVersion: FACTORY_CLI_VERSION, sdkVersion: FACTORY_SDK_VERSION,
  command: ["exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"],
  terminal: "droid.session_notification:agent_turn_completed bound to owned session and messageId",
}).value}`;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AUTONOMY_LEVELS: readonly FactoryAutonomyLevel[] = ["off", "low", "medium", "high"];
const PERMISSION_DECISIONS: readonly FactoryPermissionDecision[] = ["proceed_once", "cancel"];
const REASONING_EFFORTS: readonly FactoryReasoningEffort[] = ["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type FactoryModelConfiguration = {
  schemaVersion: typeof FACTORY_CONFIG_SCHEMA_VERSION;
  kind: "model";
  /** Provider label is provenance; the Factory-managed model route is selected by model ID. */
  provider: string;
  /** Native Factory model ID. */
  model: string;
  reasoningEffort: FactoryReasoningEffort;
  /** Environment variable copied into the isolated child for authentication; defaults to FACTORY_API_KEY. */
  credentialEnv?: string;
};

export type FactoryHarnessConfiguration = {
  schemaVersion: typeof FACTORY_CONFIG_SCHEMA_VERSION;
  kind: "harness";
  adapter: typeof FACTORY_HARNESS;
  executable: string;
  version: typeof FACTORY_CLI_VERSION;
  sdkVersion: typeof FACTORY_SDK_VERSION;
  contractDigest: `sha256:${string}`;
};

export type FactoryNativeLimitsConfiguration = {
  schemaVersion: typeof FACTORY_CONFIG_SCHEMA_VERSION;
  kind: "native-limits";
  shutdownGraceMs?: number;
};

export type FactoryNativeToolPolicyConfiguration = {
  schemaVersion: typeof FACTORY_CONFIG_SCHEMA_VERSION;
  kind: "native-tool-policy";
  autonomyLevel: FactoryAutonomyLevel;
  /** Unattended answer for every `droid.request_permission`; the native request and answer stay in evidence. */
  permissionDecision: FactoryPermissionDecision;
};

export type FactoryCaptureProfileConfiguration = {
  schemaVersion: typeof FACTORY_CONFIG_SCHEMA_VERSION;
  kind: "capture-profile";
  workspaceOutcome?: {
    excludeDirectoryNames: string[];
    respectGitignore?: boolean;
    omitEmptyDirectories?: boolean;
  };
};

export type FactoryConfigurationRecord = FactoryModelConfiguration | FactoryHarnessConfiguration
  | FactoryNativeLimitsConfiguration | FactoryNativeToolPolicyConfiguration | FactoryCaptureProfileConfiguration;
export type FactoryConfigurationKind = FactoryConfigurationRecord["kind"];

export type CaptureFactoryDroidVerifier = (
  context: VerifierExecutionContext,
  workspace: CapturedWorkspaceOutcome,
  workspacePath: string,
) => VerifierResult | Promise<VerifierResult>;

export type CaptureFactoryDroidRunOptions = {
  definition: RunBundleDefinition;
  startingWorkspacePath: string;
  workspace: WorkspaceCoordinator;
  configuration: FactoryDroidConfiguration;
  prompt: string;
  verifier?: CaptureFactoryDroidVerifier;
  workspaceOutcomeExcludedDirectoryNames?: readonly string[];
  workspaceOutcomeRespectsGitignore?: boolean;
  workspaceOutcomeOmitsEmptyDirectories?: boolean;
  signal?: AbortSignal;
  maxWallClockMs?: number;
  shutdownGraceMs?: number;
  capture?: typeof captureFactoryDroid;
};

export type CaptureFactoryDroidRunResult = {
  attempt: RunAttemptResult;
  manifest: RunManifest;
  qualification: CaptureQualificationReport;
  capture?: FactoryCapture;
  normalized?: NormalizedDataset;
  coverage?: AdapterCoverageReport;
};

/** Execute and retain one caller-configured Factory native attempt without scheduling or retrying it. */
export async function captureFactoryDroidRun(options: CaptureFactoryDroidRunOptions): Promise<CaptureFactoryDroidRunResult> {
  if (options.definition.run.harness.id !== FACTORY_HARNESS) throw new Error(`Factory run harness must be ${FACTORY_HARNESS}.`);
  if (options.definition.run.harness.version !== options.configuration.version) throw new Error("The declared harness version must match the Factory CLI configuration.");
  if (options.definition.run.model.id !== options.configuration.model) {
    throw new Error("The declared model must match the Factory CLI configuration.");
  }
  validateFactoryConfiguration(options.configuration);
  const shutdownGraceMs = options.shutdownGraceMs ?? FACTORY_DEFAULT_SHUTDOWN_GRACE_MS;
  const assembler = await createRunBundleAssembler(withPinnedRuntime(options.definition));
  let workspace: WorkspaceExecutionResult | undefined;
  let workspaceOutcome: CapturedWorkspaceOutcome | undefined;
  let workspaceOutcomePromise: Promise<CapturedWorkspaceOutcome> | undefined;
  let verifierResult: VerifierResult | undefined;
  let capture: FactoryCapture | undefined;
  let sessionEvidenceRegistered = false;
  let telemetryEvidenceRegistered = false;

  const captureWorkspace = async (context?: VerifierExecutionContext): Promise<CapturedWorkspaceOutcome> => {
    if (workspaceOutcome !== undefined) return workspaceOutcome;
    if (workspace?.status !== "ready" || workspace.path === undefined || workspace.artifactId === undefined) {
      throw new Error("Factory capture requires a ready retained workspace before outcome packaging.");
    }
    workspaceOutcomePromise ??= assembler.captureWorkspaceOutcome({
      startPath: options.startingWorkspacePath,
      finalPath: workspace.path,
      id: workspace.artifactId,
      source: "factory-workspace-outcome",
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
    if (!sessionEvidenceRegistered && await nonempty(`${assembler.bundleRoot}/session.jsonl`)) {
      await assembler.registerArtifact({
        id: "session",
        source: FACTORY_HARNESS,
        kind: "session",
        mediaType: "application/x-ndjson",
        sharingClass: "restricted",
        relativePath: "session.jsonl",
        ...(capture?.sessionId === undefined ? {} : { nativeReference: { type: "session", id: capture.sessionId } }),
      });
      sessionEvidenceRegistered = true;
    }
    if (!telemetryEvidenceRegistered && capture !== undefined) {
      await assembler.writeJsonArtifact({
      id: "telemetry",
      source: FACTORY_HARNESS,
      kind: "telemetry",
      mediaType: "application/json",
      sharingClass: "restricted",
      relativePath: "telemetry/factory.json",
      }, capture.telemetry);
      telemetryEvidenceRegistered = true;
    }
  };

  const coordinatedWorkspace: WorkspaceCoordinator = {
    setup: async (context) => {
      workspace = await options.workspace.setup(context);
      return workspace;
    },
    cleanup: async (context) => {
      // Packaging gaps must not rewrite native completion or delete recoverable work.
      if (workspace?.status === "ready") {
        try { await captureWorkspace(); } catch { return; }
      }
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
  const performCapture = options.capture ?? captureFactoryDroid;
  const attempt = await executeRunAttempt({
    run,
    assessmentMode: options.definition.run.assessmentMode,
    attempt: attemptIdentity,
    workspace: coordinatedWorkspace,
    harness: async ({ signal, registerShutdown }) => {
      if (workspace?.status !== "ready" || workspace.path === undefined) throw new Error("Factory run requires a ready workspace.");
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
        return { status: "interrupted", reason: "Factory turn was cancelled.", evidence: durableCaptureEvidence(capture) };
      }
      return {
        status: "failed",
        failureClass: "infrastructure",
        reason: capture.gaps.find(({ kind }) => kind === "capture-error")?.detail ?? `Factory turn ended as ${String(capture.terminalStatus)}.`,
        evidence: durableCaptureEvidence(capture),
      };
    },
    ...(options.verifier === undefined ? {} : {
      verifier: async (context) => {
        await captureWorkspace(context);
        if (verifierResult === undefined) throw new Error("Factory verifier did not return a result.");
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
  if (capture?.sessionId === undefined) missingEvidence.push({
    kind: "session-identity", reason: "not-collected", affects: ["semantic"], detail: "Factory did not return an owned native session identity.",
  });
  for (const gap of capture?.gaps ?? []) missingEvidence.push({
    kind: gap.kind,
    reason: gap.kind === "interrupt-acknowledgement" ? "process-interrupted" : "not-collected",
    affects: [gap.kind.includes("telemetry") ? "timing-resource" : "semantic"],
    detail: gap.detail,
  });
  missingEvidence.push({ kind: "telemetry-receipt", reason: "not-checked", affects: ["timing-resource"],
    detail: "Factory OTLP is not collected by this adapter; native token usage remains available." });
  missingEvidence.push({
    kind: "child-history",
    reason: "not-checked",
    affects: ["semantic"],
    detail: "Child identities are retained when exposed; complete child history is not fetched.",
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
  if (capture === undefined || capture.sessionId === undefined) return { attempt, manifest, qualification, capture };
  const { dataset, coverage } = await describeAndValidateFactoryDataset(capture);
  return { attempt, manifest, qualification, capture, normalized: dataset, coverage };
}

export type RunFactoryQueueEntryOptions = {
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
  capture?: typeof captureFactoryDroid;
};

export type FactoryRunSummary = {
  runId: string;
  attemptId: string;
  bundlePath: string;
  terminal: TerminalRecord;
  classification: RunAttemptResult["classification"]["kind"];
  captureQualification: CaptureQualificationStatus;
  assessmentMode: TaskPacket["assessmentMode"];
  sessionId?: string;
  stopReason?: string;
  normalizedEvents: number;
  unmappedNativeRecords: number;
  retainedWorkspacePath?: string;
};

/** Execute exactly one persisted frozen queue entry through the pinned Factory CLI adapter. */
export async function runFactoryQueueEntry(options: RunFactoryQueueEntryOptions): Promise<FactoryRunSummary> {
  const bundleRoot = resolve(options.bundleRoot);
  const queue = readRunQueue(options.queuePath, undefined, { bundleRoot });
  const matches = queue.entries.filter((entry) => entry.runId === options.runId);
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? `Run "${options.runId}" is not in the queue.` : `Run "${options.runId}" matches more than one queue entry.`);
  const entry = matches[0]!;
  const model = resolveFactoryConfigurationRecord(bundleRoot, entry.configuration.model, "model");
  const harness = resolveFactoryConfigurationRecord(bundleRoot, entry.configuration.harness, "harness");
  const limits = resolveFactoryConfigurationRecord(bundleRoot, entry.configuration.nativeLimits, "native-limits");
  const toolPolicy = resolveFactoryConfigurationRecord(bundleRoot, entry.configuration.nativeToolPolicy, "native-tool-policy");
  const captureProfile = resolveFactoryConfigurationRecord(bundleRoot, queue.captureProfile, "capture-profile");
  if (entry.harness.id !== FACTORY_HARNESS) throw new Error(`Queue harness must be ${FACTORY_HARNESS}.`);
  const runtime = await (options.probeRuntime ?? probeFactoryRuntime)(harness.executable);
  if (runtime.version !== harness.version) throw new Error(`Factory CLI ${harness.version} is required; received ${runtime.version}.`);

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
    baselineRoot = await mkdtemp(join(tmpdir(), "ebo-factory-baseline-"));
    const startingWorkspacePath = join(baselineRoot, "workspace");
    await cp(workspace.path, startingWorkspacePath, { recursive: true, preserveTimestamps: true, force: false });
    const verifierReference = packet.assessmentMode === "verified" ? packet.restricted.verifier : undefined;
    const verifierFormat = verifierReference?.locator.toLowerCase().endsWith(".mjs") ? "module" : "commonjs";
    const definition = buildDefinition(queue.captureProfile, entry, packet, destination, attemptId, model, harness, verifierFormat);
    const result = await captureFactoryDroidRun({
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
        model: model.model,
        reasoningEffort: model.reasoningEffort,
        sdkVersion: harness.sdkVersion,
        autonomyLevel: toolPolicy.autonomyLevel,
        permissionDecision: toolPolicy.permissionDecision,
        ...(model.credentialEnv === undefined ? {} : { credentialEnv: model.credentialEnv }),
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
    const stopReason = result.capture?.terminal?.reason;
    return {
      runId: entry.runId,
      attemptId,
      bundlePath: destination,
      terminal: manifest.terminal,
      classification: result.attempt.classification.kind,
      captureQualification: result.qualification.status,
      assessmentMode: packet.assessmentMode,
      ...(result.capture?.sessionId === undefined ? {} : { sessionId: result.capture.sessionId }),
      ...(typeof stopReason === "string" ? { stopReason } : {}),
      normalizedEvents: result.normalized?.events.length ?? 0,
      unmappedNativeRecords: result.normalized?.unmapped.length ?? 0,
      ...(workspace.state === "ready" ? { retainedWorkspacePath: workspace.path } : {}),
    };
  } finally {
    if (baselineRoot !== undefined) await rm(baselineRoot, { recursive: true, force: true });
    if (!captureStarted && workspace.state === "ready") await cleanupWorkspace(workspace).catch(() => undefined);
  }
}

type FactoryConfigurationByKind = {
  model: FactoryModelConfiguration;
  harness: FactoryHarnessConfiguration;
  "native-limits": FactoryNativeLimitsConfiguration;
  "native-tool-policy": FactoryNativeToolPolicyConfiguration;
  "capture-profile": FactoryCaptureProfileConfiguration;
};

export function resolveFactoryConfigurationRecord<Kind extends FactoryConfigurationKind>(
  bundleRoot: string,
  reference: ArtifactReference,
  kind: Kind,
): FactoryConfigurationByKind[Kind] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(resolveBundleConfiguration(bundleRoot, reference));
  assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== FACTORY_CONFIG_SCHEMA_VERSION || value.kind !== kind) {
    throw configError(reference, `must declare ${FACTORY_CONFIG_SCHEMA_VERSION} kind ${kind}`);
  }
  validateConfiguration(value, kind, reference);
  return value as FactoryConfigurationByKind[Kind];
}

function validateConfiguration(record: Record<string, unknown>, kind: FactoryConfigurationKind, reference: ArtifactReference): void {
  if (kind === "model") {
    keys(record, ["schemaVersion", "kind", "provider", "model", "reasoningEffort", "credentialEnv"], ["provider", "model", "reasoningEffort"], reference);
    requiredText(record.provider, "provider", reference);
    requiredText(record.model, "model", reference);
    if (!REASONING_EFFORTS.includes(record.reasoningEffort as FactoryReasoningEffort)) throw configError(reference, "reasoningEffort is invalid");
    if (record.credentialEnv !== undefined && (typeof record.credentialEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(record.credentialEnv))) throw configError(reference, "credentialEnv must be an environment variable name");
  } else if (kind === "harness") {
    keys(record, ["schemaVersion", "kind", "adapter", "executable", "version", "sdkVersion", "contractDigest"], ["adapter", "executable", "version", "sdkVersion", "contractDigest"], reference);
    if (record.adapter !== FACTORY_HARNESS || record.version !== FACTORY_CLI_VERSION || record.sdkVersion !== FACTORY_SDK_VERSION) throw configError(reference, "adapter or version is not pinned");
    requiredText(record.executable, "executable", reference);
    if (!isAbsolute(record.executable as string)) throw configError(reference, "executable must be absolute");
    if (record.contractDigest !== FACTORY_CONTRACT_DIGEST) throw configError(reference, `contractDigest must be ${FACTORY_CONTRACT_DIGEST}`);
  } else if (kind === "native-limits") {
    keys(record, ["schemaVersion", "kind", "shutdownGraceMs"], [], reference);
    if (record.shutdownGraceMs !== undefined && (!Number.isSafeInteger(record.shutdownGraceMs) || (record.shutdownGraceMs as number) < 1 || (record.shutdownGraceMs as number) > 60_000)) throw configError(reference, "shutdownGraceMs must be positive");
  } else if (kind === "native-tool-policy") {
    keys(record, ["schemaVersion", "kind", "autonomyLevel", "permissionDecision"], ["autonomyLevel", "permissionDecision"], reference);
    if (!AUTONOMY_LEVELS.includes(record.autonomyLevel as FactoryAutonomyLevel)) throw configError(reference, "autonomyLevel is invalid");
    if (!PERMISSION_DECISIONS.includes(record.permissionDecision as FactoryPermissionDecision)) throw configError(reference, "permissionDecision is invalid");
  } else {
    keys(record, ["schemaVersion", "kind", "workspaceOutcome"], [], reference);
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
  model: FactoryModelConfiguration,
  harness: FactoryHarnessConfiguration,
  verifierFormat: "commonjs" | "module",
): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-${attemptId}`,
    run: {
      id: entry.runId,
      trial: { index: entry.trial.index },
      assessmentMode: packet.assessmentMode,
      task: { id: entry.task.id, digest: `sha256:${entry.task.packetRef.digest.value}` },
      fixture: { id: packet.agentInput.fixture.source.locator, digest: `sha256:${packet.agentInput.fixture.source.digest.value}` },
      model: { provider: model.provider, id: model.model, configurationDigest: `sha256:${entry.configuration.model.digest.value}` },
      harness: { id: FACTORY_HARNESS, version: harness.version, configurationDigest: `sha256:${entry.configuration.harness.digest.value}` },
      runtime: [
        { source: "Factory", name: "factory-droid", version: harness.version },
        { source: "Factory", name: "@factory/droid-sdk", version: FACTORY_SDK_VERSION },
        { source: "EBO", name: "factory-adapter", version: FACTORY_ADAPTER_VERSION },
      ],
      ...(packet.assessmentMode === "verified" ? {
        verifier: { locator: packet.restricted.verifier.locator, digest: `sha256:${packet.restricted.verifier.digest.value}`, format: verifierFormat },
      } : {}),
    },
    attempt: { id: attemptId, number: 1 },
    configuration: {
      digest: `sha256:${digestMetadata({ model: entry.configuration.model, harness: entry.configuration.harness, captureProfile }).value}`,
      captureProfileDigest: `sha256:${captureProfile.digest.value}`,
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
      harness: { ...structuredClone(definition.run.harness), id: FACTORY_HARNESS, version: FACTORY_CLI_VERSION },
      runtime: definition.run.runtime.filter(({ name }) => !["factory-droid", "@factory/droid-sdk", "factory-adapter"].includes(name)).concat([
        { source: "Factory", name: "factory-droid", version: FACTORY_CLI_VERSION },
        { source: "Factory", name: "@factory/droid-sdk", version: FACTORY_SDK_VERSION },
        { source: "EBO", name: "factory-adapter", version: FACTORY_ADAPTER_VERSION },
      ]),
    },
  };
}

function durableCaptureEvidence(capture: FactoryCapture): Record<string, unknown> {
  return {
    qualification: capture.qualification,
    ...(capture.sessionId === undefined ? {} : { sessionId: capture.sessionId }),
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
  return new Error(`Factory configuration "${reference.locator}" ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
