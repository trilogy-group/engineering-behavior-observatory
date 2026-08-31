import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HOOK_EVENTS,
  type HookInput,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  buildClaudeAgentSdkEnvironment,
  createRunIdentity,
  executeClaudeAgentSdk,
  executeRunAttempt,
  probeClaudeAgentSdkCapabilities,
  type ClaudeAgentSdkAttemptEvidence,
  type ClaudeAgentSdkConfiguration,
  type ClaudeAgentSdkEvidenceSink,
} from "../src/index.js";

type QueryInput = { prompt: string; options?: Options };
type QueryHandle = AsyncIterable<SDKMessage> & { close: () => void };
type QueryFunction = (input: QueryInput) => QueryHandle;

const run = createRunIdentity({
  id: "run-agent-sdk-1",
  taskId: "task-agent-sdk",
  modelId: "claude-test",
  harnessId: "agent-sdk",
});

const configuration: ClaudeAgentSdkConfiguration = {
  prompt: "Inspect the attempt workspace.",
  model: "claude-test",
  tools: ["Read", "Glob"],
  allowedTools: ["Read"],
  disallowedTools: ["Write"],
  permissionMode: "dontAsk",
  maxTurns: 3,
  maxBudgetUsd: 1.25,
  env: { EBO_CHILD_SETTING: "child" },
};

const noOpSink: ClaudeAgentSdkEvidenceSink = {
  message: () => undefined,
  stderr: () => undefined,
  hook: () => undefined,
  lifecycle: () => undefined,
};

test("runs a typed SDK stream in the attempt workspace and records effective manifest facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-success-"));
  const previousParentSetting = process.env.EBO_PARENT_SETTING;
  process.env.EBO_PARENT_SETTING = "parent";
  try {
    let input: QueryInput | undefined;
    const messages: SDKMessage[] = [];
    const hooks: string[] = [];
    const stderr: string[] = [];
    const lifecycle: string[] = [];
    const sink: ClaudeAgentSdkEvidenceSink = {
      flush: () => undefined,
      message: (message) => { messages.push(message); },
      stderr: (data) => { stderr.push(data); },
      hook: (event) => { hooks.push(event); },
      lifecycle: (event) => { lifecycle.push(event.type); },
    };
    const query: QueryFunction = (value) => {
      input = value;
      return stream([
        { type: "assistant", uuid: "assistant-1", session_id: "session-1" } as unknown as SDKMessage,
        sdkResult("success"),
      ], async () => {
        value.options?.stderr?.("non-fatal stderr");
        const callback = value.options?.hooks?.SessionStart?.[0]?.hooks[0];
        await callback?.(
          { hook_event_name: "SessionStart" } as HookInput,
          undefined,
          { signal: new AbortController().signal },
        );
      });
    };

    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, sink, query),
      verifier: async () => ({ status: "passed" }),
      harnessBudgetMs: 5_000,
      evidence: sink,
    });

    assert.equal(result.classification.kind, "completed");
    assert.equal(input?.prompt, configuration.prompt);
    assert.equal(input?.options?.cwd, root);
    assert.equal(input?.options?.model, configuration.model);
    assert.deepEqual(input?.options?.tools, configuration.tools);
    assert.deepEqual(input?.options?.allowedTools, configuration.allowedTools);
    assert.deepEqual(input?.options?.disallowedTools, configuration.disallowedTools);
    assert.equal(input?.options?.permissionMode, configuration.permissionMode);
    assert.equal(input?.options?.maxTurns, configuration.maxTurns);
    assert.equal(input?.options?.maxBudgetUsd, configuration.maxBudgetUsd);
    assert.equal(input?.options?.env?.EBO_PARENT_SETTING, "parent");
    assert.equal(input?.options?.env?.EBO_CHILD_SETTING, "child");
    assert.ok(input?.options?.abortController instanceof AbortController);
    assert.deepEqual(Object.keys(input?.options?.hooks ?? {}).sort(), [...HOOK_EVENTS].sort());
    assert.equal(input?.options?.includeHookEvents, true);
    assert.equal(messages.length, 2);
    assert.deepEqual(stderr, ["non-fatal stderr"]);
    assert.deepEqual(hooks, ["SessionStart"]);
    assert.deepEqual(lifecycle, ["started", "completed"]);

    const evidence = result.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence;
    assert.deepEqual(evidence.runtime, [
      { source: "anthropic", name: "agent-sdk", version: "0.3.251" },
      { source: "anthropic", name: "agent-cli", version: "2.1.251" },
    ]);
    assert.deepEqual(evidence.effectiveConfiguration, {
      model: "claude-test",
      tools: ["Read", "Glob"],
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
      permissionMode: "dontAsk",
      environment: { parentPreserved: true, overridesApplied: true },
      budget: { wallClockMs: 5_000, maxTurns: 3, maxBudgetUsd: 1.25 },
      workingDirectory: "attempt-workspace",
    });
    assert.equal(evidence.capabilities.telemetry.metrics.stability, "stable");
    assert.equal(evidence.capabilities.telemetry.logs.stability, "stable");
    assert.equal(evidence.capabilities.telemetry.traces.stability, "beta");
    assert.deepEqual(Object.keys(evidence.capabilities.hooks).sort(), [...HOOK_EVENTS].sort());
  } finally {
    if (previousParentSetting === undefined) delete process.env.EBO_PARENT_SETTING;
    else process.env.EBO_PARENT_SETTING = previousParentSetting;
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains SDK stderr and classifies API failures as infrastructure", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-failure-"));
  try {
    const query: QueryFunction = (input) => stream([
      sdkResult("error_during_execution", ["API request failed"]),
    ], () => { input.options?.stderr?.("process stderr"); });
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, noOpSink, query),
      evidence: { flush: () => undefined },
    });

    assert.equal(result.classification.kind, "infrastructure-failure");
    assert.equal(result.record.harness?.failureClass, "infrastructure");
    assert.match(result.record.harness?.error ?? "", /API request failed/);
    assert.match(result.record.harness?.error ?? "", /process stderr/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forwards abort through the SDK controller and closes the query", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-abort-"));
  try {
    const external = new AbortController();
    let started!: () => void;
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    let closed = false;
    const query = blockingQuery(() => { started(); }, () => { closed = true; });
    const pending = executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, noOpSink, query),
      signal: external.signal,
      evidence: { flush: () => undefined },
    });
    await queryStarted;
    external.abort("operator");
    const result = await pending;

    assert.equal(result.classification.kind, "interrupted");
    assert.equal(result.record.harness?.status, "interrupted");
    assert.equal(closed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lets the lifecycle enforce timeout as a budget stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-timeout-"));
  try {
    let closed = false;
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, noOpSink, blockingQuery(undefined, () => { closed = true; })),
      harnessBudgetMs: 20,
      shutdownGraceMs: 100,
      evidence: { flush: () => undefined },
    });

    assert.equal(result.classification.kind, "budget-stop");
    assert.equal(result.terminal.stopReason, "budget");
    assert.equal(closed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed configuration before starting the SDK", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-invalid-"));
  try {
    let called = false;
    const invalid = { ...configuration, prompt: "" };
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, invalid, noOpSink, () => {
        called = true;
        return stream([]);
      }),
      evidence: { flush: () => undefined },
    });

    assert.equal(called, false);
    assert.equal(result.classification.kind, "infrastructure-failure");
    assert.match(result.record.harness?.error ?? "", /prompt must be a nonempty string/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires every native evidence callback before starting the SDK", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-sink-"));
  try {
    let called = false;
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, {} as ClaudeAgentSdkEvidenceSink, () => {
        called = true;
        return stream([]);
      }),
      evidence: { flush: () => undefined },
    });

    assert.equal(called, false);
    assert.equal(result.classification.kind, "infrastructure-failure");
    assert.match(result.record.harness?.error ?? "", /requires message, stderr, hook, and lifecycle callbacks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capability probe exposes every public hook and native telemetry stability", () => {
  const capabilities = probeClaudeAgentSdkCapabilities();
  assert.equal(capabilities.sdkVersion, "0.3.251");
  assert.equal(capabilities.claudeCodeVersion, "2.1.251");
  assert.deepEqual(Object.keys(capabilities.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.equal(capabilities.telemetry.metrics.stability, "stable");
  assert.equal(capabilities.telemetry.logs.stability, "stable");
  assert.equal(capabilities.telemetry.traces.stability, "beta");
  assert.equal(capabilities.telemetry.hookSpans.status, "optional");
  assert.deepEqual(capabilities.missingEvidence, []);
});

test("builds a safe correlated telemetry environment without leaking secret settings", () => {
  const built = buildClaudeAgentSdkEnvironment({
    inherited: {
      PATH: "/approved/bin",
      KEEP_PARENT: "parent",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=test",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer collector-secret",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://stale.example.test/v1/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://stale.example.test/v1/metrics",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://stale.example.test/v1/logs",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc",
      OTEL_LOG_USER_PROMPTS: "1",
      OTEL_LOG_TOOL_DETAILS: "1",
      OTEL_LOG_TOOL_CONTENT: "1",
      OTEL_LOG_RAW_API_BODIES: "1",
    },
    overrides: { KEEP_PARENT: "overridden", KEEP_CHILD: "child" },
    telemetry: { endpoint: "http://127.0.0.1:4318", protocol: "http/json" },
    run,
    attempt: { id: "attempt/one", number: 1 },
  });

  assert.equal(built.env.PATH, "/approved/bin");
  assert.equal(built.env.KEEP_PARENT, "overridden");
  assert.equal(built.env.KEEP_CHILD, "child");
  assert.equal(built.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(built.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, "1");
  assert.equal(built.env.CLAUDE_CODE_OTEL_DIAG_STDERR, "1");
  assert.equal(built.env.OTEL_TRACES_EXPORTER, "otlp");
  assert.equal(built.env.OTEL_METRICS_EXPORTER, "otlp");
  assert.equal(built.env.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(built.env.OTEL_METRIC_EXPORT_INTERVAL, "1000");
  assert.equal(built.env.OTEL_LOGS_EXPORT_INTERVAL, "1000");
  assert.equal(built.env.OTEL_TRACES_EXPORT_INTERVAL, "1000");
  assert.equal(built.env.OTEL_LOG_USER_PROMPTS, "0");
  assert.equal(built.env.OTEL_LOG_TOOL_DETAILS, "0");
  assert.equal(built.env.OTEL_LOG_TOOL_CONTENT, "0");
  assert.equal(built.env.OTEL_LOG_RAW_API_BODIES, "0");
  assert.equal(built.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, undefined);
  assert.equal(built.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, undefined);
  assert.equal(built.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, undefined);
  assert.equal(built.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, undefined);
  assert.equal(built.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, undefined);
  assert.equal(built.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, undefined);
  assert.equal(built.env.ENABLE_BETA_TRACING_DETAILED, undefined);
  assert.equal(built.env.BETA_TRACING_ENDPOINT, undefined);
  assert.equal(
    built.env.OTEL_RESOURCE_ATTRIBUTES,
    "deployment.environment=test,ebo.run.id=run-agent-sdk-1,ebo.attempt.id=attempt%2Fone,ebo.attempt.number=1",
  );
  assert.equal(built.telemetry?.effectiveSettings.secretHeadersConfigured, true);
  assert.equal(built.telemetry?.correlation.inheritedResourceAttributesPreserved, true);
  assert.equal(JSON.stringify(built.telemetry).includes("collector-secret"), false);

  const detailed = buildClaudeAgentSdkEnvironment({
    inherited: {},
    telemetry: {
      endpoint: "https://collector.example.test/otlp",
      logUserPrompts: true,
      logToolDetails: true,
      logToolContent: true,
      logRawApiBodies: true,
      detailedHookSpans: { endpoint: "https://collector.example.test/detailed" },
    },
    run,
    attempt: { id: "attempt-1", number: 1 },
  });
  assert.equal(detailed.env.OTEL_LOG_USER_PROMPTS, "1");
  assert.equal(detailed.env.OTEL_LOG_TOOL_DETAILS, "1");
  assert.equal(detailed.env.OTEL_LOG_TOOL_CONTENT, "1");
  assert.equal(detailed.env.OTEL_LOG_RAW_API_BODIES, "1");
  assert.equal(detailed.env.ENABLE_BETA_TRACING_DETAILED, "1");
  assert.equal(detailed.env.BETA_TRACING_ENDPOINT, "https://collector.example.test/detailed");
  assert.deepEqual(detailed.telemetry?.hookSpans, {
    status: "enabled",
    stability: "detailed-beta",
    endpoint: "https://collector.example.test/detailed",
  });
});

test("rejects a console exporter before opening the SDK protocol channel", () => {
  assert.throws(
    () => buildClaudeAgentSdkEnvironment({
      inherited: { OTEL_LOGS_EXPORTER: "otlp, console" },
      run,
      attempt: { id: "attempt-1", number: 1 },
    }),
    /OTEL_LOGS_EXPORTER cannot use the console exporter/,
  );
});

test("records correlated receipt for all three signals through a test HTTP receiver", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-telemetry-receipt-"));
  const requests: Array<{ path: string; body: string }> = [];
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolvePromise) => receiver.listen(0, "127.0.0.1", resolvePromise));
  const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  try {
    const telemetryConfiguration: ClaudeAgentSdkConfiguration = {
      ...configuration,
      telemetry: {
        endpoint,
        protocol: "http/json",
        checkReceipt: (correlation) => {
          const correlated = requests.every(({ body }) => Object.values(correlation.attributes).every((value) => body.includes(value)));
          const signals = requests.flatMap(({ path }) => path === "/v1/traces" ? ["traces" as const]
            : path === "/v1/metrics" ? ["metrics" as const]
              : path === "/v1/logs" ? ["logs" as const] : []);
          return correlated && signals.length === 3
            ? { status: "received", signals }
            : { status: "missing", signals, reason: "partial-receipt" };
        },
      },
    };
    const query: QueryFunction = (input) => stream([sdkResult("success")], async () => {
      const attributes = input.options?.env?.OTEL_RESOURCE_ATTRIBUTES ?? "";
      await Promise.all([
        fetch(`${endpoint}/v1/traces`, { method: "POST", body: JSON.stringify({ attributes, spans: ["claude_code.interaction", "claude_code.llm_request", "claude_code.tool"] }) }),
        fetch(`${endpoint}/v1/metrics`, { method: "POST", body: JSON.stringify({ attributes, metrics: ["claude_code.session.count"] }) }),
        fetch(`${endpoint}/v1/logs`, { method: "POST", body: JSON.stringify({ attributes, events: ["claude_code.user_prompt", "claude_code.tool_result"] }) }),
      ]);
    });
    const result = await executeRunAttempt({
      run,
      attempt: { id: "attempt-receipt", number: 1 },
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, telemetryConfiguration, noOpSink, query),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });

    assert.equal(result.classification.kind, "completed");
    const telemetry = (result.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence).telemetry;
    assert.deepEqual(telemetry?.receipt, { status: "received", signals: ["traces", "metrics", "logs"] });
    assert.equal(requests.find(({ path }) => path === "/v1/traces")?.body.includes("claude_code.tool"), true);
    assert.equal(requests.find(({ path }) => path === "/v1/logs")?.body.includes("claude_code.tool_result"), true);
  } finally {
    await new Promise<void>((resolvePromise, reject) => receiver.close((error) => error === undefined ? resolvePromise() : reject(error)));
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a successful agent result when the collector receipt is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-telemetry-gap-"));
  try {
    const stderr: string[] = [];
    const sink = { ...noOpSink, stderr: (data: string) => { stderr.push(data); } };
    const unreachableConfiguration: ClaudeAgentSdkConfiguration = {
      ...configuration,
      telemetry: {
        endpoint: "http://127.0.0.1:1",
        checkReceipt: () => ({ status: "missing", signals: [], reason: "collector-unreachable" }),
      },
    };
    const query: QueryFunction = (input) => stream([sdkResult("success")], () => {
      input.options?.stderr?.("[3P telemetry] export failed: connection refused");
    });
    const result = await executeRunAttempt({
      run,
      attempt: { id: "attempt-gap", number: 1 },
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, unreachableConfiguration, sink, query),
      verifier: async () => ({ status: "passed" }),
      evidence: { flush: () => undefined },
    });

    assert.equal(result.classification.kind, "completed");
    assert.deepEqual((result.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence).telemetry?.receipt, {
      status: "missing",
      signals: [],
      reason: "collector-unreachable",
    });
    assert.match(stderr.join(""), /\[3P telemetry\].*connection refused/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stream(messages: SDKMessage[], before?: () => void | Promise<void>): QueryHandle {
  return {
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      await before?.();
      for (const message of messages) yield message;
    },
  };
}

function blockingQuery(start?: () => void, close?: () => void): QueryFunction {
  return (input) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const abort = () => { release(); };
    const signal = input.options?.abortController?.signal;
    if (signal?.aborted) release();
    else signal?.addEventListener("abort", abort, { once: true });
    return {
      close: () => { close?.(); release(); },
      async *[Symbol.asyncIterator]() {
        start?.();
        await released;
        signal?.removeEventListener("abort", abort);
      },
    };
  };
}

function sdkResult(
  subtype: SDKResultMessage["subtype"],
  errors: string[] = [],
): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: subtype !== "success",
    errors,
    result: subtype === "success" ? "done" : undefined,
    session_id: "session-1",
    uuid: "result-1",
  } as unknown as SDKMessage;
}
