import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createHarborAdapter, type HarborAdapter } from "./adapter.js";
import { prepareHarborExecution, type PreparedHarborExecution, type PreparedHarborStep } from "./execution.js";
import { readHarborRunQueue } from "./queue.js";
import { runOfficialHarborTrial } from "./official-trial.js";

export const HARBOR_ATTEMPT_SCHEMA_VERSION = "ebo.harbor-attempt/v1";
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What one native harness loop reports back for one Harbor step. */
export type HarborStepExecution = {
  bundleLocator: string;
  classification: string;
  qualification: "qualified" | "qualified-with-gaps" | "unqualified";
  terminal: { state: "completed" | "failed" | "stopped" | "interrupted"; failureClass?: string; stopReason?: string };
  nativeSessionId?: string;
  error?: string;
};

export type HarborStepExecutorInput = {
  prepared: PreparedHarborExecution;
  step: PreparedHarborStep;
  workspacePath: string;
  startingWorkspacePath: string;
  stepBundleRoot: string;
  signal?: AbortSignal;
  maxWallClockMs?: number;
};

export type HarborHarnessStepExecutor = (input: HarborStepExecutorInput) => Promise<HarborStepExecution>;

export type HarborRunSummary = {
  runId: string;
  attemptId: string;
  bundlePath: string;
  taskSourceId: string;
  harnessId: string;
  assessmentMode: "observational" | "verified";
  environmentProfile: string;
  terminal: { state: "completed" | "failed" | "stopped" | "interrupted"; failureClass: string; stopReason: string };
  classification: string;
  captureQualification: string;
  completedSteps: number;
  skippedSteps: number;
  verifierAggregate: Record<string, number> | null;
};

export type RunHarborQueueEntryOptions = {
  studyRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  attemptId?: string;
  adapter?: HarborAdapter;
  signal?: AbortSignal;
};

export async function runHarborBackedQueueEntry(options: RunHarborQueueEntryOptions): Promise<HarborRunSummary> {
  const queue = await readHarborRunQueue(options.queuePath, options.adapter === undefined
    ? { studyRoot: options.studyRoot }
    : { studyRoot: options.studyRoot, adapter: options.adapter });
  const matches = queue.entries.filter((entry) => entry.runId === options.runId);
  if (matches.length === 0) throw new Error(`Run "${options.runId}" is not in the queue.`);
  if (matches.length > 1) throw new Error(`Run "${options.runId}" matches more than one queue entry.`);
  const entry = matches[0]!;
  if (entry.task.kind !== "harbor-task") {
    throw new Error(`Run "${options.runId}" references a legacy task packet; use the existing v1 harness runner.`);
  }

  const adapter = options.adapter ?? await createHarborAdapter();
  const attemptId = options.attemptId ?? randomUUID();
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("Attempt ID must be one safe path component.");
  const outputRoot = resolve(options.outputRoot);
  const attemptRoot = join(outputRoot, entry.runId, attemptId);
  const fromOutput = relative(outputRoot, attemptRoot);
  if (fromOutput === "" || fromOutput.startsWith("..")) throw new Error("Attempt destination escapes the selected output root.");
  await assertAbsent(attemptRoot);

  // Preflight throws before any attempt evidence exists.
  const prepared = await prepareHarborExecution({
    studyRoot: options.studyRoot,
    entry,
    attemptRoot,
    execution: queue.execution,
    coordinatorWallClockMs: queue.coordinatorBudget.maxWallClockMs,
    adapter,
    signal: options.signal,
  });


  if (prepared.environment.profile !== "smol") throw new Error("Harbor execution now requires an explicitly compiled smol profile; Docker queues are not reinterpreted and local-fs-test is preparation-only.");
  prepared.run.attemptId = attemptId;
  return runOfficialHarborTrial({ studyRoot: options.studyRoot, prepared, queue, entry, attemptId, adapter, signal: options.signal });
}
async function assertAbsent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Attempt destination already exists and is never replaced.");
}
