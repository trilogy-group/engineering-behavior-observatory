import { join } from "node:path";
import { CLAUDE_AGENT_SDK_HARNESS, readQualifiedRunCapture, createAgentSdkNativeEvidenceResolver, type AgentSdkNativeRecord } from "./agent-sdk-normalizer.js";
import { createAgentSdkBehaviorEvidence } from "./behavior-assertions.js";
import { describeAndValidateCodexDataset, CODEX_HARNESS } from "./codex.js";
import { describeAndValidateDevinDataset, DEVIN_HARNESS, qualifyRetainedDevinCapture, RETAINED_DEVIN_CLI_VERSIONS } from "./devin.js";
import { normalizeOpenHandsCapture, openHandsCapabilityProfile, type OpenHandsNativeRecord } from "./openhands.js";
import { createDeepSeekHarnessAdapter, DEEPSEEK_HARNESS_ID, RETAINED_DEEPSEEK_SDK_VERSIONS, normalizeDeepSeekCapture, qualifyRetainedDeepSeekCapture, type DeepSeekNativeObservation } from "./deepseek-adapter.js";
import { createCursorSdkBehaviorEvidence, CURSOR_SDK_HARNESS } from "./cursor-sdk.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset, validateNormalizedDataset, type AdapterCoverageReport, type NormalizedDataset } from "./normalization-integrity.js";
import { readBoundedFile } from "./scheduler.js";
import { assertProtocolObservation, type ProtocolObservation } from "./process-protocol.js";
import type { NormalizationInput, NativeEvidenceResolver } from "./uniform-events.js";
import type { RunManifest } from "./run-bundles.js";
import {
  assertPiNativeRecord,
  normalizePiCapture,
  piCapabilityProfile,
  piNativeType,
  qualifyRetainedPiCapture,
  PI_ADAPTER_VERSION,
  PI_HARNESS,
  RETAINED_PI_SDK_VERSIONS,
  type PiNativeRecord,
} from "./pi.js";

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
  if (harness === CURSOR_SDK_HARNESS) return createCursorSdkBehaviorEvidence(bundleRoot);
  const isAgentSdk = [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(harness)
    || manifest.run.runtime.some(({ source, name }) => source === "anthropic" && [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(name));
  if (isAgentSdk) {
    const evidence = await createAgentSdkBehaviorEvidence(bundleRoot);
    return { ...evidence, outcomeCapture: evidence.capture };
  }
  if (![CODEX_HARNESS, DEVIN_HARNESS, "openhands-agent-server", DEEPSEEK_HARNESS_ID, PI_HARNESS].includes(harness)) {
    throw new Error(`Unsupported retained harness ${harness}; refusing Agent SDK fallback normalization.`);
  }
  if (harness === "openhands-agent-server") openHandsCapabilityProfile(manifest.run.harness.version);
  if (harness === DEEPSEEK_HARNESS_ID && !RETAINED_DEEPSEEK_SDK_VERSIONS.includes(manifest.run.harness.version)) {
    throw new Error(`Unsupported retained DeepSeek runtime ${manifest.run.harness.version}.`);
  }
  if (harness === DEVIN_HARNESS && !RETAINED_DEVIN_CLI_VERSIONS.includes(manifest.run.harness.version)) {
    throw new Error(`Unsupported retained Devin runtime ${manifest.run.harness.version}.`);
  }
  if (harness === PI_HARNESS && !RETAINED_PI_SDK_VERSIONS.includes(manifest.run.harness.version)) {
    throw new Error(`Unsupported retained Pi runtime ${manifest.run.harness.version}.`);
  }
  if (harness === PI_HARNESS) {
    const expected = new Map([
      ["pi-coding-agent", { source: "earendil-works", version: manifest.run.harness.version }],
      [PI_HARNESS, { source: "EBO", version: manifest.run.harness.version }],
      ["pi-sdk-adapter", { source: "EBO", version: PI_ADAPTER_VERSION }],
    ]);
    for (const [name, identity] of expected) {
      const matches = manifest.run.runtime.filter((runtime) => runtime.name === name);
      if (matches.length !== 1 || matches[0]!.source !== identity.source || matches[0]!.version !== identity.version) {
        throw new Error(`Retained Pi runtime identity ${name} differs from the pinned adapter manifest.`);
      }
    }
  }
  const outcomeCapture = await readQualifiedRunCapture(bundleRoot);
  // A verifier task failure also presupposes a normally completed native run.
  const expectsCompletion = manifest.terminal.state === "completed" || manifest.terminal.failureClass === "task";
  const capture = {
    ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind === "session")
      .map(({ reference, record }) => {
        const line = Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]);
        if (harness === PI_HARNESS) assertPiNativeRecord(record.document, line);
        else assertNativeEnvelope(harness, record.document, line);
        return { reference, record: record.document };
      }),
  };
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver({ ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind !== "session" && record.kind !== "hook"),
  }));
  let dataset: NormalizedDataset;
  if (harness === PI_HARNESS) {
    const native = qualifyRetainedPiCapture(capture as NormalizationInput<PiNativeRecord>, manifest.run.native?.sessionId, expectsCompletion);
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({
      capture: native,
      normalization: await normalizePiCapture(native),
      capabilityProfile: piCapabilityProfile,
      adapterVersion: PI_ADAPTER_VERSION,
      nativeType: piNativeType,
    });
  } else if (harness === CODEX_HARNESS) {
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
    let acceptedStartSequence = 0;
    const identities = (method: string, key: "thread" | "turn"): string | undefined => {
      const accepted = native.records.filter(({ record }) => {
        const payload = record.payload as Record<string, any> | undefined;
        return record.kind === "response" && record.source === CODEX_HARNESS && record.method === method
          && typeof payload?.[key]?.id === "string" && payload[key].id.trim() !== "";
      });
      const optionalPartialTurn = key === "turn" && !expectsCompletion;
      if (accepted.length === 0 && optionalPartialTurn) return undefined;
      if (accepted.length !== 1) throw new Error(`Retained Codex ${method} requires one owned identity.`);
      const response = accepted[0]!.record;
      const requests = native.records.filter(({ record }) => record.kind === "request" && record.source === "ebo-codex-client" && record.id === response.id);
      const responses = native.records.filter(({ record }) => record.kind === "response" && record.source === CODEX_HARNESS && record.id === response.id);
      const request = requests[0]?.record;
      const payload = response.payload as Record<string, any>;
      if (response.id === undefined || response.id === null || requests.length !== 1 || responses.length !== 1
        || request?.method !== method || request.sequence <= acceptedStartSequence || request.sequence >= response.sequence
        || key === "turn" && ((request.payload as Record<string, unknown> | undefined)?.threadId !== native.threadId
          || payload.turn.threadId !== undefined && payload.turn.threadId !== native.threadId)) {
        throw new Error(`Retained Codex ${method} requires a unique ordered owned request/response pair.`);
      }
      acceptedStartSequence = response.sequence;
      return payload[key].id as string;
    };
    native.threadId = identities("thread/start", "thread");
    native.turnId = identities("turn/start", "turn");
    if (native.threadId !== manifest.run.native?.sessionId) throw new Error("Retained Codex thread identity differs from the run manifest.");
    const terminals = native.records.filter(({ record }) => {
      const payload = record.payload as Record<string, any> | undefined;
      return record.kind === "notification" && record.source === CODEX_HARNESS && record.method === "turn/completed"
        && payload?.threadId === native.threadId && payload?.turn?.id === native.turnId;
    });
    if (terminals.length > 1 || terminals.some(({ record }) => record.sequence <= acceptedStartSequence)
      || expectsCompletion && (terminals[0]?.record.payload as Record<string, any> | undefined)?.turn?.status !== "completed") {
      throw new Error("Retained Codex capture requires unambiguous matching owned terminal evidence.");
    }
    dataset = (await describeAndValidateCodexDataset(native, manifest.run.harness.version)).dataset;
  } else if (harness === DEVIN_HARNESS) {
    // The native runtime document is the only runtime-version evidence; never fall back to the manifest pin alone.
    const telemetryDocuments = outcomeCapture.records.filter(({ record }) => record.kind === "telemetry").map(({ record }) => record.document as Record<string, any> | undefined);
    if (telemetryDocuments.length !== 1 || telemetryDocuments[0]?.schemaVersion !== "ebo.devin-telemetry/v1") {
      throw new Error("Retained Devin capture requires exactly one recognized ebo.devin-telemetry/v1 runtime document.");
    }
    const telemetryVersion = telemetryDocuments[0].runtime?.version;
    if (typeof telemetryVersion !== "string") throw new Error("Retained Devin runtime document lacks a native runtime version.");
    const runtimeVersions = manifest.run.runtime.filter(({ name }) => name === DEVIN_HARNESS).map(({ version }) => version);
    if (runtimeVersions.length !== 1) throw new Error("Retained Devin runtime identity devin-cli differs from the pinned adapter manifest.");
    const native = qualifyRetainedDevinCapture(capture as NormalizationInput<ProtocolObservation>, {
      sessionId: manifest.run.native?.sessionId,
      expectsCompletion,
      harnessVersion: manifest.run.harness.version,
      runtimeVersions: [telemetryVersion, ...runtimeVersions],
    });
    dataset = (await describeAndValidateDevinDataset(native, manifest.run.harness.version)).dataset;
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
      capabilityProfile: openHandsCapabilityProfile(manifest.run.harness.version), adapterVersion: manifest.run.harness.version,
      nativeType: (record) => typeof record.payload.kind === "string" ? record.payload.kind : record.channel });
  } else {
    const native = qualifyRetainedDeepSeekCapture(capture as NormalizationInput<DeepSeekNativeObservation>,
      manifest.run.native?.sessionId, expectsCompletion);
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({ capture: native, normalization: normalizeDeepSeekCapture(native),
      capabilityProfile: createDeepSeekHarnessAdapter().normalization.capabilityProfile, adapterVersion: manifest.run.harness.version,
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
  if (harness === DEVIN_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== DEVIN_HARNESS && value.source !== "ebo-devin-client") fail();
    if (value.source === "ebo-devin-client" && (!["request", "response", "notification"].includes(value.kind)
      || value.kind === "notification" && value.method !== "session/cancel")) fail();
    return;
  }
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
