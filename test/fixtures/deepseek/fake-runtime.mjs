import { createInterface } from "node:readline";

const scenario = process.env.FAKE_SCENARIO ?? "success";

if (scenario === "contaminated") {
  process.stdout.write("not-json\n");
  process.stderr.write(`runtime diagnostic ${process.env.FAKE_SECRET ?? ""}\n`);
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (scenario === "contaminated") {
      setImmediate(() => process.exit(2));
      return;
    }
    respond(request.id, { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "fake-1.0.0" } });
    return;
  }
  if (request.method === "session/prompt") {
    const sessionId = request.params.sessionId;
    const messageId = "message-fixture-1";
    respond(request.id, { messageId });
    notify("session.status", { sessionId, status: "running" });
    emitEvent(sessionId, 1, "turn/start", { turn: 1 });
    emitEvent(sessionId, 2, "agent/inbox/spliced", { inserted: [{ id: messageId }] });
    emitEvent(sessionId, 3, "user/message", { role: "user", content: request.params.contentBlocks }, { surfaceOp: "append" });
    emitEvent(sessionId, 4, "step/start", { turn: 1, step: 1 });
    emitEvent(sessionId, 5, "request/header", { header: { model: "fake-model" }, reason: "initial" });
    emitEvent(sessionId, 6, "assistant/chunk", { turn: 1, step: 1, chunk: { type: "text", text: "working" } });
    emitEvent(sessionId, 7, "tool/call", { turn: 1, step: 1, callId: "call-1", name: "read", arguments: "{}" });
    emitEvent(sessionId, 8, "tool/result", { turn: 1, step: 1, message: { role: "user", content: [{ type: "tool-result", toolCallId: "call-1", content: "ok" }] } }, { surfaceOp: "append", sourceEventSeqs: [7] });
    emitEvent(sessionId, 9, "compaction/start", { turn: 1 });
    emitEvent(sessionId, 10, "compaction/summary", { summary: "fixture summary" }, { ignorable: true });
    emitEvent(sessionId, 11, "compaction/end", { turn: 1 });
    emitEvent(sessionId, 12, "hook/invoked", { handlerId: "hook-1", hook: "PreToolUse" }, { ignorable: true });
    emitEvent(sessionId, 13, "hook/result", { handlerId: "hook-1", decision: "allow" }, { ignorable: true });
    emitEvent(sessionId, 14, "assistant/message", {
      turn: 1,
      step: 1,
      message: { role: "assistant", provider: "fake", model: "fake-model", content: [{ type: "text", text: "done" }] },
    }, { surfaceOp: "append", sourceEventSeqs: [6] });
    emitEvent(sessionId, 15, "step/end", { turn: 1, step: 1 });
    emitEvent(sessionId, 16, "validation/result", { status: "passed" }, { ignorable: true });
    emitEvent(sessionId, 17, "artifact/changed", { name: "result.txt" }, { ignorable: true });
    notify("subagent.started", { parentSessionId: sessionId, childSessionId: "child-fixture-1" });
    emitEvent("child-fixture-1", 1, "assistant/message", {
      turn: 1,
      step: 1,
      message: { role: "assistant", provider: "fake", model: "fake-model", content: [{ type: "text", text: "child done" }] },
    }, { surfaceOp: "append" });
    notify("subagent.finished", {
      provider: "fake",
      agentId: "child-fixture-1",
      parentSessionId: sessionId,
      childSessionId: "child-fixture-1",
      status: "ok",
      stopReason: { kind: "completed" },
      lastAssistantMessage: [{ type: "text", text: "child done" }],
    });
    if (scenario === "interrupt") return;
    emitEvent(sessionId, 18, "plugin/private", { privateFact: "retained-only" }, { ignorable: true });
    emitEvent(sessionId, 19, "turn/end", { turn: 1, reason: { kind: "completed" } });
    notify("session.status", { sessionId, status: "idle" });
    return;
  }
  if (request.method === "shutdown") {
    respond(request.id, {});
    setImmediate(() => process.exit(0));
  }
});

function emitEvent(sessionId, seq, type, data, extra = {}) {
  notify("session.event", { sessionId, event: { type, seq, time: 1788332400000 + seq, data, ...extra } });
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
