import type { HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { stat } from "node:fs/promises";

import {
  executeClaudeAgentSdk,
  openClaudeAgentSdkHookCapture,
  openClaudeAgentSdkStreamCapture,
  probeClaudeAgentSdkCapabilities,
  type ClaudeAgentSdkAttemptEvidence,
  type ClaudeAgentSdkCaptureReport,
  type ClaudeAgentSdkConfiguration,
  type ClaudeAgentSdkQuery,
} from "./agent-sdk.js";
import {
  createAttemptIdentity,
  createRunIdentity,
  executeRunAttempt,
  type RunAttemptResult,
  type VerifierExecutionContext,
  type WorkspaceCoordinator,
  type WorkspaceExecutionResult,
} from "./lifecycle.js";
import {
  createRunBundleAssembler,
  qualifyRunBundle,
  type CaptureQualificationReport,
  type CapturedWorkspaceOutcome,
  type CaptureMissingEvidence,
  type RunBundleDefinition,
  type RunManifest,
} from "./run-bundles.js";
import type { VerifierResult } from "./verifiers.js";

export type CaptureClaudeAgentSdkVerifier = (
  context: VerifierExecutionContext,
  workspace: CapturedWorkspaceOutcome,
  workspacePath: string,
) => VerifierResult | Promise<VerifierResult>;

export type CaptureClaudeAgentSdkRunOptions = {
  definition: RunBundleDefinition;
  startingWorkspacePath: string;
  workspace: WorkspaceCoordinator;
  configuration: ClaudeAgentSdkConfiguration;
  verifier?: CaptureClaudeAgentSdkVerifier;
  workspaceOutcomeExcludedDirectoryNames?: readonly string[];
  workspaceOutcomeRespectsGitignore?: boolean;
  workspaceOutcomeOmitsEmptyDirectories?: boolean;
  expectedHooks?: readonly HookEvent[];
  query?: ClaudeAgentSdkQuery;
  traceId?: string;
  signal?: AbortSignal;
  maxWallClockMs?: number;
  harnessBudgetMs?: number;
  shutdownGraceMs?: number;
};

export type CaptureClaudeAgentSdkRunResult = {
  attempt: RunAttemptResult;
  manifest: RunManifest;
  qualification: CaptureQualificationReport;
  stream: ClaudeAgentSdkCaptureReport;
};

/** Execute and retain one caller-configured Agent SDK attempt without scheduling or retrying it. */
export async function captureClaudeAgentSdkRun(
  options: CaptureClaudeAgentSdkRunOptions,
): Promise<CaptureClaudeAgentSdkRunResult> {
  if (options.definition.run.model.id !== options.configuration.model) {
    throw new Error("The declared model must match the Agent SDK model configuration.");
  }
  const expectedHooks = [...new Set(options.expectedHooks ?? [])];
  const capabilities = probeClaudeAgentSdkCapabilities();
  const definition = withPinnedRuntime(options.definition, capabilities.sdkVersion, capabilities.claudeCodeVersion);
  const assembler = await createRunBundleAssembler(definition);
  const hookCapture = await openClaudeAgentSdkHookCapture(`${assembler.bundleRoot}/hooks.jsonl`);
  const streamCapture = await openClaudeAgentSdkStreamCapture(`${assembler.bundleRoot}/session.jsonl`, {
    message: () => undefined,
    stderr: () => undefined,
    hook: hookCapture.hook,
    lifecycle: () => undefined,
    flush: hookCapture.flush,
  });
  let workspace: WorkspaceExecutionResult | undefined;
  let workspaceOutcome: CapturedWorkspaceOutcome | undefined;
  let workspaceOutcomePromise: Promise<CapturedWorkspaceOutcome> | undefined;
  let workspaceCaptureError: string | undefined;
  let verifierResult: VerifierResult | undefined;
  let verifierError: unknown;

  const captureWorkspace = async (verifierContext?: VerifierExecutionContext): Promise<CapturedWorkspaceOutcome> => {
    if (workspaceOutcome !== undefined) return workspaceOutcome;
    workspaceOutcomePromise ??= (async () => {
      if (workspace?.status !== "ready" || workspace.path === undefined || workspace.artifactId === undefined) {
        throw new Error("Agent SDK capture requires a retained ready workspace before outcome packaging.");
      }
      workspaceOutcome = await assembler.captureWorkspaceOutcome({
        startPath: options.startingWorkspacePath,
        finalPath: workspace.path,
        id: workspace.artifactId,
        ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : {
          excludeDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames,
        }),
        ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : {
          respectGitignore: options.workspaceOutcomeRespectsGitignore,
        }),
        ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : {
          omitEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories,
        }),
      }, verifierContext === undefined || options.verifier === undefined
        ? undefined
        : async (projectedPath, outcome) => {
            try {
              const aborted = Symbol("aborted");
              let onAbort: (() => void) | undefined;
              const verifierPromise = Promise.resolve(options.verifier!(verifierContext, outcome, projectedPath));
              const verifierOutcome = await Promise.race([
                verifierPromise,
                new Promise<typeof aborted>((resolvePromise) => {
                  onAbort = () => resolvePromise(aborted);
                  if (verifierContext.signal.aborted) onAbort();
                  else verifierContext.signal.addEventListener("abort", onAbort, { once: true });
                }),
              ]);
              if (onAbort !== undefined) verifierContext.signal.removeEventListener("abort", onAbort);
              if (verifierOutcome === aborted) {
                let graceTimer: NodeJS.Timeout | undefined;
                const settled = await Promise.race([
                  verifierPromise.then(
                    (value) => ({ kind: "result" as const, value }),
                    (error: unknown) => ({ kind: "error" as const, error }),
                  ),
                  new Promise<{ kind: "timed-out" }>((resolvePromise) => {
                    graceTimer = setTimeout(() => resolvePromise({ kind: "timed-out" }), options.shutdownGraceMs ?? 250);
                  }),
                ]);
                if (graceTimer !== undefined) clearTimeout(graceTimer);
                if (settled.kind === "result") verifierResult = settled.value;
                else if (settled.kind === "error") verifierError = settled.error;
                else void verifierPromise.catch(() => undefined);
              } else {
                verifierResult = verifierOutcome;
              }
            } catch (error) {
              verifierError = error;
            }
          });
      return workspaceOutcome;
    })().catch((error: unknown) => {
      workspaceCaptureError = error instanceof Error ? error.message : String(error);
      throw error;
    });
    return workspaceOutcomePromise;
  };

  const coordinatedWorkspace: WorkspaceCoordinator = {
    setup: async (context) => {
      workspace = await options.workspace.setup(context);
      return workspace;
    },
    cleanup: async (context) => {
      if (workspace?.status === "ready") await captureWorkspace();
      await options.workspace.cleanup?.(context);
    },
  };
  const run = createRunIdentity({
    id: definition.run.id,
    taskId: definition.run.task.id,
    modelId: definition.run.model.id,
    harnessId: definition.run.harness.id,
  });
  const attemptIdentity = createAttemptIdentity(
    definition.run.id,
    definition.attempt.number,
    definition.attempt.id,
    definition.attempt.retryOf,
  );
  let attempt: RunAttemptResult;
  try {
    attempt = await executeRunAttempt({
      run,
      assessmentMode: definition.run.assessmentMode,
      attempt: attemptIdentity,
      workspace: coordinatedWorkspace,
      harness: (context) => executeClaudeAgentSdk(context, options.configuration, streamCapture, options.query),
      ...(options.verifier === undefined ? {} : {
        verifier: async (context) => {
          await captureWorkspace(context);
          if (verifierError !== undefined) throw verifierError;
          if (verifierResult === undefined) throw new Error("Agent SDK verifier did not return a result.");
          const result = verifierResult;
          await assembler.writeJsonArtifact({
            id: "verifier",
            source: "ebo-verifier",
            kind: "verifier",
            mediaType: "application/json",
            sharingClass: "restricted",
            relativePath: "verifier.json",
          }, result);
          return {
            status: result.status,
            ...(result.error === undefined ? {} : { error: result.error }),
            evidence: result,
          };
        },
      }),
      evidence: streamCapture,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.maxWallClockMs === undefined ? {} : { maxWallClockMs: options.maxWallClockMs }),
      ...(options.harnessBudgetMs === undefined ? {} : { harnessBudgetMs: options.harnessBudgetMs }),
      ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
    });
  } finally {
    await Promise.allSettled([streamCapture.close(), hookCapture.close()]);
  }
  if (workspace?.status === "ready") await captureWorkspace().catch(() => undefined);

  const stream = streamCapture.report();
  if (await isNonemptyFile(streamCapture.path)) {
    await assembler.registerArtifact({
      id: "session",
      source: "anthropic-agent-sdk",
      kind: "session",
      mediaType: "application/x-ndjson",
      sharingClass: "restricted",
      relativePath: "session.jsonl",
      ...(stream.capabilities.sessionIdentity.status === "available"
        ? { nativeReference: { type: "session", id: stream.capabilities.sessionIdentity.sessionId } }
        : {}),
    });
  }
  if (await isNonemptyFile(hookCapture.path)) {
    await assembler.registerArtifact({
      id: "hooks",
      source: "anthropic-agent-sdk",
      kind: "hook",
      mediaType: "application/x-ndjson",
      sharingClass: "restricted",
      relativePath: "hooks.jsonl",
    });
  }

  const agentSdkEvidence = attempt.record.harness?.evidence as ClaudeAgentSdkAttemptEvidence | undefined;
  if (agentSdkEvidence?.telemetry !== undefined || agentSdkEvidence?.usage !== undefined) {
    await assembler.writeAgentSdkTelemetry({ evidence: agentSdkEvidence, ...(options.traceId === undefined ? {} : { traceId: options.traceId }) });
  }
  const missingEvidence: CaptureMissingEvidence[] = [
    ...(stream.status === "complete" ? [] : [{
      kind: "session-completion",
      reason: attempt.terminal.state === "interrupted" ? "process-interrupted" as const : "not-emitted" as const,
      affects: ["semantic" as const],
    }]),
    ...(workspaceOutcome === undefined && workspaceCaptureError !== undefined ? [{
      kind: "workspace",
      reason: "not-collected" as const,
      affects: ["outcome" as const],
      detail: workspaceCaptureError.slice(0, 4096),
    }] : []),
  ];
  const qualificationOptions = {
    startingWorkspacePath: options.startingWorkspacePath,
    ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : {
      workspaceOutcomeExcludedDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames,
    }),
    ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : {
      workspaceOutcomeRespectsGitignore: options.workspaceOutcomeRespectsGitignore,
    }),
    ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : {
      workspaceOutcomeOmitsEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories,
    }),
    ...(agentSdkEvidence === undefined ? {} : { agentSdkEvidence }),
    hookCapabilities: capabilities,
    expectedHooks,
  };
  const terminal = structuredClone(attempt.terminal);
  if (workspaceOutcome === undefined) delete terminal.workspaceArtifactId;
  const manifest = await assembler.finalize({
    terminal,
    missingEvidence,
    qualification: qualificationOptions,
  });
  const qualification = await qualifyRunBundle(assembler.bundleRoot, qualificationOptions);
  return { attempt, manifest, qualification, stream };
}

async function isNonemptyFile(path: string): Promise<boolean> {
  const size = (await stat(path).catch(() => undefined))?.size;
  return size !== undefined && size > 0;
}

function withPinnedRuntime(
  definition: RunBundleDefinition,
  sdkVersion: string,
  claudeCodeVersion: string,
): RunBundleDefinition {
  const runtime = definition.run.runtime.filter((component) => !(
    component.source === "anthropic" && (component.name === "agent-sdk" || component.name === "agent-cli")
  ));
  runtime.push(
    { source: "anthropic", name: "agent-sdk", version: sdkVersion },
    { source: "anthropic", name: "agent-cli", version: claudeCodeVersion },
  );
  return {
    ...structuredClone(definition),
    run: {
      ...structuredClone(definition.run),
      harness: { ...structuredClone(definition.run.harness), version: sdkVersion },
      runtime,
    },
  };
}
