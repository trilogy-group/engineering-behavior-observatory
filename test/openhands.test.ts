import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAdapterContract,
  captureOpenHandsAgentServer,
  captureOpenHandsAgentServerRun,
  createOpenHandsHarnessAdapter,
  normalizeOpenHandsCapture,
  OPENHANDS_AGENT_SERVER_CAPABILITIES,
  OPENHANDS_AGENT_SERVER_VERSION,
  OPENHANDS_TYPESCRIPT_CLIENT_VERSION,
  type OpenHandsCapture,
  type RunBundleDefinition,
  type OpenHandsWebSocket,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const SHA = (value: string): `sha256:${string}` => `sha256:${value.repeat(64).slice(0, 64)}`;

const message = {
  id: "event-message",
  kind: "MessageEvent",
  source: "user",
  timestamp: "2026-09-02T07:00:00Z",
  llm_message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
};

test("captures the pinned REST and WebSocket event then normalizes native source", async () => {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1", sdk_version: "1.44.1", tools_version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") {
      return json({ id: "conversation-1", execution_status: "running", workspace: { type: "local", working_dir: "/workspace" } }, 201);
    }
    if (url.endsWith("/api/conversations/conversation-1")) {
      return json({ id: "conversation-1", execution_status: "finished", workspace: { type: "local", working_dir: "/workspace" } });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) {
      return json({ items: [message], next_page_id: null });
    }
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  const sockets: FakeWebSocket[] = [];
  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: { workspace: { type: "local", working_dir: "/workspace" } },
    message: { role: "user", content: [{ type: "text", text: "hello" }], run: true },
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.open();
        socket.message(message);
      });
      return socket;
    },
    pollIntervalMs: 0,
  });
  const normalized = await normalizeOpenHandsCapture(result);

  assert.equal(result.qualification, "qualified-with-gaps");
  assert.equal(result.reconciliation.status, "matched");
  assert.deepEqual(result.reconciliation.streamedEventIds, ["event-message"]);
  assert.deepEqual(result.reconciliation.finalEventIds, ["event-message"]);
  assert.equal(result.eventLogCompleteness.status, "unknown");
  assert.equal(sockets[0]?.url, "ws://127.0.0.1:8000/sockets/events/conversation-1?resend_mode=all");
  assert.deepEqual(requests, [
    "GET /server_info",
    "POST /api/conversations",
    "POST /api/conversations/conversation-1/events",
    "GET /api/conversations/conversation-1",
    "GET /api/conversations/conversation-1/events/search",
    "DELETE /api/conversations/conversation-1",
  ]);
  assert.deepEqual(normalized.events.map(({ family }) => family), ["message", "outcome"]);
  assert.equal(normalized.events[0]?.actor.kind, "user");
  assert.equal(normalized.events[0]?.source.nativeType, "MessageEvent");
  assert.equal(normalized.unmapped.length > 0, true);
});

test("reconnects from the last native timestamp and reconciles duplicate streamed events", async () => {
  const second = { ...message, id: "event-second", timestamp: "2026-09-02T07:00:01Z" };
  const sockets: FakeWebSocket[] = [];
  let conversationPolls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/conversations") && init?.method === "POST") {
      assert.equal(new Headers(init.headers).get("x-session-api-key"), "secret");
    }
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") {
      return json({ id: "conversation-1", execution_status: "running", workspace: {} }, 201);
    }
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1")) {
      conversationPolls += 1;
      return json({ id: "conversation-1", execution_status: conversationPolls < 2 ? "running" : "finished", workspace: {} });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) {
      return json({ items: [message, second], next_page_id: null });
    }
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: { workspace: {} },
    message: { role: "user", content: [], run: true },
    sessionApiKey: "secret",
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.open();
        if (sockets.length === 1) {
          socket.message(message);
          socket.disconnect();
        } else {
          socket.message(message);
          socket.message(second);
        }
      });
      return socket;
    },
    maxReconnects: 1,
    reconnectDelayMs: 0,
    pollIntervalMs: 1,
  });

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1]?.url.includes("resend_mode=since"), true);
  assert.equal(sockets[1]?.url.includes("after_timestamp=2026-09-02T07%3A00%3A00Z"), true);
  assert.equal(sockets.some(({ url }) => url.includes("secret")), false);
  assert.deepEqual(sockets.map((socket) => socket.sent), [[JSON.stringify({ type: "auth", session_api_key: "secret" })], [JSON.stringify({ type: "auth", session_api_key: "secret" })]]);
  assert.deepEqual(result.reconciliation.streamedEventIds, ["event-message", "event-second"]);
  assert.equal(result.records.filter(({ record }) => record.channel === "websocket-event").length, 3);
  assert.equal(result.reconciliation.status, "matched");
});

test("fences a pending reconnect when capture closes", async () => {
  const sockets: FakeWebSocket[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      return json({ id: "conversation-1", execution_status: "finished" });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      if (sockets.length === 1) queueMicrotask(() => {
        socket.open();
        socket.disconnect();
      });
      return socket;
    },
    reconnectDelayMs: 0,
    timeoutMs: 10,
    pollIntervalMs: 0,
  });
  const retainedCount = result.records.length;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

  assert.equal(sockets.length, 2);
  assert.equal(sockets[1]?.readyState, 3);
  assert.equal(result.records.length, retainedCount);
  assert.equal(result.records.some(({ record }) => record.payload.state === "reconnect-failed"), false);
});

test("maps supported event facts, error scopes, and exposed relationships while retaining unknown kinds", async () => {
  const native = JSON.parse(readFileSync(
    join(repositoryRoot, "test/fixtures/openhands/v1.44.1/final-events.json"),
    "utf8",
  )) as Array<Record<string, unknown>>;
  const records = native.map((payload, index) => ({
    reference: { artifactId: "session", recordLocator: `line:${index + 1}` },
    record: {
      schemaVersion: "ebo.openhands-native-record/v1" as const,
      session_id: "conversation-1",
      channel: "rest-event" as const,
      sequence: index + 1,
      channelSequence: index + 1,
      payload,
    },
  }));
  const capture: OpenHandsCapture = {
    runId: "run-1",
    attemptId: "attempt-1",
    qualification: "qualified-with-gaps",
    records,
    conversationId: "conversation-1",
    serverInfo: { version: "1.44.1" },
    finalConversation: { id: "conversation-1", execution_status: "finished" },
    reconciliation: {
      status: "matched",
      streamedEventIds: [],
      finalEventIds: native.map(({ id }) => String(id)),
      streamedOnlyEventIds: [],
      finalOnlyEventIds: [],
      transportGaps: [],
    },
    eventLogCompleteness: { status: "unknown", reason: "REST does not prove EventLog completeness." },
  };
  const normalized = await normalizeOpenHandsCapture(capture);

  assert.deepEqual(normalized.events.map(({ family }) => family), [
    "message", "tool", "tool", "tool", "runtime", "runtime", "context", "context", "runtime", "runtime",
  ]);
  assert.deepEqual(
    normalized.events.filter(({ source }) => source.nativeType.includes("Error")).map(({ attributes }) => attributes.errorScope),
    ["agent-tool", "conversation", "server"],
  );
  assert.deepEqual(
    normalized.events.find(({ source }) => source.nativeType === "Condensation")?.attributes.forgottenEventIds,
    ["message-1", "action-1"],
  );
  assert.deepEqual(
    normalized.events.find(({ source }) => source.nativeType === "ObservationEvent")?.relations.known,
    [{ kind: "caused-by", eventId: "openhands:action-1" }],
  );
  assert.equal(normalized.unmapped.some(({ reference }) => reference.recordLocator === "line:11"), true);
});

test("declares source-specific capabilities without behavioral comparison claims", () => {
  const adapter = createOpenHandsHarnessAdapter();
  const agentSdk = {
    families: {
      ...OPENHANDS_AGENT_SERVER_CAPABILITIES.families,
      context: { status: "unsupported" as const },
      permission: { status: "available" as const },
    },
  };

  assert.equal(adapter.capture.id, "openhands-agent-server-v1.44.1");
  assert.equal(adapter.normalization.capabilityProfile, OPENHANDS_AGENT_SERVER_CAPABILITIES);
  assert.deepEqual(
    Object.keys(OPENHANDS_AGENT_SERVER_CAPABILITIES.families).filter((family) =>
      OPENHANDS_AGENT_SERVER_CAPABILITIES.families[family as keyof typeof OPENHANDS_AGENT_SERVER_CAPABILITIES.families].status
        !== agentSdk.families[family as keyof typeof agentSdk.families].status),
    ["context", "permission"],
  );
});

test("retains streamed evidence and a capture gap when final REST reconciliation fails", async () => {
  let deleted = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") {
      return json({ id: "conversation-1", execution_status: "running", workspace: {} }, 201);
    }
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "error", workspace: {} });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ detail: "unavailable" }, 503);
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") {
      deleted = true;
      return json({ success: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  const agentError = {
    id: "agent-error-1",
    kind: "AgentErrorEvent",
    source: "agent",
    timestamp: "2026-09-02T07:00:00Z",
    tool_name: "terminal",
    tool_call_id: "call-1",
    error: "failed",
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: { workspace: {} },
    message: { role: "user", content: [], run: true },
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => {
        socket.open();
        socket.message(agentError);
      });
      return socket;
    },
    pollIntervalMs: 0,
  });
  const normalized = await normalizeOpenHandsCapture(result);

  assert.equal(result.reconciliation.status, "partial");
  assert.match(result.reconciliation.finalReadError ?? "", /503/);
  assert.deepEqual(result.reconciliation.streamedOnlyEventIds, ["agent-error-1"]);
  assert.equal(normalized.events[0]?.attributes.errorScope, "agent-tool");
  assert.equal(deleted, true);
});

test("retains successful final REST pages when a later page fails", async () => {
  let eventPages = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "finished" });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) {
      eventPages += 1;
      return eventPages === 1
        ? json({ items: [message], next_page_id: "page-2" })
        : json({ detail: "later page failed" }, 503);
    }
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => socket.open());
      return socket;
    },
    pollIntervalMs: 0,
  });
  const normalized = await normalizeOpenHandsCapture(result);

  assert.match(result.reconciliation.finalReadError ?? "", /503/);
  assert.deepEqual(result.reconciliation.finalEventIds, ["event-message"]);
  assert.equal(result.records.filter(({ record }) => record.channel === "rest-event").length, 1);
  assert.equal(normalized.events.some(({ source }) => source.nativeType === "MessageEvent"), true);
});

test("retains and cleans up a partial attempt when message submission fails", async () => {
  let deleted = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ detail: "failed" }, 500);
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") {
      deleted = true;
      return json({ success: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: { workspace: {} },
    message: { role: "user", content: [], run: true },
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });

  assert.equal(result.reconciliation.status, "partial");
  assert.match(result.captureError ?? "", /500/);
  assert.equal(result.finalConversation, undefined);
  assert.equal(result.records.some(({ record }) => record.channel === "capture-error"), true);
  assert.equal(deleted, true);
});

test("aborts an in-flight conversation capture and retains the partial evidence", async () => {
  const controller = new AbortController();
  let deleted = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "running" });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") {
      deleted = true;
      return json({ success: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };
  setTimeout(() => controller.abort(), 1);

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => socket.open());
      return socket;
    },
    signal: controller.signal,
    timeoutMs: 1_000,
    pollIntervalMs: 50,
  });

  assert.match(result.captureError ?? "", /aborted/);
  assert.equal(result.reconciliation.status, "partial");
  assert.equal(deleted, true);
});

test("bounds untrusted Agent Server JSON responses before parsing", async () => {
  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch: async () => json({ version: "1.44.1", padding: "x".repeat(256) }),
    webSocket: (url) => new FakeWebSocket(url),
    maxResponseBytes: 100,
  });

  assert.match(result.captureError ?? "", /response exceeds 100 bytes/);
  assert.equal(result.records[0]?.record.channel, "capture-error");
});

test("retains an explicit partial record when server identity lookup fails", async () => {
  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch: async () => json({ detail: "server info failed" }, 503),
  });

  assert.equal(result.conversationId, undefined);
  assert.match(result.captureError ?? "", /503/);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.record.channel, "capture-error");
  assert.equal(result.records[0]?.record.session_id, undefined);
});

test("applies the configured timeout to Agent Server REST requests", async () => {
  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((resolvePromise, reject) => {
      const timer = setTimeout(() => resolvePromise(json({ version: "1.44.1" })), 30);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      }, { once: true });
    }),
  });

  assert.match(result.captureError ?? "", /abort|timeout/i);
  assert.equal(result.records[0]?.record.channel, "capture-error");
});

test("closes and fences a WebSocket that misses its open deadline", async () => {
  let socket: FakeWebSocket | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    sessionApiKey: "secret",
    timeoutMs: 10,
    fetch,
    webSocket: (url) => {
      socket = new FakeWebSocket(url);
      return socket;
    },
  });
  const retainedCount = result.records.length;
  assert.equal(socket!.readyState, 3);
  socket!.open();
  await Promise.resolve();

  assert.deepEqual(socket!.sent, []);
  assert.equal(result.records.length, retainedCount);
  assert.equal(result.records.some(({ record }) =>
    record.channel === "websocket-status" && record.payload.state === "connected"), false);
});

test("retains an explicit gap for an oversized WebSocket frame", async () => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "finished" });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => {
        socket.open();
        socket.message({ id: "oversized", kind: "FutureEvent", padding: "x".repeat(300) });
        socket.rawMessage("[]");
      });
      return socket;
    },
    maxResponseBytes: 200,
    pollIntervalMs: 0,
  });

  assert.equal(result.reconciliation.status, "partial");
  assert.equal(result.records.some(({ record }) =>
    record.channel === "websocket-status" && record.payload.state === "message-rejected"), true);
  assert.equal(result.records.some(({ record }) =>
    record.channel === "websocket-status" && String(record.payload.reason).includes("JSON object")), true);
});

test("marks identifier-less channel records as reconciliation gaps", async () => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "finished" });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => {
        socket.open();
        socket.message({ kind: "FutureEvent", source: "agent" });
      });
      return socket;
    },
    pollIntervalMs: 0,
  });

  assert.equal(result.reconciliation.status, "partial");
  assert.deepEqual(result.reconciliation.transportGaps, ["unidentified-websocket-event"]);
  assert.equal(result.records.some(({ record }) =>
    record.channel === "websocket-event" && record.payload.kind === "FutureEvent"), true);
});

test("bounds rejected WebSocket status records", async () => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "finished" });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: {},
    message: {},
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => {
        socket.open();
        for (let index = 0; index < 300; index += 1) socket.rawMessage("x".repeat(2_000));
      });
      return socket;
    },
    maxResponseBytes: 1_024,
    pollIntervalMs: 0,
  });
  const statuses = result.records.filter(({ record }) => record.channel === "websocket-status");

  assert.equal(statuses.length, 257);
  assert.equal(statuses.at(-1)?.record.payload.state, "status-limit-reached");
  assert.equal(result.reconciliation.transportGaps.includes("status-limit-reached"), true);
});

test("records an exhausted stream disconnect while final REST preserves the event", async () => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "finished", workspace: {} });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [message], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  const result = await captureOpenHandsAgentServer({
    runId: "run-1",
    attemptId: "attempt-1",
    baseUrl: "http://127.0.0.1:8000",
    startConversation: { workspace: {} },
    message: { role: "user", content: [], run: true },
    fetch,
    webSocket: (url) => {
      const socket = new FakeWebSocket(url);
      queueMicrotask(() => {
        socket.open();
        socket.disconnect();
      });
      return socket;
    },
    maxReconnects: 0,
    pollIntervalMs: 0,
  });

  assert.equal(result.reconciliation.status, "partial");
  assert.deepEqual(result.reconciliation.finalOnlyEventIds, ["event-message"]);
  assert.deepEqual(
    result.records.filter(({ record }) => record.channel === "websocket-status").map(({ record }) => record.payload.state),
    ["connected", "disconnected", "reconnect-exhausted"],
  );
});

test("satisfies the uniform adapter contract with resolvable retained native records", async () => {
  const native = JSON.parse(readFileSync(
    join(repositoryRoot, "test/fixtures/openhands/v1.44.1/final-events.json"),
    "utf8",
  )) as Array<Record<string, unknown>>;
  const capture: OpenHandsCapture = {
    runId: "run-1",
    attemptId: "attempt-1",
    qualification: "qualified-with-gaps",
    records: native.map((payload, index) => ({
      reference: { artifactId: "session", recordLocator: `line:${index + 1}` },
      record: {
        schemaVersion: "ebo.openhands-native-record/v1",
        session_id: "conversation-1",
        channel: "rest-event",
        sequence: index + 1,
        channelSequence: index + 1,
        payload,
      },
    })),
    conversationId: "conversation-1",
    serverInfo: { version: "1.44.1" },
    finalConversation: { id: "conversation-1", execution_status: "finished" },
    reconciliation: {
      status: "matched",
      streamedEventIds: [],
      finalEventIds: native.map(({ id }) => String(id)),
      streamedOnlyEventIds: [],
      finalOnlyEventIds: [],
      transportGaps: [],
    },
    eventLogCompleteness: { status: "unknown", reason: "REST does not prove EventLog completeness." },
  };
  const adapter = createOpenHandsHarnessAdapter();
  const result = await assertAdapterContract({
    ...adapter,
    capture: { ...adapter.capture, capture: async () => capture },
  }, null, {
    resolve: ({ artifactId, recordLocator }) => artifactId === "session" && /^line:\d+(#\/payload(?:\/.*)?)?$/.test(recordLocator),
  });

  assert.equal(result.events.length, 10);
  assert.equal(result.unmapped.length, 1);
});

test("preserves timezone-naive native timestamps without inventing a uniform timezone", async () => {
  const capture: OpenHandsCapture = {
    runId: "run-1",
    attemptId: "attempt-1",
    qualification: "qualified-with-gaps",
    records: [{
      reference: { artifactId: "session", recordLocator: "line:1" },
      record: {
        schemaVersion: "ebo.openhands-native-record/v1",
        session_id: "conversation-1",
        channel: "rest-event",
        sequence: 1,
        channelSequence: 1,
        payload: { ...message, timestamp: "2026-09-02T07:00:00" },
      },
    }],
    conversationId: "conversation-1",
    serverInfo: { version: "1.44.1" },
    finalConversation: { execution_status: "finished" },
    reconciliation: {
      status: "matched",
      streamedEventIds: [],
      finalEventIds: ["event-message"],
      streamedOnlyEventIds: [],
      finalOnlyEventIds: [],
      transportGaps: [],
    },
    eventLogCompleteness: { status: "unknown", reason: "not exposed" },
  };

  const normalized = await normalizeOpenHandsCapture(capture);

  assert.equal(normalized.events[0]?.nativeTime.status, "unknown");
  assert.equal(capture.records[0]?.record.payload.timestamp, "2026-09-02T07:00:00");
});

test("marks missing native content unknown instead of emitting a nonexistent pointer", async () => {
  const capture: OpenHandsCapture = {
    runId: "run-1",
    attemptId: "attempt-1",
    qualification: "qualified-with-gaps",
    records: [{
      reference: { artifactId: "session", recordLocator: "line:1" },
      record: {
        schemaVersion: "ebo.openhands-native-record/v1",
        session_id: "conversation-1",
        channel: "rest-event",
        sequence: 1,
        channelSequence: 1,
        payload: { id: "message-without-content", kind: "MessageEvent", source: "user" },
      },
    }],
    conversationId: "conversation-1",
    serverInfo: { version: "1.44.1" },
    finalConversation: { execution_status: "finished" },
    reconciliation: {
      status: "matched",
      streamedEventIds: [],
      finalEventIds: ["message-without-content"],
      streamedOnlyEventIds: [],
      finalOnlyEventIds: [],
      transportGaps: [],
    },
    eventLogCompleteness: { status: "unknown", reason: "not exposed" },
  };

  const normalized = await normalizeOpenHandsCapture(capture);

  assert.equal(normalized.events[0]?.content.status, "unknown");
  delete capture.records[0]!.record.payload.source;
  const missingActor = await normalizeOpenHandsCapture(capture);
  assert.equal(missingActor.events.length, 0);
  assert.equal(missingActor.unmapped.length, 1);
  capture.records[0]!.record.payload.source = "user";
  capture.records[0]!.record.payload.id = "x".repeat(246);
  const oversizedIdentity = await normalizeOpenHandsCapture(capture);
  assert.equal(oversizedIdentity.events.length, 0);
  assert.equal(oversizedIdentity.unmapped.length, 1);
});

test("packages one verified smoke attempt with native, workspace, verifier, and normalized evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-openhands-run-"));
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "result.txt"), "before\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  writeFileSync(join(final, "result.txt"), "after\n");
  mkdirSync(join(final, ".git"));
  writeFileSync(join(final, ".git", "HEAD"), "ref: refs/heads/main\n");
  const hook = {
    id: "hook-1",
    kind: "HookExecutionEvent",
    source: "hook",
    timestamp: "2026-09-02T07:00:00Z",
    hook_event_type: "SessionEnd",
    hook_command: "echo done",
    success: true,
    exit_code: 0,
  };
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-openhands-smoke",
    run: {
      id: "run-openhands-smoke",
      assessmentMode: "verified",
      task: { id: "task-openhands-smoke" },
      fixture: { id: "fixture-openhands-smoke", digest: SHA("a") },
      model: { provider: "test", id: "test/model" },
      harness: { id: "openhands-agent-server", version: "1.44.1" },
      runtime: [],
    },
    attempt: { id: "attempt-openhands-smoke", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1", sdk_version: "1.44.1", tools_version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { workspace: { working_dir: string } };
      assert.equal(body.workspace.working_dir, "/server/workspace");
      return json({ id: "conversation-1", workspace: { type: "local", working_dir: "/server/workspace" } }, 201);
    }
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") return json({ success: true });
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "finished", workspace: { type: "local", working_dir: final } });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [message, hook], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  try {
    const result = await captureOpenHandsAgentServerRun({
      definition,
      startingWorkspacePath: start,
      workspace: {
        setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }),
        cleanup: async () => undefined,
      },
      configuration: {
        model: "test/model",
        baseUrl: "http://127.0.0.1:8000",
        serverWorkspacePath: "/server/workspace",
        startConversation: { agent: { kind: "Agent", llm: { model: "test/model" } } },
        message: { role: "user", content: [{ type: "text", text: "update result.txt" }], run: true },
        fetch,
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          queueMicrotask(() => {
            socket.open();
            socket.message(message);
            socket.message(hook);
          });
          return socket;
        },
        pollIntervalMs: 0,
      },
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
        diagnostics: [],
      }),
    });

    assert.equal(result.attempt.classification.kind, "completed");
    assert.equal(result.capture!.conversationId, "conversation-1");
    assert.equal(result.manifest.run.native?.sessionId, "conversation-1");
    assert.deepEqual(result.manifest.evidence.filter(({ kind }) => ["session", "hook", "workspace", "verifier"].includes(kind)).map(({ kind }) => kind), [
      "workspace", "verifier", "session", "hook",
    ]);
    assert.equal(result.normalized.events.every(({ attemptId }) => attemptId === definition.attempt.id), true);
    assert.equal(result.normalized.events.every(({ source }) => source.nativeReference.artifactId === "session"), true);
    assert.equal(result.normalized.events.flatMap(({ content }) => content.status === "known" ? content.value : [])
      .every(({ nativeReference }) => nativeReference.artifactId === "session"), true);
    assert.equal(result.qualification.status, "qualified-with-gaps");
    assert.equal(result.qualification.reasons.some(({ code }) => code === "EVENT_LOG_COMPLETENESS_UNPROVEN"), true);
    const captureReport = result.manifest.evidence.find(({ kind }) => kind === "capture-report")!;
    assert.deepEqual(
      (JSON.parse(readFileSync(join(bundleRoot, captureReport.relativePath), "utf8")) as {
        workspaceOutcomeExcludedDirectoryNames: string[];
      }).workspaceOutcomeExcludedDirectoryNames,
      [".git"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a declared model that differs from the actual conversation request", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-openhands-model-mismatch-"));
  const definition: RunBundleDefinition = {
    bundleRoot: join(root, "bundle"),
    bundleId: "bundle-openhands-model-mismatch",
    run: {
      id: "run-openhands-model-mismatch",
      assessmentMode: "observational",
      task: { id: "task-openhands-model-mismatch" },
      fixture: { id: "fixture-openhands-model-mismatch", digest: SHA("a") },
      model: { provider: "test", id: "declared/model" },
      harness: { id: "openhands-agent-server", version: OPENHANDS_AGENT_SERVER_VERSION },
      runtime: [],
    },
    attempt: { id: "attempt-openhands-model-mismatch", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };

  try {
    await assert.rejects(captureOpenHandsAgentServerRun({
      definition,
      startingWorkspacePath: root,
      workspace: { setup: async () => { throw new Error("workspace must not start"); } },
      configuration: {
        model: "declared/model",
        baseUrl: "http://127.0.0.1:8000",
        startConversation: { agent: { kind: "Agent", llm: { model: "actual/model" } } },
        message: {},
      },
    }), /actual conversation request model/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a run definition attributed to another harness", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-openhands-harness-mismatch-"));
  const definition: RunBundleDefinition = {
    bundleRoot: join(root, "bundle"),
    bundleId: "bundle-openhands-harness-mismatch",
    run: {
      id: "run-openhands-harness-mismatch",
      assessmentMode: "observational",
      task: { id: "task-openhands-harness-mismatch" },
      fixture: { id: "fixture-openhands-harness-mismatch", digest: SHA("a") },
      model: { provider: "test", id: "test/model" },
      harness: { id: "agent-sdk", version: "1.44.1" },
      runtime: [],
    },
    attempt: { id: "attempt-openhands-harness-mismatch", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };

  try {
    await assert.rejects(captureOpenHandsAgentServerRun({
      definition,
      startingWorkspacePath: root,
      workspace: { setup: async () => { throw new Error("workspace must not start"); } },
      configuration: {
        model: "test/model",
        baseUrl: "http://127.0.0.1:8000",
        startConversation: { agent: { kind: "Agent", llm: { model: "test/model" } } },
        message: {},
      },
    }), /harness.*openhands-agent-server/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalizes the actual terminal record when workspace setup fails before capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-openhands-workspace-failure-"));
  const definition: RunBundleDefinition = {
    bundleRoot: join(root, "bundle"),
    bundleId: "bundle-openhands-workspace-failure",
    run: {
      id: "run-openhands-workspace-failure",
      assessmentMode: "observational",
      task: { id: "task-openhands-workspace-failure" },
      fixture: { id: "fixture-openhands-workspace-failure", digest: SHA("a") },
      model: { provider: "test", id: "test/model" },
      harness: { id: "openhands-agent-server", version: OPENHANDS_AGENT_SERVER_VERSION },
      runtime: [],
    },
    attempt: { id: "attempt-openhands-workspace-failure", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };

  try {
    const result = await captureOpenHandsAgentServerRun({
      definition,
      startingWorkspacePath: root,
      workspace: { setup: async () => { throw new Error("fixture setup failed"); } },
      configuration: {
        model: "test/model",
        baseUrl: "http://127.0.0.1:8000",
        startConversation: { agent: { kind: "Agent", llm: { model: "test/model" } } },
        message: {},
      },
    });

    assert.equal(result.capture, undefined);
    assert.equal(result.attempt.classification.kind, "infrastructure-failure");
    assert.equal(result.manifest.terminal.state, "failed");
    assert.equal(result.manifest.terminal.failureClass, "infrastructure");
    assert.equal(result.manifest.evidence.some(({ kind }) => kind === "session"), false);
    assert.equal(result.qualification.status, "unqualified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains pre-session evidence when conversation creation fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-openhands-create-failure-"));
  const start = join(root, "start");
  const final = join(root, "final");
  mkdirSync(start);
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  const definition: RunBundleDefinition = {
    bundleRoot: join(root, "bundle"),
    bundleId: "bundle-openhands-create-failure",
    run: {
      id: "run-openhands-create-failure",
      assessmentMode: "observational",
      task: { id: "task-openhands-create-failure" },
      fixture: { id: "fixture-openhands-create-failure", digest: SHA("a") },
      model: { provider: "test", id: "test/model" },
      harness: { id: "openhands-agent-server", version: OPENHANDS_AGENT_SERVER_VERSION },
      runtime: [],
    },
    attempt: { id: "attempt-openhands-create-failure", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };

  try {
    const result = await captureOpenHandsAgentServerRun({
      definition,
      startingWorkspacePath: start,
      workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
      configuration: {
        model: "test/model",
        baseUrl: "http://127.0.0.1:8000",
        startConversation: { agent: { kind: "Agent", llm: { model: "test/model" } } },
        message: {},
        fetch: async (input) => String(input).endsWith("/server_info")
          ? json({ version: "1.44.1" }) : json({ detail: "create failed" }, 503),
      },
    });
    const session = result.manifest.evidence.find(({ kind }) => kind === "session")!;
    const native = readFileSync(join(definition.bundleRoot, session.relativePath), "utf8");

    assert.equal(result.capture!.conversationId, undefined);
    assert.match(result.capture!.captureError ?? "", /503/);
    assert.equal(session.nativeReference, undefined);
    assert.equal(native.includes("server-info"), true);
    assert.equal(native.includes("capture-error"), true);
    assert.equal(result.qualification.status, "unqualified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains progressively written native evidence when lifecycle cancellation interrupts polling", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-openhands-interrupted-run-"));
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "result.txt"), "before\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-openhands-interrupted",
    run: {
      id: "run-openhands-interrupted",
      assessmentMode: "observational",
      task: { id: "task-openhands-interrupted" },
      fixture: { id: "fixture-openhands-interrupted", digest: SHA("a") },
      model: { provider: "test", id: "test/model" },
      harness: { id: "openhands-agent-server", version: OPENHANDS_AGENT_SERVER_VERSION },
      runtime: [],
    },
    attempt: { id: "attempt-openhands-interrupted", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };
  const controller = new AbortController();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/server_info")) return json({ version: "1.44.1" });
    if (url.endsWith("/api/conversations") && init?.method === "POST") return json({ id: "conversation-1" }, 201);
    if (url.endsWith("/api/conversations/conversation-1/events") && init?.method === "POST") {
      setTimeout(() => controller.abort(), 1);
      return json({ success: true });
    }
    if (url.endsWith("/api/conversations/conversation-1") && (init?.method ?? "GET") === "GET") {
      return json({ id: "conversation-1", execution_status: "running" });
    }
    if (url.includes("/api/conversations/conversation-1/events/search")) return json({ items: [], next_page_id: null });
    if (url.endsWith("/api/conversations/conversation-1") && init?.method === "DELETE") return json({ success: true });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
  };

  try {
    const result = await captureOpenHandsAgentServerRun({
      definition,
      startingWorkspacePath: start,
      workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
      configuration: {
        model: "test/model",
        baseUrl: "http://127.0.0.1:8000",
        startConversation: { agent: { kind: "Agent", llm: { model: "test/model" } } },
        message: {},
        fetch,
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          queueMicrotask(() => socket.open());
          return socket;
        },
        pollIntervalMs: 50,
      },
      signal: controller.signal,
      shutdownGraceMs: 250,
    });
    const session = result.manifest.evidence.find(({ kind }) => kind === "session");

    assert.equal(result.attempt.terminal.state, "interrupted");
    assert.match(result.capture!.captureError ?? "", /aborted/);
    assert.equal(session?.id, "session");
    assert.equal(readFileSync(join(bundleRoot, session!.relativePath), "utf8").includes("conversation-created"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pins the exact upstream OpenAPI and TypeScript-client comparison artifacts", () => {
  const contract = JSON.parse(readFileSync(
    join(repositoryRoot, "contracts/openhands-agent-server-v1.44.1.json"),
    "utf8",
  )) as {
    server: { version: string; openapiSha256: string };
    typescriptClient: { version: string; generatedForServer: string; decision: string };
    websocket: { path: string; authentication: string };
  };

  assert.equal(contract.server.version, OPENHANDS_AGENT_SERVER_VERSION);
  assert.equal(contract.server.openapiSha256, "718a6e6e658ead0aba4457ad5fc083df0436b3bfddfdac646cd8eb2f22c973f1");
  assert.equal(contract.typescriptClient.version, OPENHANDS_TYPESCRIPT_CLIENT_VERSION);
  assert.equal(contract.typescriptClient.generatedForServer, "1.44.0");
  assert.equal(contract.typescriptClient.decision, "direct-rest-websocket");
  assert.equal(contract.websocket.path, "/sockets/events/{conversation_id}");
  assert.equal(contract.websocket.authentication, "first-message");
});

test("approved live Agent Server smoke produces a verified run bundle", {
  skip: process.env.EBO_LIVE_OPENHANDS_SMOKE !== "1",
  timeout: 300_000,
}, async () => {
  const workspaceRoot = process.env.EBO_LIVE_OPENHANDS_WORKSPACE_ROOT;
  const model = process.env.LLM_MODEL;
  const apiKey = process.env.LLM_API_KEY;
  if (workspaceRoot === undefined || model === undefined || apiKey === undefined) {
    throw new Error("Live OpenHands smoke requires EBO_LIVE_OPENHANDS_WORKSPACE_ROOT, LLM_MODEL, and LLM_API_KEY.");
  }
  mkdirSync(workspaceRoot, { recursive: true });
  const root = mkdtempSync(join(workspaceRoot, "attempt-"));
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "result.txt"), "before\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-openhands-live-smoke",
    run: {
      id: "run-openhands-live-smoke",
      assessmentMode: "verified",
      task: { id: "task-openhands-live-smoke" },
      fixture: { id: "fixture-openhands-live-smoke", digest: SHA("a") },
      model: { provider: model.split("/", 1)[0] ?? "unknown", id: model },
      harness: { id: "openhands-agent-server", version: OPENHANDS_AGENT_SERVER_VERSION },
      runtime: [],
    },
    attempt: { id: "attempt-openhands-live-smoke", number: 1 },
    configuration: { digest: SHA("b"), budgetDigest: SHA("c"), toolPolicyDigest: SHA("d") },
  };

  try {
    const result = await captureOpenHandsAgentServerRun({
      definition,
      startingWorkspacePath: start,
      workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
      configuration: {
        model,
        baseUrl: process.env.EBO_OPENHANDS_SERVER_URL ?? "http://127.0.0.1:8010",
        startConversation: {
          agent: {
            kind: "Agent",
            llm: {
              model,
              api_key: apiKey,
              ...(process.env.LLM_BASE_URL === undefined ? {} : { base_url: process.env.LLM_BASE_URL }),
            },
            tools: [
              { name: "terminal", params: {} },
              { name: "file_editor", params: {} },
            ],
          },
          hook_config: {
            session_start: [{ matcher: "*", hooks: [{ command: "true" }] }],
            session_end: [{ matcher: "*", hooks: [{ command: "true" }] }],
          },
          max_iterations: 20,
          stuck_detection: true,
        },
        message: {
          role: "user",
          content: [{ type: "text", text: "Replace result.txt with exactly the single line: after" }],
          run: true,
        },
        sessionApiKey: process.env.EBO_OPENHANDS_SESSION_API_KEY,
        timeoutMs: 240_000,
        pollIntervalMs: 250,
      },
      verifier: async (_context, workspace, workspacePath) => {
        const passed = readFileSync(join(workspacePath, "result.txt"), "utf8").trim() === "after";
        const base = {
          schemaVersion: "verifier-result/v1" as const,
          bundleId: definition.bundleId,
          workspace: {
            artifactId: workspace.descriptor.id,
            digest: workspace.descriptor.digest,
            fingerprint: workspace.fingerprint,
          },
          diagnostics: [],
        };
        return passed
          ? { ...base, status: "passed", exitCode: 0, assertions: [{ id: "result-file", status: "passed" }] }
          : { ...base, status: "failed", exitCode: 1, assertions: [{ id: "result-file", status: "failed" }] };
      },
    });

    assert.equal(result.attempt.classification.kind, "completed");
    assert.equal(result.manifest.terminal.state, "completed");
    assert.equal(result.qualification.status, "qualified-with-gaps");
    assert.equal(result.normalized.events.length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class FakeWebSocket implements OpenHandsWebSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  public constructor(public readonly url: string) {}

  public addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  public message(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) });
  }

  public rawMessage(data: string): void {
    this.emit("message", { data });
  }

  public disconnect(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
