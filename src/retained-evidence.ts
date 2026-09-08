import { join } from "node:path";
import { readQualifiedRunCapture, createAgentSdkNativeEvidenceResolver, type AgentSdkNativeRecord } from "./agent-sdk-normalizer.js";
import { createAgentSdkBehaviorEvidence } from "./behavior-assertions.js";
import { describeAndValidateCodexDataset, CODEX_HARNESS } from "./codex.js";
import { normalizeOpenHandsCapture, OPENHANDS_AGENT_SERVER_CAPABILITIES, OPENHANDS_AGENT_SERVER_VERSION, type OpenHandsNativeRecord } from "./openhands.js";
import { createDeepSeekHarnessAdapter, DEEPSEEK_HARNESS_ID, DEEPSEEK_SDK_VERSION, normalizeDeepSeekCapture, qualifyRetainedDeepSeekCapture, type DeepSeekNativeObservation } from "./deepseek-adapter.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset, validateNormalizedDataset, type AdapterCoverageReport, type NormalizedDataset } from "./normalization-integrity.js";
import { readBoundedFile } from "./scheduler.js";
import { assertProtocolObservation, type ProtocolObservation } from "./process-protocol.js";
import type { NormalizationInput, NativeEvidenceResolver } from "./uniform-events.js";
import type { RunManifest } from "./run-bundles.js";

export type RetainedBehaviorEvidence = {
  capture: NormalizationInput<unknown>;
  /** Verified bundle metadata for outcome import; never replaces native session records. */
  outcomeCapture: NormalizationInput<AgentSdkNativeRecord>;
  dataset: NormalizedDataset;
  resolver: NativeEvidenceResolver;
  coverage: AdapterCoverageReport;
};

export async function createRetainedBehaviorEvidence(bundleRoot: string): Promise<RetainedBehaviorEvidence> {
  const manifest = JSON.parse(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest").toString("utf8")) as RunManifest;
  const harness = manifest.run.harness.id;
  if (![CODEX_HARNESS, "openhands-agent-server", DEEPSEEK_HARNESS_ID].includes(harness)) {
    const evidence = await createAgentSdkBehaviorEvidence(bundleRoot);
    return { ...evidence, outcomeCapture: evidence.capture };
  }
  if (harness === "openhands-agent-server" && manifest.run.harness.version !== OPENHANDS_AGENT_SERVER_VERSION) {
    throw new Error(`Unsupported retained OpenHands runtime ${manifest.run.harness.version}.`);
  }
  if (harness === DEEPSEEK_HARNESS_ID && manifest.run.harness.version !== DEEPSEEK_SDK_VERSION) {
    throw new Error(`Unsupported retained DeepSeek runtime ${manifest.run.harness.version}.`);
  }
  const outcomeCapture = await readQualifiedRunCapture(bundleRoot);
  // A verifier task failure also presupposes a normally completed native run.
  const expectsCompletion = manifest.terminal.state === "completed" || manifest.terminal.failureClass === "task";
  const capture = {
    ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind === "session")
      .map(({ reference, record }) => {
        assertNativeEnvelope(harness, record.document, Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]));
        return { reference, record: record.document };
      }),
  };
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver({ ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind !== "session" && record.kind !== "hook"),
  }));
  let dataset: NormalizedDataset;
  if (harness === CODEX_HARNESS) {
    const native = capture as NormalizationInput<ProtocolObservation> & { threadId?: string; turnId?: string };
    const handshakeVersions = native.records.filter(({ record }) => record.kind === "response" && record.source === CODEX_HARNESS && record.method === "initialize")
      .map(({ record }) => String((record.payload as Record<string, unknown> | undefined)?.userAgent ?? "").match(/^[^\s/]+\/([^\s]+)/u)?.[1]);
    const telemetryVersions = outcomeCapture.records.flatMap(({ record }) => {
      const document = record.document as Record<string, any> | undefined;
      return document?.schemaVersion === "ebo.codex-telemetry/v1" ? [document.runtime?.version] : [];
    });
    if (handshakeVersions.length === 0 || [...handshakeVersions, ...telemetryVersions,
      ...manifest.run.runtime.filter(({ name }) => name === CODEX_HARNESS).map(({ version }) => version),
    ].some((version) => version !== manifest.run.harness.version)) {
      throw new Error("Retained Codex native runtime version differs from the run manifest.");
    }
    const identities = (method: string, key: "thread" | "turn"): string | undefined => {
      const ids = new Set(native.records.flatMap(({ record }) => {
        const payload = record.payload as Record<string, any> | undefined;
        return record.kind === "response" && record.source === CODEX_HARNESS && record.method === method && typeof payload?.[key]?.id === "string" ? [payload[key].id as string] : [];
      }));
      const optionalPartialTurn = key === "turn" && !expectsCompletion;
      if (ids.size > 1 || ids.size === 0 && !optionalPartialTurn) throw new Error(`Retained Codex ${method} requires one owned identity.`);
      return [...ids][0];
    };
    native.threadId = identities("thread/start", "thread");
    native.turnId = identities("turn/start", "turn");
    if (native.threadId !== manifest.run.native?.sessionId) throw new Error("Retained Codex thread identity differs from the run manifest.");
    const terminals = native.records.filter(({ record }) => {
      const payload = record.payload as Record<string, any> | undefined;
      return record.kind === "notification" && record.source === CODEX_HARNESS && record.method === "turn/completed"
        && payload?.threadId === native.threadId && payload?.turn?.id === native.turnId;
    });
    if (terminals.length > 1 || expectsCompletion && (terminals[0]?.record.payload as Record<string, any> | undefined)?.turn?.status !== "completed") {
      throw new Error("Retained Codex capture requires unambiguous matching owned terminal evidence.");
    }
    dataset = (await describeAndValidateCodexDataset(native, manifest.run.harness.version)).dataset;
  } else if (harness === "openhands-agent-server") {
    const native = capture as NormalizationInput<OpenHandsNativeRecord>;
    const sessionId = manifest.run.native?.sessionId;
    const serverInfo = native.records.filter(({ record }) => record.channel === "server-info");
    if (serverInfo.length !== 1) throw new Error("Retained OpenHands capture requires exactly one native server-info record.");
    for (const { record } of native.records) {
      if (record.channel === "server-info" && record.payload.version !== manifest.run.harness.version) {
        throw new Error("Retained OpenHands native server version differs from the run manifest.");
      }
      if (record.session_id !== undefined && record.session_id !== sessionId
        || ["conversation-created", "websocket-status", "websocket-event", "rest-event", "conversation-final"].includes(record.channel)
          && (sessionId === undefined || record.session_id !== sessionId)
        || ["conversation-created", "conversation-final"].includes(record.channel) && record.payload.id !== sessionId) {
        throw new Error("Retained OpenHands conversation identity differs from the run manifest.");
      }
    }
    const finals = native.records.filter(({ record }) => record.channel === "conversation-final");
    if (expectsCompletion && (finals.length !== 1 || finals[0]!.record.payload.execution_status !== "finished")) {
      throw new Error("Completed retained OpenHands capture lacks owned finished conversation evidence.");
    }
    dataset = describeNormalizedDataset({ capture: native, normalization: await normalizeOpenHandsCapture(native),
      capabilityProfile: OPENHANDS_AGENT_SERVER_CAPABILITIES, adapterVersion: OPENHANDS_AGENT_SERVER_VERSION,
      nativeType: (record) => typeof record.payload.kind === "string" ? record.payload.kind : record.channel });
  } else {
    const native = qualifyRetainedDeepSeekCapture(capture as NormalizationInput<DeepSeekNativeObservation>,
      manifest.run.native?.sessionId, expectsCompletion);
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({ capture: native, normalization: normalizeDeepSeekCapture(native),
      capabilityProfile: createDeepSeekHarnessAdapter().normalization.capabilityProfile, adapterVersion: DEEPSEEK_SDK_VERSION,
      nativeType: (record) => record.method ?? record.kind });
  }
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { capture, outcomeCapture, dataset, resolver, coverage };
}

function assertNativeEnvelope(harness: string, value: unknown, line: number): void {
  const fail = (): never => { throw new Error(`Invalid retained ${harness} native envelope at line ${line}.`); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(line) || line < 1 || record.sequence !== line) fail();
  if (harness === CODEX_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== CODEX_HARNESS && value.source !== "ebo-codex-client") fail();
    if (value.source === "ebo-codex-client" && (!["request", "response", "notification"].includes(value.kind)
      || value.kind === "notification" && value.method !== "initialized")) fail();
    return;
  }
  const optionalText = (fields: string[]) => fields.every((field) => record[field] === undefined
    || typeof record[field] === "string" && (record[field] as string).trim() !== "");
  if (harness === "openhands-agent-server") {
    if (record.schemaVersion !== "ebo.openhands-native-record/v1"
      || !["server-info", "conversation-create-response", "conversation-created", "websocket-status", "websocket-event", "conversation-final", "rest-event", "capture-error", "cleanup"].includes(String(record.channel))
      || record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)
      || !optionalText(["session_id"]) || record.channelSequence !== undefined
        && (typeof record.channelSequence !== "number" || !Number.isSafeInteger(record.channelSequence) || record.channelSequence < 0)) fail();
    return;
  }
  if (record.schemaVersion !== "ebo.deepseek-native-observation/v1"
    || !["composition", "capability", "request", "response", "notification", "diagnostic", "error"].includes(String(record.kind))
    || typeof record.observedAt !== "string" || record.observedAt.trim() === ""
    || !optionalText(["method", "sessionId", "sourceIdentity"]) || record.stream !== undefined && record.stream !== "stderr"
    || ["request", "response", "notification"].includes(String(record.kind)) && typeof record.method !== "string") fail();
}
