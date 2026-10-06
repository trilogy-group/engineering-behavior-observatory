import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { digestBytes, digestMetadata } from "./artifacts.js";
import {
  createCapturedNativeEvidenceResolver,
  describeNormalizedDataset,
  validateNormalizedDataset,
  type AdapterCoverageReport,
  type NormalizedDataset,
} from "./normalization-integrity.js";
import { decodeOtlpProtobuf } from "./otlp-protobuf.js";
import {
  spawnProtocolProcess,
  type ProtocolIdentity,
  type ProtocolObservation,
  type ProtocolProcess,
  type ProtocolProcessResult, writeProtocolLine } from "./process-protocol.js";
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

export const DEVIN_CLI_VERSION = "3000.11.3";
/** Every Devin CLI pin whose retained captures this adapter still reads. */
export const RETAINED_DEVIN_CLI_VERSIONS: readonly string[] = [DEVIN_CLI_VERSION];
export const DEVIN_ADAPTER_VERSION = "0.1.0";
export const DEVIN_HARNESS = "devin-cli";
export const DEVIN_DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
export const DEVIN_DEFAULT_CREDENTIAL_ENV = "WINDSURF_API_KEY";
const DEVIN_CLIENT = "ebo-devin-client";
const ACP_PROTOCOL_VERSION = 1;
const PROMPT_USAGE_FIELDS = ["totalTokens", "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens"] as const;
const PERMISSION_REQUEST = "session/request_permission";
const AGENT_STOPPED = "_cognition.ai/agent_stopped";
const OTLP_EXPORT_INTERVAL_MS = 500;

/** Native ACP session modes exposed by `devin acp`; `bypass` auto-approves every tool. */
export type DevinSessionMode = "accept-edits" | "smart" | "bypass" | "plan" | "ask";
/** Unattended answer to every native `session/request_permission`. */
export type DevinPermissionDecision = "allow-once" | "reject-once";
export type DevinTelemetrySignal = "logs" | "metrics";

export type DevinCliConfiguration = {
  executable: string;
  version: typeof DEVIN_CLI_VERSION;
  /** Native model slug as listed by the ACP `model` config option, e.g. `swe-2-high`. */
  model: string;
  mode: DevinSessionMode;
  permissionDecision: DevinPermissionDecision;
  /** Environment variable copied into the isolated child for ACP authentication; defaults to WINDSURF_API_KEY. */
  credentialEnv?: string;
  /** Extra arguments after `acp`, e.g. `["--agent-type", "review"]`. */
  acpArgs?: readonly string[];
  /** Test-only executable prefix; production uses the pinned executable directly. */
  executableArgs?: readonly string[];
  telemetry?: { signals: readonly DevinTelemetrySignal[] };
};

export type DevinOtlpRecord = {
  signal: DevinTelemetrySignal;
  receivedAt: string;
  contentType?: string;
  sizeBytes: number;
  /** The original request body (base64) within the receiver bounds, retained even when it cannot be decoded. */
  body: string;
  bodyDigest: string;
  /** The OTLP/JSON projection of `body`; absent when decoding failed. */
  payload?: unknown;
  parseError?: string;
};

export type DevinUsageUpdate = {
  sequence: number;
  sessionId: string;
  used: number;
  size?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
};

export type DevinTelemetryEvidence = {
  schemaVersion: "ebo.devin-telemetry/v1";
  attemptId: string;
  runtime: {
    executable: string;
    version: string;
    adapterVersion: string;
    userConfiguration: "isolated";
    credentialEnv: string;
    agentInfo?: Record<string, unknown>;
    agentCapabilities?: Record<string, unknown>;
  };
  effectiveConfiguration: {
    model: string;
    mode: DevinSessionMode;
    permissionDecision: DevinPermissionDecision;
    workspace: string;
    environmentKeys: readonly string[];
    appliedModel?: string;
    appliedMode?: string;
  };
  telemetry: {
    receipt: {
      status: "received" | "missing" | "not-checked";
      signals: Record<DevinTelemetrySignal, { status: "received" | "missing" | "disabled"; count: number }>;
    };
    records: readonly DevinOtlpRecord[];
    receiverErrors: readonly string[];
  };
  usage: {
    updates: readonly DevinUsageUpdate[];
    /** The native `session/prompt` response usage; Devin reports the final request, not a turn total. */
    final?: Record<string, number>;
    /** Native `_cognition.ai/agent_stopped` statistics, retained unchanged. */
    agentStopped?: Record<string, unknown>;
  };
};

export type DevinCaptureGap = { kind: string; detail: string };

export type DevinCliCaptureRequest = {
  runId: string;
  attemptId: string;
  workspacePath: string;
  prompt: string;
  configuration: DevinCliConfiguration;
  evidencePath: string;
  stderrPath?: string;
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  maxLineBytes?: number;
  maxInMemoryObservations?: number;
  now?: () => string;
  registerShutdown?: (shutdown: () => Promise<void>) => void;
};

export type DevinCliCapture = QualifiedNativeCapture<ProtocolObservation> & {
  sessionId?: string;
  promptRequestId?: number;
  terminalStatus?: "completed" | "interrupted" | "failed";
  /** The native `session/prompt` result (`stopReason`, `usage`, `_meta`) or its JSON-RPC error. */
  terminal?: Record<string, unknown>;
  process: ProtocolProcessResult;
  gaps: readonly DevinCaptureGap[];
  telemetry: DevinTelemetryEvidence;
};

export const DEVIN_CLI_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: `ebo-devin-cli-v${DEVIN_CLI_VERSION}`,
  harness: DEVIN_HARNESS,
  nativeTypes: [
    "session/update:agent_message_chunk",
    "session/update:user_message_chunk",
    "session/update:tool_call",
    "session/update:tool_call_update",
    "session/update:usage_update",
    "session/update:plan",
    AGENT_STOPPED,
    "server-request",
    "session/prompt:response",
  ],
  families: {
    message: { status: "partial", detail: "ACP emits message chunks without a completed-message record; each chunk is projected." },
    "model-request": { status: "unsupported", detail: "Inference requests are not inferred from ACP updates; OTLP api_request records stay telemetry evidence." },
    tool: { status: "partial", detail: "tool_call starts and completed/failed tool_call_update records are projected; progress updates stay native." },
    context: { status: "partial", detail: "ACP plan updates are projected when emitted." },
    permission: { status: "partial", detail: "session/request_permission requests are projected; the unattended decision stays a native response record." },
    delegation: { status: "unsupported", detail: "Subagent context appears only in usage metadata; no native child session identity is exposed over ACP." },
    artifact: { status: "unsupported", detail: "ACP tool calls do not report completed file changes; workspace outcome is packaged separately." },
    validation: { status: "unsupported", detail: "Verifier evidence is packaged outside the Devin native normalizer." },
    runtime: { status: "partial", detail: "usage_update context snapshots and agent_stopped turn statistics are projected with native values only." },
    outcome: { status: "available", detail: "The matching session/prompt response stopReason is authoritative for turn outcome." },
  },
  evidence: {
    nativeOrder: { status: "available", detail: "The retained receive/write sequence is one stdio ordering domain." },
    nativeTime: { status: "partial", detail: "ACP frames carry no native timestamps; events use EBO observation time labeled nativeTimeSource capture-receipt. OTLP log timestamps stay in telemetry evidence." },
    parentage: { status: "partial", detail: "Terminal tool_call_update events reference their tool_call event; other relations remain source-specific." },
    content: { status: "partial", detail: "Mapped content references retained native payloads without copying bodies." },
  },
} as const satisfies AdapterCapabilityProfile;

export function createDevinHarnessAdapter(): HarnessAdapter<DevinCliCaptureRequest, ProtocolObservation> {
  return {
    capture: { id: DEVIN_CLI_CAPABILITIES.adapterId, harness: DEVIN_HARNESS, capture: captureDevinCli },
    normalization: {
      id: DEVIN_CLI_CAPABILITIES.adapterId,
      harness: DEVIN_HARNESS,
      capabilityProfile: DEVIN_CLI_CAPABILITIES,
      normalize: normalizeDevinCapture,
    },
  };
}

/**
 * Own one `devin acp` child over stdio for a single prompt. Every JSON-RPC
 * frame in both directions appends to the evidence JSONL before any
 * normalization. Only the `session/prompt` response for the owned session ends
 * the native attempt; process exit alone never does.
 */
export async function captureDevinCli(request: DevinCliCaptureRequest): Promise<DevinCliCapture> {
  requireText(request.runId, "Run ID");
  requireText(request.attemptId, "Attempt ID");
  requireText(request.workspacePath, "Workspace path");
  requireText(request.prompt, "Prompt");
  requireText(request.configuration.executable, "Devin executable");
  requireText(request.configuration.model, "Devin model");
  if (request.configuration.version !== DEVIN_CLI_VERSION) {
    throw new Error(`Devin CLI ${DEVIN_CLI_VERSION} is required; configuration declares ${String(request.configuration.version)}.`);
  }
  if (!["accept-edits", "smart", "bypass", "plan", "ask"].includes(request.configuration.mode)) throw new Error("Devin session mode is invalid.");
  if (!["allow-once", "reject-once"].includes(request.configuration.permissionDecision)) throw new Error("Devin permission decision is invalid.");
  const shutdownGraceMs = request.shutdownGraceMs ?? DEVIN_DEFAULT_SHUTDOWN_GRACE_MS;
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 0) throw new Error("Shutdown grace must be a nonnegative integer.");
  const credentialEnv = request.configuration.credentialEnv ?? DEVIN_DEFAULT_CREDENTIAL_ENV;
  // Validate the credential before any receiver or temporary home exists so a missing key cannot leak resources.
  const credential = requireCredential(credentialEnv);

  let abortRequested = request.signal?.aborted ?? false;
  let abortDeadline: number | undefined;
  let abortAction: (() => Promise<void>) | undefined;
  const abortListener = (): void => {
    abortRequested = true;
    void abortAction?.();
  };
  request.signal?.addEventListener("abort", abortListener, { once: true });

  const telemetry = await openOtlpReceiver(request.configuration.telemetry?.signals ?? [], request.now).catch((error: unknown) => {
    request.signal?.removeEventListener("abort", abortListener);
    throw error;
  });
  let isolatedHome: string;
  try {
    isolatedHome = await mkdtemp(join(tmpdir(), "ebo-devin-home-"));
    const configDirectory = join(isolatedHome, "config", "devin");
    await mkdir(configDirectory, { recursive: true });
    for (const name of ["data", "cache", "state"]) await mkdir(join(isolatedHome, name), { recursive: true });
    await writeFile(join(configDirectory, "config.json"), `${JSON.stringify(telemetry.userConfiguration(request.attemptId))}\n`, { mode: 0o600 });
  } catch (error) {
    request.signal?.removeEventListener("abort", abortListener);
    await telemetry.close();
    throw error;
  }
  const environment = isolatedEnvironment(isolatedHome, credentialEnv, credential);
  const gaps: DevinCaptureGap[] = [];
  const addGap = (gap: DevinCaptureGap): void => recordCaptureGap(gaps, gap);
  let sessionId: string | undefined;
  let promptRequestId: number | undefined;
  let terminal: Record<string, unknown> | undefined;
  let currentModeId: string | undefined;
  let currentModel: string | undefined;
  let agentInfo: Record<string, unknown> | undefined;
  let agentCapabilities: Record<string, unknown> | undefined;
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
  const terminalPromise = new Promise<Record<string, unknown>>((resolvePromise) => {
    resolveTerminal = resolvePromise;
  });
  let protocolProcess: ProtocolProcess;
  const stderrDecoder = new TextDecoder("utf-8");
  try {
    protocolProcess = spawnProtocolProcess({
      command: request.configuration.executable,
      args: [...(request.configuration.executableArgs ?? []), "acp", ...(request.configuration.acpArgs ?? [])],
      cwd: request.workspacePath,
      env: environment,
      source: DEVIN_HARNESS,
      evidencePath: request.evidencePath,
      ...(request.stderrPath === undefined ? {} : { stderrPath: request.stderrPath }),
      ...(request.maxLineBytes === undefined ? {} : { maxLineBytes: request.maxLineBytes }),
      ...(request.maxInMemoryObservations === undefined ? {} : { maxInMemoryObservations: request.maxInMemoryObservations }),
      shutdownGraceMs,
      ...(request.now === undefined ? {} : { now: request.now }),
      onStderr: async (chunk, final, recorder) => {
        const diagnostic = stderrDecoder.decode(chunk, { stream: !final });
        if (diagnostic !== "") {
          await recorder.recordNotification({ source: DEVIN_HARNESS, method: "diagnostic/stderr", payload: { text: diagnostic } });
        }
      },
      onFrame: async (payload, recorder) => {
        if (!isRecord(payload)) return;
        const id = protocolId(payload.id);
        const method = text(payload.method);
        if (method !== undefined && id !== undefined) {
          const params = isRecord(payload.params) ? payload.params : {};
          const sourceIdentity = text(params.sessionId);
          await recorder.recordRequest({
            source: DEVIN_HARNESS,
            method,
            id,
            ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
            payload: payload.params ?? null,
          });
          const answer = unattendedClientResponse(method, params, request.configuration.permissionDecision, sessionId);
          if (answer.gap !== undefined) addGap(answer.gap);
          await recorder.recordResponse({
            source: DEVIN_CLIENT,
            method,
            id,
            ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
            payload: answer.error === undefined ? answer.result : { error: answer.error },
          });
          await writeProtocolLine(protocolProcess.stdin, answer.error === undefined
            ? { jsonrpc: "2.0", id, result: answer.result }
            : { jsonrpc: "2.0", id, error: answer.error });
          return;
        }
        if (id !== undefined && method === undefined) {
          const waiter = pending.get(id);
          const responseMethod = waiter?.method ?? "unknown-response";
          const responsePayload = payload.error === undefined ? payload.result : { error: payload.error };
          const sourceIdentity = responseMethod === "session/new" && isRecord(responsePayload) ? text(responsePayload.sessionId) : sessionId;
          await recorder.recordResponse({
            source: DEVIN_HARNESS,
            method: responseMethod,
            id,
            ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
            payload: responsePayload ?? null,
          });
          if (id === promptRequestId && terminal === undefined) {
            terminal = isRecord(responsePayload) ? structuredClone(responsePayload) : { result: responsePayload ?? null };
            await recorder.recordCompletion({
              source: DEVIN_HARNESS,
              method: "session/prompt",
              ...(sessionId === undefined ? {} : { sourceIdentity: sessionId }),
              status: payload.error === undefined ? text(terminal.stopReason) ?? "unknown" : "error",
              evidence: terminal,
            });
            resolveTerminal?.(terminal);
          }
          if (waiter !== undefined) {
            pending.delete(id);
            if (payload.error !== undefined) waiter.reject(new Error(jsonRpcError(responseMethod, payload.error)));
            else if (isRecord(payload.result)) waiter.resolve(payload.result);
            else waiter.reject(new Error(`Devin ${responseMethod} returned a non-object result.`));
          }
          return;
        }
        if (method === undefined || id !== undefined) return;
        const params = isRecord(payload.params) ? payload.params : {};
        const sourceIdentity = text(params.sessionId) ?? sessionId;
        await recorder.recordNotification({
          source: DEVIN_HARNESS,
          method,
          ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
          payload: params,
        });
        if (method === "session/update" && isRecord(params.update) && (sessionId === undefined || params.sessionId === sessionId)) {
          const update = params.update;
          if (update.sessionUpdate === "current_mode_update") currentModeId = text(update.currentModeId) ?? currentModeId;
          if (update.sessionUpdate === "config_option_update") currentModel = configuredModel(update.configOptions) ?? currentModel;
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
    await rm(isolatedHome, { recursive: true, force: true });
    throw error;
  }

  const sendRequest = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextRequestId++;
    if (method === "session/prompt") promptRequestId = id;
    await protocolProcess.evidence.recordRequest({
      source: DEVIN_CLIENT,
      method,
      id,
      ...(sessionId === undefined ? {} : { sourceIdentity: sessionId }),
      payload: params,
    });
    const response = new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      pending.set(id, { method, resolve: resolvePromise, reject });
    });
    await writeProtocolLine(protocolProcess.stdin, { jsonrpc: "2.0", id, method, params });
    return Promise.race([
      response,
      protocolProcess.wait().then((result) => {
        throw new Error(`Devin acp exited before ${method} completed (${result.status}).`);
      }),
    ]);
  };
  const sendNotification = async (method: string, params: Record<string, unknown>): Promise<void> => {
    await protocolProcess.evidence.recordNotification({
      source: DEVIN_CLIENT,
      method,
      ...(sessionId === undefined ? {} : { sourceIdentity: sessionId }),
      payload: params,
    });
    await writeProtocolLine(protocolProcess.stdin, { jsonrpc: "2.0", method, params });
  };

  const abort = async (): Promise<void> => {
    abortRequested = true;
    abortDeadline ??= performance.now() + shutdownGraceMs;
    if (sessionId !== undefined && promptRequestId !== undefined && terminal === undefined) {
      try {
        await sendNotification("session/cancel", { sessionId });
      } catch (error) {
        addGap({ kind: "interrupt-delivery", detail: errorMessage(error) });
      }
      // ACP answers a cancelled prompt with stopReason "cancelled"; wait for that native terminal before tearing down.
      if (terminal === undefined) await settleOrDelay(terminalPromise, Math.floor(remainingAbortGrace() / 2));
    }
    if (terminal === undefined) await interruptWithinAbortGrace();
  };
  abortAction = abort;
  if (abortRequested) void abort();

  let processResult: ProtocolProcessResult;
  let captureError: string | undefined;
  try {
    const initialized = await sendRequest("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "ebo", title: "Engineering Behavior Observatory", version: DEVIN_ADAPTER_VERSION },
    });
    if (isRecord(initialized.agentInfo)) agentInfo = structuredClone(initialized.agentInfo);
    if (isRecord(initialized.agentCapabilities)) agentCapabilities = structuredClone(initialized.agentCapabilities);
    if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
      addGap({ kind: "protocol-version-mismatch", detail: `Requested ACP ${ACP_PROTOCOL_VERSION}; agent answered ${String(initialized.protocolVersion)}.` });
    }
    const session = await sendRequest("session/new", { cwd: request.workspacePath, mcpServers: [] });
    sessionId = text(session.sessionId);
    if (sessionId === undefined) throw new Error("Devin session/new did not return a session identity.");
    currentModeId = text(isRecord(session.modes) ? session.modes.currentModeId : undefined) ?? currentModeId;
    currentModel = configuredModel(session.configOptions) ?? currentModel;
    if (currentModeId !== request.configuration.mode) {
      await sendRequest("session/set_mode", { sessionId, modeId: request.configuration.mode });
      if (currentModeId !== request.configuration.mode) {
        addGap({ kind: "mode-mismatch", detail: `Requested ${request.configuration.mode}; applied ${String(currentModeId)}.` });
      }
    }
    if (currentModel !== request.configuration.model) {
      const applied = await sendRequest("session/set_config_option", { sessionId, configId: "model", value: request.configuration.model });
      currentModel = configuredModel(applied.configOptions) ?? currentModel;
      if (currentModel !== request.configuration.model) {
        addGap({ kind: "model-mismatch", detail: `Requested ${request.configuration.model}; applied ${String(currentModel)}.` });
      }
    }
    try {
      await sendRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: request.prompt }] });
    } catch (error) {
      // A JSON-RPC error for the owned prompt is terminal evidence, recorded by the frame handler.
      if (terminal === undefined) throw error;
    }
    // Let the child observe end-of-input and flush its exporters before any signal.
    await new Promise<void>((resolvePromise) => protocolProcess.stdin.end(resolvePromise));
    await settleOrDelay(protocolProcess.wait(), Math.min(remainingAbortGrace(), telemetry.enabled ? OTLP_EXPORT_INTERVAL_MS * 3 : 250));
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
    await rm(isolatedHome, { recursive: true, force: true });
  }

  const records = processResult.observations;
  if (processResult.droppedObservations > 0) addGap({
    kind: "normalization-projection-truncated",
    detail: `${processResult.droppedObservations} earlier observations remain authoritative in session.jsonl but are outside the bounded in-memory projection.`,
  });
  const stopReason = text(terminal?.stopReason);
  const terminalStatus: DevinCliCapture["terminalStatus"] | undefined = terminal === undefined ? undefined
    : stopReason === "end_turn" ? "completed"
      : stopReason === "cancelled" && abortRequested ? "interrupted"
        : "failed";
  if (terminal !== undefined && terminalStatus === "failed") {
    addGap({ kind: "terminal-stop-reason", detail: stopReason === undefined ? `Devin session/prompt failed: ${JSON.stringify(terminal.error ?? terminal)}` : `Devin stopped with ${stopReason}.` });
  }
  const agentStopped = records.find((record) => record.kind === "notification" && record.method === AGENT_STOPPED
    && isRecord(record.payload) && record.payload.sessionId === sessionId);
  if (terminal !== undefined && agentStopped === undefined) addGap({ kind: "agent-stopped-missing", detail: "Devin did not emit _cognition.ai/agent_stopped for the owned session." });
  if (processResult.error !== undefined) addGap({ kind: "process-error", detail: processResult.error });
  const telemetryEvidence = telemetry.evidence({
    attemptId: request.attemptId,
    executable: request.configuration.executable,
    version: request.configuration.version,
    credentialEnv,
    model: request.configuration.model,
    mode: request.configuration.mode,
    permissionDecision: request.configuration.permissionDecision,
    workspace: request.workspacePath,
    environmentKeys: Object.keys(environment).sort(),
    records,
    sessionId,
    terminal,
    agentInfo,
    agentCapabilities,
    appliedModel: currentModel,
    appliedMode: currentModeId,
    agentStopped: isRecord(agentStopped?.payload) && isRecord(agentStopped.payload.stats) ? agentStopped.payload.stats : undefined,
  });
  return {
    runId: request.runId,
    attemptId: request.attemptId,
    qualification: captureError === undefined && terminalStatus === "completed" && gaps.length === 0 ? "qualified" : "qualified-with-gaps",
    records: records.map((record) => ({
      reference: { artifactId: "session", recordLocator: `line:${record.sequence}` },
      record,
    })),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(promptRequestId === undefined ? {} : { promptRequestId }),
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
    ...(terminal === undefined ? {} : { terminal }),
    process: processResult,
    gaps,
    telemetry: telemetryEvidence,
  };
}

export async function normalizeDevinCapture(
  capture: QualifiedNativeCapture<ProtocolObservation>,
): Promise<NormalizationResult> {
  const events: UniformEvent[] = [];
  const mapped = new Set<number>();
  const toolCalls: DevinToolCallState = { events: new Map(), terminalExits: new Map() };
  for (const captured of capture.records) {
    const event = mapDevinRecord(capture, captured, toolCalls);
    if (event === undefined) continue;
    events.push(event);
    mapped.add(captured.record.sequence);
  }
  await validateUniformEvents(events, { resolve: (reference) => resolvesCaptureReference(capture, reference) });
  return {
    events,
    unmapped: capture.records
      .filter(({ record }) => !mapped.has(record.sequence))
      .map(({ reference }) => ({ reference, reason: "native record has no supported uniform mapping" })),
  };
}

export async function describeAndValidateDevinDataset(
  capture: QualifiedNativeCapture<ProtocolObservation>,
  runtimeVersion = (capture as Partial<DevinCliCapture>).telemetry?.runtime?.version ?? DEVIN_CLI_VERSION,
): Promise<{ dataset: NormalizedDataset; coverage: AdapterCoverageReport }> {
  if (!RETAINED_DEVIN_CLI_VERSIONS.includes(runtimeVersion)) throw new Error(`Unsupported retained Devin runtime ${runtimeVersion}.`);
  const normalization = await normalizeDevinCapture(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: DEVIN_CLI_CAPABILITIES,
    adapterVersion: DEVIN_ADAPTER_VERSION,
    nativeType: devinNativeType,
  });
  const coverage = await validateNormalizedDataset(dataset, createCapturedNativeEvidenceResolver(capture));
  return { dataset, coverage };
}

export type RetainedDevinCapture = QualifiedNativeCapture<ProtocolObservation> & { sessionId?: string; promptRequestId?: number };

/**
 * Re-establishes the owned ACP identities of a retained Devin bundle before normalization. The ACP `initialize`
 * handshake reports a placeholder `agentInfo.version`, so the runtime version is verified through the retained
 * telemetry document and the manifest runtime pins rather than the handshake.
 */
export function qualifyRetainedDevinCapture(
  capture: QualifiedNativeCapture<ProtocolObservation>,
  options: { sessionId: string | undefined; expectsCompletion: boolean; harnessVersion: string; runtimeVersions: readonly string[] },
): RetainedDevinCapture {
  if (!RETAINED_DEVIN_CLI_VERSIONS.includes(options.harnessVersion)) throw new Error(`Unsupported retained Devin runtime ${options.harnessVersion}.`);
  if (options.runtimeVersions.length === 0 || options.runtimeVersions.some((version) => version !== options.harnessVersion)) {
    throw new Error("Retained Devin native runtime version differs from the run manifest.");
  }
  const records = capture.records.map(({ record }) => record);
  for (const record of records) {
    if (record.source !== DEVIN_HARNESS && record.source !== DEVIN_CLIENT) throw new Error(`Retained Devin capture contains a foreign source ${record.source}.`);
  }
  let acceptedSequence = 0;
  const owned = (method: string, required: boolean): { request: ProtocolObservation; response?: ProtocolObservation } | undefined => {
    const sent = records.filter((record) => record.kind === "request" && record.source === DEVIN_CLIENT && record.method === method);
    if (sent.length > 1 || required && sent.length !== 1) throw new Error(`Retained Devin ${method} requires one owned request.`);
    const request = sent[0];
    if (request === undefined) return undefined;
    const responses = records.filter((record) => record.kind === "response" && record.source === DEVIN_HARNESS && record.id === request.id);
    if (request.id === undefined || request.id === null || request.sequence <= acceptedSequence || responses.length > 1
      || responses.some((response) => response.sequence <= request.sequence)) {
      throw new Error(`Retained Devin ${method} requires a unique ordered owned request/response pair.`);
    }
    acceptedSequence = responses[0]?.sequence ?? request.sequence;
    return { request, ...(responses[0] === undefined ? {} : { response: responses[0] }) };
  };
  owned("initialize", options.expectsCompletion);
  const session = owned("session/new", options.expectsCompletion);
  const sessionResult = session?.response?.payload;
  const sessionId = isRecord(sessionResult) && sessionResult.error === undefined ? text(sessionResult.sessionId) : undefined;
  if (sessionId !== options.sessionId) throw new Error("Retained Devin session identity differs from the run manifest.");
  const prompt = owned("session/prompt", options.expectsCompletion);
  if (prompt !== undefined && (sessionId === undefined || !isRecord(prompt.request.payload) || prompt.request.payload.sessionId !== sessionId
    || typeof prompt.request.id !== "number")) {
    throw new Error("Retained Devin session/prompt is not bound to the owned session.");
  }
  for (const record of records) {
    const payload = isRecord(record.payload) ? record.payload : {};
    if (record.sourceIdentity !== undefined && record.sourceIdentity !== sessionId
      || record.kind === "notification" && record.method === "session/update" && payload.sessionId !== sessionId) {
      throw new Error("Retained Devin stream identity differs from the owned session.");
    }
  }
  const completions = records.filter((record) => record.kind === "completion" && record.source === DEVIN_HARNESS && record.method === "session/prompt");
  if (completions.length > 1 || completions.length === 1 && (prompt?.response === undefined || completions[0]!.sequence <= prompt.response.sequence)) {
    throw new Error("Retained Devin capture requires unambiguous matching owned terminal evidence.");
  }
  if (options.expectsCompletion) {
    const result = prompt?.response?.payload;
    if (!isRecord(result) || result.error !== undefined || result.stopReason !== "end_turn" || completions[0]?.status !== "end_turn") {
      throw new Error("Completed retained Devin capture lacks matching owned end_turn terminal evidence.");
    }
  }
  return {
    ...capture,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(prompt === undefined ? {} : { promptRequestId: prompt.request.id as number }),
  };
}

type DevinToolCallState = {
  events: Map<string, string>;
  terminalExits: Map<string, Record<string, unknown>>;
};

function mapDevinRecord(
  capture: QualifiedNativeCapture<ProtocolObservation>,
  captured: CapturedNativeRecord<ProtocolObservation>,
  toolCalls: DevinToolCallState,
): UniformEvent | undefined {
  const record = captured.record;
  const owned = captureIdentity(capture);
  if (owned.sessionId === undefined || record.method === undefined) return undefined;
  const payload = isRecord(record.payload) ? record.payload : {};
  const attributes: Record<string, string | number | boolean | null> = { method: record.method };
  let family: UniformEvent["family"];
  let actor: UniformEvent["actor"]["kind"] = "harness";
  let phase: UniformEvent["phase"] = "instant";
  let contentPath: string;
  let parent: string | undefined;
  let label = record.method.replaceAll("/", "-");
  if (record.kind === "request" && record.source === DEVIN_HARNESS && record.method === PERMISSION_REQUEST) {
    if (text(payload.sessionId) !== owned.sessionId) return undefined;
    family = "permission";
    phase = "before";
    contentPath = "#/payload";
    if (isRecord(payload.toolCall)) copyScalar(attributes, "toolCallId", payload.toolCall.toolCallId);
    if (Array.isArray(payload.options)) attributes.optionCount = payload.options.length;
  } else if (record.kind === "response" && record.source === DEVIN_HARNESS && record.method === "session/prompt") {
    if (owned.promptRequestId === undefined || record.id !== owned.promptRequestId) return undefined;
    family = "outcome";
    phase = "after";
    contentPath = "#/payload";
    label = "session-prompt-response";
    copyScalar(attributes, "stopReason", payload.stopReason);
    if (isRecord(payload.error)) {
      attributes.error = true;
      copyScalar(attributes, "errorCode", payload.error.code);
    }
    if (isRecord(payload.usage)) {
      for (const key of PROMPT_USAGE_FIELDS) copyScalar(attributes, key, payload.usage[key]);
      // Devin reports the final request's usage here; cumulative turn totals live only in `agent_stopped` stats.
      attributes.usageSemantics = "final-request";
    }
  } else if (record.kind === "notification" && record.source === DEVIN_HARNESS && text(payload.sessionId) === owned.sessionId) {
    if (record.method === "session/update") {
      const update = isRecord(payload.update) ? payload.update : {};
      const type = text(update.sessionUpdate);
      if (type === undefined) return undefined;
      label = type;
      attributes.sessionUpdate = type;
      const meta = isRecord(update._meta) ? update._meta : {};
      if (type === "agent_message_chunk" || type === "user_message_chunk") {
        family = "message";
        actor = type === "user_message_chunk" ? "user" : "agent";
        contentPath = "#/payload/update/content";
      } else if (type === "plan") {
        family = "context";
        actor = "agent";
        contentPath = "#/payload/update";
      } else if (type === "tool_call") {
        family = "tool";
        actor = "agent";
        phase = "before";
        contentPath = "#/payload/update";
        copyScalar(attributes, "toolCallId", update.toolCallId);
        copyScalar(attributes, "kind", update.kind);
        copyScalar(attributes, "title", update.title);
        copyScalar(attributes, "toolName", meta["cognition.ai/inferenceToolName"]);
        if (update.rawInput !== undefined) attributes.inputDigest = `sha256:${digestMetadata(update.rawInput).value}`;
      } else if (type === "tool_call_update") {
        const status = text(update.status);
        const toolCallId = text(update.toolCallId);
        if (toolCallId !== undefined && isRecord(meta.terminal_exit)) toolCalls.terminalExits.set(toolCallId, meta.terminal_exit);
        if (status !== "completed" && status !== "failed") return undefined;
        family = "tool";
        actor = "tool";
        phase = "after";
        contentPath = "#/payload/update";
        attributes.status = status;
        copyScalar(attributes, "toolCallId", update.toolCallId);
        copyScalar(attributes, "toolName", meta["cognition.ai/inferenceToolName"]);
        if (meta["cognition.ai/canceled"] === true) attributes.canceled = true;
        const terminalExit = isRecord(meta.terminal_exit)
          ? meta.terminal_exit
          : toolCallId === undefined
            ? undefined
            : toolCalls.terminalExits.get(toolCallId);
        if (terminalExit !== undefined) {
          copyScalar(attributes, "exitCode", terminalExit.exit_code);
          copyScalar(attributes, "signal", terminalExit.signal);
        }
        if (toolCallId !== undefined) parent = toolCalls.events.get(toolCallId);
      } else if (type === "usage_update") {
        family = "runtime";
        contentPath = "#/payload/update";
        copyScalar(attributes, "used", update.used);
        copyScalar(attributes, "size", update.size);
        copyScalar(attributes, "inputTokens", meta["cognition.ai/inputTokens"]);
        copyScalar(attributes, "outputTokens", meta["cognition.ai/outputTokens"]);
        copyScalar(attributes, "cachedReadTokens", meta["cognition.ai/cachedReadTokens"]);
        // A native context-window snapshot for one request, not a turn total: no resourceSemantics claim.
        attributes.usageSemantics = "request-context-snapshot";
      } else return undefined;
    } else if (record.method === AGENT_STOPPED) {
      family = "runtime";
      contentPath = "#/payload";
      copyScalar(attributes, "cause", payload.cause);
      const stats = isRecord(payload.stats) ? payload.stats : {};
      for (const key of ["modelLabel", "toolCalls", "filesChanged", "commandsRun", "ttftMs", "totalTimeMs"] as const) copyScalar(attributes, key, stats[key]);
      const cumulative = cumulativeTokenDimensions(stats.responseDimensions);
      if (cumulative !== undefined) {
        Object.assign(attributes, cumulative);
        attributes.resourceSemantics = "cumulative-final";
      }
    } else return undefined;
  } else return undefined;

  const nativeTime = observationTime(record.observedAt);
  if (nativeTime !== undefined) attributes.nativeTimeSource = "capture-receipt";
  const id = `devin:${record.sequence}:${label}`;
  if (label === "tool_call") {
    const toolCallId = text(attributes.toolCallId);
    if (toolCallId !== undefined && !toolCalls.events.has(toolCallId)) toolCalls.events.set(toolCallId, id);
  }
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id,
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: { harness: DEVIN_HARNESS, nativeType: devinNativeType(record), nativeReference: captured.reference },
    nativeOrder: { status: "known", value: record.sequence, domain: "devin-acp-stdio" },
    nativeTime: nativeTime ?? { status: "unknown", reason: "ACP frames carry no native timestamp and the observation time was invalid." },
    actor: { kind: actor },
    family,
    phase,
    scope: { kind: "session", id: owned.sessionId },
    relations: {
      parent: parent === undefined
        ? { status: "unknown", reason: "Devin ACP records retain the session scope but no uniform parent event identity." }
        : { status: "known", value: parent },
      known: [],
    },
    attributes,
    content: {
      status: "known",
      value: [{
        nativeReference: { artifactId: captured.reference.artifactId, recordLocator: `${captured.reference.recordLocator}${contentPath}` },
        mediaType: "application/json",
      }],
    },
  };
}

function devinNativeType(record: ProtocolObservation): string {
  if (record.kind === "request" && record.source === DEVIN_HARNESS) return "server-request";
  if (record.kind === "response" && record.source === DEVIN_HARNESS && record.method === "session/prompt") return "session/prompt:response";
  if (record.kind === "notification" && record.method === "session/update" && isRecord(record.payload) && isRecord(record.payload.update)) {
    const type = text(record.payload.update.sessionUpdate);
    if (type !== undefined) return `session/update:${type}`;
  }
  return record.method ?? record.kind;
}

function captureIdentity(capture: QualifiedNativeCapture<ProtocolObservation>): { sessionId?: string; promptRequestId?: number } {
  const value = capture as unknown as Record<string, unknown>;
  const sessionId = text(value.sessionId);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(typeof value.promptRequestId === "number" ? { promptRequestId: value.promptRequestId } : {}),
  };
}

function cumulativeTokenDimensions(value: unknown): Record<string, number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: Record<string, string> = { input_tokens: "inputTokens", output_tokens: "outputTokens", cached_input_tokens: "cachedInputTokens" };
  const output: Record<string, number> = {};
  for (const dimension of value) {
    if (!isRecord(dimension) || !isRecord(dimension.kind) || dimension.kind.type !== "cumulativeMetric") continue;
    const name = names[String(dimension.uid)];
    if (name === undefined || typeof dimension.kind.value !== "number" || !Number.isFinite(dimension.kind.value)) continue;
    output[name] = dimension.kind.value;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

function configuredModel(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find((candidate) => isRecord(candidate) && candidate.id === "model");
  return isRecord(option) ? text(option.currentValue) : undefined;
}

function unattendedClientResponse(
  method: string,
  params: Record<string, unknown>,
  decision: DevinPermissionDecision,
  sessionId: string | undefined,
): { result?: Record<string, unknown>; error?: { code: number; message: string }; gap?: DevinCaptureGap } {
  if (method !== PERMISSION_REQUEST) {
    return {
      error: { code: -32601, message: `EBO's unattended ACP client does not implement ${method}.` },
      gap: { kind: "unsupported-client-request", detail: `Devin requested ${method}, which the unattended client declined.` },
    };
  }
  if (sessionId !== undefined && params.sessionId !== sessionId) {
    return {
      result: { outcome: { outcome: "cancelled" } },
      gap: { kind: "foreign-permission-request", detail: "Cancelled a permission request for a non-owned session." },
    };
  }
  const wanted = decision === "allow-once" ? "allow_once" : "reject_once";
  const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
  const option = options.find((candidate) => candidate.kind === wanted);
  if (option === undefined || text(option.optionId) === undefined) {
    return {
      result: { outcome: { outcome: "cancelled" } },
      gap: { kind: "permission-option-missing", detail: `Devin offered no ${wanted} option; the request was cancelled.` },
    };
  }
  return { result: { outcome: { outcome: "selected", optionId: option.optionId } } };
}

type OtlpReceiver = {
  enabled: boolean;
  userConfiguration(attemptId: string): Record<string, unknown>;
  close(): Promise<void>;
  evidence(input: {
    attemptId: string;
    executable: string;
    version: string;
    credentialEnv: string;
    model: string;
    mode: DevinSessionMode;
    permissionDecision: DevinPermissionDecision;
    workspace: string;
    environmentKeys: readonly string[];
    records: readonly ProtocolObservation[];
    sessionId: string | undefined;
    terminal: Record<string, unknown> | undefined;
    agentInfo: Record<string, unknown> | undefined;
    agentCapabilities: Record<string, unknown> | undefined;
    appliedModel: string | undefined;
    appliedMode: string | undefined;
    agentStopped: Record<string, unknown> | undefined;
  }): DevinTelemetryEvidence;
};

type ReceiverState = { records: DevinOtlpRecord[]; receiverErrors: string[]; bytes: number; inFlightBytes: number; inFlightRecords: number };

async function openOtlpReceiver(signals: readonly DevinTelemetrySignal[], now = () => new Date().toISOString()): Promise<OtlpReceiver> {
  const enabled = [...new Set(signals)];
  if (enabled.some((signal) => !["logs", "metrics"].includes(signal))) throw new Error("Devin telemetry contains an unsupported signal.");
  const state: ReceiverState = { records: [], receiverErrors: [], bytes: 0, inFlightBytes: 0, inFlightRecords: 0 };
  let server: Server | undefined;
  let port: number | undefined;
  if (enabled.length > 0) {
    server = createServer((incoming, response) => {
      void receiveOtlp(incoming, enabled, state, now).then((status) => {
        response.writeHead(status, { "content-type": "application/x-protobuf" });
        response.end();
      }, () => {
        response.writeHead(400, { "content-type": "application/x-protobuf" });
        response.end();
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
    if (address === null || typeof address === "string") throw new Error("Devin OTLP receiver did not bind a TCP port.");
    port = address.port;
  }
  return {
    enabled: enabled.length > 0,
    userConfiguration: (attemptId) => ({
      version: 1,
      ...(port === undefined ? {} : {
        otel: {
          enabled: true,
          // Both routes point at the loopback receiver so a disabled signal never reaches a default remote endpoint.
          logs_endpoint: `http://127.0.0.1:${port}/v1/logs`,
          metrics_endpoint: `http://127.0.0.1:${port}/v1/metrics`,
          log_export_interval_ms: OTLP_EXPORT_INTERVAL_MS,
          metric_export_interval_ms: OTLP_EXPORT_INTERVAL_MS,
          resource_attributes: { "ebo.attempt_id": attemptId },
        },
      }),
    }),
    close: async () => {
      if (server === undefined) return;
      await new Promise<void>((resolvePromise, reject) => server!.close((error) => error === undefined ? resolvePromise() : reject(error)));
    },
    evidence: (input) => {
      const statuses = Object.fromEntries((["logs", "metrics"] as const).map((signal) => {
        const count = state.records.filter((record) => record.signal === signal && record.parseError === undefined && record.payload !== undefined).length;
        return [signal, { status: enabled.includes(signal) ? count > 0 ? "received" : "missing" : "disabled", count }];
      })) as DevinTelemetryEvidence["telemetry"]["receipt"]["signals"];
      const updates = input.records.flatMap((record): DevinUsageUpdate[] => {
        if (record.kind !== "notification" || record.method !== "session/update" || !isRecord(record.payload)) return [];
        const update = isRecord(record.payload.update) ? record.payload.update : undefined;
        const seenSessionId = text(record.payload.sessionId);
        if (update?.sessionUpdate !== "usage_update" || seenSessionId === undefined || seenSessionId !== input.sessionId) return [];
        if (typeof update.used !== "number" || !Number.isFinite(update.used)) return [];
        const meta = isRecord(update._meta) ? update._meta : {};
        return [{
          sequence: record.sequence,
          sessionId: seenSessionId,
          used: update.used,
          ...finiteNumber("size", update.size),
          ...finiteNumber("inputTokens", meta["cognition.ai/inputTokens"]),
          ...finiteNumber("outputTokens", meta["cognition.ai/outputTokens"]),
          ...finiteNumber("cachedReadTokens", meta["cognition.ai/cachedReadTokens"]),
        }];
      });
      const final = numberRecord(input.terminal?.usage);
      return {
        schemaVersion: "ebo.devin-telemetry/v1",
        attemptId: input.attemptId,
        runtime: {
          executable: input.executable,
          version: input.version,
          adapterVersion: DEVIN_ADAPTER_VERSION,
          userConfiguration: "isolated",
          credentialEnv: input.credentialEnv,
          ...(input.agentInfo === undefined ? {} : { agentInfo: input.agentInfo }),
          ...(input.agentCapabilities === undefined ? {} : { agentCapabilities: input.agentCapabilities }),
        },
        effectiveConfiguration: {
          model: input.model,
          mode: input.mode,
          permissionDecision: input.permissionDecision,
          workspace: input.workspace,
          environmentKeys: input.environmentKeys,
          ...(input.appliedModel === undefined ? {} : { appliedModel: input.appliedModel }),
          ...(input.appliedMode === undefined ? {} : { appliedMode: input.appliedMode }),
        },
        telemetry: {
          receipt: {
            status: enabled.length === 0 ? "not-checked"
              : enabled.every((signal) => statuses[signal].status === "received") ? "received" : "missing",
            signals: statuses,
          },
          records: state.records,
          receiverErrors: state.receiverErrors,
        },
        usage: {
          updates,
          ...(final === undefined ? {} : { final }),
          ...(input.agentStopped === undefined ? {} : { agentStopped: structuredClone(input.agentStopped) }),
        },
      };
    },
  };
}

async function receiveOtlp(
  incoming: IncomingMessage,
  enabled: readonly DevinTelemetrySignal[],
  state: ReceiverState,
  now: () => string,
): Promise<number> {
  const signal = (["logs", "metrics"] as const).find((candidate) => incoming.url === `/v1/${candidate}`);
  if (incoming.method !== "POST" || signal === undefined) {
    incoming.resume();
    recordReceiverError(state, "Rejected an unknown OTLP route or method.");
    return 404;
  }
  if (!enabled.includes(signal)) {
    // The disabled signal still targets loopback; drain it without retaining or counting it as receipt.
    incoming.resume();
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
      if (bytes + value.length > 4 * 1024 * 1024 || state.bytes + state.inFlightBytes + value.length > 16 * 1024 * 1024) {
        incoming.destroy();
        recordReceiverError(state, `Rejected oversized ${signal} OTLP evidence.`);
        return 413;
      }
      bytes += value.length;
      state.inFlightBytes += value.length;
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    const contentType = typeof incoming.headers["content-type"] === "string" ? incoming.headers["content-type"] : undefined;
    const record: DevinOtlpRecord = {
      signal,
      receivedAt: now(),
      ...(contentType === undefined ? {} : { contentType }),
      sizeBytes: body.length,
      body: body.toString("base64"),
      bodyDigest: `sha256:${digestBytes(body).value}`,
    };
    try {
      if (contentType?.startsWith("application/json")) record.payload = JSON.parse(body.toString("utf8"));
      else if (contentType?.startsWith("application/x-protobuf")) record.payload = decodeOtlpProtobuf(signal, body);
      else throw new Error(`Unsupported OTLP content type ${contentType ?? "(none)"}.`);
    } catch (error) {
      record.parseError = errorMessage(error);
      recordReceiverError(state, `Rejected undecodable ${signal} OTLP payload: ${record.parseError.slice(0, 160)}`);
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

function recordCaptureGap(gaps: DevinCaptureGap[], gap: DevinCaptureGap): void {
  if (gaps.some((existing) => existing.kind === gap.kind && existing.detail === gap.detail)) return;
  if (gaps.length < 64) gaps.push(gap);
  else if (!gaps.some(({ kind }) => kind === "capture-gap-limit")) {
    gaps.push({ kind: "capture-gap-limit", detail: "Additional capture gaps remain in native session evidence." });
  }
}

function requireCredential(credentialEnv: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(credentialEnv)) throw new Error("Devin credentialEnv must be an environment variable name.");
  const value = process.env[credentialEnv];
  if (value === undefined) throw new Error(`Devin credentialEnv ${credentialEnv} is not set.`);
  return value;
}

function isolatedEnvironment(home: string, credentialEnv: string, credential: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    NO_COLOR: "1",
  };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment[credentialEnv] = credential;
  return environment;
}

function resolvesCaptureReference(capture: QualifiedNativeCapture<ProtocolObservation>, reference: NativeEvidenceReference): boolean {
  return capture.records.some(({ reference: base }) => base.artifactId === reference.artifactId
    && (reference.recordLocator === base.recordLocator || reference.recordLocator.startsWith(`${base.recordLocator}#`)));
}

function observationTime(value: unknown): UniformEvent["nativeTime"] | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : { status: "known", value: date.toISOString() };
}

function copyScalar(target: Record<string, string | number | boolean | null>, key: string, value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") target[key] = value;
}

function finiteNumber<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } as Record<Key, number> : {};
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, item]) => typeof item === "number" && Number.isFinite(item));
  return entries.length === 0 ? undefined : Object.fromEntries(entries) as Record<string, number>;
}

function protocolId(value: unknown): ProtocolIdentity | undefined {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

function jsonRpcError(method: string, value: unknown): string {
  const message = isRecord(value) && typeof value.message === "string" ? value.message : JSON.stringify(value);
  return `Devin ${method} failed: ${message}`;
}

async function settleOrDelay(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, Math.max(0, milliseconds)); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
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
