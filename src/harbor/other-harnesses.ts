import { join, relative } from "node:path";
import { createRunBundleAssembler, qualifyRunBundle } from "../run-bundles.js";
import { createRunIdentity, executeRunAttempt } from "../lifecycle.js";
import { captureOpenHandsAgentServerRun, type OpenHandsAgentServerRunConfiguration } from "../openhands-run.js";
import { DeepSeekNativeCapture, executeDeepSeekHarness, type DeepSeekHarnessConfiguration, type DeepSeekCaptureReport } from "../deepseek-adapter.js";
import { harborStepBundleDefinition, type HarborHarnessConfigurationReferences } from "./harnesses.js";
import type { HarborHarnessStepExecutor, HarborStepExecutorInput } from "./runner.js";

type Common = { configuration: HarborHarnessConfigurationReferences; workspaceOutcome?: { excludeDirectoryNames?: string[]; respectGitignore?: boolean; omitEmptyDirectories?: boolean } };
function definition(input: HarborStepExecutorInput, options: Common, version: string, model: string, provider: string) {
  return harborStepBundleDefinition(input.prepared, input.step, input.stepBundleRoot, {
    harnessId: input.prepared.run.harnessId, harnessVersion: version, modelId: model, provider,
    configurationDigests: Object.fromEntries(Object.entries(options.configuration).map(([k,v]) => [k,v.digest.value])) as Record<keyof HarborHarnessConfigurationReferences, string>,
  });
}
function workspace(input: HarborStepExecutorInput) {
  return { setup: () => ({ status: "ready" as const, path: input.workspacePath, artifactId: "workspace", retained: true }), cleanup: async () => {} };
}
export type OpenHandsHarborExecutorOptions = Common & { native: OpenHandsAgentServerRunConfiguration; provider: string; version: string };
export function createOpenHandsHarborExecutor(options: OpenHandsHarborExecutorOptions): HarborHarnessStepExecutor {
  return async input => {
    const result = await captureOpenHandsAgentServerRun({
      definition: definition(input, options, options.version, options.native.model, options.provider),
      startingWorkspacePath: input.startingWorkspacePath, workspace: workspace(input),
      configuration: { ...options.native, serverWorkspacePath: input.workspacePath,
        startConversation: { ...options.native.startConversation, workspace: { type: "local", working_dir: input.workspacePath } },
        message: { role: "user", content: [{ type: "text", text: input.step.effectiveInstruction }], run: true },
      }, signal: input.signal, maxWallClockMs: input.maxWallClockMs,
      workspaceOutcomeExcludedDirectoryNames: options.workspaceOutcome?.excludeDirectoryNames,
      workspaceOutcomeRespectsGitignore: options.workspaceOutcome?.respectGitignore,
      workspaceOutcomeOmitsEmptyDirectories: options.workspaceOutcome?.omitEmptyDirectories,
    });
    return { bundleLocator: relative(input.prepared.evidence.attemptRoot, join(input.stepBundleRoot, "manifest.json")),
      classification: result.attempt.classification.kind, qualification: result.qualification.status,
      terminal: result.manifest.terminal, nativeSessionId: result.manifest.run.native?.sessionId };
  };
}
export type DeepSeekHarborExecutorOptions = Common & { native: Omit<DeepSeekHarnessConfiguration, "input" | "sessionId"> };
export function createDeepSeekHarborExecutor(options: DeepSeekHarborExecutorOptions): HarborHarnessStepExecutor {
  return async input => {
    const composition = { ...options.native.composition, workspaceCwd: input.workspacePath };
    const def = definition(input, options, composition.runtime.clientVersion, composition.route.model, composition.route.provider);
    const assembler = await createRunBundleAssembler(def);
    const capture = new DeepSeekNativeCapture(join(input.stepBundleRoot, "deepseek/session.jsonl"));
    let report: DeepSeekCaptureReport | undefined;
    let outcome: Awaited<ReturnType<typeof assembler.captureWorkspaceOutcome>> | undefined;
    let outcomeError: string | undefined;
    let flushed = false;
    let harnessSettled = false;
    const excluded = [...new Set([".git", "node_modules", ...(options.workspaceOutcome?.excludeDirectoryNames ?? [])])];
    const attempt = await executeRunAttempt({
      run: createRunIdentity({ id: def.run.id, taskId: def.run.task.id, modelId: def.run.model.id, harnessId: "deepseek-harness" }),
      attempt: def.attempt, assessmentMode: "observational", workspace: workspace(input),
      signal: input.signal, maxWallClockMs: input.maxWallClockMs,
      recordPath: join(input.stepBundleRoot, "attempt.json"),
      harness: async context => {
        try {
          const result = await executeDeepSeekHarness(context, { ...options.native, composition, input: input.step.effectiveInstruction, sessionId: def.attempt.id }, capture);
          report = result.evidence as DeepSeekCaptureReport;
          return result;
        } finally { harnessSettled = true; }
      },
      evidence: { flush: async () => {
        if (flushed) return;
        if (!harnessSettled) { await capture.flush(); return; }
        flushed = true;
        await capture.close();
        if (capture.report().length) await assembler.registerArtifact({ id: "deepseek-session", source: "deepseek-harness-sdk", kind: "session", mediaType: "application/x-ndjson", sharingClass: "restricted", relativePath: "deepseek/session.jsonl", nativeReference: { type: "session", id: def.attempt.id } });
        try { outcome = await assembler.captureWorkspaceOutcome({ startPath: input.startingWorkspacePath, finalPath: input.workspacePath, id: "workspace", ...options.workspaceOutcome, excludeDirectoryNames: excluded }); }
        catch (error) { outcomeError = String(error); }
      } },
    });
    const qualification = { startingWorkspacePath: input.startingWorkspacePath, semanticEvidenceKinds: ["session" as const], relatedSessionIds: report?.relatedSessionIds, workspaceOutcomeExcludedDirectoryNames: excluded,
      workspaceOutcomeRespectsGitignore: options.workspaceOutcome?.respectGitignore, workspaceOutcomeOmitsEmptyDirectories: options.workspaceOutcome?.omitEmptyDirectories };
    const manifest = await assembler.finalize({ terminal: { ...attempt.terminal, ...(outcome ? { workspaceArtifactId: outcome.descriptor.id } : {}) },
      missingEvidence: [{ kind: "telemetry", reason: composition.telemetry.status === "enabled" ? "not-collected" : "unsupported", affects: ["timing-resource"] }, ...(outcomeError ? [{ kind: "workspace", reason: "not-collected" as const, affects: ["outcome" as const], detail: outcomeError }] : [])], qualification });
    const qualified = await qualifyRunBundle(input.stepBundleRoot, qualification);
    return { bundleLocator: relative(input.prepared.evidence.attemptRoot, join(input.stepBundleRoot, "manifest.json")), qualification: qualified.status,
      classification: attempt.classification.kind, terminal: manifest.terminal, nativeSessionId: manifest.run.native?.sessionId };
  };
}
