import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, copyFile } from "node:fs/promises";
import { constants, openSync, writeSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { digestMetadata, digestBytes, assertNoDuplicateJsonKeys, writeMetadataAtomically, writeArtifactAtomically } from "../artifacts.js";
import { resolveBundleConfiguration, isSafeArtifactRelativePath, type ArtifactReference } from "../contracts.js";
import type { RunManifest } from "../run-bundles.js";
import type { HarborAdapter } from "./adapter.js";
import type { PreparedHarborExecution } from "./execution.js";
import type { RunQueueV2 } from "./queue.js";
import type { HarborRunSummary, HarborStepExecution } from "./runner.js";
import { HARBOR_TRIAL_SCRIPT } from "./trial-script.js";

export type HarborWorkerRuntime = {
  schemaVersion: "ebo.harbor-worker-runtime/v1";
  archive: ArtifactReference;
  node: string;
  entrypoint: string;
  environmentKeys: string[];
  resources?: ArtifactReference[];
};
export function resolveHarborWorkerRuntime(root: string, reference: ArtifactReference): HarborWorkerRuntime {
  const text = resolveBundleConfiguration(root, reference).toString("utf8");
  assertNoDuplicateJsonKeys(text);
  const value = JSON.parse(text) as HarborWorkerRuntime;
  if (value.schemaVersion !== "ebo.harbor-worker-runtime/v1" || !isSafeArtifactRelativePath(value.node)
    || !isSafeArtifactRelativePath(value.entrypoint) || !Array.isArray(value.environmentKeys)
    || value.environmentKeys.some(k => !/^[A-Z][A-Z0-9_]*$/.test(k))
    || value.environmentKeys.some(k => ["NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "DOCKER_HOST"].includes(k))) {
    throw new Error("Invalid Harbor worker runtime: declare relative node/entrypoint paths and explicit credential/route keys.");
  }
  return value;
}

/** Official Trial + custom-agent extension, not a second EBO step scheduler. */
export async function runOfficialHarborTrial(input: {
  studyRoot: string; prepared: PreparedHarborExecution; queue: RunQueueV2;
  entry: RunQueueV2["entries"][number]; attemptId: string; adapter: HarborAdapter; signal?: AbortSignal;
}): Promise<HarborRunSummary> {
  const { prepared, entry, queue, attemptId } = input;
  if (!queue.execution.workerRef) throw new Error("Docker Harbor runs require an execution.workerRef for the pinned Linux capture runtime.");
  const runtime = resolveHarborWorkerRuntime(input.studyRoot, queue.execution.workerRef);
  const archive = resolveBundleConfiguration(input.studyRoot, runtime.archive, 2 * 1024 * 1024 * 1024);
  const root = prepared.evidence.attemptRoot;
  await mkdir(prepared.evidence.harborDir, { recursive: true, mode: 0o700 });
  try {
  const archivePath = join(root, "harbor", "worker-runtime.tgz");
  await copyFile(join(input.studyRoot, runtime.archive.locator), archivePath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  await chmod(archivePath, 0o600);
  const configuration = { ...entry.configuration, captureProfile: queue.captureProfile };
  const refs = [...Object.values(configuration), ...(runtime.resources ?? [])];
  const configurationFiles: Array<{ hostPath: string; locator: string }> = [];
  for (const ref of refs) {
    const bytes = resolveBundleConfiguration(input.studyRoot, ref);
    const hostPath = join(root, "harbor", "configuration", ref.locator);
    await mkdir(dirname(hostPath), { recursive: true, mode: 0o700 });
    await writeFile(hostPath, bytes, { mode: 0o600 });
    configurationFiles.push({ hostPath, locator: ref.locator });
  }
  const nativeRoot = join(root, "steps");
  await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
  const script = join(prepared.evidence.harborDir, "ebo_harbor_" + createHash("sha256").update(HARBOR_TRIAL_SCRIPT).digest("hex").slice(0,16) + ".py");
  await writeFile(script, HARBOR_TRIAL_SCRIPT, { flag: "wx", mode: 0o600 });
  const request = {
    taskPath: prepared.task.snapshotDirectory, attemptId, trialsDir: join(root, "harbor", "trials"),
    model: entry.modelId, verified: prepared.verifier.requested, budgetMs: prepared.budget.coordinatorWallClockMs,
    build: "ebo-harbor-v1", nativeRoot,
    runtime: { ...runtime, archivePath, archiveDigest: digestBytes(archive).value }, configurationFiles,
    workerInput: { prepared, configuration, configurationRoot: "/tmp/ebo-worker/config" },
  };
  const requestPath = join(prepared.evidence.harborDir, "request.json");
  await writeFile(requestPath, JSON.stringify(request), { flag: "wx", mode: 0o600 });
  const prerequisites = await input.adapter.describePrerequisites();
  const execution = await invokeTrial(prerequisites.python, script, requestPath, input.signal, prepared.budget.coordinatorWallClockMs);
  let result: { exception_info?: unknown; agent_result?: unknown; step_results?: Array<{ step_name: string; exception_info?: unknown; verifier_result?: unknown }>; verifier_result?: { rewards?: Record<string, number> } } = {};
  let resultValid = false;
  try {
    result = JSON.parse(execution.stdout);
    if (!result || typeof result !== "object" || Array.isArray(result) || result.step_results != null && !Array.isArray(result.step_results)) throw new Error("Invalid result envelope");
    resultValid = true;
  } catch { result = { exception_info: "Harbor returned no valid terminal result; retained stdout/stderr are authoritative." }; }
  let trialLock: unknown = null;
  try { trialLock = JSON.parse(await readFile(join(root, "harbor/trials", attemptId, "lock.json"), "utf8")); } catch { /* Explicitly absent on pre-Trial failure. */ }
  const steps: Array<Record<string, unknown>> = [];
  let qualification: "qualified" | "qualified-with-gaps" | "unqualified" = resultValid ? "qualified" : "unqualified";
  for (const step of prepared.steps) {
    let native: HarborStepExecution | undefined;
    try {
      const value = JSON.parse(await readFile(join(nativeRoot, String(step.index), "worker-finished.json"), "utf8"));
      if (value && ["completed", "failed", "stopped", "interrupted"].includes(value.terminal?.state)
        && ["qualified", "qualified-with-gaps", "unqualified"].includes(value.qualification)
        && typeof value.classification === "string" && typeof value.bundleLocator === "string") native = value;
    } catch { /* Missing or damaged worker result is explicit below. */ }
    const officialStep = step.name === null
      ? (result.agent_result ? { step_name: null, agent_result: result.agent_result, verifier_result: result.verifier_result, exception_info: result.exception_info } : undefined)
      : result.step_results?.find(r => r?.step_name === step.name);
    steps.push({ index: step.index, name: step.name, instructionDigest: step.instructionDigest,
      state: native?.terminal.state ?? (officialStep?.exception_info ? "setup-failed" : "skipped"),
      native: native ?? null, harbor: officialStep ?? null });
    if ((!native && officialStep) || (native && !officialStep) || native?.qualification === "unqualified") qualification = "unqualified";
    else if (native?.qualification === "qualified-with-gaps" && qualification === "qualified") qualification = "qualified-with-gaps";
    if (native) try { await attachHarborEvidence(join(nativeRoot, String(step.index), "bundle"), {
      sourceKind: "harbor-task", task: prepared.task, environment: prepared.environment,
      step: { index: step.index, name: step.name }, condition: queue.execution, coordinatorBudget: prepared.budget,
      trialResult: result, trialLock, assessmentMode: prepared.task.assessmentMode,
      queueCondition: { modelId: entry.modelId, harnessId: entry.harnessId, taskId: entry.taskId, trialIndex: entry.trialIndex },
      execution: { code: execution.code, interrupted: execution.interrupted },
    }); } catch (error) { qualification = "unqualified"; steps.at(-1)!.joinError = String(error); }
  }
  const nativeFailure = steps.map(s => s.native as HarborStepExecution | null).find(s => s && s.terminal.state !== "completed");
  const skipped = steps.some(s => s.state === "skipped");
  const stepError = result.step_results?.some(s => s.exception_info);
  const reached = steps.some(s => s.native);
  if (!reached || trialLock === null) qualification = "unqualified";
  const terminal: HarborRunSummary["terminal"] = execution.interrupted
    ? { state: "interrupted", failureClass: "none", stopReason: "external" }
    : nativeFailure ? { state: nativeFailure.terminal.state, failureClass: nativeFailure.terminal.failureClass ?? "none", stopReason: nativeFailure.terminal.stopReason ?? "none" }
    : result.exception_info || execution.code !== 0 || stepError || !reached
      ? { state: "failed", failureClass: "infrastructure", stopReason: "none" }
      : skipped ? { state: "stopped", failureClass: "none", stopReason: "policy" }
      : { state: "completed", failureClass: "none", stopReason: "none" };
  const summary: HarborRunSummary = {
    runId: entry.runId, attemptId, bundlePath: root, taskSourceId: prepared.task.taskSourceId,
    harnessId: entry.harness.id, assessmentMode: prepared.task.assessmentMode,
    environmentProfile: "docker", terminal, classification: execution.interrupted ? "interrupted" : nativeFailure?.classification ?? (terminal.state === "completed" ? (qualification === "unqualified" ? "capture-incomplete" : "completed") : terminal.state === "stopped" ? "policy-stop" : "infrastructure-failure"),
    captureQualification: qualification, completedSteps: steps.filter(s=>s.state === "completed").length,
    skippedSteps: steps.filter(s=>s.state === "skipped" || s.state === "setup-failed").length,
    verifierAggregate: result.verifier_result?.rewards ?? null,
  };
  await mkdir(prepared.evidence.eboDir, { recursive: true });
  await writeArtifactAtomically(prepared.evidence.eboDir, "manifest.json", Buffer.from(JSON.stringify({ schemaVersion: "ebo.harbor-attempt/v1", ...summary, task: prepared.task, steps, harborResult: "harbor/result.json", workerDigest: digestMetadata(runtime) }, null, 2)), undefined, { overwrite: false });
  return summary;
  } catch (error) {
    const summary: HarborRunSummary = {
      runId: entry.runId, attemptId, bundlePath: root, taskSourceId: prepared.task.taskSourceId,
      harnessId: entry.harness.id, assessmentMode: prepared.task.assessmentMode, environmentProfile: "docker",
      terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none" }, classification: "infrastructure-failure",
      captureQualification: "unqualified", completedSteps: 0, skippedSteps: prepared.steps.length, verifierAggregate: null,
    };
    await mkdir(prepared.evidence.eboDir, { recursive: true, mode: 0o700 });
    await writeMetadataAtomically(prepared.evidence.eboDir, "manifest.json", {
      schemaVersion: "ebo.harbor-attempt/v1", ...summary, task: prepared.task, steps: [], error: String(error),
    }, undefined, { overwrite: false });
    return summary;
  }
}

async function attachHarborEvidence(bundle: string, content: unknown): Promise<void> {
  const path = join(bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as RunManifest;
  const bytes = Buffer.from(JSON.stringify({ ...(content as object),
    nativeCapture: { bundleId: manifest.bundleId, runId: manifest.run.id, attemptId: manifest.attempt.id, assessmentMode: manifest.run.assessmentMode },
  }, null, 2) + "\n");
  await writeFile(join(bundle, "harbor-result.json"), bytes, { flag: "wx", mode: 0o600 });
  manifest.evidence.push({ id: "harbor-result", source: "harbor", kind: "diagnostic", authority: "outcome", mediaType: "text/plain", sharingClass: "restricted", relativePath: "harbor-result.json", digest: `sha256:${digestBytes(bytes).value}`, sizeBytes: bytes.length });
  await writeMetadataAtomically(bundle, "manifest.json", manifest);
}

export async function invokeTrial(python: string, script: string, request: string, signal: AbortSignal | undefined, budget: number): Promise<{ stdout: string; stderr: string; code: number | null; interrupted: boolean }> {
  return new Promise((done) => {
    const out = openSync(join(dirname(script), "result.json"), "wx", 0o600);
    const err = openSync(join(dirname(script), "stderr.log"), "wx", 0o600);
    const child = spawn(python, [script, request], { stdio: ["ignore", "pipe", "pipe"], cwd: dirname(script), detached: process.platform !== "win32" });
    let stdout = "", stderr = "", interrupted = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    const stop = () => { if (interrupted) return; interrupted = true; child.kill("SIGTERM"); force = setTimeout(killGroup, 60_000); };
    const timer = setTimeout(stop, Math.min(budget + 60_000, 2_147_483_647));
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const retain = (fd: number, limit: number, append: (text: string) => void) => {
      let retained = 0;
      const decoder = new StringDecoder("utf8");
      return (chunk: Buffer) => {
        const bytes = chunk.subarray(0, Math.max(0, limit - retained));
        try {
          for (let offset = 0; offset < bytes.length;) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            if (written === 0) throw new Error("Harbor evidence write made no progress.");
            offset += written;
          }
          retained += bytes.length;
          append(decoder.write(bytes));
          if (bytes.length < chunk.length) stop();
        } catch { stop(); }
      };
    };
    const retainOut = retain(out, 64 * 1024 * 1024, text => { stdout += text; });
    const retainErr = retain(err, 4 * 1024 * 1024, text => { stderr += text; });
    child.stdout.on("data", retainOut);
    child.stderr.on("data", retainErr);
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; closeSync(out); closeSync(err); clearTimeout(timer); clearTimeout(force); signal?.removeEventListener("abort", stop); };
    child.on("error", error => { retainErr(Buffer.from(String(error))); cleanup(); done({ stdout, stderr, code: 1, interrupted }); });
    child.on("close", code => { if (interrupted) killGroup(); cleanup(); done({ stdout, stderr, code, interrupted }); });
  });
}
