import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createSession, AutonomyLevel, DroidInteractionMode, ReasoningEffort, ToolConfirmationOutcome,
  type DroidSession, type StringFramedDroidClientTransport } from "@factory/droid-sdk/node";
import { FACTORY_PROTOCOL_VERSION, SessionNotificationSchema, RequestPermissionRequestSchema,
  InitializeSessionRequestSchema, InitializeSessionResponseSchema, AddUserMessageRequestSchema, AddUserMessageResponseSchema } from "@factory/droid-sdk";
import { assertNoDuplicateJsonKeys, digestBytes, digestMetadata } from "./artifacts.js";
import { spawnProtocolProcess, writeProtocolLine, assertProtocolObservation,
  type ProtocolObservation, type ProtocolProcess, type ProtocolProcessResult } from "./process-protocol.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset, validateNormalizedDataset } from "./normalization-integrity.js";
import { validateUniformEvents, type AdapterCapabilityProfile, type HarnessAdapter,
  type NormalizationResult, type QualifiedNativeCapture, type UniformEvent } from "./uniform-events.js";

export const FACTORY_HARNESS = "factory-droid";
export const FACTORY_SDK_VERSION = "0.9.1";
export const FACTORY_CLI_VERSION = "0.238.0";
export const FACTORY_ADAPTER_VERSION = "0.1.0";
export const RETAINED_FACTORY_CLI_VERSIONS: readonly string[] = [FACTORY_CLI_VERSION];
export const RETAINED_FACTORY_SDK_VERSIONS: readonly string[] = [FACTORY_SDK_VERSION];
export const FACTORY_DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
export const FACTORY_CLIENT = "ebo-factory-client";
export type FactoryPermissionDecision = "proceed_once" | "cancel";
export type FactoryAutonomyLevel = "off" | "low" | "medium" | "high";
export type FactoryReasoningEffort = "none" | "dynamic" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type FactoryDroidConfiguration = {
  executable: string;
  version: typeof FACTORY_CLI_VERSION;
  sdkVersion: typeof FACTORY_SDK_VERSION;
  model: string;
  reasoningEffort: FactoryReasoningEffort;
  autonomyLevel: FactoryAutonomyLevel;
  permissionDecision: FactoryPermissionDecision;
  credentialEnv?: string;
  /** Test fixture prefix; never read from frozen configuration or a CLI flag. */
  executableArgs?: readonly string[];
};
export type FactoryCaptureRequest = {
  runId: string; attemptId: string; workspacePath: string; prompt: string;
  configuration: FactoryDroidConfiguration; evidencePath: string; stderrPath?: string;
  signal?: AbortSignal; shutdownGraceMs?: number; maxLineBytes?: number;
  maxInMemoryObservations?: number; registerShutdown?: (shutdown: () => Promise<void>) => void;
};
export type FactoryCaptureGap = { kind: string; detail: string };
export type FactoryRuntimeEvidence = {
  schemaVersion: "ebo.factory-runtime/v1";
  runtime: { executable: string; version: string; sdkVersion: string; adapterVersion: string; binaryDigest: string; protocolVersion: string };
  effectiveConfiguration: { model: string; reasoningEffort: string; autonomyLevel: string; permissionDecision: string;
    environmentKeys: string[]; userConfiguration: "isolated"; settings?: unknown };
  diagnostics?: Omit<ProtocolProcessResult["stderr"], "bytes">;
  telemetry: { receipt: { status: "not-checked" }; contentCapture: "not-requested" };
};
export type FactoryCapture = QualifiedNativeCapture<ProtocolObservation> & {
  sessionId?: string; turnId?: string; terminal?: Record<string, unknown>;
  terminalStatus?: "completed" | "interrupted" | "failed";
  process: ProtocolProcessResult; gaps: readonly FactoryCaptureGap[]; telemetry: FactoryRuntimeEvidence;
};

/** This probe disables the standalone updater and never reads user settings. */
export async function probeFactoryRuntime(executable: string, args: readonly string[] = []): Promise<{ path: string; version: string }> {
  if (!isAbsolute(executable)) throw new Error("Factory executable must be an absolute path.");
  const { realpath } = await import("node:fs/promises");
  const path = await realpath(executable);
  const { stdout } = await promisify(execFile)(path, [...args, "--version"], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
    env: { PATH: process.env.PATH, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  });
  return { path, version: stdout.trim().replace(/^(?:droid|factory(?:[- ]cli)?)\s+/iu, "") };
}

/** The SDK owns the protocol; EBO owns the child and records each frame before delivery. */
class RecordingFactoryTransport implements StringFramedDroidClientTransport {
  public readonly child: ProtocolProcess;
  public sessionId?: string;
  public turnId?: string;
  public terminal?: Record<string, unknown>;
  public initializationId?: string | number;
  private handler?: (raw: string) => void;
  private errorHandler?: (error: Error) => void;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly shutdownGraceMs: number;
  public fatal: Promise<never>;
  private rejectFatal!: (error: Error) => void;

  constructor(request: FactoryCaptureRequest, env: NodeJS.ProcessEnv) {
    this.shutdownGraceMs = request.shutdownGraceMs ?? FACTORY_DEFAULT_SHUTDOWN_GRACE_MS;
    this.fatal = new Promise((_, reject) => { this.rejectFatal = reject; });
    void this.fatal.catch(() => undefined);
    this.child = spawnProtocolProcess({
      command: request.configuration.executable,
      args: [...(request.configuration.executableArgs ?? []), "exec", "--input-format", "stream-jsonrpc", "--output-format", "stream-jsonrpc"],
      cwd: request.workspacePath, env, source: FACTORY_HARNESS, evidencePath: request.evidencePath,
      ...(request.stderrPath === undefined ? {} : { stderrPath: request.stderrPath }),
      shutdownGraceMs: request.shutdownGraceMs ?? FACTORY_DEFAULT_SHUTDOWN_GRACE_MS,
      ...(request.maxLineBytes === undefined ? {} : { maxLineBytes: request.maxLineBytes }),
      ...(request.maxInMemoryObservations === undefined ? {} : { maxInMemoryObservations: request.maxInMemoryObservations }),
      onFrame: (payload) => {
        const frame = object(payload);
        if (frame?.type === "response" && frame.id === this.initializationId) {
          const result = object(frame.result);
          const id = text(result?.sessionId);
          if (this.sessionId !== undefined || id === undefined) throw new Error("Factory initialization lacks one owned session identity.");
          this.sessionId = id;
        }
        const params = object(frame?.params);
        const notification = object(params?.notification);
        if (frame?.method === "droid.session_notification" && notification?.type === "agent_turn_completed"
          && params?.sessionId === this.sessionId && this.turnId !== undefined && notification.turnId === this.turnId) {
          if (this.terminal !== undefined) throw new Error("Factory emitted duplicate owned turn terminals.");
          this.terminal = notification;
        }
        // The SDK correlates turn IDs but its message bridge does not scope by session.
        // Retain foreign traffic, then keep it outside the owned SDK session.
        if (frame?.method === "droid.session_notification" && params?.sessionId !== this.sessionId) return;
        this.handler?.(JSON.stringify(payload));
      },
    });
    void this.child.wait().then((result) => {
      if (!this.closing) this.fail(new Error(result.recorderError ?? result.protocolError?.message ?? result.error ?? "Factory process exited before capture settled."));
    });
  }
  get isConnected(): boolean { return !this.closing; }
  onMessage(handler: (raw: string) => void): void { this.handler = handler; }
  onError(handler: (error: Error) => void): void { this.errorHandler = handler; }
  async send(raw: string): Promise<void> {
    try {
      const frame = object(JSON.parse(raw));
      if (frame === undefined) throw new Error("Factory SDK sent an invalid frame.");
      const method = text(frame.method) ?? "jsonrpc-response";
      const id = typeof frame.id === "string" || typeof frame.id === "number" ? frame.id : undefined;
      await this.child.evidence.recordRequest({ source: FACTORY_CLIENT, method, raw, payload: frame, ...(id === undefined ? {} : { id }) });
      if (method === "droid.initialize_session") {
        if (this.initializationId !== undefined || id === undefined) throw new Error("Factory sent duplicate initialization.");
        this.initializationId = id;
      }
      if (method === "droid.add_user_message") {
        const turnId = text(object(frame.params)?.messageId);
        if (this.sessionId === undefined || this.turnId !== undefined || turnId === undefined) throw new Error("Factory prompt lacks one owned turn identity.");
        this.turnId = turnId;
      }
      await writeProtocolLine(this.child.stdin!, frame);
    } catch (error) { this.fail(asError(error)); throw error; }
  }
  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closing = true;
      this.child.stdin.end();
      await bounded(this.child.wait(), this.shutdownGraceMs);
      await this.child.shutdown();
    })();
  }
  private fail(error: Error): void { this.rejectFatal(error); this.errorHandler?.(error); }
}

export async function captureFactoryDroid(request: FactoryCaptureRequest): Promise<FactoryCapture> {
  validateFactoryConfiguration(request.configuration);
  for (const [label, value] of Object.entries({ runId: request.runId, attemptId: request.attemptId, prompt: request.prompt, workspacePath: request.workspacePath })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Factory ${label} is required.`);
  }
  const grace = request.shutdownGraceMs ?? FACTORY_DEFAULT_SHUTDOWN_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 60_000) throw new Error("Factory shutdown grace must be 1–60000 ms.");
  const runtime = await probeFactoryRuntime(request.configuration.executable, request.configuration.executableArgs);
  if (runtime.version !== FACTORY_CLI_VERSION) throw new Error(`Factory CLI ${FACTORY_CLI_VERSION} is required; received ${runtime.version}.`);
  const binaryDigest = `sha256:${digestBytes(await readFile(runtime.path)).value}`;
  const credentialEnv = request.configuration.credentialEnv ?? "FACTORY_API_KEY";
  const credential = process.env[credentialEnv];
  if (!credential?.trim()) throw new Error(`${credentialEnv} is required for Factory Droid.`);
  const home = await mkdtemp(join(tmpdir(), "ebo-factory-home-"));
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: join(home, "tmp"), FACTORY_API_KEY: credential, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    TERM: "dumb", NO_COLOR: "1", OTEL_LOG_MESSAGE_CONTENT: "false", OTEL_TELEMETRY_GRANULARITY: "aggregate",
  };
  const gaps: FactoryCaptureGap[] = [];
  let transport: RecordingFactoryTransport | undefined;
  let session: DroidSession | undefined;
  let settings: unknown;
  let sdkResult: unknown;
  let streamPromise: Promise<void> | undefined;
  let streamDrained = false;
  let stopped = false;
  let shutdownPromise: Promise<void> | undefined;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  void aborted.catch(() => undefined);
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    stopped = true;
    const deadline = Date.now() + grace;
    const remaining = (): number => Math.max(0, deadline - Date.now());
    if (session !== undefined) await bounded(session.interrupt().catch(() => undefined), remaining());
    // Interrupt acknowledgement only enqueues cancellation. Keep consuming until
    // the SDK observes the native terminal, or the single drain deadline expires.
    if (streamPromise !== undefined) await bounded(streamPromise.catch(() => undefined), remaining());
    if (transport !== undefined && !streamDrained) await transport.child.interrupt(grace);
  })();
  const abort = (): void => { rejectAbort(new Error("Factory capture interrupted.")); void shutdown(); };
  request.signal?.addEventListener("abort", abort, { once: true });
  request.registerShutdown?.(shutdown);
  try {
    await mkdir(join(home, ".factory"), { recursive: true });
    await mkdir(join(home, "tmp"));
    // Empty user settings and hooks. Repository instructions/hooks remain native task inputs.
    await writeFile(join(home, ".factory", "settings.json"), JSON.stringify({ cloudSessionSync: false, telemetry: { logMessageContent: false, granularity: "aggregate" } }), { mode: 0o600 });
    await writeFile(join(home, ".factory", "hooks.json"), "{}", { mode: 0o600 });
    if (request.signal?.aborted) throw new Error("Factory capture interrupted before launch.");
    transport = new RecordingFactoryTransport({ ...request, configuration: { ...request.configuration, executable: runtime.path } }, environment);
    await transport.child.evidence.recordCapability({ source: FACTORY_HARNESS, name: "runtime-composition", status: "available", details: {
      version: runtime.version, sdkVersion: FACTORY_SDK_VERSION, adapterVersion: FACTORY_ADAPTER_VERSION, binaryDigest, protocolVersion: FACTORY_PROTOCOL_VERSION,
    } });
    const created = createSession({ transport, cwd: request.workspacePath,
      modelId: request.configuration.model, reasoningEffort: request.configuration.reasoningEffort as ReasoningEffort,
      autonomyLevel: request.configuration.autonomyLevel as AutonomyLevel, interactionMode: DroidInteractionMode.Auto,
      permissionHandler: (event) => {
        const selected = request.configuration.permissionDecision;
        if (!event.options.some((option) => option.value === selected)) return ToolConfirmationOutcome.Cancel;
        return selected as ToolConfirmationOutcome.ProceedOnce | ToolConfirmationOutcome.Cancel;
      },
      askUserHandler: () => ({ cancelled: true, answers: [] }),
      observability: { logger: { log: () => undefined } },
    }).then(async (createdSession) => {
      if (stopped) { await bounded(createdSession.close().catch(() => undefined), grace); throw new Error("Factory initialization completed after shutdown."); }
      return createdSession;
    });
    session = await Promise.race([created, transport.fatal, aborted]);
    if (session.id !== transport.sessionId) throw new Error("Factory SDK session differs from native initialization.");
    settings = structuredClone(session.settings);
    if (session.settings.modelId !== request.configuration.model || session.settings.reasoningEffort !== request.configuration.reasoningEffort
      || session.settings.autonomyLevel !== request.configuration.autonomyLevel || session.settings.interactionMode !== DroidInteractionMode.Auto) {
      throw new Error("Factory effective settings differ from the frozen model/tool configuration.");
    }
    streamPromise = (async () => {
      for await (const message of session!.stream(request.prompt, { includePartialMessages: true })) {
        if (message.type === "result") sdkResult = message;
      }
      streamDrained = true;
    })();
    await Promise.race([streamPromise, transport.fatal, aborted]);
    if (transport.terminal === undefined || object(sdkResult)?.sessionId !== transport.sessionId
      || transport.terminal.reason === "completed" && object(sdkResult)?.subtype !== "success") throw new Error("Factory stream lacks an owned native terminal and SDK result.");
  } catch (error) {
    gaps.push({ kind: "capture-error", detail: redactError(error, credential) });
  } finally {
    request.signal?.removeEventListener("abort", abort);
    stopped = true;
    if (shutdownPromise !== undefined) await shutdownPromise;
    if (session !== undefined) await bounded(session.close().catch(() => undefined), grace);
    if (transport !== undefined) await transport.close();
    await rm(home, { recursive: true, force: true });
  }
  if (transport === undefined) throw new Error(gaps[0]?.detail ?? "Factory capture failed before recording.");
  const processResult = await transport.child.wait();
  if (processResult.recorderError || processResult.protocolError || processResult.status === "failed") gaps.push({ kind: "protocol-capture", detail: "Factory protocol recording failed; retained records are partial." });
  // Re-read the durable stream: an in-memory observation limit never discards analysis evidence.
  const { readBoundedFile } = await import("./scheduler.js");
  const records = readBoundedFile(request.evidencePath, "Factory native stream").toString("utf8").split(/\r?\n/u).filter(Boolean)
    .map((line, index) => { const record: unknown = JSON.parse(line); assertProtocolObservation(record, index + 1); return record; });
  const base = { runId: request.runId, attemptId: request.attemptId, qualification: "qualified-with-gaps" as const,
    records: records.map((record) => ({ reference: { artifactId: "session", recordLocator: `line:${record.sequence}` }, record })) };
  let native: QualifiedFactory = base;
  try { native = qualifyFactoryCapture(base, { sessionId: transport.sessionId, expectsCompletion: false, cliVersion: runtime.version, sdkVersion: FACTORY_SDK_VERSION }); }
  catch (error) { gaps.push({ kind: "native-qualification", detail: redactError(error, credential) }); }
  if (native.terminal === undefined) gaps.push({ kind: "native-terminal", detail: "No unambiguous owned agent_turn_completed was retained." });
  const terminalStatus = gaps.length > 0 ? request.signal?.aborted ? "interrupted" : "failed"
    : native.terminal?.reason === "completed" ? "completed"
      : ["cancelled", "permission_rejected"].includes(String(native.terminal?.reason)) ? "interrupted" : "failed";
  const telemetry: FactoryRuntimeEvidence = {
    schemaVersion: "ebo.factory-runtime/v1",
    runtime: { executable: runtime.path, version: runtime.version, sdkVersion: FACTORY_SDK_VERSION, adapterVersion: FACTORY_ADAPTER_VERSION, binaryDigest, protocolVersion: FACTORY_PROTOCOL_VERSION },
    effectiveConfiguration: { model: request.configuration.model, reasoningEffort: request.configuration.reasoningEffort,
      autonomyLevel: request.configuration.autonomyLevel, permissionDecision: request.configuration.permissionDecision,
      environmentKeys: Object.keys(environment).sort(), userConfiguration: "isolated", ...(settings === undefined ? {} : { settings }) },
    diagnostics: { text: processResult.stderr.text, sizeBytes: processResult.stderr.sizeBytes, truncated: processResult.stderr.truncated, maxBytes: processResult.stderr.maxBytes },
    telemetry: { receipt: { status: "not-checked" }, contentCapture: "not-requested" },
  };
  return { ...native, qualification: terminalStatus === "completed" && gaps.length === 0 ? "qualified" : "qualified-with-gaps",
    terminalStatus, process: processResult, gaps, telemetry };
}

export function validateFactoryConfiguration(config: FactoryDroidConfiguration): void {
  if (config.version !== FACTORY_CLI_VERSION || config.sdkVersion !== FACTORY_SDK_VERSION) throw new Error("Factory SDK and CLI must both match the pinned versions.");
  if (!isAbsolute(config.executable) || !text(config.model)) throw new Error("Factory requires an absolute executable and a model.");
  if (!["off", "low", "medium", "high"].includes(config.autonomyLevel)
    || !["none", "dynamic", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.reasoningEffort)
    || !["proceed_once", "cancel"].includes(config.permissionDecision)) throw new Error("Invalid Factory model/tool policy.");
  if (config.credentialEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/u.test(config.credentialEnv)) throw new Error("Factory credentialEnv must name an environment variable.");
}

type QualifiedFactory = QualifiedNativeCapture<ProtocolObservation> & { sessionId?: string; turnId?: string; terminal?: Record<string, unknown> };
/** Native request/response/turn identities are reconstructed on every retained read. */
export function qualifyFactoryCapture(capture: QualifiedNativeCapture<ProtocolObservation>, options: {
  sessionId?: string; expectsCompletion: boolean; cliVersion: string; sdkVersion: string;
}): QualifiedFactory {
  if (!RETAINED_FACTORY_CLI_VERSIONS.includes(options.cliVersion) || !RETAINED_FACTORY_SDK_VERSIONS.includes(options.sdkVersion)) throw new Error("Unsupported retained Factory runtime.");
  const records = capture.records.map(({ record, reference }) => {
    const line = Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]);
    assertProtocolObservation(record, line);
    if (![FACTORY_HARNESS, FACTORY_CLIENT].includes(record.source)) throw new Error("Foreign source in retained Factory stream.");
    if (record.raw !== undefined && record.parseError === undefined) {
      assertNoDuplicateJsonKeys(record.raw);
      if (digestMetadata(JSON.parse(record.raw)).value !== digestMetadata(record.payload).value) throw new Error("Factory raw frame differs from its parsed payload.");
    }
    if (record.source === FACTORY_CLIENT && (object(record.payload)?.jsonrpc !== "2.0" || !["request", "response"].includes(String(object(record.payload)?.type)) || record.kind !== "request" || object(record.payload)?.id !== record.id
      || record.method !== "jsonrpc-response" && object(record.payload)?.method !== record.method)) throw new Error("Factory outbound envelope differs from its protocol frame.");
    return record;
  });
  const compositions = records.filter((r) => r.kind === "capability" && r.capability === "runtime-composition");
  if (compositions.length !== 1 || object(compositions[0]?.evidence)?.version !== options.cliVersion
    || object(compositions[0]?.evidence)?.sdkVersion !== options.sdkVersion
    || object(compositions[0]?.evidence)?.adapterVersion !== FACTORY_ADAPTER_VERSION
    || object(compositions[0]?.evidence)?.protocolVersion !== FACTORY_PROTOCOL_VERSION) throw new Error("Retained Factory native runtime composition differs from the manifest.");
  const initializations = records.filter((r) => r.source === FACTORY_CLIENT && r.method === "droid.initialize_session");
  if (initializations.length > 1 || options.expectsCompletion && initializations.length !== 1) throw new Error("Factory requires one owned initialization request.");
  const initialization = initializations[0];
  if (initialization !== undefined && !InitializeSessionRequestSchema.safeParse(initialization.payload).success) throw new Error("Factory initialization fails the pinned native schema.");
  const responses = initialization === undefined ? [] : records.filter((r) => r.kind === "frame" && object(r.payload)?.type === "response"
    && object(r.payload)?.id === initialization.id);
  if (responses.length > 1 || responses.some((r) => r.sequence <= initialization!.sequence)) throw new Error("Factory initialization response is ambiguous or unordered.");
  const sessionId = text(object(object(responses[0]?.payload)?.result)?.sessionId);
  if (options.expectsCompletion && (responses.length !== 1 || object(responses[0]?.payload)?.error !== undefined)) throw new Error("Completed Factory capture lacks successful initialization.");
  if (responses.length === 1 && !InitializeSessionResponseSchema.safeParse(responses[0]!.payload).success) throw new Error("Factory initialization response fails the pinned native schema.");
  if (sessionId !== options.sessionId) throw new Error("Retained Factory session identity differs from the manifest.");
  const prompts = records.filter((r) => r.source === FACTORY_CLIENT && r.method === "droid.add_user_message");
  if (prompts.length > 1 || options.expectsCompletion && prompts.length !== 1) throw new Error("Factory requires one owned prompt request.");
  const prompt = prompts[0];
  const turnId = text(object(object(prompt?.payload)?.params)?.messageId);
  const promptSessionId = object(object(prompt?.payload)?.params)?.sessionId;
  // Local stdio is bound by initialization; daemon-style explicit IDs must agree if present.
  if (prompt !== undefined && (sessionId === undefined || turnId === undefined || promptSessionId !== undefined && promptSessionId !== sessionId
    || !AddUserMessageRequestSchema.safeParse(prompt.payload).success || prompt.sequence <= (responses[0]?.sequence ?? Infinity))) throw new Error("Factory prompt lacks ordered owned session evidence.");
  const promptResponses = prompt === undefined ? [] : records.filter((r) => r.kind === "frame" && object(r.payload)?.type === "response" && object(r.payload)?.id === prompt.id);
  if (promptResponses.length > 1 || promptResponses.some((r) => r.sequence <= prompt!.sequence)
    || options.expectsCompletion && (promptResponses.length !== 1 || object(promptResponses[0]?.payload)?.error !== undefined)) throw new Error("Factory prompt acknowledgement is missing, ambiguous or failed.");
  if (promptResponses.length === 1 && !AddUserMessageResponseSchema.safeParse(promptResponses[0]!.payload).success) throw new Error("Factory prompt acknowledgement fails the pinned native schema.");
  if (options.expectsCompletion) {
    const requested = object(object(initialization?.payload)?.params);
    const effective = object(object(object(responses[0]?.payload)?.result)?.settings);
    if (["modelId", "reasoningEffort", "autonomyLevel", "interactionMode"].some((key) => requested?.[key] !== effective?.[key])) throw new Error("Factory native effective settings differ from initialization.");
  }
  const terminals = records.filter((r) => {
    const frame = object(r.payload); const params = object(frame?.params); const n = object(params?.notification);
    return r.kind === "frame" && frame?.method === "droid.session_notification" && params?.sessionId === sessionId
      && n?.type === "agent_turn_completed" && n.turnId === turnId && turnId !== undefined;
  });
  if (terminals.length > 1 || terminals.some((r) => r.sequence <= prompt!.sequence)) throw new Error("Factory requires unambiguous ordered owned terminal evidence.");
  const terminal = object(object(object(terminals[0]?.payload)?.params)?.notification);
  if (terminals.length === 1 && !SessionNotificationSchema.safeParse(terminals[0]!.payload).success) throw new Error("Factory owned terminal fails the pinned native schema.");
  if (options.expectsCompletion && (terminal?.reason !== "completed" || sessionId === undefined)) throw new Error("Completed Factory capture lacks an owned completed native turn.");
  return { ...capture, ...(sessionId === undefined ? {} : { sessionId }), ...(turnId === undefined ? {} : { turnId }), ...(terminal === undefined ? {} : { terminal }) };
}

export const FACTORY_CAPABILITIES: AdapterCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1", adapterId: "ebo-factory-droid", harness: FACTORY_HARNESS,
  nativeTypes: ["droid.add_user_message", "create_message", "assistant_text_delta", "tool_call", "tool_result", "droid.request_permission", "permission_resolved", "session_compacted", "child_session_available", "llm_retry", "agent_turn_completed", "session_token_usage_changed", "settings_updated"],
  families: {
    message: { status: "partial", detail: "Completed visible messages, or partial text when no completed message exists; copied SDK messages are not counted again." },
    "model-request": { status: "unsupported", detail: "No inference requests are inferred from message streams." },
    tool: { status: "partial", detail: "Native tool IDs bind calls and results; child histories are incomplete." },
    context: { status: "partial", detail: "Explicit settings, retry and compaction notifications only." },
    permission: { status: "partial", detail: "Client requests, frozen responses and native resolutions are retained." },
    delegation: { status: "partial", detail: "Child identity and tool relationship; child history is not fetched." },
    artifact: { status: "unsupported", detail: "Workspace outcome is packaged separately." },
    validation: { status: "unsupported", detail: "Only explicit verifier evidence establishes validation." },
    runtime: { status: "partial", detail: "Owned terminal turn usage inclusive of children; cumulative updates are context snapshots, not additive usage." },
    outcome: { status: "available", detail: "Exact native owned session and turn terminal reason." },
  },
  evidence: {
    nativeOrder: { status: "available", detail: "One recorded stdio ordering domain." },
    nativeTime: { status: "partial", detail: "Capture receipt times are labeled separately from upstream timestamps." },
    parentage: { status: "partial", detail: "Native tool IDs and exposed child relations only." },
    content: { status: "partial", detail: "References to restricted frames; hidden reasoning never projected." },
  },
};

export function factoryNativeType(record: ProtocolObservation): string {
  const frame = object(record.payload);
  return text(object(object(frame?.params)?.notification)?.type) ?? text(frame?.method) ?? record.method ?? record.capability ?? record.kind;
}

export async function normalizeFactoryCapture(input: QualifiedNativeCapture<ProtocolObservation>): Promise<NormalizationResult> {
  const capture = input as QualifiedFactory;
  const events: UniformEvent[] = [];
  const mapped = new Set<number>();
  const calls = new Map<string, string>();
  const completedMessages = new Set(capture.records.flatMap(({ record }) => {
    const n = object(object(object(record.payload)?.params)?.notification);
    return object(object(record.payload)?.params)?.sessionId === capture.sessionId && n?.type === "create_message"
      && object(n.message)?.role === "assistant" && SessionNotificationSchema.safeParse(record.payload).success ? [text(object(n.message)?.id)] : [];
  }).filter((id): id is string => id !== undefined));
  const seenTools = new Set<string>();
  const seenMessages = new Set<string>();
  for (const { record, reference } of capture.records) {
    if (capture.sessionId === undefined) continue;
    const frame = object(record.payload); const params = object(frame?.params); const n = object(params?.notification);
    const type = factoryNativeType(record);
    const attributes: Record<string, string | number | boolean | null> = { nativeTimeSource: "capture-receipt" };
    let family: UniformEvent["family"] | undefined;
    let phase: UniformEvent["phase"] = "instant";
    let actor: UniformEvent["actor"]["kind"] = "harness";
    let parent: string | undefined;
    let contentPointer = "/payload";
    const id = `factory:${record.sequence}`;
    if (record.source === FACTORY_CLIENT && frame?.method === "droid.add_user_message" && params?.messageId === capture.turnId) {
      family = "message"; actor = "user"; phase = "before";
      contentPointer = "/payload/params/text";
    } else if (record.kind === "frame" && frame?.method === "droid.request_permission" && RequestPermissionRequestSchema.safeParse(frame).success) {
      family = "permission"; phase = "before";
    } else if (record.kind === "frame" && frame?.method === "droid.session_notification" && params?.sessionId === capture.sessionId && SessionNotificationSchema.safeParse(frame).success) {
      if (type === "create_message" && ["assistant", "user"].includes(String(object(n?.message)?.role))) {
        const message = object(n?.message)!;
        // The outbound prompt already represents the root user message.
        if (message.role === "user") continue;
        if (seenMessages.has(String(message.id))) continue;
        seenMessages.add(String(message.id));
        family = "message"; actor = "agent"; phase = "after"; attributes.messageId = String(message.id);
      } else if (type === "assistant_text_delta" && !completedMessages.has(String(n?.messageId))) { family = "message"; actor = "agent"; phase = "during"; }
      else if (type === "tool_call") {
        const tool = object(n?.toolUse); const toolId = text(tool?.id); if (toolId === undefined || seenTools.has(`call:${toolId}`)) continue;
        seenTools.add(`call:${toolId}`); calls.set(toolId, id); family = "tool"; actor = "agent"; phase = "before";
        attributes.toolCallId = toolId; if (typeof tool?.name === "string") attributes.toolName = tool.name;
        if (tool?.input !== undefined) attributes.inputDigest = `sha256:${digestMetadata(tool.input).value}`;
      } else if (type === "tool_result") {
        const toolId = text(n?.toolUseId); if (toolId === undefined || seenTools.has(`result:${toolId}`)) continue;
        seenTools.add(`result:${toolId}`); family = "tool"; actor = "tool"; phase = "after"; attributes.toolCallId = toolId;
        if (typeof n?.isError === "boolean") attributes.isError = n.isError;
        parent = calls.get(toolId);
      } else if (["session_compacted", "settings_updated", "llm_retry"].includes(type)) family = "context";
      else if (type === "session_token_usage_changed") { family = "context"; attributes.usageSemantics = "cumulative-session-snapshot"; }
      else if (type === "permission_resolved") family = "permission";
      else if (type === "child_session_available") {
        family = "delegation"; if (typeof n?.childSessionId === "string") attributes.childSessionId = n.childSessionId;
        parent = calls.get(String(n?.toolUseId));
      } else if (type === "agent_turn_completed" && n !== undefined && n.turnId === capture.turnId) {
        family = "outcome"; phase = "after"; attributes.reason = String(n.reason);
        attributes.usageSemantics = "turn-inclusive-children";
        const usage = object(n.tokenUsage);
        for (const [native, uniform] of Object.entries({ inputTokens: "inputTokens", outputTokens: "outputTokens",
          cacheReadTokens: "cacheReadInputTokens", cacheCreationTokens: "cacheCreationInputTokens",
          thinkingTokens: "thinkingTokens", factoryCredits: "factoryCredits" })) {
          if (typeof usage?.[native] === "number" && Number.isFinite(usage[native])) attributes[uniform] = usage[native];
        }
        if (typeof n.durationMs === "number") attributes.durationMs = n.durationMs;
      }
    }
    if (family === undefined) continue;
    events.push({ schemaVersion: "ebo.uniform-event/v1", id, runId: capture.runId, attemptId: capture.attemptId,
      source: { harness: FACTORY_HARNESS, nativeType: type, nativeReference: reference },
      nativeOrder: { status: "known", value: record.sequence, domain: "factory-native-stdio" },
      nativeTime: { status: "known", value: record.observedAt }, actor: { kind: actor }, family, phase,
      scope: { kind: "session", id: capture.sessionId },
      relations: { parent: parent === undefined ? { status: "unknown", reason: "No exposed native parent." } : { status: "known", value: parent }, known: [] },
      attributes, content: { status: "known", value: [{ nativeReference: { ...reference, recordLocator: `${reference.recordLocator}#${contentPointer}` }, mediaType: "application/json" }] },
    });
    if (type === "agent_turn_completed" && family === "outcome") {
      events.push({ ...events[events.length - 1]!, id: `${id}:usage`, family: "runtime",
        attributes: { ...attributes, resourceSemantics: "cumulative-final" } });
    }
    mapped.add(record.sequence);
  }
  await validateUniformEvents(events, createCapturedNativeEvidenceResolver(capture));
  return { events, unmapped: capture.records.filter(({ record }) => !mapped.has(record.sequence)).map(({ reference }) => ({ reference, reason: "Native record retained without a supported uniform projection." })) };
}

export async function describeAndValidateFactoryDataset(capture: QualifiedNativeCapture<ProtocolObservation>) {
  const dataset = describeNormalizedDataset({ capture, normalization: await normalizeFactoryCapture(capture), capabilityProfile: FACTORY_CAPABILITIES,
    adapterVersion: FACTORY_ADAPTER_VERSION, nativeType: factoryNativeType });
  const coverage = await validateNormalizedDataset(dataset, createCapturedNativeEvidenceResolver(capture));
  return { dataset, coverage };
}
export function createFactoryHarnessAdapter(): HarnessAdapter<FactoryCaptureRequest, ProtocolObservation> {
  return { capture: { id: FACTORY_CAPABILITIES.adapterId, harness: FACTORY_HARNESS, capture: captureFactoryDroid },
    normalization: { id: FACTORY_CAPABILITIES.adapterId, harness: FACTORY_HARNESS, capabilityProfile: FACTORY_CAPABILITIES, normalize: normalizeFactoryCapture } };
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() !== "" ? value : undefined; }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function redactError(error: unknown, credential: string): string { return asError(error).message.replaceAll(credential, "[REDACTED]"); }
async function bounded(operation: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
