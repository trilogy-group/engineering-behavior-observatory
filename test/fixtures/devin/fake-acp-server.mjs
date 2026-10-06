// Deterministic stand-in for `devin acp` 3000.11.3. Frame shapes follow the
// measured ACP lifecycle: initialize, session/new, session/set_mode,
// session/set_config_option, session/prompt, session/update notifications,
// session/request_permission, _cognition.ai/* notifications, and the
// session/prompt response that ends the turn.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) ?? "success";
if (!process.argv.includes("acp")) {
  process.stderr.write("fake devin: expected the acp subcommand\n");
  process.exit(2);
}
const REASONING_SENTINEL = "FIXTURE-HIDDEN-THOUGHT-7f3a";
const SESSION_ID = "fixture-session";
const FOREIGN_SESSION_ID = "foreign-session";
const TOOL_CALL_ID = "call_fixture0001#abcdef";
const authenticated = [process.env.WINDSURF_API_KEY, process.env.EBO_FAKE_DEVIN_KEY].some((value) => typeof value === "string" && value !== "");
let otel;
try {
  const config = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME ?? "", "devin", "config.json"), "utf8"));
  if (config?.otel?.enabled === true) otel = config.otel;
} catch {
  otel = undefined;
}

let currentMode = "accept-edits";
let currentModel = "swe-2-high";
let nextServerId = 1;
const pendingServerRequests = new Map();
let cancelRequested = false;
let onCancel;
const promptQueue = [];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const serverRequest = (method, params) => new Promise((resolve) => {
  const id = `srv-${nextServerId++}`;
  pendingServerRequests.set(id, resolve);
  send({ id, method, params });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configOptions = () => [
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: currentMode, options: ["accept-edits", "smart", "ask", "plan", "bypass"].map((value) => ({ value, name: value })) },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: ["swe-2-high", "swe-1-7-lightning-medium"].map((value) => ({ value, name: value })) },
];
const modes = () => ({ currentModeId: currentMode, availableModes: ["accept-edits", "smart", "ask", "plan", "bypass"].map((id) => ({ id, name: id })) });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("fake devin: malformed client line\n");
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingServerRequests.get(message.id);
    if (resolve !== undefined) {
      pendingServerRequests.delete(message.id);
      resolve(message.error === undefined ? { result: message.result } : { error: message.error });
    }
    return;
  }
  void handle(message);
});
rl.on("close", async () => {
  if (mode === "ignore-stdin-close") return;
  await exportOtlp("session_end");
  process.exit(0);
});

async function handle(message) {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      send({ id, result: {
        protocolVersion: mode === "protocol-mismatch" ? 2 : 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, delete: {} } },
        authMethods: [{ id: "devin-browser", name: "Log in with browser" }],
        agentInfo: { name: "affogato", title: "Devin Agent", version: "0.0.0-dev" },
      } });
      return;
    case "session/new":
      if (!authenticated) {
        process.stderr.write("fake devin: not authenticated\n");
        send({ id, error: { code: -32000, message: "Not logged in. Run `devin auth login`." } });
        return;
      }
      send({ method: "_cognition.ai/mcp/serversChanged", params: {} });
      update(SESSION_ID, { sessionUpdate: "config_option_update", configOptions: configOptions() });
      update(SESSION_ID, { sessionUpdate: "current_mode_update", currentModeId: currentMode });
      update(SESSION_ID, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "status", description: "Check authentication status" }] });
      await exportOtlp("session_start");
      send({ id, result: { sessionId: SESSION_ID, modes: modes(), configOptions: configOptions() } });
      return;
    case "session/set_mode":
      if (mode !== "mode-mismatch") currentMode = params.modeId;
      update(SESSION_ID, { sessionUpdate: "config_option_update", configOptions: configOptions() });
      update(SESSION_ID, { sessionUpdate: "current_mode_update", currentModeId: currentMode });
      send({ id, result: {} });
      return;
    case "session/set_config_option":
      if (params.configId === "model" && mode !== "model-mismatch") currentModel = params.value;
      if (params.configId === "mode" && mode !== "mode-mismatch") currentMode = params.value;
      update(SESSION_ID, { sessionUpdate: "config_option_update", configOptions: configOptions() });
      send({ id, result: { configOptions: configOptions() } });
      return;
    case "session/cancel":
      cancelRequested = true;
      onCancel?.();
      return;
    case "session/prompt":
      if (params.sessionId !== SESSION_ID) {
        send({ id, error: { code: -32602, message: "Unknown session" } });
        return;
      }
      await prompt(id, params);
      return;
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

async function prompt(id, params) {
  const promptText = params.prompt?.map((block) => block.text ?? "").join("") ?? "";
  if (mode === "prompt-error") {
    send({ id, error: { code: -32000, message: "Model unavailable" } });
    return;
  }
  update(SESSION_ID, { sessionUpdate: "session_info_update", title: promptText.slice(0, 40) });
  update(SESSION_ID, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${REASONING_SENTINEL} I should run a shell command.` } });
  send({ method: "_cognition.ai/thinking_complete", params: { durationMs: 44, blockIndex: 0, sessionId: SESSION_ID } });
  if (mode === "malformed") {
    process.stdout.write("this is not json\n");
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update: "not-an-object" } })}\n`);
  }
  if (mode === "stderr") process.stderr.write("fake devin: diagnostic warning\n");
  if (mode !== "missing-usage") {
    update(SESSION_ID, { sessionUpdate: "usage_update", used: 10938, size: 262000, _meta: { "cognition.ai/inputTokens": 10841, "cognition.ai/outputTokens": 97, "cognition.ai/cachedReadTokens": 8192 } });
  }
  if (mode === "foreign-session") {
    update(FOREIGN_SESSION_ID, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign chatter" } });
    update(FOREIGN_SESSION_ID, { sessionUpdate: "tool_call", toolCallId: "call_foreign", title: "Ran ls", kind: "execute", rawInput: { command: "ls" } });
    update(FOREIGN_SESSION_ID, { sessionUpdate: "usage_update", used: 1, size: 2 });
    send({ method: "_cognition.ai/agent_stopped", params: { cause: "complete", stats: { toolCalls: 9 }, sessionId: FOREIGN_SESSION_ID } });
    await serverRequest("session/request_permission", { sessionId: FOREIGN_SESSION_ID, toolCall: { toolCallId: "call_foreign" }, options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }, { optionId: "reject_once", name: "Reject", kind: "reject_once" }] });
  }
  if (mode === "unsupported-request") {
    await serverRequest("fs/read_text_file", { sessionId: SESSION_ID, path: join(process.cwd(), "README.md") });
  }
  const command = mode === "tool-failure" ? "false; echo \"exit=$?\"" : "printf done > devin-result.txt && cat devin-result.txt";
  update(SESSION_ID, {
    sessionUpdate: "tool_call",
    toolCallId: TOOL_CALL_ID,
    title: mode === "tool-failure" ? "Ran false" : "Ran printf",
    kind: "execute",
    content: [{ type: "content", content: { type: "resource", resource: { mimeType: "text/x-shellscript", text: command, uri: "tool://preview" } } }],
    rawInput: { command },
    _meta: { "cognition.ai/commandNames": [command.split(" ")[0]], "cognition.ai/inferenceToolName": "exec" },
  });
  if (mode === "crash") {
    process.stderr.write("fake devin: panicked before the tool completed\n");
    process.exit(3);
  }
  if (mode === "hang") {
    await new Promise(() => undefined);
  }
  let permitted = true;
  if (mode === "permission" || mode === "permission-without-options") {
    const answer = await serverRequest("session/request_permission", {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: TOOL_CALL_ID, _meta: { "cognition.ai/editableCommand": command } },
      options: mode === "permission-without-options" ? [{ optionId: "allow_always", name: "Always", kind: "allow_always" }] : [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "allow_session", name: "Yes, allow this session", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = answer.result?.outcome;
    permitted = outcome?.outcome === "selected" && String(outcome.optionId).startsWith("allow");
  }
  update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "in_progress", _meta: { "cognition.ai/inferenceToolName": "exec" } });
  await exportOtlp("tool_decision");
  if (mode === "interrupt") {
    await new Promise((resolve) => {
      if (cancelRequested) resolve();
      onCancel = resolve;
      setTimeout(resolve, 10_000);
    });
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "failed", content: [{ type: "content", content: { type: "text", text: "Canceled due to user interrupt" } }], _meta: { "cognition.ai/inferenceToolName": "exec", "cognition.ai/canceled": true } });
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "completed", _meta: { "cognition.ai/inferenceToolName": "exec", terminal_exit: { terminal_id: "049e4c", exit_code: -1, signal: null } } });
    send({ method: "_cognition.ai/agent_stopped", params: { cause: "cancelled", stats: { toolCalls: 1, filesChanged: 0, commandsRun: 1, inputTokens: 10846, outputTokens: 84, modelLabel: "SWE-2 High" }, sessionId: SESSION_ID } });
    send({ id, result: { stopReason: "cancelled", usage: { totalTokens: 10930, inputTokens: 10846, outputTokens: 84 } } });
    return;
  }
  if (!permitted) {
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "failed", content: [{ type: "content", content: { type: "text", text: "User rejected the command" } }], _meta: { "cognition.ai/inferenceToolName": "exec" } });
  } else if (mode === "tool-failure") {
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "in_progress", content: [{ type: "content", content: { type: "text", text: "exit=1" } }], _meta: { "cognition.ai/inferenceToolName": "exec" } });
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "failed", _meta: { "cognition.ai/inferenceToolName": "exec", terminal_exit: { terminal_id: "ac4e0e", exit_code: 1, signal: null } } });
  } else {
    writeFileSync(join(process.cwd(), "devin-result.txt"), "done");
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "in_progress", content: [{ type: "content", content: { type: "text", text: "done" } }], _meta: { "cognition.ai/inferenceToolName": "exec" } });
    // The live CLI reports terminal_exit on an in_progress update and sends the terminal "completed" update without it.
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "in_progress", _meta: { "cognition.ai/inferenceToolName": "exec", terminal_exit: { terminal_id: "ac4e0e", exit_code: 0, signal: null } } });
    update(SESSION_ID, { sessionUpdate: "tool_call_update", toolCallId: TOOL_CALL_ID, status: "completed", _meta: { "cognition.ai/inferenceToolName": "exec" } });
  }
  await exportOtlp("tool_result");
  update(SESSION_ID, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: permitted && mode !== "tool-failure" ? "DONE" : "The command did not succeed." } });
  const responseDimensions = [
    { uid: "agent_messages", groupTitle: "Response Statistics", label: "Agent messages", kind: { type: "cumulativeMetric", value: 2 } },
    { uid: "model", groupTitle: "Response Statistics", label: "Model", kind: { type: "metric", value: "SWE-2 High" } },
    { uid: "input_tokens", groupTitle: "Token Usage", label: "Input tokens", kind: { type: "cumulativeMetric", value: 2794 } },
    { uid: "output_tokens", groupTitle: "Token Usage", label: "Output tokens", kind: { type: "cumulativeMetric", value: 118 } },
    { uid: "cached_input_tokens", groupTitle: "Token Usage", label: "Cached input tokens", kind: { type: "cumulativeMetric", value: 19032 } },
  ];
  send({ method: "_cognition.ai/turn_stats", params: { sessionId: SESSION_ID, turnClientMessageId: "msg-1", responseDimensions, turnRequestId: "req-1" } });
  if (mode !== "no-agent-stopped") {
    send({ method: "_cognition.ai/agent_stopped", params: {
      cause: "complete",
      stats: { toolCalls: 1, filesChanged: 0, commandsRun: 1, inputTokens: 10985, outputTokens: 21, ttftMs: 3031, tokensPerSec: 1615.38, totalTimeMs: 3044, requestId: "req-1", modelLabel: "SWE-2 High", responseDimensions: mode === "missing-usage" ? [] : responseDimensions },
      sessionId: SESSION_ID,
    } });
  }
  send({ id, result: {
    stopReason: mode === "max-tokens" ? "max_tokens" : "end_turn",
    ...(mode === "missing-usage" ? {} : { usage: { totalTokens: 11006, inputTokens: 10985, outputTokens: 21, cachedReadTokens: 10840 } }),
    _meta: { "cognition.ai/userMessageId": "msg-1" },
  } });
}

// --- OTLP protobuf export -------------------------------------------------
const varint = (value) => {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Buffer.from(bytes);
};
const field = (number, wireType) => varint((number << 3) | wireType);
const lengthDelimited = (number, bytes) => Buffer.concat([field(number, 2), varint(bytes.length), bytes]);
const stringField = (number, text) => lengthDelimited(number, Buffer.from(text, "utf8"));
const fixed64 = (number, value) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(value)); return Buffer.concat([field(number, 1), buffer]); };
const sfixed64 = (number, value) => { const buffer = Buffer.alloc(8); buffer.writeBigInt64LE(BigInt(value)); return Buffer.concat([field(number, 1), buffer]); };
const varintField = (number, value) => Buffer.concat([field(number, 0), varint(value)]);
const anyString = (text) => stringField(1, text);
const anyInt = (value) => varintField(3, value);
const keyValue = (key, anyValue) => lengthDelimited(0, Buffer.alloc(0)).subarray(0, 0).length === 0
  ? Buffer.concat([stringField(1, key), lengthDelimited(2, anyValue)]) : Buffer.alloc(0);
const attribute = (key, anyValue) => lengthDelimited(1, keyValue(key, anyValue));
const resource = () => lengthDelimited(1, Buffer.concat([
  attribute("service.name", anyString("devin-local")),
  attribute("service.version", anyString("3000.11.3")),
  attribute("session.id", anyString(SESSION_ID)),
  ...Object.entries(otel?.resource_attributes ?? {}).map(([key, value]) => attribute(key, anyString(String(value)))),
]));
const nowNanos = () => BigInt(Date.now()) * 1_000_000n;
function logsRequest(eventName) {
  const logRecord = Buffer.concat([
    fixed64(1, nowNanos()),
    varintField(2, 9),
    stringField(3, "INFO"),
    lengthDelimited(5, anyString(eventName)),
    lengthDelimited(6, keyValue("session_id", anyString(SESSION_ID))),
    lengthDelimited(6, keyValue("request_id", anyString("req-1"))),
    lengthDelimited(6, keyValue("input_tokens", anyInt(10985))),
    ...(mode === "otlp-secret" ? [lengthDelimited(6, keyValue("api_key", anyString(process.env.EBO_FAKE_DEVIN_KEY ?? "")))] : []),
    fixed64(11, nowNanos()),
    stringField(12, eventName),
  ]);
  const scopeLogs = lengthDelimited(2, Buffer.concat([lengthDelimited(1, stringField(1, "devin")), lengthDelimited(2, logRecord)]));
  return lengthDelimited(1, Buffer.concat([resource(), scopeLogs]));
}
function metricsRequest() {
  const dataPoint = (type, value) => lengthDelimited(1, Buffer.concat([
    fixed64(2, nowNanos()), fixed64(3, nowNanos()), sfixed64(6, value), lengthDelimited(7, keyValue("type", anyString(type))),
  ]));
  const sum = lengthDelimited(7, Buffer.concat([dataPoint("input", 10985), dataPoint("output", 21), dataPoint("cache_read", 10840), varintField(2, 1), varintField(3, 1)]));
  const metric = lengthDelimited(2, Buffer.concat([stringField(1, "devin.token.usage"), stringField(3, "{token}"), sum]));
  const scopeMetrics = lengthDelimited(2, Buffer.concat([lengthDelimited(1, stringField(1, "devin")), metric]));
  return lengthDelimited(1, Buffer.concat([resource(), scopeMetrics]));
}
async function exportOtlp(eventName) {
  if (otel === undefined) return;
  const post = (endpoint, body, contentType = "application/x-protobuf") => new Promise((resolve) => {
    if (typeof endpoint !== "string") return resolve();
    const url = new URL(endpoint);
    const outgoing = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": contentType, "content-length": body.length } }, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    outgoing.on("error", resolve);
    outgoing.end(body);
  });
  if (mode === "otlp-malformed") {
    await post(otel.logs_endpoint, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f, 0x00]));
    return;
  }
  await post(otel.logs_endpoint, logsRequest(eventName));
  if (eventName === "tool_result" || eventName === "session_end") await post(otel.metrics_endpoint, metricsRequest());
}
