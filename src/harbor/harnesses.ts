import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digestMetadata } from "../artifacts.js";

import type { ArtifactReference } from "../contracts.js";
import {
  captureCursorSdkRun,
  assertCursorWorkspaceIsolation,
  type CursorSdkCaptureConfiguration,
} from "../cursor-sdk.js";
import { resolveCursorSdkConfigurationRecord } from "../cursor-sdk-runner.js";
import {
  captureCodexAppServerRun,
  probeCodexRuntime,
  resolveCodexConfigurationRecord,
} from "../codex-run.js";
import type { CodexAppServerConfiguration } from "../codex.js";
import { capturePiSdkRun, resolvePiConfigurationRecord, type PiSessionFactory } from "../pi.js";
import type { PiCaptureProfileConfiguration, PiHarnessConfiguration, PiModelConfiguration, PiNativeLimitsConfiguration, PiNativeToolPolicyConfiguration } from "../pi.js";
import type { TerminalState } from "../lifecycle.js";
import type { RunBundleDefinition } from "../run-bundles.js";
import { captureClaudeAgentSdkRun } from "../agent-sdk-run.js";
import { probeClaudeAgentSdkCapabilities } from "../agent-sdk.js";
import { buildSdkConfiguration, resolveAgentSdkConfigurationRecord } from "../agent-sdk-runner.js";
import type { PreparedHarborExecution, PreparedHarborStep } from "./execution.js";
import type { HarborStepExecution, HarborStepExecutorInput, HarborHarnessStepExecutor } from "./runner.js";

export type HarborHarnessConfigurationReferences = {
  model: ArtifactReference;
  harness: ArtifactReference;
  nativeLimits: ArtifactReference;
  nativeToolPolicy: ArtifactReference;
  captureProfile: ArtifactReference;
};

type StepManifestView = {
  terminal?: { state?: TerminalState; failureClass?: string; stopReason?: string };
  run?: { native?: { sessionId?: string } };
};

/** Build the run-bundle definition for one Harbor step consumed by a native capture core. */
export function harborStepBundleDefinition(
  prepared: PreparedHarborExecution,
  step: PreparedHarborStep,
  stepBundleRoot: string,
  details: {
    harnessId: string;
    harnessVersion: string;
    modelId: string;
    provider?: string;
    configurationDigests: { model: string; harness: string; captureProfile: string; nativeLimits: string; nativeToolPolicy: string };
    runtime?: Array<{ source: string; name: string; version: string }>;
  },
): RunBundleDefinition {
  return {
    bundleRoot: stepBundleRoot,
    bundleId: `bundle-${prepared.run.attemptId ?? prepared.run.id}-step-${step.index}`,
    run: {
      id: prepared.run.id,
      trial: { index: prepared.run.trialIndex ?? 1 },
      assessmentMode: prepared.verifier.requested ? "verified" : "observational",
      task: { id: prepared.run.taskId, digest: `sha256:${prepared.task.harborDigest.replace(/^sha256:/, "")}` },
      fixture: {
        id: `harbor:${prepared.task.taskSourceId}:step-${step.index}`,
        digest: `sha256:${digestMetadata({ resolution: prepared.task.resolutionDigest, step: step.index, instruction: step.instructionDigest }).value}`,
      },
      model: { provider: details.provider ?? providerForHarness(details.harnessId), id: details.modelId, configurationDigest: `sha256:${details.configurationDigests.model}` },
      harness: { id: details.harnessId, version: details.harnessVersion, configurationDigest: `sha256:${details.configurationDigests.harness}` },
      runtime: details.runtime ?? [{ source: "EBO", name: details.harnessId, version: details.harnessVersion }],
    },
    attempt: { id: `${prepared.run.attemptId ?? prepared.run.id}-step-${step.index}`, number: 1 },
    configuration: {
      digest: `sha256:${digestMetadata({ instruction: step.instructionDigest, configuration: details.configurationDigests }).value}`,
      captureProfileDigest: `sha256:${details.configurationDigests.captureProfile}`,
      budgetDigest: `sha256:${details.configurationDigests.nativeLimits}`,
      toolPolicyDigest: `sha256:${details.configurationDigests.nativeToolPolicy}`,
    },
  };
}

function providerForHarness(harnessId: string): string {
  if (harnessId === "codex-app-server") return "openai";
  if (harnessId === "deepseek-harness") return "deepseek";
  if (harnessId === "openhands-agent-server") return "openhands";
  return "anthropic";
}

async function readStepManifest(stepBundleRoot: string): Promise<StepManifestView> {
  try {
    return JSON.parse(await readFile(join(stepBundleRoot, "manifest.json"), "utf8")) as StepManifestView;
  } catch {
    return {};
  }
}

async function stepExecutionFromCapture(
  input: HarborStepExecutorInput,
  capture: {
    qualification: { status: "qualified" | "qualified-with-gaps" | "unqualified" };
    attempt: { classification: { kind: string } };
    manifest?: { terminal?: StepManifestView["terminal"]; run?: StepManifestView["run"] };
  },
): Promise<HarborStepExecution> {
  const manifestView = capture.manifest ?? await readStepManifest(input.stepBundleRoot);
  const relativeLocator = relativeBundleLocator(input);
  return {
    bundleLocator: relativeLocator,
    classification: capture.attempt.classification.kind,
    qualification: capture.qualification.status,
    terminal: {
      state: (manifestView.terminal?.state ?? "failed") as HarborStepExecution["terminal"]["state"],
      ...(manifestView.terminal?.failureClass === undefined ? {} : { failureClass: manifestView.terminal.failureClass }),
      ...(manifestView.terminal?.stopReason === undefined ? {} : { stopReason: manifestView.terminal.stopReason }),
    },
    ...(manifestView.run?.native?.sessionId === undefined ? {} : { nativeSessionId: manifestView.run.native.sessionId }),
  };
}

function relativeBundleLocator(input: HarborStepExecutorInput): string {
  const base = input.prepared.evidence.attemptRoot;
  return relativeWithin(base, join(input.stepBundleRoot, "manifest.json"));
}

function relativeWithin(attemptRoot: string, stepBundleRoot: string): string {
  const marker = `${attemptRoot}${attemptRoot.endsWith("/") ? "" : "/"}`;
  if (!stepBundleRoot.startsWith(marker)) return "manifest.json";
  return stepBundleRoot.slice(marker.length).replace(/\\/g, "/");
}

/** Coordinator that hands the live Harbor workspace to a native capture core without deleting it. */
function harborWorkspaceCoordinator(workspacePath: string, onSetup?: () => void): {
  setup: () => { status: "ready"; path: string; artifactId: string; retained: true };
  cleanup: () => Promise<void>;
} {
  return {
    setup: () => {
      onSetup?.();
      return { status: "ready", path: workspacePath, artifactId: "workspace", retained: true } as const;
    },
    cleanup: async () => {
      // The Harbor attempt workspace is trial evidence; it is retained.
    },
  };
}

/* ---------------------------------- Claude Agent SDK ---------------------------------- */

export type ClaudeAgentSdkHarborExecutorOptions = {
  studyRoot: string;
  configuration: HarborHarnessConfigurationReferences;
  query?: (input: { prompt: string; options?: unknown }) => AsyncIterable<unknown> & { close: () => void };
  signal?: AbortSignal;
};

export function createClaudeAgentSdkHarborExecutor(options: ClaudeAgentSdkHarborExecutorOptions): HarborHarnessStepExecutor {
  return async (input: HarborStepExecutorInput): Promise<HarborStepExecution> => {
    const model = resolveAgentSdkConfigurationRecord(options.studyRoot, options.configuration.model, "model");
    resolveAgentSdkConfigurationRecord(options.studyRoot, options.configuration.harness, "harness");
    const limits = resolveAgentSdkConfigurationRecord(options.studyRoot, options.configuration.nativeLimits, "native-limits");
    const toolPolicy = resolveAgentSdkConfigurationRecord(options.studyRoot, options.configuration.nativeToolPolicy, "native-tool-policy");
    const captureProfile = resolveAgentSdkConfigurationRecord(options.studyRoot, options.configuration.captureProfile, "capture-profile");
    const capabilities = probeClaudeAgentSdkCapabilities();
    const definition = harborStepBundleDefinition(input.prepared, input.step, input.stepBundleRoot, {
      harnessId: input.prepared.run.harnessId,
      harnessVersion: capabilities.sdkVersion,
      modelId: model.model,
      configurationDigests: {
        model: options.configuration.model.digest.value,
        harness: options.configuration.harness.digest.value,
        captureProfile: options.configuration.captureProfile.digest.value,
        nativeLimits: options.configuration.nativeLimits.digest.value,
        nativeToolPolicy: options.configuration.nativeToolPolicy.digest.value,
      },
      runtime: [
        { source: "anthropic", name: "claude-agent-sdk", version: capabilities.sdkVersion },
        { source: "anthropic", name: "agent-cli", version: capabilities.claudeCodeVersion },
      ],
    });
    const result = await captureClaudeAgentSdkRun({
      definition,
      startingWorkspacePath: input.startingWorkspacePath,
      workspace: harborWorkspaceCoordinator(input.workspacePath),
      configuration: buildSdkConfiguration(input.step.effectiveInstruction, model, limits, toolPolicy, captureProfile, undefined),
      ...workspaceCaptureOptions(captureProfile.workspaceOutcome),
      maxWallClockMs: input.maxWallClockMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(options.query === undefined ? {} : { query: options.query as never }),
    });
    return stepExecutionFromCapture(input, {
      qualification: result.qualification,
      attempt: result.attempt,
      manifest: result.manifest as unknown as StepManifestView,
    });
  };
}

/* ------------------------------------- Codex app-server ------------------------------------- */

export type CodexHarborExecutorOptions = {
  studyRoot: string;
  configuration: HarborHarnessConfigurationReferences;
  probeRuntime?: (executable: string) => Promise<{ path: string; version: string }>;
  executableArgs?: readonly string[];
  signal?: AbortSignal;
};

export function createCodexHarborExecutor(options: CodexHarborExecutorOptions): HarborHarnessStepExecutor {
  return async (input: HarborStepExecutorInput): Promise<HarborStepExecution> => {
    const model = resolveCodexConfigurationRecord(options.studyRoot, options.configuration.model, "model");
    const harness = resolveCodexConfigurationRecord(options.studyRoot, options.configuration.harness, "harness");
    const limits = resolveCodexConfigurationRecord(options.studyRoot, options.configuration.nativeLimits, "native-limits");
    const toolPolicy = resolveCodexConfigurationRecord(options.studyRoot, options.configuration.nativeToolPolicy, "native-tool-policy");
    const captureProfile = resolveCodexConfigurationRecord(options.studyRoot, options.configuration.captureProfile, "capture-profile");
    if (input.prepared.run.harnessId !== "codex-app-server") throw new Error("Codex Harbor executor requires the codex-app-server harness.");
    const runtime = await (options.probeRuntime ?? probeCodexRuntime)(harness.executable);
    if (runtime.version !== `codex-cli ${harness.version}`) {
      throw new Error(`Codex ${harness.version} is required; received ${runtime.version}.`);
    }
    const definition = harborStepBundleDefinition(input.prepared, input.step, input.stepBundleRoot, {
      harnessId: "codex-app-server",
      harnessVersion: harness.version,
      modelId: model.model,
      provider: model.provider,
      configurationDigests: {
        model: options.configuration.model.digest.value,
        harness: options.configuration.harness.digest.value,
        captureProfile: options.configuration.captureProfile.digest.value,
        nativeLimits: options.configuration.nativeLimits.digest.value,
        nativeToolPolicy: options.configuration.nativeToolPolicy.digest.value,
      },
    });
    const configuration: CodexAppServerConfiguration = {
      executable: runtime.path,
      ...(options.executableArgs === undefined ? {} : { executableArgs: options.executableArgs }),
      version: harness.version,
      provider: model.provider,
      model: model.model,
      effort: model.effort,
      approvalPolicy: toolPolicy.approvalPolicy,
      sandbox: toolPolicy.sandbox,
      ...(toolPolicy.networkAccess === undefined ? {} : { networkAccess: toolPolicy.networkAccess }),
      ...(captureProfile.telemetrySignals === undefined ? {} : { telemetry: { signals: captureProfile.telemetrySignals } }),
    };
    const result = await captureCodexAppServerRun({
      definition,
      startingWorkspacePath: input.startingWorkspacePath,
      workspace: harborWorkspaceCoordinator(input.workspacePath),
      configuration,
      prompt: input.step.effectiveInstruction,
      ...workspaceCaptureOptions(captureProfile.workspaceOutcome),
      maxWallClockMs: input.maxWallClockMs,
      ...(limits.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: limits.shutdownGraceMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return stepExecutionFromCapture(input, {
      qualification: result.qualification,
      attempt: result.attempt,
      manifest: { terminal: result.manifest.terminal, run: (result.manifest as unknown as { run?: { native?: { sessionId?: string } } }).run },
    });
  };
}

/* ------------------------------------- Cursor SDK ------------------------------------- */

export type CursorHarborExecutorOptions = {
  studyRoot: string;
  configuration: HarborHarnessConfigurationReferences;
  apiKey: string;
  agentFactory?: NonNullable<Parameters<typeof captureCursorSdkRun>[0]["agentFactory"]>;
  signal?: AbortSignal;
};

export function createCursorHarborExecutor(options: CursorHarborExecutorOptions): HarborHarnessStepExecutor {
  return async (input: HarborStepExecutorInput): Promise<HarborStepExecution> => {
    const model = resolveCursorSdkConfigurationRecord(options.studyRoot, options.configuration.model, "model");
    resolveCursorSdkConfigurationRecord(options.studyRoot, options.configuration.harness, "harness");
    const limits = resolveCursorSdkConfigurationRecord(options.studyRoot, options.configuration.nativeLimits, "native-limits");
    const toolPolicy = resolveCursorSdkConfigurationRecord(options.studyRoot, options.configuration.nativeToolPolicy, "native-tool-policy");
    const captureProfile = resolveCursorSdkConfigurationRecord(options.studyRoot, options.configuration.captureProfile, "capture-profile");
    await assertCursorWorkspaceIsolation(input.workspacePath);
    const definition = harborStepBundleDefinition(input.prepared, input.step, input.stepBundleRoot, {
      harnessId: input.prepared.run.harnessId,
      harnessVersion: "1.0.31",
      modelId: model.model.id,
      provider: "cursor",
      runtime: [{ source: "cursor", name: "cursor-sdk", version: "1.0.31" }, { source: "cursor", name: "local-agent-runtime", version: "not-exposed" }],
      configurationDigests: {
        model: options.configuration.model.digest.value,
        harness: options.configuration.harness.digest.value,
        captureProfile: options.configuration.captureProfile.digest.value,
        nativeLimits: options.configuration.nativeLimits.digest.value,
        nativeToolPolicy: options.configuration.nativeToolPolicy.digest.value,
      },
    });
    const configuration: CursorSdkCaptureConfiguration = {
      model: structuredClone(model.model),
      toolPolicy: {
        tools: [...toolPolicy.tools],
        ...(toolPolicy.disallowedTools === undefined ? {} : { disallowedTools: [...toolPolicy.disallowedTools] }),
        sandbox: { enabled: toolPolicy.sandbox.enabled },
        settingSources: [],
        autoReview: false,
        enableAgentRetries: true,
      },
      maxNativeRecordBytes: limits.maxNativeRecordBytes,
    };
    const result = await captureCursorSdkRun({
      definition,
      startingWorkspacePath: input.startingWorkspacePath,
      workspace: harborWorkspaceCoordinator(input.workspacePath),
      configuration,
      apiKey: options.apiKey,
      prompt: input.step.effectiveInstruction,
      ...workspaceCaptureOptions(captureProfile.workspaceOutcome),
      maxWallClockMs: input.maxWallClockMs,
      shutdownGraceMs: limits.shutdownGraceMs,
      ...(options.agentFactory === undefined ? {} : { agentFactory: options.agentFactory }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return stepExecutionFromCapture(input, {
      qualification: result.qualification,
      attempt: result.attempt,
      manifest: { terminal: result.manifest.terminal, run: (result.manifest as unknown as { run?: { native?: { sessionId?: string } } }).run },
    });
  };
}

/* ------------------------------------- Pi SDK ------------------------------------- */

export type PiHarborExecutorOptions = {
  studyRoot: string;
  configuration: HarborHarnessConfigurationReferences;
  createSession?: PiSessionFactory;
  signal?: AbortSignal;
};

export function createPiHarborExecutor(options: PiHarborExecutorOptions): HarborHarnessStepExecutor {
  return async (input: HarborStepExecutorInput): Promise<HarborStepExecution> => {
    const model = resolvePiConfigurationRecord(options.studyRoot, options.configuration.model, "model") as PiModelConfiguration;
    const harness = resolvePiConfigurationRecord(options.studyRoot, options.configuration.harness, "harness") as PiHarnessConfiguration;
    const limits = resolvePiConfigurationRecord(options.studyRoot, options.configuration.nativeLimits, "native-limits") as PiNativeLimitsConfiguration;
    const toolPolicy = resolvePiConfigurationRecord(options.studyRoot, options.configuration.nativeToolPolicy, "native-tool-policy") as PiNativeToolPolicyConfiguration;
    const captureProfile = resolvePiConfigurationRecord(options.studyRoot, options.configuration.captureProfile, "capture-profile") as PiCaptureProfileConfiguration;
    const definition = harborStepBundleDefinition(input.prepared, input.step, input.stepBundleRoot, {
      harnessId: "pi-sdk",
      harnessVersion: harness.version ?? "0",
      modelId: model.model,
      provider: model.provider,
      configurationDigests: {
        model: options.configuration.model.digest.value,
        harness: options.configuration.harness.digest.value,
        captureProfile: options.configuration.captureProfile.digest.value,
        nativeLimits: options.configuration.nativeLimits.digest.value,
        nativeToolPolicy: options.configuration.nativeToolPolicy.digest.value,
      },
    });
    const result = await capturePiSdkRun({
      definition,
      configurationRoot: options.studyRoot,
      startingWorkspacePath: input.startingWorkspacePath,
      workspace: harborWorkspaceCoordinator(input.workspacePath),
      model,
      harness,
      limits,
      toolPolicy,
      captureProfile,
      prompt: input.step.effectiveInstruction,
      ...workspaceCaptureOptions(captureProfile.workspaceOutcome),
      maxWallClockMs: input.maxWallClockMs,
      ...(options.createSession === undefined ? {} : { createSession: options.createSession }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return stepExecutionFromCapture(input, {
      qualification: result.qualification,
      attempt: result.attempt,
      manifest: { terminal: result.manifest.terminal, run: (result.manifest as unknown as { run?: { native?: { sessionId?: string } } }).run },
    });
  };
}

export { createOpenHandsHarborExecutor, createDeepSeekHarborExecutor, type OpenHandsHarborExecutorOptions, type DeepSeekHarborExecutorOptions } from "./other-harnesses.js";

function workspaceCaptureOptions(policy?: { excludeDirectoryNames?: string[]; respectGitignore?: boolean; omitEmptyDirectories?: boolean }) {
  return {
    workspaceOutcomeExcludedDirectoryNames: policy?.excludeDirectoryNames,
    workspaceOutcomeRespectsGitignore: policy?.respectGitignore,
    workspaceOutcomeOmitsEmptyDirectories: policy?.omitEmptyDirectories,
  };
}
