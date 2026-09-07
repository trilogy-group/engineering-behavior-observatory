import readline from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.slice(7) ?? "success";
const endpoints = process.argv.flatMap((argument) => [...argument.matchAll(/endpoint = \"([^\"]+)\"/g)].map((match) => match[1]));
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let approvalPending = false;

async function emitTurn() {
  send({ method: "unknown/native", params: { threadId: "thread-1", turnId: "turn-1", value: 1 } });
  send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", startedAtMs: 1_700_000_000_000, item: { id: "tool-1", type: "commandExecution", status: "inProgress", command: "printf ok" } } });
  if (mode === "approval") {
    approvalPending = true;
    send({ method: "item/commandExecution/requestApproval", id: 900, params: { threadId: "thread-1", turnId: "turn-1", itemId: "tool-1" } });
    return;
  }
  if (mode === "user-input") {
    send({ method: "item/tool/requestUserInput", id: 901, params: { threadId: "thread-1", turnId: "turn-1", itemId: "tool-1", questions: [] } });
    return;
  }
  await finishTurn();
}

async function finishTurn(status = "completed") {
  for (const endpoint of endpoints) {
    await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resourceLogs: [], resourceSpans: [], resourceMetrics: [] }) });
  }
  send({ method: "thread/tokenUsage/updated", params: {
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: {
      total: { totalTokens: 14, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 4, reasoningOutputTokens: 2 },
      last: { totalTokens: 14, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 4, reasoningOutputTokens: 2 },
      modelContextWindow: 128000,
    },
  } });
  send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", completedAtMs: 1_700_000_000_100, item: { id: "tool-1", type: "commandExecution", status: status === "completed" ? "completed" : "declined", command: "printf ok", aggregatedOutput: "ok" } } });
  send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", threadId: "thread-1", status, items: [] } } });
}

lines.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id === 900 || message.id === 901) {
    approvalPending = false;
    void finishTurn("completed");
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "codex_cli_rs/0.150.1", codexHome: "/redacted", platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: {
      thread: { id: "thread-1", turns: [] },
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      serviceTier: null,
      cwd: message.params.cwd,
      runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
      instructionSources: [],
      approvalPolicy: message.params.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: { type: message.params.sandbox },
      activePermissionProfile: null,
      reasoningEffort: "high",
      multiAgentMode: "explicitRequestOnly",
    } });
  } else if (message.method === "turn/start") {
    if (mode === "auth-failure") {
      send({ id: message.id, error: { code: -32000, message: "Unauthorized" } });
      return;
    }
    send({ id: message.id, result: { turn: { id: "turn-1", threadId: "thread-1", status: "inProgress", items: [] } } });
    await writeFile(join(message.params.cwd, "codex-result.txt"), "done\n");
    if (mode === "malformed") {
      process.stdout.write("{bad json\n");
    } else if (mode === "crash") {
      setImmediate(() => process.exit(9));
    } else if (mode !== "interrupt") {
      void emitTurn();
    }
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    void finishTurn("interrupted");
  } else if (message.method === "thread/read") {
    send({ id: message.id, result: { thread: { id: "thread-1", turns: [{ id: mode === "history-mismatch" ? "other-turn" : "turn-1", status: "completed", items: [] }] } } });
  }
});

process.stderr.write("fake codex diagnostic\n");
