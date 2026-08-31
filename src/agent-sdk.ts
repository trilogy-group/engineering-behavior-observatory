import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_EVENTS,
  query,
  type HookCallbackMatcher,
  type HookEvent,
  type HookInput,
  type Options,
  type PermissionMode,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { EvidenceSink, HarnessExecutionContext, HarnessExecutionResult } from "./lifecycle.js";
import { BoundedDiagnosticCapture, openJsonlEvidenceWriter } from "./process-protocol.js";

export type ClaudeAgentSdkConfiguration = {
  prompt: string;
  model: string;
  tools: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env?: NodeJS.ProcessEnv;
};

export type ClaudeAgentSdkLifecycleEvent =
  | { type: "started"; at: string }
  | { type: "abort-requested"; at: string; reason?: string }
  | { type: "completed"; at: string; messageCount: number }
  | { type: "failed"; at: string; messageCount: number; error: string };

export type ClaudeAgentSdkMessageDiagnostic = {
  sequence: number;
  code: "unknown-native-type";
  nativeType: string;
};

export type ClaudeAgentSdkMessageRecord = {
  schemaVersion: "ebo.agent-sdk-message/v1";
  sequence: number;
  capturedAt: string;
  nativeType: string;
  nativeSubtype?: string;
  sessionId?: string;
  message: SDKMessage;
  diagnostics?: ClaudeAgentSdkMessageDiagnostic[];
};

export type ClaudeAgentSdkCaptureReport = {
  schemaVersion: "ebo.agent-sdk-capture/v1";
  status: "complete" | "partial";
  artifact: {
    path: string;
    kind: "session";
    authority: "semantic";
    mediaType: "application/x-ndjson";
    sharingClass: "restricted";
  };
  capabilities: {
    typedMessageStream: { status: "available"; messageCount: number };
    sessionIdentity:
      | { status: "available"; sessionId: string; source: "sdk-result.session_id" | "sdk-message.session_id" }
      | { status: "missing"; reason: "not-emitted" };
  };
  result?: { uuid: string; subtype: string; sessionId: string };
  diagnostics: {
    count: number;
    retained: ClaudeAgentSdkMessageDiagnostic[];
    truncated: boolean;
  };
};

export type ClaudeAgentSdkEvidenceSink = EvidenceSink & {
  message: (message: SDKMessage) => void | Promise<void>;
  stderr: (data: string) => void;
  hook: (
    event: HookEvent,
    input: HookInput,
    toolUseId: string | undefined,
    signal: AbortSignal,
  ) => void | Promise<void>;
  lifecycle: (event: ClaudeAgentSdkLifecycleEvent) => void | Promise<void>;
};

export type ClaudeAgentSdkStreamCapture = ClaudeAgentSdkEvidenceSink & {
  path: string;
  flush: () => Promise<void>;
  report: () => ClaudeAgentSdkCaptureReport;
  close: () => Promise<void>;
};

export type ClaudeAgentSdkCapabilities = {
  sdkVersion: string;
  claudeCodeVersion: string;
  query: { status: "available" };
  typedMessageStream: { status: "available" };
  stderr: { status: "available" };
  abort: { status: "available" };
  hookLifecycleMessages: { status: "available" };
  hooks: Record<HookEvent, { status: "available" }>;
  betaTelemetry: { status: "unsupported"; reason: string };
  missingEvidence: Array<{ capability: "beta-telemetry"; reason: string }>;
};

type QueryHandle = AsyncIterable<SDKMessage> & { close: () => void };
type QueryFunction = (input: { prompt: string; options?: Options }) => QueryHandle;

export type ClaudeAgentSdkAttemptEvidence = {
  runtime: Array<{ source: "anthropic"; name: "agent-sdk" | "agent-cli"; version: string }>;
  effectiveConfiguration: {
    model: string;
    tools: string[];
    allowedTools: string[];
    disallowedTools: string[];
    permissionMode: PermissionMode;
    environment: { parentPreserved: true; overridesApplied: boolean };
    budget: { wallClockMs?: number; maxTurns?: number; maxBudgetUsd?: number };
    workingDirectory: "attempt-workspace";
  };
  capabilities: ClaudeAgentSdkCapabilities;
};

const PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
const BETA_TELEMETRY_REASON = "The pinned SDK exposes no typed telemetry callback; external telemetry capture is not emulated.";
const MAX_CAPTURE_DIAGNOSTICS = 32;
const KNOWN_MESSAGE_TYPES = new Set<SDKMessage["type"]>([
  "assistant",
  "auth_status",
  "conversation_reset",
  "prompt_suggestion",
  "rate_limit_event",
  "result",
  "stream_event",
  "system",
  "tool_progress",
  "tool_use_summary",
  "user",
]);

export async function openClaudeAgentSdkStreamCapture(
  path: string,
  sink: ClaudeAgentSdkEvidenceSink,
  now: () => string = () => new Date().toISOString(),
): Promise<ClaudeAgentSdkStreamCapture> {
  validateEvidenceSink(sink);
  const writer = await openJsonlEvidenceWriter(path, { exclusive: true });
  let sequence = 0;
  let sessionId: string | undefined;
  let sessionSource: "sdk-result.session_id" | "sdk-message.session_id" | undefined;
  let result: ClaudeAgentSdkCaptureReport["result"];
  let diagnosticCount = 0;
  let appendError: unknown;
  const diagnostics: ClaudeAgentSdkMessageDiagnostic[] = [];

  return {
    path: writer.path,
    async message(message) {
      const record = nativeMessageRecord(message, sequence + 1, now());
      const value = message as unknown;
      try {
        await writer.append(record);
      } catch (error) {
        appendError ??= error;
        throw error;
      }
      sequence = record.sequence;
      for (const diagnostic of record.diagnostics ?? []) {
        diagnosticCount += 1;
        if (diagnostics.length < MAX_CAPTURE_DIAGNOSTICS) diagnostics.push(diagnostic);
      }
      if (record.sessionId !== undefined && sessionId === undefined) {
        sessionId = record.sessionId;
        sessionSource = "sdk-message.session_id";
      }
      if (record.nativeType === "result" && record.sessionId !== undefined && isRecord(value)
          && typeof value.uuid === "string" && typeof value.subtype === "string") {
        sessionId = record.sessionId;
        sessionSource = "sdk-result.session_id";
        result = { uuid: value.uuid, subtype: value.subtype, sessionId: record.sessionId };
      }
      await sink.message(message);
    },
    stderr: (data) => sink.stderr(data),
    hook: (event, input, toolUseId, signal) => sink.hook(event, input, toolUseId, signal),
    lifecycle: (event) => sink.lifecycle(event),
    async flush() {
      const results = await Promise.allSettled([writer.flush(), Promise.resolve().then(() => sink.flush?.())]);
      const error = appendError ?? results.find((entry) => entry.status === "rejected")?.reason;
      if (error !== undefined) throw error;
    },
    close: () => writer.close(),
    report: () => ({
      schemaVersion: "ebo.agent-sdk-capture/v1",
      status: result === undefined || appendError !== undefined ? "partial" : "complete",
      artifact: {
        path: writer.path,
        kind: "session",
        authority: "semantic",
        mediaType: "application/x-ndjson",
        sharingClass: "restricted",
      },
      capabilities: {
        typedMessageStream: { status: "available", messageCount: sequence },
        sessionIdentity: sessionId === undefined || sessionSource === undefined
          ? { status: "missing", reason: "not-emitted" }
          : { status: "available", sessionId, source: sessionSource },
      },
      ...(result === undefined ? {} : { result: { ...result } }),
      diagnostics: {
        count: diagnosticCount,
        retained: diagnostics.map((diagnostic) => ({ ...diagnostic })),
        truncated: diagnosticCount > diagnostics.length,
      },
    }),
  };
}

export function probeClaudeAgentSdkCapabilities(): ClaudeAgentSdkCapabilities {
  const { sdkVersion, claudeCodeVersion } = installedVersions();
  return {
    sdkVersion,
    claudeCodeVersion,
    query: { status: "available" },
    typedMessageStream: { status: "available" },
    stderr: { status: "available" },
    abort: { status: "available" },
    hookLifecycleMessages: { status: "available" },
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, { status: "available" }])) as Record<HookEvent, { status: "available" }>,
    betaTelemetry: { status: "unsupported", reason: BETA_TELEMETRY_REASON },
    missingEvidence: [{ capability: "beta-telemetry", reason: BETA_TELEMETRY_REASON }],
  };
}

export async function executeClaudeAgentSdk(
  context: HarnessExecutionContext,
  configuration: ClaudeAgentSdkConfiguration,
  sink: ClaudeAgentSdkEvidenceSink,
  queryFunction: QueryFunction = query,
): Promise<HarnessExecutionResult> {
  let queryHandle: QueryHandle | undefined;
  let messageCount = 0;
  let lastResult: SDKResultMessage | undefined;
  const stderr = new BoundedDiagnosticCapture();
  let evidence: ClaudeAgentSdkAttemptEvidence | undefined;
  const controller = new AbortController();
  let abortEvent = Promise.resolve();
  let abortLifecycleError: string | undefined;
  let closeError: string | undefined;
  let closed = false;

  const close = (): void => {
    if (queryHandle === undefined || closed) return;
    closed = true;
    try {
      queryHandle.close();
    } catch (error) {
      closeError = errorMessage(error);
    }
  };

  const abort = (): void => {
    if (controller.signal.aborted) return;
    controller.abort(context.signal.reason);
    abortEvent = emitLifecycle(sink, {
      type: "abort-requested",
      at: new Date().toISOString(),
      ...errorReason(context.signal.reason),
    }).catch((error) => {
      abortLifecycleError = errorMessage(error);
    });
    close();
  };

  context.registerShutdown(() => {
    close();
    if (closeError !== undefined) throw new Error(closeError);
  });
  if (context.signal.aborted) abort();
  else context.signal.addEventListener("abort", abort, { once: true });

  try {
    validateEvidenceSink(sink);
    validateConfiguration(configuration, context);
    const capabilities = probeClaudeAgentSdkCapabilities();
    evidence = executorEvidence(configuration, context, capabilities);
    const hooks = passiveHooks(sink);
    const options: Options = {
      abortController: controller,
      cwd: context.workspace!.path,
      env: { ...process.env, ...configuration.env },
      model: configuration.model,
      tools: [...configuration.tools],
      allowedTools: [...(configuration.allowedTools ?? [])],
      disallowedTools: [...(configuration.disallowedTools ?? [])],
      permissionMode: configuration.permissionMode,
      ...(configuration.allowDangerouslySkipPermissions === undefined
        ? {}
        : { allowDangerouslySkipPermissions: configuration.allowDangerouslySkipPermissions }),
      ...(configuration.maxTurns === undefined ? {} : { maxTurns: configuration.maxTurns }),
      ...(configuration.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: configuration.maxBudgetUsd }),
      hooks,
      includeHookEvents: true,
      stderr: captureStderr,
    };

    await emitLifecycle(sink, { type: "started", at: new Date().toISOString() });
    queryHandle = queryFunction({ prompt: configuration.prompt, options });
    if (controller.signal.aborted) close();

    for await (const message of queryHandle) {
      messageCount += 1;
      await sink.message?.(message);
      if (message.type === "result") lastResult = message;
    }
    await abortEvent;
    if (abortLifecycleError !== undefined) throw new Error(abortLifecycleError);

    if (context.signal.aborted || controller.signal.aborted && lastResult === undefined) {
      const reason = "Claude Agent SDK execution was aborted.";
      await emitLifecycle(sink, { type: "failed", at: new Date().toISOString(), messageCount, error: reason });
      return { status: "interrupted", reason, evidence };
    }
    const result = classifyResult(lastResult, diagnosticText(stderr), evidence);
    await emitLifecycle(sink, result.status === "completed"
      ? { type: "completed", at: new Date().toISOString(), messageCount }
      : { type: "failed", at: new Date().toISOString(), messageCount, error: result.error ?? result.reason ?? "Claude Agent SDK failed." });
    return result;
  } catch (error) {
    await abortEvent;
    const diagnostic = joinDiagnostics(errorMessage(error), closeError, diagnosticText(stderr));
    if (context.signal.aborted || controller.signal.aborted) {
      await emitLifecycle(sink, { type: "failed", at: new Date().toISOString(), messageCount, error: diagnostic });
      return { status: "interrupted", reason: "Claude Agent SDK execution was aborted.", error: diagnostic, ...(evidence === undefined ? {} : { evidence }) };
    }
    await emitLifecycle(sink, { type: "failed", at: new Date().toISOString(), messageCount, error: diagnostic });
    return { status: "failed", failureClass: "infrastructure", reason: "Claude Agent SDK execution failed.", error: diagnostic, ...(evidence === undefined ? {} : { evidence }) };
  } finally {
    context.signal.removeEventListener("abort", abort);
  }

  function captureStderr(data: string): void {
    stderr.write(Buffer.from(data));
    sink.stderr?.(data);
  }
}

function passiveHooks(sink: ClaudeAgentSdkEvidenceSink): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{
      hooks: [async (input, toolUseId, { signal }) => {
        await sink.hook?.(event, input, toolUseId, signal);
        return {};
      }],
    }];
  }
  return hooks;
}

function classifyResult(
  result: SDKResultMessage | undefined,
  stderr: string,
  evidence: ClaudeAgentSdkAttemptEvidence,
): HarnessExecutionResult {
  if (result === undefined) {
    return {
      status: "failed",
      failureClass: "infrastructure",
      reason: "Claude Agent SDK stream ended without a result message.",
      error: joinDiagnostics("Claude Agent SDK stream ended without a result message.", stderr),
      evidence,
    };
  }
  const completionEvidence = {
    type: "sdk-result",
    subtype: result.subtype,
    sessionId: result.session_id,
    uuid: result.uuid,
  };
  if (result.subtype === "success" && !result.is_error) {
    return { status: "completed", completionEvidence, evidence };
  }
  const sdkError = result.subtype === "success" ? result.result : result.errors.join("\n");
  const error = joinDiagnostics(sdkError || `Claude Agent SDK returned ${result.subtype}.`, stderr);
  if (result.subtype === "error_max_turns" || result.subtype === "error_max_budget_usd") {
    return { status: "stopped", stopReason: "budget", reason: `Claude Agent SDK reached ${result.subtype}.`, error, completionEvidence, evidence };
  }
  return {
    status: "failed",
    failureClass: "infrastructure",
    reason: result.subtype === "success"
      ? "Claude Agent SDK returned an API error."
      : `Claude Agent SDK returned ${result.subtype}.`,
    error,
    completionEvidence,
    evidence,
  };
}

function executorEvidence(
  configuration: ClaudeAgentSdkConfiguration,
  context: HarnessExecutionContext,
  capabilities: ClaudeAgentSdkCapabilities,
): ClaudeAgentSdkAttemptEvidence {
  return {
    runtime: [
      { source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion },
      { source: "anthropic", name: "agent-cli", version: capabilities.claudeCodeVersion },
    ],
    effectiveConfiguration: {
      model: configuration.model,
      tools: [...configuration.tools],
      allowedTools: [...(configuration.allowedTools ?? [])],
      disallowedTools: [...(configuration.disallowedTools ?? [])],
      permissionMode: configuration.permissionMode,
      environment: { parentPreserved: true, overridesApplied: Object.keys(configuration.env ?? {}).length > 0 },
      budget: {
        ...(context.budgetMs === undefined ? {} : { wallClockMs: context.budgetMs }),
        ...(configuration.maxTurns === undefined ? {} : { maxTurns: configuration.maxTurns }),
        ...(configuration.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: configuration.maxBudgetUsd }),
      },
      workingDirectory: "attempt-workspace",
    },
    capabilities,
  };
}

function validateConfiguration(configuration: ClaudeAgentSdkConfiguration, context: HarnessExecutionContext): void {
  if (!isRecord(configuration)) throw new Error("Claude Agent SDK configuration must be an object.");
  assertText(configuration.prompt, "prompt");
  assertText(configuration.model, "model");
  assertStringList(configuration.tools, "tools");
  if (configuration.allowedTools !== undefined) assertStringList(configuration.allowedTools, "allowedTools");
  if (configuration.disallowedTools !== undefined) assertStringList(configuration.disallowedTools, "disallowedTools");
  if (!["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"].includes(configuration.permissionMode)) {
    throw new Error("Claude Agent SDK permissionMode is invalid.");
  }
  if (configuration.permissionMode === "bypassPermissions" && configuration.allowDangerouslySkipPermissions !== true) {
    throw new Error("bypassPermissions requires allowDangerouslySkipPermissions=true.");
  }
  if (configuration.maxTurns !== undefined && (!Number.isSafeInteger(configuration.maxTurns) || configuration.maxTurns < 1)) {
    throw new Error("Claude Agent SDK maxTurns must be a positive safe integer.");
  }
  if (configuration.maxBudgetUsd !== undefined && (!Number.isFinite(configuration.maxBudgetUsd) || configuration.maxBudgetUsd <= 0)) {
    throw new Error("Claude Agent SDK maxBudgetUsd must be a positive finite number.");
  }
  if (configuration.env !== undefined) {
    if (!isRecord(configuration.env)) throw new Error("Claude Agent SDK env must be an object.");
    for (const value of Object.values(configuration.env)) {
      if (value !== undefined && typeof value !== "string") throw new Error("Claude Agent SDK env values must be strings or undefined.");
    }
  }
  if (context.workspace?.status !== "ready" || context.workspace.path === undefined || context.workspace.path.trim() === "") {
    throw new Error("Claude Agent SDK requires a ready attempt workspace path.");
  }
}

function validateEvidenceSink(sink: ClaudeAgentSdkEvidenceSink): void {
  if (!isRecord(sink) || [sink.message, sink.stderr, sink.hook, sink.lifecycle].some((callback) => typeof callback !== "function")) {
    throw new Error("Claude Agent SDK evidence sink requires message, stderr, hook, and lifecycle callbacks.");
  }
}

function nativeMessageRecord(message: SDKMessage, sequence: number, capturedAt: string): ClaudeAgentSdkMessageRecord {
  const value = message as unknown;
  const nativeType = isRecord(value) && typeof value.type === "string" && value.type !== "" ? value.type : "unknown";
  const nativeSubtype = isRecord(value) && typeof value.subtype === "string" && value.subtype !== "" ? value.subtype : undefined;
  const sessionId = isRecord(value) && typeof value.session_id === "string" && value.session_id !== "" ? value.session_id : undefined;
  const diagnostic = KNOWN_MESSAGE_TYPES.has(nativeType as SDKMessage["type"])
    ? undefined
    : { sequence, code: "unknown-native-type" as const, nativeType: nativeType.slice(0, 256) };
  return {
    schemaVersion: "ebo.agent-sdk-message/v1",
    sequence,
    capturedAt,
    nativeType,
    ...(nativeSubtype === undefined ? {} : { nativeSubtype }),
    ...(sessionId === undefined ? {} : { sessionId }),
    message,
    ...(diagnostic === undefined ? {} : { diagnostics: [diagnostic] }),
  };
}

function installedVersions(): { sdkVersion: string; claudeCodeVersion: string } {
  const entry = fileURLToPath(import.meta.resolve(PACKAGE_NAME));
  const metadata = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as unknown;
  if (!isRecord(metadata) || typeof metadata.version !== "string" || typeof metadata.claudeCodeVersion !== "string") {
    throw new Error("Installed Claude Agent SDK package metadata is incomplete.");
  }
  return { sdkVersion: metadata.version, claudeCodeVersion: metadata.claudeCodeVersion };
}

function emitLifecycle(sink: ClaudeAgentSdkEvidenceSink, event: ClaudeAgentSdkLifecycleEvent): Promise<void> {
  return Promise.resolve(sink.lifecycle?.(event));
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Claude Agent SDK ${field} must be a nonempty string.`);
}

function assertStringList(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`Claude Agent SDK ${field} must contain only nonempty strings.`);
  }
}

function joinDiagnostics(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined && value !== "").join("\n");
}

function diagnosticText(capture: BoundedDiagnosticCapture): string {
  const result = capture.result();
  return result.truncated
    ? `${result.text}\n[stderr truncated: received ${result.sizeBytes} bytes, retained ${result.maxBytes}]`
    : result.text;
}

function errorReason(value: unknown): { reason?: string } {
  return value === undefined ? {} : { reason: errorMessage(value) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
