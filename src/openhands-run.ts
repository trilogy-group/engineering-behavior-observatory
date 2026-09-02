import { writeArtifactAtomically } from "./artifacts.js";
import {
  captureOpenHandsAgentServer,
  normalizeOpenHandsCapture,
  OPENHANDS_AGENT_SERVER_VERSION,
  type OpenHandsCapture,
  type OpenHandsCaptureRequest,
  type OpenHandsNativeRecord,
} from "./openhands.js";
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
import type { CapturedNativeRecord, NormalizationResult, NativeEvidenceReference } from "./uniform-events.js";
import { validateUniformEvents } from "./uniform-events.js";
import type { VerifierResult } from "./verifiers.js";
import { openJsonlEvidenceWriter } from "./process-protocol.js";

export type CaptureOpenHandsAgentServerVerifier = (
  context: VerifierExecutionContext,
  workspace: CapturedWorkspaceOutcome,
  workspacePath: string,
) => VerifierResult | Promise<VerifierResult>;

export type OpenHandsAgentServerRunConfiguration = Omit<
  OpenHandsCaptureRequest,
  "runId" | "attemptId" | "startConversation" | "signal" | "onRecord"
> & {
  model: string;
  startConversation: Record<string, unknown>;
  serverWorkspacePath?: string;
};

export type CaptureOpenHandsAgentServerRunOptions = {
  definition: RunBundleDefinition;
  startingWorkspacePath: string;
  workspace: WorkspaceCoordinator;
  configuration: OpenHandsAgentServerRunConfiguration;
  verifier?: CaptureOpenHandsAgentServerVerifier;
  workspaceOutcomeExcludedDirectoryNames?: readonly string[];
  workspaceOutcomeRespectsGitignore?: boolean;
  workspaceOutcomeOmitsEmptyDirectories?: boolean;
  signal?: AbortSignal;
  maxWallClockMs?: number;
  harnessBudgetMs?: number;
  shutdownGraceMs?: number;
};

export type CaptureOpenHandsAgentServerRunResult = {
  attempt: RunAttemptResult;
  manifest: RunManifest;
  qualification: CaptureQualificationReport;
  capture: OpenHandsCapture;
  normalized: NormalizationResult;
};

/** Execute and retain one caller-configured OpenHands Agent Server attempt. */
export async function captureOpenHandsAgentServerRun(
  options: CaptureOpenHandsAgentServerRunOptions,
): Promise<CaptureOpenHandsAgentServerRunResult> {
  if (options.definition.run.model.id !== options.configuration.model) {
    throw new Error("The declared model must match the OpenHands run configuration.");
  }
  const requestModel = openHandsRequestModel(options.configuration.startConversation);
  if (requestModel !== options.configuration.model) {
    throw new Error(`The actual conversation request model must match ${options.configuration.model}; received ${String(requestModel)}.`);
  }
  const definition = withPinnedRuntime(options.definition);
  const assembler = await createRunBundleAssembler(definition);
  const sessionWriter = await openJsonlEvidenceWriter(`${assembler.bundleRoot}/session.jsonl`, { exclusive: true });
  let workspace: WorkspaceExecutionResult | undefined;
  let workspaceOutcome: CapturedWorkspaceOutcome | undefined;
  let workspaceOutcomePromise: Promise<CapturedWorkspaceOutcome> | undefined;
  let verifierResult: VerifierResult | undefined;
  let capture: OpenHandsCapture | undefined;
  let nativeEvidenceWritten = false;
  let captureSettled = false;
  let progressiveSessionId: string | undefined;
  let progressiveWriteError: string | undefined;
  let acceptingRecords = true;
  const progressiveRecords: Array<CapturedNativeRecord<OpenHandsNativeRecord>> = [];
  const workspaceOutcomeExcludedDirectoryNames = [
    ".git",
    ...(options.workspaceOutcomeExcludedDirectoryNames ?? []).filter((name) => name !== ".git"),
  ];

  const captureWorkspace = async (verifierContext?: VerifierExecutionContext): Promise<CapturedWorkspaceOutcome> => {
    if (workspaceOutcome !== undefined) return workspaceOutcome;
    if (workspace?.status !== "ready" || workspace.path === undefined || workspace.artifactId === undefined) {
      throw new Error("OpenHands capture requires a retained ready workspace before outcome packaging.");
    }
    workspaceOutcomePromise ??= assembler.captureWorkspaceOutcome({
      startPath: options.startingWorkspacePath,
      finalPath: workspace.path,
      id: workspace.artifactId,
      excludeDirectoryNames: workspaceOutcomeExcludedDirectoryNames,
      ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : {
        respectGitignore: options.workspaceOutcomeRespectsGitignore,
      }),
      ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : {
        omitEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories,
      }),
    }, verifierContext === undefined || options.verifier === undefined
      ? undefined
      : async (projectedPath, outcome) => {
          verifierResult = await options.verifier!(verifierContext, outcome, projectedPath);
        });
    workspaceOutcome = await workspaceOutcomePromise;
    return workspaceOutcome;
  };

  const writeNativeEvidence = async (): Promise<void> => {
    if (nativeEvidenceWritten) return;
    await sessionWriter.flush();
    if (progressiveWriteError !== undefined) throw new Error(progressiveWriteError);
    if (!captureSettled || sessionWriter.count === 0) return;
    await sessionWriter.close();
    await assembler.registerArtifact({
      id: "session",
      source: "openhands-agent-server",
      kind: "session",
      mediaType: "application/x-ndjson",
      sharingClass: "restricted",
      relativePath: "session.jsonl",
      ...(progressiveSessionId === undefined ? {} : {
        nativeReference: { type: "session", id: progressiveSessionId },
      }),
    });
    if (capture === undefined) {
      nativeEvidenceWritten = true;
      return;
    }
    const hooks = capture.records.filter(({ record }) => record.payload.kind === "HookExecutionEvent");
    if (hooks.length > 0) {
      const hookBytes = Buffer.from(`${hooks.map(({ record }) => JSON.stringify({
        session_id: capture!.conversationId,
        hook_event_name: record.payload.hook_event_type,
        native_record: record,
      })).join("\n")}\n`);
      await writeArtifactAtomically(assembler.bundleRoot, "hooks.jsonl", hookBytes, undefined, { overwrite: false });
      await assembler.registerArtifact({
        id: "hooks",
        source: "openhands-agent-server",
        kind: "hook",
        mediaType: "application/x-ndjson",
        sharingClass: "restricted",
        relativePath: "hooks.jsonl",
      });
    }
    nativeEvidenceWritten = true;
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
  const attempt = await executeRunAttempt({
    run,
    assessmentMode: definition.run.assessmentMode,
    attempt: attemptIdentity,
    workspace: coordinatedWorkspace,
    harness: async ({ signal, registerShutdown }) => {
      if (workspace?.status !== "ready" || workspace.path === undefined) {
        throw new Error("OpenHands run requires a ready workspace path.");
      }
      const { serverWorkspacePath, ...configuration } = options.configuration;
      registerShutdown(async () => {
        if (progressiveSessionId === undefined) return;
        await cleanupOpenHandsConversation(configuration, progressiveSessionId, options.shutdownGraceMs ?? 250);
      });
      try {
        capture = await captureOpenHandsAgentServer({
          ...configuration,
          runId: definition.run.id,
          attemptId: definition.attempt.id,
          signal,
          onRecord: (captured) => {
            if (!acceptingRecords) return;
            if (captured.record.session_id !== undefined) progressiveSessionId = captured.record.session_id;
            progressiveRecords.push(captured);
            void sessionWriter.append(captured.record).catch((error: unknown) => {
              progressiveWriteError ??= error instanceof Error ? error.message : String(error);
            });
          },
          startConversation: {
            ...options.configuration.startConversation,
            workspace: { type: "local", working_dir: serverWorkspacePath ?? workspace.path },
          },
        });
      } finally {
        captureSettled = true;
      }
      if (capture.captureError !== undefined) {
        return {
          status: "failed",
          failureClass: "infrastructure",
          reason: capture.captureError,
          captureError: capture.captureError,
          evidence: capture,
        };
      }
      const status = capture.finalConversation?.execution_status;
      return status === "finished"
        ? {
            status: "completed",
            completionEvidence: capture.finalConversation,
            evidence: capture,
            ...(capture.reconciliation.finalReadError === undefined ? {} : {
              captureError: capture.reconciliation.finalReadError,
            }),
          }
        : { status: "failed", failureClass: "infrastructure", reason: `OpenHands conversation ended as ${String(status)}.`, evidence: capture };
    },
    ...(options.verifier === undefined ? {} : {
      verifier: async (context: VerifierExecutionContext) => {
        await captureWorkspace(context);
        if (verifierResult === undefined) throw new Error("OpenHands verifier did not return a result.");
        await assembler.writeJsonArtifact({
          id: "verifier",
          source: "ebo-verifier",
          kind: "verifier",
          mediaType: "application/json",
          sharingClass: "restricted",
          relativePath: "verifier.json",
        }, verifierResult);
        return {
          status: verifierResult.status,
          ...(verifierResult.error === undefined ? {} : { error: verifierResult.error }),
          evidence: verifierResult,
        };
      },
    }),
    evidence: { flush: writeNativeEvidence },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxWallClockMs === undefined ? {} : { maxWallClockMs: options.maxWallClockMs }),
    ...(options.harnessBudgetMs === undefined ? {} : { harnessBudgetMs: options.harnessBudgetMs }),
    ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
  });
  if (capture === undefined) {
    acceptingRecords = false;
    await sessionWriter.close();
    if (progressiveSessionId === undefined || sessionWriter.count === 0) {
      throw new Error("OpenHands attempt ended before producing identified native capture evidence.");
    }
    capture = interruptedCapture(
      definition.run.id,
      definition.attempt.id,
      progressiveSessionId,
      progressiveRecords.slice(0, sessionWriter.count),
    );
    captureSettled = true;
  }
  await writeNativeEvidence();
  const normalized = await normalizeOpenHandsCapture(capture);
  await validateUniformEvents(normalized.events, {
    resolve: (reference) => resolvesCaptureReference(capture!, reference),
  });
  const terminal = structuredClone(attempt.terminal);
  if (workspaceOutcome === undefined) delete terminal.workspaceArtifactId;
  const missingEvidence: CaptureMissingEvidence[] = [
    {
      kind: "telemetry",
      reason: "unsupported",
      affects: ["timing-resource"],
      detail: "The pinned Agent Server REST/WebSocket boundary does not expose native OpenTelemetry records.",
    },
    {
      kind: "event-log-completeness",
      reason: "not-checked",
      affects: ["semantic"],
      detail: capture.eventLogCompleteness.reason,
    },
    ...(capture.captureError === undefined ? [] : [{
      kind: "agent-server-control",
      reason: "not-collected" as const,
      affects: ["semantic" as const],
      detail: capture.captureError,
    }]),
    ...(capture.reconciliation.finalReadError === undefined ? [] : [{
      kind: "final-rest-events",
      reason: "not-collected" as const,
      affects: ["semantic" as const],
      detail: capture.reconciliation.finalReadError,
    }]),
    ...(capture.reconciliation.transportGaps.length === 0 ? [] : [{
      kind: "websocket-events",
      reason: "not-collected" as const,
      affects: ["semantic" as const],
      detail: `Transport gaps: ${capture.reconciliation.transportGaps.join(", ")}`,
    }]),
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
  };
  const manifest = await assembler.finalize({ terminal, missingEvidence, qualification: qualificationOptions });
  const qualification = await qualifyRunBundle(assembler.bundleRoot, qualificationOptions);
  return { attempt, manifest, qualification, capture, normalized };
}

function resolvesCaptureReference(capture: OpenHandsCapture, reference: NativeEvidenceReference): boolean {
  return capture.records.some(({ reference: base }) => base.artifactId === reference.artifactId
    && (reference.recordLocator === base.recordLocator || reference.recordLocator.startsWith(`${base.recordLocator}#`)));
}

function interruptedCapture(
  runId: string,
  attemptId: string,
  conversationId: string,
  records: readonly CapturedNativeRecord<OpenHandsNativeRecord>[],
): OpenHandsCapture {
  const events = (channel: OpenHandsNativeRecord["channel"]): Record<string, unknown>[] => records
    .filter(({ record }) => record.channel === channel)
    .map(({ record }) => record.payload);
  const ids = (values: readonly Record<string, unknown>[]): string[] => [...new Set(values.flatMap(({ id }) =>
    typeof id === "string" && id !== "" ? [id] : []))];
  const streamedEventIds = ids(events("websocket-event"));
  const finalEventIds = ids(events("rest-event"));
  const streamedSet = new Set(streamedEventIds);
  const finalSet = new Set(finalEventIds);
  return {
    runId,
    attemptId,
    qualification: "qualified-with-gaps",
    records: structuredClone(records),
    conversationId,
    serverInfo: structuredClone(events("server-info")[0] ?? {}),
    captureError: "OpenHands capture was aborted before returning.",
    reconciliation: {
      status: "partial",
      streamedEventIds,
      finalEventIds,
      streamedOnlyEventIds: streamedEventIds.filter((id) => !finalSet.has(id)),
      finalOnlyEventIds: finalEventIds.filter((id) => !streamedSet.has(id)),
      transportGaps: ["capture-aborted"],
    },
    eventLogCompleteness: {
      status: "unknown",
      reason: "REST/WebSocket reconciliation cannot prove complete in-process EventLog delivery.",
    },
  };
}

function withPinnedRuntime(definition: RunBundleDefinition): RunBundleDefinition {
  const runtime = definition.run.runtime.filter(({ name }) => name !== "openhands-agent-server");
  runtime.push({ source: "OpenHands", name: "openhands-agent-server", version: OPENHANDS_AGENT_SERVER_VERSION });
  return {
    ...structuredClone(definition),
    run: {
      ...structuredClone(definition.run),
      harness: { ...structuredClone(definition.run.harness), version: OPENHANDS_AGENT_SERVER_VERSION },
      runtime,
    },
  };
}

function openHandsRequestModel(startConversation: Record<string, unknown>): string | undefined {
  for (const candidate of [startConversation.agent, startConversation.agent_settings]) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const llm = (candidate as Record<string, unknown>).llm;
    if (typeof llm !== "object" || llm === null || Array.isArray(llm)) continue;
    const model = (llm as Record<string, unknown>).model;
    if (typeof model === "string" && model !== "") return model;
  }
  return undefined;
}

async function cleanupOpenHandsConversation(
  configuration: OpenHandsAgentServerRunConfiguration,
  conversationId: string,
  timeoutMs: number,
): Promise<void> {
  const headers = new Headers();
  if (configuration.sessionApiKey !== undefined) headers.set("x-session-api-key", configuration.sessionApiKey);
  const response = await (configuration.fetch ?? globalThis.fetch)(
    new URL(`/api/conversations/${encodeURIComponent(conversationId)}`, configuration.baseUrl),
    { method: "DELETE", headers, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`OpenHands conversation cleanup failed with ${response.status}.`);
  }
}
