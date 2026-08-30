import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type ProtocolIdentity = string | number | null;

export type ProtocolObservationKind =
  | "frame"
  | "request"
  | "response"
  | "notification"
  | "completion"
  | "capability"
  | "error"
  | "process";

export type ProtocolObservation = {
  schemaVersion: "ebo.protocol-observation/v1";
  sequence: number;
  observedAt: string;
  kind: ProtocolObservationKind;
  source: string;
  stream?: "stdout" | "stderr";
  method?: string;
  id?: ProtocolIdentity;
  sourceIdentity?: string;
  raw?: string;
  payload?: unknown;
  evidence?: unknown;
  status?: string;
  capability?: string;
};

export type ProtocolObservationInput = {
  source: string;
  method: string;
  id?: ProtocolIdentity;
  sourceIdentity?: string;
  payload?: unknown;
  observedAt?: string;
};

export type ProtocolCompletionEvidence = {
  source: string;
  status: string;
  evidence: unknown;
  method?: string;
  sourceIdentity?: string;
  observedAt?: string;
};

export type ProtocolCapability = {
  source: string;
  name: string;
  status: "available" | "unsupported" | "missing" | "not-checked";
  details?: unknown;
  observedAt?: string;
};

export type JsonlEvidenceWriterOptions = {
  maxLineBytes?: number;
  fsync?: boolean;
  exclusive?: boolean;
};

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
const DEFAULT_KILL_GRACE_MS = 250;
const DEFAULT_MAX_IN_MEMORY_OBSERVATIONS = 1024;
const MAX_TIMER_MS = 2_147_483_647;
const INTERNAL_RECORDER_TOKEN = Symbol("internal recorder event");
const CLAIMED_WRITER_PATHS = new Set<string>();

/**
 * Appends JSON records one line at a time and optionally fsyncs each append.
 * A queued writer keeps records ordered even when protocol callbacks overlap.
 */
export class JsonlEvidenceWriter {
  public readonly path: string;
  private readonly maxLineBytes: number;
  private readonly shouldFsync: boolean;
  private readonly exclusive: boolean;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private claimed = false;
  private hasWrites = false;
  private claimLockFd: number | undefined;
  private claimLockPath: string | undefined;
  private claimCanonicalPath: string | undefined;
  private _count = 0;

  public constructor(path: string, options: JsonlEvidenceWriterOptions = {}) {
    if (path.trim() === "") throw new Error("JSONL evidence path is required.");
    this.path = resolve(path);
    this.maxLineBytes = positiveInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, "JSONL line limit");
    this.shouldFsync = options.fsync ?? true;
    this.exclusive = options.exclusive ?? false;
  }

  public get count(): number {
    return this._count;
  }

  public append(record: unknown, token?: typeof INTERNAL_RECORDER_TOKEN): Promise<void> {
    if (this.poisoned) return Promise.reject(new Error("JSONL evidence writer is unusable after an ambiguous append."));
    if (this.claimed && token !== INTERNAL_RECORDER_TOKEN) {
      return Promise.reject(new Error("JSONL evidence writer is claimed by a protocol recorder."));
    }
    if (token !== INTERNAL_RECORDER_TOKEN && writerPathIsReserved(this.path)) {
      return Promise.reject(new Error("JSONL evidence path is reserved by a protocol recorder."));
    }
    if (!isRecord(record)) return Promise.reject(new Error("JSONL evidence records must be objects."));
    let line: string;
    try {
      assertJsonValue(record, "JSONL evidence record", new Set<object>());
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      return Promise.reject(error);
    }
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      return Promise.reject(new Error(`JSONL evidence record exceeds ${this.maxLineBytes} bytes.`));
    }
    this.hasWrites = true;
    const operation = this.queue.then(async () => {
      let directLockFd: number | undefined;
      let directLockPath: string | undefined;
      try {
        if (token !== INTERNAL_RECORDER_TOKEN) {
          const canonicalPath = canonicalWriterPath(this.path);
          directLockPath = `${canonicalPath}.protocol.lock`;
          mkdirSync(dirname(canonicalPath), { recursive: true, mode: 0o700 });
          try {
            directLockFd = openSync(directLockPath, "wx", 0o600);
          } catch (error) {
            throw new Error(`JSONL evidence path is reserved by a protocol recorder: ${errorMessage(error)}`);
          }
        }
        if (this.closed) throw new Error("JSONL evidence writer is closed.");
        const handle = await this.openHandle();
        let wrote = false;
        try {
          await handle.write(line, undefined, "utf8");
          wrote = true;
          if (this.shouldFsync) await handle.sync();
          this._count += 1;
        } catch (error) {
          if (wrote) this.poisoned = true;
          throw error;
        }
      } finally {
        if (directLockFd !== undefined && directLockPath !== undefined) {
          closeSync(directLockFd);
          try {
            unlinkSync(directLockPath);
          } catch {
            // Preserve the append result; a missing lock is already released.
          }
        }
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  public flush(): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.handle !== undefined && this.shouldFsync) await this.handle.sync();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  public close(): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.closed) return;
      this.closed = true;
      if (this.handle !== undefined) {
        await this.handle.close();
        this.handle = undefined;
      }
      this.releaseClaimNow();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  public ensureOpen(): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.closed) throw new Error("JSONL evidence writer is closed.");
      await this.openHandle();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  public claim(token?: typeof INTERNAL_RECORDER_TOKEN): number {
    if (this.claimed) throw new Error("JSONL evidence writer is already claimed by a protocol recorder.");
    const canonicalPath = canonicalWriterPath(this.path);
    if (CLAIMED_WRITER_PATHS.has(canonicalPath)) throw new Error("JSONL evidence path is already claimed by a protocol recorder.");
    rejectHardLinkedPath(canonicalPath);
    if (this.hasWrites) throw new Error("JSONL evidence writer cannot be claimed after direct writes.");
    if (token !== INTERNAL_RECORDER_TOKEN) throw new Error("JSONL evidence writer claim is internal.");
    mkdirSync(dirname(canonicalPath), { recursive: true, mode: 0o700 });
    const lockPath = `${canonicalPath}.protocol.lock`;
    let lockFd: number | undefined;
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
      writeSync(lockFd, `${process.pid}\n`, undefined, "utf8");
      fsyncSync(lockFd);
      syncDirectory(dirname(lockPath));
      const sequence = recoverWriterSequence(this.path);
      this.claimed = true;
      this.claimLockFd = lockFd;
      this.claimLockPath = lockPath;
      this.claimCanonicalPath = canonicalPath;
      CLAIMED_WRITER_PATHS.add(canonicalPath);
      return sequence;
    } catch (error) {
      if (lockFd !== undefined) {
        closeSync(lockFd);
        try {
          unlinkSync(lockPath);
          syncDirectory(dirname(lockPath));
        } catch {
          // Preserve the original claim/recovery error.
        }
      }
      throw error;
    }
  }

  public releaseClaim(token?: typeof INTERNAL_RECORDER_TOKEN): void {
    if (token !== INTERNAL_RECORDER_TOKEN) throw new Error("JSONL evidence writer release is internal.");
    this.releaseClaimNow();
  }

  private releaseClaimNow(): void {
    this.claimed = false;
    if (this.claimLockFd === undefined || this.claimLockPath === undefined) return;
    const lockFd = this.claimLockFd;
    const lockPath = this.claimLockPath;
    const canonicalPath = this.claimCanonicalPath;
    this.claimLockFd = undefined;
    this.claimLockPath = undefined;
    this.claimCanonicalPath = undefined;
    if (canonicalPath !== undefined) CLAIMED_WRITER_PATHS.delete(canonicalPath);
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
      syncDirectory(dirname(lockPath));
    } catch {
      // A missing lock is already released; other errors do not change the closed writer state.
    }
  }

  private async openHandle(): Promise<FileHandle> {
    if (this.handle !== undefined) return this.handle;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.path, this.exclusive ? "wx" : "a", 0o600);
    try {
      syncDirectory(dirname(this.path));
      this.handle = handle;
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
}

export async function openJsonlEvidenceWriter(
  path: string,
  options: JsonlEvidenceWriterOptions = {},
): Promise<JsonlEvidenceWriter> {
  const writer = new JsonlEvidenceWriter(path, options);
  await writer.ensureOpen();
  return writer;
}

export type BoundedDiagnostic = {
  bytes: Buffer;
  text: string;
  sizeBytes: number;
  truncated: boolean;
  maxBytes: number;
};

/** Keeps a bounded diagnostic prefix while continuing to drain the stream. */
export class BoundedDiagnosticCapture {
  private readonly chunks: Buffer[] = [];
  private _sizeBytes = 0;
  private _truncated = false;
  private keptBytes = 0;

  public constructor(public readonly maxBytes: number = DEFAULT_MAX_STDERR_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error("Diagnostic byte limit must be a nonnegative safe integer.");
    }
  }

  public write(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk);
    this._sizeBytes += bytes.length;
    const kept = Math.max(0, Math.min(bytes.length, this.maxBytes - this.keptBytes));
    if (kept > 0) {
      this.chunks.push(bytes.subarray(0, kept));
      this.keptBytes += kept;
    }
    if (kept < bytes.length) this._truncated = true;
  }

  public get sizeBytes(): number {
    return this._sizeBytes;
  }

  public get truncated(): boolean {
    return this._truncated;
  }

  public result(): BoundedDiagnostic {
    const bytes = Buffer.concat(this.chunks);
    return {
      bytes,
      text: bytes.toString("utf8"),
      sizeBytes: this._sizeBytes,
      truncated: this._truncated,
      maxBytes: this.maxBytes,
    };
  }

}

export type ProtocolProcessOptions = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  source: string;
  evidencePath?: string;
  writer?: JsonlEvidenceWriter;
  stderrPath?: string;
  maxStderrBytes?: number;
  maxLineBytes?: number;
  shutdownGraceMs?: number;
  killGraceMs?: number;
  maxInMemoryObservations?: number;
  signal?: AbortSignal;
  now?: () => string;
  spawnOptions?: Omit<SpawnOptions, "stdio" | "env" | "cwd">;
  onFrame?: (payload: unknown, recorder: ProtocolEvidenceRecorder) => void | Promise<void>;
};

export type ProcessTermination = "natural" | "shutdown" | "interrupted" | "malformed" | "recorder-error";

export type ProtocolProcessResult = {
  status: "completed" | "failed" | "malformed" | "interrupted" | "shutdown";
  partial: boolean;
  protocolOnly: true;
  launch: {
    command: string;
    args: string[];
    cwd: string;
    pid: number | null;
    startedAt: string;
    endedAt: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  };
  termination: ProcessTermination;
  stdoutFrames: number;
  stderr: BoundedDiagnostic;
  error?: string;
  recorderError?: string;
  protocolError?: { line: number; message: string; raw?: string };
  evidencePath?: string;
  stderrPath?: string;
  droppedObservations: number;
  observations: ProtocolObservation[];
};

export class ProtocolEvidenceRecorder {
  private sequence = 0;
  private readonly records: ProtocolObservation[] = [];
  private readonly maxInMemoryObservations: number;
  private queue: Promise<void> = Promise.resolve();
  private fenced = false;
  private _dropped = 0;

  public constructor(
    private readonly writer: JsonlEvidenceWriter,
    private readonly source: string,
    private readonly now: () => string = () => new Date().toISOString(),
    maxInMemoryObservations = DEFAULT_MAX_IN_MEMORY_OBSERVATIONS,
  ) {
    assertNonEmpty(source, "Protocol source");
    this.maxInMemoryObservations = positiveInteger(maxInMemoryObservations, "In-memory observation limit");
    this.sequence = writer.claim(INTERNAL_RECORDER_TOKEN);
  }

  public get observations(): readonly ProtocolObservation[] {
    return this.records.map((record) => structuredClone(record));
  }

  public get droppedObservations(): number {
    return this._dropped;
  }

  /** Prevents late observer callbacks from appending after process finalization. */
  public fence(): void {
    this.fenced = true;
  }

  public recordFrame(payload: unknown, observedAt = this.now(), raw?: string): Promise<ProtocolObservation> {
    if (payload === undefined) return Promise.reject(new Error("Frame payload is required."));
    if (raw !== undefined) assertNonEmpty(raw, "Raw frame text");
    return this.record({ kind: "frame", source: this.source, stream: "stdout", ...(raw === undefined ? {} : { raw }), payload, observedAt });
  }

  public recordRequest(input: ProtocolObservationInput): Promise<ProtocolObservation> {
    return this.record({ ...input, kind: "request", observedAt: input.observedAt ?? this.now() });
  }

  public recordResponse(input: ProtocolObservationInput): Promise<ProtocolObservation> {
    return this.record({ ...input, kind: "response", observedAt: input.observedAt ?? this.now() });
  }

  public recordNotification(input: ProtocolObservationInput): Promise<ProtocolObservation> {
    return this.record({ ...input, kind: "notification", observedAt: input.observedAt ?? this.now() });
  }

  public recordCompletion(input: ProtocolCompletionEvidence): Promise<ProtocolObservation> {
    assertNonEmpty(input.source, "Completion source");
    assertNonEmpty(input.status, "Completion status");
    if (input.evidence === undefined) return Promise.reject(new Error("Completion evidence is required."));
    return this.record({
      kind: "completion",
      source: input.source,
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.sourceIdentity === undefined ? {} : { sourceIdentity: input.sourceIdentity }),
      evidence: input.evidence,
      status: input.status,
      observedAt: input.observedAt ?? this.now(),
    });
  }

  public recordCapability(input: ProtocolCapability): Promise<ProtocolObservation> {
    assertNonEmpty(input.source, "Capability source");
    assertNonEmpty(input.name, "Capability name");
    if (!["available", "unsupported", "missing", "not-checked"].includes(String(input.status))) {
      return Promise.reject(new Error("Capability status is invalid."));
    }
    return this.record({
      kind: "capability",
      source: input.source,
      capability: input.name,
      status: input.status,
      ...(input.details === undefined ? {} : { evidence: input.details }),
      observedAt: input.observedAt ?? this.now(),
    });
  }

  public recordError(message: string, evidence?: unknown, token?: typeof INTERNAL_RECORDER_TOKEN): Promise<ProtocolObservation> {
    assertNonEmpty(message, "Protocol error");
    return this.record({
      kind: "error",
      source: this.source,
      status: message,
      ...(evidence === undefined ? {} : { evidence }),
      observedAt: this.now(),
    }, token === INTERNAL_RECORDER_TOKEN);
  }

  public recordProcess(status: string, evidence?: unknown, token?: typeof INTERNAL_RECORDER_TOKEN): Promise<ProtocolObservation> {
    assertNonEmpty(status, "Process status");
    return this.record({
      kind: "process",
      source: this.source,
      status,
      ...(evidence === undefined ? {} : { evidence }),
      observedAt: this.now(),
    }, token === INTERNAL_RECORDER_TOKEN);
  }

  public flush(): Promise<void> {
    return this.queue.then(() => this.writer.flush());
  }

  public close(): Promise<void> {
    return this.queue.then(() => this.writer.close());
  }

  private record(input: {
    kind: ProtocolObservationKind;
    source: string;
    method?: string;
    id?: ProtocolIdentity;
    sourceIdentity?: string;
    raw?: string;
    payload?: unknown;
    evidence?: unknown;
    status?: string;
    capability?: string;
    stream?: "stdout" | "stderr";
    observedAt: string;
  }, allowFenced = false): Promise<ProtocolObservation> {
    if (this.fenced && !allowFenced) return Promise.reject(new Error("Protocol evidence recorder is fenced."));
    assertNonEmpty(input.source, "Protocol source");
    assertNonEmpty(input.observedAt, "Observation timestamp");
    if (input.method !== undefined) assertNonEmpty(input.method, "Protocol method");
    if (input.sourceIdentity !== undefined) assertNonEmpty(input.sourceIdentity, "Protocol source identity");
    if (input.id !== undefined && (typeof input.id === "number" && !Number.isFinite(input.id)
        || typeof input.id !== "string" && typeof input.id !== "number" && input.id !== null)) {
      return Promise.reject(new Error("Protocol identity must be a finite JSON string, number, or null."));
    }
    let payload: unknown;
    let evidence: unknown;
    try {
      if (input.payload !== undefined) payload = cloneJsonValue(input.payload, "payload");
      if (input.evidence !== undefined) evidence = cloneJsonValue(input.evidence, "evidence");
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.queue.then(async () => {
      const observation: ProtocolObservation = {
        schemaVersion: "ebo.protocol-observation/v1",
        sequence: this.sequence + 1,
        observedAt: input.observedAt,
        kind: input.kind,
        source: input.source,
        ...(input.stream === undefined ? {} : { stream: input.stream }),
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.sourceIdentity === undefined ? {} : { sourceIdentity: input.sourceIdentity }),
        ...(input.raw === undefined ? {} : { raw: input.raw }),
        ...(payload === undefined ? {} : { payload }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.capability === undefined ? {} : { capability: input.capability }),
      };
      await this.writer.append(observation, INTERNAL_RECORDER_TOKEN);
      this.sequence = observation.sequence;
      if (this.records.length >= this.maxInMemoryObservations) {
        this.records.shift();
        this._dropped += 1;
      }
      this.records.push(observation);
      return structuredClone(observation);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export class ProtocolProcess {
  private readonly child: ChildProcess;
  private readonly recorder: ProtocolEvidenceRecorder;
  private readonly stderrCapture: BoundedDiagnosticCapture;
  private readonly stdoutLineLimit: number;
  private readonly shutdownGraceMs: number;
  private readonly killGraceMs: number;
  private readonly maxInMemoryObservations: number;
  private readonly writer: JsonlEvidenceWriter;
  private readonly now: () => string;
  private readonly ownsWriter: boolean;
  private readonly evidencePath?: string;
  private readonly stderrPath?: string;
  private stderrPersisted = false;
  private readonly startedAt: string;
  private readonly cwd: string;
  private readonly args: string[];
  private lineCount = 0;
  private nextLineNumber = 1;
  private frameCount = 0;
  private lineQueue: Promise<void> = Promise.resolve();
  private pendingLineParts: Buffer[] = [];
  private pendingLineBytes = 0;
  private protocolFailureQueued = false;
  private readonly waitPromise: Promise<ProtocolProcessResult>;
  private termination: ProcessTermination = "natural";
  private protocolError: { line: number; message: string; raw?: string } | undefined;
  private recorderError: string | undefined;
  private shutdownStarted = false;
  private interruptionStarted = false;
  private childError: string | undefined;
  private signalQueue: Promise<void> = Promise.resolve();
  private abortListener: (() => void) | undefined;

  public constructor(private readonly options: ProtocolProcessOptions) {
    assertNonEmpty(options.command, "Protocol command");
    assertNonEmpty(options.source, "Protocol source");
    this.stdoutLineLimit = positiveInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, "Protocol line limit");
    this.stderrCapture = new BoundedDiagnosticCapture(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES);
    this.shutdownGraceMs = nonnegativeInteger(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, "Shutdown grace period");
    this.killGraceMs = nonnegativeInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "Kill grace period");
    if (this.shutdownGraceMs > MAX_TIMER_MS) throw new Error("Shutdown grace period must not exceed the Node timer maximum.");
    if (this.killGraceMs > MAX_TIMER_MS) throw new Error("Kill grace period must not exceed the Node timer maximum.");
    this.maxInMemoryObservations = positiveInteger(options.maxInMemoryObservations ?? DEFAULT_MAX_IN_MEMORY_OBSERVATIONS, "In-memory observation limit");
    this.now = options.now ?? (() => new Date().toISOString());
    this.startedAt = this.now();
    assertTimestamp(this.startedAt, "Process start timestamp");
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.args = [...(options.args ?? [])];
    let writer: JsonlEvidenceWriter;
    if (options.writer !== undefined) {
      writer = options.writer;
    } else {
      const evidencePath = options.evidencePath ?? resolve(process.cwd(), `.ebo-protocol-${randomUUID()}.jsonl`);
      mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o700 });
      const descriptor = openSync(evidencePath, "wx", 0o600);
      closeSync(descriptor);
      syncDirectory(dirname(resolve(evidencePath)));
      writer = new JsonlEvidenceWriter(evidencePath, {
        maxLineBytes: Math.min(Number.MAX_SAFE_INTEGER, this.stdoutLineLimit * 4 + 1024),
      });
    }
    const configuredEvidencePath = options.evidencePath === undefined ? undefined : resolve(options.evidencePath);
    if (options.writer !== undefined && configuredEvidencePath !== undefined && configuredEvidencePath !== writer.path) {
      throw new Error("Protocol writer path conflicts with evidencePath.");
    }
    this.ownsWriter = options.writer === undefined;
    this.evidencePath = writer.path;
    this.stderrPath = options.stderrPath === undefined ? undefined : resolve(options.stderrPath);
    this.writer = writer;
    this.recorder = new ProtocolEvidenceRecorder(writer, options.source, this.now, this.maxInMemoryObservations);

    const spawnOptions: SpawnOptions = {
      ...options.spawnOptions,
      cwd: this.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: options.spawnOptions?.detached ?? process.platform !== "win32",
    };
    try {
      this.child = spawn(options.command, this.args, spawnOptions);
    } catch (error) {
      this.writer.releaseClaim(INTERNAL_RECORDER_TOKEN);
      throw error;
    }
    this.child.on("error", (error) => {
      this.childError ??= errorMessage(error);
      void this.recorder.recordError(this.childError, undefined, INTERNAL_RECORDER_TOKEN).catch(() => undefined);
    });
    this.attachStreams();
    this.waitPromise = new Promise<ProtocolProcessResult>((resolveResult) => {
      this.child.once("close", (exitCode, signal) => {
        void this.finish(exitCode, signal, resolveResult);
      });
    });
    const abort = () => {
      void this.interrupt();
    };
    this.abortListener = abort;
    if (this.options.signal?.aborted) abort();
    else this.options.signal?.addEventListener("abort", abort, { once: true });
    if (this.childError !== undefined) void this.recorder.recordError(this.childError, undefined, INTERNAL_RECORDER_TOKEN);
  }

  public get pid(): number | undefined {
    return this.child.pid ?? undefined;
  }

  public get stdin(): NodeJS.WritableStream {
    if (this.child.stdin === null) throw new Error("Protocol process stdin is unavailable.");
    return this.child.stdin;
  }

  public get evidence(): ProtocolEvidenceRecorder {
    return this.recorder;
  }

  public wait(): Promise<ProtocolProcessResult> {
    return this.waitPromise;
  }

  public async shutdown(): Promise<ProtocolProcessResult> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.wait();
    this.shutdownStarted = true;
    this.setTermination("shutdown");
    await this.sendSignal("SIGTERM", this.shutdownGraceMs);
    return this.wait();
  }

  public async interrupt(): Promise<ProtocolProcessResult> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.wait();
    this.interruptionStarted = true;
    this.setTermination("interrupted");
    await this.sendSignal("SIGINT", this.shutdownGraceMs);
    return this.wait();
  }

  private attachStreams(): void {
    if (this.child.stderr !== null) {
      this.child.stderr.on("data", (chunk: Buffer) => this.stderrCapture.write(chunk));
    }
    if (this.child.stdout === null) return;
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.child.stdout?.pause();
      try {
        this.consumeStdout(chunk);
      } catch (error) {
        void this.failRecorder(`Protocol output processing failed: ${errorMessage(error)}`);
      }
      void this.lineQueue.finally(() => this.child.stdout?.resume()).catch(() => undefined);
    });
    this.child.stdout.on("end", () => this.flushPendingLine());
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.protocolError !== undefined || this.recorderError !== undefined) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        this.appendPendingLine(chunk.subarray(offset));
        return;
      }
      if (!this.appendPendingLine(chunk.subarray(offset, newline))) return;
      this.queuePendingLine(this.nextLineNumber);
      this.nextLineNumber += 1;
      offset = newline + 1;
    }
  }

  private appendPendingLine(part: Buffer): boolean {
    if (part.length === 0) return true;
    this.pendingLineBytes += part.length;
    if (this.pendingLineBytes > this.stdoutLineLimit) {
      this.pendingLineParts = [];
      this.pendingLineBytes = 0;
      if (!this.protocolFailureQueued) {
        this.protocolFailureQueued = true;
        const line = this.nextLineNumber;
        this.lineQueue = this.lineQueue
          .then(() => this.failProtocol(`Protocol line ${line} exceeds the configured byte limit.`, undefined, line))
          .catch((error) => this.failRecorder(`Protocol evidence recording failed: ${errorMessage(error)}`));
      }
      return false;
    }
    this.pendingLineParts.push(part);
    return true;
  }

  private queuePendingLine(lineNumber: number): void {
    const bytes = Buffer.concat(this.pendingLineParts, this.pendingLineBytes);
    this.pendingLineParts = [];
    this.pendingLineBytes = 0;
    this.lineQueue = this.lineQueue
      .then(() => this.processLine(bytes, lineNumber))
      .catch((error) => this.failRecorder(`Protocol evidence recording failed: ${errorMessage(error)}`));
  }

  private flushPendingLine(): void {
    if (this.pendingLineBytes > 0 && this.protocolError === undefined && this.recorderError === undefined) {
      this.queuePendingLine(this.nextLineNumber);
      this.nextLineNumber += 1;
    }
  }

  private async processLine(bytes: Buffer, lineNumber: number): Promise<void> {
    if (this.recorderError !== undefined || (this.protocolError !== undefined && lineNumber >= this.protocolError.line)) return;
    this.lineCount = lineNumber;
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      await this.failProtocol(`Malformed UTF-8 protocol output: ${errorMessage(error)}`, bytes.toString("base64"), lineNumber);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line) as unknown;
    } catch (error) {
      await this.failProtocol(`Malformed JSONL protocol output: ${errorMessage(error)}`, line, lineNumber);
      return;
    }
    this.frameCount += 1;
    await this.recorder.recordFrame(payload, this.now(), line);
    if (this.options.onFrame !== undefined) {
      const observer = Promise.resolve(this.options.onFrame(payload, this.recorder));
      const outcome = await settleObserver(observer, this.shutdownGraceMs);
      if (outcome.status === "failed") throw outcome.error;
      if (outcome.status === "timed-out") {
        this.recorder.fence();
        throw new Error("Protocol frame observer exceeded its grace period.");
      }
    }
  }

  private async failProtocol(message: string, raw?: string, line = this.nextLineNumber): Promise<void> {
    if (this.protocolError !== undefined) return;
    this.protocolError = { line, message, ...(raw === undefined ? {} : { raw }) };
    this.setTermination("malformed");
    try {
      await this.recorder.recordError(message, raw === undefined ? undefined : { raw }, INTERNAL_RECORDER_TOKEN);
    } catch (error) {
      this.childError ??= `Protocol error evidence could not be persisted: ${errorMessage(error)}`;
    }
    void this.sendSignal("SIGTERM", this.shutdownGraceMs);
  }

  private async failRecorder(message: string): Promise<void> {
    if (this.recorderError !== undefined || this.protocolError !== undefined) return;
    this.recorderError = message;
    this.setTermination("recorder-error");
    try {
      await this.recorder.recordError(message, undefined, INTERNAL_RECORDER_TOKEN);
    } catch (error) {
      this.childError ??= `Protocol error evidence could not be persisted: ${errorMessage(error)}`;
    }
    void this.sendSignal("SIGTERM", this.shutdownGraceMs);
  }

  private setTermination(termination: ProcessTermination): void {
    if (this.termination === "natural") this.termination = termination;
  }

  private sendSignal(signal: NodeJS.Signals, graceMs: number): Promise<void> {
    const operation = this.signalQueue.then(() => this.sendSignalNow(signal, graceMs));
    this.signalQueue = operation.catch(() => undefined);
    return operation;
  }

  private async sendSignalNow(signal: NodeJS.Signals, graceMs: number): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform !== "win32" && this.options.spawnOptions?.detached !== false) {
        process.kill(-pid, signal);
      } else {
        this.child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.childError ??= errorMessage(error);
      return;
    }
    if (graceMs > 0) await waitForExit(this.child, graceMs);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        if (process.platform !== "win32" && this.options.spawnOptions?.detached !== false) {
          process.kill(-pid, "SIGKILL");
        } else {
          this.child.kill("SIGKILL");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.childError ??= errorMessage(error);
      }
      if (this.killGraceMs > 0) await waitForExit(this.child, this.killGraceMs);
    }
  }

  private async finish(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    resolveResult: (result: ProtocolProcessResult) => void,
  ): Promise<void> {
    try {
      await this.lineQueue;
    } catch (error) {
      this.childError ??= `Protocol output processing failed: ${errorMessage(error)}`;
    }
    this.recorder.fence();
    try {
      await this.recorder.flush();
      await this.recorder.recordProcess(
        signal === null && exitCode === 0 ? "exited" : "terminated",
        { exitCode, signal, pid: this.child.pid ?? null },
        INTERNAL_RECORDER_TOKEN,
      );
      await this.recorder.flush();
    } catch (error) {
      this.childError ??= `Protocol evidence could not be persisted: ${errorMessage(error)}`;
    }
    if (this.options.signal !== undefined && this.abortListener !== undefined) {
      this.options.signal.removeEventListener("abort", this.abortListener);
    }
    const stderr = this.stderrCapture.result();
    if (this.stderrPath !== undefined) {
      let diagnosticFile: FileHandle | undefined;
      try {
        await mkdir(dirname(this.stderrPath), { recursive: true, mode: 0o700 });
        diagnosticFile = await open(this.stderrPath, "wx", 0o600);
        await diagnosticFile.write(stderr.bytes);
        await diagnosticFile.sync();
        await diagnosticFile.close();
        diagnosticFile = undefined;
        syncDirectory(dirname(this.stderrPath));
        this.stderrPersisted = true;
      } catch (error) {
        await diagnosticFile?.close().catch(() => undefined);
        this.childError ??= `stderr evidence could not be persisted: ${errorMessage(error)}`;
      }
    }
    if (this.ownsWriter) {
      // The process record above is durable before the writer is closed.
      try {
        await this.recorder.close();
      } catch (error) {
        this.childError ??= `Protocol evidence could not be closed: ${errorMessage(error)}`;
      }
    }
    let endedAt: string;
    try {
      endedAt = this.now();
    } catch (error) {
      this.childError ??= `Process completion timestamp could not be recorded: ${errorMessage(error)}`;
      endedAt = this.startedAt;
    }
    const termination = this.termination;
    const status = this.protocolError !== undefined
      ? "malformed"
      : this.recorderError !== undefined || this.childError !== undefined
        ? "failed"
        : this.termination === "interrupted"
          ? "interrupted"
          : this.termination === "shutdown"
            ? "shutdown"
            : exitCode === 0 && signal === null
              ? "completed"
              : "failed";
    const result: ProtocolProcessResult = {
      status,
      partial: status === "interrupted" || status === "malformed" || status === "failed",
      protocolOnly: true,
      launch: {
        command: this.options.command,
        args: this.args,
        cwd: this.cwd,
        pid: this.child.pid ?? null,
        startedAt: this.startedAt,
        endedAt,
        exitCode,
        signal,
      },
      termination,
      stdoutFrames: this.frameCount,
      stderr,
      ...(this.protocolError === undefined ? {} : { protocolError: this.protocolError }),
      ...(this.childError === undefined && this.recorderError === undefined ? {} : { error: this.childError ?? this.recorderError }),
      ...(this.recorderError === undefined ? {} : { recorderError: this.recorderError }),
      ...(this.evidencePath === undefined || this.writer.count === 0 ? {} : { evidencePath: this.evidencePath }),
      ...(this.stderrPersisted && this.stderrPath !== undefined ? { stderrPath: this.stderrPath } : {}),
      droppedObservations: this.recorder.droppedObservations,
      observations: [...this.recorder.observations],
    };
    resolveResult(result);
  }
}

export function spawnProtocolProcess(options: ProtocolProcessOptions): ProtocolProcess {
  return new ProtocolProcess(options);
}

export async function runProtocolProcess(options: ProtocolProcessOptions): Promise<ProtocolProcessResult> {
  return spawnProtocolProcess(options).wait();
}

export const spawnJsonlProcess = spawnProtocolProcess;
export const runJsonlProcess = runProtocolProcess;

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalWriterPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let parent: string;
    try {
      parent = realpathSync.native(dirname(path));
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
      parent = resolve(dirname(path));
    }
    return resolve(parent, basename(path));
  }
}

function writerPathIsReserved(path: string): boolean {
  const canonicalPath = canonicalWriterPath(path);
  if (CLAIMED_WRITER_PATHS.has(canonicalPath)) return true;
  if (isHardLinkedPath(canonicalPath)) return true;
  try {
    lstatSync(`${canonicalPath}.protocol.lock`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isHardLinkedPath(path: string): boolean {
  try {
    return statSync(path).nlink > 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function rejectHardLinkedPath(path: string): void {
  if (isHardLinkedPath(path)) throw new Error("JSONL evidence path has multiple hard links and cannot be claimed safely.");
}

function recoverWriterSequence(path: string): number {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (bytes.length === 0) return 0;
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw new Error("Existing JSONL evidence stream has an unterminated final record.");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let sequence = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Existing JSONL evidence line ${index + 1} is malformed: ${errorMessage(error)}`);
    }
    const candidate = isRecord(value) ? value.sequence : undefined;
    if (!isRecord(value) || value.schemaVersion !== "ebo.protocol-observation/v1"
        || typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate !== sequence + 1) {
      throw new Error(`Existing JSONL evidence line ${index + 1} is not a contiguous protocol observation.`);
    }
    assertRecoveredObservation(value, index + 1);
    sequence = candidate;
  }
  return sequence;
}

function assertRecoveredObservation(value: Record<string, unknown>, line: number): void {
  if (typeof value.observedAt !== "string" || value.observedAt.trim() === "") {
    throw new Error(`Existing JSONL evidence line ${line} has no valid observation timestamp.`);
  }
  const kind = value.kind;
  if (!["frame", "request", "response", "notification", "completion", "capability", "error", "process"].includes(String(kind))) {
    throw new Error(`Existing JSONL evidence line ${line} has an invalid observation kind.`);
  }
  if (typeof value.source !== "string" || value.source.trim() === "") {
    throw new Error(`Existing JSONL evidence line ${line} has no valid observation source.`);
  }
  if (value.stream !== undefined && value.stream !== "stdout" && value.stream !== "stderr") {
    throw new Error(`Existing JSONL evidence line ${line} has an invalid observation stream.`);
  }
  for (const field of ["method", "sourceIdentity", "raw", "status", "capability"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || value[field].trim() === "")) {
      throw new Error(`Existing JSONL evidence line ${line} has an invalid ${field}.`);
    }
  }
  if (value.id !== undefined && (typeof value.id === "number" && !Number.isFinite(value.id)
      || typeof value.id !== "string" && typeof value.id !== "number" && value.id !== null)) {
    throw new Error(`Existing JSONL evidence line ${line} has an invalid protocol identity.`);
  }
  if (kind === "frame" && !Object.hasOwn(value, "payload")) {
    throw new Error(`Existing JSONL evidence line ${line} is missing frame payload.`);
  }
  if ((kind === "request" || kind === "response" || kind === "notification")
      && (typeof value.method !== "string" || value.method.trim() === "")) {
    throw new Error(`Existing JSONL evidence line ${line} is missing protocol method.`);
  }
  if (kind === "completion" && (!Object.hasOwn(value, "evidence") || typeof value.status !== "string" || value.status.trim() === "")) {
    throw new Error(`Existing JSONL evidence line ${line} is missing completion evidence.`);
  }
  if (kind === "capability" && (typeof value.capability !== "string" || value.capability.trim() === ""
      || !["available", "unsupported", "missing", "not-checked"].includes(String(value.status)))) {
    throw new Error(`Existing JSONL evidence line ${line} has invalid capability evidence.`);
  }
  if ((kind === "error" || kind === "process") && (typeof value.status !== "string" || value.status.trim() === "")) {
    throw new Error(`Existing JSONL evidence line ${line} is missing status evidence.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new Error(`${label} is required.`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is invalid.`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJsonValue(value: unknown, label: string): unknown {
  assertJsonValue(value, label, new Set<object>());
  return structuredClone(value);
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

async function settleObserver<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{ status: "completed"; value: T } | { status: "failed"; error: unknown } | { status: "timed-out" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ status: "completed" as const, value }), (error) => ({ status: "failed" as const, error })),
      new Promise<{ status: "timed-out" }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ status: "timed-out" }), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForExit(child: ChildProcess, milliseconds: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
