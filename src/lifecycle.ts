import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
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
  status: "ready" | "failed";
  path?: string;
  artifactId?: string;
  digest?: string;
  retained?: boolean;
  error?: string;
  shutdownResult?: WorkspaceShutdownResult;
  evidence?: unknown;
};

export type WorkspaceShutdownResult = {
  status: "completed" | "failed" | "timed-out";
  error?: string;
};

export type WorkspaceSetupContext = {
  run: RunIdentity;
  attempt: AttemptIdentity;
  signal: AbortSignal;
  registerShutdown: (shutdown: () => void | Promise<void>) => void;
};

export type WorkspaceCleanupContext = {
  run: RunIdentity;
  attempt: AttemptIdentity;
  signal: AbortSignal;
  outcome: TerminalRecord;
  workspace?: WorkspaceExecutionResult;
};

export type WorkspaceCoordinator = {
  setup: (context: WorkspaceSetupContext) => WorkspaceExecutionResult | Promise<WorkspaceExecutionResult>;
  cleanup?: (context: WorkspaceCleanupContext) => void | Promise<void>;
};

export type HarnessExecutionContext = {
  run: RunIdentity;
  attempt: AttemptIdentity;
  signal: AbortSignal;
  budgetMs?: number;
  workspace?: WorkspaceExecutionResult;
  registerShutdown: (shutdown: () => void | Promise<void>) => void;
};

export type HarnessExecutionResult = {
  status: "completed" | "failed" | "stopped" | "interrupted";
  failureClass?: Exclude<FailureClass, "none">;
  stopReason?: Exclude<StopReason, "none">;
  reason?: string;
  error?: string;
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
  registerShutdown: (shutdown: () => void | Promise<void>) => void;
};

export type VerifierExecutionResult = {
  status: "passed" | "failed" | "error" | "not-run";
  error?: string;
  shutdownResult?: VerifierShutdownResult;
  evidence?: unknown;
};

export type VerifierShutdownResult = {
  status: "completed" | "failed" | "timed-out";
  error?: string;
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
  harnessTerminationConfirmed?: boolean;
  verifierTerminationConfirmed?: boolean;
  cleanup?: { status: "completed" | "failed" | "timed-out"; error?: string };
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

const LIFECYCLE_PROGRESS: Record<LifecycleState, number> = {
  created: 0,
  setup: 1,
  running: 2,
  verifying: 3,
  cleaning: 4,
  terminal: 5,
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
  const runSnapshot = structuredClone(options.run);
  const attemptSnapshot = structuredClone(attempt);
  const lifecycle = new LifecycleController(now);
  const controller = new AbortController();
  const executionStartedAt = Date.now();
  const record: AttemptRecord = {
    schemaVersion: "ebo.attempt/v1",
    run: structuredClone(runSnapshot),
    attempt: structuredClone(attemptSnapshot),
    lifecycle: lifecycle.snapshot(),
    partial: true,
  };
  if (options.evidence?.flush === undefined) {
    record.capture = { status: "incomplete", error: "Evidence flush boundary is unavailable." };
  }
  let persistenceError: string | undefined;
  let initialCheckpointError: string | undefined;
  let reservationPath: string | undefined;
  if (options.recordPath !== undefined) {
    await assertAttemptRecordPathAvailable(options.recordPath, runSnapshot, attemptSnapshot);
    reservationPath = await reserveAttemptRecordPath(options.recordPath);
  }
  const persist = async (): Promise<void> => {
    record.lifecycle = lifecycle.snapshot();
    if (options.recordPath === undefined) return;
    try {
      record.persistence = { status: "complete" };
      await writeAttemptRecordInternal(options.recordPath, record);
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
          const settledFlush = await settleWithTimeout(evidenceFlush, options.shutdownGraceMs ?? 250);
          if (settledFlush.status === "failed") throw settledFlush.error;
          if (settledFlush.status === "timed-out") throw new Error("Evidence flush interrupted.");
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
  let harnessShutdown: (() => void | Promise<void>) | undefined;
  let workspaceShutdown: (() => void | Promise<void>) | undefined;
  let workspaceTerminationConfirmed = true;
  let verifierShutdown: (() => void | Promise<void>) | undefined;
  let setupStarted = false;
  const abortPromise = new Promise<"aborted">((resolveAbort) => {
    if (controller.signal.aborted) resolveAbort("aborted");
    else controller.signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true });
  });
  if (options.maxWallClockMs !== undefined) {
    budgetTimer = setTimeout(() => {
      abortCause ??= "budget";
      budgetExpired ??= "coordinator";
      controller.abort("budget");
    }, options.maxWallClockMs);
  }
  const markCoordinatorBudgetIfExpired = () => {
    if (options.maxWallClockMs !== undefined && Date.now() - executionStartedAt >= options.maxWallClockMs) {
      abortCause ??= "budget";
      budgetExpired ??= "coordinator";
      controller.abort("budget");
    }
  };

  try {
    await flush();
    if (persistenceError !== undefined) {
      initialCheckpointError = persistenceError;
      throw new Error(`Initial attempt checkpoint could not be persisted: ${persistenceError}`);
    }
    lifecycle.transition("setup");
    await persist();
    if (persistenceError !== undefined) {
      initialCheckpointError ??= persistenceError;
      throw new Error(`Initial attempt checkpoint could not be persisted: ${persistenceError}`);
    }
    try {
      markCoordinatorBudgetIfExpired();
      if (controller.signal.aborted) {
        classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
      } else {
        setupStarted = true;
        const setupPromise = Promise.resolve(options.workspace.setup({
          run: structuredClone(runSnapshot),
          attempt: structuredClone(attemptSnapshot),
          signal: controller.signal,
          registerShutdown: (shutdown) => { workspaceShutdown = shutdown; },
        }));
        const setupOutcome = await Promise.race([
          setupPromise.then((value) => ({ kind: "result" as const, value })),
          abortPromise.then((value) => ({ kind: value })),
        ]);
        if (setupOutcome.kind === "aborted" || controller.signal.aborted) {
          const settledSetup = await settleWithTimeout(setupPromise, options.shutdownGraceMs ?? 250);
          if (settledSetup.status === "completed") {
            workspace = snapshotWorkspace(settledSetup.value);
            record.workspace = snapshotWorkspace(workspace);
            if (workspaceShutdown !== undefined) {
              workspaceTerminationConfirmed = false;
              const shutdownResult = await shutdownWorkspace(workspaceShutdown, options.shutdownGraceMs ?? 250);
              if (shutdownResult !== undefined) {
                workspace = { ...workspace, shutdownResult };
                record.workspace = snapshotWorkspace(workspace);
                workspaceTerminationConfirmed = shutdownResult.status === "completed";
              }
            }
          } else if (settledSetup.status === "failed") {
            record.workspace = { status: "failed", error: errorMessage(settledSetup.error) };
            if (workspaceShutdown !== undefined) {
              workspaceTerminationConfirmed = false;
              const shutdownResult = await shutdownWorkspace(workspaceShutdown, options.shutdownGraceMs ?? 250);
              if (shutdownResult !== undefined) {
                record.workspace.shutdownResult = shutdownResult;
                workspaceTerminationConfirmed = shutdownResult.status === "completed";
              }
            }
          } else {
            record.workspace = { status: "failed", error: settledSetup.error };
            workspaceTerminationConfirmed = false;
            const shutdownResult = await shutdownWorkspace(workspaceShutdown, options.shutdownGraceMs ?? 250);
            if (shutdownResult !== undefined) {
              record.workspace.shutdownResult = shutdownResult;
              workspaceTerminationConfirmed = shutdownResult.status === "completed";
            }
          }
          classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
        } else {
          workspace = snapshotWorkspace(setupOutcome.value);
          record.workspace = snapshotWorkspace(workspace);
          if (workspace.status === "failed") {
            classification = infrastructureClassification("Workspace setup failed.", "workspace", workspace);
            if (workspaceShutdown !== undefined) {
              workspaceTerminationConfirmed = false;
              const shutdownResult = await shutdownWorkspace(workspaceShutdown, options.shutdownGraceMs ?? 250);
              if (shutdownResult !== undefined) {
                workspace = { ...workspace, shutdownResult };
                record.workspace = snapshotWorkspace(workspace);
                workspaceTerminationConfirmed = shutdownResult.status === "completed";
              }
            }
          }
        }
      }
    } catch (error) {
      const setupError = errorMessage(error);
      if (workspaceShutdown !== undefined) {
        workspaceTerminationConfirmed = false;
        const shutdownResult = await shutdownWorkspace(workspaceShutdown, options.shutdownGraceMs ?? 250);
        record.workspace = {
          status: "failed",
          error: setupError,
          ...(shutdownResult === undefined ? {} : { shutdownResult }),
        };
        workspaceTerminationConfirmed = shutdownResult?.status === "completed";
      }
      classification = controller.signal.aborted
        ? abortClassification(abortCause, budgetExpired, setupError, workspace)
        : infrastructureClassification(setupError, "workspace", workspace);
    }
    markCoordinatorBudgetIfExpired();
    if (classification === undefined && controller.signal.aborted) {
      classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
    }
    await flush();
    markCoordinatorBudgetIfExpired();
    if (classification === undefined && controller.signal.aborted) {
      classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
    }

    if (classification === undefined) {
      lifecycle.transition("running");
      await persist();
      markCoordinatorBudgetIfExpired();
      if (controller.signal.aborted) classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
    }
    if (classification === undefined) {
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
          run: structuredClone(runSnapshot),
          attempt: structuredClone(attemptSnapshot),
          signal: controller.signal,
          ...(options.harnessBudgetMs === undefined ? {} : { budgetMs: options.harnessBudgetMs }),
          ...(workspace === undefined ? {} : { workspace: snapshotWorkspace(workspace) }),
          registerShutdown: (shutdown) => { harnessShutdown = shutdown; },
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
          ? abortClassification(abortCause, budgetExpired, errorMessage(error), workspace)
          : infrastructureClassification(errorMessage(error), "harness", workspace);
      } finally {
        for (const timer of timers) clearTimeout(timer);
      }
      if (outcome === undefined && harnessShutdown !== undefined) {
        const shutdownResult = await shutdownHarness(undefined, harnessShutdown, options.shutdownGraceMs ?? 250);
        record.harness = {
          status: "failed",
          ...(classification?.reason === undefined ? {} : { error: classification.reason }),
          ...(shutdownResult === undefined ? {} : { shutdownResult }),
        };
        record.harnessTerminationConfirmed = shutdownResult?.status === "completed";
      } else if (outcome === undefined) {
        record.harnessTerminationConfirmed = true;
      }
      if (outcome !== undefined && (outcome.kind === "aborted" || controller.signal.aborted)) {
        let harnessTerminationConfirmed = false;
        if (outcome.kind === "result") {
          harnessResult = outcome.value;
          record.harness = durableHarnessResult(outcome.value);
          harnessTerminationConfirmed = true;
        }
        const settledHarness = await settleWithTimeout(harnessPromise, options.shutdownGraceMs ?? 250);
        if (settledHarness.status === "completed" && harnessResult === undefined) {
          harnessResult = settledHarness.value;
          record.harness = durableHarnessResult(settledHarness.value);
          harnessTerminationConfirmed = true;
        } else if (settledHarness.status === "failed" && harnessResult === undefined) {
          record.harness = { status: "interrupted", error: errorMessage(settledHarness.error) };
          harnessTerminationConfirmed = true;
        } else if (settledHarness.status === "timed-out" && harnessResult === undefined) {
          record.harness = { status: "interrupted", error: settledHarness.error };
        }
        classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
        const shutdownResult = await shutdownHarness(harnessResult, harnessShutdown, options.shutdownGraceMs ?? 250);
        if (shutdownResult !== undefined) {
          if (harnessResult !== undefined) {
            harnessResult = { ...harnessResult, shutdownResult };
            record.harness = durableHarnessResult(harnessResult);
          } else {
            record.harness = { status: "interrupted", shutdownResult };
          }
          harnessTerminationConfirmed = shutdownResult.status === "completed";
        }
        if (!harnessTerminationConfirmed) record.harness = {
          ...(record.harness ?? { status: "interrupted" }),
          error: record.harness?.error ?? "Harness execution did not terminate before cleanup.",
        };
        record.harnessTerminationConfirmed = harnessTerminationConfirmed;
      } else if (outcome?.kind === "result") {
        harnessResult = outcome.value;
        record.harness = durableHarnessResult(harnessResult);
        classification = classifyHarness(harnessResult, workspace);
        if (classification !== undefined && harnessResult.status !== "completed") {
          let harnessTerminationConfirmed = true;
          if (harnessShutdown !== undefined || harnessResult.shutdown !== undefined) {
            harnessTerminationConfirmed = false;
            const shutdownResult = await shutdownHarness(harnessResult, harnessShutdown, options.shutdownGraceMs ?? 250);
            if (shutdownResult !== undefined) {
              harnessResult = { ...harnessResult, shutdownResult };
              record.harness = durableHarnessResult(harnessResult);
              harnessTerminationConfirmed = shutdownResult.status === "completed";
            }
          }
          record.harnessTerminationConfirmed = harnessTerminationConfirmed;
        }
        if (classification === undefined && harnessResult.status === "completed") {
          lifecycle.transition("verifying");
          await persist();
          markCoordinatorBudgetIfExpired();
          if (controller.signal.aborted) {
            classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
          } else if (options.verifier === undefined) {
            record.verifier = { status: "not-run" };
            classification = infrastructureClassification("Verifier did not run.", "verifier", workspace);
          } else {
            try {
              const verifierPromise = Promise.resolve(options.verifier({
                run: structuredClone(runSnapshot),
                attempt: structuredClone(attemptSnapshot),
                signal: controller.signal,
                ...(workspace === undefined ? {} : { workspace: snapshotWorkspace(workspace) }),
                registerShutdown: (shutdown) => { verifierShutdown = shutdown; },
              }));
              const verifierOutcome = await Promise.race([
                verifierPromise.then((value) => ({ kind: "result" as const, value })),
                abortPromise.then((value) => ({ kind: value })),
              ]);
              if (verifierOutcome.kind === "aborted" || controller.signal.aborted) {
                let verifierTerminationConfirmed = false;
                if (verifierOutcome.kind === "result") {
                  record.verifier = snapshotVerifier(verifierOutcome.value);
                  verifierTerminationConfirmed = true;
                }
                const settledVerifier = await settleWithTimeout(verifierPromise, options.shutdownGraceMs ?? 250);
                if (settledVerifier.status === "completed" && record.verifier === undefined) {
                  record.verifier = snapshotVerifier(settledVerifier.value);
                  verifierTerminationConfirmed = true;
                }
                if (settledVerifier.status === "failed" && record.verifier === undefined) {
                  record.verifier = { status: "error", error: errorMessage(settledVerifier.error) };
                  verifierTerminationConfirmed = true;
                }
                if (settledVerifier.status === "timed-out" && record.verifier === undefined) {
                  record.verifier = { status: "error", error: settledVerifier.error };
                }
                const shutdownResult = await shutdownVerifier(verifierShutdown, options.shutdownGraceMs ?? 250);
                if (shutdownResult !== undefined) {
                  record.verifier = {
                    ...(record.verifier ?? { status: "error" }),
                    shutdownResult,
                  };
                  verifierTerminationConfirmed = shutdownResult.status === "completed";
                }
                record.verifierTerminationConfirmed = verifierTerminationConfirmed;
                classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
              } else {
                const verifier = snapshotVerifier(verifierOutcome.value);
                record.verifier = verifier;
                if (verifier.status !== "passed") {
                  let verifierTerminationConfirmed = true;
                  if (verifierShutdown !== undefined) {
                    verifierTerminationConfirmed = false;
                    const shutdownResult = await shutdownVerifier(verifierShutdown, options.shutdownGraceMs ?? 250);
                    if (shutdownResult !== undefined) {
                      record.verifier = { ...verifier, shutdownResult };
                      verifierTerminationConfirmed = shutdownResult.status === "completed";
                    }
                  }
                  record.verifierTerminationConfirmed = verifierTerminationConfirmed;
                }
                markCoordinatorBudgetIfExpired();
                classification = controller.signal.aborted
                  ? abortClassification(abortCause, budgetExpired, undefined, workspace)
                  : classifyVerifier(verifier, workspace);
              }
            } catch (error) {
              const verifierError = errorMessage(error);
              record.verifier = { status: "error", error: verifierError };
              record.verifierTerminationConfirmed = true;
              if (verifierShutdown !== undefined) {
                const shutdownResult = await shutdownVerifier(verifierShutdown, options.shutdownGraceMs ?? 250);
                if (shutdownResult !== undefined) {
                  record.verifier.shutdownResult = shutdownResult;
                  record.verifierTerminationConfirmed = shutdownResult.status === "completed";
                }
              }
              classification = controller.signal.aborted
                  ? abortClassification(abortCause, budgetExpired, verifierError, workspace)
                : verifierErrorClassification(verifierError, workspace);
            }
          }
        }
      }
      await flush();
    }
  } catch (error) {
    classification ??= infrastructureClassification(errorMessage(error), "runner", workspace);
  } finally {
    if (lifecycle.state !== "cleaning" && lifecycle.state !== "terminal") {
      lifecycle.transition("cleaning");
      await persist();
    }
    if (!setupStarted && workspace === undefined) {
      cleanupStatus = { status: "completed" };
    } else if (record.harnessTerminationConfirmed === false) {
      cleanupStatus = { status: "timed-out", error: "Harness execution did not terminate before cleanup." };
    } else if (record.verifierTerminationConfirmed === false) {
      cleanupStatus = { status: "timed-out", error: "Verifier execution did not terminate before cleanup." };
    } else if (!workspaceTerminationConfirmed) {
      cleanupStatus = { status: "timed-out", error: "Workspace setup did not terminate before cleanup." };
    } else try {
      const cleanupPromise = Promise.resolve(options.workspace.cleanup?.({
        run: structuredClone(runSnapshot),
        attempt: structuredClone(attemptSnapshot),
        signal: controller.signal,
        outcome: structuredClone(classification?.terminal ?? infrastructureClassification("Run did not produce a terminal outcome.", "runner").terminal),
        ...(workspace === undefined ? {} : { workspace: snapshotWorkspace(workspace) }),
      }));
      const cleanupOutcome = await Promise.race([
        cleanupPromise.then(() => "completed" as const),
        abortPromise.then(() => "aborted" as const),
      ]);
      if (cleanupOutcome === "aborted") {
        const settledCleanup = await settleWithTimeout(cleanupPromise, options.shutdownGraceMs ?? 250);
        if (settledCleanup.status === "timed-out") {
          cleanupStatus = { status: "timed-out", error: settledCleanup.error };
        } else if (settledCleanup.status === "failed") {
          cleanupStatus = { status: "failed", error: errorMessage(settledCleanup.error) };
        } else {
          cleanupStatus = { status: "completed" };
        }
      } else {
        cleanupStatus = { status: "completed" };
      }
    } catch (error) {
      cleanupStatus = { status: "failed", error: errorMessage(error) };
      if (classification === undefined || classificationUnderlyingKind(classification) === "completed") {
        classification = infrastructureClassification(errorMessage(error), "cleanup", workspace);
      }
    }
    markCoordinatorBudgetIfExpired();
    if (cleanupStatus?.status === "timed-out" && classificationUnderlyingKind(classification ?? infrastructureClassification("Run did not produce a terminal outcome.", "runner")) === "completed") {
      classification = infrastructureClassification(cleanupStatus.error ?? "Workspace cleanup timed out.", "cleanup", workspace);
    }
    record.cleanup = cleanupStatus;
    await flush();
    if (record.capture?.status !== "incomplete" && options.evidence?.flush !== undefined) {
      record.capture = { status: "complete" };
    }
    if (budgetExpired !== undefined && classification?.kind === "completed") {
      classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
    }
    if (controller.signal.aborted && classification?.kind === "completed") {
      classification = abortClassification(abortCause, budgetExpired, undefined, workspace);
    }
    if (persistenceError !== undefined && classification !== undefined && classificationUnderlyingKind(classification) === "completed") {
      classification = infrastructureClassification(persistenceError, "runner", workspace);
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
    classification ??= infrastructureClassification("Run did not produce a terminal outcome.", "runner", workspace);
    record.classification = classification;
    record.terminal = classification.terminal;
    record.partial = classificationUnderlyingKind(classification) !== "completed"
      || record.capture?.status === "incomplete";
    const persistenceBeforeTerminal = persistenceError;
    await persist();
    if (persistenceError !== undefined && persistenceBeforeTerminal === undefined
        && classificationUnderlyingKind(classification) === "completed") {
      const failedPersistence = infrastructureClassification(persistenceError, "runner", workspace);
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
    if (reservationPath !== undefined) await rm(reservationPath, { force: true });
    if (initialCheckpointError !== undefined) {
      throw new Error(`Initial attempt checkpoint could not be persisted: ${initialCheckpointError}`);
    }
  }

  return {
    run: structuredClone(record.run),
    attempt: structuredClone(record.attempt),
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
  assertJsonValue(record, "attempt record", new Set<object>());
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await withRecordReservationLock(destination, () => writeAttemptRecordInternal(path, record));
}

async function writeAttemptRecordInternal(path: string, record: AttemptRecord): Promise<void> {
  assertRecord(record);
  const destination = resolve(path);
  await withRecordPublicationLock(destination, async () => {
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
        await syncDirectory(dirname(destination));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readAttemptRecord(destination);
        if (existing.run.id !== record.run.id || existing.attempt.id !== record.attempt.id) {
          throw new Error(`Attempt record "${path}" already belongs to another attempt.`);
        }
        if (existing.terminal !== undefined || existing.classification !== undefined) {
          throw new Error(`Attempt record "${path}" is already terminal.`);
        }
        assertCheckpointDoesNotRegress(existing, record);
        await rename(temporary, destination);
        await syncDirectory(dirname(destination));
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
}

async function withRecordReservationLock<T>(destination: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${destination}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`Attempt record "${destination}" is already reserved: ${errorMessage(error)}`);
  }
  try {
    return await operation();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function withRecordPublicationLock<T>(destination: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${destination}.write-lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`Attempt record "${destination}" is already being published: ${errorMessage(error)}`);
  }
  try {
    return await operation();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readAttemptRecord(path: string): Promise<AttemptRecord> {
  const bytes = await readFile(resolve(path));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  assertRecord(value);
  return value;
}

async function assertAttemptRecordPathAvailable(
  path: string,
  run: RunIdentity,
  attempt: AttemptIdentity,
): Promise<void> {
  const destination = resolve(path);
  let exists = false;
  try {
    await lstat(destination);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) return;
  const existing = await readAttemptRecord(destination);
  if (existing.run.id !== run.id || existing.attempt.id !== attempt.id) {
    throw new Error(`Attempt record "${path}" already belongs to another attempt.`);
  }
  throw new Error(`Attempt record "${path}" is already owned; use a new linked attempt.`);
}

async function reserveAttemptRecordPath(path: string): Promise<string> {
  const reservation = `${resolve(path)}.lock`;
  await mkdir(dirname(reservation), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(reservation, "wx", 0o600);
    created = true;
    await handle.write(`${process.pid}\n`, undefined, "utf8");
    await handle.sync();
    return reservation;
  } catch (error) {
    if (created) await rm(reservation, { force: true });
    throw new Error(`Attempt record "${path}" is already reserved: ${errorMessage(error)}`);
  } finally {
    await handle?.close();
  }
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
  if (!Number.isSafeInteger(options.shutdownGraceMs) && options.shutdownGraceMs !== undefined) {
    throw new Error("Shutdown grace period must be a nonnegative safe integer.");
  }
  if (options.shutdownGraceMs !== undefined && options.shutdownGraceMs < 0) {
    throw new Error("Shutdown grace period must be a nonnegative safe integer.");
  }
}

function assertCheckpointDoesNotRegress(existing: AttemptRecord, incoming: AttemptRecord): void {
  const existingProgress = LIFECYCLE_PROGRESS[existing.lifecycle.state];
  const incomingProgress = LIFECYCLE_PROGRESS[incoming.lifecycle.state];
  if (incomingProgress < existingProgress || incoming.lifecycle.transitions.length < existing.lifecycle.transitions.length) {
    throw new Error("Attempt record update regresses lifecycle progress.");
  }
  for (const [index, transition] of existing.lifecycle.transitions.entries()) {
    const incomingTransition = incoming.lifecycle.transitions[index];
    if (incomingTransition.from !== transition.from || incomingTransition.to !== transition.to || incomingTransition.at !== transition.at) {
      throw new Error("Attempt record update changes retained lifecycle transitions.");
    }
  }
  if (!sameJsonValue(existing.run, incoming.run) || !sameJsonValue(existing.attempt, incoming.attempt)
      || existing.lifecycle.createdAt !== incoming.lifecycle.createdAt) {
    throw new Error("Attempt record update changes retained creation metadata.");
  }
  for (const field of [
    "workspace",
    "harness",
    "verifier",
    "harnessTerminationConfirmed",
    "verifierTerminationConfirmed",
    "cleanup",
    "capture",
    "persistence",
  ] as const) {
    if (existing[field] !== undefined && (incoming[field] === undefined || !sameJsonValue(existing[field], incoming[field]))) {
      throw new Error(`Attempt record update changes retained ${field} evidence.`);
    }
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
  }
  return false;
}

function classifyHarness(
  result: HarnessExecutionResult,
  workspace: WorkspaceExecutionResult | undefined,
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
        workspace,
      );
    case "stopped":
      if (result.stopReason === "policy") return policyClassification(result.reason, workspace);
      if (result.stopReason === "budget") return budgetClassification("harness", result.reason, workspace);
      return infrastructureClassification("Harness stopped without an explicit stop reason.", "harness", workspace);
    case "interrupted":
      return interruptedClassification(result.reason, "harness", workspace);
  }
}

function classifyVerifier(result: VerifierExecutionResult, workspace: WorkspaceExecutionResult | undefined): AttemptClassification {
  switch (result.status) {
    case "passed":
      return completedClassification(workspace);
    case "failed":
      return taskClassification(result.error ?? "Verifier reported task failure.", workspace, "verifier");
    case "error":
      return verifierErrorClassification(result.error ?? "Verifier failed to execute.", workspace);
    case "not-run":
      return infrastructureClassification("Verifier did not run.", "verifier", workspace);
  }
}

function completedClassification(workspace: WorkspaceExecutionResult | undefined): AttemptClassification {
  if (workspace === undefined || workspace.status !== "ready" || workspace.retained === false
      || workspace.artifactId === undefined) {
    return infrastructureClassification("Completed run requires a retained workspace artifact.", "workspace", workspace);
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
    return infrastructureClassification("Task failure requires a retained workspace artifact.", "workspace", workspace);
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
  workspace?: WorkspaceExecutionResult,
): AttemptClassification {
  const workspaceArtifactId = retainedWorkspaceArtifactId(workspace);
  return {
    kind: source === "verifier" ? "verifier-error" : "infrastructure-failure",
    terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none", ...(workspaceArtifactId === undefined ? {} : { workspaceArtifactId }) },
    reason,
    source,
  };
}

function verifierErrorClassification(reason: string, workspace?: WorkspaceExecutionResult): AttemptClassification {
  const workspaceArtifactId = retainedWorkspaceArtifactId(workspace);
  return {
    kind: "verifier-error",
    terminal: { state: "failed", failureClass: "infrastructure", stopReason: "none", ...(workspaceArtifactId === undefined ? {} : { workspaceArtifactId }) },
    reason,
    source: "verifier",
  };
}

function retainedWorkspaceArtifactId(workspace: WorkspaceExecutionResult | undefined): string | undefined {
  return workspace !== undefined && workspace.retained !== false && workspace.artifactId !== undefined
    && (workspace.status === "ready" || workspace.retained === true)
    ? workspace.artifactId
    : undefined;
}

function budgetClassification(
  source: "coordinator" | "harness",
  reason?: string,
  workspace?: WorkspaceExecutionResult,
): AttemptClassification {
  const workspaceArtifactId = retainedWorkspaceArtifactId(workspace);
  return {
    kind: "budget-stop",
    terminal: { state: "stopped", failureClass: "none", stopReason: "budget", ...(workspaceArtifactId === undefined ? {} : { workspaceArtifactId }) },
    ...(reason === undefined ? {} : { reason }),
    source: source === "harness" ? "harness" : "runner",
  };
}

function policyClassification(reason?: string, workspace?: WorkspaceExecutionResult): AttemptClassification {
  const workspaceArtifactId = retainedWorkspaceArtifactId(workspace);
  return {
    kind: "policy-stop",
    terminal: { state: "stopped", failureClass: "none", stopReason: "policy", ...(workspaceArtifactId === undefined ? {} : { workspaceArtifactId }) },
    ...(reason === undefined ? {} : { reason }),
    source: "harness",
  };
}

function interruptedClassification(
  reason?: string,
  source: AttemptClassification["source"] = "runner",
  workspace?: WorkspaceExecutionResult,
): AttemptClassification {
  const workspaceArtifactId = retainedWorkspaceArtifactId(workspace);
  return {
    kind: "interrupted",
    terminal: { state: "interrupted", failureClass: "infrastructure", stopReason: "none", ...(workspaceArtifactId === undefined ? {} : { workspaceArtifactId }) },
    ...(reason === undefined ? {} : { reason }),
    source,
  };
}

function abortClassification(
  cause: "interrupted" | "budget" | undefined,
  budget: "coordinator" | "harness" | undefined,
  reason?: string,
  workspace?: WorkspaceExecutionResult,
): AttemptClassification {
  return cause === "interrupted"
    ? interruptedClassification(reason, "runner", workspace)
    : budgetClassification(budget ?? "coordinator", reason, workspace);
}

function classificationUnderlyingKind(classification: AttemptClassification): AttemptClassificationKind {
  return classification.kind === "capture-incomplete"
    ? classification.underlying ?? classification.kind
    : classification.kind;
}

function snapshotWorkspace(workspace: WorkspaceExecutionResult): WorkspaceExecutionResult {
  assertJsonValue(workspace, "workspace", new Set<object>());
  return structuredClone(workspace);
}

function snapshotVerifier(verifier: VerifierExecutionResult): VerifierExecutionResult {
  assertJsonValue(verifier, "verifier", new Set<object>());
  return structuredClone(verifier);
}

async function shutdownHarness(
  result: HarnessExecutionResult | undefined,
  independentShutdown: (() => void | Promise<void>) | undefined,
  graceMs: number,
): Promise<HarnessShutdownResult | undefined> {
  const shutdownCallback = independentShutdown ?? result?.shutdown;
  if (shutdownCallback === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const shutdown = Promise.resolve(shutdownCallback());
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

async function shutdownWorkspace(
  shutdownCallback: (() => void | Promise<void>) | undefined,
  graceMs: number,
): Promise<WorkspaceShutdownResult | undefined> {
  if (shutdownCallback === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const shutdown = Promise.resolve(shutdownCallback());
    return await Promise.race([
      shutdown.then(() => ({ status: "completed" as const }), (error) => ({ status: "failed" as const, error: errorMessage(error) })),
      new Promise<WorkspaceShutdownResult>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ status: "timed-out", error: "Workspace shutdown exceeded its grace period." }), graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function shutdownVerifier(
  shutdownCallback: (() => void | Promise<void>) | undefined,
  graceMs: number,
): Promise<VerifierShutdownResult | undefined> {
  if (shutdownCallback === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const shutdown = Promise.resolve(shutdownCallback());
    return await Promise.race([
      shutdown.then(() => ({ status: "completed" as const }), (error) => ({ status: "failed" as const, error: errorMessage(error) })),
      new Promise<VerifierShutdownResult>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ status: "timed-out", error: "Verifier shutdown exceeded its grace period." }), graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function durableHarnessResult(result: HarnessExecutionResult): HarnessExecutionResult {
  const { shutdown: _shutdown, ...durable } = result;
  assertHarnessResult(durable);
  assertJsonValue(durable, "harness", new Set<object>());
  return structuredClone(durable);
}

async function settleWithTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "timed-out"; error: string }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ status: "completed" as const, value }), (error) => ({ status: "failed" as const, error })),
      new Promise<{ status: "timed-out"; error: string }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ status: "timed-out", error: "Operation exceeded its cancellation grace period." }), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  assertJsonValue(value, "attempt record", new Set<object>());
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
  const visitedStates = new Set<LifecycleState>(["created"]);
  for (const transition of lifecycle.transitions) {
    if (!isRecord(transition) || !isLifecycleState(transition.from) || !isLifecycleState(transition.to)) {
      throw new Error("Lifecycle transition is invalid.");
    }
    assertTimestampValue(transition.at, "Lifecycle transition timestamp");
    if (transition.from !== state || !ALLOWED_TRANSITIONS[state].includes(transition.to)) {
      throw new Error("Lifecycle transition sequence is invalid.");
    }
    state = transition.to;
    visitedStates.add(state);
  }
  if (state !== lifecycle.state) throw new Error("Lifecycle state does not match its transitions.");
  for (const [timestampState, timestamp] of Object.entries(lifecycle.timestamps)) {
    if (!isLifecycleState(timestampState)) throw new Error("Lifecycle timestamp state is invalid.");
    if (!visitedStates.has(timestampState)) throw new Error("Lifecycle timestamp state is not present in its transitions.");
    assertTimestampValue(timestamp, `Lifecycle timestamp ${timestampState}`);
  }
  for (const visitedState of visitedStates) {
    if (lifecycle.timestamps[visitedState] === undefined) throw new Error(`Lifecycle timestamp ${visitedState} is missing.`);
  }
  for (const transition of lifecycle.transitions) {
    if (lifecycle.timestamps[transition.to] !== transition.at) {
      throw new Error("Lifecycle transition timestamp disagrees with its state timestamp.");
    }
  }
  if (lifecycle.timestamps.created !== lifecycle.createdAt) throw new Error("Lifecycle created timestamp is inconsistent.");
  if (lifecycle.startedAt !== (lifecycle.timestamps.setup ?? lifecycle.createdAt)) {
    throw new Error("Lifecycle started timestamp is inconsistent.");
  }
  if (visitedStates.has("terminal")) {
    if (lifecycle.endedAt === undefined || lifecycle.endedAt !== lifecycle.timestamps.terminal) {
      throw new Error("Lifecycle ended timestamp is inconsistent.");
    }
  } else if (lifecycle.endedAt !== undefined) {
    throw new Error("Lifecycle ended timestamp is present before terminal state.");
  }
  if (typeof value.partial !== "boolean") throw new Error("Attempt record partial state is invalid.");
  if (lifecycle.state !== "terminal" && value.partial !== true) {
    throw new Error("Nonterminal attempt records must remain partial.");
  }
  if (value.harnessTerminationConfirmed !== undefined && typeof value.harnessTerminationConfirmed !== "boolean") {
    throw new Error("Harness termination confirmation is invalid.");
  }
  if (value.verifierTerminationConfirmed !== undefined && typeof value.verifierTerminationConfirmed !== "boolean") {
    throw new Error("Verifier termination confirmation is invalid.");
  }
  if (value.workspace !== undefined) assertWorkspaceResult(value.workspace);
  if (value.harness !== undefined) assertHarnessResult(value.harness);
  if (value.verifier !== undefined) assertVerifierResult(value.verifier);
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
    if (value.classification.reason !== undefined) assertTimestampValue(value.classification.reason, "Classification reason");
    if (value.classification.source !== undefined && !["runner", "workspace", "harness", "verifier", "cleanup", "capture"].includes(String(value.classification.source))) {
      throw new Error("Classification source is invalid.");
    }
    if (value.classification.underlying !== undefined) {
      if (value.classification.kind !== "capture-incomplete" || !isClassificationKind(value.classification.underlying)
          || value.classification.underlying === "capture-incomplete") {
        throw new Error("Classification underlying outcome is invalid.");
      }
    }
    assertTerminalRecord(value.classification.terminal);
    if (!sameTerminalRecord(value.terminal, value.classification.terminal)) {
      throw new Error("Attempt terminal and classification records disagree.");
    }
    assertClassificationTerminal(value.classification.kind, value.classification.terminal, value.classification.underlying);
    const expectedPartial = classificationUnderlyingKind(value.classification as unknown as AttemptClassification) !== "completed"
      || isRecord(value.capture) && value.capture.status === "incomplete";
    if (value.partial !== expectedPartial) throw new Error("Attempt partial state contradicts its terminal outcome.");
  }
  if (value.terminal?.workspaceArtifactId !== undefined) {
    assertTerminalWorkspaceEvidence(
      value.workspace,
      value.terminal.workspaceArtifactId,
      value.terminal.state === "failed" && value.terminal.failureClass === "infrastructure"
        || value.terminal.state === "stopped"
        || value.terminal.state === "interrupted",
    );
  }
  if (value.terminal?.state === "completed") {
    assertTerminalWorkspaceEvidence(value.workspace, value.terminal.workspaceArtifactId);
    assertVerifierStatus(value.verifier, "passed");
  }
  if (value.terminal?.state === "failed" && value.terminal.failureClass === "task") {
    assertTerminalWorkspaceEvidence(value.workspace, value.terminal.workspaceArtifactId);
    assertVerifierStatus(value.verifier, "failed");
  }
  if (isRecord(value.capture) && value.capture.status === "incomplete" && value.partial !== true) {
    throw new Error("Incomplete capture requires partial attempt state.");
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
    if (!isRecord(value.cleanup) || !["completed", "failed", "timed-out"].includes(String(value.cleanup.status))) {
      throw new Error("Attempt cleanup status is invalid.");
    }
    if (value.cleanup.error !== undefined) assertTimestampValue(value.cleanup.error, "Attempt cleanup error");
  }
  if (value.classification?.kind === "capture-incomplete"
      && (!isRecord(value.capture) || value.capture.status !== "incomplete" || value.partial !== true)) {
    throw new Error("Capture-incomplete classifications require incomplete capture evidence and partial state.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite JSON number.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value.`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a JSON object or array.`);
    const object = value as Record<string, unknown>;
    for (const key of Object.keys(object)) assertJsonValue(object[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
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
  if (value.state === "failed" && (value.failureClass !== "infrastructure" && value.failureClass !== "task" || value.stopReason !== "none" || value.failureClass === "task" && value.workspaceArtifactId === undefined)) {
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

function assertTerminalWorkspaceEvidence(workspace: unknown, artifactId: string | undefined, allowFailed = false): void {
  if (!isRecord(workspace) || (workspace.status !== "ready" && !(allowFailed && workspace.status === "failed" && workspace.retained === true)) || workspace.retained === false
      || typeof workspace.artifactId !== "string" || artifactId === undefined || workspace.artifactId !== artifactId) {
    throw new Error("Terminal outcome requires matching retained workspace evidence.");
  }
}

function assertWorkspaceResult(value: unknown): asserts value is WorkspaceExecutionResult {
  if (!isRecord(value) || value.status !== "ready" && value.status !== "failed") {
    throw new Error("Attempt workspace evidence is invalid.");
  }
  for (const field of ["path", "artifactId", "digest", "error"] as const) {
    if (value[field] !== undefined) assertTimestampValue(value[field], `Workspace ${field}`);
  }
  if (value.retained !== undefined && typeof value.retained !== "boolean") throw new Error("Workspace retention is invalid.");
  if (value.shutdownResult !== undefined) assertShutdownResult(value.shutdownResult, "Workspace shutdown");
}

function assertHarnessResult(value: unknown): asserts value is HarnessExecutionResult {
  if (!isRecord(value) || !["completed", "failed", "stopped", "interrupted"].includes(String(value.status))) {
    throw new Error("Attempt harness evidence is invalid.");
  }
  if (value.status === "completed" && (value.failureClass !== undefined || value.stopReason !== undefined)) {
    throw new Error("Completed harness evidence cannot include failure or stop fields.");
  }
  if (value.status === "failed" && value.stopReason !== undefined) {
    throw new Error("Failed harness evidence cannot include a stop field.");
  }
  if (value.status === "stopped" && value.failureClass !== undefined) {
    throw new Error("Stopped harness evidence cannot include a failure field.");
  }
  if (value.status === "interrupted" && (value.failureClass !== undefined || value.stopReason !== undefined)) {
    throw new Error("Interrupted harness evidence cannot include failure or stop fields.");
  }
  if (value.failureClass !== undefined && !["infrastructure", "task"].includes(String(value.failureClass))) {
    throw new Error("Harness failure class is invalid.");
  }
  if (value.stopReason !== undefined && !["budget", "policy"].includes(String(value.stopReason))) {
    throw new Error("Harness stop reason is invalid.");
  }
  for (const field of ["reason", "error"] as const) {
    if (value[field] !== undefined) assertTimestampValue(value[field], `Harness ${field}`);
  }
  if (value.shutdownResult !== undefined) assertShutdownResult(value.shutdownResult, "Harness shutdown");
}

function assertVerifierResult(value: unknown): asserts value is VerifierExecutionResult {
  if (!isRecord(value) || !["passed", "failed", "error", "not-run"].includes(String(value.status))) {
    throw new Error("Attempt verifier evidence is invalid.");
  }
  if (value.error !== undefined) assertTimestampValue(value.error, "Verifier error");
  if (value.shutdownResult !== undefined) assertShutdownResult(value.shutdownResult, "Verifier shutdown");
}

function assertShutdownResult(value: unknown, label: string): asserts value is { status: "completed" | "failed" | "timed-out"; error?: string } {
  if (!isRecord(value) || !["completed", "failed", "timed-out"].includes(String(value.status))) {
    throw new Error(`${label} result is invalid.`);
  }
  if (value.error !== undefined) assertTimestampValue(value.error, `${label} error`);
}

function assertVerifierStatus(verifier: unknown, status: "passed" | "failed"): void {
  if (!isRecord(verifier) || verifier.status !== status) {
    throw new Error(`Terminal outcome requires a ${status} verifier result.`);
  }
}

function assertClassificationTerminal(
  kind: AttemptClassificationKind,
  terminal: TerminalRecord,
  underlying: unknown,
): void {
  const baseKind = kind === "capture-incomplete" ? underlying : kind;
  if (!isClassificationKind(baseKind) || baseKind === "capture-incomplete") {
    throw new Error("Capture-incomplete classification must name a concrete underlying outcome.");
  }
  const expected = baseKind === "completed"
    ? { state: "completed", failureClass: "none", stopReason: "none" }
    : baseKind === "task-failure"
      ? { state: "failed", failureClass: "task", stopReason: "none" }
      : baseKind === "infrastructure-failure" || baseKind === "verifier-error"
        ? { state: "failed", failureClass: "infrastructure", stopReason: "none" }
        : baseKind === "budget-stop"
          ? { state: "stopped", failureClass: "none", stopReason: "budget" }
          : baseKind === "policy-stop"
            ? { state: "stopped", failureClass: "none", stopReason: "policy" }
            : { state: "interrupted", failureClass: "infrastructure", stopReason: "none" };
  if (terminal.state !== expected.state || terminal.failureClass !== expected.failureClass || terminal.stopReason !== expected.stopReason) {
    throw new Error("Attempt classification kind does not match its terminal outcome.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
