import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertNoDuplicateJsonKeys,
  assertUniqueArtifactIdentities,
  canonicalizeMetadata,
  inspectRetainedArtifact,
  readVerifiedArtifact,
  validateArtifact,
  validateExportManifest,
  validateRunManifestEvidence,
  writeArtifactAtomically,
  writeMetadataAtomically,
} from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { digestWorkspace, digestWorkspaceTree } from "./verifiers.js";
import type { ClaudeAgentSdkAttemptEvidence, ClaudeAgentSdkCapabilities } from "./agent-sdk.js";
import type { AttemptIdentity, TerminalRecord } from "./lifecycle.js";
import { readBoundedFile } from "./scheduler.js";

type DigestString = `sha256:${string}`;
type SharingClass = "unknown" | "restricted" | "internal" | "partner" | "public";
type EvidenceKind = "session" | "hook" | "telemetry" | "workspace" | "verifier";
type EvidenceAuthority = "semantic" | "timing-resource" | "outcome";
type CapabilityStatus = "available" | "missing" | "unsupported" | "not-checked";

export type RunBundleRuntimeComponent = {
  source: string;
  name: string;
  version: string;
};

export type RunBundleRun = {
  id: string;
  task: { id: string };
  fixture: { id: string; digest: DigestString };
  model: { provider: string; id: string };
  harness: { id: string; version: string };
  runtime: RunBundleRuntimeComponent[];
  verifier?: { locator: string; digest: DigestString; format?: "commonjs" | "module" };
  native?: { sessionId?: string; traceId?: string };
};

export type RunBundleConfiguration = {
  digest: DigestString;
  budgetDigest: DigestString;
  toolPolicyDigest: DigestString;
};

export type RunBundleEvidenceDescriptor = {
  id: string;
  source: string;
  kind: EvidenceKind | "diagnostic" | "capture-report" | "export-manifest";
  authority: EvidenceAuthority | "capture" | "export";
  mediaType: string;
  digest: DigestString;
  sizeBytes: number;
  sharingClass: SharingClass;
  relativePath: string;
  fingerprint?: DigestString;
  nativeReference?: { type: string; id: string };
  sanitizedFrom?: { artifactId: string; digest: DigestString };
};

export type RunManifest = {
  schemaVersion: "run-manifest/v1";
  bundleId: string;
  run: RunBundleRun;
  attempt: AttemptIdentity;
  configuration: RunBundleConfiguration;
  terminal: TerminalRecord;
  evidence: RunBundleEvidenceDescriptor[];
};

export type CaptureMissingEvidence = {
  kind: string;
  reason: "not-emitted" | "not-collected" | "optional-beta-unavailable" | "process-interrupted" | "policy-restricted" | "unsupported" | "not-checked";
  affects: Array<"semantic" | "timing-resource" | "outcome">;
};

export type RunBundleDefinition = {
  bundleRoot: string;
  bundleId: string;
  run: RunBundleRun;
  attempt: AttemptIdentity;
  configuration: RunBundleConfiguration;
};

export type RegisterRunBundleArtifact = {
  id: string;
  source: string;
  kind: EvidenceKind;
  mediaType: string;
  sharingClass: Exclude<SharingClass, "partner" | "public">;
  relativePath: string;
  fingerprint?: DigestString;
  nativeReference?: { type: string; id: string };
};

export type CaptureWorkspaceOutcomeOptions = {
  startPath: string;
  finalPath: string;
  id?: string;
  source?: string;
  relativePath?: string;
  snapshotRelativePath?: string;
};

export type CapturedWorkspaceOutcome = {
  descriptor: RunBundleEvidenceDescriptor;
  fingerprint: DigestString;
  treeDigest: DigestString;
  format: "patch" | "snapshot";
};

export type CaptureQualificationStatus = "qualified" | "qualified-with-gaps" | "unqualified";
export type CaptureQualificationDimension =
  | "attemptIdentity"
  | "semanticEvidence"
  | "hooks"
  | "telemetry"
  | "workspace"
  | "verifier"
  | "terminal"
  | "sharing";
export type CaptureQualificationReasonCode =
  | "MANIFEST_INVALID"
  | "ATTEMPT_IDENTITY_INVALID"
  | "ARTIFACT_INTEGRITY_INVALID"
  | "NATIVE_JSON_EMPTY"
  | "NATIVE_JSON_MALFORMED"
  | "NATIVE_JSONL_EMPTY"
  | "NATIVE_JSONL_MALFORMED"
  | "SESSION_EVIDENCE_MISSING"
  | "SESSION_IDENTITY_MISSING"
  | "HOOK_EVIDENCE_MISSING"
  | "HOOK_CAPABILITY_NOT_CHECKED"
  | "HOOK_CAPABILITY_VERSION_MISMATCH"
  | "HOOK_SUPPORTED_BUT_MISSING"
  | "HOOK_UNSUPPORTED_BY_PINNED_SDK"
  | "HOOK_CAPABILITY_CONTRADICTION"
  | "TELEMETRY_EVIDENCE_MISSING"
  | "TELEMETRY_RECEIPT_MISSING"
  | "OPTIONAL_BETA_TIMING_UNAVAILABLE"
  | "WORKSPACE_EVIDENCE_MISSING"
  | "WORKSPACE_PATCH_NOT_CHECKED"
  | "WORKSPACE_PATCH_UNUSABLE"
  | "VERIFIER_EVIDENCE_MISSING"
  | "VERIFIER_RESULT_ERROR"
  | "VERIFIER_RESULT_NOT_RUN"
  | "TERMINAL_CLASSIFICATION_INVALID"
  | "INFRASTRUCTURE_FAILURE_MISCLASSIFIED_AS_TASK"
  | "SHARING_CLASSIFICATION_UNKNOWN"
  | "CAPTURE_REPORT_MISSING"
  | "CAPTURE_REPORT_INVALID"
  | "CAPTURE_REPORT_CONTRADICTS_SOURCE"
  | "EXPORT_MANIFEST_INVALID";

export type CaptureQualificationReason = {
  code: CaptureQualificationReasonCode;
  dimension: CaptureQualificationDimension;
  evidenceId?: string;
  detail: string;
};

export type CaptureQualificationReport = {
  status: CaptureQualificationStatus;
  semanticAnalysisUsable: boolean;
  attempt?: AttemptIdentity;
  terminal?: TerminalRecord;
  dimensions: Record<CaptureQualificationDimension, {
    status: "qualified" | "gap" | "unqualified";
    reasonCodes: CaptureQualificationReasonCode[];
  }>;
  reasons: CaptureQualificationReason[];
};

export type CaptureQualificationOptions = {
  startingWorkspacePath?: string;
  hookCapabilities?: Pick<ClaudeAgentSdkCapabilities, "sdkVersion" | "hooks" | "unsupportedHooks">;
  expectedHooks?: readonly string[];
};

const execFileAsync = promisify(execFile);
const MAX_WORKSPACE_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_WORKSPACE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const TAR_COMMAND = process.platform === "win32" ? "tar" : "/usr/bin/tar";
const PROVISIONAL_TERMINAL: TerminalRecord = {
  state: "interrupted",
  failureClass: "infrastructure",
  stopReason: "none",
};
const AUTHORITIES: Record<EvidenceKind, EvidenceAuthority> = {
  session: "semantic",
  hook: "semantic",
  telemetry: "timing-resource",
  workspace: "outcome",
  verifier: "outcome",
};

export async function createRunBundleAssembler(definition: RunBundleDefinition): Promise<RunBundleAssembler> {
  const assembler = new RunBundleAssembler(definition);
  await assembler.initialize();
  return assembler;
}

export class RunBundleAssembler {
  readonly bundleRoot: string;
  readonly bundleId: string;
  readonly attempt: AttemptIdentity;

  private run: RunBundleRun;
  private readonly configuration: RunBundleConfiguration;
  private evidence: RunBundleEvidenceDescriptor[] = [];
  private manifest?: RunManifest;
  private revision = 0;
  private finalized = false;
  private captureMissing: CaptureMissingEvidence[] = [];

  public constructor(definition: RunBundleDefinition) {
    this.bundleRoot = resolve(definition.bundleRoot);
    this.bundleId = definition.bundleId;
    this.run = structuredClone(definition.run);
    this.attempt = structuredClone(definition.attempt);
    this.configuration = structuredClone(definition.configuration);
  }

  public async initialize(): Promise<void> {
    if (this.manifest !== undefined) throw new Error("Run-bundle assembler is already initialized.");
    await mkdir(this.bundleRoot, { recursive: true, mode: 0o700 });
    try {
      await lstat(join(this.bundleRoot, "manifest.json"));
      throw new Error("Run bundle already has a manifest.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.checkpoint([], this.run, PROVISIONAL_TERMINAL);
  }

  public currentManifest(): RunManifest {
    if (this.manifest === undefined) throw new Error("Run-bundle assembler is not initialized.");
    return structuredClone(this.manifest);
  }

  public async registerArtifact(input: RegisterRunBundleArtifact): Promise<RunBundleEvidenceDescriptor> {
    this.assertOpen();
    if (!isSafeArtifactRelativePath(input.relativePath) || input.relativePath.toLowerCase() === "manifest.json") {
      throw new Error(`Artifact path "${input.relativePath}" is unsafe or reserved.`);
    }
    const inspected = await inspectRetainedArtifact(this.bundleRoot, input.relativePath);
    const descriptor: RunBundleEvidenceDescriptor = {
      id: input.id,
      source: input.source,
      kind: input.kind,
      authority: AUTHORITIES[input.kind],
      mediaType: input.mediaType,
      digest: digestString(inspected.digest.value),
      sizeBytes: inspected.sizeBytes,
      sharingClass: input.sharingClass,
      relativePath: input.relativePath,
      ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
      ...(input.nativeReference === undefined ? {} : { nativeReference: structuredClone(input.nativeReference) }),
    };
    const candidateEvidence = [...this.evidence, descriptor];
    assertUniqueArtifactIdentities(candidateEvidence);
    const candidateRun = runWithNativeReference(this.run, descriptor);
    await this.checkpoint(candidateEvidence, candidateRun, PROVISIONAL_TERMINAL);
    return structuredClone(descriptor);
  }

  public async writeJsonArtifact(
    input: RegisterRunBundleArtifact,
    document: unknown,
  ): Promise<RunBundleEvidenceDescriptor> {
    this.assertOpen();
    await writeMetadataAtomically(this.bundleRoot, input.relativePath, document, undefined, { overwrite: false });
    return this.registerArtifact(input);
  }

  public async writeAgentSdkTelemetry(input: {
    evidence: Pick<ClaudeAgentSdkAttemptEvidence, "telemetry" | "usage">;
    traceId?: string;
    id?: string;
    relativePath?: string;
  }): Promise<RunBundleEvidenceDescriptor> {
    if (input.evidence.telemetry === undefined && input.evidence.usage === undefined) {
      throw new Error("Agent SDK telemetry evidence requires telemetry or SDK-reported usage.");
    }
    const previousMissing = this.captureMissing;
    const receipt = input.evidence.telemetry?.receipt;
    this.captureMissing = previousMissing.filter((entry) => !["telemetry", "telemetry-receipt"].includes(entry.kind));
    if (input.evidence.telemetry === undefined || receipt?.status !== "received") {
      const reason = receipt?.status === "not-checked"
        ? "not-checked"
        : receipt?.status === "missing" && receipt.reason === "process-interrupted"
          ? "process-interrupted"
          : "not-collected";
      this.captureMissing = deduplicateMissing([
        ...this.captureMissing,
        { kind: receipt === undefined ? "telemetry" : "telemetry-receipt", reason, affects: ["timing-resource"] },
      ]);
    }
    try {
      return await this.writeJsonArtifact({
        id: input.id ?? "telemetry",
        source: "anthropic-agent-sdk",
        kind: "telemetry",
        mediaType: "application/json",
        sharingClass: "restricted",
        relativePath: input.relativePath ?? "telemetry/agent-sdk.json",
        ...(input.traceId === undefined ? {} : { nativeReference: { type: "trace", id: input.traceId } }),
      }, {
        schemaVersion: "ebo.agent-sdk-telemetry/v1",
        attemptId: this.attempt.id,
        ...(input.evidence.telemetry === undefined ? {} : { telemetry: structuredClone(input.evidence.telemetry) }),
        ...(input.evidence.usage === undefined ? {} : { usage: structuredClone(input.evidence.usage) }),
      });
    } catch (error) {
      this.captureMissing = previousMissing;
      throw error;
    }
  }

  public async captureWorkspaceOutcome(options: CaptureWorkspaceOutcomeOptions): Promise<CapturedWorkspaceOutcome> {
    this.assertOpen();
    const startPath = resolve(options.startPath);
    const finalPath = resolve(options.finalPath);
    const [fingerprint, treeDigest] = await Promise.all([
      digestWorkspace(finalPath) as Promise<DigestString>,
      digestWorkspaceTree(finalPath) as Promise<DigestString>,
    ]);
    const patch = await workspacePatch(startPath, finalPath, treeDigest);
    if (await digestWorkspace(finalPath) !== fingerprint) {
      throw new Error("Final workspace metadata changed while its outcome was being captured.");
    }
    const format = patch === undefined ? "snapshot" : "patch";
    const content = patch ?? await workspaceSnapshot(finalPath, treeDigest);
    const relativePath = format === "patch"
      ? options.relativePath ?? "workspace.patch"
      : options.snapshotRelativePath ?? "workspace.tar.gz";
    await writeArtifactAtomically(this.bundleRoot, relativePath, content, undefined, { overwrite: false });
    const descriptor = await this.registerArtifact({
      id: options.id ?? "workspace",
      source: options.source ?? `workspace-${format}`,
      kind: "workspace",
      mediaType: format === "patch" ? "text/x-diff" : "application/gzip",
      sharingClass: "restricted",
      relativePath,
      fingerprint,
    });
    return { descriptor, fingerprint, treeDigest, format };
  }

  public async finalize(input: {
    terminal: TerminalRecord;
    missingEvidence?: CaptureMissingEvidence[];
  }): Promise<RunManifest> {
    this.assertOpen();
    await this.checkpoint(this.evidence, this.run, structuredClone(input.terminal), input.missingEvidence ?? []);
    this.finalized = true;
    return this.currentManifest();
  }

  private assertOpen(): void {
    if (this.manifest === undefined) throw new Error("Run-bundle assembler is not initialized.");
    if (this.finalized) throw new Error("Run bundle is already finalized.");
  }

  private async checkpoint(
    evidence: RunBundleEvidenceDescriptor[],
    run: RunBundleRun,
    terminal: TerminalRecord,
    missingEvidence: CaptureMissingEvidence[] = [],
  ): Promise<void> {
    const report = captureReport(this.bundleId, evidence, [
      ...this.captureMissing,
      ...missingEvidence,
    ]);
    assertValid("capture-report", report);
    const reportPath = `capture/report-${String(this.revision).padStart(4, "0")}-${randomUUID()}.json`;
    const reportDigest = await writeMetadataAtomically(this.bundleRoot, reportPath, report, undefined, { overwrite: false });
    const reportDescriptor: RunBundleEvidenceDescriptor = {
      id: "capture-report",
      source: "ebo-capture",
      kind: "capture-report",
      authority: "capture",
      mediaType: "application/json",
      digest: digestString(reportDigest.value),
      sizeBytes: Buffer.byteLength(canonicalizeMetadata(report)),
      sharingClass: "internal",
      relativePath: reportPath,
    };
    const manifest: RunManifest = {
      schemaVersion: "run-manifest/v1",
      bundleId: this.bundleId,
      run: structuredClone(run),
      attempt: structuredClone(this.attempt),
      configuration: structuredClone(this.configuration),
      terminal: structuredClone(terminal),
      evidence: [...structuredClone(evidence), reportDescriptor],
    };
    assertValid("manifest.json", manifest);
    const evidenceErrors = validateRunManifestEvidence("manifest.json", manifest, this.bundleRoot);
    if (evidenceErrors.length > 0) throw new Error(formatValidationErrors(evidenceErrors));
    await writeMetadataAtomically(this.bundleRoot, "manifest.json", manifest, undefined, {
      overwrite: this.manifest !== undefined,
    });
    this.evidence = structuredClone(evidence);
    this.run = structuredClone(run);
    this.manifest = structuredClone(manifest);
    this.revision += 1;
  }
}

/** Structurally qualify one retained run bundle without normalizing native evidence. */
export async function qualifyRunBundle(
  bundleRoot: string,
  options: CaptureQualificationOptions = {},
): Promise<CaptureQualificationReport> {
  const report = emptyQualificationReport();
  let document: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(join(resolve(bundleRoot), "manifest.json"), "Run manifest"));
    assertNoDuplicateJsonKeys(text);
    document = JSON.parse(text);
  } catch (error) {
    addQualificationReason(report, "attemptIdentity", "unqualified", "MANIFEST_INVALID", undefined, errorMessage(error));
    return finishQualificationReport(report);
  }
  if (!isRecord(document) || !Array.isArray(document.evidence)) {
    addQualificationReason(report, "attemptIdentity", "unqualified", "MANIFEST_INVALID", undefined, "Run manifest is not a record with evidence.");
    return finishQualificationReport(report);
  }
  const manifest = document as unknown as RunManifest;
  report.attempt = structuredClone(manifest.attempt);
  report.terminal = structuredClone(manifest.terminal);

  const manifestErrors = validateArtifact("manifest.json", manifest);
  for (const error of manifestErrors) {
    const dimension = error.field.startsWith("/attempt") ? "attemptIdentity"
      : error.field.startsWith("/terminal") ? "terminal"
        : "semanticEvidence";
    addQualificationReason(
      report,
      dimension,
      "unqualified",
      dimension === "attemptIdentity" ? "ATTEMPT_IDENTITY_INVALID"
        : dimension === "terminal" ? "TERMINAL_CLASSIFICATION_INVALID" : "MANIFEST_INVALID",
      undefined,
      `${error.field}: ${error.message}`,
    );
  }
  if (manifestErrors.length > 0) return finishQualificationReport(report);

  type ArtifactState = {
    descriptor: RunBundleEvidenceDescriptor;
    document?: unknown;
    records?: Record<string, unknown>[];
    bytes?: Buffer;
    valid: boolean;
  };
  const states = new Map<string, ArtifactState>();
  for (const descriptor of manifest.evidence) {
    const state: ArtifactState = { descriptor, valid: true };
    states.set(descriptor.id, state);
    try {
      state.bytes = await readVerifiedArtifact(bundleRoot, descriptor.relativePath, digestValue(descriptor.digest));
      if (descriptor.mediaType === "application/x-ndjson") {
        state.records = parseNativeJsonl(state.bytes);
      } else if (descriptor.mediaType === "application/json") {
        state.document = parseNativeJson(state.bytes);
      }
    } catch (error) {
      state.valid = false;
      const { dimension, code } = artifactFailure(descriptor, error);
      addQualificationReason(report, dimension, "unqualified", code, descriptor.id, errorMessage(error));
    }
  }

  for (const error of validateRunManifestEvidence("manifest.json", manifest, bundleRoot)) {
    const descriptor = descriptorFromValidationField(manifest, error.field);
    const dimension = descriptor === undefined
      ? error.field.startsWith("/terminal") ? "terminal" : "semanticEvidence"
      : artifactFailure(descriptor, new Error(error.message)).dimension;
    const code = dimension === "terminal" ? "TERMINAL_CLASSIFICATION_INVALID" : "ARTIFACT_INTEGRITY_INVALID";
    addQualificationReason(report, dimension, "unqualified", code, descriptor?.id, `${error.field}: ${error.message}`);
  }

  const valid = (kind: RunBundleEvidenceDescriptor["kind"]): ArtifactState[] => [...states.values()].filter((state) =>
    state.descriptor.kind === kind && state.descriptor.sanitizedFrom === undefined && state.valid);
  const sessions = valid("session");
  const hooks = valid("hook");
  const telemetry = valid("telemetry");
  const workspaces = valid("workspace");
  const verifiers = valid("verifier");
  const captureReports = valid("capture-report");

  if (sessions.length === 0) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "SESSION_EVIDENCE_MISSING", undefined, "No valid native session evidence is retained.");
  }
  const sessionId = manifest.run?.native?.sessionId;
  if (typeof sessionId !== "string" || !sessions.some(({ descriptor }) =>
    descriptor.nativeReference?.type === "session" && descriptor.nativeReference.id === sessionId)) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "SESSION_IDENTITY_MISSING", undefined, "Run session identity is not bound to retained session evidence.");
  }
  if (hooks.length === 0) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "HOOK_EVIDENCE_MISSING", undefined, "No valid native hook evidence is retained.");
  }
  qualifyHooks(report, manifest, hooks, options);

  const captureReport = captureReports[0]?.document;
  qualifyTelemetry(report, telemetry, captureMissingEvidence(captureReport));

  if (workspaces.length === 0) {
    addQualificationReason(report, "workspace", "unqualified", "WORKSPACE_EVIDENCE_MISSING", undefined, "No valid workspace outcome is retained.");
  }
  for (const workspace of workspaces.filter(({ descriptor }) => descriptor.mediaType === "text/x-diff")) {
    if (options.startingWorkspacePath === undefined) {
      addQualificationReason(report, "workspace", "gap", "WORKSPACE_PATCH_NOT_CHECKED", workspace.descriptor.id, "Workspace patch applicability was not checked against its starting fixture.");
    } else if (!await workspacePatchApplies(options.startingWorkspacePath, workspace.bytes!)) {
      addQualificationReason(report, "workspace", "unqualified", "WORKSPACE_PATCH_UNUSABLE", workspace.descriptor.id, "Workspace patch does not reproduce the retained outcome.");
    }
  }

  if (verifiers.length === 0) {
    addQualificationReason(report, "verifier", "unqualified", "VERIFIER_EVIDENCE_MISSING", undefined, "No valid verifier result is retained.");
  }
  for (const verifier of verifiers) {
    const status = isRecord(verifier.document) ? verifier.document.status : undefined;
    if (status === "error") {
      addQualificationReason(report, "verifier", "unqualified", "VERIFIER_RESULT_ERROR", verifier.descriptor.id, "Verifier infrastructure returned an error result.");
      if (manifest.terminal?.failureClass === "task") {
        addQualificationReason(report, "terminal", "unqualified", "INFRASTRUCTURE_FAILURE_MISCLASSIFIED_AS_TASK", verifier.descriptor.id, "Verifier infrastructure error cannot be a model task failure.");
      }
    } else if (status === "not-run") {
      addQualificationReason(report, "verifier", "unqualified", "VERIFIER_RESULT_NOT_RUN", verifier.descriptor.id, "Verifier was not run.");
    }
  }

  if (manifest.evidence.some((descriptor) => descriptor.sharingClass === "unknown")) {
    addQualificationReason(report, "sharing", "gap", "SHARING_CLASSIFICATION_UNKNOWN", undefined, "At least one retained artifact has unknown sharing classification.");
  }
  for (const exportState of valid("export-manifest")) {
    const errors = validateExportManifest(exportState.descriptor.relativePath, exportState.document, manifest, bundleRoot);
    for (const error of errors) {
      addQualificationReason(report, "sharing", "unqualified", "EXPORT_MANIFEST_INVALID", exportState.descriptor.id, `${error.field}: ${error.message}`);
    }
  }

  if (captureReports.length === 0) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "CAPTURE_REPORT_MISSING", undefined, "No valid capture report is retained.");
  } else {
    for (const error of validateArtifact(captureReports[0]!.descriptor.relativePath, captureReport)) {
      addQualificationReason(report, "semanticEvidence", "unqualified", "CAPTURE_REPORT_INVALID", captureReports[0]!.descriptor.id, `${error.field}: ${error.message}`);
    }
    crossCheckCaptureReport(report, captureReports[0]!.descriptor.id, captureReport, {
      semantic: sessions.length > 0 && hooks.length > 0,
      timingResource: telemetry.length > 0 && telemetry.every(({ document }) => {
        const receipt = isRecord(document) && isRecord(document.telemetry) ? document.telemetry.receipt : undefined;
        return !isRecord(receipt) || receipt.status === "received";
      }),
      outcome: workspaces.length > 0 && verifiers.length > 0,
    });
  }

  return finishQualificationReport(report);
}

function emptyQualificationReport(): CaptureQualificationReport {
  const dimension = () => ({ status: "qualified" as const, reasonCodes: [] as CaptureQualificationReasonCode[] });
  return {
    status: "qualified",
    semanticAnalysisUsable: true,
    dimensions: {
      attemptIdentity: dimension(), semanticEvidence: dimension(), hooks: dimension(), telemetry: dimension(),
      workspace: dimension(), verifier: dimension(), terminal: dimension(), sharing: dimension(),
    },
    reasons: [],
  };
}

function addQualificationReason(
  report: CaptureQualificationReport,
  dimension: CaptureQualificationDimension,
  status: "gap" | "unqualified",
  code: CaptureQualificationReasonCode,
  evidenceId: string | undefined,
  detail: string,
): void {
  if (report.reasons.some((reason) => reason.code === code && reason.dimension === dimension
      && reason.evidenceId === evidenceId && reason.detail === detail)) return;
  report.reasons.push({ code, dimension, ...(evidenceId === undefined ? {} : { evidenceId }), detail });
  const target = report.dimensions[dimension];
  if (!target.reasonCodes.includes(code)) target.reasonCodes.push(code);
  if (status === "unqualified" || target.status === "qualified") target.status = status;
}

function finishQualificationReport(report: CaptureQualificationReport): CaptureQualificationReport {
  const statuses = Object.values(report.dimensions).map((dimension) => dimension.status);
  report.status = statuses.includes("unqualified") ? "unqualified" : statuses.includes("gap") ? "qualified-with-gaps" : "qualified";
  report.semanticAnalysisUsable = report.dimensions.attemptIdentity.status !== "unqualified"
    && report.dimensions.semanticEvidence.status !== "unqualified"
    && report.dimensions.hooks.status !== "unqualified";
  return report;
}

function artifactFailure(
  descriptor: RunBundleEvidenceDescriptor,
  error: unknown,
): { dimension: CaptureQualificationDimension; code: CaptureQualificationReasonCode } {
  const dimension: CaptureQualificationDimension = descriptor.kind === "session" ? "semanticEvidence"
    : descriptor.kind === "hook" ? "hooks"
      : descriptor.kind === "telemetry" ? "telemetry"
        : descriptor.kind === "workspace" ? "workspace"
          : descriptor.kind === "verifier" || descriptor.kind === "diagnostic" ? "verifier"
            : descriptor.kind === "export-manifest" ? "sharing" : "semanticEvidence";
  const message = errorMessage(error);
  const code: CaptureQualificationReasonCode = descriptor.kind === "capture-report" ? "CAPTURE_REPORT_INVALID"
    : descriptor.kind === "export-manifest" ? "EXPORT_MANIFEST_INVALID"
      : descriptor.mediaType === "application/x-ndjson" && message.includes("empty") ? "NATIVE_JSONL_EMPTY"
        : descriptor.mediaType === "application/x-ndjson" ? "NATIVE_JSONL_MALFORMED"
          : descriptor.mediaType === "application/json" && ["session", "hook", "telemetry"].includes(descriptor.kind) && message.includes("empty") ? "NATIVE_JSON_EMPTY"
            : descriptor.mediaType === "application/json" && ["session", "hook", "telemetry"].includes(descriptor.kind) ? "NATIVE_JSON_MALFORMED"
              : "ARTIFACT_INTEGRITY_INVALID";
  return { dimension, code };
}

function parseNativeJson(bytes: Buffer): unknown {
  if (bytes.length === 0) throw new Error("Native JSON evidence is empty.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Native JSON evidence is malformed: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || Object.keys(value).length === 0) throw new Error("Native JSON evidence is empty.");
  return value;
}

function parseNativeJsonl(bytes: Buffer): Record<string, unknown>[] {
  if (bytes.length === 0) throw new Error("Native JSONL evidence is empty.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("Native JSONL evidence is empty.");
  return lines.map((line, index) => {
    try {
      assertNoDuplicateJsonKeys(line);
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || Object.keys(value).length === 0) throw new Error("record is empty");
      return value;
    } catch (error) {
      throw new Error(`Native JSONL evidence line ${index + 1} is malformed: ${errorMessage(error)}`);
    }
  });
}

function qualifyHooks(
  report: CaptureQualificationReport,
  manifest: RunManifest,
  hooks: Array<{ records?: Record<string, unknown>[] }>,
  options: CaptureQualificationOptions,
): void {
  const capabilities = options.hookCapabilities;
  if (capabilities === undefined) {
    addQualificationReason(report, "hooks", "gap", "HOOK_CAPABILITY_NOT_CHECKED", undefined, "Pinned TypeScript hook capabilities were not supplied.");
    return;
  }
  const runtimeVersion = manifest.run.runtime.find((component) => component.name === "agent-sdk")?.version;
  if (runtimeVersion !== capabilities.sdkVersion) {
    addQualificationReason(report, "hooks", "unqualified", "HOOK_CAPABILITY_VERSION_MISMATCH", undefined, `Retained Agent SDK ${String(runtimeVersion)} does not match capability profile ${capabilities.sdkVersion}.`);
  }
  const observed = new Set(hooks.flatMap(({ records }) => (records ?? []).flatMap((record) => {
    const hook = typeof record.hook === "string" ? record.hook
      : typeof record.hook_event_name === "string" ? record.hook_event_name
        : typeof record.type === "string" ? record.type : undefined;
    return hook === undefined ? [] : [hook];
  })));
  const supported = new Set(Object.keys(capabilities.hooks));
  const unsupported = new Set(capabilities.unsupportedHooks);
  for (const hook of options.expectedHooks ?? []) {
    if (supported.has(hook) && !observed.has(hook)) {
      addQualificationReason(report, "hooks", "unqualified", "HOOK_SUPPORTED_BUT_MISSING", undefined, `Pinned SDK supports expected hook ${hook}, but no callback was retained.`);
    } else if (unsupported.has(hook)) {
      addQualificationReason(report, "hooks", "gap", "HOOK_UNSUPPORTED_BY_PINNED_SDK", undefined, `Pinned SDK does not support expected hook ${hook}.`);
    } else if (!supported.has(hook)) {
      addQualificationReason(report, "hooks", "unqualified", "HOOK_CAPABILITY_CONTRADICTION", undefined, `Expected hook ${hook} is absent from the pinned capability profile.`);
    }
  }
  for (const hook of observed) {
    if (unsupported.has(hook)) {
      addQualificationReason(report, "hooks", "unqualified", "HOOK_CAPABILITY_CONTRADICTION", undefined, `Hook ${hook} was observed although the pinned profile declares it unsupported.`);
    }
  }
}

function qualifyTelemetry(
  report: CaptureQualificationReport,
  telemetry: Array<{ document?: unknown }>,
  missing: Array<Record<string, unknown>>,
): void {
  const optionalBeta = missing.some((entry) => entry.reason === "optional-beta-unavailable"
    && Array.isArray(entry.affects) && entry.affects.includes("timing-resource"));
  if (optionalBeta) {
    addQualificationReason(report, "telemetry", "gap", "OPTIONAL_BETA_TIMING_UNAVAILABLE", undefined, "Optional detailed-beta timing is unavailable; semantic hook evidence remains usable.");
  }
  if (telemetry.length === 0) {
    if (!optionalBeta) addQualificationReason(report, "telemetry", "unqualified", "TELEMETRY_EVIDENCE_MISSING", undefined, "No valid telemetry evidence is retained.");
    return;
  }
  for (const entry of telemetry) {
    const receipt = isRecord(entry.document) && isRecord(entry.document.telemetry)
      ? entry.document.telemetry.receipt : undefined;
    if (isRecord(receipt) && receipt.status !== "received") {
      addQualificationReason(report, "telemetry", "gap", "TELEMETRY_RECEIPT_MISSING", undefined, `Collector receipt status is ${String(receipt.status)}.`);
    }
  }
}

async function workspacePatchApplies(startingWorkspacePath: string, patch: Buffer): Promise<boolean> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ebo-qualification-patch-"));
  const applied = join(temporaryRoot, "workspace");
  const patchPath = join(temporaryRoot, "workspace.patch");
  try {
    await cp(resolve(startingWorkspacePath), applied, { recursive: true, preserveTimestamps: true, force: false });
    if (patch.length > 0) {
      await writeFile(patchPath, patch, { flag: "wx", mode: 0o600 });
      await execFileAsync("git", ["apply", "--check", "--binary", patchPath], { cwd: applied });
      await execFileAsync("git", ["apply", "--binary", patchPath], { cwd: applied });
    }
    return true;
  } catch {
    return false;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function crossCheckCaptureReport(
  report: CaptureQualificationReport,
  evidenceId: string,
  value: unknown,
  actual: Record<"semantic" | "timingResource" | "outcome", boolean>,
): void {
  if (!isRecord(value) || !isRecord(value.capabilities)) return;
  for (const [area, available] of Object.entries(actual) as Array<[keyof typeof actual, boolean]>) {
    const capability = value.capabilities[area];
    const claimsAvailable = isRecord(capability) && capability.status === "available";
    if (claimsAvailable !== available) {
      const dimension = area === "semantic" ? "semanticEvidence" : area === "timingResource" ? "telemetry" : "workspace";
      addQualificationReason(report, dimension, "unqualified", "CAPTURE_REPORT_CONTRADICTS_SOURCE", evidenceId, `Capture report ${area}=${String(isRecord(capability) ? capability.status : undefined)} contradicts retained source evidence.`);
    }
  }
  const retainedKinds = new Set<unknown>(Object.entries(actual).filter(([, available]) => available).flatMap(([area]) =>
    area === "semantic" ? ["session", "hook"] : area === "timingResource" ? ["telemetry"] : ["workspace", "verifier"]));
  for (const entry of captureMissingEvidence(value)) {
    if (retainedKinds.has(entry.kind) && entry.reason !== "optional-beta-unavailable") {
      const dimension = entry.kind === "telemetry" ? "telemetry" : ["workspace", "verifier"].includes(String(entry.kind)) ? "workspace" : "semanticEvidence";
      addQualificationReason(report, dimension, "unqualified", "CAPTURE_REPORT_CONTRADICTS_SOURCE", evidenceId, `Capture report marks retained ${String(entry.kind)} evidence as missing.`);
    }
  }
}

function captureMissingEvidence(value: unknown): Array<Record<string, unknown>> {
  return isRecord(value) && Array.isArray(value.missingEvidence)
    ? value.missingEvidence.filter(isRecord)
    : [];
}

function descriptorFromValidationField(manifest: RunManifest, field: string): RunBundleEvidenceDescriptor | undefined {
  if (!field.startsWith("/evidence/")) return undefined;
  const id = field.slice("/evidence/".length).split("/")[0]?.replaceAll("~1", "/").replaceAll("~0", "~");
  return manifest.evidence.find((descriptor) => descriptor.id === id);
}

function digestValue(value: DigestString): { algorithm: "sha256"; value: string } {
  return { algorithm: "sha256", value: value.slice("sha256:".length) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureReport(
  bundleId: string,
  evidence: RunBundleEvidenceDescriptor[],
  suppliedMissing: CaptureMissingEvidence[],
): {
  schemaVersion: "capture-report/v1";
  bundleId: string;
  qualification: "qualified" | "incomplete";
  capabilities: Record<"semantic" | "timingResource" | "outcome", { status: CapabilityStatus }>;
  missingEvidence: CaptureMissingEvidence[];
} {
  const kinds = new Set(evidence.map((descriptor) => descriptor.kind));
  const missing = deduplicateMissing([
    ...structuredClone(suppliedMissing),
    ...defaultMissing(kinds, suppliedMissing),
  ]);
  const semantic = capability(kinds.has("session") && kinds.has("hook"), "semantic", missing);
  const timingResource = capability(kinds.has("telemetry"), "timing-resource", missing);
  const outcome = capability(kinds.has("workspace") && kinds.has("verifier"), "outcome", missing);
  const qualified = semantic === "available"
    && outcome === "available"
    && (timingResource === "available" || timingResource === "unsupported")
    && !missing.some((entry) => entry.affects.some((area) => area !== "timing-resource")
      || entry.affects.includes("timing-resource")
        && !["unsupported", "optional-beta-unavailable"].includes(entry.reason));
  return {
    schemaVersion: "capture-report/v1",
    bundleId,
    qualification: qualified ? "qualified" : "incomplete",
    capabilities: {
      semantic: { status: semantic },
      timingResource: { status: timingResource },
      outcome: { status: outcome },
    },
    missingEvidence: missing,
  };
}

function defaultMissing(
  kinds: ReadonlySet<RunBundleEvidenceDescriptor["kind"]>,
  supplied: readonly CaptureMissingEvidence[],
): CaptureMissingEvidence[] {
  const expected: Array<[EvidenceKind, CaptureMissingEvidence["affects"][number]]> = [
    ["session", "semantic"],
    ["hook", "semantic"],
    ["telemetry", "timing-resource"],
    ["workspace", "outcome"],
    ["verifier", "outcome"],
  ];
  return expected.flatMap(([kind, affects]) => kinds.has(kind)
    || supplied.some((entry) => entry.kind === kind && entry.affects.includes(affects))
    ? []
    : [{ kind, reason: "not-collected" as const, affects: [affects] }]);
}

function deduplicateMissing(entries: CaptureMissingEvidence[]): CaptureMissingEvidence[] {
  const unique = new Map(entries.map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()];
}

function capability(
  available: boolean,
  area: CaptureMissingEvidence["affects"][number],
  missing: readonly CaptureMissingEvidence[],
): CapabilityStatus {
  const relevant = missing.filter((entry) => entry.affects.includes(area)
    && entry.reason !== "optional-beta-unavailable");
  if (available && relevant.length === 0) return "available";
  if (relevant.length > 0 && relevant.every((entry) => entry.reason === "unsupported")) return "unsupported";
  if (relevant.some((entry) => entry.reason === "not-checked")) return "not-checked";
  return "missing";
}

function runWithNativeReference(run: RunBundleRun, descriptor: RunBundleEvidenceDescriptor): RunBundleRun {
  const native = structuredClone(run.native ?? {});
  if (descriptor.kind === "session" && descriptor.nativeReference?.type === "session") {
    if (native.sessionId !== undefined && native.sessionId !== descriptor.nativeReference.id) {
      throw new Error("Session evidence does not match the run's native session ID.");
    }
    native.sessionId = descriptor.nativeReference.id;
  }
  if (descriptor.kind === "telemetry" && descriptor.nativeReference?.type === "trace") {
    if (native.traceId !== undefined && native.traceId !== descriptor.nativeReference.id) {
      throw new Error("Telemetry evidence does not match the run's native trace ID.");
    }
    native.traceId = descriptor.nativeReference.id;
  }
  return { ...structuredClone(run), ...(Object.keys(native).length === 0 ? {} : { native }) };
}

async function workspacePatch(startPath: string, finalPath: string, finalTreeDigest: DigestString): Promise<Buffer | undefined> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ebo-workspace-patch-"));
  const worktree = join(temporaryRoot, "worktree");
  const applied = join(temporaryRoot, "applied");
  const patchPath = join(temporaryRoot, "workspace.patch");
  try {
    await cp(startPath, worktree, { recursive: true, preserveTimestamps: true, force: false });
    await execFileAsync("git", ["init", "--quiet"], { cwd: worktree });
    await execFileAsync("git", ["add", "--force", "--all"], { cwd: worktree });
    await execFileAsync("git", ["-c", "user.name=EBO", "-c", "user.email=ebo.invalid", "commit", "--quiet", "--allow-empty", "-m", "starting fixture"], { cwd: worktree });
    for (const entry of await readdir(worktree)) {
      if (entry !== ".git") await rm(join(worktree, entry), { recursive: true, force: true });
    }
    for (const entry of await readdir(finalPath)) {
      if (entry === ".git") throw new Error("Workspace patches cannot retain Git administrative state.");
      await cp(join(finalPath, entry), join(worktree, entry), { recursive: true, preserveTimestamps: true, force: false });
    }
    await execFileAsync("git", ["add", "--force", "--intent-to-add", "--all"], { cwd: worktree });
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("git", [
        "diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", "HEAD", "--", ".",
      ], { cwd: worktree, encoding: "utf8", maxBuffer: MAX_WORKSPACE_PATCH_BYTES }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return undefined;
      throw error;
    }
    const patch = Buffer.from(stdout);

    await cp(startPath, applied, { recursive: true, preserveTimestamps: true, force: false });
    if (patch.length > 0) {
      await writeFile(patchPath, patch, { flag: "wx", mode: 0o600 });
      await execFileAsync("git", ["apply", "--binary", patchPath], { cwd: applied });
    }
    const appliedTreeDigest = await digestWorkspaceTree(applied);
    if (appliedTreeDigest !== finalTreeDigest) {
      return undefined;
    }
    return patch;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function workspaceSnapshot(finalPath: string, finalTreeDigest: DigestString): Promise<Buffer> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ebo-workspace-snapshot-"));
  const snapshotPath = join(temporaryRoot, "workspace.tar.gz");
  const snapshotParent = join(temporaryRoot, "source");
  const snapshotRoot = join(snapshotParent, "workspace");
  const extracted = join(temporaryRoot, "extracted");
  try {
    await mkdir(snapshotParent);
    await cp(finalPath, snapshotRoot, { recursive: true, preserveTimestamps: true, force: false });
    const { stdout } = await execFileAsync(TAR_COMMAND, ["-czf", "-", "-C", snapshotParent, "workspace"], {
      encoding: "buffer",
      maxBuffer: MAX_WORKSPACE_SNAPSHOT_BYTES,
    });
    const snapshot = Buffer.from(stdout);
    await writeFile(snapshotPath, snapshot, { flag: "wx", mode: 0o600 });
    await mkdir(extracted, { mode: 0o700 });
    await execFileAsync(TAR_COMMAND, ["-xzpf", snapshotPath, "-C", extracted]);
    if (await digestWorkspaceTree(join(extracted, "workspace")) !== finalTreeDigest) {
      throw new Error("Bounded workspace snapshot cannot reproduce the final workspace tree.");
    }
    return snapshot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertValid(artifact: string, document: unknown): void {
  const errors = validateArtifact(artifact, document);
  if (errors.length > 0) throw new Error(formatValidationErrors(errors));
}

function formatValidationErrors(errors: Array<{ artifact: string; field: string; message: string }>): string {
  return errors.map((error) => `${error.artifact} ${error.field}: ${error.message}`).join("\n");
}

function digestString(value: string): DigestString {
  return `sha256:${value}`;
}
