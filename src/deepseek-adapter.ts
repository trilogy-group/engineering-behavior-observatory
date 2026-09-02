import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  HarnessClient,
  type HarnessClientOptions,
  type HarnessNotification,
  type NotificationSubscription,
  type ContentBlock,
} from "@deepseek-ai/dsh-sdk-client";
import type {
  InitializeParams,
  InitializeResult,
} from "@deepseek-ai/dsh-sdk-protocol";

import { canonicalizeMetadata, digestBytes, validateArtifact } from "./artifacts.js";
import type { HarnessExecutionContext, HarnessExecutionResult } from "./lifecycle.js";
import { JsonlEvidenceWriter } from "./process-protocol.js";
import type {
  AdapterCapabilityProfile,
  HarnessAdapter,
  NormalizationResult,
  QualifiedNativeCapture,
  UniformAttributeValue,
  UniformEvent,
  UniformEventFamily,
} from "./uniform-events.js";

export const DEEPSEEK_SDK_VERSION = "0.1.1-rc.2";
export const DEEPSEEK_ADAPTER_ID = "deepseek-harness-sdk";
export const DEEPSEEK_HARNESS_ID = "deepseek-harness";

type DigestString = `sha256:${string}`;

export type DeepSeekFileReference = {
  locator: string;
  digest: DigestString;
};

export type DeepSeekRuntimeComposition = {
  schemaVersion: "ebo.deepseek-runtime-composition/v1";
  id: string;
  launch: {
    command: string;
    args: string[];
    processCwd: string;
    profile: string;
    dshHome?: string;
    runtimeArtifact: DeepSeekFileReference;
  };
  workspaceCwd: string;
  runtime: {
    clientPackage: "@deepseek-ai/dsh-sdk-client";
    clientVersion: string;
    protocolPackage: "@deepseek-ai/dsh-sdk-protocol";
    protocolVersion: string;
  };
  route: {
    provider: string;
    model: string;
    maxTokens?: number;
  };
  cordis: DeepSeekFileReference;
  patches: DeepSeekFileReference[];
  plugins: Array<{ name: string; configuration?: DeepSeekFileReference }>;
  environment: {
    mode: "replace";
    allowedKeys: string[];
    secretKeys: string[];
  };
  telemetry: {
    status: "enabled" | "disabled";
    nativeSpans: "available" | "unsupported" | "not-checked";
    artifact?: DeepSeekFileReference;
  };
};

export type DeepSeekRuntimeCompositionInput = {
  id: string;
  baseDir: string;
  dshBin: string;
  profile: string;
  cordisPath: string;
  patches?: readonly string[];
  processCwd: string;
  workspaceCwd: string;
  dshHome?: string;
  provider: string;
  model: string;
  maxTokens?: number;
  plugins: ReadonlyArray<{ name: string; configurationPath?: string }>;
  environment: { allowedKeys: readonly string[]; secretKeys: readonly string[] };
  telemetry: { status: "enabled" | "disabled"; nativeSpans: "available" | "unsupported" | "not-checked"; artifactPath?: string };
};

export type DeepSeekCapabilities = {
  protocolVersionNegotiation: "unsupported";
  promptCancellation: "unsupported";
  sessionClose: "unsupported";
  promptResult: "unsupported";
  sessionEvents: "available";
  sessionStatus: "available";
  subagentNotifications: "available";
  telemetry: "available" | "unsupported";
  nativeSpans: "available" | "unsupported" | "not-checked";
  completionEvidence: "agent/inbox/spliced-to-session.status:idle";
};

export type DeepSeekNativeObservation = {
  schemaVersion: "ebo.deepseek-native-observation/v1";
  sequence: number;
  observedAt: string;
  kind: "composition" | "capability" | "request" | "response" | "notification" | "diagnostic" | "error";
  method?: string;
  sessionId?: string;
  sourceIdentity?: string;
  stream?: "stderr";
  payload?: unknown;
};

export type DeepSeekCaptureReport = {
  status: "completed" | "failed" | "stopped" | "interrupted";
  composition: DeepSeekRuntimeComposition;
  capabilities: DeepSeekCapabilities;
  records: readonly DeepSeekNativeObservation[];
  serverInfo?: InitializeResult["serverInfo"];
  messageId?: string;
  receiptSequence?: number;
  idleSequence?: number;
  relatedSessionIds: readonly string[];
  error?: string;
  captureError?: string;
  stderr?: string;
};

export type DeepSeekHarnessConfiguration = {
  composition: DeepSeekRuntimeComposition;
  input: string | ContentBlock[];
  sessionId: string;
  env: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  activityTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  disposeEofGraceMs?: number;
  disposeGraceMs?: number;
};

export type DeepSeekAdapterRequest = {
  context: HarnessExecutionContext;
  configuration: DeepSeekHarnessConfiguration;
  capture: DeepSeekNativeCapture;
};

export class DeepSeekNativeCapture {
  readonly path: string;
  readonly #writer: JsonlEvidenceWriter;
  readonly #records: DeepSeekNativeObservation[] = [];

  public constructor(path: string) {
    this.path = resolve(path);
    this.#writer = new JsonlEvidenceWriter(this.path, { exclusive: true });
  }

  public async record(input: Omit<DeepSeekNativeObservation, "schemaVersion" | "sequence" | "observedAt">): Promise<DeepSeekNativeObservation> {
    const record: DeepSeekNativeObservation = {
      schemaVersion: "ebo.deepseek-native-observation/v1",
      sequence: this.#records.length + 1,
      observedAt: new Date().toISOString(),
      ...structuredClone(input),
    };
    await this.#writer.append(record);
    this.#records.push(record);
    return structuredClone(record);
  }

  public report(): readonly DeepSeekNativeObservation[] {
    return structuredClone(this.#records);
  }

  public flush(): Promise<void> {
    return this.#writer.flush();
  }

  public close(): Promise<void> {
    return this.#writer.close();
  }
}

export function createDeepSeekRuntimeComposition(input: DeepSeekRuntimeCompositionInput): DeepSeekRuntimeComposition {
  const baseDir = resolve(input.baseDir);
  const dshBin = resolve(baseDir, input.dshBin);
  const processCwd = resolve(baseDir, input.processCwd);
  const workspaceCwd = resolve(baseDir, input.workspaceCwd);
  const profile = required(input.profile, "DeepSeek profile");
  const cordisPath = resolve(baseDir, input.cordisPath);
  const patches = [...new Set([cordisPath, ...(input.patches ?? []).map((path) => resolve(baseDir, path))])];
  const pluginNames = input.plugins.map((plugin) => required(plugin.name, "DeepSeek plugin name"));
  if (new Set(pluginNames).size !== pluginNames.length) throw new Error("DeepSeek plugin names must be unique.");
  const composition: DeepSeekRuntimeComposition = {
    schemaVersion: "ebo.deepseek-runtime-composition/v1",
    id: required(input.id, "DeepSeek composition ID"),
    launch: {
      command: process.execPath,
      args: [dshBin, "--profile", profile, ...patches.flatMap((path) => ["--patch", path])],
      processCwd,
      profile,
      ...(input.dshHome === undefined ? {} : { dshHome: resolve(baseDir, input.dshHome) }),
      runtimeArtifact: fileReference(baseDir, dshBin),
    },
    workspaceCwd,
    runtime: {
      clientPackage: "@deepseek-ai/dsh-sdk-client",
      clientVersion: DEEPSEEK_SDK_VERSION,
      protocolPackage: "@deepseek-ai/dsh-sdk-protocol",
      protocolVersion: DEEPSEEK_SDK_VERSION,
    },
    route: {
      provider: required(input.provider, "DeepSeek provider"),
      model: required(input.model, "DeepSeek model"),
      ...(input.maxTokens === undefined ? {} : { maxTokens: positiveInteger(input.maxTokens, "DeepSeek max tokens") }),
    },
    cordis: fileReference(baseDir, cordisPath),
    patches: patches.map((path) => fileReference(baseDir, path)),
    plugins: input.plugins.map((plugin, index) => ({
      name: pluginNames[index]!,
      ...(plugin.configurationPath === undefined ? {} : { configuration: fileReference(baseDir, plugin.configurationPath) }),
    })),
    environment: {
      mode: "replace",
      allowedKeys: [...new Set(input.environment.allowedKeys)].sort(),
      secretKeys: [...new Set(input.environment.secretKeys)].sort(),
    },
    telemetry: {
      status: input.telemetry.status,
      nativeSpans: input.telemetry.nativeSpans,
      ...(input.telemetry.artifactPath === undefined ? {} : { artifact: fileReference(baseDir, input.telemetry.artifactPath) }),
    },
  };
  assertArtifact("DeepSeek runtime composition", composition);
  if (composition.environment.secretKeys.some((key) => !composition.environment.allowedKeys.includes(key))) {
    throw new Error("DeepSeek secret environment keys must also be allowlisted.");
  }
  return composition;
}

export function deepSeekCompositionDigest(composition: DeepSeekRuntimeComposition): DigestString {
  assertArtifact("DeepSeek runtime composition", composition);
  return digestString(Buffer.from(canonicalizeMetadata(composition)));
}

export function deepSeekCapabilities(composition: DeepSeekRuntimeComposition): DeepSeekCapabilities {
  return {
    protocolVersionNegotiation: "unsupported",
    promptCancellation: "unsupported",
    sessionClose: "unsupported",
    promptResult: "unsupported",
    sessionEvents: "available",
    sessionStatus: "available",
    subagentNotifications: "available",
    telemetry: composition.telemetry.status === "enabled" ? "available" : "unsupported",
    nativeSpans: composition.telemetry.nativeSpans,
    completionEvidence: "agent/inbox/spliced-to-session.status:idle",
  };
}

export async function executeDeepSeekHarness(
  context: HarnessExecutionContext,
  configuration: DeepSeekHarnessConfiguration,
  capture: DeepSeekNativeCapture,
): Promise<HarnessExecutionResult> {
  validateConfiguration(configuration, context);
  const composition = structuredClone(configuration.composition);
  const capabilities = deepSeekCapabilities(composition);
  const client = new HarnessClient(clientOptions(configuration));
  const subscription = client.subscribeSessionTree(configuration.sessionId);
  const sensitiveValues = composition.environment.secretKeys.flatMap((key) => configuration.env[key] ?? []);
  let status: DeepSeekCaptureReport["status"] = "failed";
  let serverInfo: InitializeResult["serverInfo"] | undefined;
  let messageId: string | undefined;
  let receiptSequence: number | undefined;
  let idleSequence: number | undefined;
  let failure: unknown;
  let stderr: string | undefined;
  let captureError: string | undefined;
  let shutdownResult: { status: "completed" | "failed"; error?: string } = { status: "completed" };
  context.registerShutdown(() => client.close());
  const closeOnAbort = () => { void client.close().catch(() => undefined); };
  if (!context.signal.aborted) context.signal.addEventListener("abort", closeOnAbort, { once: true });

  await capture.record({ kind: "composition", payload: composition });
  await capture.record({ kind: "capability", payload: capabilities });
  try {
    throwIfAborted(context.signal);
    const initialize: InitializeParams = {
      cwd: composition.workspaceCwd,
      provider: composition.route.provider,
      model: composition.route.model,
      ...(composition.route.maxTokens === undefined ? {} : { maxTokens: composition.route.maxTokens }),
    };
    await capture.record({ kind: "request", method: "initialize", payload: initialize });
    client.start();
    ({ serverInfo } = await client.initialize(initialize));
    await capture.record({ kind: "response", method: "initialize", payload: { serverInfo } });
    throwIfAborted(context.signal);

    const contentBlocks = typeof configuration.input === "string"
      ? [{ type: "text" as const, text: configuration.input }]
      : configuration.input;
    await capture.record({ kind: "request", method: "session/prompt", sessionId: configuration.sessionId, payload: { contentBlocks } });
    throwIfAborted(context.signal);
    messageId = await client.prompt(configuration.sessionId, contentBlocks);
    await capture.record({ kind: "response", method: "session/prompt", sessionId: configuration.sessionId, sourceIdentity: messageId, payload: { messageId } });

    const deadline = Date.now() + (configuration.activityTimeoutMs ?? context.budgetMs ?? 60_000);
    while (idleSequence === undefined) {
      const notification = await nextNotification(subscription, context.signal, deadline);
      const sourceIdentity = notificationIdentity(notification);
      const record = await capture.record({
        kind: "notification",
        method: notification.method,
        sessionId: notificationSessionId(notification, configuration.sessionId),
        ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
        payload: notification.params,
      });
      if (receiptSequence === undefined && isInboxReceipt(notification, configuration.sessionId, messageId)) {
        receiptSequence = record.sequence;
      }
      if (receiptSequence !== undefined && isRootIdle(notification, configuration.sessionId)) {
        idleSequence = record.sequence;
      }
    }
    status = "completed";
  } catch (error) {
    failure = error;
    status = context.signal.aborted || error instanceof DeepSeekInterruptedError
      ? "interrupted"
      : error instanceof DeepSeekActivityTimeoutError ? "stopped" : "failed";
    const diagnostic = sanitizedError(error, sensitiveValues);
    stderr = extractStderr(diagnostic);
    try {
      await capture.record({ kind: "error", payload: { name: errorName(error), message: withoutStderr(diagnostic) } });
      if (stderr !== undefined) await capture.record({ kind: "diagnostic", stream: "stderr", payload: { text: stderr } });
    } catch (recordError) {
      captureError = sanitizedError(recordError, sensitiveValues);
    }
  } finally {
    context.signal.removeEventListener("abort", closeOnAbort);
    subscription.close();
    try {
      await capture.record({ kind: "request", method: "client.close" });
    } catch (error) {
      captureError ??= sanitizedError(error, sensitiveValues);
    }
    try {
      await client.close();
      try {
        await capture.record({ kind: "response", method: "client.close", payload: { status: "runtime-reaped" } });
      } catch (error) {
        captureError ??= sanitizedError(error, sensitiveValues);
      }
    } catch (error) {
      const message = sanitizedError(error, sensitiveValues);
      shutdownResult = { status: "failed", error: message };
      try {
        await capture.record({ kind: "error", method: "client.close", payload: { name: errorName(error), message: withoutStderr(message) } });
      } catch (recordError) {
        captureError ??= sanitizedError(recordError, sensitiveValues);
      }
      const tail = extractStderr(message);
      if (tail !== undefined) {
        stderr = tail;
        try {
          await capture.record({ kind: "diagnostic", method: "client.close", stream: "stderr", payload: { text: tail } });
        } catch (recordError) {
          captureError ??= sanitizedError(recordError, sensitiveValues);
        }
      }
      if (status === "completed") {
        status = "failed";
        failure = error;
      }
    }
  }

  const report: DeepSeekCaptureReport = {
    status,
    composition,
    capabilities,
    records: capture.report(),
    relatedSessionIds: relatedSessionIds(capture.report(), configuration.sessionId),
    ...(serverInfo === undefined ? {} : { serverInfo }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(receiptSequence === undefined ? {} : { receiptSequence }),
    ...(idleSequence === undefined ? {} : { idleSequence }),
    ...(failure === undefined ? {} : { error: sanitizedError(failure, sensitiveValues) }),
    ...(captureError === undefined ? {} : { captureError }),
    ...(stderr === undefined ? {} : { stderr }),
  };
  return {
    status,
    ...(status === "failed" ? { failureClass: "infrastructure" as const } : {}),
    ...(status === "stopped" ? { stopReason: "budget" as const } : {}),
    ...(report.error === undefined ? {} : { error: report.error }),
    ...(captureError === undefined ? {} : { captureError }),
    completionEvidence: {
      authority: "durable-receipt-to-whole-agent-idle",
      ...(messageId === undefined ? {} : { messageId }),
      ...(receiptSequence === undefined ? {} : { receiptSequence }),
      ...(idleSequence === undefined ? {} : { idleSequence }),
      promptResult: { status: "unsupported" },
    },
    evidence: report,
    shutdownResult,
  };
}

export function qualifiedDeepSeekCapture(
  runId: string,
  attemptId: string,
  report: DeepSeekCaptureReport,
  artifactId = "deepseek-session",
): QualifiedNativeCapture<DeepSeekNativeObservation> {
  if (report.captureError !== undefined) throw new Error(`DeepSeek capture is unqualified: ${report.captureError}`);
  const hasSessionEvent = report.records.some((record) => record.method === "session.event");
  const has = (kind: DeepSeekNativeObservation["kind"], method?: string) => report.records.some((record) =>
    record.kind === kind && (method === undefined || record.method === method));
  const requiredBoundary = has("composition") && has("capability")
    && has("response", "initialize") && has("response", "session/prompt") && hasSessionEvent;
  if (!requiredBoundary) throw new Error("DeepSeek capture is unqualified: runtime, prompt receipt, or durable session evidence is missing.");
  const complete = report.status === "completed" && report.receiptSequence !== undefined && report.idleSequence !== undefined
    && has("response", "client.close");
  if (report.status === "completed" && !complete) throw new Error("Completed DeepSeek capture lacks durable receipt-to-idle or clean runtime-reap evidence.");
  return {
    runId,
    attemptId,
    qualification: complete ? "qualified" : "qualified-with-gaps",
    records: report.records.map((record) => ({
      reference: { artifactId, recordLocator: `line:${record.sequence}` },
      record,
    })),
  };
}

export const DEEPSEEK_CAPABILITY_PROFILE: AdapterCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: DEEPSEEK_ADAPTER_ID,
  harness: DEEPSEEK_HARNESS_ID,
  nativeTypes: [
    "composition", "capability", "diagnostic", "error", "initialize", "session/prompt",
    "session.event", "session.status", "subagent.started", "subagent.finished", "client.close",
  ],
  families: {
    message: { status: "available" },
    "model-request": { status: "available" },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "unsupported" },
    delegation: { status: "available" },
    artifact: { status: "partial" },
    validation: { status: "partial" },
    runtime: { status: "available" },
    outcome: { status: "available" },
  },
  evidence: {
    nativeOrder: { status: "partial" },
    nativeTime: { status: "partial" },
    parentage: { status: "partial" },
    content: { status: "partial" },
  },
};

export function normalizeDeepSeekCapture(
  input: QualifiedNativeCapture<DeepSeekNativeObservation>,
): NormalizationResult {
  const eventBySessionSequence = new Map<string, string>();
  const mapped = input.records.flatMap(({ reference, record }) => {
    const family = eventFamily(record);
    if (family === undefined) return [];
    const id = `${input.attemptId}-deepseek-${record.sequence}`;
    const event = nativeSessionEvent(record);
    const sessionId = nativeSessionId(record);
    const nativeSequence = nativeSessionSequence(event);
    if (sessionId !== undefined && nativeSequence !== undefined) {
      eventBySessionSequence.set(`${sessionId}:${nativeSequence}`, id);
    }
    return [{ reference, record, family, id, event, sessionId, nativeSequence }];
  });
  const events: UniformEvent[] = mapped.map(({ reference, record, family, id, event, sessionId, nativeSequence }) => {
    const sourceSequences = nativeSourceSequences(event);
    const known = sessionId === undefined ? [] : sourceSequences.flatMap((sequence) => {
      const eventId = eventBySessionSequence.get(`${sessionId}:${sequence}`);
      return eventId === undefined ? [] : [{ kind: "caused-by" as const, eventId }];
    });
    return {
      schemaVersion: "ebo.uniform-event/v1",
      id,
      runId: input.runId,
      attemptId: input.attemptId,
      source: {
        harness: DEEPSEEK_HARNESS_ID,
        nativeType: record.method ?? record.kind,
        nativeReference: reference,
      },
      nativeOrder: nativeSequence === undefined || sessionId === undefined
        ? { status: "known", value: record.sequence, domain: "deepseek-sdk-observations" }
        : { status: "known", value: nativeSequence, domain: `deepseek-session:${sessionId}` },
      nativeTime: nativeSessionTime(event),
      actor: { kind: actorKind(record, event) },
      family,
      phase: eventPhase(record, event),
      scope: sessionId === undefined
        ? { kind: "attempt", id: input.attemptId }
        : { kind: "session", id: sessionId },
      relations: {
        parent: { status: "unknown", reason: "native record does not declare a uniform parent event" },
        known,
      },
      attributes: eventAttributes(record, event),
      content: hasReferencedContent(record, event)
        ? { status: "known", value: [{ nativeReference: { ...reference, recordLocator: `${reference.recordLocator}#/payload` } }] }
        : { status: "unknown", reason: "native record carries no mapped content" },
    };
  });
  const mappedReferences = new Set(mapped.map(({ reference }) => referenceKey(reference)));
  return {
    events,
    unmapped: input.records.flatMap(({ reference, record }) => mappedReferences.has(referenceKey(reference))
      ? []
      : [{ reference, reason: `native record ${record.method ?? record.kind} has no uniform mapping` }]),
  };
}

export function createDeepSeekHarnessAdapter(): HarnessAdapter<DeepSeekAdapterRequest, DeepSeekNativeObservation> {
  return {
    capture: {
      id: DEEPSEEK_ADAPTER_ID,
      harness: DEEPSEEK_HARNESS_ID,
      capture: async ({ context, configuration, capture }) => {
        const result = await executeDeepSeekHarness(context, configuration, capture);
        return qualifiedDeepSeekCapture(context.run.id, context.attempt.id, result.evidence as DeepSeekCaptureReport);
      },
    },
    normalization: {
      id: DEEPSEEK_ADAPTER_ID,
      harness: DEEPSEEK_HARNESS_ID,
      capabilityProfile: DEEPSEEK_CAPABILITY_PROFILE,
      normalize: async (input) => normalizeDeepSeekCapture(input),
    },
  };
}

function clientOptions(configuration: DeepSeekHarnessConfiguration): HarnessClientOptions {
  const composition = configuration.composition;
  return {
    command: composition.launch.command,
    args: [...composition.launch.args],
    cwd: composition.launch.processCwd,
    env: structuredClone(configuration.env),
    ...(configuration.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: configuration.requestTimeoutMs }),
    ...(configuration.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: configuration.shutdownTimeoutMs }),
    ...(configuration.disposeEofGraceMs === undefined ? {} : { disposeEofGraceMs: configuration.disposeEofGraceMs }),
    ...(configuration.disposeGraceMs === undefined ? {} : { disposeGraceMs: configuration.disposeGraceMs }),
  };
}

function validateConfiguration(configuration: DeepSeekHarnessConfiguration, context: HarnessExecutionContext): void {
  assertArtifact("DeepSeek runtime composition", configuration.composition);
  if (configuration.composition.launch.command !== process.execPath
      || configuration.composition.runtime.clientVersion !== DEEPSEEK_SDK_VERSION
      || configuration.composition.runtime.protocolVersion !== DEEPSEEK_SDK_VERSION) {
    throw new Error("DeepSeek runtime composition does not match the pinned public client runtime.");
  }
  const expectedArgs = [
    configuration.composition.launch.runtimeArtifact.locator,
    "--profile",
    configuration.composition.launch.profile,
    ...configuration.composition.patches.flatMap(({ locator }) => ["--patch", locator]),
  ];
  if (JSON.stringify(configuration.composition.launch.args) !== JSON.stringify(expectedArgs)) {
    throw new Error("DeepSeek launch arguments do not match the retained runtime and patch artifacts.");
  }
  if (configuration.sessionId.trim() === "") throw new Error("DeepSeek session ID is required.");
  if (context.workspace?.status !== "ready" || context.workspace.path === undefined
      || resolve(context.workspace.path) !== resolve(configuration.composition.workspaceCwd)) {
    throw new Error("DeepSeek runtime workspace must match the retained ready lifecycle workspace.");
  }
  for (const reference of [
    configuration.composition.cordis,
    configuration.composition.launch.runtimeArtifact,
    ...configuration.composition.patches,
    ...configuration.composition.plugins.flatMap(({ configuration: value }) => value ?? []),
    ...(configuration.composition.telemetry.artifact === undefined ? [] : [configuration.composition.telemetry.artifact]),
  ]) verifyFileReference(reference);
  const keys = Object.keys(configuration.env).sort();
  const allowed = configuration.composition.environment.allowedKeys;
  if (keys.some((key) => !allowed.includes(key))) throw new Error("DeepSeek child environment contains a key outside the recorded policy.");
}

function fileReference(baseDir: string, path: string): DeepSeekFileReference {
  const locator = resolve(baseDir, path);
  return { locator, digest: digestString(readFileSync(locator)) };
}

function verifyFileReference(reference: DeepSeekFileReference): void {
  if (digestString(readFileSync(reference.locator)) !== reference.digest) {
    throw new Error(`DeepSeek configuration digest mismatch for ${reference.locator}.`);
  }
}

function digestString(bytes: Uint8Array): DigestString {
  return `sha256:${digestBytes(bytes).value}`;
}

function assertArtifact(label: string, document: unknown): void {
  const errors = validateArtifact(label, document);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}

function required(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} is required.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

class DeepSeekActivityTimeoutError extends Error {}
class DeepSeekInterruptedError extends Error {}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DeepSeekInterruptedError("DeepSeek activity was interrupted.");
}

async function nextNotification(
  subscription: NotificationSubscription,
  signal: AbortSignal,
  deadline: number,
): Promise<HarnessNotification> {
  if (signal.aborted) throw new DeepSeekInterruptedError("DeepSeek activity was interrupted.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DeepSeekActivityTimeoutError("DeepSeek activity interval timed out.");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      subscription.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeepSeekActivityTimeoutError("DeepSeek activity interval timed out.")), remaining);
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new DeepSeekInterruptedError("DeepSeek activity was interrupted."));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

function isInboxReceipt(notification: HarnessNotification, sessionId: string, messageId: string): boolean {
  if (notification.method !== "session.event" || notification.params.sessionId !== sessionId) return false;
  const event = record(notification.params.event);
  const data = record(event?.data);
  return event?.type === "agent/inbox/spliced" && Array.isArray(data?.inserted)
    && data.inserted.some((message) => record(message)?.id === messageId);
}

function isRootIdle(notification: HarnessNotification, sessionId: string): boolean {
  return notification.method === "session.status"
    && notification.params.sessionId === sessionId
    && notification.params.status === "idle";
}

function notificationIdentity(notification: HarnessNotification): string | undefined {
  if (notification.method === "session.event") {
    const event = record(notification.params.event);
    return typeof event?.seq === "number" ? String(event.seq) : undefined;
  }
  for (const key of ["childSessionId", "sessionId"] as const) {
    if (typeof notification.params[key] === "string") return notification.params[key] as string;
  }
  return undefined;
}

function notificationSessionId(notification: HarnessNotification, rootSessionId: string): string {
  if (typeof notification.params.sessionId === "string") return notification.params.sessionId;
  if (typeof notification.params.childSessionId === "string") return notification.params.childSessionId;
  return rootSessionId;
}

function relatedSessionIds(records: readonly DeepSeekNativeObservation[], rootSessionId: string): string[] {
  const ids = new Set<string>();
  for (const observation of records) {
    const payload = record(observation.payload);
    for (const value of [observation.sessionId, payload?.sessionId, payload?.childSessionId, payload?.parentSessionId]) {
      if (typeof value === "string" && value !== rootSessionId) ids.add(value);
    }
  }
  return [...ids].sort();
}

function eventFamily(recordValue: DeepSeekNativeObservation): UniformEventFamily | undefined {
  if (["composition", "capability", "diagnostic"].includes(recordValue.kind)) return "runtime";
  if (recordValue.kind === "error") return "outcome";
  if (["initialize", "session/prompt", "session.status", "client.close"].includes(recordValue.method ?? "")) return "runtime";
  if (["subagent.started", "subagent.finished"].includes(recordValue.method ?? "")) return "delegation";
  if (recordValue.method !== "session.event") return undefined;
  const type = nativeSessionEvent(recordValue)?.type;
  if (typeof type !== "string") return undefined;
  if (type.startsWith("user/") || type.startsWith("assistant/")) return "message";
  if (type.startsWith("tool/")) return "tool";
  if (type.startsWith("request/")) return "model-request";
  if (type.startsWith("compaction/") || type === "session/end-seed") return "context";
  if (type.startsWith("validation/")) return "validation";
  if (type.startsWith("artifact/")) return "artifact";
  if (type === "turn/end") return "outcome";
  if (type.startsWith("turn/") || type.startsWith("step/") || type.startsWith("hook/") || type === "agent/inbox/spliced") return "runtime";
  return undefined;
}

function nativeSessionEvent(recordValue: DeepSeekNativeObservation): Record<string, unknown> | undefined {
  if (recordValue.method !== "session.event") return undefined;
  return record(record(recordValue.payload)?.event);
}

function nativeSessionId(recordValue: DeepSeekNativeObservation): string | undefined {
  const payload = record(recordValue.payload);
  return typeof payload?.sessionId === "string" ? payload.sessionId : recordValue.sessionId;
}

function nativeSessionSequence(event: Record<string, unknown> | undefined): number | undefined {
  return Number.isSafeInteger(event?.seq) && (event?.seq as number) >= 0 ? event?.seq as number : undefined;
}

function nativeSessionTime(event: Record<string, unknown> | undefined): UniformEvent["nativeTime"] {
  if (typeof event?.time !== "number" || !Number.isFinite(event.time)) {
    return { status: "unknown", reason: "native record carries no valid event time" };
  }
  const timestamp = new Date(event.time);
  return Number.isNaN(timestamp.valueOf())
    ? { status: "unknown", reason: "native event time is outside the supported timestamp range" }
    : { status: "known", value: timestamp.toISOString() };
}

function nativeSourceSequences(event: Record<string, unknown> | undefined): number[] {
  return Array.isArray(event?.sourceEventSeqs)
    ? event.sourceEventSeqs.filter((value): value is number => Number.isSafeInteger(value) && (value as number) >= 0)
    : [];
}

function actorKind(
  recordValue: DeepSeekNativeObservation,
  event: Record<string, unknown> | undefined,
): UniformEvent["actor"]["kind"] {
  const type = typeof event?.type === "string" ? event.type : "";
  if (type.startsWith("user/")) return "user";
  if (type.startsWith("assistant/") || type.startsWith("request/")) return "model";
  if (type.startsWith("tool/")) return "tool";
  if (recordValue.method?.startsWith("subagent.")) return "agent";
  return "harness";
}

function eventPhase(
  recordValue: DeepSeekNativeObservation,
  event: Record<string, unknown> | undefined,
): UniformEvent["phase"] {
  const type = typeof event?.type === "string" ? event.type : recordValue.method ?? "";
  if (type.endsWith("/start") || recordValue.kind === "request") return "before";
  if (type.endsWith("/end") || type.endsWith("/result") || recordValue.kind === "response") return "after";
  if (type === "session.status") return "during";
  return "instant";
}

function eventAttributes(
  recordValue: DeepSeekNativeObservation,
  event: Record<string, unknown> | undefined,
): Readonly<Record<string, UniformAttributeValue>> {
  const data = record(event?.data);
  const attributes: Record<string, UniformAttributeValue> = {
    recordKind: recordValue.kind,
    ...(recordValue.method === undefined ? {} : { method: recordValue.method }),
  };
  addAttribute(attributes, "eventType", event?.type);
  addAttribute(attributes, "eventSeq", event?.seq);
  addAttribute(attributes, "surface", event === undefined ? undefined : Object.hasOwn(event, "surfaceOp") ? "surface" : "log-only");
  addAttribute(attributes, "surfaceOp", typeof event?.surfaceOp === "string" ? event.surfaceOp : record(event?.surfaceOp)?.op);
  for (const key of ["turn", "step", "callId", "name", "status", "reason"] as const) addAttribute(attributes, key, data?.[key]);
  return attributes;
}

function addAttribute(target: Record<string, UniformAttributeValue>, key: string, value: unknown): void {
  if (typeof value === "string" && value.length <= 512 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") {
    target[key] = value;
  }
}

function hasReferencedContent(recordValue: DeepSeekNativeObservation, event: Record<string, unknown> | undefined): boolean {
  if (recordValue.method === "session/prompt" && recordValue.kind === "request") return true;
  const type = typeof event?.type === "string" ? event.type : "";
  return type.startsWith("user/") || type.startsWith("assistant/") || type.startsWith("tool/")
    || type.startsWith("compaction/") || type.startsWith("request/") || type.startsWith("validation/");
}

function sanitizedError(error: unknown, sensitiveValues: readonly string[]): string {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const value of sensitiveValues) if (value !== "") message = message.replaceAll(value, "[redacted]");
  return Buffer.from(message).subarray(0, 64 * 1024).toString("utf8");
}

function extractStderr(message: string): string | undefined {
  const marker = "stderr tail:\n";
  const index = message.lastIndexOf(marker);
  return index < 0 ? undefined : message.slice(index + marker.length);
}

function withoutStderr(message: string): string {
  const index = message.lastIndexOf("stderr tail:\n");
  return index < 0 ? message : message.slice(0, index).trimEnd();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function referenceKey(reference: { artifactId: string; recordLocator: string }): string {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}
