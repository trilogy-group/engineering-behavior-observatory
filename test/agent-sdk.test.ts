import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    assert.equal(evidence.capabilities.betaTelemetry.status, "unsupported");
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
      harness: (context) => executeClaudeAgentSdk(context, configuration, {}, query),
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
      harness: (context) => executeClaudeAgentSdk(context, configuration, {}, query),
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
      harness: (context) => executeClaudeAgentSdk(context, configuration, {}, blockingQuery(undefined, () => { closed = true; })),
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
      harness: (context) => executeClaudeAgentSdk(context, invalid, {}, () => {
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

test("capability probe exposes every public hook and explicit missing telemetry", () => {
  const capabilities = probeClaudeAgentSdkCapabilities();
  assert.equal(capabilities.sdkVersion, "0.3.251");
  assert.equal(capabilities.claudeCodeVersion, "2.1.251");
  assert.deepEqual(Object.keys(capabilities.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.equal(capabilities.betaTelemetry.status, "unsupported");
  assert.deepEqual(capabilities.missingEvidence.map((entry) => entry.capability), ["beta-telemetry"]);
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
