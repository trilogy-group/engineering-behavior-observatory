#!/usr/bin/env node
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("codex-cli 0.150.1"); process.exit(0); }
if (process.argv.includes("--bundled")) { console.log(JSON.stringify({ models: [{ slug: "fixture", apply_patch_tool_type: "freeform" }] })); process.exit(0); }
assert.equal(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.EBO_JUDGE_SECRET_SENTINEL, undefined);
assert.deepEqual(readdirSync(process.cwd()), []);
assert.ok(!readdirSync(process.env.CODEX_HOME).includes("config.toml"));
assert.ok(readFileSync(join(process.env.CODEX_HOME, "instructions.md"), "utf8").includes("no tools"));
const emit = (value) => console.log(JSON.stringify(value));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") emit({ id, result: {} });
  if (method === "thread/start") {
    assert.equal(params.config.features.shell_tool, false);
    assert.equal(params.config.features.plugins, false);
    assert.deepEqual(params.config.mcp_servers, {});
    const model = JSON.parse(readFileSync(params.config.model_catalog_json, "utf8")).models[0];
    assert.equal(model.apply_patch_tool_type, null);
    assert.deepEqual(model.experimental_supported_tools, []);
    emit({ id, result: { thread: { id: "judge-thread", ephemeral: true }, model: params.model, modelProvider: "openai",
      approvalPolicy: "never", reasoningEffort: params.config.model_reasoning_effort, sandbox: { type: "readOnly", networkAccess: false }, instructionSources: [] } });
  }
  if (method === "turn/start") {
    emit({ id, result: { turn: { id: "judge-turn" } } });
    const prompt = params.input[0].text;
    if (prompt === "partial-timeout") {
      emit({ method: "item/agentMessage/delta", params: { threadId: "judge-thread", turnId: "judge-turn", itemId: "partial", delta: "PARTIAL_MODEL_OUTPUT" } });
      continue;
    }
    if (prompt.includes("CLI_INTERRUPT_FIXTURE")) {
      writeFileSync(`${process.argv[1]}.ready`, String(process.pid));
      continue;
    }
    if (prompt === "late") {
      process.on("SIGINT", () => setTimeout(() => {
        emit({ method: "item/completed", params: { threadId: "judge-thread", turnId: "judge-turn", item: { type: "agentMessage", id: "late", text: "{}" } } });
        emit({ method: "turn/completed", params: { threadId: "judge-thread", turn: { id: "judge-turn", status: "completed" } } });
      }, 10));
      continue;
    }
    if (prompt === "timeout") continue;
    if (prompt === "exit") process.exit(2);
    setTimeout(() => {
      if (prompt === "foreign") { emit({ method: "turn/completed", params: { threadId: "foreign", turn: { id: "judge-turn", status: "completed" } } }); return; }
      if (prompt === "tool") { emit({ id: 999, method: "item/tool/call", params: {} }); return; }
      const response = { judgment: { disposition: "abstained", assessment: null, confidence: null, reason: "Synthetic evidence absent.", missingEvidenceCapability: null,
        rationale: "Synthetic test.", alternativeExplanation: "No conclusion is supported.", citations: [] } };
      emit({ method: "item/completed", params: { threadId: "judge-thread", turnId: "judge-turn", item: { type: "agentMessage", id: "answer", text: prompt === "malformed" || prompt.includes("MALFORMED_OUTPUT_FIXTURE") ? "invalid JSON" : JSON.stringify(response) } } });
      emit({ method: "turn/completed", params: { threadId: "judge-thread", turn: { id: "judge-turn", status: "completed" } } });
    }, 5);
  }
}
