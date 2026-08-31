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
import type {
  AttemptIdentity,
  EvidenceSink,
  HarnessExecutionContext,
  HarnessExecutionResult,
  RunIdentity,
} from "./lifecycle.js";
import { BoundedDiagnosticCapture } from "./process-protocol.js";

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
  telemetry?: ClaudeAgentSdkTelemetryConfiguration;
};

export type ClaudeAgentSdkTelemetrySignal = "traces" | "metrics" | "logs";

export type ClaudeAgentSdkTelemetryCorrelation = {
  type: "resource-attributes";
  attributes: {
    "ebo.run.id": string;
    "ebo.attempt.id": string;
    "ebo.attempt.number": string;
  };
};

export type ClaudeAgentSdkTelemetryReceipt =
  | { status: "received"; signals: ClaudeAgentSdkTelemetrySignal[] }
  | {
    status: "missing";
    signals: ClaudeAgentSdkTelemetrySignal[];
    reason: "not-received" | "collector-unreachable" | "process-interrupted" | "partial-receipt" | "receipt-check-failed";
  }
  | { status: "not-checked"; signals: []; reason: "no-receipt-check" };

export type ClaudeAgentSdkTelemetryConfiguration = {
  endpoint: string;
  protocol?: "http/protobuf" | "http/json" | "grpc";
  exportIntervalMs?: number;
  logUserPrompts?: boolean;
  logToolDetails?: boolean;
  logToolContent?: boolean;
  logRawApiBodies?: boolean;
  detailedHookSpans?: { endpoint: string };
  checkReceipt?: (
    correlation: ClaudeAgentSdkTelemetryCorrelation,
  ) => ClaudeAgentSdkTelemetryReceipt | Promise<ClaudeAgentSdkTelemetryReceipt>;
};

export type ClaudeAgentSdkTelemetryEvidence = {
  effectiveSettings: {
    endpoint: string;
    protocol: "http/protobuf" | "http/json" | "grpc";
    exporters: Record<ClaudeAgentSdkTelemetrySignal, "otlp">;
    exportIntervalMs: Record<ClaudeAgentSdkTelemetrySignal, number>;
    diagnostics: "stderr";
    content: {
      userPrompts: boolean;
      toolDetails: boolean;
      toolContent: boolean;
      rawApiBodies: boolean;
    };
    secretHeadersConfigured: boolean;
  };
  correlation: ClaudeAgentSdkTelemetryCorrelation & { inheritedResourceAttributesPreserved: boolean };
  traces: { status: "beta" };
  hookSpans: { status: "disabled" } | { status: "enabled"; stability: "detailed-beta"; endpoint: string };
  receipt: ClaudeAgentSdkTelemetryReceipt;
};

export type ClaudeAgentSdkEnvironment = {
  env: NodeJS.ProcessEnv;
  telemetry?: ClaudeAgentSdkTelemetryEvidence;
};

export type ClaudeAgentSdkLifecycleEvent =
  | { type: "started"; at: string }
  | { type: "abort-requested"; at: string; reason?: string }
  | { type: "completed"; at: string; messageCount: number }
  | { type: "failed"; at: string; messageCount: number; error: string };

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

export type ClaudeAgentSdkCapabilities = {
  sdkVersion: string;
  claudeCodeVersion: string;
  query: { status: "available" };
  typedMessageStream: { status: "available" };
  stderr: { status: "available" };
  abort: { status: "available" };
  hookLifecycleMessages: { status: "available" };
  hooks: Record<HookEvent, { status: "available" }>;
  telemetry: {
    metrics: { status: "available"; stability: "stable" };
    logs: { status: "available"; stability: "stable" };
    traces: { status: "available"; stability: "beta" };
    hookSpans: { status: "optional"; stability: "detailed-beta" };
  };
  missingEvidence: [];
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
  telemetry?: ClaudeAgentSdkTelemetryEvidence;
};

const PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
const TELEMETRY_SIGNALS = ["traces", "metrics", "logs"] as const;
const TELEMETRY_EXPORTER_KEYS = ["OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER"] as const;
const DEFAULT_EXPORT_INTERVAL_MS = 1_000;

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
    telemetry: {
      metrics: { status: "available", stability: "stable" },
      logs: { status: "available", stability: "stable" },
      traces: { status: "available", stability: "beta" },
      hookSpans: { status: "optional", stability: "detailed-beta" },
    },
    missingEvidence: [],
  };
}

export function buildClaudeAgentSdkEnvironment(input: {
  inherited: NodeJS.ProcessEnv;
  overrides?: NodeJS.ProcessEnv;
  telemetry?: ClaudeAgentSdkTelemetryConfiguration;
  run: RunIdentity;
  attempt: AttemptIdentity;
}): ClaudeAgentSdkEnvironment {
  const env = { ...input.inherited, ...input.overrides };
  if (input.telemetry === undefined) {
    rejectConsoleExporter(env);
    return { env };
  }

  validateTelemetryConfiguration(input.telemetry);
  const protocol = input.telemetry.protocol ?? "http/protobuf";
  const exportIntervalMs = input.telemetry.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS;
  const attributes = {
    "ebo.run.id": input.run.id,
    "ebo.attempt.id": input.attempt.id,
    "ebo.attempt.number": String(input.attempt.number),
  };
  const encodedAttributes = Object.entries(attributes)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(",");
  const inheritedResourceAttributes = env.OTEL_RESOURCE_ATTRIBUTES;
  const content = {
    userPrompts: input.telemetry.logUserPrompts ?? false,
    toolDetails: input.telemetry.logToolDetails ?? false,
    toolContent: input.telemetry.logToolContent ?? false,
    rawApiBodies: input.telemetry.logRawApiBodies ?? false,
  };

  Object.assign(env, {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    CLAUDE_CODE_OTEL_DIAG_STDERR: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
    OTEL_EXPORTER_OTLP_ENDPOINT: input.telemetry.endpoint,
    OTEL_METRIC_EXPORT_INTERVAL: String(exportIntervalMs),
    OTEL_LOGS_EXPORT_INTERVAL: String(exportIntervalMs),
    OTEL_TRACES_EXPORT_INTERVAL: String(exportIntervalMs),
    OTEL_LOG_USER_PROMPTS: content.userPrompts ? "1" : "0",
    OTEL_LOG_TOOL_DETAILS: content.toolDetails ? "1" : "0",
    OTEL_LOG_TOOL_CONTENT: content.toolContent ? "1" : "0",
    OTEL_LOG_RAW_API_BODIES: content.rawApiBodies ? "1" : "0",
    OTEL_RESOURCE_ATTRIBUTES: inheritedResourceAttributes === undefined || inheritedResourceAttributes === ""
      ? encodedAttributes
      : `${inheritedResourceAttributes},${encodedAttributes}`,
  });
  if (input.telemetry.detailedHookSpans === undefined) {
    delete env.ENABLE_BETA_TRACING_DETAILED;
    delete env.BETA_TRACING_ENDPOINT;
  } else {
    env.ENABLE_BETA_TRACING_DETAILED = "1";
    env.BETA_TRACING_ENDPOINT = input.telemetry.detailedHookSpans.endpoint;
  }
  rejectConsoleExporter(env);

  return {
    env,
    telemetry: {
      effectiveSettings: {
        endpoint: input.telemetry.endpoint,
        protocol,
        exporters: { traces: "otlp", metrics: "otlp", logs: "otlp" },
        exportIntervalMs: { traces: exportIntervalMs, metrics: exportIntervalMs, logs: exportIntervalMs },
        diagnostics: "stderr",
        content,
        secretHeadersConfigured: TELEMETRY_SIGNALS.some((signal) => env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`] !== undefined)
          || env.OTEL_EXPORTER_OTLP_HEADERS !== undefined,
      },
      correlation: {
        type: "resource-attributes",
        attributes,
        inheritedResourceAttributesPreserved: inheritedResourceAttributes !== undefined && inheritedResourceAttributes !== "",
      },
      traces: { status: "beta" },
      hookSpans: input.telemetry.detailedHookSpans === undefined
        ? { status: "disabled" }
        : { status: "enabled", stability: "detailed-beta", endpoint: input.telemetry.detailedHookSpans.endpoint },
      receipt: { status: "not-checked", signals: [], reason: "no-receipt-check" },
    },
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
  let receiptChecked = false;

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
    const environment = buildClaudeAgentSdkEnvironment({
      inherited: process.env,
      overrides: configuration.env,
      telemetry: configuration.telemetry,
      run: context.run,
      attempt: context.attempt,
    });
    evidence = executorEvidence(configuration, context, capabilities, environment.telemetry);
    const hooks = passiveHooks(sink);
    const options: Options = {
      abortController: controller,
      cwd: context.workspace!.path,
      env: environment.env,
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
    close();
    if (closeError !== undefined) throw new Error(closeError);
    await checkTelemetryReceipt();
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
    close();
    await checkTelemetryReceipt();
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

  async function checkTelemetryReceipt(): Promise<void> {
    if (receiptChecked || configuration.telemetry === undefined || evidence?.telemetry === undefined) return;
    receiptChecked = true;
    evidence.telemetry.receipt = await checkTelemetryReceiptSafely(configuration.telemetry, evidence.telemetry.correlation);
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
  telemetry: ClaudeAgentSdkTelemetryEvidence | undefined,
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
    ...(telemetry === undefined ? {} : { telemetry }),
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
  if (configuration.telemetry !== undefined && !isRecord(configuration.telemetry)) {
    throw new Error("Claude Agent SDK telemetry must be an object.");
  }
  if (context.workspace?.status !== "ready" || context.workspace.path === undefined || context.workspace.path.trim() === "") {
    throw new Error("Claude Agent SDK requires a ready attempt workspace path.");
  }
}

function validateTelemetryConfiguration(configuration: ClaudeAgentSdkTelemetryConfiguration): void {
  if (!isRecord(configuration)) throw new Error("Claude Agent SDK telemetry must be an object.");
  assertTelemetryEndpoint(configuration.endpoint, "endpoint");
  if (configuration.protocol !== undefined && !["http/protobuf", "http/json", "grpc"].includes(configuration.protocol)) {
    throw new Error("Claude Agent SDK telemetry protocol is invalid.");
  }
  if (configuration.exportIntervalMs !== undefined
      && (!Number.isSafeInteger(configuration.exportIntervalMs) || configuration.exportIntervalMs < 1)) {
    throw new Error("Claude Agent SDK telemetry exportIntervalMs must be a positive safe integer.");
  }
  for (const field of ["logUserPrompts", "logToolDetails", "logToolContent", "logRawApiBodies"] as const) {
    if (configuration[field] !== undefined && typeof configuration[field] !== "boolean") {
      throw new Error(`Claude Agent SDK telemetry ${field} must be a boolean.`);
    }
  }
  if (configuration.detailedHookSpans !== undefined) {
    if (!isRecord(configuration.detailedHookSpans)) throw new Error("Claude Agent SDK detailedHookSpans must be an object.");
    assertTelemetryEndpoint(configuration.detailedHookSpans.endpoint, "detailedHookSpans.endpoint");
  }
  if (configuration.checkReceipt !== undefined && typeof configuration.checkReceipt !== "function") {
    throw new Error("Claude Agent SDK telemetry checkReceipt must be a function.");
  }
}

function assertTelemetryEndpoint(value: unknown, field: string): asserts value is string {
  assertText(value, `telemetry ${field}`);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`Claude Agent SDK telemetry ${field} must be an absolute URL.`);
  }
  if (!(["http:", "https:"] as string[]).includes(endpoint.protocol)
      || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new Error(`Claude Agent SDK telemetry ${field} must be an HTTP(S) URL without credentials, query, or fragment.`);
  }
}

function rejectConsoleExporter(env: NodeJS.ProcessEnv): void {
  for (const key of TELEMETRY_EXPORTER_KEYS) {
    if ((env[key] ?? "").split(",").some((exporter) => exporter.trim().toLowerCase() === "console")) {
      throw new Error(`Claude Agent SDK ${key} cannot use the console exporter because stdout is the SDK protocol channel.`);
    }
  }
}

async function checkTelemetryReceiptSafely(
  configuration: ClaudeAgentSdkTelemetryConfiguration,
  correlation: ClaudeAgentSdkTelemetryCorrelation,
): Promise<ClaudeAgentSdkTelemetryReceipt> {
  if (configuration.checkReceipt === undefined) return { status: "not-checked", signals: [], reason: "no-receipt-check" };
  let receipt: ClaudeAgentSdkTelemetryReceipt;
  try {
    receipt = await configuration.checkReceipt(correlation);
  } catch {
    return { status: "missing", signals: [], reason: "receipt-check-failed" };
  }
  if (!isRecord(receipt) || !Array.isArray(receipt.signals)
      || receipt.signals.some((signal) => !TELEMETRY_SIGNALS.includes(signal as ClaudeAgentSdkTelemetrySignal))) {
    return { status: "missing", signals: [], reason: "receipt-check-failed" };
  }
  const signals = [...new Set(receipt.signals)] as ClaudeAgentSdkTelemetrySignal[];
  if (receipt.status === "received") {
    return TELEMETRY_SIGNALS.every((signal) => signals.includes(signal))
      ? { status: "received", signals }
      : { status: "missing", signals, reason: "partial-receipt" };
  }
  if (receipt.status === "missing"
      && ["not-received", "collector-unreachable", "process-interrupted", "partial-receipt", "receipt-check-failed"].includes(String(receipt.reason))) {
    return { status: "missing", signals, reason: receipt.reason };
  }
  return { status: "missing", signals, reason: "receipt-check-failed" };
}

function validateEvidenceSink(sink: ClaudeAgentSdkEvidenceSink): void {
  if (!isRecord(sink) || [sink.message, sink.stderr, sink.hook, sink.lifecycle].some((callback) => typeof callback !== "function")) {
    throw new Error("Claude Agent SDK evidence sink requires message, stderr, hook, and lifecycle callbacks.");
  }
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
