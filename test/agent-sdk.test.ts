import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HOOK_EVENTS,
  type HookEvent,
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
  openClaudeAgentSdkHookCapture,
  openClaudeAgentSdkStreamCapture,
  probeClaudeAgentSdkCapabilities,
  type ClaudeAgentSdkAttemptEvidence,
  type ClaudeAgentSdkConfiguration,
  type ClaudeAgentSdkEvidenceSink,
  type ClaudeAgentSdkHookRecord,
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

const hookBase = {
  session_id: "session-hooks",
  transcript_path: "/restricted/session-hooks.jsonl",
  cwd: "/attempt/workspace",
  prompt_id: "prompt-hooks",
  agent_id: "agent-hooks",
  agent_type: "general-purpose",
} as const;

const hookFixtures = {
  PreToolUse: { ...hookBase, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "tool-pre" },
  PostToolUse: { ...hookBase, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, tool_response: {}, tool_use_id: "tool-post" },
  PostToolUseFailure: { ...hookBase, hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_input: {}, tool_use_id: "tool-failed", error: "failed" },
  PostToolBatch: { ...hookBase, hook_event_name: "PostToolBatch", tool_calls: [{ tool_name: "Read", tool_input: {}, tool_use_id: "tool-batch", tool_response: {} }] },
  Notification: { ...hookBase, hook_event_name: "Notification", message: "working", notification_type: "status" },
  UserPromptSubmit: { ...hookBase, hook_event_name: "UserPromptSubmit", prompt: "Inspect the workspace." },
  UserPromptExpansion: { ...hookBase, hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "review", command_args: "", prompt: "Review." },
  SessionStart: { ...hookBase, hook_event_name: "SessionStart", source: "startup" },
  SessionEnd: { ...hookBase, hook_event_name: "SessionEnd", reason: "other" },
  Stop: { ...hookBase, hook_event_name: "Stop", stop_hook_active: false },
  StopFailure: { ...hookBase, hook_event_name: "StopFailure", error: "unknown" },
  SubagentStart: { ...hookBase, hook_event_name: "SubagentStart" },
  SubagentStop: { ...hookBase, hook_event_name: "SubagentStop", stop_hook_active: false, agent_transcript_path: "/restricted/agent-hooks.jsonl" },
  PreCompact: { ...hookBase, hook_event_name: "PreCompact", trigger: "auto", custom_instructions: "retain facts" },
  PostCompact: { ...hookBase, hook_event_name: "PostCompact", trigger: "auto", compact_summary: "summary" },
  PreModelSwitch: { ...hookBase, hook_event_name: "PreModelSwitch", from_model: "claude-a", to_model: "claude-b", requested_model: "claude-b", source: "sdk", context_tokens: 10, prompt_cache_warm: true, cache_ttl: "5m", estimated_cache_write_usd: 0, pricing: "catalog" },
  PostModelSwitch: { ...hookBase, hook_event_name: "PostModelSwitch", from_model: "claude-a", to_model: "claude-b", requested_model: "claude-b", source: "sdk", context_tokens: 10, prompt_cache_warm: true, cache_ttl: "5m", estimated_cache_write_usd: 0, pricing: "catalog" },
  PermissionRequest: { ...hookBase, hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: {} },
  PermissionDenied: { ...hookBase, hook_event_name: "PermissionDenied", tool_name: "Write", tool_input: {}, tool_use_id: "tool-denied", reason: "policy" },
  Setup: { ...hookBase, hook_event_name: "Setup", trigger: "init" },
  TeammateIdle: { ...hookBase, hook_event_name: "TeammateIdle", teammate_name: "worker", team_name: "team" },
  TaskCreated: { ...hookBase, hook_event_name: "TaskCreated", task_id: "task-created", task_subject: "Created task" },
  TaskCompleted: { ...hookBase, hook_event_name: "TaskCompleted", task_id: "task-completed", task_subject: "Completed task" },
  Elicitation: { ...hookBase, hook_event_name: "Elicitation", mcp_server_name: "server", message: "Choose." },
  ElicitationResult: { ...hookBase, hook_event_name: "ElicitationResult", mcp_server_name: "server", action: "decline" },
  ConfigChange: { ...hookBase, hook_event_name: "ConfigChange", source: "project_settings", file_path: "/attempt/workspace/.claude/settings.json" },
  WorktreeCreate: { ...hookBase, hook_event_name: "WorktreeCreate", name: "feature" },
  WorktreeRemove: { ...hookBase, hook_event_name: "WorktreeRemove", worktree_path: "/attempt/worktree" },
  InstructionsLoaded: { ...hookBase, hook_event_name: "InstructionsLoaded", file_path: "/attempt/workspace/CLAUDE.md", memory_type: "Project", load_reason: "session_start" },
  CwdChanged: { ...hookBase, hook_event_name: "CwdChanged", old_cwd: "/attempt/workspace", new_cwd: "/attempt/workspace/subdir" },
  FileChanged: { ...hookBase, hook_event_name: "FileChanged", file_path: "/attempt/workspace/file.ts", event: "change" },
  DirectoryAdded: { ...hookBase, hook_event_name: "DirectoryAdded", directory: "/attempt/other", source: "register_repo_root" },
  MessageDisplay: { ...hookBase, hook_event_name: "MessageDisplay", turn_id: "turn-hooks", message_id: "message-hooks", index: 0, final: true, delta: "Done." },
} satisfies { [Event in HookEvent]: Extract<HookInput, { hook_event_name: Event }> };

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
    assert.deepEqual(evidence.usage, {
      source: "sdk-result",
      totalCostUsd: 0.25,
      numTurns: 1,
      mainLoop: { input_tokens: 1, output_tokens: 2 },
      byModel: { "claude-test": { inputTokens: 1, outputTokens: 2, costUSD: 0.25 } },
    });
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

test("keeps a typed budget result authoritative when the SDK stream later fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-budget-result-"));
  try {
    const query: QueryFunction = () => ({
      close: () => undefined,
      async *[Symbol.asyncIterator]() {
        yield sdkResult("error_max_budget_usd", ["Reached maximum budget"]);
        throw new Error("transport failed after result");
      },
    });
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, noOpSink, query),
      evidence: { flush: () => undefined },
    });

    assert.equal(result.classification.kind, "budget-stop");
    assert.equal(result.terminal.stopReason, "budget");
    assert.match(result.record.harness?.error ?? "", /Reached maximum budget/);
    assert.match(result.record.harness?.error ?? "", /transport failed after result/);
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

test("persists every pinned typed hook in ordered restricted JSONL with neutral outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-hooks-"));
  const capture = await openClaudeAgentSdkHookCapture(
    join(root, "hooks.jsonl"),
    (() => {
      let timestamp = Date.parse("2026-08-31T00:00:00.000Z");
      return () => new Date(timestamp++).toISOString();
    })(),
  );
  try {
    const callbackOutputs: unknown[] = [];
    const sink: ClaudeAgentSdkEvidenceSink = {
      ...noOpSink,
      flush: capture.flush,
      hook: capture.hook,
    };
    const query: QueryFunction = (input) => stream([sdkResult("success")], async () => {
      for (const event of HOOK_EVENTS) {
        const callback = input.options?.hooks?.[event]?.[0]?.hooks[0];
        assert.ok(callback, `missing ${event} callback`);
        const signal = new AbortController();
        if (event === HOOK_EVENTS.at(-1)) signal.abort("fixture");
        callbackOutputs.push(await callback(hookFixtures[event], callbackToolUseId(hookFixtures[event]), { signal: signal.signal }));
      }
    });
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-hooks", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, sink, query),
      verifier: async () => ({ status: "passed" }),
      evidence: sink,
    });

    assert.equal(result.classification.kind, "completed");
    assert.deepEqual(callbackOutputs, HOOK_EVENTS.map(() => ({})));
    const records = readFileSync(capture.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ClaudeAgentSdkHookRecord);
    assert.deepEqual(records.map((record) => record.sequence), HOOK_EVENTS.map((_, index) => index + 1));
    assert.deepEqual(records.map((record) => record.hook), HOOK_EVENTS);
    assert.deepEqual(records.map((record) => record.nativePayload), HOOK_EVENTS.map((event) => hookFixtures[event]));
    assert.deepEqual(records.map((record) => record.callbackOutput), HOOK_EVENTS.map(() => ({})));
    assert.deepEqual(records[0], {
      schemaVersion: "ebo.claude-agent-hook/v1",
      sequence: 1,
      callbackAt: "2026-08-31T00:00:00.000Z",
      hook: "PreToolUse",
      sessionId: hookBase.session_id,
      transcriptPath: hookBase.transcript_path,
      cwd: hookBase.cwd,
      promptId: hookBase.prompt_id,
      toolUseId: "tool-pre",
      agentId: hookBase.agent_id,
      agentType: hookBase.agent_type,
      signalAborted: false,
      callbackOutput: {},
      nativePayload: hookFixtures.PreToolUse,
    });
    assert.equal(records.at(-1)?.signalAborted, true);
    assert.deepEqual((result.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence).captureWarnings, {
      count: 0,
      diagnostic: "",
      sizeBytes: 0,
      truncated: false,
    });
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("contains hook sink failure as a capture warning while returning neutral output", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-hook-failure-"));
  const capture = await openClaudeAgentSdkHookCapture(join(root, "hooks.jsonl"));
  await capture.close();
  try {
    let callbackOutput: unknown;
    const sink: ClaudeAgentSdkEvidenceSink = { ...noOpSink, flush: () => undefined, hook: capture.hook };
    const query: QueryFunction = (input) => stream([sdkResult("success")], async () => {
      callbackOutput = await input.options?.hooks?.PreToolUse?.[0]?.hooks[0]?.(
        hookFixtures.PreToolUse,
        "tool-pre",
        { signal: new AbortController().signal },
      );
    });
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-hook-failure", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, sink, query),
      verifier: async () => ({ status: "passed" }),
      evidence: sink,
    });

    assert.equal(result.classification.kind, "capture-incomplete");
    assert.equal(result.classification.underlying, "completed");
    assert.equal(result.record.harness?.status, "completed");
    assert.match(result.record.harness?.captureError ?? "", /hook capture reported 1 warning/);
    assert.equal(result.record.capture?.status, "incomplete");
    assert.deepEqual(callbackOutput, {});
    const warnings = (result.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence).captureWarnings;
    assert.equal(warnings.count, 1);
    assert.match(warnings.diagnostic, /"type":"hook-capture-warning"/);
    assert.match(warnings.diagnostic, /"hook":"PreToolUse"/);
    assert.match(warnings.diagnostic, /JSONL evidence writer is closed/);
    assert.equal(warnings.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains a multi-megabyte typed hook callback within the fixed hook bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-large-hook-"));
  const capture = await openClaudeAgentSdkHookCapture(join(root, "hooks.jsonl"));
  try {
    await capture.hook("PostToolUse", {
      hook_event_name: "PostToolUse",
      session_id: "session-large-hook",
      transcript_path: "/restricted/transcript.jsonl",
      cwd: "/workspace",
      tool_name: "Bash",
      tool_input: { command: "test" },
      tool_response: { stdout: "x".repeat(2 * 1024 * 1024), optional: undefined },
      tool_use_id: "tool-large-hook",
    } as HookInput, "tool-large-hook", new AbortController().signal);
    await capture.close();
    const record = JSON.parse(readFileSync(join(root, "hooks.jsonl"), "utf8"));
    assert.equal(record.sequence, 1);
    assert.equal(record.nativePayload.tool_response.stdout.length, 2 * 1024 * 1024);
    assert.equal("optional" in record.nativePayload.tool_response, false);
  } finally {
    await capture.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("capability probe separates hook callbacks, telemetry stability, and optional detailed-beta timing", () => {
  const capabilities = probeClaudeAgentSdkCapabilities();
  assert.equal(capabilities.sdkVersion, "0.3.251");
  assert.equal(capabilities.claudeCodeVersion, "2.1.251");
  assert.deepEqual(Object.keys(capabilities.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.ok(Object.values(capabilities.hooks).every((hook) => hook.status === "available" && hook.evidence === "callback"));
  assert.deepEqual(capabilities.unsupportedHooks, []);
  assert.equal(capabilities.hookOccurrenceAuthority, "hooks.jsonl");
  assert.equal(capabilities.telemetry.metrics.stability, "stable");
  assert.equal(capabilities.telemetry.logs.stability, "stable");
  assert.equal(capabilities.telemetry.traces.stability, "beta");
  assert.equal(capabilities.telemetry.hookSpans.status, "optional");
  assert.deepEqual(capabilities.detailedBetaHookSpanTiming.status, "unsupported");
  assert.equal(capabilities.detailedBetaHookSpanTiming.optional, true);
  assert.deepEqual(capabilities.missingEvidence.map((entry) => entry.capability), ["detailed-beta-hook-span-timing"]);
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

test("persists typed native messages in arrival order with public result identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-capture-"));
  const path = join(root, "session.jsonl");
  const messages = nativeFixtureMessages();
  let tick = 0;
  const capturedAt = messages.map((_, index) => `2026-08-31T00:00:0${index}.000Z`);
  const capture = await openClaudeAgentSdkStreamCapture(path, noOpSink, () => capturedAt[tick++]!);
  try {
    for (const message of messages) await capture.message(message);
    await capture.flush();

    const records = readJsonl(path);
    assert.deepEqual(records.map((record) => record.sequence), [1, 2, 3, 4]);
    assert.deepEqual(records.map((record) => record.capturedAt), capturedAt);
    assert.deepEqual(records.map((record) => record.nativeType), ["user", "assistant", "user", "result"]);
    assert.deepEqual(records.map((record) => record.message), messages);
    assert.deepEqual(capture.report(), {
      schemaVersion: "ebo.agent-sdk-capture/v1",
      status: "complete",
      artifact: {
        path,
        kind: "session",
        authority: "semantic",
        mediaType: "application/x-ndjson",
        sharingClass: "restricted",
      },
      capabilities: {
        typedMessageStream: { status: "available", messageCount: 4 },
        sessionIdentity: { status: "available", sessionId: "session-1", source: "sdk-result.session_id" },
      },
      result: { uuid: "result-1", subtype: "success", sessionId: "session-1" },
      diagnostics: { count: 0, retained: [], truncated: false },
    });
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("forced interruption retains each fully received message as a readable partial capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-partial-"));
  const path = join(root, "session.jsonl");
  const capture = await openClaudeAgentSdkStreamCapture(path, noOpSink);
  try {
    const external = new AbortController();
    let firstPersisted!: () => void;
    const persisted = new Promise<void>((resolve) => { firstPersisted = resolve; });
    const first = nativeFixtureMessages()[1]!;
    const pending = executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, capture, interruptibleStream(first, firstPersisted)),
      signal: external.signal,
      evidence: capture,
    });
    await persisted;
    external.abort("forced interruption");
    const result = await pending;

    assert.equal(result.classification.kind, "interrupted");
    assert.deepEqual(readJsonl(path).map((record) => record.message), [first]);
    assert.deepEqual(capture.report().capabilities, {
      typedMessageStream: { status: "available", messageCount: 1 },
      sessionIdentity: { status: "available", sessionId: "session-1", source: "sdk-message.session_id" },
    });
    assert.equal(capture.report().status, "partial");
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains unknown future message types with bounded diagnostics without failing the attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-unknown-"));
  const path = join(root, "session.jsonl");
  const capture = await openClaudeAgentSdkStreamCapture(path, noOpSink);
  const futureMessages = Array.from({ length: 40 }, (_, index) => ({
    type: `future_message_${index}`,
    session_id: "session-1",
    payload: { index },
  } as unknown as SDKMessage));
  try {
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, capture, () => stream([...futureMessages, sdkResult("success")])),
      verifier: async () => ({ status: "passed" }),
      evidence: capture,
    });

    assert.equal(result.classification.kind, "completed");
    const records = readJsonl(path);
    assert.equal(records.length, 41);
    assert.deepEqual(records.slice(0, 40).map((record) => record.message), futureMessages);
    assert.deepEqual(capture.report().diagnostics, {
      count: 40,
      retained: futureMessages.slice(0, 32).map((message, index) => ({
        sequence: index + 1,
        code: "unknown-native-type",
        nativeType: (message as unknown as { type: string }).type,
      })),
      truncated: true,
    });
    assert.equal(capture.report().status, "complete");
  } finally {
    await capture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps an append failure visible through lifecycle flushes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-append-failure-"));
  const path = join(root, "session.jsonl");
  const capture = await openClaudeAgentSdkStreamCapture(path, noOpSink);
  const valid = nativeFixtureMessages()[0]!;
  const invalid = { type: "future_message", payload: { invalid: 1n } } as unknown as SDKMessage;
  try {
    const result = await executeRunAttempt({
      run,
      workspace: { setup: async () => ({ status: "ready", path: root, artifactId: "workspace-1", retained: true }) },
      harness: (context) => executeClaudeAgentSdk(context, configuration, capture, () => stream([valid, invalid])),
      evidence: capture,
    });

    assert.equal(result.classification.kind, "capture-incomplete");
    assert.equal(result.record.capture?.status, "incomplete");
    assert.match(result.record.capture?.error ?? "", /JSON/);
    assert.deepEqual(readJsonl(path).map((record) => record.message), [valid]);
    assert.equal(capture.report().status, "partial");
  } finally {
    await capture.close();
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

function interruptibleStream(message: SDKMessage, persisted: () => void): QueryFunction {
  return (input) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const signal = input.options?.abortController?.signal;
    const abort = () => { release(); };
    if (signal?.aborted) release();
    else signal?.addEventListener("abort", abort, { once: true });
    return {
      close: release,
      async *[Symbol.asyncIterator]() {
        yield message;
        persisted();
        await released;
        signal?.removeEventListener("abort", abort);
      },
    };
  };
}

function nativeFixtureMessages(): SDKMessage[] {
  return [
    {
      type: "user",
      uuid: "prompt-1",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: { role: "user", content: "Inspect the attempt workspace." },
    } as unknown as SDKMessage,
    {
      type: "assistant",
      uuid: "assistant-1",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: {
        id: "message-1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as unknown as SDKMessage,
    {
      type: "user",
      uuid: "tool-result-1",
      session_id: "session-1",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "README" }] },
    } as unknown as SDKMessage,
    sdkResult("success"),
  ];
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sdkResult(
  subtype: SDKResultMessage["subtype"],
  errors: string[] = [],
): SDKMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: subtype !== "success",
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.25,
    usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: { "claude-test": { inputTokens: 1, outputTokens: 2, costUSD: 0.25 } },
    permission_denials: [],
    ...(subtype === "success" ? { result: "done" } : { errors }),
    session_id: "session-1",
    uuid: "result-1",
  } as unknown as SDKMessage;
}

function callbackToolUseId(input: HookInput): string | undefined {
  if ("tool_use_id" in input && typeof input.tool_use_id === "string") return input.tool_use_id;
  return input.hook_event_name === "PermissionRequest" ? "tool-permission" : undefined;
}
