import { join } from "node:path";
import { readQualifiedRunCapture, createAgentSdkNativeEvidenceResolver, type AgentSdkNativeRecord } from "./agent-sdk-normalizer.js";
import { createAgentSdkBehaviorEvidence } from "./behavior-assertions.js";
import { describeAndValidateCodexDataset, CODEX_HARNESS } from "./codex.js";
import { normalizeOpenHandsCapture, OPENHANDS_AGENT_SERVER_CAPABILITIES, OPENHANDS_AGENT_SERVER_VERSION, type OpenHandsNativeRecord } from "./openhands.js";
import { createDeepSeekHarnessAdapter, DEEPSEEK_HARNESS_ID, DEEPSEEK_SDK_VERSION, normalizeDeepSeekCapture, qualifyRetainedDeepSeekCapture, type DeepSeekNativeObservation } from "./deepseek-adapter.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset, validateNormalizedDataset, type AdapterCoverageReport, type NormalizedDataset } from "./normalization-integrity.js";
import { readBoundedFile } from "./scheduler.js";
import type { ProtocolObservation } from "./process-protocol.js";
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
  const capture = {
    ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind === "session")
      .map(({ reference, record }) => ({ reference, record: record.document })),
  };
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver({ ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind !== "session" && record.kind !== "hook"),
  }));
  let dataset: NormalizedDataset;
  if (harness === CODEX_HARNESS) {
    const native = capture as NormalizationInput<ProtocolObservation> & { threadId?: string; turnId?: string };
    const identities = (method: string, key: "thread" | "turn"): string | undefined => {
      const ids = new Set(native.records.flatMap(({ record }) => {
        const payload = record.payload as Record<string, any> | undefined;
        return record.kind === "response" && record.method === method && typeof payload?.[key]?.id === "string" ? [payload[key].id as string] : [];
      }));
      const optionalPartialTurn = key === "turn" && manifest.terminal.state !== "completed";
      if (ids.size > 1 || ids.size === 0 && !optionalPartialTurn) throw new Error(`Retained Codex ${method} requires one owned identity.`);
      return [...ids][0];
    };
    native.threadId = identities("thread/start", "thread");
    native.turnId = identities("turn/start", "turn");
    if (native.threadId !== manifest.run.native?.sessionId) throw new Error("Retained Codex thread identity differs from the run manifest.");
    const terminal = native.records.find(({ record }) => {
      const payload = record.payload as Record<string, any> | undefined;
      return record.kind === "notification" && record.source === CODEX_HARNESS && record.method === "turn/completed"
        && payload?.threadId === native.threadId && payload?.turn?.id === native.turnId;
    });
    if (manifest.terminal.state === "completed" && (terminal?.record.payload as Record<string, any> | undefined)?.turn?.status !== "completed") {
      throw new Error("Completed retained Codex capture lacks matching owned terminal evidence.");
    }
    dataset = (await describeAndValidateCodexDataset(native, manifest.run.harness.version)).dataset;
  } else if (harness === "openhands-agent-server") {
    const native = capture as NormalizationInput<OpenHandsNativeRecord>;
    dataset = describeNormalizedDataset({ capture: native, normalization: await normalizeOpenHandsCapture(native),
      capabilityProfile: OPENHANDS_AGENT_SERVER_CAPABILITIES, adapterVersion: OPENHANDS_AGENT_SERVER_VERSION,
      nativeType: (record) => typeof record.payload.kind === "string" ? record.payload.kind : record.channel });
  } else {
    const native = qualifyRetainedDeepSeekCapture(capture as NormalizationInput<DeepSeekNativeObservation>,
      manifest.run.native?.sessionId, manifest.terminal.state === "completed");
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({ capture: native, normalization: normalizeDeepSeekCapture(native),
      capabilityProfile: createDeepSeekHarnessAdapter().normalization.capabilityProfile, adapterVersion: DEEPSEEK_SDK_VERSION,
      nativeType: (record) => record.method ?? record.kind });
  }
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { capture, outcomeCapture, dataset, resolver, coverage };
}
