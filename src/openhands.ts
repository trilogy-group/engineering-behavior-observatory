import type {
  AdapterCapabilityProfile,
  CapturedNativeRecord,
  HarnessAdapter,
  NormalizationInput,
  NormalizationResult,
  QualifiedNativeCapture,
  UniformEvent,
} from "./uniform-events.js";

export const OPENHANDS_AGENT_SERVER_VERSION = "1.44.1";
export const OPENHANDS_TYPESCRIPT_CLIENT_VERSION = "1.39.0";
export const OPENHANDS_AGENT_SERVER_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: "openhands-agent-server-v1.44.1",
  harness: "openhands-agent-server",
  nativeTypes: [
    "MessageEvent",
    "SystemPromptEvent",
    "ActionEvent",
    "ObservationEvent",
    "AgentErrorEvent",
    "UserRejectObservation",
    "CondensationRequest",
    "Condensation",
    "CondensationSummaryEvent",
    "ConversationErrorEvent",
    "ServerErrorEvent",
    "HookExecutionEvent",
    "ConversationStateUpdateEvent",
    "InterruptEvent",
    "PauseEvent",
    "conversation-final",
  ],
  families: {
    message: { status: "available" },
    "model-request": { status: "unsupported", detail: "The pinned public event boundary does not expose model requests." },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "unsupported", detail: "Hook blocking is retained natively but is not projected as a permission event." },
    delegation: { status: "unsupported", detail: "Nested delegate actions remain source-specific tool evidence." },
    artifact: { status: "unsupported", detail: "Workspace outcome is packaged outside the Agent Server event normalizer." },
    validation: { status: "unsupported", detail: "Verifier evidence is packaged outside the Agent Server event normalizer." },
    runtime: { status: "available" },
    outcome: { status: "partial", detail: "Final conversation state is available when the run reaches the final REST read." },
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "REST page and WebSocket receipt order remain separate source domains." },
    nativeTime: { status: "partial", detail: "Event timestamps are available; control records may omit native time." },
    parentage: { status: "partial", detail: "Event parent_id and selected action associations are projected when their targets are captured." },
    content: { status: "partial", detail: "Supported content stays in native records and is referenced rather than copied." },
  },
} as const satisfies AdapterCapabilityProfile;

export interface OpenHandsWebSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export type OpenHandsNativeRecord = {
  schemaVersion: "ebo.openhands-native-record/v1";
  session_id?: string;
  channel: "server-info" | "conversation-created" | "websocket-status" | "websocket-event" | "conversation-final" | "rest-event" | "capture-error" | "cleanup";
  sequence: number;
  channelSequence?: number;
  payload: Record<string, unknown>;
};

export type OpenHandsCaptureRequest = {
  runId: string;
  attemptId: string;
  baseUrl: string;
  startConversation: Record<string, unknown>;
  message: Record<string, unknown>;
  sessionApiKey?: string;
  fetch?: typeof globalThis.fetch;
  webSocket?: (url: string) => OpenHandsWebSocket;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxReconnects?: number;
  reconnectDelayMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  onRecord?: (record: CapturedNativeRecord<OpenHandsNativeRecord>) => void;
};

export type OpenHandsCapture = QualifiedNativeCapture<OpenHandsNativeRecord> & {
  conversationId?: string;
  serverInfo: Record<string, unknown>;
  finalConversation?: Record<string, unknown>;
  captureError?: string;
  reconciliation: {
    status: "matched" | "mismatch" | "partial";
    streamedEventIds: string[];
    finalEventIds: string[];
    streamedOnlyEventIds: string[];
    finalOnlyEventIds: string[];
    transportGaps: string[];
    finalReadError?: string;
  };
  eventLogCompleteness: {
    status: "unknown";
    reason: string;
  };
};

const TERMINAL_STATUSES = new Set(["finished", "error", "stuck"]);
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_EVENTS = 10_000;
const MAX_TRANSPORT_STATUS_RECORDS = 256;

export function createOpenHandsHarnessAdapter(): HarnessAdapter<OpenHandsCaptureRequest, OpenHandsNativeRecord> {
  return {
    capture: {
      id: OPENHANDS_AGENT_SERVER_CAPABILITIES.adapterId,
      harness: OPENHANDS_AGENT_SERVER_CAPABILITIES.harness,
      capture: captureOpenHandsAgentServer,
    },
    normalization: {
      id: OPENHANDS_AGENT_SERVER_CAPABILITIES.adapterId,
      harness: OPENHANDS_AGENT_SERVER_CAPABILITIES.harness,
      capabilityProfile: OPENHANDS_AGENT_SERVER_CAPABILITIES,
      normalize: normalizeOpenHandsCapture,
    },
  };
}

export async function captureOpenHandsAgentServer(request: OpenHandsCaptureRequest): Promise<OpenHandsCapture> {
  if (request.runId.trim() === "" || request.attemptId.trim() === "") {
    throw new Error("OpenHands capture requires non-empty run and attempt identities.");
  }
  const maxResponseBytes = request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    throw new Error(`OpenHands max response bytes must be between 1 and ${MAX_RESPONSE_BYTES}.`);
  }
  assertIntegerOption(request.timeoutMs, 1, "timeout milliseconds");
  assertIntegerOption(request.pollIntervalMs, 0, "poll interval milliseconds");
  assertIntegerOption(request.maxReconnects, 0, "max reconnects");
  assertIntegerOption(request.reconnectDelayMs, 0, "reconnect delay milliseconds");
  assertNotAborted(request.signal);
  const baseUrl = normalizedBaseUrl(request.baseUrl);
  const fetch = request.fetch ?? globalThis.fetch;
  const records: Array<CapturedNativeRecord<OpenHandsNativeRecord>> = [];
  let sequence = 0;
  let conversationId: string | undefined;
  const publish = (captured: CapturedNativeRecord<OpenHandsNativeRecord>): void => {
    request.onRecord?.(structuredClone(captured));
  };
  const append = (
    channel: OpenHandsNativeRecord["channel"],
    payload: Record<string, unknown>,
    channelSequence?: number,
  ): void => {
    sequence += 1;
    const record: OpenHandsNativeRecord = {
      schemaVersion: "ebo.openhands-native-record/v1",
      ...(conversationId === undefined ? {} : { session_id: conversationId }),
      channel,
      sequence,
      ...(channelSequence === undefined ? {} : { channelSequence }),
      payload: structuredClone(payload),
    };
    const captured = {
      reference: { artifactId: "session", recordLocator: `line:${sequence}` },
      record,
    };
    records.push(captured);
    publish(captured);
  };

  let serverInfo: Record<string, unknown> = {};
  try {
    serverInfo = await requestJson(fetch, baseUrl, "/server_info", undefined, request.sessionApiKey, maxResponseBytes, request.signal, request.timeoutMs);
    append("server-info", serverInfo);
    if (serverInfo.version !== OPENHANDS_AGENT_SERVER_VERSION) {
      throw new Error(`OpenHands Agent Server ${OPENHANDS_AGENT_SERVER_VERSION} is required; received ${String(serverInfo.version)}.`);
    }
  } catch (error) {
    const captureError = errorMessage(error);
    append("capture-error", { error: captureError.slice(0, 512) });
    return {
      runId: request.runId,
      attemptId: request.attemptId,
      qualification: "qualified-with-gaps",
      records,
      serverInfo,
      captureError,
      reconciliation: {
        status: "partial",
        streamedEventIds: [],
        finalEventIds: [],
        streamedOnlyEventIds: [],
        finalOnlyEventIds: [],
        transportGaps: ["server-info-unavailable"],
      },
      eventLogCompleteness: {
        status: "unknown",
        reason: "REST/WebSocket reconciliation cannot prove complete in-process EventLog delivery.",
      },
    };
  }

  let created: Record<string, unknown>;
  try {
    created = await requestJson(fetch, baseUrl, "/api/conversations", {
      method: "POST",
      body: JSON.stringify(request.startConversation),
    }, request.sessionApiKey, maxResponseBytes, request.signal, request.timeoutMs);
    if (typeof created.id !== "string" || created.id.length === 0) {
      throw new Error("OpenHands conversation creation did not return an ID.");
    }
  } catch (error) {
    const captureError = errorMessage(error);
    append("capture-error", { error: captureError.slice(0, 512) });
    return {
      runId: request.runId,
      attemptId: request.attemptId,
      qualification: "qualified-with-gaps",
      records,
      serverInfo,
      captureError,
      reconciliation: {
        status: "partial",
        streamedEventIds: [],
        finalEventIds: [],
        streamedOnlyEventIds: [],
        finalOnlyEventIds: [],
        transportGaps: ["conversation-not-created"],
      },
      eventLogCompleteness: {
        status: "unknown",
        reason: "REST/WebSocket reconciliation cannot prove complete in-process EventLog delivery.",
      },
    };
  }
  conversationId = created.id;
  append("conversation-created", created);

  const streamed: Record<string, unknown>[] = [];
  const finalEvents: Record<string, unknown>[] = [];
  let transportStatusRecords = 0;
  let transportStatusLimitRecorded = false;
  const retainTransportStatus = (status: Record<string, unknown>): void => {
    if (transportStatusRecords < MAX_TRANSPORT_STATUS_RECORDS) {
      transportStatusRecords += 1;
      append("websocket-status", status);
    } else if (!transportStatusLimitRecorded) {
      transportStatusLimitRecorded = true;
      append("websocket-status", { state: "status-limit-reached", limit: MAX_TRANSPORT_STATUS_RECORDS });
    }
  };
  let finalConversation: Record<string, unknown> | undefined;
  let finalReadError: string | undefined;
  let captureError: string | undefined;
  let socket: OpenHandsWebSocket | undefined;
  try {
    socket = await openEventSocket(
      request,
      baseUrl,
      conversationId,
      (event) => {
        if (streamed.length >= MAX_CAPTURE_EVENTS) {
          if (!records.some(({ record }) => record.channel === "websocket-status" && record.payload.state === "event-limit-reached")) {
            retainTransportStatus({ state: "event-limit-reached", limit: MAX_CAPTURE_EVENTS });
          }
          return;
        }
        streamed.push(event);
        append("websocket-event", event, streamed.length);
      },
      retainTransportStatus,
    );
    await requestJson(fetch, baseUrl, `/api/conversations/${encodeURIComponent(conversationId)}/events`, {
      method: "POST",
      body: JSON.stringify(request.message),
    }, request.sessionApiKey, maxResponseBytes, request.signal, request.timeoutMs);

    finalConversation = await pollConversation(fetch, baseUrl, conversationId, request);
    append("conversation-final", finalConversation);
    try {
      await readFinalEvents(fetch, baseUrl, conversationId, request.sessionApiKey, maxResponseBytes, request.signal, request.timeoutMs, (event, index) => {
        finalEvents.push(event);
        append("rest-event", event, index);
      });
    } catch (error) {
      finalReadError = errorMessage(error);
    }
  } catch (error) {
    captureError = errorMessage(error);
    append("capture-error", { error: captureError.slice(0, 512) });
    const recoverySignal = request.signal?.aborted ? AbortSignal.timeout(100) : request.signal;
    try {
      await readFinalEvents(fetch, baseUrl, conversationId, request.sessionApiKey, maxResponseBytes, recoverySignal, request.timeoutMs, (event, index) => {
        finalEvents.push(event);
        append("rest-event", event, index);
      });
    } catch (readError) {
      finalReadError = errorMessage(readError);
    }
  } finally {
    socket?.close();
  }
  try {
    const cleanupSignal = request.signal?.aborted ? AbortSignal.timeout(100) : request.signal;
    await requestJson(fetch, baseUrl, `/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
    }, request.sessionApiKey, maxResponseBytes, cleanupSignal, request.timeoutMs);
    append("cleanup", { success: true });
  } catch (error) {
    append("cleanup", { success: false, error: errorMessage(error).slice(0, 512) });
  }

  const streamedEventIds = eventIds(streamed);
  const finalEventIds = eventIds(finalEvents);
  const streamedSet = new Set(streamedEventIds);
  const finalSet = new Set(finalEventIds);
  const streamedOnlyEventIds = streamedEventIds.filter((id) => !finalSet.has(id));
  const finalOnlyEventIds = finalEventIds.filter((id) => !streamedSet.has(id));
  const transportGaps = records.flatMap(({ record }) => record.channel === "websocket-status"
    && ["message-rejected", "reconnect-exhausted", "reconnect-failed", "event-limit-reached", "status-limit-reached"].includes(String(record.payload.state))
    ? [String(record.payload.state)] : []);
  return {
    runId: request.runId,
    attemptId: request.attemptId,
    qualification: "qualified-with-gaps",
    records,
    conversationId,
    serverInfo,
    ...(finalConversation === undefined ? {} : { finalConversation }),
    ...(captureError === undefined ? {} : { captureError }),
    reconciliation: {
      status: captureError !== undefined || finalReadError !== undefined || transportGaps.length > 0 ? "partial"
        : streamedOnlyEventIds.length === 0 && finalOnlyEventIds.length === 0 ? "matched" : "mismatch",
      streamedEventIds,
      finalEventIds,
      streamedOnlyEventIds,
      finalOnlyEventIds,
      transportGaps,
      ...(finalReadError === undefined ? {} : { finalReadError }),
    },
    eventLogCompleteness: {
      status: "unknown",
      reason: "REST/WebSocket reconciliation cannot prove complete in-process EventLog delivery.",
    },
  };
}

export async function normalizeOpenHandsCapture(
  capture: NormalizationInput<OpenHandsNativeRecord>,
): Promise<NormalizationResult> {
  const conversationId = capture.records.find(({ record }) => record.session_id !== undefined)?.record.session_id;
  if (conversationId === undefined) {
    return {
      events: [],
      unmapped: capture.records.map(({ reference }) => ({
        reference,
        reason: "capture ended before the Agent Server assigned a conversation identity",
      })),
    };
  }
  const canonical = new Map<string, CapturedNativeRecord<OpenHandsNativeRecord>>();
  for (const captured of capture.records) {
    if (captured.record.channel !== "rest-event") continue;
    const id = nativeEventId(captured.record.payload);
    if (id !== undefined) canonical.set(id, captured);
  }
  for (const captured of capture.records) {
    if (captured.record.channel !== "websocket-event") continue;
    const id = nativeEventId(captured.record.payload);
    if (id !== undefined && !canonical.has(id)) canonical.set(id, captured);
  }

  const events: UniformEvent[] = [];
  const mappedReferences = new Set<string>();
  const eventIdByNativeId = new Map<string, string>();
  for (const [id, captured] of canonical) {
    const native = captured.record.payload;
    const kind = typeof native.kind === "string" ? native.kind : "";
    const eventId = uniformEventId(id);
    if (mappedEvent(kind) !== undefined && nativeEventSource(native.source) !== undefined && eventId !== undefined) {
      eventIdByNativeId.set(id, eventId);
    }
  }
  for (const [nativeId, captured] of canonical) {
    if (!eventIdByNativeId.has(nativeId)) continue;
    const mapped = mapOpenHandsEvent(capture, conversationId, captured, nativeId, eventIdByNativeId);
    if (mapped === undefined) continue;
    events.push(mapped);
    mappedReferences.add(referenceKey(captured.reference));
  }
  for (const captured of capture.records.filter(({ record }) => record.channel === "conversation-final")) {
    events.push(mapOpenHandsOutcome(capture, conversationId, captured));
    mappedReferences.add(referenceKey(captured.reference));
  }
  return {
    events,
    unmapped: capture.records
      .filter(({ reference }) => !mappedReferences.has(referenceKey(reference)))
      .map(({ reference, record }) => ({
        reference,
        reason: record.channel === "websocket-event" && canonical.has(nativeEventId(record.payload) ?? "")
          ? "reconciled duplicate; final REST event is canonical"
          : "native record has no uniform mapping",
      })),
  };
}

function mapOpenHandsOutcome(
  capture: NormalizationInput<OpenHandsNativeRecord>,
  conversationId: string,
  captured: CapturedNativeRecord<OpenHandsNativeRecord>,
): UniformEvent {
  const native = captured.record.payload;
  const attributes: Record<string, string | number | boolean | null> = {};
  copyScalar(attributes, "executionStatus", native.execution_status);
  if (isRecord(native.workspace)) {
    copyScalar(attributes, "workspaceKind", native.workspace.kind ?? native.workspace.type);
  }
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id: `openhands:conversation-final:${captured.record.sequence}`,
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: {
      harness: "openhands-agent-server",
      nativeType: "conversation-final",
      nativeReference: captured.reference,
    },
    nativeOrder: { status: "unknown", reason: "Conversation status records have no native sequence." },
    nativeTime: isOffsetDateTime(native.updated_at)
      ? { status: "known", value: native.updated_at }
      : { status: "unknown", reason: "Final conversation record omitted an RFC 3339 update time with an explicit offset." },
    actor: { kind: "harness", id: "openhands-agent-server" },
    family: "outcome",
    phase: "after",
    scope: { kind: "session", id: conversationId },
    relations: {
      parent: { status: "unknown", reason: "Agent Server does not relate final conversation state to one event." },
      known: [],
    },
    attributes,
    content: {
      status: "known",
      value: [{
        nativeReference: {
          artifactId: captured.reference.artifactId,
          recordLocator: `${captured.reference.recordLocator}#/payload`,
        },
        mediaType: "application/json",
      }],
    },
  };
}

function mapOpenHandsEvent(
  capture: NormalizationInput<OpenHandsNativeRecord>,
  conversationId: string,
  captured: CapturedNativeRecord<OpenHandsNativeRecord>,
  nativeId: string,
  eventIdByNativeId: ReadonlyMap<string, string>,
): UniformEvent | undefined {
  const native = captured.record.payload;
  const kind = typeof native.kind === "string" ? native.kind : undefined;
  if (kind === undefined) return undefined;
  const mapping = mappedEvent(kind);
  if (mapping === undefined) return undefined;
  const source = nativeEventSource(native.source);
  if (source === undefined) return undefined;
  const parentId = typeof native.parent_id === "string" ? eventIdByNativeId.get(native.parent_id) : undefined;
  const knownRelations: Array<UniformEvent["relations"]["known"][number]> = [];
  if (kind === "ObservationEvent" && typeof native.action_id === "string") {
    const actionId = eventIdByNativeId.get(native.action_id);
    if (actionId !== undefined) knownRelations.push({ kind: "caused-by", eventId: actionId });
  }
  if (kind === "HookExecutionEvent") {
    const relatedId = typeof native.action_id === "string" ? native.action_id
      : typeof native.message_id === "string" ? native.message_id : undefined;
    const eventId = relatedId === undefined ? undefined : eventIdByNativeId.get(relatedId);
    if (eventId !== undefined) knownRelations.push({ kind: "correlates-with", eventId });
  }
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id: eventIdByNativeId.get(nativeId)!,
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: {
      harness: "openhands-agent-server",
      nativeType: kind,
      nativeReference: captured.reference,
    },
    nativeOrder: captured.record.channelSequence === undefined
      ? { status: "unknown", reason: "Agent Server record has no native sequence." }
      : {
          status: "known",
          value: captured.record.channelSequence,
          domain: captured.record.channel === "rest-event" ? "agent-server-rest" : "agent-server-websocket",
        },
    nativeTime: isOffsetDateTime(native.timestamp)
      ? { status: "known", value: native.timestamp }
      : { status: "unknown", reason: "Agent Server event omitted an RFC 3339 timestamp with an explicit offset." },
    actor: { kind: actorForSource(source), id: source },
    family: mapping.family,
    phase: mapping.phase,
    scope: { kind: "session", id: conversationId },
    relations: {
      parent: parentId === undefined
        ? { status: "unknown", reason: "No captured mapped parent event is available." }
        : { status: "known", value: parentId },
      known: knownRelations,
    },
    attributes: eventAttributes(kind, source, native),
    content: eventContent(kind, captured),
  };
}

function mappedEvent(kind: string): Pick<UniformEvent, "family" | "phase"> | undefined {
  if (kind === "MessageEvent" || kind === "SystemPromptEvent") return { family: "message", phase: "instant" };
  if (kind === "ActionEvent") return { family: "tool", phase: "before" };
  if (["ObservationEvent", "AgentErrorEvent", "UserRejectObservation"].includes(kind)) return { family: "tool", phase: "after" };
  if (kind === "CondensationRequest") return { family: "context", phase: "before" };
  if (kind === "Condensation") return { family: "context", phase: "during" };
  if (kind === "CondensationSummaryEvent") return { family: "context", phase: "after" };
  if (["ConversationErrorEvent", "ServerErrorEvent", "HookExecutionEvent", "ConversationStateUpdateEvent", "InterruptEvent", "PauseEvent"].includes(kind)) {
    return { family: "runtime", phase: "instant" };
  }
  return undefined;
}

function eventAttributes(
  kind: string,
  source: string,
  native: Record<string, unknown>,
): Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]> {
  const attributes: Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]> = {
    nativeSource: source,
  };
  copyScalar(attributes, "toolName", native.tool_name);
  copyScalar(attributes, "toolCallId", native.tool_call_id);
  copyScalar(attributes, "actionId", native.action_id);
  copyScalar(attributes, "llmResponseId", native.llm_response_id);
  if (kind === "AgentErrorEvent") attributes.errorScope = "agent-tool";
  if (kind === "ConversationErrorEvent") attributes.errorScope = "conversation";
  if (kind === "ServerErrorEvent") attributes.errorScope = "server";
  if (["ConversationErrorEvent", "ServerErrorEvent"].includes(kind)) copyScalar(attributes, "errorCode", native.code);
  if (kind === "HookExecutionEvent") {
    copyScalar(attributes, "hookEventType", native.hook_event_type);
    copyScalar(attributes, "success", native.success);
    copyScalar(attributes, "exitCode", native.exit_code);
    copyScalar(attributes, "blocked", native.blocked);
  }
  if (kind === "ConversationStateUpdateEvent") {
    copyScalar(attributes, "stateKey", native.key);
    copyScalar(attributes, "stateValue", native.value);
  }
  if (kind === "Condensation" && Array.isArray(native.forgotten_event_ids)
      && native.forgotten_event_ids.length <= 16 && native.forgotten_event_ids.every((value) => typeof value === "string")) {
    attributes.forgottenEventIds = native.forgotten_event_ids;
  }
  return attributes;
}

function copyScalar(
  target: Record<string, string | number | boolean | null | readonly (string | number | boolean | null)[]>,
  name: string,
  value: unknown,
): void {
  if (typeof value === "string" && value.length <= 512 || typeof value === "number" && Number.isFinite(value)
      || typeof value === "boolean" || value === null) target[name] = value;
}

function eventContent(
  kind: string,
  captured: CapturedNativeRecord<OpenHandsNativeRecord>,
): UniformEvent["content"] {
  const native = captured.record.payload;
  const llmMessage = isRecord(native.llm_message) ? native.llm_message : undefined;
  const pointer = kind === "MessageEvent" && llmMessage !== undefined && Object.hasOwn(llmMessage, "content")
    ? "/payload/llm_message/content"
    : kind === "SystemPromptEvent" && Object.hasOwn(native, "system_prompt") ? "/payload/system_prompt"
      : kind === "ActionEvent" && Object.hasOwn(native, "action") ? "/payload/action"
        : ["ObservationEvent", "UserRejectObservation"].includes(kind) && Object.hasOwn(native, "observation") ? "/payload/observation"
          : kind === "AgentErrorEvent" && Object.hasOwn(native, "error") ? "/payload/error"
            : ["ConversationErrorEvent", "ServerErrorEvent"].includes(kind) && Object.hasOwn(native, "detail") ? "/payload/detail"
              : kind === "Condensation" || kind === "HookExecutionEvent" ? "/payload"
                : kind === "CondensationSummaryEvent" && Object.hasOwn(native, "summary") ? "/payload/summary"
                  : undefined;
  return pointer === undefined
    ? { status: "unknown", reason: "Pinned Agent Server event has no mapped content field." }
    : {
        status: "known",
        value: [{
          nativeReference: {
            artifactId: captured.reference.artifactId,
            recordLocator: `${captured.reference.recordLocator}#${pointer}`,
          },
          mediaType: "application/json",
        }],
      };
}

type OpenHandsEventSource = "user" | "agent" | "environment" | "hook";

function nativeEventSource(value: unknown): OpenHandsEventSource | undefined {
  return ["user", "agent", "environment", "hook"].includes(String(value))
    ? value as OpenHandsEventSource : undefined;
}

function actorForSource(source: OpenHandsEventSource): UniformEvent["actor"]["kind"] {
  if (source === "user") return "user";
  if (source === "agent") return "agent";
  return "harness";
}

async function openEventSocket(
  request: OpenHandsCaptureRequest,
  baseUrl: URL,
  conversationId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onStatus: (status: Record<string, unknown>) => void,
): Promise<OpenHandsWebSocket> {
  let current: OpenHandsWebSocket | undefined;
  let lastTimestamp: string | undefined;
  let reconnects = 0;
  let stopped = false;
  const factory = request.webSocket ?? ((socketUrl: string) => new WebSocket(socketUrl));

  const connect = async (resendMode: "all" | "since"): Promise<void> => {
    assertNotAborted(request.signal);
    const url = new URL(`/sockets/events/${encodeURIComponent(conversationId)}`, baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("resend_mode", resendMode);
    if (resendMode === "since" && lastTimestamp !== undefined) url.searchParams.set("after_timestamp", lastTimestamp);
    const socket = factory(url.toString());
    current = socket;
    let active = true;
    const onMessage = ({ data }: { data?: unknown }): void => {
      if (!active) return;
      try {
        const text = typeof data === "string" ? data : String(data);
        const maxBytes = request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
        if (Buffer.byteLength(text) > maxBytes) {
          onStatus({ state: "message-rejected", reason: `frame exceeds ${maxBytes} bytes` });
          return;
        }
        const value: unknown = JSON.parse(text);
        if (isRecord(value)) {
          if (typeof value.timestamp === "string") lastTimestamp = value.timestamp;
          onEvent(value);
        } else {
          onStatus({ state: "message-rejected", reason: "frame is not a JSON object" });
        }
      } catch (error) {
        onStatus({ state: "message-rejected", reason: errorMessage(error).slice(0, 512) });
      }
    };
    const onClose = (): void => {
      active = false;
      if (stopped) return;
      onStatus({ state: "disconnected", connection: reconnects + 1 });
      if (reconnects >= (request.maxReconnects ?? 2)) {
        onStatus({ state: "reconnect-exhausted", connection: reconnects + 1 });
        return;
      }
      reconnects += 1;
      onStatus({ state: "reconnecting", connection: reconnects + 1 });
      setTimeout(() => {
        if (!stopped) void connect(lastTimestamp === undefined ? "all" : "since").catch((error: unknown) => {
          onStatus({ state: "reconnect-failed", reason: errorMessage(error).slice(0, 512) });
        });
      }, request.reconnectDelayMs ?? 250);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const cleanupPending = (): void => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        active = false;
        stopped = true;
        cleanupPending();
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.close();
        reject(error);
      };
      const onAbort = (): void => {
        fail(new Error("OpenHands capture was aborted."));
      };
      const onOpen = (): void => {
        if (settled) return;
        settled = true;
        cleanupPending();
        if (request.sessionApiKey !== undefined) {
          socket.send(JSON.stringify({ type: "auth", session_api_key: request.sessionApiKey }));
        }
        onStatus({ state: "connected", connection: reconnects + 1, resendMode });
        resolvePromise();
      };
      const timeout = setTimeout(() => fail(new Error("OpenHands event WebSocket did not open before timeout.")), request.timeoutMs ?? 30_000);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen);
    });
  };

  await connect("all");
  const onAbort = (): void => {
    stopped = true;
    current?.close();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    get readyState() { return current?.readyState ?? 3; },
    addEventListener: (...args) => current?.addEventListener(...args),
    removeEventListener: (...args) => current?.removeEventListener(...args),
    send: (data) => current?.send(data),
    close: () => {
      stopped = true;
      request.signal?.removeEventListener("abort", onAbort);
      current?.close();
    },
  };
}

async function pollConversation(
  fetch: typeof globalThis.fetch,
  baseUrl: URL,
  conversationId: string,
  request: OpenHandsCaptureRequest,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + (request.timeoutMs ?? 300_000);
  for (;;) {
    const conversation = await requestJson(
      fetch,
      baseUrl,
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      undefined,
      request.sessionApiKey,
      request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      request.signal,
      request.timeoutMs,
    );
    if (typeof conversation.execution_status === "string" && TERMINAL_STATUSES.has(conversation.execution_status)) {
      return conversation;
    }
    if (Date.now() >= deadline) throw new Error("OpenHands conversation did not reach a terminal status before timeout.");
    await abortableDelay(request.pollIntervalMs ?? 250, request.signal);
  }
}

async function readFinalEvents(
  fetch: typeof globalThis.fetch,
  baseUrl: URL,
  conversationId: string,
  sessionApiKey?: string,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal?: AbortSignal,
  timeoutMs?: number,
  onEvent?: (event: Record<string, unknown>, index: number) => void,
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const pageIds = new Set<string>();
  let pageId: string | undefined;
  do {
    if (pageId !== undefined && pageIds.has(pageId)) throw new Error("OpenHands event pagination repeated a page cursor.");
    if (pageId !== undefined) pageIds.add(pageId);
    const path = new URL(`/api/conversations/${encodeURIComponent(conversationId)}/events/search`, baseUrl);
    path.searchParams.set("limit", "100");
    path.searchParams.set("sort_order", "TIMESTAMP");
    if (pageId !== undefined) path.searchParams.set("page_id", pageId);
    const page = await requestJson(fetch, baseUrl, path.toString(), undefined, sessionApiKey, maxResponseBytes, signal, timeoutMs);
    if (!Array.isArray(page.items) || !page.items.every(isRecord)) throw new Error("OpenHands event search returned an invalid page.");
    if (events.length + page.items.length > MAX_CAPTURE_EVENTS) throw new Error(`OpenHands event capture exceeds ${MAX_CAPTURE_EVENTS} records.`);
    for (const event of page.items) {
      events.push(event);
      onEvent?.(event, events.length);
    }
    pageId = typeof page.next_page_id === "string" && page.next_page_id.length > 0 ? page.next_page_id : undefined;
  } while (pageId !== undefined);
  return events;
}

async function requestJson(
  fetch: typeof globalThis.fetch,
  baseUrl: URL,
  path: string,
  init?: RequestInit,
  sessionApiKey?: string,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  if (sessionApiKey !== undefined) headers.set("x-session-api-key", sessionApiKey);
  const requestSignal = AbortSignal.any([
    ...[init?.signal, signal].filter((candidate): candidate is AbortSignal => candidate !== undefined),
    AbortSignal.timeout(Math.min(timeoutMs, 2_147_483_647)),
  ]);
  const response = await fetch(path.startsWith("http") ? path : new URL(path, baseUrl), { ...init, headers, signal: requestSignal });
  if (!response.ok) throw new Error(`OpenHands request ${init?.method ?? "GET"} ${new URL(response.url || path, baseUrl).pathname} failed with ${response.status}.`);
  const bytes = await readBoundedResponse(response, maxResponseBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`OpenHands response is not valid UTF-8 JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error("OpenHands response is not a JSON object.");
  return value;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`OpenHands response exceeds ${maxBytes} bytes.`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`OpenHands response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("OpenHands base URL must use HTTP or HTTPS.");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("OpenHands base URL must not include credentials, query parameters, or a fragment.");
  }
  if (url.pathname !== "/") throw new Error("OpenHands base URL must be a bare origin without a path prefix.");
  return url;
}

function assertIntegerOption(value: number | undefined, minimum: number, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new Error(`OpenHands ${label} must be a safe integer of at least ${minimum}.`);
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("OpenHands capture was aborted.");
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const onElapsed = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("OpenHands capture was aborted."));
    };
    const timer = setTimeout(onElapsed, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function eventIds(events: readonly Record<string, unknown>[]): string[] {
  return [...new Set(events.map(nativeEventId).filter((id): id is string => id !== undefined))];
}

function nativeEventId(event: Record<string, unknown>): string | undefined {
  return typeof event.id === "string" && event.id.length > 0 ? event.id : undefined;
}

function uniformEventId(nativeId: string): string | undefined {
  const eventId = `openhands:${nativeId}`;
  return eventId.length <= 255 ? eventId : undefined;
}

function isOffsetDateTime(value: unknown): value is string {
  return typeof value === "string"
    && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function referenceKey(reference: CapturedNativeRecord<unknown>["reference"]): string {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
