import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { HookInput, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  captureClaudeAgentSdkRun,
  probeClaudeAgentSdkCapabilities,
  type ClaudeAgentSdkQuery,
  type RunBundleDefinition,
} from "../src/index.js";

const SHA = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;

test("captures and qualifies one caller-supplied Agent SDK run", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-run-"));
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "result.txt"), "before\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  writeFileSync(join(final, "result.txt"), "after\n");
  const capabilities = probeClaudeAgentSdkCapabilities();
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-production-capture",
    run: {
      id: "run-production-capture",
      task: { id: "task-production-capture" },
      fixture: { id: "fixture-production-capture", digest: SHA("a") },
      model: { provider: "anthropic", id: "claude-test" },
      harness: { id: "agent-sdk", version: capabilities.sdkVersion },
      runtime: [
        { source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion },
        { source: "anthropic", name: "agent-cli", version: capabilities.claudeCodeVersion },
      ],
    },
    attempt: { id: "attempt-production-capture", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };
  const query: ClaudeAgentSdkQuery = (input) => ({
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      for (const hook of ["UserPromptSubmit", "SessionStart", "SessionEnd"] as const) {
        await input.options?.hooks?.[hook]?.[0]?.hooks[0]?.({
          hook_event_name: hook,
          session_id: "session-production-capture",
          transcript_path: "/restricted/session.jsonl",
          cwd: final,
        } as HookInput, undefined, { signal: new AbortController().signal });
      }
      yield assistantMessage();
      yield sdkResult();
    },
  });

  try {
    const result = await captureClaudeAgentSdkRun({
      definition,
      startingWorkspacePath: start,
      workspace: {
        setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }),
        cleanup: async () => undefined,
      },
      configuration: {
        prompt: "Update result.txt.",
        model: "claude-test",
        tools: ["Read", "Write"],
        allowedTools: ["Read", "Write"],
        permissionMode: "dontAsk",
        telemetry: {
          endpoint: "http://127.0.0.1:4318",
          checkReceipt: () => ({ status: "received", signals: ["traces", "metrics", "logs"] }),
        },
      },
      expectedHooks: ["UserPromptSubmit", "SessionStart", "SessionEnd"],
      query,
      verifier: async (_context, workspace) => ({
        schemaVersion: "verifier-result/v1",
        bundleId: definition.bundleId,
        status: "passed",
        exitCode: 0,
        workspace: {
          artifactId: workspace.descriptor.id,
          digest: workspace.descriptor.digest,
          fingerprint: workspace.fingerprint,
        },
        assertions: [{ id: "result", status: "passed" }],
      }),
    });

    assert.equal(result.attempt.classification.kind, "completed");
    assert.equal(result.qualification.status, "qualified");
    assert.equal(result.manifest.terminal.state, "completed");
    const descriptor = result.manifest.evidence.find((entry) => entry.kind === "capture-report")!;
    const report = JSON.parse(readFileSync(join(bundleRoot, descriptor.relativePath), "utf8")) as {
      agentSdk: { capabilities: { sdkVersion: string }; effectiveConfiguration: { model: string } };
      structuralQualification: { status: string };
    };
    assert.equal(report.agentSdk.capabilities.sdkVersion, capabilities.sdkVersion);
    assert.equal(report.agentSdk.effectiveConfiguration.model, "claude-test");
    assert.equal(report.structuralQualification.status, "qualified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains interrupted and verifier-error attempts through the single-run entry point", async (context) => {
  for (const scenario of ["interrupted", "verifier-error"] as const) {
    await context.test(scenario, async () => {
      const root = mkdtempSync(join(tmpdir(), `ebo-agent-sdk-run-${scenario}-`));
      const start = join(root, "start");
      const final = join(root, "final");
      const bundleRoot = join(root, "bundle");
      mkdirSync(start);
      writeFileSync(join(start, "result.txt"), "before\n");
      cpSync(start, final, { recursive: true, preserveTimestamps: true });
      writeFileSync(join(final, "result.txt"), "after\n");
      const capabilities = probeClaudeAgentSdkCapabilities();
      const definition: RunBundleDefinition = {
        bundleRoot,
        bundleId: `bundle-${scenario}`,
        run: {
          id: `run-${scenario}`,
          task: { id: "task-partial" },
          fixture: { id: "fixture-partial", digest: SHA("a") },
          model: { provider: "anthropic", id: "claude-test" },
          harness: { id: "agent-sdk", version: capabilities.sdkVersion },
          runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }],
        },
        attempt: { id: `attempt-${scenario}`, number: 1 },
        configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
      };
      const controller = new AbortController();
      const query: ClaudeAgentSdkQuery = () => ({
        close: () => undefined,
        async *[Symbol.asyncIterator]() {
          yield assistantMessage();
          if (scenario === "interrupted") controller.abort("fixture interruption");
          else yield sdkResult();
        },
      });
      try {
        const result = await captureClaudeAgentSdkRun({
          definition,
          startingWorkspacePath: start,
          workspace: {
            setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }),
            cleanup: async () => undefined,
          },
          configuration: {
            prompt: "Update result.txt.", model: "claude-test", tools: [], permissionMode: "dontAsk",
            telemetry: {
              endpoint: "http://127.0.0.1:4318",
              checkReceipt: () => scenario === "interrupted"
                ? { status: "missing", signals: [], reason: "process-interrupted" }
                : { status: "received", signals: ["traces", "metrics", "logs"] },
            },
          },
          query,
          ...(scenario === "interrupted" ? { signal: controller.signal } : {
            verifier: async (_verifierContext, workspace) => ({
              schemaVersion: "verifier-result/v1" as const,
              bundleId: definition.bundleId,
              status: "error" as const,
              error: "verifier failed",
              workspace: {
                artifactId: workspace.descriptor.id,
                digest: workspace.descriptor.digest,
                fingerprint: workspace.fingerprint,
              },
              assertions: [],
            }),
          }),
        });
        assert.equal(result.attempt.classification.kind, scenario === "interrupted" ? "interrupted" : "verifier-error");
        assert.equal(result.manifest.terminal.state, scenario === "interrupted" ? "interrupted" : "failed");
        assert.equal(result.qualification.status, "unqualified");
        const reportDescriptor = result.manifest.evidence.find((entry) => entry.kind === "capture-report")!;
        const report = JSON.parse(readFileSync(join(bundleRoot, reportDescriptor.relativePath), "utf8")) as {
          structuralQualification: { status: string };
        };
        assert.equal(report.structuralQualification.status, "unqualified");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

function assistantMessage(): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-production-capture",
    session_id: "session-production-capture",
    message: { role: "assistant", content: [] },
  } as unknown as SDKMessage;
}

function sdkResult(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-test": { inputTokens: 1, outputTokens: 1, costUSD: 0.01 } },
    permission_denials: [],
    result: "done",
    session_id: "session-production-capture",
    uuid: "result-production-capture",
  } as unknown as SDKResultMessage;
}
