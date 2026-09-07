import { createServer, type IncomingMessage, type Server } from "node:http";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { ClientNotification } from "../contracts/codex-app-server-0.150.1/types/ClientNotification.js";
import type { AskForApproval } from "../contracts/codex-app-server-0.150.1/types/AskForApproval.js";
import type { SandboxMode } from "../contracts/codex-app-server-0.150.1/types/SandboxMode.js";
import type { ThreadReadParams } from "../contracts/codex-app-server-0.150.1/types/ThreadReadParams.js";
import type { TokenUsageBreakdown } from "../contracts/codex-app-server-0.150.1/types/TokenUsageBreakdown.js";
import type { TurnInterruptParams } from "../contracts/codex-app-server-0.150.1/types/TurnInterruptParams.js";

import {
  spawnProtocolProcess,
  type ProtocolIdentity,
  type ProtocolObservation,
  type ProtocolProcess,
  type ProtocolProcessResult,
} from "./process-protocol.js";
import {
  createCapturedNativeEvidenceResolver,
  describeNormalizedDataset,
  validateNormalizedDataset,
  type AdapterCoverageReport,
  type NormalizedDataset,
} from "./normalization-integrity.js";
import {
  validateUniformEvents,
  type AdapterCapabilityProfile,
  type CapturedNativeRecord,
  type HarnessAdapter,
  type NativeEvidenceReference,
  type NormalizationResult,
  type QualifiedNativeCapture,
  type UniformEvent,
} from "./uniform-events.js";

export const CODEX_APP_SERVER_VERSION = "0.150.1";
export const CODEX_ADAPTER_VERSION = "0.1.0";
export const CODEX_HARNESS = "codex-app-server";
export const CODEX_DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type CodexApprovalPolicy = Extract<AskForApproval, string>;
export type CodexSandbox = SandboxMode;
export type CodexTelemetrySignal = "logs" | "traces" | "metrics";

export type CodexAppServerConfiguration = {
  executable: string;
  version: typeof CODEX_APP_SERVER_VERSION;
  provider: "openai";
  model: string;
  effort: CodexReasoningEffort;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandbox;
  /** Test-only executable prefix; production uses the pinned executable directly. */
  executableArgs?: readonly string[];
  telemetry?: { signals: readonly CodexTelemetrySignal[] };
};

export type CodexOtlpRecord = {
  signal: CodexTelemetrySignal;
  receivedAt: string;
  contentType?: string;
  payload?: unknown;
  raw?: string;
  parseError?: string;
};

export type CodexTelemetryEvidence = {
  schemaVersion: "ebo.codex-telemetry/v1";
  attemptId: string;
  runtime: {
    executable: string;
    version: string;
    adapterVersion: string;
    userConfiguration: "isolated";
    localLoginReference: "available" | "unavailable";
  };
  effectiveConfiguration: {
    model: string;
    provider: "openai";
    effort: CodexReasoningEffort;
    approvalPolicy: CodexApprovalPolicy;
    sandbox: CodexSandbox;
    workspace: string;
    environmentKeys: readonly string[];
    threadStart?: Record<string, unknown>;
  };
  telemetry: {
    receipt: {
      status: "received" | "missing" | "not-checked";
      signals: Record<CodexTelemetrySignal, {
        status: "received" | "missing" | "disabled";
        count: number;
      }>;
    };
    records: readonly CodexOtlpRecord[];
    receiverErrors: readonly string[];
  };
  usage: {
    updates: ReadonlyArray<{
      sequence: number;
      threadId: string;
      turnId: string;
      total: Partial<TokenUsageBreakdown>;
      last: Partial<TokenUsageBreakdown>;
      modelContextWindow?: number;
    }>;
    final?: {
      total: Partial<TokenUsageBreakdown>;
      last: Partial<TokenUsageBreakdown>;
      modelContextWindow?: number;
    };
  };
};

export type CodexCaptureGap = {
  kind: string;
  detail: string;
};

export type CodexAppServerCaptureRequest = {
  runId: string;
  attemptId: string;
  workspacePath: string;
  prompt: string;
  configuration: CodexAppServerConfiguration;
  evidencePath: string;
  stderrPath?: string;
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  maxLineBytes?: number;
  maxInMemoryObservations?: number;
  now?: () => string;
  registerShutdown?: (shutdown: () => Promise<void>) => void;
};

export type CodexAppServerCapture = QualifiedNativeCapture<ProtocolObservation> & {
  threadId?: string;
  turnId?: string;
  terminalStatus?: "completed" | "interrupted" | "failed";
  terminal?: Record<string, unknown>;
  history?: Record<string, unknown>;
  process: ProtocolProcessResult;
  gaps: readonly CodexCaptureGap[];
  telemetry: CodexTelemetryEvidence;
};

export const CODEX_APP_SERVER_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: "ebo-codex-app-server-v0.150.1",
  harness: CODEX_HARNESS,
  nativeTypes: [
    "item/completed",
    "turn/completed",
    "turn/plan/updated",
    "thread/compacted",
    "thread/tokenUsage/updated",
    "model/rerouted",
    "hook/completed",
    "server-request",
  ],
  families: {
    message: { status: "partial", detail: "Completed user and agent message items are projected." },
    "model-request": { status: "unsupported", detail: "Inference requests are not inferred from turns or model changes." },
    tool: { status: "partial", detail: "Only completed native tool items are projected; deltas stay native." },
    context: { status: "partial", detail: "Plans and compaction are projected when emitted." },
    permission: { status: "partial", detail: "Server requests and unattended decisions stay native; request events are projected." },
    delegation: { status: "partial", detail: "Completed exposed collaboration items are projected when present." },
    artifact: { status: "partial", detail: "Completed file-change items are projected." },
    validation: { status: "unsupported", detail: "Verifier evidence is packaged outside the Codex native normalizer." },
    runtime: { status: "partial", detail: "Usage, reroutes, and completed hooks are projected when emitted." },
    outcome: { status: "available", detail: "Matching turn/completed is authoritative for turn outcome." },
  },
  evidence: {
    nativeOrder: { status: "available", detail: "The retained receive/write sequence is one stdio ordering domain." },
    nativeTime: { status: "partial", detail: "Item lifecycle timestamps are native; other records retain observation time separately." },
    parentage: { status: "partial", detail: "Thread and turn scopes are retained; item relations remain source-specific." },
    content: { status: "partial", detail: "Mapped content references retained native payloads without copying bodies." },
  },
} as const satisfies AdapterCapabilityProfile;

export function createCodexHarnessAdapter(): HarnessAdapter<CodexAppServerCaptureRequest, ProtocolObservation> {
  return {
    capture: {
      id: CODEX_APP_SERVER_CAPABILITIES.adapterId,
      harness: CODEX_HARNESS,
      capture: captureCodexAppServer,
    },
    normalization: {
      id: CODEX_APP_SERVER_CAPABILITIES.adapterId,
      harness: CODEX_HARNESS,
      capabilityProfile: CODEX_APP_SERVER_CAPABILITIES,
      normalize: normalizeCodexCapture,
    },
  };
}

/** Drive one owned Codex app-server thread and finish only on its matching turn/completed notification. */
export async function captureCodexAppServer(request: CodexAppServerCaptureRequest): Promise<CodexAppServerCapture> {
  requireText(request.runId, "Codex run ID");
  requireText(request.attemptId, "Codex attempt ID");
  requireText(request.workspacePath, "Codex workspace path");
  requireText(request.prompt, "Codex prompt");
  requireText(request.configuration.executable, "Codex executable");
  const shutdownGraceMs = request.shutdownGraceMs ?? CODEX_DEFAULT_SHUTDOWN_GRACE_MS;
  let abortRequested = request.signal?.aborted ?? false;
  let abortDeadline = abortRequested ? performance.now() + shutdownGraceMs : undefined;
  let abortAction: (() => Promise<void>) | undefined;
  const abortListener = (): void => {
    abortRequested = true;
    abortDeadline ??= performance.now() + shutdownGraceMs;
    if (abortAction !== undefined) void abortAction();
  };
  request.signal?.addEventListener("abort", abortListener, { once: true });
  if (request.signal?.aborted) abortListener();
  const telemetry = await openOtlpReceiver(request.configuration.telemetry?.signals ?? [], request.now).catch((error: unknown) => {
    request.signal?.removeEventListener("abort", abortListener);
    throw error;
  });
  let isolatedCodexHome: string;
  let localLoginReference: "available" | "unavailable" = "unavailable";
  try {
    isolatedCodexHome = await mkdtemp(join(tmpdir(), "ebo-codex-home-"));
    await writeFile(join(isolatedCodexHome, "instructions.md"), "Work only in the supplied workspace. Do not request interactive input or broaden permissions.\n", { mode: 0o600 });
    const authSource = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
    try {
      await lstat(authSource);
      await symlink(authSource, join(isolatedCodexHome, "auth.json"));
      localLoginReference = "available";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    request.signal?.removeEventListener("abort", abortListener);
    await telemetry.close();
    throw error;
  }
  const instructionsPath = join(isolatedCodexHome, "instructions.md");
  const environment = isolatedEnvironment(isolatedCodexHome);
  const gaps: CodexCaptureGap[] = [];
  const addGap = (gap: CodexCaptureGap): void => recordCaptureGap(gaps, gap);
  let threadId: string | undefined;
  let turnId: string | undefined;
  let terminal: Record<string, unknown> | undefined;
  let history: Record<string, unknown> | undefined;
  const remainingAbortGrace = (): number => abortDeadline === undefined
    ? shutdownGraceMs
    : Math.max(0, abortDeadline - performance.now());
  const interruptWithinAbortGrace = async (): Promise<void> => {
    const terminationBudget = Math.floor(remainingAbortGrace() * 2 / 3);
    const signalGrace = Math.floor(terminationBudget / 2);
    await protocolProcess.interrupt(signalGrace, terminationBudget - signalGrace);
  };
  let nextRequestId = 1;
  const pending = new Map<ProtocolIdentity, {
    method: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  let resolveTerminal: ((value: Record<string, unknown>) => void) | undefined;
  let resolveOwnedTurn: (() => void) | undefined;
  const terminalPromise = new Promise<Record<string, unknown>>((resolvePromise) => {
    resolveTerminal = resolvePromise;
  });
  const ownedTurnPromise = new Promise<void>((resolvePromise) => {
    resolveOwnedTurn = resolvePromise;
  });
  let protocolProcess: ProtocolProcess;
  const stderrDecoder = new TextDecoder("utf-8");
  try {
    protocolProcess = spawnProtocolProcess({
      command: request.configuration.executable,
      args: [
        ...(request.configuration.executableArgs ?? []),
        "app-server",
        "--listen",
        "stdio://",
        "--strict-config",
        ...telemetry.configArgs,
      ],
      cwd: request.workspacePath,
      env: environment,
      source: CODEX_HARNESS,
      evidencePath: request.evidencePath,
      ...(request.stderrPath === undefined ? {} : { stderrPath: request.stderrPath }),
      ...(request.maxLineBytes === undefined ? {} : { maxLineBytes: request.maxLineBytes }),
      ...(request.maxInMemoryObservations === undefined ? {} : { maxInMemoryObservations: request.maxInMemoryObservations }),
      shutdownGraceMs,
      ...(request.now === undefined ? {} : { now: request.now }),
      onStderr: async (chunk, final, recorder) => {
        const diagnostic = stderrDecoder.decode(chunk, { stream: !final });
        if (diagnostic !== "") {
          await recorder.recordNotification({
            source: CODEX_HARNESS,
            method: "diagnostic/stderr",
            payload: { text: diagnostic },
          });
        }
      },
      onFrame: async (payload, recorder) => {
        if (!isRecord(payload)) return;
        const id = protocolId(payload.id);
        const method = typeof payload.method === "string" && payload.method !== "" ? payload.method : undefined;
        if (method !== undefined && id !== undefined) {
          const sourceIdentity = scopedThreadId(payload.params);
          await recorder.recordRequest({
            source: CODEX_HARNESS,
            method,
            id,
            ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
            payload: payload.params ?? null,
          });
          const answer = unattendedServerResponse(method);
          await recorder.recordResponse({
            source: "ebo-codex-client",
            method,
            id,
            ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
            payload: answer,
          });
          await writeProtocolLine(protocolProcess.stdin, answer.error === undefined
            ? { id, result: answer.result }
            : { id, error: answer.error });
          return;
        }
        if (id !== undefined && method === undefined) {
          const waiter = pending.get(id);
          const responseMethod = waiter?.method ?? "unknown-response";
          const responsePayload = payload.error === undefined ? payload.result : { error: payload.error };
          const sourceIdentity = responseSourceIdentity(responseMethod, responsePayload);
          await recorder.recordResponse({
            source: CODEX_HARNESS,
            method: responseMethod,
            id,
            ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
            payload: responsePayload ?? null,
          });
          if (waiter !== undefined) {
            pending.delete(id);
            if (payload.error !== undefined) waiter.reject(new Error(jsonRpcError(responseMethod, payload.error)));
            else if (isRecord(payload.result)) waiter.resolve(payload.result);
            else waiter.reject(new Error(`Codex ${responseMethod} returned a non-object result.`));
          }
          return;
        }
        if (method === undefined || id !== undefined) return;
        const params = isRecord(payload.params) ? payload.params : {};
        const sourceIdentity = scopedThreadId(params) ?? threadId;
        await recorder.recordNotification({
          source: CODEX_HARNESS,
          method,
          ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
          payload: params,
        });
        if (method === "turn/completed") {
          const turn = isRecord(params.turn) ? params.turn : undefined;
          const completedThreadId = text(params.threadId);
          const completedTurnId = text(turn?.id);
          if (turn !== undefined && threadId !== undefined && turnId !== undefined
              && completedThreadId === threadId && completedTurnId === turnId && terminal === undefined) {
            terminal = structuredClone(turn);
            await recorder.recordCompletion({
              source: CODEX_HARNESS,
              method,
              sourceIdentity: threadId!,
              status: text(turn.status) ?? "unknown",
              evidence: turn,
            });
            resolveTerminal?.(turn);
          } else {
            addGap({ kind: "foreign-turn-completion", detail: "Ignored turn/completed for a non-owned thread or turn." });
          }
        }
      },
    });
    request.registerShutdown?.(async () => {
      abortRequested = true;
      abortDeadline ??= performance.now() + shutdownGraceMs;
      await interruptWithinAbortGrace();
    });
  } catch (error) {
    request.signal?.removeEventListener("abort", abortListener);
    await telemetry.close();
    await rm(isolatedCodexHome, { recursive: true, force: true });
    throw error;
  }

  const sendRequest = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextRequestId++;
    await protocolProcess.evidence.recordRequest({
      source: "ebo-codex-client",
      method,
      id,
      ...(threadId === undefined ? {} : { sourceIdentity: threadId }),
      payload: params,
    });
    const response = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      pending.set(id, { method, resolve: resolvePromise, reject });
    });
    await writeProtocolLine(protocolProcess.stdin, { method, id, params });
    return Promise.race([
      response,
      protocolProcess.wait().then((result) => {
        throw new Error(`Codex app-server exited before ${method} completed (${result.status}).`);
      }),
    ]);
  };
  const sendNotification = async (method: string, params: Record<string, unknown> = {}): Promise<void> => {
    await protocolProcess.evidence.recordNotification({ source: "ebo-codex-client", method, payload: params });
    await writeProtocolLine(protocolProcess.stdin, { method, params });
  };

  const abort = async (): Promise<void> => {
    abortRequested = true;
    abortDeadline ??= performance.now() + shutdownGraceMs;
    if ((threadId === undefined || turnId === undefined) && terminal === undefined) {
      await settleOrDelay(ownedTurnPromise, Math.min(250, remainingAbortGrace()));
    }
    if (threadId !== undefined && turnId !== undefined && terminal === undefined) {
      try {
        await withTimeout(
          sendRequest("turn/interrupt", { threadId, turnId } satisfies TurnInterruptParams),
          Math.floor(remainingAbortGrace() / 4),
          "Codex turn/interrupt acknowledgement timed out.",
        );
      } catch (error) {
        addGap({ kind: "interrupt-acknowledgement", detail: errorMessage(error) });
      }
      if (terminal === undefined) {
        await settleOrDelay(terminalPromise, Math.min(250, Math.floor(remainingAbortGrace() / 4)));
      }
    }
    if (terminal === undefined) await interruptWithinAbortGrace();
  };
  abortAction = abort;
  if (abortRequested) void abort();

  let processResult: ProtocolProcessResult;
  let captureError: string | undefined;
  let threadStart: Record<string, unknown> | undefined;
  try {
    await sendRequest("initialize", {
      clientInfo: { name: "ebo", title: "Engineering Behavior Observatory", version: CODEX_ADAPTER_VERSION },
      capabilities: null,
    });
    await sendNotification("initialized" satisfies ClientNotification["method"]);
    threadStart = await sendRequest("thread/start", {
      model: request.configuration.model,
      cwd: request.workspacePath,
      approvalPolicy: request.configuration.approvalPolicy,
      sandbox: request.configuration.sandbox,
      serviceName: "ebo",
      ephemeral: false,
      config: { model_instructions_file: instructionsPath, mcp_servers: {}, hooks: {}, plugins: {} },
      developerInstructions: "Work only in the supplied workspace. Do not request interactive input or broaden permissions.",
    });
    threadId = text(isRecord(threadStart.thread) ? threadStart.thread.id : undefined);
    if (threadId === undefined) throw new Error("Codex thread/start did not return a thread identity.");
    if (text(threadStart.model) !== request.configuration.model) {
      addGap({ kind: "model-mismatch", detail: `Requested ${request.configuration.model}; launched ${String(threadStart.model)}.` });
    }
    if (text(threadStart.reasoningEffort) !== request.configuration.effort) {
      addGap({ kind: "effort-mismatch", detail: `Requested ${request.configuration.effort}; launched ${String(threadStart.reasoningEffort)}.` });
    }
    if (text(threadStart.modelProvider) !== request.configuration.provider) {
      addGap({ kind: "provider-mismatch", detail: `Requested ${request.configuration.provider}; launched ${String(threadStart.modelProvider)}.` });
    }
    if (threadStart.approvalPolicy !== request.configuration.approvalPolicy) {
      addGap({ kind: "approval-policy-mismatch", detail: `Requested ${request.configuration.approvalPolicy}; applied ${JSON.stringify(threadStart.approvalPolicy)}.` });
    }
    if (!sandboxMatches(request.configuration.sandbox, threadStart.sandbox, request.workspacePath)) {
      addGap({ kind: "sandbox-mismatch", detail: `Requested ${request.configuration.sandbox}; applied ${JSON.stringify(threadStart.sandbox)}.` });
    }
    const started = await sendRequest("turn/start", {
      threadId,
      input: [{ type: "text", text: request.prompt }],
      cwd: request.workspacePath,
      approvalPolicy: request.configuration.approvalPolicy,
      sandboxPolicy: turnSandboxPolicy(request.configuration.sandbox, request.workspacePath),
      model: request.configuration.model,
      effort: request.configuration.effort,
    });
    turnId = text(isRecord(started.turn) ? started.turn.id : undefined);
    if (turnId === undefined) throw new Error("Codex turn/start did not return a turn identity.");
    resolveOwnedTurn?.();
    terminal = await Promise.race([
      terminalPromise,
      protocolProcess.wait().then((result) => {
        throw new Error(`Codex app-server exited before matching turn/completed (${result.status}).`);
      }),
    ]);
    try {
      const historyRequest = sendRequest("thread/read", { threadId, includeTurns: true } satisfies ThreadReadParams);
      // The lifecycle owner starts the same grace window when it aborts us.
      // Spend at most one quarter of what remains on optional history so
      // process teardown and evidence finalization can finish inside it.
      const historyGraceMs = abortDeadline === undefined
        ? shutdownGraceMs
        : Math.max(0, Math.floor((abortDeadline - performance.now()) / 4));
      history = await withAbortAwareTimeout(
        historyRequest,
        historyGraceMs,
        "Persisted history readback timed out.",
        request.signal,
        () => {
          abortDeadline ??= performance.now() + shutdownGraceMs;
          return Math.max(0, Math.floor((abortDeadline - performance.now()) / 4));
        },
      );
      if (!historyMatches(history, threadId, turnId)) {
        addGap({ kind: "history-mismatch", detail: "thread/read history did not contain the owned terminal turn." });
      }
    } catch (error) {
      addGap({ kind: "history-readback", detail: errorMessage(error) });
      if (abortRequested) await interruptWithinAbortGrace();
      else if (errorMessage(error).includes("timed out")) await protocolProcess.interrupt();
    }
  } catch (error) {
    captureError = errorMessage(error);
    addGap({ kind: "capture-error", detail: captureError });
  } finally {
    request.signal?.removeEventListener("abort", abortListener);
    if (abortRequested) await interruptWithinAbortGrace();
    else await protocolProcess.shutdown();
    processResult = await protocolProcess.wait();
    pending.clear();
    await telemetry.close();
    await rm(isolatedCodexHome, { recursive: true, force: true });
  }

  const records = processResult.observations;
  if (processResult.droppedObservations > 0) addGap({
    kind: "normalization-projection-truncated",
    detail: `${processResult.droppedObservations} earlier observations remain authoritative in session.jsonl but are outside the bounded in-memory projection.`,
  });
  const terminalStatus = text(terminal?.status);
  const telemetryEvidence = telemetry.evidence({
    attemptId: request.attemptId,
    executable: request.configuration.executable,
    version: request.configuration.version,
    model: request.configuration.model,
    provider: request.configuration.provider,
    effort: request.configuration.effort,
    approvalPolicy: request.configuration.approvalPolicy,
    sandbox: request.configuration.sandbox,
    workspace: request.workspacePath,
    threadStart,
    records,
    localLoginReference,
    environmentKeys: Object.keys(environment).sort(),
    threadId,
    turnId,
  });
  if (processResult.error !== undefined) {
    addGap({ kind: "process-error", detail: processResult.error });
  }
  return {
    runId: request.runId,
    attemptId: request.attemptId,
    qualification: captureError === undefined && terminalStatus === "completed" && gaps.length === 0
      ? "qualified" : "qualified-with-gaps",
    records: records.map((record) => ({
      reference: { artifactId: "session", recordLocator: `line:${record.sequence}` },
      record,
    })),
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(terminalStatus === "completed" || terminalStatus === "interrupted" || terminalStatus === "failed"
      ? { terminalStatus } : {}),
    ...(terminal === undefined ? {} : { terminal }),
    ...(history === undefined ? {} : { history }),
    process: processResult,
    gaps,
    telemetry: telemetryEvidence,
  };
}

export async function normalizeCodexCapture(
  capture: QualifiedNativeCapture<ProtocolObservation>,
): Promise<NormalizationResult> {
  const events: UniformEvent[] = [];
  const mapped = new Set<number>();
  for (const captured of capture.records) {
    const event = mapCodexRecord(capture, captured);
    if (event === undefined) continue;
    events.push(event);
    mapped.add(captured.record.sequence);
  }
  await validateUniformEvents(events, {
    resolve: (reference) => resolvesCaptureReference(capture, reference),
  });
  return {
    events,
    unmapped: capture.records
      .filter(({ record }) => !mapped.has(record.sequence))
      .map(({ reference }) => ({ reference, reason: "native record has no supported uniform mapping" })),
  };
}

export async function describeAndValidateCodexDataset(
  capture: QualifiedNativeCapture<ProtocolObservation>,
): Promise<{ dataset: NormalizedDataset; coverage: AdapterCoverageReport }> {
  const normalization = await normalizeCodexCapture(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: CODEX_APP_SERVER_CAPABILITIES,
    adapterVersion: CODEX_ADAPTER_VERSION,
    nativeType: codexNativeType,
  });
  const coverage = await validateNormalizedDataset(dataset, createCapturedNativeEvidenceResolver(capture));
  return { dataset, coverage };
}

function mapCodexRecord(
  capture: QualifiedNativeCapture<ProtocolObservation>,
  captured: CapturedNativeRecord<ProtocolObservation>,
): UniformEvent | undefined {
  const record = captured.record;
  const method = record.method;
  if (method === undefined) return undefined;
  const payload = isRecord(record.payload) ? record.payload : {};
  let family: UniformEvent["family"] | undefined;
  let actor: UniformEvent["actor"]["kind"] = "harness";
  let phase: UniformEvent["phase"] = "instant";
  let scope: UniformEvent["scope"] = { kind: "attempt", id: capture.attemptId };
  let contentPath: string | undefined;
  if (record.kind === "request" && record.source === CODEX_HARNESS && isPermissionRequest(method)
      && matchesOwnedScope(capture, payload)) {
    family = "permission";
    actor = "harness";
    phase = "before";
    scope = scopedTurn(payload);
  } else if (record.kind !== "notification") return undefined;
  else if (method === "item/completed") {
    if (!matchesOwnedScope(capture, payload)) return undefined;
    const item = isRecord(payload.item) ? payload.item : {};
    const type = text(item.type);
    family = itemFamily(type);
    if (family === undefined) return undefined;
    actor = family === "message" && type === "userMessage" ? "user"
      : family === "message" ? "agent" : family === "tool" ? "tool" : "agent";
    phase = "after";
    scope = { kind: "turn", id: text(payload.turnId) };
    contentPath = "#/payload/item";
  } else if (method === "turn/completed") {
    const turn = isRecord(payload.turn) ? payload.turn : {};
    if (!matchesOwnedScope(capture, { threadId: payload.threadId, turnId: turn.id })) return undefined;
    family = "outcome";
    actor = "harness";
    phase = "after";
    scope = { kind: "turn", id: text(turn.id) };
    contentPath = "#/payload/turn";
  } else if (method === "turn/plan/updated" || method === "thread/compacted") {
    if (!matchesOwnedScope(capture, payload)) return undefined;
    family = "context";
    actor = "agent";
    scope = scopedTurn(payload);
    contentPath = "#/payload";
  } else if (method === "thread/tokenUsage/updated" || method === "model/rerouted" || method === "hook/completed") {
    if (!matchesOwnedScope(capture, payload, method === "hook/completed")) return undefined;
    family = "runtime";
    scope = scopedTurn(payload);
    contentPath = "#/payload";
  } else return undefined;

  const attributes: Record<string, string | number | boolean | null> = { method };
  if (method === "turn/completed" && isRecord(payload.turn)) copyScalar(attributes, "status", payload.turn.status);
  if (method === "item/completed" && isRecord(payload.item)) {
    copyScalar(attributes, "itemType", payload.item.type);
    copyScalar(attributes, "itemId", payload.item.id);
    copyScalar(attributes, "status", payload.item.status);
    if (payload.item.type === "fileChange") attributes.mutation = true;
  }
  if (method === "thread/tokenUsage/updated" && isRecord(payload.tokenUsage)) {
    const total = numberRecord(payload.tokenUsage.total);
    if (total !== undefined) {
      for (const key of ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const) {
        copyScalar(attributes, key, total[key]);
      }
      attributes.resourceSemantics = "cumulative-snapshot";
    }
  }
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id: `codex:${record.sequence}:${method.replaceAll("/", "-")}`,
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: {
      harness: CODEX_HARNESS,
      nativeType: codexNativeType(record),
      nativeReference: captured.reference,
    },
    nativeOrder: { status: "known", value: record.sequence, domain: "codex-app-server-stdio" },
    nativeTime: nativeTimestamp(method, payload),
    actor: { kind: actor },
    family,
    phase,
    scope,
    relations: {
      parent: { status: "unknown", reason: "Codex native records retain scope IDs but no uniform parent event identity." },
      known: [],
    },
    attributes,
    content: contentPath === undefined
      ? { status: "unknown", reason: "This mapped record has no projected content body." }
      : {
          status: "known",
          value: [{
            nativeReference: {
              artifactId: captured.reference.artifactId,
              recordLocator: `${captured.reference.recordLocator}${contentPath}`,
            },
            mediaType: "application/json",
          }],
        },
  };
}

function codexNativeType(record: ProtocolObservation): string {
  if (record.kind === "request" && record.source === CODEX_HARNESS) return "server-request";
  return record.method ?? record.kind;
}

function captureIdentity(capture: QualifiedNativeCapture<ProtocolObservation>): { threadId?: string; turnId?: string } {
  const value = capture as unknown as Record<string, unknown>;
  const threadId = text(value.threadId);
  const turnId = text(value.turnId);
  return {
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function matchesOwnedScope(
  capture: QualifiedNativeCapture<ProtocolObservation>,
  payload: Record<string, unknown>,
  allowSessionScope = false,
): boolean {
  const owned = captureIdentity(capture);
  if (owned.threadId === undefined || owned.turnId === undefined || text(payload.threadId) !== owned.threadId) return false;
  const recordTurnId = text(payload.turnId);
  return recordTurnId === owned.turnId || allowSessionScope && (payload.turnId === null || payload.turnId === undefined);
}

function itemFamily(type: string | undefined): UniformEvent["family"] | undefined {
  if (type === "userMessage" || type === "agentMessage") return "message";
  if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") return "tool";
  if (type === "fileChange") return "artifact";
  if (type === "collabAgentToolCall") return "delegation";
  return undefined;
}

function nativeTimestamp(method: string, payload: Record<string, unknown>): UniformEvent["nativeTime"] {
  const milliseconds = method === "item/completed" ? payload.completedAtMs : undefined;
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds)) {
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return { status: "known", value: date.toISOString() };
  }
  return milliseconds === undefined
    ? { status: "unknown", reason: "Native record omitted a lifecycle timestamp." }
    : { status: "unknown", reason: "Native lifecycle timestamp is invalid or outside the supported range." };
}

function scopedTurn(payload: Record<string, unknown>): UniformEvent["scope"] {
  return text(payload.turnId) === undefined
    ? { kind: "session", id: text(payload.threadId) }
    : { kind: "turn", id: text(payload.turnId) };
}

function copyScalar(target: Record<string, string | number | boolean | null>, key: string, value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") target[key] = value;
}

function resolvesCaptureReference(
  capture: QualifiedNativeCapture<ProtocolObservation>,
  reference: NativeEvidenceReference,
): boolean {
  return capture.records.some(({ reference: base }) => base.artifactId === reference.artifactId
    && (reference.recordLocator === base.recordLocator || reference.recordLocator.startsWith(`${base.recordLocator}#`)));
}

function responseSourceIdentity(method: string, payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (method === "thread/start") return text(isRecord(payload.thread) ? payload.thread.id : undefined);
  if (method === "turn/start") return text(isRecord(payload.turn) ? payload.turn.threadId : undefined);
  if (method === "thread/read") return text(isRecord(payload.thread) ? payload.thread.id : undefined);
  return undefined;
}

function turnSandboxPolicy(sandbox: CodexSandbox, workspace: string): Record<string, unknown> {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function sandboxMatches(requested: CodexSandbox, applied: unknown, workspace: string): boolean {
  if (!isRecord(applied)) return false;
  if (requested === "danger-full-access") return applied.type === "dangerFullAccess";
  if (requested === "read-only") return applied.type === "readOnly" && applied.networkAccess === false;
  return applied.type === "workspaceWrite"
    && applied.networkAccess === false
    && Array.isArray(applied.writableRoots)
    && applied.writableRoots.length === 1
    && applied.writableRoots[0] === workspace
    && applied.excludeTmpdirEnvVar === true
    && applied.excludeSlashTmp === true;
}

function scopedThreadId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return text(payload.threadId)
    ?? text(isRecord(payload.turn) ? payload.turn.threadId : undefined)
    ?? text(isRecord(payload.thread) ? payload.thread.id : undefined);
}

function isPermissionRequest(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(method);
}

function unattendedServerResponse(method: string): {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
} {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
      || method === "execCommandApproval" || method === "applyPatchApproval") {
    return { result: { decision: "decline" } };
  }
  if (method === "mcpServer/elicitation/request") return { result: { action: "decline", content: null, _meta: null } };
  if (method === "item/tool/call") return { result: { contentItems: [], success: false } };
  if (method === "currentTime/read") return { result: { currentTimeAt: Math.floor(Date.now() / 1_000) } };
  return { error: { code: -32000, message: `EBO unattended policy does not provide ${method}.` } };
}

function historyMatches(history: Record<string, unknown>, threadId: string, turnId: string): boolean {
  const thread = isRecord(history.thread) ? history.thread : undefined;
  if (text(thread?.id) !== threadId || !Array.isArray(thread?.turns)) return false;
  return thread.turns.some((candidate) => isRecord(candidate) && text(candidate.id) === turnId);
}

async function writeProtocolLine(stream: NodeJS.WritableStream, message: unknown): Promise<void> {
  const line = `${JSON.stringify(message)}\n`;
  await new Promise<void>((resolvePromise, reject) => {
    const writable = stream as NodeJS.WritableStream & { write(chunk: string, callback: (error?: Error | null) => void): boolean };
    writable.write(line, (error) => error === undefined || error === null ? resolvePromise() : reject(error));
  });
}

function protocolId(value: unknown): ProtocolIdentity | undefined {
  return typeof value === "string" || typeof value === "number" && Number.isFinite(value) || value === null
    ? value as ProtocolIdentity : undefined;
}

function jsonRpcError(method: string, value: unknown): string {
  const message = isRecord(value) && typeof value.message === "string" ? value.message : JSON.stringify(value);
  return `Codex ${method} failed: ${message}`;
}

type OtlpReceiver = {
  configArgs: string[];
  close(): Promise<void>;
  evidence(input: {
    attemptId: string;
    executable: string;
    version: string;
    model: string;
    provider: "openai";
    effort: CodexReasoningEffort;
    approvalPolicy: CodexApprovalPolicy;
    sandbox: CodexSandbox;
    workspace: string;
    threadStart?: Record<string, unknown>;
    records: readonly ProtocolObservation[];
    localLoginReference: "available" | "unavailable";
    environmentKeys: readonly string[];
    threadId?: string;
    turnId?: string;
  }): CodexTelemetryEvidence;
};

async function openOtlpReceiver(signals: readonly CodexTelemetrySignal[], now = () => new Date().toISOString()): Promise<OtlpReceiver> {
  const enabled = [...new Set(signals)];
  if (enabled.some((signal) => !["logs", "traces", "metrics"].includes(signal))) {
    throw new Error("Codex telemetry contains an unsupported signal.");
  }
  const records: CodexOtlpRecord[] = [];
  const receiverErrors: string[] = [];
  const receiverState = { records, receiverErrors, bytes: 0, inFlightBytes: 0, inFlightRecords: 0 };
  let server: Server | undefined;
  const configArgs: string[] = ["-c", "otel.log_user_prompt=false", "-c", 'otel.environment="ebo"'];
  if (enabled.length === 0) {
    configArgs.push("-c", 'otel.exporter="none"', "-c", 'otel.trace_exporter="none"', "-c", 'otel.metrics_exporter="none"');
  } else {
    server = createServer((incoming, response) => {
      void receiveOtlp(incoming, enabled, receiverState, now).then((status) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end("{}");
      }, () => {
        response.writeHead(400, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolvePromise, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", reject);
        resolvePromise();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Codex OTLP receiver did not bind a TCP port.");
    for (const signal of ["logs", "traces", "metrics"] as const) {
      const field = signal === "logs" ? "exporter" : signal === "traces" ? "trace_exporter" : "metrics_exporter";
      if (!enabled.includes(signal)) configArgs.push("-c", `otel.${field}=\"none\"`);
      else configArgs.push(
        "-c",
        `otel.${field}={ otlp-http = { endpoint = \"http://127.0.0.1:${address.port}/v1/${signal}\", protocol = \"json\" } }`,
      );
    }
  }
  return {
    configArgs,
    close: async () => {
      if (server === undefined) return;
      await new Promise<void>((resolvePromise, reject) => server!.close((error) => error === undefined ? resolvePromise() : reject(error)));
    },
    evidence: (input) => {
      const statuses = Object.fromEntries((["logs", "traces", "metrics"] as const).map((signal) => {
        const count = records.filter((record) => record.signal === signal && record.parseError === undefined && record.payload !== undefined).length;
        return [signal, { status: enabled.includes(signal) ? count > 0 ? "received" : "missing" : "disabled", count }];
      })) as CodexTelemetryEvidence["telemetry"]["receipt"]["signals"];
      const usageUpdates = input.records.flatMap((record) => {
        if (record.kind !== "notification" || record.method !== "thread/tokenUsage/updated" || !isRecord(record.payload)) return [];
        const tokenUsage = isRecord(record.payload.tokenUsage) ? record.payload.tokenUsage : undefined;
        const total = numberRecord(tokenUsage?.total);
        const last = numberRecord(tokenUsage?.last);
        const seenThreadId = text(record.payload.threadId);
        const seenTurnId = text(record.payload.turnId);
        if (total === undefined || last === undefined || seenThreadId === undefined || seenTurnId === undefined) return [];
        if (seenThreadId !== input.threadId || seenTurnId !== input.turnId) return [];
        return [{
          sequence: record.sequence,
          threadId: seenThreadId,
          turnId: seenTurnId,
          total,
          last,
          ...(typeof tokenUsage?.modelContextWindow === "number" ? { modelContextWindow: tokenUsage.modelContextWindow } : {}),
        }];
      });
      return {
        schemaVersion: "ebo.codex-telemetry/v1",
        attemptId: input.attemptId,
        runtime: {
          executable: input.executable,
          version: input.version,
          adapterVersion: CODEX_ADAPTER_VERSION,
          userConfiguration: "isolated",
          localLoginReference: input.localLoginReference,
        },
        effectiveConfiguration: {
          model: input.model,
          provider: input.provider,
          effort: input.effort,
          approvalPolicy: input.approvalPolicy,
          sandbox: input.sandbox,
          workspace: input.workspace,
          environmentKeys: input.environmentKeys,
          ...(input.threadStart === undefined ? {} : { threadStart: input.threadStart }),
        },
        telemetry: {
          receipt: {
            status: enabled.length === 0 ? "not-checked"
              : enabled.every((signal) => statuses[signal].status === "received") ? "received" : "missing",
            signals: statuses,
          },
          records,
          receiverErrors,
        },
        usage: {
          updates: usageUpdates,
          ...(usageUpdates.length === 0 ? {} : {
            final: {
              total: usageUpdates.at(-1)!.total,
              last: usageUpdates.at(-1)!.last,
              ...(usageUpdates.at(-1)!.modelContextWindow === undefined ? {} : {
                modelContextWindow: usageUpdates.at(-1)!.modelContextWindow,
              }),
            },
          }),
        },
      };
    },
  };
}

async function receiveOtlp(
  incoming: IncomingMessage,
  enabled: readonly CodexTelemetrySignal[],
  state: {
    records: CodexOtlpRecord[];
    receiverErrors: string[];
    bytes: number;
    inFlightBytes: number;
    inFlightRecords: number;
  },
  now: () => string,
): Promise<number> {
  const signal = (["logs", "traces", "metrics"] as const).find((candidate) => incoming.url === `/v1/${candidate}`);
  if (incoming.method !== "POST" || signal === undefined || !enabled.includes(signal)) {
    incoming.resume();
    recordReceiverError(state, "Rejected an unconfigured OTLP route or method.");
    return 404;
  }
  if (state.records.length + state.inFlightRecords >= 256) {
    incoming.resume();
    recordReceiverError(state, `Rejected ${signal} after the 256-record receiver limit.`);
    return 429;
  }
  state.inFlightRecords += 1;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of incoming) {
      const value = Buffer.from(chunk as Uint8Array);
      if (bytes + value.length > 4 * 1024 * 1024
          || state.bytes + state.inFlightBytes + value.length > 16 * 1024 * 1024) {
        incoming.destroy();
        recordReceiverError(state, `Rejected oversized ${signal} OTLP evidence.`);
        return 413;
      }
      bytes += value.length;
      state.inFlightBytes += value.length;
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const record: CodexOtlpRecord = {
      signal,
      receivedAt: now(),
      ...(typeof incoming.headers["content-type"] === "string" ? { contentType: incoming.headers["content-type"] } : {}),
    };
    try {
      record.payload = JSON.parse(raw);
    } catch (error) {
      record.raw = raw;
      record.parseError = errorMessage(error);
      recordReceiverError(state, `Rejected malformed ${signal} OTLP JSON.`);
    }
    state.records.push(record);
    state.bytes += bytes;
    return record.parseError === undefined ? 200 : 400;
  } catch (error) {
    recordReceiverError(state, `Failed receiving ${signal} OTLP body: ${errorMessage(error).slice(0, 256)}`);
    return 400;
  } finally {
    state.inFlightRecords -= 1;
    state.inFlightBytes -= bytes;
  }
}

function recordReceiverError(state: { receiverErrors: string[] }, message: string): void {
  if (state.receiverErrors.length < 64) state.receiverErrors.push(message);
  else if (state.receiverErrors.length === 64) state.receiverErrors.push("Additional OTLP receiver errors were truncated.");
}

function recordCaptureGap(gaps: CodexCaptureGap[], gap: CodexCaptureGap): void {
  if (gaps.some((existing) => existing.kind === gap.kind && existing.detail === gap.detail)) return;
  if (gaps.length < 64) gaps.push(gap);
  else if (!gaps.some(({ kind }) => kind === "capture-gap-limit")) {
    gaps.push({ kind: "capture-gap-limit", detail: "Additional capture gaps remain in native session evidence." });
  }
}

function numberRecord(value: unknown): Partial<TokenUsageBreakdown> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "number" || !Number.isFinite(item))) return undefined;
  return Object.fromEntries(entries) as Partial<TokenUsageBreakdown>;
}

function isolatedEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CODEX_HOME: codexHome, HOME: codexHome };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR", "USER", "LOGNAME", "SHELL"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, milliseconds));
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withAbortAwareTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  signal: AbortSignal | undefined,
  abortTimeoutMs: () => number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let rejectTimeout: ((error: Error) => void) | undefined;
  const schedule = (delay: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => rejectTimeout?.(new Error(message)), Math.max(0, delay));
  };
  const onAbort = (): void => schedule(abortTimeoutMs());
  const timedOut = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    schedule(milliseconds);
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleOrDelay(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined),
      new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, Math.max(0, milliseconds)); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireText(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} is required.`);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
