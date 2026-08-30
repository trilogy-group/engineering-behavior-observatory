import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type RunIdentity = {
  id: string;
  taskId: string;
  modelId: string;
  harnessId: string;
};

export type AttemptIdentity = {
  id: string;
  number: number;
  retryOf?: string;
};

export type LifecycleState = "created" | "setup" | "running" | "verifying" | "cleaning" | "terminal";

export type LifecycleTransition = {
  from: LifecycleState;
  to: LifecycleState;
  at: string;
};

export type LifecycleSnapshot = {
  state: LifecycleState;
  createdAt: string;
  startedAt: string;
  endedAt?: string;
  timestamps: Partial<Record<LifecycleState, string>>;
  transitions: LifecycleTransition[];
};

export type FailureClass = "none" | "infrastructure" | "task";
export type StopReason = "none" | "budget" | "policy";
export type TerminalState = "completed" | "failed" | "stopped" | "interrupted";

export type TerminalRecord = {
  state: TerminalState;
  failureClass: FailureClass;
  stopReason: StopReason;
  workspaceArtifactId?: string;
};

export type AttemptClassificationKind =
  | "completed"
  | "task-failure"
  | "infrastructure-failure"
  | "verifier-error"
  | "budget-stop"
  | "policy-stop"
  | "interrupted"
  | "capture-incomplete";

export type AttemptClassification = {
  kind: AttemptClassificationKind;
  terminal: TerminalRecord;
  reason?: string;
  source?: "runner" | "workspace" | "harness" | "verifier" | "cleanup" | "capture";
  underlying?: AttemptClassificationKind;
};

export type WorkspaceExecutionResult = {
  status?: "ready" | "failed";
  path?: string;
  artifactId?: string;
  digest?: string;
  retained?: boolean;
  evidence?: unknown;
};

export type WorkspaceSetupContext = {
  run: RunIdentity;
  attempt: AttemptIdentity;
  signal: AbortSignal;
};

export type WorkspaceCoordinator = {
  setup: (context: WorkspaceSetupContext) => WorkspaceExecutionResult | Promise<WorkspaceExecutionResult>;
  cleanup?: (context: WorkspaceSetupContext & {
    outcome: TerminalRecord;
    workspace?: WorkspaceExecutionResult;
  }) => void | Promise<void>;
};

export type HarnessExecutionContext = {
  run: RunIdentity;
  attempt: AttemptIdentity;
  signal: AbortSignal;
  budgetMs?: number;
  workspace?: WorkspaceExecutionResult;
};

export type HarnessExecutionResult = {
  status: "completed" | "failed" | "stopped" | "interrupted";
  failureClass?: Exclude<FailureClass, "none">;
  stopReason?: Exclude<StopReason, "none">;
  reason?: string;
  completionEvidence?: unknown;
  evidence?: unknown;
  shutdown?: () => void | Promise<void>;
  shutdownResult?: HarnessShutdownResult;
};

export type HarnessShutdownResult = {
  status: "completed" | "failed" | "timed-out";
  error?: string;
};

export type HarnessExecutor = (
  context: HarnessExecutionContext,
) => HarnessExecutionResult | Promise<HarnessExecutionResult>;

export type VerifierExecutionContext = {
  run: RunIdentity;
  attempt: AttemptIdentity;
  signal: AbortSignal;
  workspace?: WorkspaceExecutionResult;
};

export type VerifierExecutionResult = {
  status: "passed" | "failed" | "error" | "not-run";
  error?: string;
  evidence?: unknown;
};

export type VerifierExecutor = (
  context: VerifierExecutionContext,
) => VerifierExecutionResult | Promise<VerifierExecutionResult>;

export type EvidenceSink = {
  flush?: () => void | Promise<void>;
};

export type RunAttemptOptions = {
  run: RunIdentity;
  attempt?: AttemptIdentity;
  workspace: WorkspaceCoordinator;
  harness: HarnessExecutor;
  verifier?: VerifierExecutor;
  maxWallClockMs?: number;
  harnessBudgetMs?: number;
  signal?: AbortSignal;
  evidence?: EvidenceSink;
  recordPath?: string;
  now?: () => string;
  shutdownGraceMs?: number;
};

export type AttemptRecord = {
  schemaVersion: "ebo.attempt/v1";
  run: RunIdentity;
  attempt: AttemptIdentity;
  lifecycle: LifecycleSnapshot;
  terminal?: TerminalRecord;
  classification?: AttemptClassification;
  workspace?: WorkspaceExecutionResult;
  harness?: HarnessExecutionResult;
  verifier?: VerifierExecutionResult;
  cleanup?: { status: "completed" | "failed"; error?: string };
  capture?: { status: "complete" | "incomplete"; error?: string };
  persistence?: { status: "complete" | "incomplete"; error?: string };
  partial: boolean;
};

export type RunAttemptResult = {
  run: RunIdentity;
  attempt: AttemptIdentity;
  record: AttemptRecord;
  terminal: TerminalRecord;
  classification: AttemptClassification;
};

export class InvalidLifecycleTransitionError extends Error {
  public constructor(from: LifecycleState, to: LifecycleState) {
    super(`Invalid lifecycle transition from "${from}" to "${to}".`);
    this.name = "InvalidLifecycleTransitionError";
  }
}

const ALLOWED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  created: ["setup", "cleaning"],
  setup: ["running", "cleaning"],
  running: ["verifying", "cleaning"],
  verifying: ["cleaning"],
  cleaning: ["terminal"],
  terminal: [],
};

export function createRunIdentity(input: {
  id?: string;
  taskId: string;
  modelId: string;
  harnessId: string;
}): RunIdentity {
  const run: RunIdentity = {
    id: input.id ?? randomUUID(),
    taskId: input.taskId,
    modelId: input.modelId,
    harnessId: input.harnessId,
  };
  assertIdentity(run.id, "Run ID");
  assertIdentity(run.taskId, "Task ID");
  assertIdentity(run.modelId, "Model ID");
  assertIdentity(run.harnessId, "Harness ID");
  return run;
}

export function createAttemptIdentity(
  runId: string,
  number = 1,
  id: string = randomUUID(),
  retryOf?: string,
): AttemptIdentity {
  assertIdentity(runId, "Run ID");
  assertIdentity(id, "Attempt ID");
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Attempt number must be a positive safe integer.");
  if (retryOf !== undefined) {
    assertIdentity(retryOf, "Retry attempt ID");
    if (retryOf === id) throw new Error("An attempt cannot retry itself.");
    if (number < 2) throw new Error("A retry attempt must have number 2 or greater.");
  } else if (number > 1) {
    throw new Error("Attempt numbers greater than 1 require retryOf.");
  }
  return { id, number, ...(retryOf === undefined ? {} : { retryOf }) };
}

export function retryAttempt(previous: AttemptIdentity | Pick<AttemptRecord, "attempt">, id: string = randomUUID()): AttemptIdentity {
  const identity = "attempt" in previous ? previous.attempt : previous;
  if (!Number.isSafeInteger(identity.number) || identity.number < 1) {
    throw new Error("Previous attempt number must be a positive safe integer.");
  }
  return createAttemptIdentity("retry", identity.number + 1, id, identity.id);
}

export const createRetryAttempt = retryAttempt;

export class LifecycleController {
  private readonly transitions: LifecycleTransition[] = [];
  private readonly timestamps: Partial<Record<LifecycleState, string>>;
  private current: LifecycleState = "created";
  private readonly createdAt: string;
  private endedAt: string | undefined;

  public constructor(private readonly now: () => string = () => new Date().toISOString()) {
    this.createdAt = this.now();
    this.timestamps = { created: this.createdAt };
  }

  public get state(): LifecycleState {
    return this.current;
  }

  public transition(to: LifecycleState, at = this.now()): LifecycleSnapshot {
    if (!ALLOWED_TRANSITIONS[this.current].includes(to)) {
      throw new InvalidLifecycleTransitionError(this.current, to);
    }
    this.transitions.push({ from: this.current, to, at });
    this.current = to;
    this.timestamps[to] = at;
    if (to === "terminal") this.endedAt = at;
    return this.snapshot();
  }

  public snapshot(): LifecycleSnapshot {
    return {
      state: this.current,
      createdAt: this.createdAt,
      startedAt: this.timestamps.setup ?? this.createdAt,
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
      timestamps: { ...this.timestamps },
      transitions: this.transitions.map((transition) => ({ ...transition })),
    };
  }
}

export class RunLifecycle extends LifecycleController {}

export class RunOrchestrator {
  public async run(options: RunAttemptOptions): Promise<RunAttemptResult> {
    return executeRunAttempt(options);
  }
}

export async function executeRunAttempt(options: RunAttemptOptions): Promise<RunAttemptResult> {
  validateOptions(options);
  const now = options.now ?? (() => new Date().toISOString());
  const attempt = options.attempt ?? createAttemptIdentity(options.run.id);
  const lifecycle = new LifecycleController(now);
  const controller = new AbortController();
  const executionStartedAt = Date.now();
  const record: AttemptRecord = {
    schemaVersion: "ebo.attempt/v1",
    run: structuredClone(options.run),
    attempt: structuredClone(attempt),
    lifecycle: lifecycle.snapshot(),
    partial: true,
  };
  if (options.evidence?.flush === undefined) {
    record.capture = { status: "incomplete", error: "Evidence flush boundary is unavailable." };
  }
  let persistenceError: string | undefined;
  const persist = async (): Promise<void> => {
    record.lifecycle = lifecycle.snapshot();
    if (options.recordPath === undefined) return;
    try {
      await writeAttemptRecord(options.recordPath, record);
      record.persistence = { status: "complete" };
    } catch (error) {
      persistenceError ??= errorMessage(error);
      record.persistence = { status: "incomplete", error: persistenceError };
    }
  };
  const flush = async (): Promise<void> => {
    try {
      if (options.evidence?.flush !== undefined) {
        const evidenceFlush = Promise.resolve(options.evidence.flush());
        const outcome = await Promise.race([
          evidenceFlush.then(() => "complete" as const),
          abortPromise.then(() => "aborted" as const),
        ]);
        if (outcome === "aborted") {
          await settle(evidenceFlush, options.shutdownGraceMs ?? 250);
          throw new Error("Evidence flush interrupted.");
        }
      }
    } catch (error) {
      record.capture = { status: "incomplete", error: errorMessage(error) };
    }
    await persist();
  };
  let abortCause: "interrupted" | "budget" | undefined;
  const externalAbort = () => {
    abortCause ??= "interrupted";
    controller.abort("interrupted");
  };
  if (options.signal?.aborted) externalAbort();
  else options.signal?.addEventListener("abort", externalAbort, { once: true });
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetExpired: "coordinator" | "harness" | undefined;
  let harnessResult: HarnessExecutionResult | undefined;
  let workspace: WorkspaceExecutionResult | undefined;
  let classification: AttemptClassification | undefined;
  let cleanupStatus: AttemptRecord["cleanup"];
  const abortPromise = new Promise<"aborted">((resolveAbort) => {
    if (controller.signal.aborted) resolveAbort("aborted");
    else controller.signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true });
  });
  if (options.maxWallClockMs !== undefined) {
    budgetTimer = setTimeout(() => {
      abortCause ??= "budget";
      budgetExpired = "coordinator";
      controller.abort("budget");
    }, options.maxWallClockMs);
  }
  const markCoordinatorBudgetIfExpired = () => {
    if (options.maxWallClockMs !== undefined && Date.now() - executionStartedAt >= options.maxWallClockMs) {
      abortCause ??= "budget";
      budgetExpired = "coordinator";
      controller.abort("budget");
    }
  };

  try {
    await flush();
    lifecycle.transition("setup");
    await persist();
    try {
      const setupPromise = Promise.resolve(options.workspace.setup({ run: options.run, attempt, signal: controller.signal }));
      const setupOutcome = await Promise.race([
        setupPromise.then((value) => ({ kind: "result" as const, value })),
        abortPromise.then((value) => ({ kind: value })),
      ]);
      if (setupOutcome.kind === "aborted" || controller.signal.aborted) {
        const settledWorkspace = await settle(setupPromise, options.shutdownGraceMs ?? 250);
        if (settledWorkspace !== undefined) {
          workspace = snapshotWorkspace(settledWorkspace);
          record.workspace = snapshotWorkspace(workspace);
        }
        classification = abortClassification(abortCause, budgetExpired);
      } else {
        workspace = snapshotWorkspace(setupOutcome.value);
        record.workspace = snapshotWorkspace(workspace);
        if (workspace.status === "failed") {
          classification = infrastructureClassification("Workspace setup failed.", "workspace", workspace.artifactId);
        }
      }
    } catch (error) {
      classification = controller.signal.aborted
        ? abortClassification(abortCause, budgetExpired, errorMessage(error))
        : infrastructureClassification(errorMessage(error), "workspace");
    }
    markCoordinatorBudgetIfExpired();
    if (classification === undefined && controller.signal.aborted) {
      classification = abortClassification(abortCause, budgetExpired);
    }
    await flush();

    if (classification === undefined) {
      lifecycle.transition("running");
      await persist();
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const installBudget = (milliseconds: number | undefined) => {
        if (milliseconds === undefined) return;
        const timer = setTimeout(() => {
          abortCause ??= "budget";
          budgetExpired ??= "harness";
          controller.abort("budget");
        }, milliseconds);
        timers.push(timer);
      };
      installBudget(options.harnessBudgetMs);
      const harnessStartedAt = Date.now();
      let harnessPromise: Promise<HarnessExecutionResult>;
      try {
        harnessPromise = Promise.resolve(options.harness({
          run: options.run,
          attempt,
          signal: controller.signal,
          ...(options.harnessBudgetMs === undefined ? {} : { budgetMs: options.harnessBudgetMs }),
          ...(workspace === undefined ? {} : { workspace: snapshotWorkspace(workspace) }),
        }));
      } catch (error) {
        harnessPromise = Promise.reject(error);
      }
      if (options.harnessBudgetMs !== undefined && Date.now() - harnessStartedAt >= options.harnessBudgetMs) {
        budgetExpired ??= "harness";
        controller.abort("budget");
      }
      markCoordinatorBudgetIfExpired();
      let outcome: { kind: "result"; value: HarnessExecutionResult } | { kind: "aborted" } | undefined;
      try {
        outcome = await Promise.race([
          harnessPromise.then((value) => ({ kind: "result" as const, value })),
          abortPromise.then((value) => ({ kind: value })),
        ]);
      } catch (error) {
        classification = controller.signal.aborted
          ? abortClassification(abortCause, budgetExpired, errorMessage(error))
          : infrastructureClassification(errorMessage(error), "harness", workspace?.artifactId);
      } finally {
        for (const timer of timers) clearTimeout(timer);
      }
      if (outcome !== undefined && (outcome.kind === "aborted" || controller.signal.aborted)) {
        if (outcome.kind === "result") {
          harnessResult = outcome.value;
          record.harness = durableHarnessResult(outcome.value);
        }
        const settledHarness = await settle(harnessPromise, options.shutdownGraceMs ?? 250);
        if (settledHarness !== undefined && harnessResult === undefined) {
          harnessResult = settledHarness;
          record.harness = durableHarnessResult(settledHarness);
        }
        classification = abortClassification(abortCause, budgetExpired);
        const shutdownResult = await shutdownHarness(harnessResult, options.shutdownGraceMs ?? 250);
        if (harnessResult !== undefined && shutdownResult !== undefined) {
          harnessResult = { ...harnessResult, shutdownResult };
          record.harness = durableHarnessResult(harnessResult);
        }
      } else if (outcome?.kind === "result") {
        harnessResult = outcome.value;
        record.harness = durableHarnessResult(harnessResult);
        classification = classifyHarness(harnessResult, workspace?.artifactId);
        if (classification === undefined && harnessResult.status === "completed") {
          lifecycle.transition("verifying");
          await persist();
          if (options.verifier === undefined) {
            record.verifier = { status: "not-run" };
            classification = infrastructureClassification("Verifier did not run.", "verifier", workspace?.artifactId);
          } else {
            try {
              const verifierPromise = Promise.resolve(options.verifier({
                run: options.run,
                attempt,
                signal: controller.signal,
                ...(workspace === undefined ? {} : { workspace: snapshotWorkspace(workspace) }),
              }));
              const verifierOutcome = await Promise.race([
                verifierPromise.then((value) => ({ kind: "result" as const, value })),
                abortPromise.then((value) => ({ kind: value })),
              ]);
              if (verifierOutcome.kind === "aborted" || controller.signal.aborted) {
                if (verifierOutcome.kind === "result") record.verifier = verifierOutcome.value;
                const settledVerifier = await settle(verifierPromise, options.shutdownGraceMs ?? 250);
                if (settledVerifier !== undefined && record.verifier === undefined) record.verifier = settledVerifier;
                classification = abortClassification(abortCause, budgetExpired);
              } else {
                record.verifier = verifierOutcome.value;
                classification = classifyVerifier(verifierOutcome.value, workspace);
              }
            } catch (error) {
              record.verifier = { status: "error", error: errorMessage(error) };
              classification = controller.signal.aborted
                ? abortClassification(abortCause, budgetExpired, errorMessage(error))
                : verifierErrorClassification(errorMessage(error), workspace?.artifactId);
            }
          }
        }
      }
      if (harnessResult !== undefined) record.harness = durableHarnessResult(harnessResult);
      await flush();
    }
  } catch (error) {
    classification ??= infrastructureClassification(errorMessage(error), "runner", workspace?.artifactId);
  } finally {
    if (lifecycle.state !== "cleaning" && lifecycle.state !== "terminal") {
      lifecycle.transition("cleaning");
      await persist();
    }
    try {
      await options.workspace.cleanup?.({
        run: options.run,
        attempt,
        signal: controller.signal,
        outcome: classification?.terminal ?? infrastructureClassification("Run did not produce a terminal outcome.", "runner").terminal,
        ...(workspace === undefined ? {} : { workspace: snapshotWorkspace(workspace) }),
      });
      cleanupStatus = { status: "completed" };
    } catch (error) {
      cleanupStatus = { status: "failed", error: errorMessage(error) };
      if (classification === undefined || classification.kind === "completed") {
        classification = infrastructureClassification(errorMessage(error), "cleanup", workspace?.artifactId);
      }
    }
    record.cleanup = cleanupStatus;
    await flush();
    if (record.capture?.status !== "incomplete" && options.evidence?.flush !== undefined) {
      record.capture = { status: "complete" };
    }
    if (budgetExpired !== undefined && classification?.kind === "completed") {
      classification = abortClassification(abortCause, budgetExpired);
    }
    if (controller.signal.aborted && classification?.kind === "completed") {
      classification = abortClassification(abortCause, budgetExpired);
    }
    if (persistenceError !== undefined && classification?.kind === "completed") {
      classification = infrastructureClassification(persistenceError, "runner", workspace?.artifactId);
    }
    if (record.capture?.status === "incomplete" && classification !== undefined && classification.kind !== "capture-incomplete") {
      classification = {
        kind: "capture-incomplete",
        terminal: classification.terminal,
        reason: record.capture.error,
        source: "capture",
        underlying: classification.kind,
      };
    }
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    lifecycle.transition("terminal");
    classification ??= infrastructureClassification("Run did not produce a terminal outcome.", "runner", workspace?.artifactId);
    record.classification = classification;
    record.terminal = classification.terminal;
    record.partial = classificationUnderlyingKind(classification) !== "completed";
    const persistenceBeforeTerminal = persistenceError;
    await persist();
    if (persistenceError !== undefined && persistenceBeforeTerminal === undefined
        && classificationUnderlyingKind(classification) === "completed") {
      const failedPersistence = infrastructureClassification(persistenceError, "runner", workspace?.artifactId);
      classification = record.capture?.status === "incomplete"
        ? { ...failedPersistence, kind: "capture-incomplete", source: "capture", underlying: failedPersistence.kind }
        : failedPersistence;
      record.classification = classification;
      record.terminal = classification.terminal;
      record.partial = true;
      // The second write may still fail, but the returned record retains the
      // persistence failure rather than reporting an unverified completion.
      await persist();
    }
    options.signal?.removeEventListener("abort", externalAbort);
  }

  return {
    run: structuredClone(options.run),
    attempt: structuredClone(attempt),
    record: structuredClone(record),
    terminal: structuredClone(record.terminal!),
    classification: structuredClone(record.classification!),
  };
}

export const runAttempt = executeRunAttempt;
export const executeRun = executeRunAttempt;

export async function writeAttemptRecord(path: string, record: AttemptRecord): Promise<void> {
  if (path.trim() === "") throw new Error("Attempt record path is required.");
  assertRecord(record);
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, destination);
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readAttemptRecord(destination);
      if (existing.run.id !== record.run.id || existing.attempt.id !== record.attempt.id) {
        throw new Error(`Attempt record "${path}" already belongs to another attempt.`);
      }
      await rename(temporary, destination);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readAttemptRecord(path: string): Promise<AttemptRecord> {
  const bytes = await readFile(resolve(path));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  assertRecord(value);
  return value;
}

function validateOptions(options: RunAttemptOptions): void {
  createRunIdentity({
    id: options.run.id,
    taskId: options.run.taskId,
    modelId: options.run.modelId,
    harnessId: options.run.harnessId,
  });
  if (options.attempt !== undefined) {
    createAttemptIdentity(options.run.id, options.attempt.number, options.attempt.id, options.attempt.retryOf);
  }
  if (!Number.isSafeInteger(options.maxWallClockMs) && options.maxWallClockMs !== undefined) {
    throw new Error("Coordinator wall-clock budget must be a positive safe integer.");
  }
  if (options.maxWallClockMs !== undefined && options.maxWallClockMs < 1) {
    throw new Error("Coordinator wall-clock budget must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(options.harnessBudgetMs) && options.harnessBudgetMs !== undefined) {
    throw new Error("Harness budget must be a positive safe integer.");
  }
  if (options.harnessBudgetMs !== undefined && options.harnessBudgetMs < 1) {
    throw new Error("Harness budget must be a positive safe integer.");
  }
}

function classifyHarness(
  result: HarnessExecutionResult,
  workspaceArtifactId: string | undefined,
): AttemptClassification | undefined {
  switch (result.status) {
    case "completed":
      return undefined;
    case "failed":
      return infrastructureClassification(
        result.failureClass === "task"
          ? result.reason ?? "Harness reported task failure without verifier evidence."
          : result.reason ?? "Harness failed.",
        "harness",
        workspaceArtifactId,
      );
    case "stopped":
      if (result.stopReason === "policy") return policyClassification(result.reason);
      if (result.stopReason === "budget") return budgetClassification("harness", result.reason);
      return infrastructureClassification("Harness stopped without an explicit stop reason.", "harness", workspaceArtifactId);
    case "interrupted":
      return interruptedClassification(result.reason);
  }
}

function classifyVerifier(result: VerifierExecutionResult, workspace: WorkspaceExecutionResult | undefined): AttemptClassification {
  switch (result.status) {
    case "passed":
      return completedClassification(workspace);
    case "failed":
      return taskClassification(result.error ?? "Verifier reported task failure.", workspace, "verifier");
    case "error":
      return verifierErrorClassification(result.error ?? "Verifier failed to execute.", workspace?.artifactId);
    case "not-run":
      return infrastructureClassification("Verifier did not run.", "verifier", workspace?.artifactId);
  }
}

function completedClassification(workspace: WorkspaceExecutionResult | undefined): AttemptClassification {
  if (workspace === undefined || workspace.status !== "ready" || workspace.retained === false
      || workspace.artifactId === undefined) {
    return infrastructureClassification("Completed run requires a retained workspace artifact.", "workspace", workspace?.artifactId);
  }
  return {
    kind: "completed",
    terminal: { state: "completed", failureClass: "none", stopReason: "none", workspaceArtifactId: workspace.artifactId },
    source: "runner",
  };
}

function taskClassification(
  reason: string,
  workspace: WorkspaceExecutionResult | undefined,
  source: AttemptClassification["source"],
): AttemptClassification {
  if (workspace === undefined || workspace.status !== "ready" || workspace.retained === false
      || workspace.artifactId === undefined) {
    return infrastructureClassification("Task failure requires a retained workspace artifact.", "workspace", workspace?.artifactId);
  }
  return {
    kind: "task-failure",
    terminal: { state: "failed", failureClass: "task", stopReason: "none", workspaceArtifactId: workspace.artifactId },
    reason,
    source,
  };
}

function infrastructureClassification(
  reason: string,
  source: AttemptClassification["source"],
  workspaceArtifactId?: string,
): AttemptClassification {
  return {
    kind: source === "verifier" ? "verifier-error" : "infrastructure-failure",
    terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none", ...(workspaceArtifactId === undefined ? {} : { workspaceArtifactId }) },
    reason,
    source,
  };
}

function verifierErrorClassification(reason: string, workspaceArtifactId?: string): AttemptClassification {
  return {
    kind: "verifier-error",
    terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none", ...(workspaceArtifactId === undefined ? {} : { workspaceArtifactId }) },
    reason,
    source: "verifier",
  };
}

function budgetClassification(source: "coordinator" | "harness", reason?: string): AttemptClassification {
  return {
    kind: "budget-stop",
    terminal: { state: "stopped", failureClass: "none", stopReason: "budget" },
    ...(reason === undefined ? {} : { reason }),
    source: source === "harness" ? "harness" : "runner",
  };
}

function policyClassification(reason?: string): AttemptClassification {
  return {
    kind: "policy-stop",
    terminal: { state: "stopped", failureClass: "none", stopReason: "policy" },
    ...(reason === undefined ? {} : { reason }),
    source: "harness",
  };
}

function interruptedClassification(reason?: string): AttemptClassification {
  return {
    kind: "interrupted",
    terminal: { state: "interrupted", failureClass: "infrastructure", stopReason: "none" },
    ...(reason === undefined ? {} : { reason }),
    source: "runner",
  };
}

function abortClassification(
  cause: "interrupted" | "budget" | undefined,
  budget: "coordinator" | "harness" | undefined,
  reason?: string,
): AttemptClassification {
  return cause === "interrupted"
    ? interruptedClassification(reason)
    : budgetClassification(budget ?? "coordinator", reason);
}

function classificationUnderlyingKind(classification: AttemptClassification): AttemptClassificationKind {
  return classification.kind === "capture-incomplete"
    ? classification.underlying ?? classification.kind
    : classification.kind;
}

function snapshotWorkspace(workspace: WorkspaceExecutionResult): WorkspaceExecutionResult {
  return {
    ...workspace,
    ...(workspace.evidence === undefined ? {} : { evidence: structuredClone(workspace.evidence) }),
  };
}

async function shutdownHarness(
  result: HarnessExecutionResult | undefined,
  graceMs: number,
): Promise<HarnessShutdownResult | undefined> {
  if (result?.shutdown === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const shutdown = Promise.resolve(result.shutdown());
    const settled = await Promise.race([
      shutdown.then(() => ({ status: "completed" as const })),
      new Promise<HarnessShutdownResult>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ status: "timed-out", error: "Harness shutdown exceeded its grace period." }), graceMs);
      }),
    ]);
    return settled;
  } catch (error) {
    return { status: "failed", error: errorMessage(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function durableHarnessResult(result: HarnessExecutionResult): HarnessExecutionResult {
  const { shutdown: _shutdown, ...durable } = result;
  return durable;
}

async function settle<T>(promise: Promise<T>, graceMs: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolvePromise) => setTimeout(resolvePromise, graceMs)),
  ]);
}

function assertIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "" || [...value].length > 256) {
    throw new Error(`${label} must be a non-empty identifier of at most 256 characters.`);
  }
}

function assertRecord(value: unknown): asserts value is AttemptRecord {
  if (!isRecord(value)) {
    throw new Error("Attempt record must be a JSON object.");
  }
  if (value.schemaVersion !== "ebo.attempt/v1") throw new Error("Attempt record schemaVersion is invalid.");
  const run = value.run;
  if (!isRecord(run)) throw new Error("Attempt record run is invalid.");
  assertIdentityValue(run.id, "Run ID");
  assertIdentityValue(run.taskId, "Task ID");
  assertIdentityValue(run.modelId, "Model ID");
  assertIdentityValue(run.harnessId, "Harness ID");
  const attempt = value.attempt;
  if (!isRecord(attempt)) throw new Error("Attempt record attempt is invalid.");
  assertIdentityValue(attempt.id, "Attempt ID");
  const attemptNumber = typeof attempt.number === "number" ? attempt.number : NaN;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("Attempt number is invalid.");
  if (attempt.retryOf !== undefined) assertIdentityValue(attempt.retryOf, "Retry attempt ID");
  if ((attemptNumber > 1) !== (attempt.retryOf !== undefined)) throw new Error("Attempt retry lineage is invalid.");
  if (attempt.retryOf === attempt.id) throw new Error("Attempt retry lineage is self-referential.");
  const lifecycle = value.lifecycle;
  if (!isRecord(lifecycle)) throw new Error("Attempt record lifecycle is invalid.");
  if (!isLifecycleState(lifecycle.state)) throw new Error("Attempt lifecycle state is invalid.");
  assertTimestampValue(lifecycle.createdAt, "Lifecycle createdAt");
  assertTimestampValue(lifecycle.startedAt, "Lifecycle startedAt");
  if (lifecycle.endedAt !== undefined) assertTimestampValue(lifecycle.endedAt, "Lifecycle endedAt");
  if (!isRecord(lifecycle.timestamps)) throw new Error("Lifecycle timestamps are invalid.");
  if (!Array.isArray(lifecycle.transitions)) throw new Error("Lifecycle transitions are invalid.");
  let state: LifecycleState = "created";
  for (const transition of lifecycle.transitions) {
    if (!isRecord(transition) || !isLifecycleState(transition.from) || !isLifecycleState(transition.to)) {
      throw new Error("Lifecycle transition is invalid.");
    }
    assertTimestampValue(transition.at, "Lifecycle transition timestamp");
    if (transition.from !== state || !ALLOWED_TRANSITIONS[state].includes(transition.to)) {
      throw new Error("Lifecycle transition sequence is invalid.");
    }
    state = transition.to;
  }
  if (state !== lifecycle.state) throw new Error("Lifecycle state does not match its transitions.");
  if (typeof value.partial !== "boolean") throw new Error("Attempt record partial state is invalid.");
  if (value.terminal !== undefined) assertTerminalRecord(value.terminal);
  if ((value.terminal === undefined) !== (value.classification === undefined)) {
    throw new Error("Attempt terminal and classification records must be paired.");
  }
  if (lifecycle.state === "terminal" && value.terminal === undefined) {
    throw new Error("Terminal attempt records require terminal and classification outcomes.");
  }
  if (value.terminal !== undefined && lifecycle.state !== "terminal") {
    throw new Error("Terminal attempt records must have terminal lifecycle state.");
  }
  if (value.classification !== undefined) {
    if (!isRecord(value.classification) || !isClassificationKind(value.classification.kind)) {
      throw new Error("Attempt classification is invalid.");
    }
    assertTerminalRecord(value.classification.terminal);
    if (!sameTerminalRecord(value.terminal, value.classification.terminal)) {
      throw new Error("Attempt terminal and classification records disagree.");
    }
  }
  for (const field of ["capture", "persistence"] as const) {
    const status = value[field];
    if (status !== undefined) {
      if (!isRecord(status) || !["complete", "incomplete"].includes(String(status.status))) {
        throw new Error(`Attempt ${field} status is invalid.`);
      }
      if (status.error !== undefined) assertTimestampValue(status.error, `Attempt ${field} error`);
    }
  }
  if (value.cleanup !== undefined) {
    if (!isRecord(value.cleanup) || !["completed", "failed"].includes(String(value.cleanup.status))) {
      throw new Error("Attempt cleanup status is invalid.");
    }
    if (value.cleanup.error !== undefined) assertTimestampValue(value.cleanup.error, "Attempt cleanup error");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertIdentityValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  assertIdentity(value, label);
}

function assertTimestampValue(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is invalid.`);
}

function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && Object.hasOwn(ALLOWED_TRANSITIONS, value);
}

function isClassificationKind(value: unknown): value is AttemptClassificationKind {
  return ["completed", "task-failure", "infrastructure-failure", "verifier-error", "budget-stop", "policy-stop", "interrupted", "capture-incomplete"].includes(String(value));
}

function assertTerminalRecord(value: unknown): asserts value is TerminalRecord {
  if (!isRecord(value) || !["completed", "failed", "stopped", "interrupted"].includes(String(value.state))) {
    throw new Error("Attempt terminal record is invalid.");
  }
  if (!["none", "infrastructure", "task"].includes(String(value.failureClass))) {
    throw new Error("Attempt terminal failure class is invalid.");
  }
  if (!["none", "budget", "policy"].includes(String(value.stopReason))) {
    throw new Error("Attempt terminal stop reason is invalid.");
  }
  if (value.workspaceArtifactId !== undefined) assertIdentityValue(value.workspaceArtifactId, "Workspace artifact ID");
  if (value.state === "completed" && (value.failureClass !== "none" || value.stopReason !== "none" || value.workspaceArtifactId === undefined)) {
    throw new Error("Completed terminal record is incomplete.");
  }
  if (value.state === "failed" && (value.failureClass !== "infrastructure" && value.failureClass !== "task" || value.stopReason !== "none")) {
    throw new Error("Failed terminal record is invalid.");
  }
  if (value.state === "stopped" && (value.failureClass !== "none" || (value.stopReason !== "budget" && value.stopReason !== "policy"))) {
    throw new Error("Stopped terminal record is invalid.");
  }
  if (value.state === "interrupted" && (value.failureClass !== "infrastructure" || value.stopReason !== "none")) {
    throw new Error("Interrupted terminal record is invalid.");
  }
}

function sameTerminalRecord(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return left.state === right.state
    && left.failureClass === right.failureClass
    && left.stopReason === right.stopReason
    && left.workspaceArtifactId === right.workspaceArtifactId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
