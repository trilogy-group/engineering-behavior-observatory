import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import {
  Agent,
  JSONL_LOCAL_AGENT_STORE_FILES,
  JsonlLocalAgentStore,
  type AgentOptions,
  type AgentUsage,
  type ConversationStep,
  type InteractionUpdate,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKMessage,
} from "@cursor/sdk";

import { assertNoDuplicateJsonKeys, digestMetadata } from "./artifacts.js";
import {
  createAttemptIdentity,
  createRunIdentity,
  executeRunAttempt,
  type HarnessExecutionResult,
  type RunAttemptResult,
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
import {
  createAgentSdkNativeEvidenceResolver,
  readQualifiedRunCapture,
  type AgentSdkNativeRecord,
} from "./agent-sdk-normalizer.js";
import {
  createRunBundleAssembler,
  qualifyRunBundle,
  type CaptureMissingEvidence,
  type CaptureQualificationReport,
  type CapturedWorkspaceOutcome,
  type RunBundleDefinition,
  type RunManifest,
} from "./run-bundles.js";
import {
  type AdapterCapabilityProfile,
  type ContentReference,
  type NativeEvidenceReference,
  type NativeEvidenceResolver,
  type NormalizationInput,
  type NormalizationResult,
  type UniformAttributeValue,
  type UniformEvent,
} from "./uniform-events.js";
import type { VerifierResult } from "./verifiers.js";
import { readBoundedFile } from "./scheduler.js";

export const CURSOR_SDK_VERSION = "1.0.31";
export const CURSOR_SDK_HARNESS = "cursor-sdk";
export const CURSOR_SDK_ADAPTER_ID = "ebo-cursor-sdk-v1";
export const CURSOR_SDK_ADAPTER_VERSION = "0.1.0";
export const CURSOR_SDK_DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

const CURSOR_NATIVE_SCHEMA_VERSION = "ebo.cursor-native-record/v1";
const MAX_NATIVE_RECORD_BYTES = 16 * 1024 * 1024;
const STREAM_TYPES = ["assistant", "request", "status", "system", "task", "thinking", "tool_call", "usage", "user"] as const;
const NATIVE_TYPES = [
  "configuration", "agent-created", "run-created", "delta", "step", "terminal", "history", "billing", "error", "cleanup",
  ...STREAM_TYPES.map((type) => `stream:${type}`),
  "stream:unknown", "store:agent", "store:run", "store:run-event", "store:checkpoint", "store:unknown",
] as const;
const CURSOR_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY", "CURSOR_API_KEY", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "LOGNAME", "NODE_EXTRA_CA_CERTS",
  "NO_PROXY", "PATH", "SHELL", "SSL_CERT_DIR", "SSL_CERT_FILE", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "USER",
]);
let cursorEnvironmentActive = false;

export type CursorSdkToolPolicy = {
  tools: readonly string[];
  disallowedTools?: readonly string[];
  sandbox: { enabled: boolean };
  settingSources: readonly [];
  autoReview: false;
  enableAgentRetries: false;
};

export type CursorSdkCaptureConfiguration = {
  model: ModelSelection;
  toolPolicy: CursorSdkToolPolicy;
  maxNativeRecordBytes?: number;
};

export type CursorSdkAgentFactory = (options: AgentOptions) => Promise<SDKAgent>;

export type CaptureCursorSdkVerifier = (
  context: VerifierExecutionContext,
  workspace: CapturedWorkspaceOutcome,
  workspacePath: string,
) => VerifierResult | Promise<VerifierResult>;

export type CaptureCursorSdkRunOptions = {
  definition: RunBundleDefinition;
  startingWorkspacePath: string;
  workspace: WorkspaceCoordinator;
  configuration: CursorSdkCaptureConfiguration;
  apiKey: string;
  prompt: string;
  verifier?: CaptureCursorSdkVerifier;
  workspaceOutcomeExcludedDirectoryNames?: readonly string[];
  workspaceOutcomeRespectsGitignore?: boolean;
  workspaceOutcomeOmitsEmptyDirectories?: boolean;
  signal?: AbortSignal;
  maxWallClockMs?: number;
  shutdownGraceMs?: number;
  agentFactory?: CursorSdkAgentFactory;
  now?: () => string;
};

export type CaptureCursorSdkRunResult = {
  attempt: RunAttemptResult;
  manifest: RunManifest;
  qualification: CaptureQualificationReport;
  capture: CursorSdkCaptureReport;
};

export type CursorSdkCaptureReport = {
  sdkVersion: typeof CURSOR_SDK_VERSION;
  agentId?: string;
  runId?: string;
  terminal?: RunResult;
  streamRecords: number;
  deltaRecords: number;
  stepRecords: number;
  historyStatus: "captured" | "failed" | "not-started";
  billingStatus: "captured" | "unavailable" | "not-started";
  storeFiles: readonly string[];
  errors: readonly string[];
};

export type CursorNativeRecord = Record<string, unknown>;

export type CursorSdkBehaviorEvidence = {
  capture: NormalizationInput<CursorNativeRecord>;
  outcomeCapture: NormalizationInput<AgentSdkNativeRecord>;
  dataset: NormalizedDataset;
  resolver: NativeEvidenceResolver;
  coverage: AdapterCoverageReport;
};

export const CURSOR_SDK_CAPABILITIES: AdapterCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: CURSOR_SDK_ADAPTER_ID,
  harness: CURSOR_SDK_HARNESS,
  nativeTypes: NATIVE_TYPES,
  families: {
    message: { status: "available", detail: "SDK stream user and assistant messages are authoritative for message projection." },
    "model-request": { status: "unsupported", detail: "The SDK does not expose source-native inference request boundaries." },
    tool: { status: "available", detail: "SDK stream tool_call records are authoritative; detailed callbacks and store history remain overlap evidence." },
    context: { status: "partial", detail: "Detailed summary and nested-task callback records remain native and are not semantically reconstructed." },
    permission: { status: "unsupported", detail: "The public SDK does not expose individual local approval decisions." },
    delegation: { status: "partial", detail: "Task tool records are retained as tool operations without inventing subagent lifecycle boundaries." },
    artifact: { status: "unsupported", detail: "Tool names express intent, not verified mutations; retained workspace outcome remains authoritative." },
    validation: { status: "unsupported", detail: "No validation is inferred from shell command text." },
    runtime: { status: "available", detail: "Per-turn stream usage is projected as increments; cumulative run and billing readbacks remain separate." },
    outcome: { status: "available", detail: "run.wait() is authoritative; stream EOF is never treated as completion." },
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "Serialized callback/stream receipt order is retained and labeled as adapter receipt order." },
    nativeTime: { status: "partial", detail: "Adapter receipt timestamps are retained separately; absent source timestamps remain unknown." },
    parentage: { status: "partial", detail: "Stable agent, run, and tool-call identities are retained where exposed." },
    content: { status: "partial", detail: "Content stays in restricted native records and normalized events carry references only." },
  },
};

/** Execute one SDK-owned local attempt and retain all source channels before projection. */
export async function captureCursorSdkRun(options: CaptureCursorSdkRunOptions): Promise<CaptureCursorSdkRunResult> {
  requireText(options.apiKey, "Cursor API key");
  requireText(options.prompt, "Cursor prompt");
  if (options.definition.run.model.id !== options.configuration.model.id) {
    throw new Error("The declared model must match the Cursor SDK model configuration.");
  }
  if (options.definition.run.harness.id !== CURSOR_SDK_HARNESS) {
    throw new Error(`Cursor capture requires harness ${CURSOR_SDK_HARNESS}.`);
  }
  if (options.definition.run.harness.version !== CURSOR_SDK_VERSION) {
    throw new Error(`Cursor capture requires pinned SDK ${CURSOR_SDK_VERSION}.`);
  }

  const assembler = await createRunBundleAssembler(options.definition);
  const writer = await CursorNativeWriter.open(
    join(assembler.bundleRoot, "native", "session.jsonl"),
    options.configuration.maxNativeRecordBytes ?? MAX_NATIVE_RECORD_BYTES,
    options.now,
  );
  const storeRoot = join(assembler.bundleRoot, "native", "store");
  const store = new JsonlLocalAgentStore(storeRoot);
  let workspace: WorkspaceExecutionResult | undefined;
  let workspaceOutcome: CapturedWorkspaceOutcome | undefined;
  let workspacePromise: Promise<CapturedWorkspaceOutcome> | undefined;
  let workspaceCaptureError: string | undefined;
  let verifierResult: VerifierResult | undefined;
  let verifierError: unknown;
  let agentId: string | undefined;
  let nativeRunId: string | undefined;
  let terminalResult: RunResult | undefined;
  let streamRecords = 0;
  let deltaRecords = 0;
  let stepRecords = 0;
  let historyStatus: CursorSdkCaptureReport["historyStatus"] = "not-started";
  let billingStatus: CursorSdkCaptureReport["billingStatus"] = "not-started";
  const errors: string[] = [];

  const captureWorkspace = async (context?: VerifierExecutionContext): Promise<CapturedWorkspaceOutcome> => {
    if (workspaceOutcome !== undefined) return workspaceOutcome;
    workspacePromise ??= (async () => {
      if (workspace?.status !== "ready" || workspace.path === undefined || workspace.artifactId === undefined) {
        throw new Error("Cursor SDK capture requires a retained ready workspace before outcome packaging.");
      }
      workspaceOutcome = await assembler.captureWorkspaceOutcome({
        startPath: options.startingWorkspacePath,
        finalPath: workspace.path,
        id: workspace.artifactId,
        ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : { excludeDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames }),
        ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : { respectGitignore: options.workspaceOutcomeRespectsGitignore }),
        ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : { omitEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories }),
      }, context === undefined || options.verifier === undefined ? undefined : async (projectedPath, outcome) => {
        try {
          verifierResult = await options.verifier!(context, outcome, projectedPath);
        } catch (error) {
          verifierError = error;
        }
      });
      return workspaceOutcome;
    })().catch((error: unknown) => {
      workspaceCaptureError = errorMessage(error);
      throw error;
    });
    return workspacePromise;
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

  let attempt: RunAttemptResult;
  try {
    attempt = await executeRunAttempt({
      run,
      assessmentMode: options.definition.run.assessmentMode,
      attempt: attemptIdentity,
      workspace: coordinatedWorkspace,
      harness: async (context) => {
        if (context.workspace?.path === undefined) throw new Error("Cursor SDK attempt has no materialized workspace.");
        const result = await executeCursorSdk({
          workspacePath: context.workspace.path,
          prompt: options.prompt,
          apiKey: options.apiKey,
          configuration: options.configuration,
          store,
          writer,
          signal: context.signal,
          registerShutdown: context.registerShutdown,
          agentFactory: options.agentFactory ?? ((agentOptions) => Agent.create(agentOptions)),
          setAgentId: (value) => { agentId = value; },
          setRunId: (value) => { nativeRunId = value; },
          setTerminal: (value) => { terminalResult = value; },
          onStream: () => { streamRecords += 1; },
          onDelta: () => { deltaRecords += 1; },
          onStep: () => { stepRecords += 1; },
          setHistoryStatus: (value) => { historyStatus = value; },
          setBillingStatus: (value) => { billingStatus = value; },
          errors,
          shutdownGraceMs: options.shutdownGraceMs ?? CURSOR_SDK_DEFAULT_SHUTDOWN_GRACE_MS,
        });
        return result;
      },
      ...(options.verifier === undefined ? {} : {
        verifier: async (context) => {
          await captureWorkspace(context);
          if (verifierError !== undefined) throw verifierError;
          if (verifierResult === undefined) throw new Error("Cursor verifier did not return a result.");
          await assembler.writeJsonArtifact({
            id: "verifier", source: "ebo-verifier", kind: "verifier", mediaType: "application/json",
            sharingClass: "restricted", relativePath: "verifier.json",
          }, verifierResult);
          return { status: verifierResult.status, ...(verifierResult.error === undefined ? {} : { error: verifierResult.error }), evidence: verifierResult };
        },
      }),
      evidence: writer,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.maxWallClockMs === undefined ? {} : { maxWallClockMs: options.maxWallClockMs }),
      shutdownGraceMs: options.shutdownGraceMs ?? CURSOR_SDK_DEFAULT_SHUTDOWN_GRACE_MS,
    });
  } finally {
    await writer.close().catch((error: unknown) => errors.push(`recorder-close: ${errorMessage(error)}`));
  }

  if (workspace?.status === "ready") await captureWorkspace().catch(() => undefined);
  if (agentId !== undefined && nativeRunId !== undefined) {
    await validateStoreFiles(storeRoot, agentId, nativeRunId).catch((error: unknown) => errors.push(`store: ${errorMessage(error)}`));
  }
  const sessionPath = join(assembler.bundleRoot, "native", "session.jsonl");
  if (await nonempty(sessionPath)) {
    await assembler.registerArtifact({
      id: "cursor-session", source: CURSOR_SDK_HARNESS, kind: "session", mediaType: "application/x-ndjson",
      sharingClass: "restricted", relativePath: "native/session.jsonl",
      ...(agentId === undefined ? {} : { nativeReference: { type: "session", id: agentId } }),
    });
  }
  const storeFiles: string[] = [];
  for (const [name, file] of Object.entries(JSONL_LOCAL_AGENT_STORE_FILES)) {
    const path = join(storeRoot, file);
    if (!await nonempty(path)) continue;
    const relativePath = `native/store/${file}`;
    storeFiles.push(relativePath);
    await assembler.registerArtifact({
      id: `cursor-store-${name}`, source: "cursor-sdk-native-store", kind: "session", mediaType: "application/x-ndjson",
      sharingClass: "restricted", relativePath,
    });
  }

  const captureFailure = errors.some((error) => !error.startsWith("billing:"));
  const missingEvidence: CaptureMissingEvidence[] = [
    { kind: "telemetry", reason: "unsupported", affects: ["timing-resource"], detail: "@cursor/sdk 1.0.31 exposes no verified native OTLP configuration or receipt API." },
    ...(captureFailure ? [{ kind: "session", reason: "not-collected" as const, affects: ["semantic" as const], detail: errors.join("; ").slice(0, 4096) }] : []),
    ...(terminalResult === undefined ? [{ kind: "session-completion", reason: attempt.terminal.state === "interrupted" ? "process-interrupted" as const : "not-emitted" as const, affects: ["semantic" as const] }] : []),
    ...(workspaceOutcome === undefined && workspaceCaptureError !== undefined ? [{ kind: "workspace", reason: "not-collected" as const, affects: ["outcome" as const], detail: workspaceCaptureError.slice(0, 4096) }] : []),
  ];
  const terminal = structuredClone(attempt.terminal);
  if (workspaceOutcome === undefined) delete terminal.workspaceArtifactId;
  const qualificationOptions = { startingWorkspacePath: options.startingWorkspacePath, semanticEvidenceKinds: ["session"] as const };
  const manifest = await assembler.finalize({ terminal, missingEvidence, qualification: qualificationOptions });
  const qualification = await qualifyRunBundle(assembler.bundleRoot, qualificationOptions);
  return {
    attempt,
    manifest,
    qualification,
    capture: {
      sdkVersion: CURSOR_SDK_VERSION,
      ...(agentId === undefined ? {} : { agentId }),
      ...(nativeRunId === undefined ? {} : { runId: nativeRunId }),
      ...(terminalResult === undefined ? {} : { terminal: structuredClone(terminalResult) }),
      streamRecords,
      deltaRecords,
      stepRecords,
      historyStatus,
      billingStatus,
      storeFiles,
      errors,
    },
  };
}

type ExecuteCursorSdkOptions = {
  workspacePath: string;
  prompt: string;
  apiKey: string;
  configuration: CursorSdkCaptureConfiguration;
  store: JsonlLocalAgentStore;
  writer: CursorNativeWriter;
  signal: AbortSignal;
  registerShutdown: (shutdown: () => void | Promise<void>) => void;
  agentFactory: CursorSdkAgentFactory;
  setAgentId: (id: string) => void;
  setRunId: (id: string) => void;
  setTerminal: (result: RunResult) => void;
  onStream: () => void;
  onDelta: () => void;
  onStep: () => void;
  setHistoryStatus: (status: CursorSdkCaptureReport["historyStatus"]) => void;
  setBillingStatus: (status: CursorSdkCaptureReport["billingStatus"]) => void;
  errors: string[];
  shutdownGraceMs: number;
};

async function executeCursorSdk(options: ExecuteCursorSdkOptions): Promise<HarnessExecutionResult> {
  let agent: SDKAgent | undefined;
  let run: Run | undefined;
  let result: RunResult | undefined;
  let executionError: string | undefined;
  let captureError: string | undefined;
  let cleanupError: string | undefined;
  let callbacksOpen = true;
  let disposePromise: Promise<void> | undefined;
  const environment = restrictCursorProcessEnvironment(options.apiKey);
  const disposeAgent = async (): Promise<void> => {
    if (agent === undefined) return;
    disposePromise ??= settleWithin(agent[Symbol.asyncDispose](), options.shutdownGraceMs, "Cursor agent disposal");
    await disposePromise;
  };
  options.registerShutdown(async () => {
    callbacksOpen = false;
    const outcomes = await Promise.allSettled([
      ...(run === undefined ? [] : [settleWithin(run.cancel(), options.shutdownGraceMs, "Cursor run cancellation")]),
      disposeAgent(),
    ]);
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  });
  try {
    await assertCursorWorkspaceIsolation(options.workspacePath);
    await options.writer.record("configuration", {
      sdkVersion: CURSOR_SDK_VERSION,
      runtimeIdentity: { status: "not-exposed", detail: "The public SDK does not expose a separately versioned local agent runtime." },
      model: options.configuration.model,
      toolPolicy: options.configuration.toolPolicy,
      workingDirectory: options.workspacePath,
      workingDirectoryPolicy: "isolated-local.cwd",
      environmentKeys: environment.keys,
      telemetry: { nativeOtlp: "unsupported" },
    });
    if (options.signal.aborted) throw new Error("Cursor agent creation was interrupted.");
    const agentPromise = options.agentFactory({
      apiKey: options.apiKey,
      model: structuredClone(options.configuration.model),
      tools: [...options.configuration.toolPolicy.tools],
      ...(options.configuration.toolPolicy.disallowedTools === undefined ? {} : { disallowedTools: [...options.configuration.toolPolicy.disallowedTools] }),
      local: {
        cwd: options.workspacePath,
        store: options.store,
        settingSources: [],
        sandboxOptions: { enabled: options.configuration.toolPolicy.sandbox.enabled },
        autoReview: false,
        enableAgentRetries: false,
      },
    });
    agent = await abortable(agentPromise, options.signal, "Cursor agent creation", async (lateAgent) => {
      await settleWithin(lateAgent[Symbol.asyncDispose](), options.shutdownGraceMs, "Late Cursor agent disposal").catch(() => undefined);
    });
    requireText(agent.agentId, "Cursor agent ID");
    options.setAgentId(agent.agentId);
    await options.writer.record("agent-created", { agentId: agent.agentId, model: agent.model }, { agentId: agent.agentId, sessionId: agent.agentId });

    if (options.signal.aborted) throw new Error("Cursor run creation was interrupted.");
    const sendPromise = agent.send(options.prompt, {
      onDelta: async ({ update }: { update: InteractionUpdate }) => {
        if (!callbacksOpen) return;
        const snapshot = snapshotJson(update);
        options.onDelta();
        await options.writer.record("delta", { update: snapshot }, { agentId: agent!.agentId, runId: run?.id, sessionId: agent!.agentId });
      },
      onStep: async ({ step }: { step: ConversationStep }) => {
        if (!callbacksOpen) return;
        const snapshot = snapshotJson(step);
        options.onStep();
        await options.writer.record("step", { step: snapshot }, { agentId: agent!.agentId, runId: run?.id, sessionId: agent!.agentId });
      },
    });
    run = await abortable(sendPromise, options.signal, "Cursor run creation", async (lateRun) => {
      await settleWithin(lateRun.cancel(), options.shutdownGraceMs, "Late Cursor run cancellation").catch(() => undefined);
    });
    requireText(run.id, "Cursor run ID");
    if (run.agentId !== agent.agentId) throw new Error("Cursor run identity differs from its owned agent.");
    options.setRunId(run.id);
    await options.writer.record("run-created", { runId: run.id, agentId: run.agentId, model: run.model, createdAt: run.createdAt }, ids(agent, run));
    if (options.signal.aborted) await run.cancel();

    const stream = (async () => {
      try {
        for await (const message of run!.stream()) {
          assertMessageIdentity(message, agent!.agentId, run!.id);
          options.onStream();
          await options.writer.record("stream", { message: snapshotJson(message) }, ids(agent!, run!));
        }
      } catch (error) {
        captureError ??= `stream: ${errorMessage(error)}`;
        options.errors.push(captureError);
        await options.writer.record("error", { stage: "stream", message: errorMessage(error) }, ids(agent!, run!)).catch(() => undefined);
      }
    })();
    try {
      result = await run.wait();
      options.setTerminal(result);
      assertTerminalIdentity(result, agent.agentId, run);
      await options.writer.record("terminal", { result: snapshotJson(result) }, ids(agent, run));
    } catch (error) {
      executionError = `wait: ${errorMessage(error)}`;
      options.errors.push(executionError);
      await options.writer.record("error", { stage: "wait", message: errorMessage(error) }, ids(agent, run)).catch(() => undefined);
    }
    await stream;

    try {
      const conversation = await run.conversation();
      options.setHistoryStatus("captured");
      await options.writer.record("history", { conversation: snapshotJson(conversation) }, ids(agent, run));
    } catch (error) {
      options.setHistoryStatus("failed");
      captureError ??= `history: ${errorMessage(error)}`;
      options.errors.push(`history: ${errorMessage(error)}`);
      await options.writer.record("error", { stage: "history", message: errorMessage(error) }, ids(agent, run)).catch(() => undefined);
    }
    try {
      const usage: AgentUsage = await agent.getUsage();
      options.setBillingStatus("captured");
      await options.writer.record("billing", { scope: "agent", retrievedAt: new Date().toISOString(), usage: snapshotJson(usage) }, ids(agent, run));
    } catch (error) {
      options.setBillingStatus("unavailable");
      options.errors.push(`billing: ${errorMessage(error)}`);
      await options.writer.record("error", { stage: "billing", message: errorMessage(error) }, ids(agent, run)).catch(() => undefined);
    }
    await validateStoreIdentity(options.store, agent.agentId, run.id);
  } catch (error) {
    executionError ??= errorMessage(error);
    options.errors.push(`execution: ${executionError}`);
    await options.writer.record("error", { stage: "execution", message: executionError }, {
      ...(agent === undefined ? {} : { agentId: agent.agentId, sessionId: agent.agentId }),
      ...(run === undefined ? {} : { runId: run.id }),
    }).catch(() => undefined);
  } finally {
    callbacksOpen = false;
    if (agent !== undefined) {
      try {
        await disposeAgent();
        await options.writer.record("cleanup", { status: "completed" }, {
          agentId: agent.agentId, sessionId: agent.agentId, ...(run === undefined ? {} : { runId: run.id }),
        });
      } catch (error) {
        cleanupError = errorMessage(error);
        options.errors.push(`cleanup: ${cleanupError}`);
        await options.writer.record("cleanup", { status: "failed", error: cleanupError }, {
          agentId: agent.agentId, sessionId: agent.agentId, ...(run === undefined ? {} : { runId: run.id }),
        }).catch(() => undefined);
      }
    }
    environment.restore();
  }
  captureError ??= options.writer.error;
  if (captureError !== undefined && !options.errors.includes(captureError)) options.errors.push(captureError);
  if (executionError !== undefined || cleanupError !== undefined || result?.status === "error") {
    return {
      status: "failed",
      failureClass: "infrastructure",
      reason: executionError ?? cleanupError ?? result?.error?.message ?? "Cursor run failed.",
      ...(captureError === undefined ? {} : { captureError }),
      ...(result === undefined ? {} : { completionEvidence: result }),
    };
  }
  if (result?.status === "cancelled" || options.signal.aborted) {
    return { status: "interrupted", ...(captureError === undefined ? {} : { captureError }), ...(result === undefined ? {} : { completionEvidence: result }) };
  }
  if (result?.status !== "finished") {
    return { status: "failed", failureClass: "infrastructure", reason: "Cursor run did not produce owned terminal evidence.", ...(captureError === undefined ? {} : { captureError }) };
  }
  return { status: "completed", ...(captureError === undefined ? {} : { captureError }), completionEvidence: result };
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  label: string,
  onLateValue: (value: T) => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void promise.then(onLateValue, () => undefined);
    throw new Error(`${label} was interrupted.`);
  }
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new Error(`${label} was interrupted.`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => {
      if (settled) {
        void Promise.resolve(onLateValue(value)).catch(() => undefined);
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolvePromise(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rejectPromise(error);
    });
  });
}

async function settleWithin(promise: Promise<void>, timeoutMs: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${String(timeoutMs)}ms.`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Prevent Cursor from promoting an ancestor checkout above the materialized workspace. */
export async function assertCursorWorkspaceIsolation(workspacePath: string): Promise<void> {
  const workspace = resolve(workspacePath);
  let current = workspace;
  const root = parse(workspace).root;
  while (current !== root) {
    try {
      await lstat(join(current, ".git"));
      throw new Error("Cursor workspace must not be nested in another Git checkout; choose --workspace-root outside that checkout.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

function restrictCursorProcessEnvironment(apiKey: string): { keys: string[]; restore: () => void } {
  if (cursorEnvironmentActive) throw new Error("Concurrent in-process Cursor captures are not supported while the SDK child environment is restricted.");
  const previous = { ...process.env };
  cursorEnvironmentActive = true;
  for (const key of Object.keys(process.env)) {
    if (!CURSOR_ENVIRONMENT_KEYS.has(key) && !key.startsWith("LC_")) delete process.env[key];
  }
  process.env.CURSOR_API_KEY = apiKey;
  let restored = false;
  return {
    keys: Object.keys(process.env).sort(),
    restore: () => {
      if (restored) return;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
      restored = true;
      cursorEnvironmentActive = false;
    },
  };
}

/** Read and normalize one retained, capture-qualified Cursor SDK bundle. */
export async function createCursorSdkBehaviorEvidence(bundleRoot: string): Promise<CursorSdkBehaviorEvidence> {
  const manifest = JSON.parse(readBoundedFile(join(resolve(bundleRoot), "manifest.json"), "Run manifest").toString("utf8")) as RunManifest;
  if (manifest.run.harness.id !== CURSOR_SDK_HARNESS || manifest.run.harness.version !== CURSOR_SDK_VERSION
      || !manifest.run.runtime.some(({ source, name, version }) => source === "cursor" && name === "cursor-sdk" && version === CURSOR_SDK_VERSION)) {
    throw new Error(`Unsupported retained Cursor SDK runtime ${manifest.run.harness.version}.`);
  }
  const outcomeCapture = await readQualifiedRunCapture(bundleRoot);
  const manifestRecord = outcomeCapture.records.find(({ record }) => record.kind === "manifest")?.record.document as RunManifest["terminal"] | undefined;
  const capture: NormalizationInput<CursorNativeRecord> = {
    runId: outcomeCapture.runId,
    attemptId: outcomeCapture.attemptId,
    qualification: outcomeCapture.qualification,
    records: outcomeCapture.records.filter(({ record }) => record.kind === "session").map(({ reference, record }) => {
      assertCursorRecord(record.document, reference);
      return { reference, record: record.document as CursorNativeRecord };
    }),
  };
  assertRetainedCursorIdentity(manifest, capture.records.map(({ record }) => record));
  const normalization = normalizeCursorSdkCapture(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: CURSOR_SDK_CAPABILITIES,
    adapterVersion: CURSOR_SDK_ADAPTER_VERSION,
    nativeType: cursorNativeType,
  });
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver(outcomeCapture));
  const coverage = await validateNormalizedDataset(dataset, resolver);
  if (manifestRecord === undefined) throw new Error("Retained Cursor bundle omits terminal outcome metadata.");
  return { capture, outcomeCapture, dataset, resolver, coverage };
}

function assertRetainedCursorIdentity(manifest: RunManifest, records: readonly CursorNativeRecord[]): void {
  const envelopes = records.filter((record) => record.schemaVersion === CURSOR_NATIVE_SCHEMA_VERSION);
  const byChannel = (channel: string): CursorNativeRecord[] => envelopes.filter((record) => record.channel === channel);
  const configurations = byChannel("configuration");
  const agents = byChannel("agent-created");
  const runs = byChannel("run-created");
  const terminals = byChannel("terminal");
  if (configurations.length !== 1 || agents.length !== 1 || runs.length !== 1 || terminals.length !== 1) {
    throw new Error("Retained Cursor capture requires one configuration, agent, run, and terminal record.");
  }
  const sessionId = manifest.run.native?.sessionId;
  const agentId = text(agents[0]!.agentId) ?? text(asRecord(agents[0]!.payload)?.agentId);
  const runId = text(runs[0]!.runId) ?? text(asRecord(runs[0]!.payload)?.runId);
  if (sessionId === undefined || agentId !== sessionId || runId === undefined) {
    throw new Error("Retained Cursor agent/run identity differs from the run manifest.");
  }
  for (const record of envelopes) {
    if (record.agentId !== undefined && record.agentId !== agentId
        || record.sessionId !== undefined && record.sessionId !== sessionId
        || record.runId !== undefined && record.runId !== runId) {
      throw new Error("Retained Cursor native envelope contains a foreign agent/run identity.");
    }
  }
  const configuration = asRecord(configurations[0]!.payload);
  const configuredModel = modelId(configuration?.model);
  if (configuration?.sdkVersion !== CURSOR_SDK_VERSION || configuredModel !== manifest.run.model.id
      || configuration?.workingDirectoryPolicy !== "isolated-local.cwd"
      || !Array.isArray(configuration?.environmentKeys) || configuration.environmentKeys.some((key) => typeof key !== "string")) {
    throw new Error("Retained Cursor configuration differs from the effective run manifest or policy.");
  }
  const runPayload = asRecord(runs[0]!.payload);
  const terminal = asRecord(asRecord(terminals[0]!.payload)?.result);
  if (runPayload?.runId !== runId || runPayload.agentId !== agentId || modelId(runPayload.model) !== manifest.run.model.id
      || terminal?.id !== runId || modelId(terminal.model) !== manifest.run.model.id
      || !["finished", "cancelled", "error"].includes(String(terminal.status))) {
    throw new Error("Retained Cursor terminal/model identity differs from the owned run.");
  }
  for (const record of byChannel("stream")) {
    const message = asRecord(asRecord(record.payload)?.message);
    if (message?.agent_id !== agentId || message.run_id !== runId) {
      throw new Error("Retained Cursor stream identity differs from the owned run.");
    }
  }
  const storeAgents = records.filter((record) => cursorNativeType(record) === "store:agent");
  const storeRuns = records.filter((record) => cursorNativeType(record) === "store:run");
  const storeEvents = records.filter((record) => cursorNativeType(record) === "store:run-event");
  const storeCheckpoints = records.filter((record) => cursorNativeType(record) === "store:checkpoint");
  if (storeAgents.length !== 1 || storeAgents[0]!.agentId !== agentId
      || storeRuns.length !== 1 || storeRuns[0]!.agentId !== agentId || storeRuns[0]!.runId !== runId
      || modelId(storeRuns[0]!.model) !== manifest.run.model.id
      || storeEvents.some((record) => record.runId !== runId)
      || storeCheckpoints.some((record) => record.agentId !== agentId)) {
    throw new Error("Retained Cursor native store identity differs from the owned agent/run/model.");
  }
}

export function normalizeCursorSdkCapture(input: NormalizationInput<CursorNativeRecord>): NormalizationResult {
  const events: UniformEvent[] = [];
  const unmapped: NormalizationResult["unmapped"][number][] = [];
  for (const captured of input.records) {
    const mapped = mapCursorRecord(input, captured.reference, captured.record);
    events.push(...mapped);
    if (mapped.length === 0) unmapped.push({ reference: captured.reference, reason: unmappedCursorReason(captured.record) });
  }
  return { events, unmapped };
}

function mapCursorRecord(
  input: Pick<NormalizationInput<CursorNativeRecord>, "runId" | "attemptId">,
  reference: NativeEvidenceReference,
  record: CursorNativeRecord,
): UniformEvent[] {
  if (record.schemaVersion !== CURSOR_NATIVE_SCHEMA_VERSION) return [];
  const channel = record.channel;
  const payload = asRecord(record.payload);
  const sequence = safeInteger(record.sequence);
  if (typeof channel !== "string" || payload === undefined || sequence === undefined) return [];
  const nativeType = cursorNativeType(record);
  const base = (family: UniformEvent["family"], phase: UniformEvent["phase"], discriminator: string): UniformEvent => ({
    schemaVersion: "ebo.uniform-event/v1",
    id: stableEventId(input, reference, discriminator),
    runId: input.runId,
    attemptId: input.attemptId,
    source: { harness: CURSOR_SDK_HARNESS, nativeType, nativeReference: reference },
    nativeOrder: { status: "known", value: sequence, domain: "cursor-sdk-receipt" },
    nativeTime: { status: "unknown", reason: "Record time is adapter receipt time, not a source-native timestamp." },
    actor: { kind: "harness", ...(text(record.agentId) === undefined ? {} : { id: text(record.agentId) }) },
    family,
    phase,
    scope: text(record.runId) === undefined ? { kind: "session", ...(text(record.sessionId) === undefined ? {} : { id: text(record.sessionId) }) } : { kind: "turn", id: text(record.runId) },
    relations: { parent: { status: "unknown", reason: "No source-native event parent is exposed for this record." }, known: [] },
    attributes: compactAttributes({ timestampSemantics: "adapter-receipt", agentId: text(record.agentId), sessionId: text(record.sessionId), runId: text(record.runId) }),
    content: { status: "unknown", reason: "Native content remains in the restricted record." },
  });

  if (channel === "stream") {
    const message = asRecord(payload.message);
    const type = text(message?.type);
    if (message === undefined || type === undefined) return [];
    if (type === "assistant" || type === "user") {
      const event = base("message", "instant", type);
      event.actor = { kind: type === "user" ? "user" : "model", ...(type === "assistant" && text(record.agentId) !== undefined ? { id: text(record.agentId) } : {}) };
      event.content = knownContent(contentReference(reference, "", `${type}-message`));
      return [event];
    }
    if (type === "tool_call") {
      const callId = text(message.call_id);
      const status = text(message.status);
      const phase = status === "running" ? "before" : "after";
      const failed = status === "error" || asRecord(message.result)?.status === "error";
      const event = base("tool", phase, `tool:${callId ?? sequence}:${status ?? "unknown"}`);
      event.actor = { kind: "tool", ...(text(message.name) === undefined ? {} : { id: text(message.name) }) };
      event.scope = { kind: "operation", ...(callId === undefined ? {} : { id: callId }) };
      event.attributes = compactAttributes({
        ...event.attributes,
        operationId: callId,
        toolName: text(message.name),
        toolStatus: status,
        inputDigest: message.args === undefined ? undefined : `sha256:${digestMetadata(message.args).value}`,
        failed: failed ? true : undefined,
      });
      const content: ContentReference[] = [];
      if (message.args !== undefined) content.push(contentReference(reference, "", "tool-input"));
      if (message.result !== undefined) content.push(contentReference(reference, "", failed ? "tool-error" : "tool-result"));
      if (content.length > 0) event.content = knownContent(...content);
      return [event];
    }
    if (type === "usage") {
      const usage = asRecord(message.usage);
      if (usage === undefined) return [];
      const event = base("runtime", "instant", `usage:${sequence}`);
      event.attributes = compactAttributes({
        ...event.attributes,
        resourceSemantics: "increment",
        inputTokens: nonnegativeInteger(usage.inputTokens),
        outputTokens: nonnegativeInteger(usage.outputTokens),
        cacheReadInputTokens: nonnegativeInteger(usage.cacheReadTokens),
        cacheCreationInputTokens: nonnegativeInteger(usage.cacheWriteTokens),
        totalTokens: nonnegativeInteger(usage.totalTokens),
        reasoningTokens: nonnegativeInteger(usage.reasoningTokens),
      });
      return [event];
    }
    if (type === "status" || type === "system") {
      const event = base("runtime", "instant", `${type}:${sequence}`);
      event.attributes = compactAttributes({ ...event.attributes, status: text(message.status), model: modelId(message.model) });
      return [event];
    }
    return [];
  }
  if (channel === "terminal") {
    const result = asRecord(payload.result);
    if (result === undefined) return [];
    const event = base("outcome", "after", "terminal");
    event.attributes = compactAttributes({
      ...event.attributes,
      status: text(result.status),
      model: modelId(result.model),
      durationMs: nonnegativeNumber(result.durationMs),
      resourceSemantics: nonnegativeNumber(result.durationMs) === undefined ? undefined : "cumulative-final",
    });
    return [event];
  }
  return [];
}

class CursorNativeWriter {
  private pending: Promise<void> = Promise.resolve();
  private sequence = 0;
  private failure?: string;

  private constructor(
    readonly path: string,
    private readonly file: FileHandle,
    private readonly maxRecordBytes: number,
    private readonly now: () => string,
  ) {}

  static async open(path: string, maxRecordBytes: number, now: (() => string) | undefined): Promise<CursorNativeWriter> {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new Error("Cursor native record limit must be a positive safe integer.");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    return new CursorNativeWriter(path, file, maxRecordBytes, now ?? (() => new Date().toISOString()));
  }

  get error(): string | undefined {
    return this.failure;
  }

  async record(
    channel: string,
    payload: unknown,
    identity: { agentId?: string; runId?: string; sessionId?: string } = {},
  ): Promise<void> {
    const record = {
      schemaVersion: CURSOR_NATIVE_SCHEMA_VERSION,
      sequence: ++this.sequence,
      receivedAt: this.now(),
      channel,
      ...identity,
      payload: snapshotJson(payload),
    };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > this.maxRecordBytes) {
      this.failure ??= `Cursor ${channel} record exceeds the configured byte limit.`;
      throw new Error(this.failure);
    }
    const write = this.pending.then(async () => {
      await this.file.write(line);
    });
    this.pending = write.catch((error: unknown) => {
      this.failure ??= `recorder: ${errorMessage(error)}`;
    });
    await write;
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure !== undefined) throw new Error(this.failure);
    await this.file.sync();
  }

  async close(): Promise<void> {
    let failure: unknown;
    try {
      await this.flush();
    } catch (error) {
      failure = error;
    }
    await this.file.close();
    if (failure !== undefined) throw failure;
  }
}

async function validateStoreIdentity(store: JsonlLocalAgentStore, agentId: string, runId: string): Promise<void> {
  const [agent, run, agents, runs] = await Promise.all([
    store.agents.get({ agentId }),
    store.runs.get({ agentId, runId }),
    store.agents.list({ filter: { limit: 2 } }),
    store.runs.list({ filter: { limit: 2 } }),
  ]);
  if (agent?.agentId !== agentId) throw new Error("Cursor native store omits or mismatches the owned agent identity.");
  if (run?.agentId !== agentId || run.runId !== runId) throw new Error("Cursor native store omits or mismatches the owned run identity.");
  if (agents.items.length !== 1 || agents.items[0]?.agentId !== agentId
      || runs.items.length !== 1 || runs.items[0]?.agentId !== agentId || runs.items[0]?.runId !== runId) {
    throw new Error("Cursor native store contains a foreign agent or run.");
  }
}

async function validateStoreFiles(storeRoot: string, agentId: string, runId: string): Promise<void> {
  const documents = (name: keyof typeof JSONL_LOCAL_AGENT_STORE_FILES): CursorNativeRecord[] => {
    const path = join(storeRoot, JSONL_LOCAL_AGENT_STORE_FILES[name]);
    if (!existsSync(path)) return [];
    const source = readBoundedFile(path, `Cursor ${name} store`).toString("utf8");
    return source.split(/\r?\n/u).filter(Boolean).map((line, index) => {
      assertNoDuplicateJsonKeys(line);
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) throw new Error(`Cursor ${name} store line ${String(index + 1)} is not an object.`);
      return value;
    });
  };
  const agents = documents("agents");
  const runs = documents("runs");
  const runEvents = documents("runEvents");
  const checkpoints = documents("checkpoints");
  if (agents.length !== 1 || agents[0]!.agentId !== agentId
      || runs.length !== 1 || runs[0]!.agentId !== agentId || runs[0]!.runId !== runId
      || runEvents.some((record) => record.runId !== runId)
      || checkpoints.some((record) => record.agentId !== agentId)) {
    throw new Error("Cursor native store contains evidence outside the owned agent/run.");
  }
}

function assertMessageIdentity(message: SDKMessage, agentId: string, runId: string): void {
  if (message.agent_id !== agentId || message.run_id !== runId) {
    throw new Error("Cursor stream record identity differs from its owned agent/run.");
  }
}

function assertTerminalIdentity(result: RunResult, agentId: string, run: Run): void {
  if (result.id !== run.id || run.agentId !== agentId) throw new Error("Cursor terminal identity differs from its owned agent/run.");
  const expectedModel = modelId(run.model);
  const actualModel = modelId(result.model);
  if (expectedModel !== undefined && actualModel !== undefined && expectedModel !== actualModel) {
    throw new Error("Cursor terminal model differs from the selected run model.");
  }
}

function ids(agent: SDKAgent, run: Run): { agentId: string; runId: string; sessionId: string } {
  return { agentId: agent.agentId, runId: run.id, sessionId: agent.agentId };
}

function assertCursorRecord(value: unknown, reference: NativeEvidenceReference): void {
  if (!isRecord(value)) throw new Error(`Invalid retained Cursor record at ${reference.artifactId}:${reference.recordLocator}.`);
  if (value.schemaVersion === CURSOR_NATIVE_SCHEMA_VERSION) {
    const expectedLine = Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]);
    if (!Number.isSafeInteger(value.sequence) || value.sequence !== expectedLine || (value.sequence as number) < 1 || typeof value.channel !== "string"
        || typeof value.receivedAt !== "string" || !isRecord(value.payload)) {
      throw new Error(`Invalid retained Cursor envelope at ${reference.artifactId}:${reference.recordLocator}.`);
    }
    return;
  }
  const type = cursorNativeType(value);
  if (type === "store:agent" && typeof value.agentId === "string" && typeof value.cwd === "string"
      && typeof value.status === "string" && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt)) return;
  if (type === "store:run" && typeof value.agentId === "string" && typeof value.runId === "string"
      && Number.isSafeInteger(value.turnNumber) && typeof value.status === "string" && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt)) return;
  if (type === "store:run-event" && typeof value.runId === "string" && Number.isSafeInteger(value.seq)
      && typeof value.offset === "string" && typeof value.eventType === "string" && typeof value.createdAt === "string") return;
  if (type === "store:checkpoint" && typeof value.agentId === "string" && typeof value.blobId === "string" && typeof value.dataBase64 === "string") return;
  throw new Error(`Invalid retained Cursor store record at ${reference.artifactId}:${reference.recordLocator}.`);
}

function cursorNativeType(record: CursorNativeRecord): string {
  if (record.schemaVersion === CURSOR_NATIVE_SCHEMA_VERSION) {
    if (record.channel === "stream") {
      const type = text(asRecord(asRecord(record.payload)?.message)?.type);
      return (STREAM_TYPES as readonly string[]).includes(type ?? "") ? `stream:${type}` : "stream:unknown";
    }
    return typeof record.channel === "string" && NATIVE_TYPES.includes(record.channel as typeof NATIVE_TYPES[number])
      ? record.channel
      : "error";
  }
  if (typeof record.dataBase64 === "string" && typeof record.blobId === "string") return "store:checkpoint";
  if (typeof record.eventType === "string" && Number.isSafeInteger(record.seq)) return "store:run-event";
  if (Number.isSafeInteger(record.turnNumber) && typeof record.runId === "string") return "store:run";
  if (typeof record.cwd === "string" && typeof record.agentId === "string") return "store:agent";
  return "store:unknown";
}

function unmappedCursorReason(record: CursorNativeRecord): string {
  const type = cursorNativeType(record);
  if (type === "delta" || type === "step") return "Detailed callback evidence overlaps the authoritative stream projection and remains native.";
  if (type === "history" || type.startsWith("store:")) return "Durable native history remains authoritative evidence and is not counted as a second operation/message source.";
  if (type === "billing") return "Eventually consistent billing readback remains separate from per-turn token observations.";
  if (type === "stream:thinking") return "Hidden reasoning remains restricted native evidence and is never projected as semantic content.";
  return "Cursor native record is retained explicitly without a supported semantic mapping.";
}

function contentReference(reference: NativeEvidenceReference, pointer: string, role: string): ContentReference {
  return { nativeReference: pointer === "" ? structuredClone(reference) : { artifactId: reference.artifactId, recordLocator: `${reference.recordLocator}#${pointer}` }, role };
}

function knownContent(...value: ContentReference[]): UniformEvent["content"] {
  return { status: "known", value };
}

function stableEventId(
  input: Pick<NormalizationInput<CursorNativeRecord>, "runId" | "attemptId">,
  reference: NativeEvidenceReference,
  discriminator: string,
): string {
  return `cursor-${createHash("sha256").update(JSON.stringify([input.runId, input.attemptId, reference, discriminator])).digest("hex").slice(0, 32)}`;
}

function compactAttributes(values: Record<string, UniformAttributeValue | undefined>): Record<string, UniformAttributeValue> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, UniformAttributeValue] => entry[1] !== undefined));
}

function snapshotJson<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Cursor SDK emitted a non-JSON value.");
  return JSON.parse(text) as T;
}

function modelId(value: unknown): string | undefined {
  return typeof value === "string" ? value : text(asRecord(value)?.id);
}

function nonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} must be nonempty.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function nonempty(path: string): Promise<boolean> {
  return ((await stat(path).catch(() => undefined))?.size ?? 0) > 0;
}
