import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digestBytes, assertNoDuplicateJsonKeys } from "../artifacts.js";
import { resolveBundleConfiguration, type ArtifactReference } from "../contracts.js";
import {
  createClaudeAgentSdkHarborExecutor, createCodexHarborExecutor, createCursorHarborExecutor,
  createPiHarborExecutor, createDeepSeekHarborExecutor, createOpenHandsHarborExecutor,
  type HarborHarnessConfigurationReferences,
} from "./harnesses.js";
import type { DeepSeekRuntimeComposition } from "../deepseek-adapter.js";
import type { OpenHandsAgentServerRunConfiguration } from "../openhands-run.js";
import type { PreparedHarborExecution } from "./execution.js";
import type { HarborHarnessStepExecutor, HarborStepExecution } from "./runner.js";

export type HarborWorkerInput = {
  prepared: PreparedHarborExecution; configuration: HarborHarnessConfigurationReferences;
  configurationRoot: string; instruction: string; stepIndex: number; workspacePath: string;
  outputRoot: string; maxWallClockMs: number;
};
function configuration<T>(root: string, ref: ArtifactReference): T {
  const text = resolveBundleConfiguration(root, ref).toString("utf8");
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text) as T;
}
function processHarnessOptions(input: HarborWorkerInput, model: string, provider: string, limitKeys: string[]) {
  const read = (ref: ArtifactReference) => configuration<Record<string, unknown>>(input.configurationRoot, ref);
  const selected = read(input.configuration.model);
  if (selected.model !== model || selected.provider !== provider || Object.keys(selected).some(k => !["model", "provider"].includes(k))) {
    throw new Error("Model reference must match the model and provider in the native harness configuration.");
  }
  const tools = read(input.configuration.nativeToolPolicy);
  if (tools.source !== "harness" || Object.keys(tools).length !== 1) throw new Error('Process harness tool policy must declare {"source":"harness"}; tools belong to its pinned native configuration.');
  const limits = read(input.configuration.nativeLimits);
  if (Object.entries(limits).some(([key, value]) => !limitKeys.includes(key) || !Number.isSafeInteger(value) || (value as number) < 1)) {
    throw new Error("Unsupported or invalid native process-harness limit.");
  }
  const capture = read(input.configuration.captureProfile);
  if (Object.keys(capture).some(k => k !== "workspaceOutcome")) throw new Error("Process harness capture profile supports workspaceOutcome; telemetry availability is recorded by its native capture.");
  const workspaceOutcome = capture.workspaceOutcome as { excludeDirectoryNames?: string[]; respectGitignore?: boolean; omitEmptyDirectories?: boolean } | undefined;
  if (workspaceOutcome !== undefined && (workspaceOutcome === null || typeof workspaceOutcome !== "object" || Array.isArray(workspaceOutcome)
    || Object.keys(workspaceOutcome).some(k => !["excludeDirectoryNames", "respectGitignore", "omitEmptyDirectories"].includes(k))
    || workspaceOutcome.excludeDirectoryNames !== undefined && (!Array.isArray(workspaceOutcome.excludeDirectoryNames) || workspaceOutcome.excludeDirectoryNames.some(v => typeof v !== "string" || !v || /[/\\]/.test(v)))
    || workspaceOutcome.respectGitignore !== undefined && typeof workspaceOutcome.respectGitignore !== "boolean"
    || workspaceOutcome.omitEmptyDirectories !== undefined && typeof workspaceOutcome.omitEmptyDirectories !== "boolean")) throw new Error("Invalid workspaceOutcome capture policy.");
  return { limits, workspaceOutcome };
}
export function createNativeHarborExecutor(input: HarborWorkerInput): HarborHarnessStepExecutor {
  const options = { studyRoot: input.configurationRoot, configuration: input.configuration };
  switch (input.prepared.run.harnessId) {
    case "claude-agent-sdk": return createClaudeAgentSdkHarborExecutor(options);
    case "codex-app-server": return createCodexHarborExecutor(options);
    case "cursor-sdk": {
      const apiKey = process.env.CURSOR_API_KEY;
      if (!apiKey) throw new Error("CURSOR_API_KEY is required by the selected Cursor condition.");
      return createCursorHarborExecutor({ ...options, apiKey });
    }
    case "pi-sdk": return createPiHarborExecutor(options);
    case "deepseek-harness": {
      const composition = configuration<DeepSeekRuntimeComposition>(input.configurationRoot, input.configuration.harness);
      if (composition.schemaVersion !== "ebo.deepseek-runtime-composition/v1") throw new Error("DeepSeek requires a native runtime composition.");
      const policy = processHarnessOptions(input, composition.route.model, composition.route.provider, ["requestTimeoutMs", "activityTimeoutMs", "shutdownTimeoutMs", "disposeEofGraceMs", "disposeGraceMs"]);
      const env = Object.fromEntries(composition.environment.allowedKeys.filter(k=>process.env[k] !== undefined).map(k=>[k,process.env[k]]));
      return createDeepSeekHarborExecutor({ configuration: input.configuration, workspaceOutcome: policy.workspaceOutcome, native: { composition, env, ...policy.limits } });
    }
    case "openhands-agent-server": {
      const native = configuration<OpenHandsAgentServerRunConfiguration & { version: string; provider: string }>(input.configurationRoot, input.configuration.harness);
      // The server must see this exact container filesystem, not a host workspace lookalike.
      const url = new URL(native.baseUrl);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Harbor OpenHands requires an Agent Server inside the task environment.");
      const policy = processHarnessOptions(input, native.model, native.provider, ["pollIntervalMs", "timeoutMs", "maxReconnects", "reconnectDelayMs", "maxResponseBytes", "maxCaptureBytes"]);
      return createOpenHandsHarborExecutor({ configuration: input.configuration, workspaceOutcome: policy.workspaceOutcome, native: { ...native, ...policy.limits }, version: native.version, provider: native.provider });
    }
    default: throw new Error("Unsupported Harbor harness: " + input.prepared.run.harnessId);
  }
}

/** Executes native capture in the actual Harbor working directory. No task packet translation. */
export async function runHarborWorker(input: HarborWorkerInput, executor?: HarborHarnessStepExecutor): Promise<HarborStepExecution> {
  const outputRoot = resolve(input.outputRoot), workspace = resolve(input.workspacePath);
  const relation = relative(workspace, outputRoot);
  if ((relation !== ".." && !relation.startsWith("../")) || workspace === "/") throw new Error("Worker evidence must be outside the candidate workspace.");
  if (!Number.isSafeInteger(input.maxWallClockMs) || input.maxWallClockMs < 1) throw new Error("Invalid worker budget.");
  const originalStep = input.prepared.steps.find(step => step.index === input.stepIndex);
  if (!originalStep) throw new Error("Worker step is not declared by the frozen task.");
  const digest = digestBytes(Buffer.from(input.instruction));
  if (digest.value !== originalStep.instructionDigest.value) throw new Error("Harbor delivered an instruction different from the frozen instruction.");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(outputRoot, "worker.pid"), String(process.pid), { flag: "wx", mode: 0o600 });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  const baseline = join(outputRoot, "baseline");
  let result: HarborStepExecution;
  try {
    await cp(workspace, baseline, { recursive: true, filter: source => ![".git", "node_modules"].includes(source.split("/").at(-1) ?? "") });
    const prepared = structuredClone(input.prepared);
    prepared.evidence.attemptRoot = outputRoot;
    // Native bundles qualify agent execution. Harbor's independent verifier result
    // is attached by the host afterward, never replaced by a dummy EBO verifier.
    prepared.verifier.requested = false;
    result = await (executor ?? createNativeHarborExecutor(input))({
      prepared, step: { ...originalStep, effectiveInstruction: input.instruction }, workspacePath: workspace,
      startingWorkspacePath: baseline, stepBundleRoot: join(outputRoot, "bundle"),
      signal: abort.signal, maxWallClockMs: input.maxWallClockMs,
    });
  } catch (error) {
    await writeFile(join(outputRoot, "worker-error.json"), JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), { flag: "wx", mode: 0o600 });
    result = { bundleLocator: "bundle/manifest.json", classification: "infrastructure-failure", qualification: "unqualified", terminal: { state: abort.signal.aborted ? "interrupted" : "failed", failureClass: "infrastructure" } };
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  await writeFile(join(outputRoot, "worker-finished.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as HarborWorkerInput;
  const result = await runHarborWorker(input);
  // Capture has drained and worker-finished.json is durable. SDK background
  // handles must not keep Harbor waiting after its native attempt has settled.
  process.exit(result.terminal.state === "completed" ? 0 : 1);
}
