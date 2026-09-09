import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Cursor, type ModelSelection, type SDKModel } from "@cursor/sdk";

import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact, validateRunManifestEvidence } from "./artifacts.js";
import { isSafeArtifactRelativePath, resolveBundleConfiguration, type ArtifactReference } from "./contracts.js";
import {
  assertCursorWorkspaceIsolation,
  captureCursorSdkRun,
  CURSOR_SDK_HARNESS,
  CURSOR_SDK_VERSION,
  type CursorSdkAgentFactory,
  type CursorSdkCaptureConfiguration,
  type CursorSdkToolPolicy,
} from "./cursor-sdk.js";
import type { AttemptClassificationKind, TerminalRecord } from "./lifecycle.js";
import type { CaptureQualificationStatus, RunBundleDefinition, RunManifest } from "./run-bundles.js";
import { readBoundedFile, readRunQueue, type RunQueueEntry } from "./scheduler.js";
import { assertTaskPacketAdmitted, formatErrors, type TaskPacket } from "./task-packets.js";
import { executeVerifier } from "./verifiers.js";
import { cleanupWorkspace, materializeWorkspace } from "./workspaces.js";

export const CURSOR_SDK_CONFIG_SCHEMA_VERSION = "ebo.cursor-sdk-config/v1";

export type CursorSdkModelConfiguration = {
  schemaVersion: typeof CURSOR_SDK_CONFIG_SCHEMA_VERSION;
  kind: "model";
  provider: "cursor";
  model: ModelSelection;
};

export type CursorSdkHarnessConfiguration = {
  schemaVersion: typeof CURSOR_SDK_CONFIG_SCHEMA_VERSION;
  kind: "harness";
  adapter: typeof CURSOR_SDK_HARNESS;
  sdkVersion: typeof CURSOR_SDK_VERSION;
};

export type CursorSdkNativeLimitsConfiguration = {
  schemaVersion: typeof CURSOR_SDK_CONFIG_SCHEMA_VERSION;
  kind: "native-limits";
  shutdownGraceMs: number;
  maxNativeRecordBytes: number;
};

export type CursorSdkNativeToolPolicyConfiguration = CursorSdkToolPolicy & {
  schemaVersion: typeof CURSOR_SDK_CONFIG_SCHEMA_VERSION;
  kind: "native-tool-policy";
};

export type CursorSdkCaptureProfileConfiguration = {
  schemaVersion: typeof CURSOR_SDK_CONFIG_SCHEMA_VERSION;
  kind: "capture-profile";
  /** SDK-local per-run configuration/receipt only; not Cursor's Enterprise team export. */
  nativeOtlp: "unsupported";
  workspaceOutcome?: {
    excludeDirectoryNames: string[];
    respectGitignore?: boolean;
    omitEmptyDirectories?: boolean;
  };
};

export type CursorSdkConfigurationRecord =
  | CursorSdkModelConfiguration
  | CursorSdkHarnessConfiguration
  | CursorSdkNativeLimitsConfiguration
  | CursorSdkNativeToolPolicyConfiguration
  | CursorSdkCaptureProfileConfiguration;

export type CursorSdkConfigurationKind = CursorSdkConfigurationRecord["kind"];

export type CursorSdkModelLister = (options: { apiKey: string; signal?: AbortSignal }) => Promise<SDKModel[]>;

export type RunCursorSdkQueueEntryOptions = {
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot?: string;
  attemptId?: string;
  apiKey?: string;
  agentFactory?: CursorSdkAgentFactory;
  modelLister?: CursorSdkModelLister;
  signal?: AbortSignal;
};

export type CursorSdkRunSummary = {
  runId: string;
  attemptId: string;
  bundlePath: string;
  terminal: TerminalRecord;
  classification: AttemptClassificationKind;
  captureQualification: CaptureQualificationStatus;
  assessmentMode: TaskPacket["assessmentMode"];
  sessionId?: string;
  nativeRunId?: string;
  retainedWorkspacePath?: string;
};

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Execute exactly one digest-pinned queue entry through the local Cursor SDK. */
export async function runCursorSdkQueueEntry(options: RunCursorSdkQueueEntryOptions): Promise<CursorSdkRunSummary> {
  const bundleRoot = resolve(options.bundleRoot);
  const queue = readRunQueue(options.queuePath, undefined, { bundleRoot });
  const matches = queue.entries.filter((candidate) => candidate.runId === options.runId);
  if (matches.length === 0) throw new Error(`Run "${options.runId}" is not in the queue.`);
  if (matches.length > 1) throw new Error(`Run "${options.runId}" matches more than one queue entry.`);
  const entry = matches[0]!;
  if (entry.harness.id !== CURSOR_SDK_HARNESS) throw new Error(`Queue entry harness must be ${CURSOR_SDK_HARNESS}.`);

  const model = resolveCursorSdkConfigurationRecord(bundleRoot, entry.configuration.model, "model");
  resolveCursorSdkConfigurationRecord(bundleRoot, entry.configuration.harness, "harness");
  const limits = resolveCursorSdkConfigurationRecord(bundleRoot, entry.configuration.nativeLimits, "native-limits");
  const toolPolicy = resolveCursorSdkConfigurationRecord(bundleRoot, entry.configuration.nativeToolPolicy, "native-tool-policy");
  const captureProfile = resolveCursorSdkConfigurationRecord(bundleRoot, queue.captureProfile, "capture-profile");
  const auth = options.apiKey ?? process.env.CURSOR_API_KEY;
  if (auth === undefined || auth.trim() === "") {
    throw new Error("An approved Cursor credential is required through the runtime secret path.");
  }
  if (options.signal?.aborted) throw new Error("Cursor model catalog lookup was interrupted.");
  const catalogPromise = (options.modelLister ?? ((input) => Cursor.models.list({ apiKey: input.apiKey })))(
    { apiKey: auth, ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
  const availableModels = await abortablePreflight(catalogPromise, options.signal, "Cursor model catalog lookup");
  const catalogModel = availableModels.find(({ id }) => id === model.model.id);
  if (catalogModel === undefined) throw new Error(`Cursor model "${model.model.id}" is not an exact available catalog model.`);
  validateModelParameters(model.model, catalogModel);

  const inspection = assertTaskPacketAdmitted(bundleRoot, entry.task.packetRef.locator);
  const packet = inspection.packet as TaskPacket;
  if (inspection.packetDigest === null || inspection.packetDigest.value !== entry.task.packetRef.digest.value
      || inspection.packetDigest.algorithm !== entry.task.packetRef.digest.algorithm) {
    throw new Error(`Task packet "${entry.task.packetRef.locator}" changed from its frozen queue reference.`);
  }
  const verifierReference = packet.assessmentMode === "verified" ? packet.restricted.verifier : undefined;
  const verifierFormat = verifierReference?.locator.toLowerCase().endsWith(".mjs") ? "module" : "commonjs";

  const attemptId = options.attemptId ?? randomUUID();
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("Attempt ID must be one safe path component.");
  const outputRoot = resolve(options.outputRoot);
  const attemptBundleRoot = join(outputRoot, entry.runId, attemptId);
  const fromOutputRoot = relative(outputRoot, attemptBundleRoot);
  if (fromOutputRoot === "" || isAbsolute(fromOutputRoot) || fromOutputRoot === ".." || fromOutputRoot.startsWith(`..${sep}`)) {
    throw new Error("Attempt destination escapes the selected output root.");
  }
  if (pathExists(attemptBundleRoot)) throw new Error(`Attempt destination "${attemptBundleRoot}" already exists and is never replaced.`);

  const definition = buildRunBundleDefinition(queue.captureProfile, entry, packet, model.model.id, attemptBundleRoot, attemptId, verifierFormat);
  const configuration: CursorSdkCaptureConfiguration = {
    model: structuredClone(model.model),
    toolPolicy: {
      tools: [...toolPolicy.tools],
      ...(toolPolicy.disallowedTools === undefined ? {} : { disallowedTools: [...toolPolicy.disallowedTools] }),
      sandbox: { enabled: toolPolicy.sandbox.enabled },
      settingSources: [],
      autoReview: false,
      enableAgentRetries: false,
    },
    maxNativeRecordBytes: limits.maxNativeRecordBytes,
  };

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
    await assertCursorWorkspaceIsolation(workspace.path);
    baselineRoot = await mkdtemp(join(tmpdir(), "ebo-cursor-sdk-baseline-"));
    const startingWorkspacePath = join(baselineRoot, "workspace");
    await cp(workspace.path, startingWorkspacePath, { recursive: true, preserveTimestamps: true, force: false });
    const result = await captureCursorSdkRun({
      definition,
      startingWorkspacePath,
      workspace: {
        setup: () => {
          captureStarted = true;
          return { status: "ready", path: workspace.path, artifactId: "workspace", retained: true };
        },
        cleanup: async () => cleanupWorkspace(workspace),
      },
      configuration,
      apiKey: auth,
      prompt: packet.agentInput.prompt,
      ...(captureProfile.workspaceOutcome === undefined ? {} : {
        workspaceOutcomeExcludedDirectoryNames: captureProfile.workspaceOutcome.excludeDirectoryNames,
        ...(captureProfile.workspaceOutcome.respectGitignore === undefined ? {} : { workspaceOutcomeRespectsGitignore: captureProfile.workspaceOutcome.respectGitignore }),
        ...(captureProfile.workspaceOutcome.omitEmptyDirectories === undefined ? {} : { workspaceOutcomeOmitsEmptyDirectories: captureProfile.workspaceOutcome.omitEmptyDirectories }),
      }),
      ...(verifierReference === undefined ? {} : {
        verifier: (context, outcome, projectedWorkspacePath) => executeVerifier({
          bundleId: definition.bundleId,
          verifierRoot: bundleRoot,
          verifier: verifierReference,
          workspacePath: projectedWorkspacePath,
          workspaceFingerprint: outcome.fingerprint,
          workspace: { artifactId: outcome.descriptor.id, digest: outcome.descriptor.digest, fingerprint: outcome.fingerprint },
          artifactRoot: attemptBundleRoot,
          moduleFormat: verifierFormat,
          signal: context.signal,
        }),
      }),
      maxWallClockMs: queue.coordinatorBudget.maxWallClockMs,
      shutdownGraceMs: limits.shutdownGraceMs,
      ...(options.agentFactory === undefined ? {} : { agentFactory: options.agentFactory }),
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
      ...(result.capture.runId === undefined ? {} : { nativeRunId: result.capture.runId }),
      ...(workspace.state === "ready" ? { retainedWorkspacePath: workspace.path } : {}),
    };
  } finally {
    if (baselineRoot !== undefined) await rm(baselineRoot, { recursive: true, force: true });
    if (!captureStarted && workspace.state === "ready") await cleanupWorkspace(workspace).catch(() => undefined);
  }
}

type ConfigurationByKind = {
  model: CursorSdkModelConfiguration;
  harness: CursorSdkHarnessConfiguration;
  "native-limits": CursorSdkNativeLimitsConfiguration;
  "native-tool-policy": CursorSdkNativeToolPolicyConfiguration;
  "capture-profile": CursorSdkCaptureProfileConfiguration;
};

export function resolveCursorSdkConfigurationRecord<Kind extends CursorSdkConfigurationKind>(
  bundleRoot: string,
  reference: ArtifactReference,
  kind: Kind,
): ConfigurationByKind[Kind] {
  const bytes = resolveBundleConfiguration(bundleRoot, reference);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw configurationError(reference, "is not valid UTF-8");
  }
  assertNoDuplicateJsonKeys(source);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw configurationError(reference, `is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw configurationError(reference, "must be a JSON object");
  if (value.schemaVersion !== CURSOR_SDK_CONFIG_SCHEMA_VERSION) {
    throw configurationError(reference, `must declare schemaVersion ${CURSOR_SDK_CONFIG_SCHEMA_VERSION}`);
  }
  if (value.kind !== kind) throw configurationError(reference, `has kind "${String(value.kind)}" instead of "${kind}"`);
  validateConfigurationRecord(value, kind, reference);
  return value as ConfigurationByKind[Kind];
}

function validateConfigurationRecord(record: Record<string, unknown>, kind: CursorSdkConfigurationKind, reference: ArtifactReference): void {
  switch (kind) {
    case "model": {
      assertRecordKeys(record, ["provider", "model"], ["provider", "model"], reference);
      if (record.provider !== "cursor" || !isRecord(record.model)) throw configurationError(reference, "must declare a Cursor model object");
      assertKeys(record.model, ["id", "params"], ["id"], reference);
      assertText(record.model.id, "model.id", reference);
      if (record.model.params !== undefined) {
        if (!Array.isArray(record.model.params) || record.model.params.some((entry) => !isRecord(entry)
            || Object.keys(entry).some((key) => !["id", "value"].includes(key))
            || typeof entry.id !== "string" || entry.id.trim() === "" || typeof entry.value !== "string" || entry.value.trim() === "")) {
          throw configurationError(reference, "model.params must contain only nonempty id/value pairs");
        }
      }
      return;
    }
    case "harness":
      assertRecordKeys(record, ["adapter", "sdkVersion"], ["adapter", "sdkVersion"], reference);
      if (record.adapter !== CURSOR_SDK_HARNESS || record.sdkVersion !== CURSOR_SDK_VERSION) {
        throw configurationError(reference, `must pin ${CURSOR_SDK_HARNESS} ${CURSOR_SDK_VERSION}`);
      }
      return;
    case "native-limits":
      assertRecordKeys(record, ["shutdownGraceMs", "maxNativeRecordBytes"], ["shutdownGraceMs", "maxNativeRecordBytes"], reference);
      for (const field of ["shutdownGraceMs", "maxNativeRecordBytes"] as const) {
        if (!Number.isSafeInteger(record[field]) || (record[field] as number) < 1) throw configurationError(reference, `${field} must be a positive safe integer`);
      }
      return;
    case "native-tool-policy":
      assertRecordKeys(record, ["tools", "disallowedTools", "sandbox", "settingSources", "autoReview", "enableAgentRetries"],
        ["tools", "sandbox", "settingSources", "autoReview", "enableAgentRetries"], reference);
      assertStringList(record.tools, "tools", reference);
      if (record.disallowedTools !== undefined) assertStringList(record.disallowedTools, "disallowedTools", reference);
      if (!isRecord(record.sandbox) || typeof record.sandbox.enabled !== "boolean" || Object.keys(record.sandbox).some((key) => key !== "enabled")) {
        throw configurationError(reference, "sandbox.enabled must be an explicit boolean");
      }
      if (!Array.isArray(record.settingSources) || record.settingSources.length !== 0) {
        throw configurationError(reference, "settingSources must be [] so unrelated user/candidate settings are not loaded");
      }
      if (record.autoReview !== false || record.enableAgentRetries !== false) {
        throw configurationError(reference, "autoReview and enableAgentRetries must both be false for an observational attempt");
      }
      return;
    case "capture-profile":
      assertRecordKeys(record, ["nativeOtlp", "workspaceOutcome"], ["nativeOtlp"], reference);
      if (record.nativeOtlp !== "unsupported") throw configurationError(reference, 'nativeOtlp must be "unsupported" for SDK 1.0.31');
      if (record.workspaceOutcome !== undefined) {
        if (!isRecord(record.workspaceOutcome)) throw configurationError(reference, "workspaceOutcome must be an object");
        assertKeys(record.workspaceOutcome, ["excludeDirectoryNames", "respectGitignore", "omitEmptyDirectories"], ["excludeDirectoryNames"], reference);
        assertStringList(record.workspaceOutcome.excludeDirectoryNames, "workspaceOutcome.excludeDirectoryNames", reference);
        if ((record.workspaceOutcome.excludeDirectoryNames as string[]).some((name) => name.includes("/") || !isSafeArtifactRelativePath(name))) {
          throw configurationError(reference, "workspace exclusions must be safe path segments");
        }
        for (const flag of ["respectGitignore", "omitEmptyDirectories"] as const) {
          if (record.workspaceOutcome[flag] !== undefined && typeof record.workspaceOutcome[flag] !== "boolean") {
            throw configurationError(reference, `workspaceOutcome.${flag} must be a boolean`);
          }
        }
      }
      return;
  }
}

function buildRunBundleDefinition(
  captureProfile: ArtifactReference,
  entry: RunQueueEntry,
  packet: TaskPacket,
  effectiveModelId: string,
  bundleRoot: string,
  attemptId: string,
  verifierFormat: "commonjs" | "module",
): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-${attemptId}`,
    run: {
      id: entry.runId,
      trial: { index: entry.trial.index },
      assessmentMode: packet.assessmentMode,
      task: { id: entry.task.id, digest: `sha256:${entry.task.packetRef.digest.value}` },
      fixture: { id: packet.agentInput.fixture.source.locator, digest: `sha256:${packet.agentInput.fixture.source.digest.value}` },
      model: { provider: "cursor", id: effectiveModelId, configurationDigest: `sha256:${entry.configuration.model.digest.value}` },
      harness: { id: CURSOR_SDK_HARNESS, version: CURSOR_SDK_VERSION, configurationDigest: `sha256:${entry.configuration.harness.digest.value}` },
      runtime: [
        { source: "cursor", name: "cursor-sdk", version: CURSOR_SDK_VERSION },
        { source: "cursor", name: "local-agent-runtime", version: "not-exposed" },
      ],
      ...(packet.assessmentMode === "verified" ? {
        verifier: { locator: packet.restricted.verifier.locator, digest: `sha256:${packet.restricted.verifier.digest.value}`, format: verifierFormat },
      } : {}),
    },
    attempt: { id: attemptId, number: 1 },
    configuration: {
      digest: `sha256:${digestMetadata({ model: entry.configuration.model, harness: entry.configuration.harness, captureProfile }).value}`,
      captureProfileDigest: `sha256:${captureProfile.digest.value}`,
      budgetDigest: `sha256:${entry.configuration.nativeLimits.digest.value}`,
      toolPolicyDigest: `sha256:${entry.configuration.nativeToolPolicy.digest.value}`,
    },
  };
}

function validateModelParameters(selection: ModelSelection, catalog: SDKModel): void {
  const selected = selection.params ?? [];
  if (new Set(selected.map(({ id }) => id)).size !== selected.length) throw new Error("Cursor model parameters must not repeat IDs.");
  for (const parameter of selected) {
    const definition = catalog.parameters?.find(({ id }) => id === parameter.id);
    if (definition === undefined || !definition.values.some(({ value }) => value === parameter.value)) {
      throw new Error(`Cursor model parameter ${parameter.id}=${parameter.value} is not available in the current catalog.`);
    }
  }
}

async function abortablePreflight<T>(promise: Promise<T>, signal: AbortSignal | undefined, label: string): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) throw new Error(`${label} was interrupted.`);
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new Error(`${label} was interrupted.`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolvePromise(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rejectPromise(error);
    });
  });
}

function reopenFinalManifest(bundleRoot: string): RunManifest {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest"));
  assertNoDuplicateJsonKeys(source);
  const manifest = JSON.parse(source) as unknown;
  const errors = [...validateArtifact("manifest.json", manifest), ...validateRunManifestEvidence("manifest.json", manifest, bundleRoot)];
  if (errors.length > 0) throw new Error(`Retained run manifest failed validation:\n${formatErrors(errors)}`);
  return manifest as RunManifest;
}

function assertRecordKeys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], reference: ArtifactReference): void {
  assertKeys(record, ["schemaVersion", "kind", ...allowed], required, reference);
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], reference: ArtifactReference): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(record)) if (!permitted.has(key)) throw configurationError(reference, `contains unknown field "${key}"`);
  for (const key of required) if (record[key] === undefined) throw configurationError(reference, `is missing required field "${key}"`);
}

function assertText(value: unknown, field: string, reference: ArtifactReference): void {
  if (typeof value !== "string" || value.trim() === "") throw configurationError(reference, `${field} must be a nonempty string`);
}

function assertStringList(value: unknown, field: string, reference: ArtifactReference): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "") || new Set(value).size !== value.length) {
    throw configurationError(reference, `${field} must be a unique array of nonempty strings`);
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
  return new Error(`Cursor SDK configuration "${reference.locator}" ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
