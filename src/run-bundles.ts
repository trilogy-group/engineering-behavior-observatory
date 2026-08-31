import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertUniqueArtifactIdentities,
  canonicalizeMetadata,
  inspectRetainedArtifact,
  validateArtifact,
  validateRunManifestEvidence,
  writeArtifactAtomically,
  writeMetadataAtomically,
} from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { digestWorkspace, digestWorkspaceTree } from "./verifiers.js";
import type { ClaudeAgentSdkAttemptEvidence } from "./agent-sdk.js";
import type { AttemptIdentity, TerminalRecord } from "./lifecycle.js";

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
  kind: EvidenceKind | "capture-report";
  authority: EvidenceAuthority | "capture";
  mediaType: string;
  digest: DigestString;
  sizeBytes: number;
  sharingClass: SharingClass;
  relativePath: string;
  fingerprint?: DigestString;
  nativeReference?: { type: string; id: string };
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
    const receipt = input.evidence.telemetry?.receipt;
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
    return this.writeJsonArtifact({
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
    const { stdout } = await execFileAsync("git", [
      "diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", "HEAD", "--", ".",
    ], { cwd: worktree, encoding: "utf8", maxBuffer: MAX_WORKSPACE_PATCH_BYTES });
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
    await execFileAsync(TAR_COMMAND, ["-xzf", snapshotPath, "-C", extracted]);
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
