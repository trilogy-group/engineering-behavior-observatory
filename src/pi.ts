import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  type AgentSessionEvent,
  type ExtensionAPI,
  type InlineExtension,
  type ProviderConfig,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact, validateRunManifestEvidence } from "./artifacts.js";
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
import {
  createCapturedNativeEvidenceResolver,
  describeNormalizedDataset,
  validateNormalizedDataset,
  type AdapterCoverageReport,
  type NormalizedDataset,
} from "./normalization-integrity.js";
import { JsonlEvidenceWriter } from "./process-protocol.js";
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
import {
  type AdapterCapabilityProfile,
  type CapturedNativeRecord,
  type NativeEvidenceResolver,
  type NormalizationInput,
  type NormalizationResult,
  type UniformAttributeValue,
  type UniformEvent,
} from "./uniform-events.js";
import { cleanupWorkspace, materializeWorkspace } from "./workspaces.js";

export const PI_HARNESS = "pi-sdk";
export const PI_CONFIG_SCHEMA_VERSION = "ebo.pi-config/v1";
export const PI_ADAPTER_VERSION = "1.0.0";
export const PINNED_PI_SDK_VERSION = "0.85.1";

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PI_APIS = ["anthropic-messages", "openai-completions", "openai-responses", "google-generative-ai"] as const;
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PI_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

type PiCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export type PiModelConfiguration = {
  schemaVersion: typeof PI_CONFIG_SCHEMA_VERSION;
  kind: "model";
  provider: string;
  queueModelId: string;
  model: string;
  api: typeof PI_APIS[number];
  baseUrl: string;
  apiKeyEnv: string;
  thinkingLevel: typeof PI_THINKING_LEVELS[number];
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  cost: PiCost;
};

export type PiHarnessConfiguration = {
  schemaVersion: typeof PI_CONFIG_SCHEMA_VERSION;
  kind: "harness";
  adapter: typeof PI_HARNESS;
  version: typeof PINNED_PI_SDK_VERSION;
  extensions?: ArtifactReference[];
  skills?: ArtifactReference[];
  prompts?: ArtifactReference[];
  contextFiles?: ArtifactReference[];
  systemPrompt?: ArtifactReference;
};

export type PiNativeLimitsConfiguration = {
  schemaVersion: typeof PI_CONFIG_SCHEMA_VERSION;
  kind: "native-limits";
  shutdownGraceMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  providerTimeoutMs?: number;
};

export type PiNativeToolPolicyConfiguration = {
  schemaVersion: typeof PI_CONFIG_SCHEMA_VERSION;
  kind: "native-tool-policy";
  tools: typeof PI_TOOLS[number][];
  excludeTools?: typeof PI_TOOLS[number][];
  environmentAllowlist: string[];
};

export type PiCaptureProfileConfiguration = {
  schemaVersion: typeof PI_CONFIG_SCHEMA_VERSION;
  kind: "capture-profile";
  passiveObserver?: boolean;
  includeProviderPayloads?: boolean;
  workspaceOutcome?: {
    excludeDirectoryNames: string[];
    respectGitignore?: boolean;
    omitEmptyDirectories?: boolean;
  };
};

export type PiConfigurationRecord = PiModelConfiguration | PiHarnessConfiguration
  | PiNativeLimitsConfiguration | PiNativeToolPolicyConfiguration | PiCaptureProfileConfiguration;
export type PiConfigurationKind = PiConfigurationRecord["kind"];

export type PiNativeRecord = Record<string, unknown>;

export const piCapabilityProfile: AdapterCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: `${PI_HARNESS}/v1`,
  harness: PI_HARNESS,
  nativeTypes: [
    "session", "history:message", "history:model_change", "history:thinking_level_change", "history:compaction", "history:branch_summary",
    "stream:agent_start", "stream:agent_end", "stream:agent_settled", "stream:turn_start", "stream:turn_end",
    "stream:message_start", "stream:message_update", "stream:message_end", "stream:tool_execution_start",
    "stream:tool_execution_update", "stream:tool_execution_end", "stream:compaction_start", "stream:compaction_end",
    "stream:auto_retry_start", "stream:auto_retry_end", "observer:session_start", "observer:session_shutdown",
    "observer:context", "observer:before_provider_request", "observer:before_provider_headers",
    "observer:after_provider_response", "observer:before_agent_start", "observer:tool_call", "observer:tool_result",
    "observer:session_before_compact", "observer:session_compact", "observer:session_compact_failed",
    "adapter:session_created", "adapter:capture_error", "adapter:cleanup",
  ],
  families: {
    message: { status: "available" },
    "model-request": { status: "partial", detail: "Available when the caller enables the passive observer." },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "unsupported", detail: "Pi's selected public SDK events do not expose a distinct permission decision record." },
    delegation: { status: "unsupported", detail: "Child-session/delegation histories are outside this one-session runner." },
    artifact: { status: "partial", detail: "Workspace outcome is authoritative; only tool events explicitly identify mutations." },
    validation: { status: "partial", detail: "Validation is identified only when the native tool name or command is explicit." },
    runtime: { status: "available" },
    outcome: { status: "available" },
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "Pi history and subscription/observer records retain separate source-local order domains." },
    nativeTime: { status: "partial", detail: "History timestamps are native; adapter receipt timestamps are labeled and not promoted to native time." },
    parentage: { status: "partial", detail: "Pi session entry IDs and parent IDs remain authoritative in native history." },
    content: { status: "partial", detail: "Native content remains restricted and is referenced rather than copied into uniform events." },
  },
};

type PiRecordedEnvelope = {
  schemaVersion: "ebo.pi-native-record/v1";
  sequence: number;
  receivedAt: string;
  channel: "stream" | "observer" | "adapter";
  nativeType: string;
  sessionId?: string;
  hook?: string;
  stage?: string;
  extensionOrder?: number;
  payload: unknown;
};

class PiEvidenceRecorder {
  readonly writer: JsonlEvidenceWriter;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private error: unknown;

  public constructor(path: string) {
    this.writer = new JsonlEvidenceWriter(path, { exclusive: true });
  }

  public record(input: Omit<PiRecordedEnvelope, "schemaVersion" | "sequence" | "receivedAt">): Promise<void> {
    let snapshot: typeof input;
    try {
      snapshot = jsonSnapshot(input);
    } catch (error) {
      this.error ??= error;
      return Promise.resolve();
    }
    const record: PiRecordedEnvelope = {
      schemaVersion: "ebo.pi-native-record/v1",
      sequence: ++this.sequence,
      receivedAt: new Date().toISOString(),
      ...snapshot,
    };
    this.queue = this.queue.then(() => this.writer.append(record)).catch((error: unknown) => {
      this.error ??= error;
    });
    return this.queue;
  }

  public async flush(): Promise<void> {
    await this.queue;
    if (this.error !== undefined) throw this.error;
    await this.writer.flush();
  }

  public async close(): Promise<void> {
    await this.queue;
    await this.writer.close();
  }
}

export type PiSession = {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly messages: unknown[];
  readonly extensionRunner?: { emit(event: unknown): Promise<unknown> };
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean; source?: "extension" }): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  exportToJsonl(outputPath?: string): string;
  getActiveToolNames(): string[];
  dispose(): void;
};

export type PiSessionFactoryInput = {
  workspacePath: string;
  sessionDirectory: string;
  model: PiModelConfiguration;
  harness: PiHarnessConfiguration;
  limits: PiNativeLimitsConfiguration;
  toolPolicy: PiNativeToolPolicyConfiguration;
  captureProfile: PiCaptureProfileConfiguration;
  bundleRoot: string;
  observer: PiEvidenceRecorder;
  signal: AbortSignal;
};

export type PiSessionFactory = (input: PiSessionFactoryInput) => Promise<PiSession>;

export type CapturePiSdkRunOptions = {
  definition: RunBundleDefinition;
  configurationRoot: string;
  startingWorkspacePath: string;
  workspace: WorkspaceCoordinator;
  model: PiModelConfiguration;
  harness: PiHarnessConfiguration;
  limits: PiNativeLimitsConfiguration;
  toolPolicy: PiNativeToolPolicyConfiguration;
  captureProfile: PiCaptureProfileConfiguration;
  prompt: string;
  verifier?: (context: VerifierExecutionContext, workspace: CapturedWorkspaceOutcome, workspacePath: string) => VerifierResult | Promise<VerifierResult>;
  workspaceOutcomeExcludedDirectoryNames?: readonly string[];
  workspaceOutcomeRespectsGitignore?: boolean;
  workspaceOutcomeOmitsEmptyDirectories?: boolean;
  signal?: AbortSignal;
  maxWallClockMs?: number;
  createSession?: PiSessionFactory;
};

export type CapturePiSdkRunResult = {
  attempt: RunAttemptResult;
  manifest: RunManifest;
  qualification: CaptureQualificationReport;
};

/** Execute one direct Pi TypeScript SDK session and retain native history, transient events, and passive observations. */
export async function capturePiSdkRun(options: CapturePiSdkRunOptions): Promise<CapturePiSdkRunResult> {
  if (PI_SDK_VERSION !== PINNED_PI_SDK_VERSION) throw new Error(`Pi SDK ${PINNED_PI_SDK_VERSION} is required; installed ${PI_SDK_VERSION}.`);
  if (options.definition.run.harness.id !== PI_HARNESS) throw new Error(`Pi run harness must be ${PI_HARNESS}.`);
  if (options.definition.run.model.id !== options.model.model) throw new Error("Declared model does not match Pi configuration.");
  if (options.toolPolicy.environmentAllowlist.includes(options.model.apiKeyEnv)) {
    throw new Error("Pi tool environment allowlist must not expose the provider credential variable.");
  }

  const assembler = await createRunBundleAssembler(withPinnedRuntime(options.definition));
  const stream = new PiEvidenceRecorder(join(assembler.bundleRoot, "pi-events.jsonl"));
  const observer = new PiEvidenceRecorder(join(assembler.bundleRoot, "pi-observer.jsonl"));
  let workspace: WorkspaceExecutionResult | undefined;
  let workspaceOutcome: CapturedWorkspaceOutcome | undefined;
  let workspaceOutcomePromise: Promise<CapturedWorkspaceOutcome> | undefined;
  let verifierResult: VerifierResult | undefined;
  let sessionId: string | undefined;
  let sessionExported = false;
  let sessionExportFailed = false;
  let terminalEvidenceObserved = false;
  let agentSettledObserved = false;
  let adapterFinalized = true;
  let adapterFinalizationTimedOut = false;
  let adapterFinalizationFailure: string | undefined;
  let recorderCloseFailure: string | undefined;

  const captureWorkspace = async (context?: VerifierExecutionContext): Promise<CapturedWorkspaceOutcome> => {
    if (workspaceOutcome !== undefined) return workspaceOutcome;
    if (workspace?.status !== "ready" || workspace.path === undefined || workspace.artifactId === undefined) {
      throw new Error("Pi capture requires a ready retained workspace before outcome packaging.");
    }
    workspaceOutcomePromise ??= assembler.captureWorkspaceOutcome({
      startPath: options.startingWorkspacePath,
      finalPath: workspace.path,
      id: workspace.artifactId,
      source: "pi-sdk-workspace-outcome",
      ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : { excludeDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames }),
      ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : { respectGitignore: options.workspaceOutcomeRespectsGitignore }),
      ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : { omitEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories }),
    }, context === undefined || options.verifier === undefined ? undefined : async (path, outcome) => {
      verifierResult = await options.verifier!(context, outcome, path);
    });
    workspaceOutcome = await workspaceOutcomePromise;
    return workspaceOutcome;
  };

  const coordinatedWorkspace: WorkspaceCoordinator = {
    setup: async (context) => {
      workspace = await options.workspace.setup(context);
      return workspace;
    },
    cleanup: async (context) => {
      // Retain the source on packaging failure; the assembler records the outcome gap.
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
    harnessId: PI_HARNESS,
  });
  const attemptIdentity = createAttemptIdentity(
    options.definition.run.id,
    options.definition.attempt.number,
    options.definition.attempt.id,
    options.definition.attempt.retryOf,
  );
  const createSession = options.createSession ?? createProductionPiSession;
  let attempt: RunAttemptResult;
  try {
    attempt = await executeRunAttempt({
      run,
      assessmentMode: options.definition.run.assessmentMode,
      attempt: attemptIdentity,
      workspace: coordinatedWorkspace,
      evidence: { flush: () => Promise.all([stream.flush(), observer.flush()]).then(() => undefined) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.maxWallClockMs === undefined ? {} : { maxWallClockMs: options.maxWallClockMs }),
      ...(options.limits.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.limits.shutdownGraceMs }),
      harness: async ({ registerShutdown, signal }) => {
        if (workspace?.status !== "ready" || workspace.path === undefined) throw new Error("Pi run requires a ready workspace.");
        let session: PiSession | undefined;
        let unsubscribe: (() => void) | undefined;
        let failure: unknown;
        let resolveAdapterFinalized!: () => void;
        const adapterFinalizationPromise = new Promise<void>((resolvePromise) => { resolveAdapterFinalized = resolvePromise; });
        adapterFinalized = false;
        let signalAbort: Promise<void> | undefined;
        const abortSession = (): void => {
          if (session === undefined || signalAbort !== undefined) return;
          signalAbort = session.abort();
          void signalAbort.catch(() => undefined);
        };
        registerShutdown(async () => {
          abortSession();
          const outcomes = await Promise.allSettled([signalAbort ?? Promise.resolve(), session?.waitForIdle() ?? Promise.resolve(), adapterFinalizationPromise]);
          const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
          if (rejected !== undefined) throw rejected.reason;
        });
        try {
          session = await createSession({
            workspacePath: workspace.path,
            sessionDirectory: join(assembler.bundleRoot, ".pi-native"),
            model: options.model,
            harness: options.harness,
            limits: options.limits,
            toolPolicy: options.toolPolicy,
            captureProfile: options.captureProfile,
            bundleRoot: resolve(options.configurationRoot),
            observer,
            signal,
          });
          sessionId = session.sessionId;
          if (signal.aborted) await session.abort();
          else signal.addEventListener("abort", abortSession, { once: true });
          await stream.record({
            channel: "adapter",
            nativeType: "session_created",
            sessionId,
            payload: piComposition(options, session.getActiveToolNames()),
          });
          unsubscribe = session.subscribe((event) => {
            if (event.type === "agent_settled") agentSettledObserved = true;
            void stream.record({ channel: "stream", nativeType: event.type, sessionId, payload: compactPiStreamEvent(event) });
          });
          if (signal.aborted) return { status: "interrupted", reason: "Pi session was aborted before prompting.", evidence: piEvidence(sessionId, session) };
          await session.prompt(options.prompt, { expandPromptTemplates: false, source: "extension" });
          await session.waitForIdle();
          const lastAssistant = [...session.messages].reverse().find((message) => isRecord(message) && message.role === "assistant") as Record<string, unknown> | undefined;
          if (lastAssistant === undefined) {
            failure = new Error("Pi prompt settled without an assistant terminal message.");
            return { status: "failed", failureClass: "infrastructure", reason: errorMessage(failure), evidence: piEvidence(sessionId, session) };
          }
          if (lastAssistant.stopReason === "aborted") {
            terminalEvidenceObserved = true;
            return { status: "interrupted", reason: "Pi session was aborted.", evidence: piEvidence(sessionId, session) };
          }
          if (lastAssistant.stopReason === "error") {
            terminalEvidenceObserved = true;
            failure = new Error(text(lastAssistant.errorMessage) ?? "Pi provider returned an error terminal.");
            return {
              status: "failed",
              failureClass: "infrastructure",
              reason: errorMessage(failure),
              evidence: piEvidence(sessionId, session),
            };
          }
          if (!["stop", "length"].includes(String(lastAssistant.stopReason)) || !agentSettledObserved) {
            failure = new Error("Pi prompt settled without a recognized assistant terminal and agent_settled evidence.");
            return { status: "failed", failureClass: "infrastructure", reason: errorMessage(failure), evidence: piEvidence(sessionId, session) };
          }
          terminalEvidenceObserved = true;
          return {
            status: "completed",
            completionEvidence: { sessionId, stopReason: lastAssistant.stopReason },
            evidence: piEvidence(sessionId, session),
          };
        } catch (error) {
          failure = error;
          await stream.record({ channel: "adapter", nativeType: "capture_error", ...(sessionId === undefined ? {} : { sessionId }), payload: { message: errorMessage(error) } });
          return { status: "failed", failureClass: "infrastructure", reason: errorMessage(error), evidence: piEvidence(sessionId, session) };
        } finally {
          try {
            if (session !== undefined) {
              await session.waitForIdle().catch(() => undefined);
              let exportFailure: unknown;
              if (!adapterFinalizationTimedOut && session.extensionRunner !== undefined) {
                try {
                  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
                } catch (error) {
                  exportFailure = error;
                  sessionExportFailed = true;
                  await observer.record({
                    channel: "observer",
                    nativeType: "extension_error",
                    hook: "session_shutdown",
                    stage: "extension-error",
                    payload: { event: "session_shutdown", error: errorMessage(error) },
                  });
                }
              }
              unsubscribe?.();
              const nativeDirectory = join(assembler.bundleRoot, ".pi-native");
              if (!adapterFinalizationTimedOut) {
                const pendingSessionPath = join(nativeDirectory, "retained-session.pending.jsonl");
                try {
                  await mkdir(nativeDirectory, { recursive: true });
                  const nativeSessionPath = session.sessionFile;
                  if (nativeSessionPath !== undefined && await nonempty(nativeSessionPath)) {
                    await cp(nativeSessionPath, pendingSessionPath, { force: true });
                  } else {
                    session.exportToJsonl(pendingSessionPath);
                    if (options.createSession === undefined) sessionExportFailed = true;
                  }
                  if (!adapterFinalizationTimedOut) {
                    renameSync(pendingSessionPath, join(assembler.bundleRoot, "pi-session.jsonl"));
                    sessionExported = true;
                  }
                } catch (error) {
                  exportFailure ??= error;
                  sessionExportFailed = true;
                }
              }
              session.dispose();
              if (!adapterFinalizationTimedOut) {
                await stream.record({ channel: "adapter", nativeType: "cleanup", sessionId, payload: {
                  disposed: true, promptFailed: failure !== undefined, sessionExported,
                  ...(exportFailure === undefined ? {} : { exportError: errorMessage(exportFailure) }),
                } });
                if (sessionExported) await rm(nativeDirectory, { recursive: true, force: true });
                if (exportFailure !== undefined) throw exportFailure;
              }
            }
          } finally {
            signal.removeEventListener("abort", abortSession);
            adapterFinalized = true;
            resolveAdapterFinalized();
          }
        }
      },
      ...(options.verifier === undefined ? {} : {
        verifier: async (context) => {
          await captureWorkspace(context);
          if (verifierResult === undefined) throw new Error("Pi verifier did not return a result.");
          await assembler.writeJsonArtifact({
            id: "verifier", source: "ebo-verifier", kind: "verifier", mediaType: "application/json",
            sharingClass: "restricted", relativePath: "verifier.json",
          }, verifierResult);
          return { status: verifierResult.status, ...(verifierResult.error === undefined ? {} : { error: verifierResult.error }), evidence: verifierResult };
        },
      }),
    });
  } finally {
    if (!adapterFinalized) {
      adapterFinalizationTimedOut = true;
      adapterFinalizationFailure = "Pi adapter finalization did not settle within the lifecycle shutdown grace period.";
      await stream.record({
        channel: "adapter",
        nativeType: "capture_error",
        ...(sessionId === undefined ? {} : { sessionId }),
        payload: { message: adapterFinalizationFailure },
      });
    }
    const closeResults = await Promise.allSettled([stream.close(), observer.close()]);
    const failures = closeResults.flatMap((result) => result.status === "rejected" ? [errorMessage(result.reason)] : []);
    if (failures.length > 0) recorderCloseFailure = `Pi recorder close failed: ${failures.join("; ")}`;
  }

  if (sessionExported && await nonempty(join(assembler.bundleRoot, "pi-session.jsonl"))) {
    await assembler.registerArtifact({
      id: "pi-session", source: PI_HARNESS, kind: "session", mediaType: "application/x-ndjson",
      sharingClass: "restricted", relativePath: "pi-session.jsonl",
      ...(sessionId === undefined ? {} : { nativeReference: { type: "session", id: sessionId } }),
    });
  }
  if (await nonempty(stream.writer.path)) {
    await assembler.registerArtifact({
      id: "pi-events", source: "pi-sdk-subscription", kind: "session", mediaType: "application/x-ndjson",
      sharingClass: "restricted", relativePath: "pi-events.jsonl",
    });
  }
  if (await nonempty(observer.writer.path)) {
    await assembler.registerArtifact({
      id: "pi-observer", source: "ebo-pi-passive-extension", kind: "session", mediaType: "application/x-ndjson",
      sharingClass: "restricted", relativePath: "pi-observer.jsonl",
    });
  }

  const missingEvidence: CaptureMissingEvidence[] = [{
    kind: "telemetry", reason: "unsupported", affects: ["timing-resource"],
    detail: "Pi 0.85.1 has no verified native OTLP receipt surface in this integration.",
  }, ...(attempt.terminal.state === "completed" && terminalEvidenceObserved ? [] : [{
    kind: "session", reason: "not-emitted" as const, affects: ["semantic" as const],
    detail: "Pi did not retain a completed assistant terminal after the owned prompt.",
  }]), ...(sessionExportFailed ? [{
    kind: "session", reason: "not-collected" as const, affects: ["semantic" as const],
    detail: "Pi session export failed; a persisted native-session fallback was retained when available.",
  }] : []), ...(attempt.record.capture?.status === "incomplete" ? [{
    kind: "session", reason: "not-collected" as const, affects: ["semantic" as const],
    detail: attempt.record.capture.error ?? "Pi evidence recorder did not drain cleanly.",
  }] : []), ...(recorderCloseFailure === undefined ? [] : [{
    kind: "session", reason: "not-collected" as const, affects: ["semantic" as const],
    detail: recorderCloseFailure,
  }]), ...(adapterFinalizationFailure === undefined ? [] : [{
    kind: "session", reason: "not-collected" as const, affects: ["semantic" as const],
    detail: adapterFinalizationFailure,
  }])];
  const qualificationOptions = {
    startingWorkspacePath: options.startingWorkspacePath,
    semanticEvidenceKinds: ["session"] as const,
    ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : { workspaceOutcomeExcludedDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames }),
    ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : { workspaceOutcomeRespectsGitignore: options.workspaceOutcomeRespectsGitignore }),
    ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : { workspaceOutcomeOmitsEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories }),
  };
  const terminal = structuredClone(attempt.terminal);
  if (workspaceOutcome === undefined) delete terminal.workspaceArtifactId;
  try {
    const native = await readPiNativeArtifacts(assembler.bundleRoot, options.definition.run.id, options.definition.attempt.id);
    qualifyRetainedPiCapture(native, sessionId, terminal.state === "completed" || terminal.failureClass === "task");
    await describeAndValidatePiDataset(native);
  } catch (error) {
    missingEvidence.push({
      kind: "session",
      reason: "not-collected",
      affects: ["semantic"],
      detail: `Pi source-specific validation failed: ${errorMessage(error)}`,
    });
  }
  const manifest = await assembler.finalize({ terminal, missingEvidence, qualification: qualificationOptions });
  const qualification = await qualifyRunBundle(assembler.bundleRoot, qualificationOptions);
  return { attempt, manifest, qualification };
}

async function createProductionPiSession(input: PiSessionFactoryInput): Promise<PiSession> {
  input.signal.throwIfAborted();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(input.sessionDirectory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
    signal: input.signal,
  });
  input.signal.throwIfAborted();
  const credentialReference = `$${input.model.apiKeyEnv}`;
  const provider: ProviderConfig = {
    name: input.model.provider,
    baseUrl: input.model.baseUrl,
    apiKey: credentialReference,
    api: input.model.api,
    models: [{
      id: input.model.model,
      name: input.model.model,
      api: input.model.api,
      reasoning: input.model.reasoning,
      ...(input.model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...input.model.thinkingLevelMap } }),
      input: [...input.model.input],
      cost: { ...input.model.cost },
      contextWindow: input.model.contextWindow,
      maxTokens: input.model.maxTokens,
    }],
  };
  modelRuntime.registerProvider(input.model.provider, provider);
  const model = modelRuntime.getModel(input.model.provider, input.model.model);
  if (model === undefined) throw new Error(`Pi model ${input.model.provider}/${input.model.model} is unavailable after explicit registration.`);

  const settingsManager = SettingsManager.inMemory({
    enableInstallTelemetry: false,
    retry: {
      enabled: (input.limits.maxRetries ?? 0) > 0,
      maxRetries: input.limits.maxRetries ?? 0,
      baseDelayMs: input.limits.retryBaseDelayMs ?? 2_000,
      provider: {
        maxRetries: 0,
        ...(input.limits.providerTimeoutMs === undefined ? {} : { timeoutMs: input.limits.providerTimeoutMs }),
      },
    },
  }, { projectTrusted: false });
  const resources = resolvePiResources(input.bundleRoot, input.harness);
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.workspacePath,
    agentDir: input.sessionDirectory,
    settingsManager,
    additionalExtensionPaths: resources.extensions,
    additionalSkillPaths: resources.skills,
    additionalPromptTemplatePaths: resources.prompts,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(resources.systemPrompt === undefined ? {} : { systemPrompt: resources.systemPrompt }),
    agentsFilesOverride: () => ({ agentsFiles: resources.contextFiles }),
    extensionFactories: input.captureProfile.passiveObserver === false
      ? []
      : [createPiPassiveObserver(input.observer, resources.extensions.length, input.captureProfile.includeProviderPayloads === true)],
  });
  await resourceLoader.reload();
  input.signal.throwIfAborted();
  const resourceErrors = resourceLoader.getExtensions().errors;
  if (resourceErrors.length > 0) throw new Error(`Pi extension loading failed: ${resourceErrors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
  const skillResult = resourceLoader.getSkills();
  const promptResult = resourceLoader.getPrompts();
  const resourceDiagnostics = [...skillResult.diagnostics, ...promptResult.diagnostics];
  if (resourceDiagnostics.length > 0) throw new Error(`Pi resource loading failed: ${resourceDiagnostics.map(({ path, message }) => `${path ?? "resource"}: ${message}`).join("; ")}`);
  const loadedExtensionPaths = new Set(resourceLoader.getExtensions().extensions.flatMap(({ resolvedPath }) => resolvedPath.startsWith("<inline:") ? [] : [resolve(resolvedPath)]));
  const loadedSkillPaths = new Set(skillResult.skills.map(({ filePath }) => resolve(filePath)));
  const loadedPromptPaths = new Set(promptResult.prompts.map(({ filePath }) => resolve(filePath)));
  if (resources.extensions.some((path) => !loadedExtensionPaths.has(resolve(path)))
      || resources.skills.some((path) => !loadedSkillPaths.has(resolve(path)))
      || resources.prompts.some((path) => !loadedPromptPaths.has(resolve(path)))) {
    throw new Error("Pi did not load every digest-pinned extension, skill, and prompt resource.");
  }
  if (resources.systemPrompt !== undefined && resourceLoader.getSystemPrompt() !== resources.systemPrompt) {
    throw new Error("Pi did not load the digest-pinned system prompt.");
  }
  if (JSON.stringify(resourceLoader.getAgentsFiles().agentsFiles) !== JSON.stringify(resources.contextFiles)) {
    throw new Error("Pi did not load the digest-pinned context files.");
  }

  const sessionManager = SessionManager.create(input.workspacePath, input.sessionDirectory);
  const allowedEnvironment = new Set(input.toolPolicy.environmentAllowlist);
  const extensionToolNames = resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const bashTool = createBashToolDefinition(input.workspacePath, {
    exposeSessionEnvironment: false,
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: filterPiToolEnvironment(env, allowedEnvironment, input.model.apiKeyEnv),
    }),
  });
  const { session, extensionsResult } = await createAgentSession({
    cwd: input.workspacePath,
    agentDir: input.sessionDirectory,
    modelRuntime,
    model,
    thinkingLevel: input.model.thinkingLevel,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: [...new Set([...input.toolPolicy.tools, ...extensionToolNames])],
    excludeTools: [...(input.toolPolicy.excludeTools ?? [])],
    customTools: input.toolPolicy.tools.includes("bash") ? [bashTool as unknown as ToolDefinition] : [],
  });
  try {
    input.signal.throwIfAborted();
    if (extensionsResult.errors.length > 0) {
      throw new Error(`Pi extension binding failed: ${extensionsResult.errors.map(({ error }) => error).join("; ")}`);
    }
    await session.bindExtensions({
      onError: (error) => {
        void input.observer.record({
          channel: "observer",
          nativeType: "extension_error",
          hook: error.event,
          stage: "extension-error",
          payload: { extensionPath: error.extensionPath, event: error.event, error: error.error },
        });
      },
    });
    const expectedTools = input.toolPolicy.tools.filter((tool) => !(input.toolPolicy.excludeTools ?? []).includes(tool)).sort();
    const activeBuiltins = session.getActiveToolNames().filter((tool) => (PI_TOOLS as readonly string[]).includes(tool)).sort();
    if (JSON.stringify(activeBuiltins) !== JSON.stringify(expectedTools)) {
      throw new Error("Pi active tools differ from the digest-pinned tool policy.");
    }
    if (session.model?.provider !== input.model.provider || session.model.id !== input.model.model
        || session.model.api !== input.model.api || session.model.baseUrl !== input.model.baseUrl) {
      throw new Error("Pi effective model/provider route differs from the digest-pinned model configuration.");
    }
    if (session.thinkingLevel !== input.model.thinkingLevel) {
      throw new Error("Pi effective thinking level differs from the digest-pinned model configuration.");
    }
    return session;
  } catch (error) {
    await session.abort().catch(() => undefined);
    session.dispose();
    throw error;
  }
}

export function filterPiToolEnvironment(
  environment: NodeJS.ProcessEnv,
  allowlist: ReadonlySet<string>,
  apiKeyEnv: string,
): NodeJS.ProcessEnv {
  if (allowlist.has(apiKeyEnv)) throw new Error("Pi tool environment allowlist must not expose the provider credential variable.");
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowlist.has(name)));
}

export function createPiPassiveObserver(recorder: PiEvidenceRecorder, extensionOrder: number, includeProviderPayloads: boolean): InlineExtension {
  const factory = (pi: ExtensionAPI): void => {
    const record = (hook: string, stage: string, payload: unknown): Promise<void> => recorder.record({
      channel: "observer", nativeType: hook, hook, stage, extensionOrder, payload,
    });
    pi.on("session_start", (event, ctx) => record(event.type, "session-lifecycle", { event, sessionId: ctx.sessionManager.getSessionId() }));
    pi.on("session_shutdown", (event, ctx) => record(event.type, "session-lifecycle", { event, sessionId: ctx.sessionManager.getSessionId() }));
    pi.on("context", (event, ctx) => record(event.type, "pre-provider-context", {
      sessionId: ctx.sessionManager.getSessionId(), messageCount: event.messages.length,
      messageTimestamps: event.messages.map((message) => isRecord(message) && typeof message.timestamp === "number" ? message.timestamp : null),
    }));
    pi.on("before_agent_start", (event, ctx) => record(event.type, "pre-agent", {
      sessionId: ctx.sessionManager.getSessionId(), promptLength: event.prompt.length,
      systemPromptLength: event.systemPrompt.length, systemPromptOptionKeys: Object.keys(event.systemPromptOptions).sort(),
    }));
    pi.on("before_provider_request", (event, ctx) => record(event.type, "pre-provider-request", {
      sessionId: ctx.sessionManager.getSessionId(),
      ...(includeProviderPayloads ? { payload: event.payload } : { payloadShape: valueShape(event.payload) }),
    }));
    pi.on("before_provider_headers", (event, ctx) => record(event.type, "pre-provider-headers", {
      sessionId: ctx.sessionManager.getSessionId(), headerNames: Object.keys(event.headers).sort(),
    }));
    pi.on("after_provider_response", (event, ctx) => record(event.type, "post-provider-response", {
      sessionId: ctx.sessionManager.getSessionId(), status: event.status, headerNames: Object.keys(event.headers).sort(),
    }));
    pi.on("tool_call", (event, ctx) => record(event.type, "pre-tool", { sessionId: ctx.sessionManager.getSessionId(), event }));
    pi.on("tool_result", (event, ctx) => record(event.type, "post-tool", { sessionId: ctx.sessionManager.getSessionId(), event }));
    pi.on("session_before_compact", (event, ctx) => record(event.type, "pre-compaction", {
      sessionId: ctx.sessionManager.getSessionId(), reason: event.reason, willRetry: event.willRetry,
      branchEntryIds: event.branchEntries.map(({ id }) => id),
    }));
    pi.on("session_compact", (event, ctx) => record(event.type, "post-compaction", { sessionId: ctx.sessionManager.getSessionId(), event }));
    pi.on("session_compact_failed", (event, ctx) => record(event.type, "post-compaction", { sessionId: ctx.sessionManager.getSessionId(), event }));
  };
  return { name: "ebo-passive-observer", factory, hidden: true };
}

type ResolvedPiResources = {
  extensions: string[];
  skills: string[];
  prompts: string[];
  contextFiles: Array<{ path: string; content: string }>;
  systemPrompt?: string;
};

function resolvePiResources(bundleRoot: string, configuration: PiHarnessConfiguration): ResolvedPiResources {
  const paths = (references: ArtifactReference[] | undefined): string[] => (references ?? []).map((reference) => {
    resolveBundleConfiguration(bundleRoot, reference);
    return resolve(bundleRoot, reference.locator);
  });
  const extensions = (configuration.extensions ?? []).map((reference) => {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(resolveBundleConfiguration(bundleRoot, reference));
    assertSelfContainedPiExtension(source, reference);
    return resolve(bundleRoot, reference.locator);
  });
  const contextFiles = (configuration.contextFiles ?? []).map((reference) => ({
    path: resolve(bundleRoot, reference.locator),
    content: new TextDecoder("utf-8", { fatal: true }).decode(resolveBundleConfiguration(bundleRoot, reference)),
  }));
  const systemPrompt = configuration.systemPrompt === undefined ? undefined
    : new TextDecoder("utf-8", { fatal: true }).decode(resolveBundleConfiguration(bundleRoot, configuration.systemPrompt));
  return {
    extensions,
    skills: paths(configuration.skills),
    prompts: paths(configuration.prompts),
    contextFiles,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

function assertSelfContainedPiExtension(source: string, reference: ArtifactReference): void {
  const importSyntax = /\bimport\b/u;
  const commonJs = /\brequire\s*\(/u;
  const exportSyntax = /\bexport\b/u;
  const fromSpecifier = /\bfrom\s*["']/u;
  if (importSyntax.test(source) || commonJs.test(source) || exportSyntax.test(source) && fromSpecifier.test(source)) {
    throw piConfigError(reference, "must be self-contained and cannot import or require an unpinned dependency graph");
  }
}

export async function normalizePiCapture(input: NormalizationInput<PiNativeRecord>): Promise<NormalizationResult> {
  const events: UniformEvent[] = [];
  const unmapped: NormalizationResult["unmapped"][number][] = [];
  const retainedSessionId = input.records.flatMap(({ record }) => record.type === "session" ? text(record.id) ?? [] : []).at(0)
    ?? input.records.flatMap(({ record }) => text(record.sessionId) ?? []).at(0);
  for (const captured of input.records) {
    const mapped = mapPiRecord(input, captured, retainedSessionId);
    events.push(...mapped);
    if (mapped.length === 0) unmapped.push({ reference: captured.reference, reason: piUnmappedReason(captured.record) });
  }
  return { events, unmapped };
}

export async function describeAndValidatePiDataset(
  capture: NormalizationInput<PiNativeRecord>,
): Promise<{ dataset: NormalizedDataset; coverage: AdapterCoverageReport; resolver: NativeEvidenceResolver }> {
  const normalization = await normalizePiCapture(capture);
  const resolver = createCapturedNativeEvidenceResolver(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: piCapabilityProfile,
    adapterVersion: PI_ADAPTER_VERSION,
    nativeType: piNativeType,
  });
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { dataset, coverage, resolver };
}

async function readPiNativeArtifacts(bundleRoot: string, runId: string, attemptId: string): Promise<NormalizationInput<PiNativeRecord>> {
  const records: CapturedNativeRecord<PiNativeRecord>[] = [];
  for (const [artifactId, relativePath] of [
    ["pi-session", "pi-session.jsonl"],
    ["pi-events", "pi-events.jsonl"],
    ["pi-observer", "pi-observer.jsonl"],
  ] as const) {
    const path = join(bundleRoot, relativePath);
    if (!await nonempty(path)) continue;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(path, `Pi ${artifactId} evidence`));
    for (const [index, line] of source.split(/\r?\n/u).filter((candidate) => candidate.trim() !== "").entries()) {
      assertNoDuplicateJsonKeys(line);
      const record: unknown = JSON.parse(line);
      assertPiNativeRecord(record, index + 1);
      records.push({ reference: { artifactId, recordLocator: `line:${index + 1}` }, record });
    }
  }
  return { runId, attemptId, qualification: "qualified", records };
}

function mapPiRecord(
  input: NormalizationInput<PiNativeRecord>,
  captured: CapturedNativeRecord<PiNativeRecord>,
  retainedSessionId: string | undefined,
): UniformEvent[] {
  const record = captured.record;
  const nativeType = piNativeType(record);
  const envelope = record.schemaVersion === "ebo.pi-native-record/v1";
  const channel = envelope ? text(record.channel) : undefined;
  const payload = envelope && isRecord(record.payload) ? record.payload : record;
  const sourceId = text(record.sessionId) ?? retainedSessionId ?? text(payload.id) ?? input.attemptId;
  const order = envelope ? number(record.sequence) : lineNumber(captured.reference.recordLocator);
  const payloadMessage = isRecord(payload.message) ? payload.message : isRecord(payload.error) ? payload.error : undefined;
  const timestamp = envelope ? millisTimestamp(payloadMessage?.timestamp) : text(record.timestamp) ?? millisTimestamp(payload.timestamp);
  const common = {
    schemaVersion: "ebo.uniform-event/v1" as const,
    runId: input.runId,
    attemptId: input.attemptId,
    source: { harness: PI_HARNESS, nativeType, nativeReference: structuredClone(captured.reference) },
    nativeOrder: order === undefined
      ? { status: "unknown" as const, reason: "Pi native order is unavailable" }
      : { status: "known" as const, value: order, domain: envelope ? `pi-${channel ?? "adapter"}` : "pi-session" },
    nativeTime: timestamp === undefined
      ? { status: "unknown" as const, reason: envelope ? "Adapter receipt time is not native time" : "Pi history timestamp is unavailable" }
      : { status: "known" as const, value: timestamp },
    relations: { parent: { status: "unknown" as const, reason: "Native parent IDs remain in Pi session history" }, known: [] },
  };
  const event = (suffix: string, family: UniformEvent["family"], phase: UniformEvent["phase"], actor: UniformEvent["actor"],
    scope: UniformEvent["scope"], attributes: Record<string, UniformAttributeValue>, content = true): UniformEvent => ({
      ...common,
      id: `pi-${captured.reference.artifactId}-${String(order ?? 0)}-${suffix}`,
      family,
      phase,
      actor,
      scope,
      attributes: { sessionId: sourceId, ...attributes },
      content: content ? { status: "known", value: [{ nativeReference: structuredClone(captured.reference) }] }
        : { status: "unknown", reason: "No content is associated with this lifecycle record" },
    });

  if (!envelope) {
    if (record.type === "session") return [event("session", "runtime", "instant", { kind: "harness" }, { kind: "session", id: sourceId }, { lifecycle: "session-start" }, false)];
    if (record.type === "message" && isRecord(record.message)) {
      const message = record.message;
      const role = text(message.role);
      const actor = role === "assistant" ? { kind: "model" as const, id: text(message.model) }
        : role === "toolResult" || role === "bashExecution" ? { kind: "tool" as const, id: text(message.toolName) }
          : role === "user" ? { kind: "user" as const }
            : ["custom", "branchSummary", "compactionSummary"].includes(String(role)) ? { kind: "harness" as const }
              : undefined;
      if (actor === undefined) return [];
      const result = [event(`message-${text(record.id) ?? "entry"}`, "message", "after", actor, { kind: "session", id: sourceId }, {
        role: role ?? "unknown", entryId: text(record.id) ?? "unknown",
      })];
      if ((role === "assistant" || role === "toolResult") && isRecord(message.usage)) {
        result.push(event(`usage-${text(record.id) ?? "entry"}`, "runtime", "after", { kind: "harness" }, { kind: "session", id: sourceId }, usageAttributes(message.usage, role), false));
      }
      return result;
    }
    if (record.type === "compaction" || record.type === "branch_summary") {
      const result = [event(`${String(record.type)}-${text(record.id) ?? "entry"}`, "context", "after", { kind: "harness" }, { kind: "session", id: sourceId }, {
        boundary: String(record.type),
        ...(record.type === "compaction" ? { subtype: "compact_boundary" } : {}),
      })];
      if (isRecord(record.usage)) result.push(event(`usage-${text(record.id) ?? "entry"}`, "runtime", "after", { kind: "harness" }, { kind: "session", id: sourceId }, usageAttributes(record.usage, String(record.type)), false));
      return result;
    }
    if (record.type === "model_change" || record.type === "thinking_level_change") {
      return [event(`${String(record.type)}-${text(record.id) ?? "entry"}`, "runtime", "instant", { kind: "harness" }, { kind: "session", id: sourceId }, { change: String(record.type) })];
    }
    return [];
  }

  const kind = text(record.nativeType) ?? "unknown";
  if (channel === "stream") {
    if (["message_start", "message_end"].includes(kind)) {
      const message = isRecord(payload.message) ? payload.message : undefined;
      const role = text(message?.role) ?? "unknown";
      const actor = role === "assistant" ? { kind: "model" as const }
        : role === "toolResult" || role === "bashExecution" ? { kind: "tool" as const }
          : role === "user" ? { kind: "user" as const }
            : role === "custom" ? { kind: "harness" as const }
              : undefined;
      return actor === undefined ? [] : [event(kind, "message", kind.endsWith("start") ? "before" : "after", actor, { kind: "session", id: sourceId }, { role })];
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(kind)) {
      const toolCallId = text(payload.toolCallId);
      const args = payload.args;
      return [event(kind, "tool", kind.endsWith("start") ? "before" : kind.endsWith("end") ? "after" : "during", { kind: "tool", id: text(payload.toolName) },
        { kind: "operation", ...(toolCallId === undefined ? {} : { id: toolCallId }) }, compactAttributes({
          toolCallId, toolName: text(payload.toolName), inputDigest: args === undefined ? undefined : `sha256:${digestMetadata(args).value}`,
          isError: typeof payload.isError === "boolean" ? payload.isError : undefined,
        }))];
    }
    if (["compaction_start", "compaction_end"].includes(kind)) return [event(kind, "context", kind.endsWith("start") ? "before" : "after", { kind: "harness" }, { kind: "session", id: sourceId }, { boundary: "compaction", subtype: "compact_boundary" })];
    if (["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "auto_retry_start", "auto_retry_end"].includes(kind)) {
      const turnIndex = number(payload.turnIndex);
      const scope = kind.startsWith("turn")
        ? { kind: "turn" as const, ...(turnIndex === undefined ? {} : { id: `${sourceId}:turn:${String(turnIndex)}` }) }
        : { kind: "session" as const, id: sourceId };
      return [event(kind, kind.startsWith("auto_retry") ? "context" : "runtime", kind.endsWith("start") ? "before" : "after", { kind: "harness" }, scope,
        compactAttributes({ lifecycle: kind, turnIndex, receiptAt: text(record.receivedAt) }))];
    }
    return [];
  }
  if (channel === "observer") {
    if (kind === "before_provider_request") return [event(kind, "model-request", "before", { kind: "harness" }, { kind: "operation", id: `provider-${String(order ?? 0)}` }, { requestId: `provider-${String(order ?? 0)}`, observationStage: text(record.stage) ?? "pre-provider-request" })];
    if (["context", "before_agent_start"].includes(kind)) return [event(kind, "context", "before", { kind: "harness" }, { kind: "session", id: sourceId }, { observationStage: text(record.stage) ?? kind })];
    if (["session_before_compact", "session_compact", "session_compact_failed"].includes(kind)) {
      return [event(kind, "context", kind === "session_before_compact" ? "before" : "after", { kind: "harness" }, { kind: "session", id: sourceId }, {
        observationStage: text(record.stage) ?? kind,
        subtype: "compact_boundary",
      })];
    }
    if (["session_start", "session_shutdown", "before_provider_headers", "after_provider_response"].includes(kind)) return [event(kind, "runtime", kind.endsWith("start") || kind.startsWith("before") ? "before" : "after", { kind: "harness" }, { kind: "session", id: sourceId }, { observationStage: text(record.stage) ?? kind })];
    return [];
  }
  if (channel === "adapter") return [event(kind, kind === "capture_error" ? "outcome" : "runtime", "instant", { kind: "harness" }, { kind: "session", id: sourceId }, { lifecycle: kind })];
  return [];
}

export function piNativeType(record: PiNativeRecord): string {
  if (record.schemaVersion === "ebo.pi-native-record/v1") return `${String(record.channel)}:${String(record.nativeType)}`;
  if (record.type === "session") return "session";
  return `history:${String(record.type)}`;
}

export function assertPiNativeRecord(record: unknown, line: number): asserts record is PiNativeRecord {
  if (!isRecord(record) || !Number.isSafeInteger(line) || line < 1) throw new Error(`Invalid retained Pi native record at line ${line}.`);
  if (record.schemaVersion === "ebo.pi-native-record/v1") {
    if (!Number.isSafeInteger(record.sequence) || record.sequence !== line
        || !["stream", "observer", "adapter"].includes(String(record.channel))
        || text(record.nativeType) === undefined || text(record.receivedAt) === undefined || record.payload === undefined) {
      throw new Error(`Invalid retained Pi native envelope at line ${line}.`);
    }
    return;
  }
  if (text(record.type) === undefined || (record.type === "session"
    ? line !== 1 || record.version !== 3 || text(record.id) === undefined || text(record.cwd) === undefined
    : line === 1 || text(record.id) === undefined || !(record.parentId === null || text(record.parentId) !== undefined) || text(record.timestamp) === undefined)) {
    throw new Error(`Invalid retained Pi session entry at line ${line}.`);
  }
}

export function qualifyRetainedPiCapture(
  capture: NormalizationInput<PiNativeRecord>,
  sessionId: string | undefined,
  expectsCompletion: boolean,
): NormalizationInput<PiNativeRecord> {
  for (const { reference, record } of capture.records) assertPiNativeRecord(record, lineNumber(reference.recordLocator) ?? 0);
  const history = capture.records.filter(({ reference }) => reference.artifactId === "pi-session").map(({ record }) => record);
  const headers = history.filter(({ type }) => type === "session");
  if (sessionId === undefined || headers.length !== 1 || headers[0]!.id !== sessionId) {
    throw new Error("Retained Pi session identity differs from the run manifest.");
  }
  const entryIds = new Set<string>();
  for (const record of history.filter(({ type }) => type !== "session")) {
    const id = text(record.id)!;
    if (entryIds.has(id) || record.parentId !== null && !entryIds.has(String(record.parentId))) {
      throw new Error("Retained Pi session history has duplicate or unresolved parent identities.");
    }
    entryIds.add(id);
  }
  const envelopeSessionIds = capture.records.flatMap(({ record }) => {
    const ids = [text(record.sessionId)];
    if (record.channel === "observer" && isRecord(record.payload)) ids.push(text(record.payload.sessionId));
    return ids.filter((id): id is string => id !== undefined);
  });
  if (envelopeSessionIds.some((id) => id !== sessionId)) throw new Error("Retained Pi stream identity differs from the native session.");
  if (capture.records.some(({ record }) => record.channel === "observer" && record.nativeType === "extension_error")) {
    throw new Error("Retained Pi capture contains a selected extension hook failure.");
  }
  if (expectsCompletion) {
    const settled = capture.records.some(({ record }) => record.channel === "stream" && record.nativeType === "agent_settled");
    const lastAssistant = history.filter(({ type, message }) => type === "message" && isRecord(message) && message.role === "assistant").at(-1)?.message;
    if (!settled || !isRecord(lastAssistant) || !["stop", "length"].includes(String(lastAssistant.stopReason))) {
      throw new Error("Completed retained Pi capture lacks matching native settled terminal evidence.");
    }
    const historyCalls = new Set(history.flatMap(({ type, message }) => {
      if (type !== "message" || !isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
      return message.content.flatMap((block) => isRecord(block) && block.type === "toolCall" ? text(block.id) ?? [] : []);
    }));
    const historyResults = new Set(history.flatMap(({ type, message }) =>
      type === "message" && isRecord(message) && message.role === "toolResult" ? text(message.toolCallId) ?? [] : []));
    const streamIds = (nativeType: string): Set<string> => new Set(capture.records.flatMap(({ record }) =>
      record.channel === "stream" && record.nativeType === nativeType && isRecord(record.payload)
        ? text(record.payload.toolCallId) ?? [] : []));
    if (!sameTextSet(historyCalls, historyResults)
        || !sameTextSet(historyCalls, streamIds("tool_execution_start"))
        || !sameTextSet(historyCalls, streamIds("tool_execution_end"))) {
      throw new Error("Completed retained Pi capture has mismatched native history and streamed tool identities.");
    }
  }
  return capture;
}

function piUnmappedReason(record: PiNativeRecord): string {
  const type = piNativeType(record);
  if (type === "stream:message_update") return "Transient message delta retained natively; final history/message records own counted semantics";
  if (type === "stream:entry_appended") return "Persistence notification overlaps authoritative native session history";
  if (type === "observer:tool_call" || type === "observer:tool_result") return "Passive observer duplicate; subscription tool lifecycle owns normalized operation semantics";
  return `Pi native type ${type} is retained but has no uniform projection`;
}

export type RunPiQueueEntryOptions = {
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot?: string;
  attemptId?: string;
  signal?: AbortSignal;
  createSession?: PiSessionFactory;
};

export type PiRunSummary = {
  runId: string;
  attemptId: string;
  bundlePath: string;
  terminal: TerminalRecord;
  classification: RunAttemptResult["classification"]["kind"];
  captureQualification: CaptureQualificationStatus;
  assessmentMode: TaskPacket["assessmentMode"];
  sessionId?: string;
  retainedWorkspacePath?: string;
};

/** Execute exactly one frozen queue entry through the pinned direct Pi SDK integration. */
export async function runPiQueueEntry(options: RunPiQueueEntryOptions): Promise<PiRunSummary> {
  const bundleRoot = resolve(options.bundleRoot);
  const queue = readRunQueue(options.queuePath, undefined, { bundleRoot });
  const matches = queue.entries.filter((entry) => entry.runId === options.runId);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `Run "${options.runId}" is not in the queue.` : `Run "${options.runId}" matches more than one queue entry.`);
  const entry = matches[0]!;
  if (entry.harness.id !== PI_HARNESS) throw new Error(`Queue harness must be ${PI_HARNESS}.`);
  const model = resolvePiConfigurationRecord(bundleRoot, entry.configuration.model, "model");
  const harness = resolvePiConfigurationRecord(bundleRoot, entry.configuration.harness, "harness");
  const limits = resolvePiConfigurationRecord(bundleRoot, entry.configuration.nativeLimits, "native-limits");
  const toolPolicy = resolvePiConfigurationRecord(bundleRoot, entry.configuration.nativeToolPolicy, "native-tool-policy");
  const captureProfile = resolvePiConfigurationRecord(bundleRoot, queue.captureProfile, "capture-profile");
  if (toolPolicy.environmentAllowlist.includes(model.apiKeyEnv)) throw new Error("Pi tool environment allowlist must not expose the provider credential variable.");
  if (model.queueModelId !== entry.model.id) throw new Error(`Pi model condition "${model.queueModelId}" does not match queue model "${entry.model.id}".`);
  resolvePiResources(bundleRoot, harness);

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
  if (fromOutput === "" || isAbsolute(fromOutput) || fromOutput === ".." || fromOutput.startsWith(`..${sep}`)) throw new Error("Attempt destination escapes selected output root.");
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
    baselineRoot = await mkdtemp(join(tmpdir(), "ebo-pi-baseline-"));
    const startingWorkspacePath = join(baselineRoot, "workspace");
    await cp(workspace.path, startingWorkspacePath, { recursive: true, preserveTimestamps: true, force: false });
    const verifierReference = packet.assessmentMode === "verified" ? packet.restricted.verifier : undefined;
    const verifierFormat = verifierReference?.locator.toLowerCase().endsWith(".mjs") ? "module" : "commonjs";
    const definition = buildPiDefinition(queue.captureProfile, entry, packet, destination, attemptId, model, harness, verifierFormat);
    const result = await capturePiSdkRun({
      definition,
      configurationRoot: bundleRoot,
      startingWorkspacePath,
      workspace: {
        setup: () => {
          captureStarted = true;
          return { status: "ready", path: workspace.path, artifactId: "workspace", retained: true };
        },
        cleanup: () => cleanupWorkspace(workspace),
      },
      model,
      harness,
      limits,
      toolPolicy,
      captureProfile,
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.createSession === undefined ? {} : { createSession: options.createSession }),
      ...(captureProfile.workspaceOutcome === undefined ? {} : {
        workspaceOutcomeExcludedDirectoryNames: captureProfile.workspaceOutcome.excludeDirectoryNames,
        ...(captureProfile.workspaceOutcome.respectGitignore === undefined ? {} : { workspaceOutcomeRespectsGitignore: captureProfile.workspaceOutcome.respectGitignore }),
        ...(captureProfile.workspaceOutcome.omitEmptyDirectories === undefined ? {} : { workspaceOutcomeOmitsEmptyDirectories: captureProfile.workspaceOutcome.omitEmptyDirectories }),
      }),
    });
    const manifest = reopenManifest(destination);
    return {
      runId: entry.runId,
      attemptId,
      bundlePath: destination,
      terminal: structuredClone(manifest.terminal),
      classification: result.attempt.classification.kind,
      captureQualification: result.qualification.status,
      assessmentMode: packet.assessmentMode,
      ...(manifest.run.native?.sessionId === undefined ? {} : { sessionId: manifest.run.native.sessionId }),
      ...(workspace.state === "ready" ? { retainedWorkspacePath: workspace.path } : {}),
    };
  } finally {
    if (baselineRoot !== undefined) await rm(baselineRoot, { recursive: true, force: true });
    if (!captureStarted && workspace.state === "ready") await cleanupWorkspace(workspace).catch(() => undefined);
  }
}

type PiConfigurationByKind = {
  model: PiModelConfiguration;
  harness: PiHarnessConfiguration;
  "native-limits": PiNativeLimitsConfiguration;
  "native-tool-policy": PiNativeToolPolicyConfiguration;
  "capture-profile": PiCaptureProfileConfiguration;
};

export function resolvePiConfigurationRecord<Kind extends PiConfigurationKind>(
  bundleRoot: string,
  reference: ArtifactReference,
  kind: Kind,
): PiConfigurationByKind[Kind] {
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(resolveBundleConfiguration(bundleRoot, reference));
  assertNoDuplicateJsonKeys(textValue);
  const value: unknown = JSON.parse(textValue);
  if (!isRecord(value) || value.schemaVersion !== PI_CONFIG_SCHEMA_VERSION || value.kind !== kind) throw piConfigError(reference, `must declare ${PI_CONFIG_SCHEMA_VERSION} kind ${kind}`);
  validatePiConfiguration(value, kind, reference);
  return value as PiConfigurationByKind[Kind];
}

function validatePiConfiguration(record: Record<string, unknown>, kind: PiConfigurationKind, reference: ArtifactReference): void {
  if (kind === "model") {
    keys(record, ["schemaVersion", "kind", "provider", "queueModelId", "model", "api", "baseUrl", "apiKeyEnv", "thinkingLevel", "thinkingLevelMap", "reasoning", "input", "contextWindow", "maxTokens", "cost"],
      ["provider", "queueModelId", "model", "api", "baseUrl", "apiKeyEnv", "thinkingLevel", "reasoning", "input", "contextWindow", "maxTokens", "cost"], reference);
    requiredText(record.provider, "provider", reference); requiredText(record.model, "model", reference);
    if (typeof record.queueModelId !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(record.queueModelId)) throw piConfigError(reference, "queueModelId is invalid");
    if (!(PI_APIS as readonly unknown[]).includes(record.api)) throw piConfigError(reference, "api is unsupported");
    assertHttpUrl(record.baseUrl, reference);
    if (typeof record.apiKeyEnv !== "string" || !ENVIRONMENT_NAME_PATTERN.test(record.apiKeyEnv)) throw piConfigError(reference, "apiKeyEnv is invalid");
    if (!(PI_THINKING_LEVELS as readonly unknown[]).includes(record.thinkingLevel)) throw piConfigError(reference, "thinkingLevel is invalid");
    if (record.thinkingLevelMap !== undefined) {
      if (!isRecord(record.thinkingLevelMap) || Object.keys(record.thinkingLevelMap).some((level) => !(PI_THINKING_LEVELS as readonly string[]).includes(level))
          || Object.values(record.thinkingLevelMap).some((value) => value !== null && (typeof value !== "string" || value.trim() === ""))) {
        throw piConfigError(reference, "thinkingLevelMap must map supported levels to nonempty provider values or null");
      }
    }
    if (["xhigh", "max"].includes(String(record.thinkingLevel))
        && (!isRecord(record.thinkingLevelMap) || typeof record.thinkingLevelMap[String(record.thinkingLevel)] !== "string")) {
      throw piConfigError(reference, "xhigh and max require an explicit non-null thinkingLevelMap entry");
    }
    if (typeof record.reasoning !== "boolean") throw piConfigError(reference, "reasoning must be boolean");
    if (record.reasoning === false && record.thinkingLevel !== "off") throw piConfigError(reference, "non-reasoning models require thinkingLevel off");
    if (!Array.isArray(record.input) || record.input.length === 0 || record.input.some((item) => item !== "text" && item !== "image") || new Set(record.input).size !== record.input.length) throw piConfigError(reference, "input must be a unique text/image list");
    positive(record.contextWindow, "contextWindow", reference); positive(record.maxTokens, "maxTokens", reference);
    if (!isRecord(record.cost)) throw piConfigError(reference, "cost must be an object");
    keys(record.cost, ["input", "output", "cacheRead", "cacheWrite"], ["input", "output", "cacheRead", "cacheWrite"], reference);
    for (const [name, value] of Object.entries(record.cost)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw piConfigError(reference, `cost.${name} must be nonnegative`);
  } else if (kind === "harness") {
    keys(record, ["schemaVersion", "kind", "adapter", "version", "extensions", "skills", "prompts", "contextFiles", "systemPrompt"], ["adapter", "version"], reference);
    if (record.adapter !== PI_HARNESS || record.version !== PINNED_PI_SDK_VERSION) throw piConfigError(reference, "adapter or version is not pinned");
    for (const field of ["extensions", "skills", "prompts", "contextFiles"] as const) if (record[field] !== undefined) assertReferences(record[field], field, reference);
    if (record.systemPrompt !== undefined) assertReference(record.systemPrompt, "systemPrompt", reference);
  } else if (kind === "native-limits") {
    keys(record, ["schemaVersion", "kind", "shutdownGraceMs", "maxRetries", "retryBaseDelayMs", "providerTimeoutMs"], [], reference);
    for (const field of ["shutdownGraceMs", "retryBaseDelayMs", "providerTimeoutMs"] as const) if (record[field] !== undefined) positive(record[field], field, reference);
    if (record.maxRetries !== undefined && (!Number.isSafeInteger(record.maxRetries) || (record.maxRetries as number) < 0)) throw piConfigError(reference, "maxRetries must be a nonnegative safe integer");
  } else if (kind === "native-tool-policy") {
    keys(record, ["schemaVersion", "kind", "tools", "excludeTools", "environmentAllowlist"], ["tools", "environmentAllowlist"], reference);
    assertStringList(record.tools, "tools", reference, PI_TOOLS);
    if (record.excludeTools !== undefined) assertStringList(record.excludeTools, "excludeTools", reference, PI_TOOLS);
    assertStringList(record.environmentAllowlist, "environmentAllowlist", reference);
    if ((record.environmentAllowlist as string[]).some((name) => !ENVIRONMENT_NAME_PATTERN.test(name))) throw piConfigError(reference, "environmentAllowlist contains an invalid variable name");
  } else {
    keys(record, ["schemaVersion", "kind", "passiveObserver", "includeProviderPayloads", "workspaceOutcome"], [], reference);
    if (record.passiveObserver !== undefined && typeof record.passiveObserver !== "boolean") throw piConfigError(reference, "passiveObserver must be boolean");
    if (record.includeProviderPayloads !== undefined && typeof record.includeProviderPayloads !== "boolean") throw piConfigError(reference, "includeProviderPayloads must be boolean");
    if (record.workspaceOutcome !== undefined) validateWorkspaceOutcome(record.workspaceOutcome, reference);
  }
}

function buildPiDefinition(
  captureProfile: ArtifactReference,
  entry: RunQueueEntry,
  packet: TaskPacket,
  bundleRoot: string,
  attemptId: string,
  model: PiModelConfiguration,
  harness: PiHarnessConfiguration,
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
      harness: { id: PI_HARNESS, version: harness.version, configurationDigest: `sha256:${entry.configuration.harness.digest.value}` },
      runtime: [
        { source: "earendil-works", name: "pi-coding-agent", version: PINNED_PI_SDK_VERSION },
        { source: "EBO", name: PI_HARNESS, version: PINNED_PI_SDK_VERSION },
        { source: "EBO", name: "pi-sdk-adapter", version: PI_ADAPTER_VERSION },
      ],
      ...(packet.assessmentMode === "verified" ? { verifier: { locator: packet.restricted.verifier.locator, digest: `sha256:${packet.restricted.verifier.digest.value}`, format: verifierFormat } } : {}),
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
      harness: { ...structuredClone(definition.run.harness), id: PI_HARNESS, version: PINNED_PI_SDK_VERSION },
      runtime: definition.run.runtime.filter(({ name }) => !["pi-coding-agent", PI_HARNESS, "pi-sdk-adapter"].includes(name)).concat([
        { source: "earendil-works", name: "pi-coding-agent", version: PINNED_PI_SDK_VERSION },
        { source: "EBO", name: PI_HARNESS, version: PINNED_PI_SDK_VERSION },
        { source: "EBO", name: "pi-sdk-adapter", version: PI_ADAPTER_VERSION },
      ]),
    },
  };
}

function piEvidence(sessionId: string | undefined, session: PiSession | undefined): Record<string, unknown> {
  return {
    sdkVersion: PINNED_PI_SDK_VERSION,
    adapterVersion: PI_ADAPTER_VERSION,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(session === undefined ? {} : { activeTools: session.getActiveToolNames() }),
  };
}

function piComposition(options: CapturePiSdkRunOptions, activeTools: string[]): Record<string, unknown> {
  return {
    schemaVersion: "ebo.pi-composition/v1",
    sdk: { package: "@earendil-works/pi-coding-agent", version: PINNED_PI_SDK_VERSION },
    adapter: { id: `${PI_HARNESS}/v1`, version: PI_ADAPTER_VERSION },
    configurationDigest: options.definition.configuration.digest,
    model: {
      provider: options.model.provider,
      queueModelId: options.model.queueModelId,
      model: options.model.model,
      api: options.model.api,
      baseUrl: options.model.baseUrl,
      credentialEnvironment: options.model.apiKeyEnv,
      thinkingLevel: options.model.thinkingLevel,
      ...(options.model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...options.model.thinkingLevelMap } }),
      reasoning: options.model.reasoning,
    },
    requestEnvironment: {
      piCacheRetention: process.env.PI_CACHE_RETENTION === "long" ? "long" : "short",
    },
    tools: {
      active: [...activeTools],
      excluded: [...(options.toolPolicy.excludeTools ?? [])],
      environmentAllowlist: [...options.toolPolicy.environmentAllowlist],
    },
    resources: {
      extensions: structuredClone(options.harness.extensions ?? []),
      skills: structuredClone(options.harness.skills ?? []),
      prompts: structuredClone(options.harness.prompts ?? []),
      contextFiles: structuredClone(options.harness.contextFiles ?? []),
      ...(options.harness.systemPrompt === undefined ? {} : { systemPrompt: structuredClone(options.harness.systemPrompt) }),
    },
    capture: {
      passiveObserver: options.captureProfile.passiveObserver !== false,
      includeProviderPayloads: options.captureProfile.includeProviderPayloads === true,
    },
  };
}

function reopenManifest(bundleRoot: string): RunManifest {
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest"));
  assertNoDuplicateJsonKeys(textValue);
  const value: unknown = JSON.parse(textValue);
  const errors = [...validateArtifact("manifest.json", value), ...validateRunManifestEvidence("manifest.json", value, bundleRoot)];
  if (errors.length > 0) throw new Error(`Retained run manifest failed validation:\n${formatErrors(errors)}`);
  return value as RunManifest;
}

function validateWorkspaceOutcome(value: unknown, reference: ArtifactReference): void {
  if (!isRecord(value)) throw piConfigError(reference, "workspaceOutcome must be an object");
  keys(value, ["excludeDirectoryNames", "respectGitignore", "omitEmptyDirectories"], ["excludeDirectoryNames"], reference);
  assertStringList(value.excludeDirectoryNames, "excludeDirectoryNames", reference);
  if ((value.excludeDirectoryNames as string[]).some((name) => name.includes("/") || !isSafeArtifactRelativePath(name))) throw piConfigError(reference, "workspace exclusions must be safe path segments");
  for (const field of ["respectGitignore", "omitEmptyDirectories"] as const) if (value[field] !== undefined && typeof value[field] !== "boolean") throw piConfigError(reference, `${field} must be boolean`);
}

function assertReferences(value: unknown, field: string, reference: ArtifactReference): void {
  if (!Array.isArray(value) || new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) throw piConfigError(reference, `${field} must be a unique reference list`);
  for (const entry of value) assertReference(entry, field, reference);
}

function assertReference(value: unknown, field: string, reference: ArtifactReference): void {
  if (!isRecord(value) || Object.keys(value).some((key) => !["locator", "digest"].includes(key)) || text(value.locator) === undefined
      || !isSafeArtifactRelativePath(String(value.locator)) || !isRecord(value.digest) || value.digest.algorithm !== "sha256"
      || typeof value.digest.value !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest.value)) throw piConfigError(reference, `${field} contains an invalid artifact reference`);
}

function keys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], reference: ArtifactReference): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) throw piConfigError(reference, `contains unknown field "${unexpected}"`);
  const missing = required.find((key) => record[key] === undefined);
  if (missing !== undefined) throw piConfigError(reference, `is missing "${missing}"`);
}

function assertStringList(value: unknown, field: string, reference: ArtifactReference, allowed?: readonly string[]): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "") || new Set(value).size !== value.length
      || allowed !== undefined && value.some((item) => !allowed.includes(item as never))) throw piConfigError(reference, `${field} must be a unique supported string list`);
}

function assertHttpUrl(value: unknown, reference: ArtifactReference): void {
  requiredText(value, "baseUrl", reference);
  let url: URL;
  try { url = new URL(value as string); } catch { throw piConfigError(reference, "baseUrl must be an absolute URL"); }
  if (!/^https?:$/u.test(url.protocol) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw piConfigError(reference, "baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
}

function requiredText(value: unknown, field: string, reference: ArtifactReference): void {
  if (typeof value !== "string" || value.trim() === "") throw piConfigError(reference, `${field} must be nonempty`);
}

function positive(value: unknown, field: string, reference: ArtifactReference): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw piConfigError(reference, `${field} must be a positive safe integer`);
}

function piConfigError(reference: ArtifactReference, detail: string): Error {
  return new Error(`Pi configuration "${reference.locator}" ${detail}.`);
}

function compactAttributes(input: Record<string, UniformAttributeValue | undefined>): Record<string, UniformAttributeValue> {
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, UniformAttributeValue] => entry[1] !== undefined));
}

function sameTextSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function usageAttributes(usage: Record<string, unknown>, usageScope: string): Record<string, UniformAttributeValue> {
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  return compactAttributes({
    inputTokens: number(usage.input),
    outputTokens: number(usage.output),
    cacheReadInputTokens: number(usage.cacheRead),
    cacheCreationInputTokens: number(usage.cacheWrite),
    reasoningOutputTokens: number(usage.reasoning),
    totalTokens: number(usage.totalTokens),
    totalCostUsd: number(cost?.total),
    resourceSemantics: "increment",
    usageScope,
  });
}

function jsonSnapshot<Value>(value: Value): Value {
  try { return JSON.parse(JSON.stringify(value)) as Value; } catch { throw new Error("Pi callback value is not JSON-safe."); }
}

function compactPiStreamEvent(event: AgentSessionEvent): unknown {
  if (event.type !== "message_update") return event;
  const update = event.assistantMessageEvent as unknown as Record<string, unknown>;
  const { partial: _partial, ...increment } = update;
  if (update.type === "toolcall_start" && Number.isSafeInteger(update.contentIndex) && isRecord(update.partial)
      && Array.isArray(update.partial.content)) {
    const toolCall = update.partial.content[Number(update.contentIndex)];
    if (isRecord(toolCall) && toolCall.type === "toolCall") {
      increment.id = toolCall.id;
      increment.toolName = toolCall.name;
    }
  }
  const message = event.message as unknown as Record<string, unknown>;
  return { type: event.type, ...(isRecord(message.usage) ? { usage: message.usage } : {}), assistantMessageEvent: increment };
}

function valueShape(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (isRecord(value)) return { type: "object", keys: Object.keys(value).sort() };
  return { type: typeof value };
}

function lineNumber(locator: string): number | undefined {
  const match = locator.match(/^line:(\d+)$/u);
  return match === null ? undefined : Number(match[1]);
}

function millisTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const timestamp = new Date(value).toISOString();
  return Number.isNaN(Date.parse(timestamp)) ? undefined : timestamp;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function nonempty(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
