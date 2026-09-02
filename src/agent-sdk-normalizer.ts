import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk";

import {
  assertNoDuplicateJsonKeys,
  readVerifiedArtifact,
  validateArtifact,
} from "./artifacts.js";
import type { AssessmentMode, Digest } from "./contracts.js";
import type { TerminalRecord } from "./lifecycle.js";
import {
  qualifyRunBundle,
  type RunBundleEvidenceDescriptor,
  type RunManifest,
} from "./run-bundles.js";
import { readBoundedFile } from "./scheduler.js";
import {
  assertAdapterContract,
  type AdapterCapabilityProfile,
  type CapturedNativeRecord,
  type ContentReference,
  type HarnessAdapter,
  type NativeEvidenceReference,
  type NativeEvidenceResolver,
  type NormalizationInput,
  type NormalizationResult,
  type UniformAttributeValue,
  type UniformEvent,
  type UniformEventFamily,
  type UniformEventNormalizationAdapter,
} from "./uniform-events.js";

export const CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_ID = "claude-agent-sdk/v1";
export const CLAUDE_AGENT_SDK_HARNESS = "claude-agent-sdk";

type JsonRecord = Record<string, unknown>;
type AgentSdkNativeKind =
  | "session"
  | "hook"
  | "telemetry"
  | "workspace"
  | "verifier"
  | "diagnostic"
  | "capture-report"
  | "manifest";

export type AgentSdkNativeRecord = {
  kind: AgentSdkNativeKind;
  document: unknown;
};

export type AgentSdkNormalizationResult = NormalizationResult & {
  capabilityProfile: AdapterCapabilityProfile;
};

type DraftEvent = {
  event: UniformEvent;
  anchors: Array<{ key: string; rank: number }>;
  relationKeys: string[];
  parentKey?: string;
};

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const HOOK_EVENT_SET = new Set<string>(HOOK_EVENTS);
const SESSION_NATIVE_TYPES = [
  "assistant",
  "auth_status",
  "conversation_reset",
  "prompt_suggestion",
  "rate_limit_event",
  "result",
  "stream_event",
  "system",
  "tool_progress",
  "tool_use_summary",
  "user",
] as const;
const ADAPTER_NATIVE_TYPES = [
  ...SESSION_NATIVE_TYPES,
  ...HOOK_EVENTS,
  "agent-sdk-telemetry",
  "workspace-outcome",
  "verifier-result",
  "terminal-record",
] as const;

const BASE_CAPABILITY_PROFILE: AdapterCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_ID,
  harness: CLAUDE_AGENT_SDK_HARNESS,
  nativeTypes: ADAPTER_NATIVE_TYPES,
  families: {
    message: { status: "available" },
    "model-request": { status: "available" },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "available" },
    delegation: { status: "available" },
    artifact: { status: "available" },
    validation: { status: "available" },
    runtime: { status: "available" },
    outcome: { status: "available" },
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "Session and hook streams retain independent source-local sequences." },
    nativeTime: { status: "partial", detail: "Origin timestamps are used when emitted; capture clocks are not substituted." },
    parentage: { status: "partial", detail: "Relations require stable tool-use, task, agent, or workspace identifiers." },
    content: { status: "partial", detail: "Raw content remains in native evidence and is represented only by references." },
  },
};

export const claudeAgentSdkNormalizationAdapter: Omit<UniformEventNormalizationAdapter<AgentSdkNativeRecord>, "normalize"> & {
  normalize(input: NormalizationInput<AgentSdkNativeRecord>): Promise<AgentSdkNormalizationResult>;
} = {
  id: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_ID,
  harness: CLAUDE_AGENT_SDK_HARNESS,
  capabilityProfile: BASE_CAPABILITY_PROFILE,
  async normalize(input) {
    assertQualifiedInput(input);
    const drafts: DraftEvent[] = [];
    const unmapped: AgentSdkNormalizationResult["unmapped"][number][] = [];
    for (const captured of input.records) {
      const mapped = mapRecord(input, captured);
      drafts.push(...mapped);
      if (mapped.length === 0) {
        unmapped.push({
          reference: captured.reference,
          reason: unmappedReason(captured.record),
        });
      }
    }

    const capabilityProfile = capabilityProfileFor(input.records);
    assertValidCapabilityProfile(capabilityProfile);
    return {
      events: resolveRelations(drafts),
      unmapped,
      capabilityProfile,
    };
  },
};

/** Read, structurally qualify, normalize, and reference-check one retained Agent SDK run bundle. */
export async function normalizeClaudeAgentSdkRunBundle(bundleRoot: string): Promise<AgentSdkNormalizationResult> {
  const input = await readQualifiedClaudeAgentSdkCapture(bundleRoot);
  const resolver = createAgentSdkNativeEvidenceResolver(input);
  const adapter: HarnessAdapter<null, AgentSdkNativeRecord> = {
    capture: {
      id: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_ID,
      harness: CLAUDE_AGENT_SDK_HARNESS,
      capture: async () => input,
    },
    normalization: claudeAgentSdkNormalizationAdapter,
  };
  return await assertAdapterContract(adapter, null, resolver) as AgentSdkNormalizationResult;
}

export async function readQualifiedClaudeAgentSdkCapture(
  bundleRoot: string,
): Promise<NormalizationInput<AgentSdkNativeRecord>> {
  const root = resolve(bundleRoot);
  const manifest = readManifest(root);
  await assertPersistedStructuralQualification(root, manifest);
  const qualification = await qualifyRunBundle(root);
  if (!qualification.semanticAnalysisUsable
      || !["qualified", "qualified-with-gaps"].includes(qualification.status)) {
    const reasons = qualification.reasons.map(({ code }) => code).join(", ") || "unknown qualification failure";
    throw new Error(`Agent SDK normalization requires capture-qualified evidence: ${reasons}.`);
  }

  if (manifest.run.harness.id !== "agent-sdk"
      || !manifest.run.runtime.some(({ source, name }) => source === "anthropic" && name === "agent-sdk")) {
    throw new Error("Run bundle is not an Agent SDK capture.");
  }

  const records: Array<CapturedNativeRecord<AgentSdkNativeRecord>> = [];
  for (const descriptor of manifest.evidence) {
    if (descriptor.sanitizedFrom !== undefined || descriptor.kind === "export-manifest") continue;
    if (descriptor.kind === "workspace" || descriptor.kind === "diagnostic") {
      records.push({
        reference: { artifactId: descriptor.id, recordLocator: "#" },
        record: { kind: descriptor.kind, document: { descriptor: structuredClone(descriptor) } },
      });
      continue;
    }
    const bytes = await readVerifiedArtifact(root, descriptor.relativePath, digestFrom(descriptor.digest), MAX_EVIDENCE_BYTES);
    if (descriptor.kind === "session" || descriptor.kind === "hook") {
      for (const { line, document } of parseJsonl(bytes)) {
        records.push({
          reference: { artifactId: descriptor.id, recordLocator: `line:${line}` },
          record: { kind: descriptor.kind, document },
        });
      }
    } else if (["telemetry", "verifier", "capture-report"].includes(descriptor.kind)) {
      records.push({
        reference: { artifactId: descriptor.id, recordLocator: "#" },
        record: { kind: descriptor.kind as "telemetry" | "verifier" | "capture-report", document: parseJson(bytes) },
      });
    }
  }
  records.push({
    reference: { artifactId: "manifest", recordLocator: "#/terminal" },
    record: {
      kind: "manifest",
      document: {
        assessmentMode: manifest.run.assessmentMode,
        terminal: structuredClone(manifest.terminal),
      },
    },
  });

  const input: NormalizationInput<AgentSdkNativeRecord> = {
    runId: manifest.run.id,
    attemptId: manifest.attempt.id,
    qualification: qualification.status === "qualified" ? "qualified" : "qualified-with-gaps",
    records,
  };
  assertQualifiedInput(input);
  return input;
}

export function createAgentSdkNativeEvidenceResolver(
  input: NormalizationInput<AgentSdkNativeRecord>,
): NativeEvidenceResolver {
  const records = new Map(input.records.map((captured) => [referenceKey(captured.reference), captured]));
  return {
    resolve(reference) {
      if (records.has(referenceKey(reference))) return true;
      const derived = splitDerivedLocator(reference.recordLocator);
      if (derived === undefined) return false;
      const captured = records.get(referenceKey({ artifactId: reference.artifactId, recordLocator: derived.base }));
      return captured !== undefined && resolvesJsonPointer(captured.record.document, derived.pointer);
    },
  };
}

function mapRecord(
  input: NormalizationInput<AgentSdkNativeRecord>,
  captured: CapturedNativeRecord<AgentSdkNativeRecord>,
): DraftEvent[] {
  switch (captured.record.kind) {
    case "session": return mapSessionRecord(input, captured);
    case "hook": return mapHookRecord(input, captured);
    case "telemetry": return mapTelemetryRecord(input, captured);
    case "workspace": return mapWorkspaceRecord(input, captured);
    case "verifier": return mapVerifierRecord(input, captured);
    case "manifest": return mapManifestRecord(input, captured);
    case "diagnostic":
    case "capture-report": return [];
  }
}

function mapSessionRecord(
  input: NormalizationInput<AgentSdkNativeRecord>,
  captured: CapturedNativeRecord<AgentSdkNativeRecord>,
): DraftEvent[] {
  const wrapper = asRecord(captured.record.document);
  const nativeType = text(wrapper?.nativeType);
  const message = asRecord(wrapper?.message);
  if (wrapper === undefined || message === undefined || nativeType === undefined) return [];
  const drafts: DraftEvent[] = [];
  const subtype = text(wrapper.nativeSubtype) ?? text(message.subtype);
  const sessionId = text(wrapper.sessionId) ?? text(message.session_id);
  const nativeOrder = sourceOrder(wrapper, orderDomain("session", captured.reference.artifactId));
  const nativeTime = originTime(message.timestamp, "Agent SDK message has no originating timestamp");
  const common = { input, captured, nativeType, nativeOrder, nativeTime, sessionId };

  const base = sessionEventShape(nativeType, subtype, message);
  if (base !== undefined) {
    const stableToolId = text(message.tool_use_id);
    const stableTaskId = text(message.task_id);
    drafts.push(draftEvent({
      ...common,
      discriminator: "record",
      family: base.family,
      phase: base.phase,
      actor: base.actor,
      scope: base.scope ?? (sessionId === undefined ? { kind: "attempt", id: input.attemptId } : { kind: "session", id: sessionId }),
      attributes: sessionAttributes(nativeType, subtype, message),
      content: sessionContent(captured.reference, nativeType, subtype, message),
      relationKeys: [
        ...(stableToolId === undefined ? [] : [`tool:${stableToolId}`]),
        ...(stableTaskId === undefined ? [] : [`task:${stableTaskId}`]),
      ],
      anchors: nativeType === "system" && subtype === "task_started" && stableTaskId !== undefined
        ? [{ key: `task:${stableTaskId}`, rank: 1 }]
        : [],
      parentKey: parentToolKey(message),
    }));
  }
  if (nativeType === "assistant" || nativeType === "user") {
    drafts.push(...mapToolBlocks(common, message));
  }
  return drafts;
}

function sessionEventShape(
  nativeType: string,
  subtype: string | undefined,
  message: JsonRecord,
): Pick<UniformEvent, "family" | "phase" | "actor"> & { scope?: UniformEvent["scope"] } | undefined {
  switch (nativeType) {
    case "assistant": return { family: "message", phase: "instant", actor: { kind: "model" } };
    case "user": return { family: "message", phase: "instant", actor: { kind: message.isSynthetic === true ? "harness" : "user" } };
    case "result": return { family: "outcome", phase: "after", actor: { kind: "harness" } };
    case "stream_event": return { family: "message", phase: "during", actor: { kind: "model" } };
    case "tool_progress": return { family: "tool", phase: "during", actor: { kind: "tool", ...(text(message.tool_name) === undefined ? {} : { id: text(message.tool_name) }) } };
    case "tool_use_summary": return { family: "tool", phase: "after", actor: { kind: "harness" } };
    case "auth_status":
    case "rate_limit_event": return { family: "runtime", phase: "instant", actor: { kind: "harness" } };
    case "conversation_reset": return { family: "context", phase: "after", actor: { kind: "harness" } };
    case "prompt_suggestion": return { family: "message", phase: "after", actor: { kind: "harness" } };
    case "system": return systemEventShape(subtype);
    default: return undefined;
  }
}

function systemEventShape(
  subtype: string | undefined,
): Pick<UniformEvent, "family" | "phase" | "actor"> | undefined {
  if (subtype === "compact_boundary") return { family: "context", phase: "after", actor: { kind: "harness" } };
  if (["task_started", "task_progress", "task_updated", "task_notification", "worker_shutting_down"].includes(subtype ?? "")) {
    return { family: "delegation", phase: subtype === "task_started" ? "before" : "during", actor: { kind: "agent" } };
  }
  if (subtype === "files_persisted") return { family: "artifact", phase: "after", actor: { kind: "harness" } };
  if (subtype === "permission_denied") return { family: "permission", phase: "after", actor: { kind: "harness" } };
  if ([
    "init", "status", "hook_started", "hook_progress", "hook_response", "background_tasks_changed",
    "thinking_tokens", "session_state_changed", "commands_changed", "notification", "informational",
    "local_command_output", "memory_recall", "elicitation_complete",
  ].includes(subtype ?? "")) return { family: "runtime", phase: "instant", actor: { kind: "harness" } };
  return undefined;
}

function mapToolBlocks(
  common: {
    input: NormalizationInput<AgentSdkNativeRecord>;
    captured: CapturedNativeRecord<AgentSdkNativeRecord>;
    nativeType: string;
    nativeOrder: UniformEvent["nativeOrder"];
    nativeTime: UniformEvent["nativeTime"];
    sessionId?: string;
  },
  message: JsonRecord,
): DraftEvent[] {
  const payload = asRecord(message.message);
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content.flatMap((value, index) => {
    const block = asRecord(value);
    if (block?.type === "tool_use") {
      const toolUseId = text(block.id);
      const toolName = text(block.name);
      if (toolUseId === undefined || toolName === undefined) return [];
      return [draftEvent({
        ...common,
        discriminator: `tool-use:${index}`,
        family: "tool",
        phase: "before",
        actor: { kind: "model" },
        scope: { kind: "operation", id: toolUseId },
        attributes: { toolName, toolUseId },
        content: knownContent(contentReference(common.captured.reference, `/message/message/content/${index}`, "tool-input")),
        anchors: [{ key: `tool:${toolUseId}`, rank: 0 }],
      })];
    }
    if (block?.type === "tool_result") {
      const toolUseId = text(block.tool_use_id);
      if (toolUseId === undefined) return [];
      return [draftEvent({
        ...common,
        discriminator: `tool-result:${index}`,
        family: "tool",
        phase: "after",
        actor: { kind: "tool" },
        scope: { kind: "operation", id: toolUseId },
        attributes: { toolUseId, ...(typeof block.is_error === "boolean" ? { isError: block.is_error } : {}) },
        content: knownContent(contentReference(common.captured.reference, `/message/message/content/${index}`, "tool-result")),
        relationKeys: [`tool:${toolUseId}`],
      })];
    }
    return [];
  });
}

function mapHookRecord(
  input: NormalizationInput<AgentSdkNativeRecord>,
  captured: CapturedNativeRecord<AgentSdkNativeRecord>,
): DraftEvent[] {
  const wrapper = asRecord(captured.record.document);
  const hook = text(wrapper?.hook);
  const payload = asRecord(wrapper?.nativePayload);
  if (wrapper === undefined || payload === undefined || hook === undefined || !HOOK_EVENT_SET.has(hook)) return [];
  const shape = hookEventShape(hook);
  if (shape === undefined) return [];
  const toolUseId = text(wrapper.toolUseId) ?? text(payload.tool_use_id);
  const agentId = text(wrapper.agentId) ?? text(payload.agent_id);
  const taskId = text(payload.task_id);
  const stable = toolUseId === undefined ? taskId === undefined ? agentId === undefined ? undefined : `agent:${agentId}` : `task:${taskId}` : `tool:${toolUseId}`;
  const anchorRank = hook === "PreToolUse" ? 1
    : hook === "SubagentStart" || hook === "TaskCreated" ? 0
      : undefined;
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: hook,
    nativeOrder: sourceOrder(wrapper, orderDomain("hooks", captured.reference.artifactId)),
    nativeTime: { status: "unknown", reason: "Hook callback record has no native occurrence timestamp" },
    family: shape.family,
    phase: shape.phase,
    actor: hookActor(shape.family, hook, payload),
    scope: hookScope(shape.family, input.attemptId, wrapper, payload, toolUseId, agentId, taskId),
    attributes: hookAttributes(hook, payload, toolUseId, agentId, taskId),
    content: hookContent(captured.reference, hook, payload),
    anchors: stable === undefined || anchorRank === undefined ? [] : [{ key: stable, rank: anchorRank }],
    relationKeys: stable === undefined ? [] : [stable],
  })];
}

function hookEventShape(hook: string): { family: UniformEventFamily; phase: UniformEvent["phase"] } | undefined {
  if (["PreToolUse"].includes(hook)) return { family: "tool", phase: "before" };
  if (["PostToolUse", "PostToolUseFailure", "PostToolBatch"].includes(hook)) return { family: "tool", phase: "after" };
  if (["UserPromptSubmit", "UserPromptExpansion"].includes(hook)) return { family: "message", phase: "before" };
  if (hook === "MessageDisplay") return { family: "message", phase: "after" };
  if (hook === "PreCompact") return { family: "context", phase: "before" };
  if (["PostCompact", "InstructionsLoaded"].includes(hook)) return { family: "context", phase: "after" };
  if (hook === "PreModelSwitch") return { family: "model-request", phase: "before" };
  if (hook === "PostModelSwitch") return { family: "model-request", phase: "after" };
  if (["PermissionRequest", "Elicitation"].includes(hook)) return { family: "permission", phase: "before" };
  if (["PermissionDenied", "ElicitationResult"].includes(hook)) return { family: "permission", phase: "after" };
  if (["SubagentStart", "TaskCreated"].includes(hook)) return { family: "delegation", phase: "before" };
  if (["SubagentStop", "TaskCompleted"].includes(hook)) return { family: "delegation", phase: "after" };
  if (hook === "TeammateIdle") return { family: "delegation", phase: "instant" };
  if (["WorktreeCreate"].includes(hook)) return { family: "artifact", phase: "before" };
  if (["WorktreeRemove"].includes(hook)) return { family: "artifact", phase: "after" };
  if (["FileChanged", "DirectoryAdded"].includes(hook)) return { family: "artifact", phase: "instant" };
  if (["SessionStart", "Setup"].includes(hook)) return { family: "runtime", phase: "before" };
  if (["SessionEnd", "Stop", "StopFailure"].includes(hook)) return { family: "runtime", phase: "after" };
  if (["Notification", "ConfigChange", "CwdChanged"].includes(hook)) return { family: "runtime", phase: "instant" };
  return undefined;
}

function mapTelemetryRecord(
  input: NormalizationInput<AgentSdkNativeRecord>,
  captured: CapturedNativeRecord<AgentSdkNativeRecord>,
): DraftEvent[] {
  const document = asRecord(captured.record.document);
  if (document?.schemaVersion !== "ebo.agent-sdk-telemetry/v1") return [];
  const telemetry = asRecord(document.telemetry);
  const receipt = asRecord(telemetry?.receipt);
  const usage = asRecord(document.usage);
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "agent-sdk-telemetry",
    nativeOrder: { status: "unknown", reason: "Telemetry artifact has no cross-signal native order" },
    nativeTime: { status: "unknown", reason: "Telemetry summary has no native occurrence timestamp" },
    family: "runtime",
    phase: "during",
    actor: { kind: "system", id: "otlp" },
    scope: { kind: "attempt", id: input.attemptId },
    attributes: compactAttributes({
      receiptStatus: scalar(receipt?.status),
      receivedSignals: scalarList(receipt?.signals),
      totalCostUsd: scalar(usage?.totalCostUsd),
      numTurns: scalar(usage?.numTurns),
    }),
    content: { status: "unknown", reason: "Telemetry payload remains in native evidence" },
  })];
}

function mapWorkspaceRecord(
  input: NormalizationInput<AgentSdkNativeRecord>,
  captured: CapturedNativeRecord<AgentSdkNativeRecord>,
): DraftEvent[] {
  const descriptor = asRecord(asRecord(captured.record.document)?.descriptor) as RunBundleEvidenceDescriptor | undefined;
  if (descriptor?.kind !== "workspace") return [];
  const mediaType = text(descriptor.mediaType);
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "workspace-outcome",
    nativeOrder: { status: "unknown", reason: "Workspace artifact has no native event order" },
    nativeTime: { status: "unknown", reason: "Workspace artifact has no native occurrence timestamp" },
    family: "artifact",
    phase: "after",
    actor: { kind: "system", id: "ebo-workspace" },
    scope: { kind: "workspace", id: descriptor.id },
    attributes: compactAttributes({ mediaType: descriptor.mediaType, fingerprint: descriptor.fingerprint }),
    content: knownContent({
      nativeReference: captured.reference,
      ...(mediaType === undefined ? {} : { mediaType }),
      role: "workspace-outcome",
    }),
    anchors: [{ key: `artifact:${descriptor.id}`, rank: 0 }],
  })];
}

function mapVerifierRecord(
  input: NormalizationInput<AgentSdkNativeRecord>,
  captured: CapturedNativeRecord<AgentSdkNativeRecord>,
): DraftEvent[] {
  const document = asRecord(captured.record.document);
  if (document?.schemaVersion !== "verifier-result/v1") return [];
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "verifier-result",
    nativeOrder: { status: "unknown", reason: "Verifier artifact has no native event order" },
    nativeTime: { status: "unknown", reason: "Verifier result has no native occurrence timestamp" },
    family: "validation",
    phase: "after",
    actor: { kind: "system", id: "ebo-verifier" },
    scope: { kind: "attempt", id: input.attemptId },
    attributes: compactAttributes({
      status: scalar(document.status),
      exitCode: scalar(document.exitCode),
      assertionCount: Array.isArray(document.assertions) ? document.assertions.length : undefined,
    }),
    content: Array.isArray(document.assertions)
      ? knownContent(contentReference(captured.reference, "/assertions", "assertions"))
      : { status: "unknown", reason: "Verifier assertions were not retained" },
  })];
}

function mapManifestRecord(
  input: NormalizationInput<AgentSdkNativeRecord>,
  captured: CapturedNativeRecord<AgentSdkNativeRecord>,
): DraftEvent[] {
  const document = asRecord(captured.record.document);
  const terminal = asRecord(document?.terminal) as TerminalRecord | undefined;
  if (terminal === undefined || typeof terminal.state !== "string") return [];
  const workspaceId = text(terminal.workspaceArtifactId);
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "terminal-record",
    nativeOrder: { status: "unknown", reason: "Run manifest has no native event order" },
    nativeTime: { status: "unknown", reason: "Terminal record has no native occurrence timestamp" },
    family: "outcome",
    phase: "after",
    actor: { kind: "system", id: "ebo" },
    scope: { kind: "attempt", id: input.attemptId },
    attributes: compactAttributes({
      state: scalar(terminal.state),
      failureClass: scalar(terminal.failureClass),
      stopReason: scalar(terminal.stopReason),
      assessmentMode: scalar(document!.assessmentMode),
    }),
    content: workspaceId === undefined
      ? { status: "unknown", reason: "Terminal record does not identify a workspace artifact" }
      : knownContent({ nativeReference: { artifactId: workspaceId, recordLocator: "#" }, role: "final-workspace" }),
    relationKeys: workspaceId === undefined ? [] : [`artifact:${workspaceId}`],
  })];
}

function draftEvent(input: {
  input: NormalizationInput<AgentSdkNativeRecord>;
  captured: CapturedNativeRecord<AgentSdkNativeRecord>;
  discriminator: string;
  nativeType: string;
  nativeOrder: UniformEvent["nativeOrder"];
  nativeTime: UniformEvent["nativeTime"];
  family: UniformEventFamily;
  phase: UniformEvent["phase"];
  actor: UniformEvent["actor"];
  scope: UniformEvent["scope"];
  attributes: Readonly<Record<string, UniformAttributeValue>>;
  content: UniformEvent["content"];
  anchors?: Array<{ key: string; rank: number }>;
  relationKeys?: string[];
  parentKey?: string;
}): DraftEvent {
  return {
    event: {
      schemaVersion: "ebo.uniform-event/v1",
      id: stableEventId(input.input, input.captured.reference, input.discriminator),
      runId: input.input.runId,
      attemptId: input.input.attemptId,
      source: {
        harness: CLAUDE_AGENT_SDK_HARNESS,
        nativeType: input.nativeType,
        nativeReference: input.captured.reference,
      },
      nativeOrder: input.nativeOrder,
      nativeTime: input.nativeTime,
      actor: input.actor,
      family: input.family,
      phase: input.phase,
      scope: input.scope,
      relations: { parent: { status: "unknown", reason: "Native record does not establish an emitted parent" }, known: [] },
      attributes: input.attributes,
      content: input.content,
    },
    anchors: input.anchors ?? [],
    relationKeys: input.relationKeys ?? [],
    ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
  };
}

function resolveRelations(drafts: readonly DraftEvent[]): UniformEvent[] {
  const candidates = new Map<string, Array<{ id: string; rank: number }>>();
  for (const draft of drafts) {
    for (const anchor of draft.anchors) {
      const entries = candidates.get(anchor.key) ?? [];
      entries.push({ id: draft.event.id, rank: anchor.rank });
      candidates.set(anchor.key, entries);
    }
  }
  const anchors = new Map<string, string>();
  for (const [key, entries] of candidates) {
    const minimum = Math.min(...entries.map(({ rank }) => rank));
    const preferred = entries.filter(({ rank }) => rank === minimum);
    if (preferred.length === 1) anchors.set(key, preferred[0]!.id);
  }
  return drafts.map((draft) => {
    const known = [...new Set(draft.relationKeys.map((key) => anchors.get(key)))]
      .filter((id): id is string => id !== undefined && id !== draft.event.id)
      .map((eventId) => ({ kind: "correlates-with" as const, eventId }));
    const parent = draft.parentKey === undefined ? draft.event.relations.parent
      : anchors.has(draft.parentKey)
        ? { status: "known" as const, value: anchors.get(draft.parentKey)! }
        : { status: "unknown" as const, reason: "Stable parent tool ID has no uniquely mapped tool-call event" };
    return { ...draft.event, relations: { parent, known } };
  });
}

function capabilityProfileFor(
  records: readonly CapturedNativeRecord<AgentSdkNativeRecord>[],
): AdapterCapabilityProfile {
  const detailedBetaConfigured = records.some(({ record }) => {
    if (record.kind !== "telemetry") return false;
    const telemetry = asRecord(asRecord(record.document)?.telemetry);
    return asRecord(telemetry?.hookSpans)?.status === "enabled";
  });
  return {
    ...structuredClone(BASE_CAPABILITY_PROFILE),
    evidence: {
      ...structuredClone(BASE_CAPABILITY_PROFILE.evidence),
      nativeTime: {
        status: "partial",
        detail: detailedBetaConfigured
          ? "Origin timestamps are used when emitted; detailed-beta hook spans are configured but are not substituted for native semantic events."
          : "Origin timestamps are used when emitted; detailed-beta hook span timing is unavailable and semantic hook history is unchanged.",
      },
    },
  };
}

function assertQualifiedInput(input: NormalizationInput<AgentSdkNativeRecord>): void {
  if (!["qualified", "qualified-with-gaps"].includes(input.qualification)) {
    throw new Error("Agent SDK normalization requires capture-qualified evidence.");
  }
  if (text(input.runId) === undefined || text(input.attemptId) === undefined || !Array.isArray(input.records)) {
    throw new Error("Agent SDK normalization input identity is invalid.");
  }
  const kinds = new Set(input.records.map(({ record }) => record.kind));
  for (const required of ["session", "hook", "workspace", "manifest"] as const) {
    if (!kinds.has(required)) throw new Error(`Capture-qualified Agent SDK input is missing required ${required} evidence.`);
  }
  const manifest = input.records.find(({ record }) => record.kind === "manifest");
  const assessmentMode = asRecord(manifest?.record.document)?.assessmentMode as AssessmentMode | undefined;
  if (assessmentMode === "verified" && !kinds.has("verifier")) {
    throw new Error("Capture-qualified verified input is missing required verifier evidence.");
  }
}

function assertValidCapabilityProfile(profile: AdapterCapabilityProfile): void {
  const errors = validateArtifact("Agent SDK adapter capability profile", profile);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
}

function readManifest(root: string): RunManifest {
  const bytes = readBoundedFile(resolve(root, "manifest.json"), "Run manifest", undefined, MAX_MANIFEST_BYTES);
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(textValue);
  const document: unknown = JSON.parse(textValue);
  const errors = validateArtifact("manifest.json", document);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  return document as RunManifest;
}

async function assertPersistedStructuralQualification(root: string, manifest: RunManifest): Promise<void> {
  const descriptor = manifest.evidence.find(({ kind, sanitizedFrom }) => kind === "capture-report" && sanitizedFrom === undefined);
  if (descriptor === undefined) return;
  const report = asRecord(parseJson(await readVerifiedArtifact(
    root,
    descriptor.relativePath,
    digestFrom(descriptor.digest),
    MAX_EVIDENCE_BYTES,
  )));
  const structural = asRecord(report?.structuralQualification);
  if (structural?.status === "unqualified" || structural?.semanticAnalysisUsable === false) {
    throw new Error("Agent SDK normalization rejects the persisted unqualified structural capture report.");
  }
}

function parseJsonl(bytes: Buffer): Array<{ line: number; document: unknown }> {
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return textValue.split(/\r?\n/u).map((value, index) => ({ value, line: index + 1 }))
    .filter(({ value }) => value.trim() !== "")
    .map(({ value, line }) => {
      assertNoDuplicateJsonKeys(value);
      return { line, document: JSON.parse(value) as unknown };
    });
}

function parseJson(bytes: Buffer): unknown {
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(textValue);
  return JSON.parse(textValue) as unknown;
}

function digestFrom(value: string): Digest {
  return { algorithm: "sha256", value: value.replace(/^sha256:/u, "") };
}

function sourceOrder(document: JsonRecord, domain: string): UniformEvent["nativeOrder"] {
  const sequence = document.sequence;
  return Number.isSafeInteger(sequence) && Number(sequence) >= 0
    ? { status: "known", value: Number(sequence), domain }
    : { status: "unknown", reason: `${domain} record has no valid source-local sequence` };
}

function orderDomain(kind: "session" | "hooks", artifactId: string): string {
  const readable = `${kind}:${artifactId}`;
  return [...readable].length <= 256
    ? readable
    : `${kind}:sha256:${createHash("sha256").update(artifactId).digest("hex")}`;
}

function originTime(value: unknown, reason: string): UniformEvent["nativeTime"] {
  if (typeof value === "string" && isRfc3339DateTime(value)) return { status: "known", value };
  return { status: "unknown", reason };
}

function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/iu.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= monthDays[month - 1]!
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
}

function sessionAttributes(nativeType: string, subtype: string | undefined, message: JsonRecord): Record<string, UniformAttributeValue> {
  const rateLimit = asRecord(message.rate_limit_info);
  return compactAttributes({
    subtype,
    messageId: scalar(message.uuid),
    model: scalar(asRecord(message.message)?.model),
    isSynthetic: scalar(message.isSynthetic),
    isError: scalar(message.is_error),
    stopReason: scalar(message.stop_reason),
    numTurns: scalar(message.num_turns),
    totalCostUsd: scalar(message.total_cost_usd),
    toolName: scalar(message.tool_name),
    elapsedSeconds: scalar(message.elapsed_time_seconds),
    rateLimitStatus: nativeType === "rate_limit_event" ? scalar(rateLimit?.status) : undefined,
    rateLimitType: nativeType === "rate_limit_event" ? scalar(rateLimit?.rateLimitType) : undefined,
    utilization: nativeType === "rate_limit_event" ? scalar(rateLimit?.utilization) : undefined,
  });
}

function sessionContent(
  reference: NativeEvidenceReference,
  nativeType: string,
  subtype: string | undefined,
  message: JsonRecord,
): UniformEvent["content"] {
  const inner = asRecord(message.message);
  if ((nativeType === "assistant" || nativeType === "user") && inner?.content !== undefined) {
    return knownContent(contentReference(reference, "/message/message/content", `${nativeType}-message`));
  }
  if (nativeType === "result" && (message.result !== undefined || message.errors !== undefined)) {
    return knownContent(contentReference(reference, message.result !== undefined ? "/message/result" : "/message/errors", "result"));
  }
  if (nativeType === "prompt_suggestion" && message.suggestion !== undefined) {
    return knownContent(contentReference(reference, "/message/suggestion", "suggestion"));
  }
  if (nativeType === "system" && ["local_command_output", "informational"].includes(subtype ?? "") && message.content !== undefined) {
    return knownContent(contentReference(reference, "/message/content", "system-message"));
  }
  return { status: "unknown", reason: "Native message content remains in the source record" };
}

function hookActor(family: UniformEventFamily, hook: string, payload: JsonRecord): UniformEvent["actor"] {
  if (family === "tool") return { kind: "tool", ...(text(payload.tool_name) === undefined ? {} : { id: text(payload.tool_name) }) };
  if (family === "delegation") return { kind: "agent", ...(text(payload.agent_id) === undefined ? {} : { id: text(payload.agent_id) }) };
  if (hook === "UserPromptSubmit" || hook === "UserPromptExpansion") return { kind: "user" };
  if (hook === "MessageDisplay") return { kind: "model" };
  if (family === "artifact") return { kind: "agent" };
  return { kind: "harness" };
}

function hookScope(
  family: UniformEventFamily,
  attemptId: string,
  wrapper: JsonRecord,
  payload: JsonRecord,
  toolUseId: string | undefined,
  agentId: string | undefined,
  taskId: string | undefined,
): UniformEvent["scope"] {
  if ((family === "tool" || family === "permission") && toolUseId !== undefined) return { kind: "operation", id: toolUseId };
  if (family === "delegation" && (taskId ?? agentId) !== undefined) return { kind: "operation", id: taskId ?? agentId };
  if (family === "artifact") return { kind: "workspace" };
  const turnId = text(payload.turn_id);
  if (family === "message" && turnId !== undefined) return { kind: "turn", id: turnId };
  const sessionId = text(wrapper.sessionId) ?? text(payload.session_id);
  return sessionId === undefined ? { kind: "attempt", id: attemptId } : { kind: "session", id: sessionId };
}

function hookAttributes(
  hook: string,
  payload: JsonRecord,
  toolUseId: string | undefined,
  agentId: string | undefined,
  taskId: string | undefined,
): Record<string, UniformAttributeValue> {
  return compactAttributes({
    hook,
    toolUseId,
    toolName: scalar(payload.tool_name),
    agentId,
    agentType: scalar(payload.agent_type),
    taskId,
    trigger: scalar(payload.trigger),
    source: scalar(payload.source),
    fromModel: scalar(payload.from_model),
    toModel: scalar(payload.to_model),
    requestedModel: scalar(payload.requested_model),
    decision: hook === "PermissionDenied" ? "denied" : scalar(payload.action),
    event: scalar(payload.event),
    notificationType: scalar(payload.notification_type),
    mcpServerName: scalar(payload.mcp_server_name),
  });
}

function hookContent(
  reference: NativeEvidenceReference,
  hook: string,
  payload: JsonRecord,
): UniformEvent["content"] {
  const fields: Partial<Record<string, { field: string; role: string }>> = {
    UserPromptSubmit: { field: "prompt", role: "user-prompt" },
    UserPromptExpansion: { field: "prompt", role: "expanded-prompt" },
    MessageDisplay: { field: "delta", role: "display-message" },
    Notification: { field: "message", role: "notification" },
    PreCompact: { field: "custom_instructions", role: "compaction-instructions" },
    PostCompact: { field: "compact_summary", role: "compaction-summary" },
    Elicitation: { field: "message", role: "elicitation" },
    PreToolUse: { field: "tool_input", role: "tool-input" },
    PostToolUse: { field: "tool_response", role: "tool-result" },
    PostToolUseFailure: { field: "error", role: "tool-error" },
    PostToolBatch: { field: "tool_calls", role: "tool-batch" },
  };
  const selected = fields[hook];
  return selected !== undefined && payload[selected.field] !== undefined
    ? knownContent(contentReference(reference, `/nativePayload/${selected.field}`, selected.role))
    : { status: "unknown", reason: "Hook payload content remains in the source record" };
}

function parentToolKey(message: JsonRecord): string | undefined {
  const parent = text(message.parent_tool_use_id);
  return parent === undefined ? undefined : `tool:${parent}`;
}

function stableEventId(
  input: Pick<NormalizationInput<AgentSdkNativeRecord>, "runId" | "attemptId">,
  reference: NativeEvidenceReference,
  discriminator: string,
): string {
  const digest = createHash("sha256").update(JSON.stringify([
    input.runId,
    input.attemptId,
    reference.artifactId,
    reference.recordLocator,
    discriminator,
  ])).digest("hex");
  return `agent-sdk-${digest.slice(0, 32)}`;
}

function contentReference(
  reference: NativeEvidenceReference,
  pointer: string,
  role: string,
): ContentReference {
  return {
    nativeReference: {
      artifactId: reference.artifactId,
      recordLocator: reference.recordLocator === "#"
        ? `#${pointer}`
        : `${reference.recordLocator}#${pointer}`,
    },
    role,
  };
}

function knownContent(...content: ContentReference[]): UniformEvent["content"] {
  return { status: "known", value: content };
}

function compactAttributes(values: Record<string, UniformAttributeValue | undefined>): Record<string, UniformAttributeValue> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, UniformAttributeValue] =>
    entry[1] !== undefined && validAttributeValue(entry[1])));
}

function scalar(value: unknown): UniformAttributeValue | undefined {
  return validAttributeScalar(value) ? value : undefined;
}

function scalarList(value: unknown): UniformAttributeValue | undefined {
  return Array.isArray(value) && value.length <= 16 && value.every(validAttributeScalar)
    ? value as UniformAttributeValue
    : undefined;
}

function validAttributeValue(value: UniformAttributeValue): boolean {
  return Array.isArray(value) ? value.length <= 16 && value.every(validAttributeScalar) : validAttributeScalar(value);
}

function validAttributeScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)
    || typeof value === "string" && [...value].length <= 512;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && [...value].length <= 256 ? value : undefined;
}

function unmappedReason(record: AgentSdkNativeRecord): string {
  if (record.kind === "capture-report") return "Capture qualification metadata informs the capability report and is not a semantic event";
  if (record.kind === "diagnostic") return "Diagnostic sidecar remains native outcome evidence";
  if (record.kind === "session") return "Unrecognized Agent SDK message type remains in the native session artifact";
  if (record.kind === "hook") return "Unrecognized Agent SDK hook record remains in the native hook artifact";
  return `Unrecognized ${record.kind} record remains in native evidence`;
}

function referenceKey(reference: NativeEvidenceReference): string {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}

function splitDerivedLocator(locator: string): { base: string; pointer: string } | undefined {
  if (locator.startsWith("#/")) return { base: "#", pointer: locator.slice(1) };
  const marker = locator.indexOf("#/");
  return marker === -1 ? undefined : { base: locator.slice(0, marker), pointer: locator.slice(marker + 1) };
}

function resolvesJsonPointer(document: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  let current = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment) || Number(segment) >= current.length) return false;
      current = current.at(Number(segment));
    } else {
      const record = asRecord(current);
      const property = record === undefined ? undefined : Object.getOwnPropertyDescriptor(record, segment);
      if (property === undefined || !("value" in property)) return false;
      current = property.value;
    }
  }
  return true;
}
