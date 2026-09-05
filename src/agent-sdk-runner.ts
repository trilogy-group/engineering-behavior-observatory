import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact, validateRunManifestEvidence } from "./artifacts.js";
import { captureClaudeAgentSdkRun } from "./agent-sdk-run.js";
import {
  probeClaudeAgentSdkCapabilities,
  type ClaudeAgentSdkConfiguration,
  type ClaudeAgentSdkQuery,
  type ClaudeAgentSdkTelemetryConfiguration,
} from "./agent-sdk.js";
import { isSafeArtifactRelativePath, resolveBundleConfiguration, type ArtifactReference } from "./contracts.js";
import type { AttemptClassificationKind, TerminalRecord } from "./lifecycle.js";
import type { CaptureQualificationStatus, RunBundleDefinition, RunManifest } from "./run-bundles.js";
import { readBoundedFile, readRunQueue, type RunQueueEntry } from "./scheduler.js";
import { assertTaskPacketAdmitted, formatErrors, type TaskPacket } from "./task-packets.js";
import { executeVerifier } from "./verifiers.js";
import { cleanupWorkspace, materializeWorkspace } from "./workspaces.js";

export const AGENT_SDK_CONFIG_SCHEMA_VERSION = "ebo.agent-sdk-config/v1";

export type AgentSdkModelConfiguration = {
  schemaVersion: typeof AGENT_SDK_CONFIG_SCHEMA_VERSION;
  kind: "model";
  model: string;
};

export type AgentSdkHarnessConfiguration = {
  schemaVersion: typeof AGENT_SDK_CONFIG_SCHEMA_VERSION;
  kind: "harness";
  adapter: "claude-agent-sdk";
};

export type AgentSdkNativeLimitsConfiguration = {
  schemaVersion: typeof AGENT_SDK_CONFIG_SCHEMA_VERSION;
  kind: "native-limits";
  maxTurns?: number;
  maxBudgetUsd?: number;
};

export type AgentSdkNativeToolPolicyConfiguration = {
  schemaVersion: typeof AGENT_SDK_CONFIG_SCHEMA_VERSION;
  kind: "native-tool-policy";
  tools: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
};

export type AgentSdkCaptureProfileConfiguration = {
  schemaVersion: typeof AGENT_SDK_CONFIG_SCHEMA_VERSION;
  kind: "capture-profile";
  telemetry?: {
    endpoint: string;
    protocol?: "http/protobuf" | "http/json" | "grpc";
    exportIntervalMs?: number;
    logUserPrompts?: boolean;
    logToolDetails?: boolean;
    logToolContent?: boolean;
    logRawApiBodies?: boolean;
  };
  workspaceOutcome?: {
    excludeDirectoryNames: string[];
    respectGitignore?: boolean;
    omitEmptyDirectories?: boolean;
  };
};

export type AgentSdkConfigurationRecord =
  | AgentSdkModelConfiguration
  | AgentSdkHarnessConfiguration
  | AgentSdkNativeLimitsConfiguration
  | AgentSdkNativeToolPolicyConfiguration
  | AgentSdkCaptureProfileConfiguration;

export type AgentSdkConfigurationKind = AgentSdkConfigurationRecord["kind"];

export type RunAgentSdkQueueEntryOptions = {
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot?: string;
  /** Deterministic attempt identity for tests or embedded callers; a fresh UUID otherwise. */
  attemptId?: string;
  /** Already-supported Agent SDK query seam for deterministic tests; never serialized configuration. */
  query?: ClaudeAgentSdkQuery;
  /** Already-supported collector receipt callback; never serialized configuration. */
  checkTelemetryReceipt?: ClaudeAgentSdkTelemetryConfiguration["checkReceipt"];
  signal?: AbortSignal;
};

export type AgentSdkRunSummary = {
  runId: string;
  attemptId: string;
  bundlePath: string;
  terminal: TerminalRecord;
  classification: AttemptClassificationKind;
  captureQualification: CaptureQualificationStatus;
  assessmentMode: TaskPacket["assessmentMode"];
  sessionId?: string;
  traceId?: string;
  /** Local recovery location when outcome capture failed; never a qualified artifact. */
  retainedWorkspacePath?: string;
};

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
const TELEMETRY_PROTOCOLS = ["http/protobuf", "http/json", "grpc"] as const;
// Matches the workspace attempt-ID contract: one safe path component, no
// separators, no leading dot, so a supplied ID cannot escape the output root.
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Execute exactly one frozen run-queue entry through the Claude Agent SDK and
 * retain its run bundle under `<outputRoot>/<runId>/<attemptId>`. Preflight
 * failures throw before any attempt evidence exists; once capture starts, the
 * existing lifecycle retains complete or partial evidence without retrying.
 */
export async function runAgentSdkQueueEntry(options: RunAgentSdkQueueEntryOptions): Promise<AgentSdkRunSummary> {
  const bundleRoot = resolve(options.bundleRoot);
  const queue = readRunQueue(options.queuePath, undefined, { bundleRoot });
  const matches = queue.entries.filter((candidate) => candidate.runId === options.runId);
  if (matches.length === 0) throw new Error(`Run "${options.runId}" is not in the queue.`);
  if (matches.length > 1) throw new Error(`Run "${options.runId}" matches more than one queue entry.`);
  const entry = matches[0]!;

  const model = resolveAgentSdkConfigurationRecord(bundleRoot, entry.configuration.model, "model");
  resolveAgentSdkConfigurationRecord(bundleRoot, entry.configuration.harness, "harness");
  const limits = resolveAgentSdkConfigurationRecord(bundleRoot, entry.configuration.nativeLimits, "native-limits");
  const toolPolicy = resolveAgentSdkConfigurationRecord(bundleRoot, entry.configuration.nativeToolPolicy, "native-tool-policy");
  const captureProfile = resolveAgentSdkConfigurationRecord(bundleRoot, queue.captureProfile, "capture-profile");
  if (model.model !== entry.model.id) {
    throw new Error(`Model configuration "${model.model}" does not match the queue entry model ID "${entry.model.id}".`);
  }

  const inspection = assertTaskPacketAdmitted(bundleRoot, entry.task.packetRef.locator);
  const packet = inspection.packet as TaskPacket;
  if (inspection.packetDigest === null || inspection.packetDigest.value !== entry.task.packetRef.digest.value
      || inspection.packetDigest.algorithm !== entry.task.packetRef.digest.algorithm) {
    throw new Error(`Task packet "${entry.task.packetRef.locator}" changed from its frozen queue reference.`);
  }
  const verifierReference = packet.assessmentMode === "verified" ? packet.restricted.verifier : undefined;
  const verifierFormat = verifierReference?.locator.toLowerCase().endsWith(".mjs") ? "module" : "commonjs";

  const attemptId = options.attemptId ?? randomUUID();
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new Error("Attempt ID must be one safe path component.");
  }
  const outputRoot = resolve(options.outputRoot);
  const attemptBundleRoot = join(outputRoot, entry.runId, attemptId);
  const fromOutputRoot = relative(outputRoot, attemptBundleRoot);
  if (fromOutputRoot === "" || isAbsolute(fromOutputRoot)
      || fromOutputRoot === ".." || fromOutputRoot.startsWith(`..${sep}`)) {
    throw new Error("Attempt destination escapes the selected output root.");
  }
  if (pathExists(attemptBundleRoot)) {
    throw new Error(`Attempt destination "${attemptBundleRoot}" already exists and is never replaced.`);
  }

  const capabilities = probeClaudeAgentSdkCapabilities();
  const configuration = buildSdkConfiguration(packet.agentInput.prompt, model, limits, toolPolicy, captureProfile, options.checkTelemetryReceipt);
  const definition = buildRunBundleDefinition(queue.captureProfile, entry, packet, attemptBundleRoot, attemptId, capabilities, verifierFormat);

  // The workspace directory name stays decoupled from the attempt identity:
  // the native SDK encodes its working-directory path into retained session
  // evidence, and an embedded attempt ID would leak a source correlation value
  // past path redaction during portable export.
  const workspace = await materializeWorkspace({
    bundleRoot,
    packetLocator: entry.task.packetRef.locator,
    freezeLocator: entry.task.freezeLocator,
    ...(options.workspaceRoot === undefined ? {} : { workspaceParent: options.workspaceRoot }),
  });
  if (workspace.status !== "ready") {
    throw new Error(`Workspace materialization failed before the attempt started: ${workspace.error ?? "unknown failure"}`);
  }

  let baselineRoot: string | undefined;
  let captureStarted = false;
  try {
    baselineRoot = await mkdtemp(join(tmpdir(), "ebo-agent-sdk-baseline-"));
    const startingWorkspacePath = join(baselineRoot, "workspace");
    await cp(workspace.path, startingWorkspacePath, { recursive: true, preserveTimestamps: true, force: false });

    const result = await captureClaudeAgentSdkRun({
      definition,
      startingWorkspacePath,
      workspace: {
        setup: () => {
          captureStarted = true;
          return { status: "ready", path: workspace.path, artifactId: "workspace", retained: true };
        },
        cleanup: async () => {
          await cleanupWorkspace(workspace);
        },
      },
      configuration,
      ...(captureProfile.workspaceOutcome === undefined ? {} : {
        workspaceOutcomeExcludedDirectoryNames: captureProfile.workspaceOutcome.excludeDirectoryNames,
        ...(captureProfile.workspaceOutcome.respectGitignore === undefined ? {} : {
          workspaceOutcomeRespectsGitignore: captureProfile.workspaceOutcome.respectGitignore,
        }),
        ...(captureProfile.workspaceOutcome.omitEmptyDirectories === undefined ? {} : {
          workspaceOutcomeOmitsEmptyDirectories: captureProfile.workspaceOutcome.omitEmptyDirectories,
        }),
      }),
      ...(verifierReference === undefined ? {} : {
        verifier: (context, outcome, projectedWorkspacePath) => executeVerifier({
          bundleId: definition.bundleId,
          verifierRoot: bundleRoot,
          verifier: verifierReference,
          workspacePath: projectedWorkspacePath,
          workspaceFingerprint: outcome.fingerprint,
          workspace: {
            artifactId: outcome.descriptor.id,
            digest: outcome.descriptor.digest,
            fingerprint: outcome.fingerprint,
          },
          artifactRoot: attemptBundleRoot,
          moduleFormat: verifierFormat,
          signal: context.signal,
        }),
      }),
      maxWallClockMs: queue.coordinatorBudget.maxWallClockMs,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const manifest = reopenFinalManifest(attemptBundleRoot);
    return {
      runId: entry.runId,
      attemptId,
      bundlePath: attemptBundleRoot,
      terminal: structuredClone(manifest.terminal),
      classification: result.attempt.classification.kind,
      captureQualification: result.qualification.status,
      assessmentMode: packet.assessmentMode,
      ...(manifest.run.native?.sessionId === undefined ? {} : { sessionId: manifest.run.native.sessionId }),
      ...(manifest.run.native?.traceId === undefined ? {} : { traceId: manifest.run.native.traceId }),
      ...(workspace.state === "ready" && !manifest.evidence.some(({ kind }) => kind === "workspace")
        ? { retainedWorkspacePath: workspace.path }
        : {}),
    };
  } finally {
    if (baselineRoot !== undefined) await rm(baselineRoot, { recursive: true, force: true });
    // Once execution starts, the capture layer cleans up only after retaining
    // an outcome. Preserve the original work if packaging or finalization fails.
    if (!captureStarted && workspace.state === "ready") await cleanupWorkspace(workspace).catch(() => undefined);
  }
}

type AgentSdkConfigurationByKind = {
  model: AgentSdkModelConfiguration;
  harness: AgentSdkHarnessConfiguration;
  "native-limits": AgentSdkNativeLimitsConfiguration;
  "native-tool-policy": AgentSdkNativeToolPolicyConfiguration;
  "capture-profile": AgentSdkCaptureProfileConfiguration;
};

/** Resolve one digest-pinned `ebo.agent-sdk-config/v1` record and validate it before SDK launch. */
export function resolveAgentSdkConfigurationRecord<Kind extends AgentSdkConfigurationKind>(
  bundleRoot: string,
  reference: ArtifactReference,
  kind: Kind,
): AgentSdkConfigurationByKind[Kind] {
  const bytes = resolveBundleConfiguration(bundleRoot, reference);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError(reference, "is not valid UTF-8");
  }
  assertNoDuplicateJsonKeys(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw configurationError(reference, `is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw configurationError(reference, "must be a JSON object");
  if (value.schemaVersion !== AGENT_SDK_CONFIG_SCHEMA_VERSION) {
    throw configurationError(reference, `must declare schemaVersion ${AGENT_SDK_CONFIG_SCHEMA_VERSION}`);
  }
  if (value.kind !== kind) {
    throw configurationError(reference, `has kind "${String(value.kind)}" instead of the required "${kind}"`);
  }
  validateConfigurationRecord(value, kind, reference);
  return value as AgentSdkConfigurationByKind[Kind];
}

function validateConfigurationRecord(record: Record<string, unknown>, kind: AgentSdkConfigurationKind, reference: ArtifactReference): void {
  switch (kind) {
    case "model":
      assertRecordKeys(record, ["model"], ["model"], reference);
      assertText(record.model, "model", reference);
      return;
    case "harness":
      assertRecordKeys(record, ["adapter"], ["adapter"], reference);
      if (record.adapter !== "claude-agent-sdk") {
        throw configurationError(reference, 'must declare the "claude-agent-sdk" adapter');
      }
      return;
    case "native-limits":
      assertRecordKeys(record, ["maxTurns", "maxBudgetUsd"], [], reference);
      if (record.maxTurns !== undefined && (!Number.isSafeInteger(record.maxTurns) || (record.maxTurns as number) < 1)) {
        throw configurationError(reference, "maxTurns must be a positive safe integer");
      }
      if (record.maxBudgetUsd !== undefined
          && (typeof record.maxBudgetUsd !== "number" || !Number.isFinite(record.maxBudgetUsd) || record.maxBudgetUsd <= 0)) {
        throw configurationError(reference, "maxBudgetUsd must be a positive finite number");
      }
      return;
    case "native-tool-policy": {
      assertRecordKeys(
        record,
        ["tools", "allowedTools", "disallowedTools", "permissionMode", "allowDangerouslySkipPermissions"],
        ["tools", "permissionMode"],
        reference,
      );
      assertToolList(record.tools, "tools", reference);
      if (record.allowedTools !== undefined) assertToolList(record.allowedTools, "allowedTools", reference);
      if (record.disallowedTools !== undefined) assertToolList(record.disallowedTools, "disallowedTools", reference);
      if (!(PERMISSION_MODES as readonly string[]).includes(record.permissionMode as string)) {
        throw configurationError(reference, "permissionMode is invalid");
      }
      if (record.allowDangerouslySkipPermissions !== undefined && typeof record.allowDangerouslySkipPermissions !== "boolean") {
        throw configurationError(reference, "allowDangerouslySkipPermissions must be a boolean");
      }
      if (record.permissionMode === "bypassPermissions" && record.allowDangerouslySkipPermissions !== true) {
        throw configurationError(reference, "bypassPermissions requires allowDangerouslySkipPermissions=true");
      }
      return;
    }
    case "capture-profile": {
      assertRecordKeys(record, ["telemetry", "workspaceOutcome"], [], reference);
      if (record.workspaceOutcome !== undefined) {
        if (!isRecord(record.workspaceOutcome)) throw configurationError(reference, "workspaceOutcome must be an object");
        assertKeys(record.workspaceOutcome, ["excludeDirectoryNames", "respectGitignore", "omitEmptyDirectories"], ["excludeDirectoryNames"], reference);
        assertToolList(record.workspaceOutcome.excludeDirectoryNames, "workspaceOutcome excludeDirectoryNames", reference);
        if ((record.workspaceOutcome.excludeDirectoryNames as string[]).some((name) => name.includes("/") || !isSafeArtifactRelativePath(name))) {
          throw configurationError(reference, "workspaceOutcome excludeDirectoryNames must contain safe path segments");
        }
        if (record.workspaceOutcome.respectGitignore !== undefined && typeof record.workspaceOutcome.respectGitignore !== "boolean") {
          throw configurationError(reference, "workspaceOutcome respectGitignore must be a boolean");
        }
        if (record.workspaceOutcome.omitEmptyDirectories !== undefined && typeof record.workspaceOutcome.omitEmptyDirectories !== "boolean") {
          throw configurationError(reference, "workspaceOutcome omitEmptyDirectories must be a boolean");
        }
      }
      if (record.telemetry === undefined) return;
      if (!isRecord(record.telemetry)) throw configurationError(reference, "telemetry must be an object");
      const telemetry = record.telemetry;
      assertKeys(
        telemetry,
        ["endpoint", "protocol", "exportIntervalMs", "logUserPrompts", "logToolDetails", "logToolContent", "logRawApiBodies"],
        ["endpoint"],
        reference,
      );
      assertTelemetryEndpoint(telemetry.endpoint, reference);
      if (telemetry.protocol !== undefined && !(TELEMETRY_PROTOCOLS as readonly string[]).includes(telemetry.protocol as string)) {
        throw configurationError(reference, "telemetry protocol is invalid");
      }
      if (telemetry.exportIntervalMs !== undefined
          && (!Number.isSafeInteger(telemetry.exportIntervalMs) || (telemetry.exportIntervalMs as number) < 1)) {
        throw configurationError(reference, "telemetry exportIntervalMs must be a positive safe integer");
      }
      for (const flag of ["logUserPrompts", "logToolDetails", "logToolContent", "logRawApiBodies"] as const) {
        if (telemetry[flag] !== undefined && typeof telemetry[flag] !== "boolean") {
          throw configurationError(reference, `telemetry ${flag} must be a boolean`);
        }
      }
      return;
    }
  }
}

function buildSdkConfiguration(
  prompt: string,
  model: AgentSdkModelConfiguration,
  limits: AgentSdkNativeLimitsConfiguration,
  toolPolicy: AgentSdkNativeToolPolicyConfiguration,
  captureProfile: AgentSdkCaptureProfileConfiguration,
  checkReceipt: ClaudeAgentSdkTelemetryConfiguration["checkReceipt"],
): ClaudeAgentSdkConfiguration {
  const telemetry = captureProfile.telemetry;
  return {
    prompt,
    model: model.model,
    tools: [...toolPolicy.tools],
    allowedTools: [...(toolPolicy.allowedTools ?? [])],
    disallowedTools: [...(toolPolicy.disallowedTools ?? [])],
    permissionMode: toolPolicy.permissionMode,
    ...(toolPolicy.allowDangerouslySkipPermissions === undefined
      ? {}
      : { allowDangerouslySkipPermissions: toolPolicy.allowDangerouslySkipPermissions }),
    ...(limits.maxTurns === undefined ? {} : { maxTurns: limits.maxTurns }),
    ...(limits.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: limits.maxBudgetUsd }),
    ...(telemetry === undefined ? {} : {
      telemetry: {
        endpoint: telemetry.endpoint,
        ...(telemetry.protocol === undefined ? {} : { protocol: telemetry.protocol }),
        ...(telemetry.exportIntervalMs === undefined ? {} : { exportIntervalMs: telemetry.exportIntervalMs }),
        ...(telemetry.logUserPrompts === undefined ? {} : { logUserPrompts: telemetry.logUserPrompts }),
        ...(telemetry.logToolDetails === undefined ? {} : { logToolDetails: telemetry.logToolDetails }),
        ...(telemetry.logToolContent === undefined ? {} : { logToolContent: telemetry.logToolContent }),
        ...(telemetry.logRawApiBodies === undefined ? {} : { logRawApiBodies: telemetry.logRawApiBodies }),
        ...(checkReceipt === undefined ? {} : { checkReceipt }),
      },
    }),
  };
}

function buildRunBundleDefinition(
  captureProfile: ArtifactReference,
  entry: RunQueueEntry,
  packet: TaskPacket,
  attemptBundleRoot: string,
  attemptId: string,
  capabilities: { sdkVersion: string; claudeCodeVersion: string },
  verifierFormat: "commonjs" | "module",
): RunBundleDefinition {
  return {
    bundleRoot: attemptBundleRoot,
    bundleId: `bundle-${attemptId}`,
    run: {
      id: entry.runId,
      assessmentMode: packet.assessmentMode,
      task: { id: entry.task.id },
      fixture: {
        id: packet.agentInput.fixture.source.locator,
        digest: `sha256:${packet.agentInput.fixture.source.digest.value}`,
      },
      model: { provider: "anthropic", id: entry.model.id },
      harness: { id: entry.harness.id, version: capabilities.sdkVersion },
      runtime: [
        { source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion },
        { source: "anthropic", name: "agent-cli", version: capabilities.claudeCodeVersion },
      ],
      ...(packet.assessmentMode === "verified" ? {
        verifier: {
          locator: packet.restricted.verifier.locator,
          digest: `sha256:${packet.restricted.verifier.digest.value}`,
          format: verifierFormat,
        },
      } : {}),
    },
    attempt: { id: attemptId, number: 1 },
    configuration: {
      digest: `sha256:${digestMetadata({
        model: entry.configuration.model,
        harness: entry.configuration.harness,
        captureProfile,
      }).value}`,
      budgetDigest: `sha256:${entry.configuration.nativeLimits.digest.value}`,
      toolPolicyDigest: `sha256:${entry.configuration.nativeToolPolicy.digest.value}`,
    },
  };
}

function reopenFinalManifest(bundleRoot: string): RunManifest {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest"));
  assertNoDuplicateJsonKeys(text);
  const manifest = JSON.parse(text) as unknown;
  const errors = [
    ...validateArtifact("manifest.json", manifest),
    ...validateRunManifestEvidence("manifest.json", manifest, bundleRoot),
  ];
  if (errors.length > 0) throw new Error(`Retained run manifest failed validation:\n${formatErrors(errors)}`);
  return manifest as RunManifest;
}

/** Allow the schemaVersion/kind envelope only on top-level configuration records. */
function assertRecordKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  reference: ArtifactReference,
): void {
  assertKeys(record, ["schemaVersion", "kind", ...allowed], required, reference);
}

function assertKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  reference: ArtifactReference,
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) throw configurationError(reference, `contains an unknown field "${key}"`);
  }
  for (const key of required) {
    if (record[key] === undefined) throw configurationError(reference, `is missing the required field "${key}"`);
  }
}

function assertText(value: unknown, field: string, reference: ArtifactReference): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw configurationError(reference, `${field} must be a nonempty string`);
  }
}

function assertToolList(value: unknown, field: string, reference: ArtifactReference): void {
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string" || tool.trim() === "")) {
    throw configurationError(reference, `${field} must be an array of nonempty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw configurationError(reference, `${field} must not repeat tool names`);
  }
}

function assertTelemetryEndpoint(value: unknown, reference: ArtifactReference): void {
  assertText(value, "telemetry endpoint", reference);
  let endpoint: URL;
  try {
    endpoint = new URL(value as string);
  } catch {
    throw configurationError(reference, "telemetry endpoint must be an absolute URL");
  }
  if (!(["http:", "https:"] as string[]).includes(endpoint.protocol)
      || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    throw configurationError(reference, "telemetry endpoint must be an HTTP(S) URL without credentials, query, or fragment");
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function configurationError(reference: ArtifactReference, detail: string): Error {
  return new Error(`Agent SDK configuration "${reference.locator}" ${detail}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
