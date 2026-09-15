import { closeSync, constants, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { digestMetadata, validateArtifact, writeMetadataAtomicallyIfAbsentSync, type ArtifactValidationError } from "../artifacts.js";
import type { ArtifactReference, AssessmentMode, Digest } from "../contracts.js";
import { createHarborAdapter, type HarborAdapter } from "./adapter.js";
import {
  harborTaskSourceId,
  resolveHarborTask,
  snapshotHarborTask,
  verifyHarborSnapshot,
  type HarborSnapshot,
  type HarborTaskResolution,
} from "./tasks.js";

export const HARBOR_ADMISSION_SCHEMA_VERSION = "ebo.harbor-admission/v1";
export const HARBOR_REVIEW_SCHEMA_VERSION = "ebo.harbor-review/v1";
export const HARBOR_FREEZE_SCHEMA_VERSION = "ebo.harbor-freeze/v1";

export type HarborSharingClassification = "open" | "restricted" | "internal";

export type HarborProvenanceInput = {
  sourceLocator?: string | null;
  repositoryUrl?: string;
  revision?: string;
  license?: string;
};

export type HarborAdmissionRecord = {
  schemaVersion: typeof HARBOR_ADMISSION_SCHEMA_VERSION;
  taskSourceId: string;
  harborTask: {
    digest: string;
    name: string;
    version: string | null;
    type: "local" | "git" | "package";
    taskSchemaVersion: string;
  };
  resolution: {
    harborPackageVersion: string;
    resolutionDigest: Digest;
    stepCount: number;
    instructionDigests: Digest[];
    environment: Record<string, unknown>;
    verifier: Record<string, unknown>;
    packaging: { includedFiles: string[]; excludedFiles: string[] };
  };
  provenance: HarborProvenanceInput;
  sharing: { classification: HarborSharingClassification };
  visibilityPolicy: {
    solution: "hidden" | "absent";
    verifier: "hidden" | "absent";
    reviewInputs: "hidden";
  };
  controlledPerturbation: { status: "not-applied" } | { status: "referenced"; reference: ArtifactReference };
  assessmentMode: AssessmentMode;
  preAdmissionDigest: Digest;
  review: {
    reviewedAt: string;
    reviewedBy: string;
    decision: "admitted" | "rejected";
    reviewRecordLocator: string;
  } | null;
  admissionDigest: Digest;
};

export type HarborReviewRecord = {
  schemaVersion: typeof HARBOR_REVIEW_SCHEMA_VERSION;
  taskSourceId: string;
  preAdmissionDigest: Digest;
  decision: "admitted" | "rejected";
  reviewedAt: string;
  reviewedBy: string;
  notes?: string;
};

export type HarborFreezeRecord = {
  schemaVersion: typeof HARBOR_FREEZE_SCHEMA_VERSION;
  taskSourceId: string;
  harborTask: {
    digest: string;
    name: string;
    version: string | null;
    type: "local" | "git" | "package";
    taskSchemaVersion: string;
  };
  snapshotLocator: string;
  snapshotCopyDigest: Digest;
  admissionLocator: string;
  admissionDigest: Digest;
  resolutionDigest: Digest;
  assessmentMode: AssessmentMode;
  frozenAt: string;
  freezeDigest: Digest;
};

export type HarborTaskStatus = {
  status: "missing-snapshot" | "invalid" | "unadmitted" | "unfrozen" | "frozen" | "changed";
  taskSourceId: string;
  harborDigest: string | null;
  admissionLocator: string;
  freezeLocator: string;
  mismatches: string[];
  errors: ArtifactValidationError[];
};

export type StudyPaths = {
  studyRoot: string;
  snapshotsRoot: string;
  admissionsRoot: string;
  reviewsRoot: string;
  freezeRecordsRoot: string;
};

export function harborStudyPaths(studyRoot: string): StudyPaths {
  const root = resolve(studyRoot);
  return {
    studyRoot: root,
    snapshotsRoot: join(root, "frozen", "task-snapshots"),
    admissionsRoot: join(root, "governance", "admissions", "harbor"),
    reviewsRoot: join(root, "governance", "reviews", "harbor"),
    freezeRecordsRoot: join(root, "frozen", "freeze-records", "harbor"),
  };
}

export function admissionLocatorOf(taskSourceId: string): string {
  return join("governance", "admissions", "harbor", `${taskSourceId}.json`);
}

export function proposedAdmissionLocatorOf(taskSourceId: string): string {
  return join("governance", "admissions", "harbor", `${taskSourceId}.proposed.json`);
}

export function reviewLocatorOf(taskSourceId: string): string {
  return join("governance", "reviews", "harbor", `${taskSourceId}.json`);
}

export function freezeLocatorOf(taskSourceId: string): string {
  return join("frozen", "freeze-records", "harbor", `${taskSourceId}.json`);
}

export type PrepareHarborAdmissionOptions = {
  assessmentMode?: AssessmentMode;
  provenance?: HarborProvenanceInput;
  sharing?: HarborSharingClassification;
  adapter?: HarborAdapter;
};

/**
 * Snapshot the task and write the proposed admission envelope for human
 * review. The proposal carries `review: null`: preparing it can never assign
 * human approval (MIGRATION_SPEC.md §6.3).
 */
export async function prepareHarborAdmission(
  studyRoot: string,
  taskDir: string,
  options: PrepareHarborAdmissionOptions = {},
): Promise<{ record: HarborAdmissionRecord; snapshot: HarborSnapshot; resolution: HarborTaskResolution }> {
  const paths = harborStudyPaths(studyRoot);
  const assessmentMode: AssessmentMode = options.assessmentMode ?? "observational";
  const snapshot = await snapshotHarborTask(taskDir, paths.snapshotsRoot, {
    assessmentMode,
    adapter: options.adapter,
    sourceLocator: options.provenance?.sourceLocator ?? undefined,
  });
  const resolution = await resolveHarborTask(snapshot.taskDirectory, { assessmentMode, adapter: options.adapter });
  const sharing = options.sharing ?? "internal";
  if (!["open", "restricted", "internal"].includes(sharing)) throw new Error(`Unknown sharing classification "${sharing}".`);

  const proposal = admissionEnvelope(resolution, snapshot, assessmentMode, options.provenance ?? {}, sharing, null, { algorithm: "sha256", value: "0".repeat(64) });
  proposal.preAdmissionDigest = preAdmissionDigestOf(proposal);
  const locator = proposedAdmissionLocatorOf(resolution.taskSourceId);
  mkdirSync(join(paths.studyRoot, dirnameOf(locator)), { recursive: true });
  const published = writeMetadataAtomicallyIfAbsentSync(paths.studyRoot, locator, proposal);
  if (!published.created) {
    const retained = readStudyJson(paths.studyRoot, locator) as HarborAdmissionRecord;
    const retainedPre = preAdmissionDigestOf(retained);
    if (retainedPre.value !== proposal.preAdmissionDigest.value) {
      throw new Error(`A different admission proposal already exists for "${resolution.taskSourceId}"; changed proposals require a new task identity.`);
    }
    return { record: retained, snapshot, resolution };
  }
  return { record: proposal, snapshot, resolution };
}

/**
 * Publish the admission record after validating the operator-supplied review.
 * The review record must bind the proposal's pre-admission digest and carry
 * an explicit human decision; commands cannot manufacture approval.
 */
export async function admitHarborTask(
  studyRoot: string,
  taskSourceId: string,
  options: { adapter?: HarborAdapter } = {},
): Promise<HarborAdmissionRecord> {
  const paths = harborStudyPaths(studyRoot);
  const proposalLocator = proposedAdmissionLocatorOf(taskSourceId);
  const admissionLocator = admissionLocatorOf(taskSourceId);

  const proposal = readStudyJson(paths.studyRoot, proposalLocator) as HarborAdmissionRecord;
  const errors = validateArtifact(proposalLocator, proposal);
  if (errors.length > 0) throw new Error(formatValidationErrors(errors));
  if (proposal.taskSourceId !== taskSourceId) throw new Error("Admission proposal identity does not match its locator.");
  if (proposal.review !== null) throw new Error("Admission proposal must not carry a review decision.");

  const expectedPre = preAdmissionDigestOf(proposal);
  if (expectedPre.value !== proposal.preAdmissionDigest.value) {
    throw new Error("Admission proposal pre-admission digest does not match its content.");
  }

  const snapshot = await verifyHarborSnapshot(paths.snapshotsRoot, taskSourceId, {
    assessmentMode: proposal.assessmentMode,
    adapter: options.adapter,
  });
  if (snapshot.manifest.harborDigest !== proposal.harborTask.digest) {
    throw new Error(`Snapshot content changed from the admission proposal (${snapshot.manifest.harborDigest}).`);
  }

  const reviewLocator = reviewLocatorOf(taskSourceId);
  const review = readStudyJson(paths.studyRoot, reviewLocator) as HarborReviewRecord;
  const reviewErrors = validateArtifact(reviewLocator, review);
  if (reviewErrors.length > 0) throw new Error(formatValidationErrors(reviewErrors));
  if (review.taskSourceId !== taskSourceId
      || review.preAdmissionDigest.algorithm !== proposal.preAdmissionDigest.algorithm
      || review.preAdmissionDigest.value !== proposal.preAdmissionDigest.value) {
    throw new Error(`Review record "${reviewLocator}" does not bind the proposal's pre-admission digest.`);
  }
  if (review.decision !== "admitted") {
    throw new Error(`Review record decision "${review.decision}" does not admit the task.`);
  }

  const record = admissionEnvelopeFromProposal(proposal, {
    reviewedAt: review.reviewedAt,
    reviewedBy: review.reviewedBy,
    decision: review.decision,
    reviewRecordLocator: reviewLocator,
  });
  mkdirSync(join(paths.studyRoot, dirnameOf(admissionLocator)), { recursive: true });
  const published = writeMetadataAtomicallyIfAbsentSync(paths.studyRoot, admissionLocator, record);
  if (!published.created) {
    const retained = readStudyJson(paths.studyRoot, admissionLocator) as HarborAdmissionRecord;
    if (retained.admissionDigest.value !== record.admissionDigest.value) {
      throw new Error(`A different admission already exists for "${taskSourceId}"; admissions are never replaced.`);
    }
    return retained;
  }
  return record;
}

/**
 * Publish the freeze record for an admitted Harbor task. Repeating freeze on
 * unchanged inputs retains the first publication; changed inputs fail
 * instead of replacing it (A04).
 */
export async function freezeHarborTask(
  studyRoot: string,
  taskSourceId: string,
  options: { adapter?: HarborAdapter } = {},
): Promise<HarborFreezeRecord> {
  const paths = harborStudyPaths(studyRoot);
  const admissionLocator = admissionLocatorOf(taskSourceId);
  const freezeLocator = freezeLocatorOf(taskSourceId);
  const admission = readStudyJson(paths.studyRoot, admissionLocator) as HarborAdmissionRecord;
  const admissionErrors = validateArtifact(admissionLocator, admission);
  if (admissionErrors.length > 0) throw new Error(formatValidationErrors(admissionErrors));
  if (admission.taskSourceId !== taskSourceId) throw new Error("Admission identity does not match its locator.");
  if (admission.review?.decision !== "admitted") throw new Error("Only admitted Harbor tasks can be frozen.");

  const snapshot = await verifyHarborSnapshot(paths.snapshotsRoot, taskSourceId, {
    assessmentMode: admission.assessmentMode,
    adapter: options.adapter,
  });
  if (snapshot.manifest.harborDigest !== admission.harborTask.digest) {
    throw new Error(`Snapshot content changed from the admitted identity (${snapshot.manifest.harborDigest}); freezing requires a new admission.`);
  }
  const resolution = await resolveHarborTask(snapshot.taskDirectory, {
    assessmentMode: admission.assessmentMode,
    adapter: options.adapter,
  });
  if (resolution.resolutionDigest.value !== admission.resolution.resolutionDigest.value) {
    throw new Error("Resolved task semantics changed from the admitted resolution; freezing requires a new admission.");
  }

  const candidate: HarborFreezeRecord = {
    schemaVersion: HARBOR_FREEZE_SCHEMA_VERSION,
    taskSourceId,
    harborTask: { ...admission.harborTask },
    snapshotLocator: snapshot.manifest.snapshotLocator,
    snapshotCopyDigest: snapshot.manifest.copyDigest,
    admissionLocator,
    admissionDigest: admission.admissionDigest,
    resolutionDigest: resolution.resolutionDigest,
    assessmentMode: admission.assessmentMode,
    frozenAt: new Date().toISOString(),
    freezeDigest: { algorithm: "sha256", value: "0".repeat(64) },
  };
  candidate.freezeDigest = freezeDigestOf(candidate);

  mkdirSync(join(paths.studyRoot, dirnameOf(freezeLocator)), { recursive: true });
  const published = writeMetadataAtomicallyIfAbsentSync(paths.studyRoot, freezeLocator, candidate);
  if (published.created) return candidate;
  const retained = readStudyJson(paths.studyRoot, freezeLocator) as HarborFreezeRecord;
  const retainedErrors = validateArtifact(freezeLocator, retained);
  if (retainedErrors.length > 0) throw new Error(formatValidationErrors(retainedErrors));
  if (retained.freezeDigest.value !== freezeDigestOf(retained).value) {
    throw new Error("Retained freeze record digest does not match its content.");
  }
  if (retained.harborTask.digest !== candidate.harborTask.digest
      || retained.admissionDigest.value !== candidate.admissionDigest.value
      || retained.snapshotCopyDigest.value !== candidate.snapshotCopyDigest.value
      || retained.resolutionDigest.value !== candidate.resolutionDigest.value) {
    throw new Error(`Freeze inputs changed after the first publication for "${taskSourceId}"; the first record is retained and inputs require a new identity.`);
  }
  return retained;
}

export async function statusHarborTask(
  studyRoot: string,
  taskSourceId: string,
  options: { adapter?: HarborAdapter } = {},
): Promise<HarborTaskStatus> {
  const paths = harborStudyPaths(studyRoot);
  const admissionLocator = admissionLocatorOf(taskSourceId);
  const freezeLocator = freezeLocatorOf(taskSourceId);
  const status: HarborTaskStatus = {
    status: "missing-snapshot",
    taskSourceId,
    harborDigest: null,
    admissionLocator,
    freezeLocator,
    mismatches: [],
    errors: [],
  };

  let snapshot: HarborSnapshot;
  try {
    snapshot = await verifyHarborSnapshot(paths.snapshotsRoot, taskSourceId, { adapter: options.adapter });
  } catch (error) {
    status.errors.push({
      artifact: `frozen/task-snapshots/${taskSourceId}`,
      schemaVersion: HARBOR_SNAPSHOT_MANIFEST_REFERENCE,
      field: "/",
      message: error instanceof Error ? error.message : "Snapshot could not be verified.",
    });
    // A snapshot whose retained manifest exists but whose content fails
    // verification is a change, not an absence.
    const { existsSync } = await import("node:fs");
    const manifestPresent = existsSync(join(paths.snapshotsRoot, `${taskSourceId}.snapshot-manifest.json`));
    status.status = manifestPresent ? "changed" : "missing-snapshot";
    return status;
  }
  status.harborDigest = snapshot.manifest.harborDigest;

  let admission: HarborAdmissionRecord | null = null;
  try {
    admission = readStudyJson(paths.studyRoot, admissionLocator) as HarborAdmissionRecord;
    const errors = validateArtifact(admissionLocator, admission);
    if (errors.length > 0) {
      status.errors.push(...errors);
      status.status = "invalid";
      return status;
    }
  } catch {
    status.status = "unadmitted";
    return status;
  }
  if (admission.review?.decision !== "admitted") {
    status.status = "unadmitted";
    status.mismatches.push("admission");
    return status;
  }
  if (admission.harborTask.digest !== snapshot.manifest.harborDigest) {
    status.status = "changed";
    status.mismatches.push("snapshot-vs-admission");
    return status;
  }

  let freeze: HarborFreezeRecord;
  try {
    freeze = readStudyJson(paths.studyRoot, freezeLocator) as HarborFreezeRecord;
    const errors = validateArtifact(freezeLocator, freeze);
    if (errors.length > 0) {
      status.errors.push(...errors);
      status.status = "invalid";
      return status;
    }
  } catch {
    status.status = "unfrozen";
    return status;
  }
  const mismatches: string[] = [];
  if (freeze.harborTask.digest !== snapshot.manifest.harborDigest) mismatches.push("snapshot-vs-freeze");
  if (freeze.admissionDigest.value !== admission.admissionDigest.value) mismatches.push("admission-vs-freeze");
  if (freeze.snapshotCopyDigest.value !== snapshot.manifest.copyDigest.value) mismatches.push("snapshot-copy");
  if (freeze.freezeDigest.value !== freezeDigestOf(freeze).value) mismatches.push("freeze-digest");
  if (admission.admissionDigest.value !== admissionDigestOf(admission).value) mismatches.push("admission-digest");
  status.mismatches = mismatches;
  status.status = mismatches.length > 0 ? "changed" : "frozen";
  return status;
}

/** Resolve a source reference (task directory or task source ID) to its task source ID, snapshotting when needed. */
export async function resolveHarborSourceReference(
  studyRoot: string,
  sourceReference: string,
  options: { assessmentMode?: AssessmentMode; adapter?: HarborAdapter } = {},
): Promise<{ taskSourceId: string; assessmentMode: AssessmentMode }> {
  const adapter = options.adapter ?? await createHarborAdapter();
  const paths = harborStudyPaths(studyRoot);
  if (/^[a-z0-9-]+$/.test(sourceReference) && sourceReference.startsWith("harbor-")) {
    return { taskSourceId: sourceReference, assessmentMode: options.assessmentMode ?? "observational" };
  }
  const identity = await adapter.identity(sourceReference);
  const taskSourceId = harborTaskSourceId(identity.digest);
  await snapshotHarborTask(sourceReference, paths.snapshotsRoot, { ...options, adapter });
  return { taskSourceId, assessmentMode: options.assessmentMode ?? "observational" };
}

function admissionEnvelope(
  resolution: HarborTaskResolution,
  snapshot: HarborSnapshot,
  assessmentMode: AssessmentMode,
  provenance: HarborProvenanceInput,
  sharing: HarborSharingClassification,
  review: HarborAdmissionRecord["review"],
  admissionDigest: Digest,
): HarborAdmissionRecord {
  const record: HarborAdmissionRecord = {
    schemaVersion: HARBOR_ADMISSION_SCHEMA_VERSION,
    taskSourceId: resolution.taskSourceId,
    harborTask: {
      digest: resolution.harborDigest,
      name: snapshot.manifest.harborName,
      version: resolution.harborVersion,
      type: resolution.harborType,
      taskSchemaVersion: resolution.taskSchemaVersion,
    },
    resolution: {
      harborPackageVersion: resolution.harborPackageVersion,
      resolutionDigest: resolution.resolutionDigest,
      stepCount: resolution.steps.length,
      instructionDigests: resolution.instructions.map((instruction) => instruction.digest),
      environment: resolution.environment as unknown as Record<string, unknown>,
      verifier: resolution.verifier as unknown as Record<string, unknown>,
      packaging: { includedFiles: resolution.packaging.includedFiles, excludedFiles: resolution.packaging.excludedFiles },
    },
    provenance: {
      sourceLocator: provenance.sourceLocator ?? snapshot.manifest.sourceLocator,
      ...(provenance.repositoryUrl === undefined ? {} : { repositoryUrl: provenance.repositoryUrl }),
      ...(provenance.revision === undefined ? {} : { revision: provenance.revision }),
      ...(provenance.license === undefined ? {} : { license: provenance.license }),
    },
    sharing: { classification: sharing },
    visibilityPolicy: {
      solution: snapshotHas(snapshot, "solution/") ? "hidden" : "absent",
      verifier: snapshotHas(snapshot, "tests/") ? "hidden" : "absent",
      reviewInputs: "hidden",
    },
    controlledPerturbation: { status: "not-applied" },
    assessmentMode,
    preAdmissionDigest: { algorithm: "sha256", value: "0".repeat(64) },
    review,
    admissionDigest,
  };
  return record;
}

function admissionEnvelopeFromProposal(proposal: HarborAdmissionRecord, review: NonNullable<HarborAdmissionRecord["review"]>): HarborAdmissionRecord {
  const record: HarborAdmissionRecord = {
    ...structuredClone(proposal),
    review,
    admissionDigest: { algorithm: "sha256", value: "0".repeat(64) },
  };
  record.admissionDigest = admissionDigestOf(record);
  return record;
}

/** Pre-admission identity excludes the review and admission digest (no circular hash). */
export function preAdmissionDigestOf(record: HarborAdmissionRecord): Digest {
  const { review, admissionDigest, preAdmissionDigest, ...content } = record;
  void review;
  void admissionDigest;
  void preAdmissionDigest;
  return digestMetadata(content);
}

export function admissionDigestOf(record: HarborAdmissionRecord): Digest {
  const { admissionDigest, ...content } = record;
  void admissionDigest;
  return digestMetadata(content);
}

export function freezeDigestOf(record: HarborFreezeRecord): Digest {
  const { freezeDigest, ...content } = record;
  void freezeDigest;
  return digestMetadata(content);
}

const HARBOR_SNAPSHOT_MANIFEST_REFERENCE = "ebo.harbor-snapshot-manifest/v1";

function snapshotHas(snapshot: HarborSnapshot, directory: string): boolean {
  return snapshot.manifest.packaging.includedFiles.some((file) =>
    file.startsWith(directory) || /^steps\/[^/]+\//.test(file) && file.split("/").slice(2).join("/").startsWith(directory));
}

function readStudyJson(studyRoot: string, locator: string): unknown {
  const path = join(resolve(studyRoot), locator);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = statSync(path).size;
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read === 0) throw new Error(`Study artifact "${locator}" was truncated while being read.`);
      offset += read;
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
}

/** Read one governance JSON artifact from a study root without its credentials or links. */
export function readHarborStudyJson(studyRoot: string, locator: string): unknown {
  return readStudyJson(studyRoot, locator);
}

function dirnameOf(locator: string): string {
  const index = locator.lastIndexOf("/");
  return index === -1 ? "." : locator.slice(0, index);
}

function formatValidationErrors(errors: readonly ArtifactValidationError[]): string {
  return errors.map((error) => `${error.artifact} [${error.schemaVersion}] ${error.field}: ${error.message}`).join("\n");
}
