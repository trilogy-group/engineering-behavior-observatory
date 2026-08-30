import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  assertNoDuplicateJsonKeys,
  digestBytes,
  digestMetadata,
  validateArtifact,
  writeMetadataAtomicallyIfAbsentSync,
  type ArtifactValidationError,
} from "./artifacts.js";
import {
  isSafeArtifactRelativePath,
  openBundleRegularFile,
  isPublicationOwnershipCurrent,
  readPublicationOwnership,
  readPublicationStagingPath,
  MAX_CONFIGURATION_BYTES,
  resolveBundleArtifact,
  resolveBundleArtifactDigest,
  resolveTaskArchive,
  validateTaskArchive,
  closeBundleRoot,
  openBundleRoot,
  type ArtifactReference,
  type BundleRootHandle,
  type Digest,
  type PublicationOwnership,
} from "./contracts.js";

export type TaskPacket = {
  schemaVersion: "ebo.task-packet/v1";
  id: string;
  agentInput: {
    prompt: string;
    fixture: {
      source: ArtifactReference & {
        kind: "sanitized-archive";
        format: "tar-gzip-v1";
        limits: {
          maxCompressedBytes: number;
          maxExpandedBytes: number;
          maxMembers: number;
        };
      };
      materializer: {
        kind: "verified-archive-literal-paths-no-links-v1";
        destination: "workspace";
        includePaths: string[];
      };
    };
  };
  provenance: {
    repositoryUrl: string;
    revision: string;
    license: string;
  };
  controlledPerturbation: { reference: ArtifactReference } | { status: "not-applied" | "unsupported" };
  sharing: { classification: "open" | "restricted" | "internal" };
  admission: {
    status: "proposed" | "admitted" | "rejected";
    review: {
      reviewedAt: string;
      reviewedBy: string;
      reviewRecord: ArtifactReference;
    } | null;
  };
  restricted: {
    referenceSolution: ArtifactReference | { status: "not-provided" | "unsupported" };
    verifier: ArtifactReference;
  };
};

export type TaskPacketComponent =
  | { status: "referenced"; digest: Digest | null }
  | { status: "not-provided" | "unsupported" | "not-applied" };

export type TaskPacketComponents = {
  prompt: Digest;
  fixture: Digest | null;
  reference: TaskPacketComponent;
  verifier: Digest | null;
  reviewRecord: Digest | null;
  controlledPerturbation: TaskPacketComponent;
};

export type TaskPacketFreezeRecord = {
  schemaVersion: "ebo.task-packet-freeze/v1";
  packetId: string;
  packetLocator: string;
  preAdmissionDigest: Digest;
  packetDigest: Digest;
  components: TaskPacketComponents;
  aggregateDigest: Digest;
  frozenAt: string;
};

export type TaskPacketInspection = {
  packetLocator: string;
  packet: TaskPacket | null;
  preAdmissionDigest: Digest | null;
  packetDigest: Digest | null;
  components: TaskPacketComponents | null;
  modelVisible: TaskPacket["agentInput"] | null;
  errors: ArtifactValidationError[];
};

export type TaskPacketStatus = {
  status: "invalid" | "unadmitted" | "unfrozen" | "frozen" | "changed";
  packetId: string | null;
  packetDigest: Digest | null;
  aggregateDigest: Digest | null;
  freezeLocator: string;
  mismatches: string[];
  errors: ArtifactValidationError[];
};

export const TASK_PACKET_FREEZE_SCHEMA_VERSION = "ebo.task-packet-freeze/v1";
export const MAX_TASK_PACKET_METADATA_BYTES = MAX_CONFIGURATION_BYTES;
const MAX_TRANSIENT_LINK_READ_RETRIES = 20;
const MAX_FREEZE_RECOVERY_ENTRIES = 4096;
const TEMPORARY_FREEZE_LINK_PATTERN = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const TASK_PACKET_SCHEMA_VERSION = "ebo.task-packet/v1";
const FREEZE_LOCATOR_SUFFIX = ".freeze.json";
const FREEZE_QUARANTINE_SUFFIX = ".quarantine.marker.binding.tmp";

export function inspectTaskPacket(bundleRoot: string, packetLocator: string): TaskPacketInspection {
  let root: BundleRootHandle | undefined;
  try {
    root = openBundleRoot(bundleRoot);
    return inspectTaskPacketWithRoot(bundleRoot, packetLocator, root);
  } catch (error) {
    return {
      packetLocator,
      packet: null,
      preAdmissionDigest: null,
      packetDigest: null,
      components: null,
      modelVisible: null,
      errors: [packetError(packetLocator, "/", errorMessage(error))],
    };
  } finally {
    if (root !== undefined) closeBundleRoot(root);
  }
}

function inspectTaskPacketWithRoot(
  bundleRoot: string,
  packetLocator: string,
  root: BundleRootHandle,
): TaskPacketInspection {
  let document: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(readBundleFile(bundleRoot, packetLocator, root));
    assertNoDuplicateJsonKeys(text);
    document = JSON.parse(text);
  } catch (error) {
    return {
      packetLocator,
      packet: null,
      preAdmissionDigest: null,
      packetDigest: null,
      components: null,
      modelVisible: null,
      errors: [packetError(packetLocator, "/", errorMessage(error))],
    };
  }

  const errors = validateTaskPacket(packetLocator, document);
  if (errors.length > 0) {
    return { packetLocator, packet: null, preAdmissionDigest: null, packetDigest: null, components: null, modelVisible: null, errors };
  }

  const packet = document as TaskPacket;
  const preAdmissionPacket = structuredClone(packet) as unknown as Record<string, unknown>;
  delete preAdmissionPacket.admission;
  const preAdmissionDigest = digestMetadata(preAdmissionPacket);
  const components: TaskPacketComponents = {
    prompt: digestBytes(Buffer.from(packet.agentInput.prompt, "utf8")),
    fixture: resolveComponent(
      bundleRoot,
      packet.agentInput.fixture.source,
      "/agentInput/fixture/source",
      packetLocator,
      errors,
      root,
      packet.agentInput.fixture.source.limits.maxCompressedBytes,
      {
        limits: packet.agentInput.fixture.source.limits,
        includePaths: packet.agentInput.fixture.materializer.includePaths,
      },
    ),
    reference: "locator" in packet.restricted.referenceSolution
      ? { status: "referenced", digest: resolveComponent(bundleRoot, packet.restricted.referenceSolution, "/restricted/referenceSolution", packetLocator, errors, root) }
      : { status: packet.restricted.referenceSolution.status },
    verifier: resolveComponent(bundleRoot, packet.restricted.verifier, "/restricted/verifier", packetLocator, errors, root),
    reviewRecord: packet.admission.review === null
      ? null
      : resolveReviewRecord(
        bundleRoot,
        packet.admission.review.reviewRecord,
        preAdmissionDigest,
        packet.admission,
        "/admission/review/reviewRecord",
        packetLocator,
        errors,
        root,
      ),
    controlledPerturbation: "reference" in packet.controlledPerturbation
      ? { status: "referenced", digest: resolveComponent(bundleRoot, packet.controlledPerturbation.reference, "/controlledPerturbation/reference", packetLocator, errors, root) }
      : { status: packet.controlledPerturbation.status },
  };

  return {
    packetLocator,
    packet,
    preAdmissionDigest,
    packetDigest: digestMetadata(packet),
    components,
    modelVisible: modelVisibleTaskPacket(packet),
    errors,
  };
}

export function admitTaskPacket(bundleRoot: string, packetLocator: string): TaskPacketInspection {
  let root: BundleRootHandle | undefined;
  try {
    root = openBundleRoot(bundleRoot);
    return admitTaskPacketWithRoot(bundleRoot, packetLocator, root);
  } catch (error) {
    return {
      packetLocator,
      packet: null,
      preAdmissionDigest: null,
      packetDigest: null,
      components: null,
      modelVisible: null,
      errors: [packetError(packetLocator, "/", errorMessage(error))],
    };
  } finally {
    if (root !== undefined) closeBundleRoot(root);
  }
}

function admitTaskPacketWithRoot(
  bundleRoot: string,
  packetLocator: string,
  root: BundleRootHandle,
): TaskPacketInspection {
  const inspection = inspectTaskPacketWithRoot(bundleRoot, packetLocator, root);
  if (inspection.packet === null) return inspection;

  if (inspection.packet.admission.status === "proposed") {
    inspection.errors.push(packetError(packetLocator, "/admission/status", "Packet has no passing human admission decision."));
  } else if (inspection.packet.admission.status === "rejected") {
    inspection.errors.push(packetError(packetLocator, "/admission/status", "Packet admission review is rejected."));
  }
  if (inspection.packet.admission.review === null) {
    inspection.errors.push(packetError(packetLocator, "/admission/review", "Packet is missing its human admission review."));
  }
  return inspection;
}

export function assertTaskPacketAdmitted(bundleRoot: string, packetLocator: string): TaskPacketInspection {
  const inspection = admitTaskPacket(bundleRoot, packetLocator);
  if (inspection.errors.length > 0) {
    throw new Error(formatErrors(inspection.errors));
  }
  return inspection;
}

function assertTaskPacketAdmittedWithRoot(
  bundleRoot: string,
  packetLocator: string,
  root: BundleRootHandle,
): TaskPacketInspection {
  const inspection = admitTaskPacketWithRoot(bundleRoot, packetLocator, root);
  if (inspection.errors.length > 0) {
    throw new Error(formatErrors(inspection.errors));
  }
  return inspection;
}

export function modelVisibleTaskPacket(packet: TaskPacket): TaskPacket["agentInput"] {
  return structuredClone(packet.agentInput);
}

export function defaultFreezeLocator(packetLocator: string): string {
  const freezeLocator = `${packetLocator}${FREEZE_LOCATOR_SUFFIX}`;
  assertFreezeLocatorPathWithinLimits(freezeLocator, packetLocator);
  return freezeLocator;
}

function readRetainedFreezeRecord(root: BundleRootHandle, freezeLocator: string): TaskPacketFreezeRecord | undefined {
  const destination = resolve(root.path, freezeLocator);
  const parent = dirname(destination);
  const quarantine = `${destination}.quarantine`;
  let descriptor: number | undefined;
  try {
    assertBundleRoot(root.path, root.descriptor, freezeLocator);
    assertFreezeParentPath(root.path, parent, freezeLocator);
    const quarantinePath = lstatSync(quarantine);
    if (!quarantinePath.isFile() || (quarantinePath.mode & 0o777) !== 0o600
        || !Number.isSafeInteger(quarantinePath.size) || quarantinePath.size > MAX_TASK_PACKET_METADATA_BYTES) return undefined;
    if (readPublicationOwnership(destination, quarantinePath, freezeLocator) === undefined) return undefined;
    descriptor = openSync(quarantine, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600
        || !sameFileIdentity(opened, quarantinePath) || opened.size !== quarantinePath.size) return undefined;
    const bytes = Buffer.alloc(opened.size);
    for (let offset = 0; offset < opened.size;) {
      const read = readSync(descriptor, bytes, offset, opened.size - offset, offset);
      if (read === 0) return undefined;
      offset += read;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailing, 0, 1, opened.size) !== 0) return undefined;
    const completed = fstatSync(descriptor);
    if (!sameFileIdentity(opened, completed) || completed.size !== opened.size
        || !sameFileIdentity(completed, lstatSync(quarantine))) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateJsonKeys(text);
    const value = JSON.parse(text) as unknown;
    const errors = validateFreezeRecord(freezeLocator, value);
    if (errors.length > 0 || !isRecord(value) || !sameDigest(digestMetadata(value), digestBytes(bytes))) return undefined;
    return value as TaskPacketFreezeRecord;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function freezeTaskPacket(
  bundleRoot: string,
  packetLocator: string,
  freezeLocator = defaultFreezeLocator(packetLocator),
): TaskPacketFreezeRecord {
  assertFreezeLocatorPathWithinLimits(freezeLocator, packetLocator);
  if (packetLocator === freezeLocator) {
    throw new Error("Freeze record must use a path distinct from the task packet.");
  }

  const root = openBundleRoot(bundleRoot);
  try {
    const inspection = assertTaskPacketAdmittedWithRoot(bundleRoot, packetLocator, root);
    const confirmedInspection = assertTaskPacketAdmittedWithRoot(bundleRoot, packetLocator, root);
    const beforePublication = freezeCandidate(packetLocator, inspection);
    const prePublicationMismatches = compareFreezeRecord(beforePublication, confirmedInspection);
    if (prePublicationMismatches.length > 0) {
      throw new Error(`Task packet changed before freeze publication: ${prePublicationMismatches.join(", ")}.`);
    }
    const retained = readRetainedFreezeRecord(root, freezeLocator);
    // Restore any validated retained publication first. The final inspection
    // below is the authority for whether current inputs still match it.
    const candidate = retained ?? freezeCandidate(packetLocator, confirmedInspection);
    const candidateErrors = validateArtifact(freezeLocator, candidate);
    if (candidateErrors.length > 0) throw new Error(formatErrors(candidateErrors));

    let validatedInspection: TaskPacketInspection | undefined;
    let validatedPublished: TaskPacketFreezeRecord | undefined;
    const validatePublication = () => {
      const inspection = assertTaskPacketAdmittedWithRoot(root.path, packetLocator, root);
      const mismatches = compareFreezeRecord(candidate, inspection);
      if (mismatches.length > 0) {
        throw new Error(`Task packet changed before freeze publication: ${mismatches.join(", ")}.`);
      }
      validatedInspection = inspection;
      const published = readOptionalJson(root.path, freezeLocator, true, root);
      if (published === undefined) return;
      const publishedErrors = validateFreezeRecord(freezeLocator, published);
      if (publishedErrors.length > 0) throw new Error(formatErrors(publishedErrors));
      const publishedMismatches = compareFreezeRecord(published as TaskPacketFreezeRecord, inspection);
      if (publishedMismatches.length > 0) {
        throw new Error(`Published freeze record changed: ${publishedMismatches.join(", ")}.`);
      }
      if (!sameDigest(digestMetadata(published), digestMetadata(candidate))) {
        throw new Error("Published freeze record bytes do not match the candidate.");
      }
      validatedPublished = published as TaskPacketFreezeRecord;
    };
    const write = writeMetadataAtomicallyIfAbsentSync(
      bundleRoot,
      freezeLocator,
      candidate,
      root,
      validatePublication,
      validatePublication,
    );
    if (!write.created) {
      const winner = readOptionalJson(bundleRoot, freezeLocator, true, root);
      if (winner === undefined) throw new Error("Freeze record disappeared after concurrent creation.");
      const errors = validateFreezeRecord(freezeLocator, winner);
      if (errors.length > 0) throw new Error(formatErrors(errors));
      const winnerDigest = digestMetadata(winner);
      const finalInspection = assertTaskPacketAdmittedWithRoot(bundleRoot, packetLocator, root);
      const finalWinner = readOptionalJson(bundleRoot, freezeLocator, true, root);
      if (finalWinner === undefined) throw new Error("Freeze record disappeared after final inspection.");
      const finalWinnerErrors = validateFreezeRecord(freezeLocator, finalWinner);
      if (finalWinnerErrors.length > 0) throw new Error(formatErrors(finalWinnerErrors));
      if (!sameDigest(winnerDigest, digestMetadata(finalWinner))) {
        throw new Error("Freeze record changed after final inspection.");
      }
      const mismatches = compareFreezeRecord(finalWinner as TaskPacketFreezeRecord, finalInspection);
      if (mismatches.length > 0) throw new Error(`Frozen task packet changed: ${mismatches.join(", ")}.`);
      return finalWinner as TaskPacketFreezeRecord;
    }

    if (validatedInspection === undefined || validatedPublished === undefined) {
      throw new Error("Freeze publication did not complete its final validation.");
    }
    return validatedPublished;
  } finally {
    closeBundleRoot(root);
  }
}

export function statusTaskPacket(
  bundleRoot: string,
  packetLocator: string,
  freezeLocator = defaultFreezeLocator(packetLocator),
): TaskPacketStatus {
  const root = openBundleRoot(bundleRoot);
  try {
    return statusTaskPacketWithRoot(bundleRoot, packetLocator, freezeLocator, root);
  } finally {
    closeBundleRoot(root);
  }
}

function statusTaskPacketWithRoot(
  bundleRoot: string,
  packetLocator: string,
  freezeLocator: string,
  root: BundleRootHandle,
): TaskPacketStatus {
  const inspection = inspectTaskPacketWithRoot(bundleRoot, packetLocator, root);
  const packetId = inspection.packet?.id ?? null;
  const packetDigest = inspection.packetDigest;
  let freeze: unknown | undefined;
  try {
    freeze = readOptionalJson(bundleRoot, freezeLocator, true, root);
  } catch (error) {
    return {
      status: "invalid",
      packetId,
      packetDigest,
      aggregateDigest: null,
      freezeLocator,
      mismatches: ["freeze-record"],
      errors: [...inspection.errors, freezeError(freezeLocator, errorMessage(error))],
    };
  }

  if (freeze === undefined) {
    return {
      status: inspection.errors.length > 0
        ? "invalid"
        : inspection.packet?.admission.status === "admitted" ? "unfrozen" : "unadmitted",
      packetId,
      packetDigest,
      aggregateDigest: null,
      freezeLocator,
      mismatches: [],
      errors: inspection.errors,
    };
  }

  const freezeErrors = validateFreezeRecord(freezeLocator, freeze);
  if (freezeErrors.length > 0) {
    return {
      status: "invalid",
      packetId,
      packetDigest,
      aggregateDigest: null,
      freezeLocator,
      mismatches: ["freeze-record"],
      errors: [...inspection.errors, ...freezeErrors],
    };
  }

  let record = freeze as TaskPacketFreezeRecord;
  if (inspection.errors.length === 0 && inspection.packet?.admission.status !== "admitted") {
    return {
      status: "unadmitted",
      packetId,
      packetDigest,
      aggregateDigest: null,
      freezeLocator,
      mismatches: ["admission"],
      errors: inspection.errors,
    };
  }
  let currentInspection = inspection;
  let mismatches = compareFreezeRecord(record, currentInspection);
  if (inspection.errors.length === 0 && mismatches.length === 0) {
    let previousInspection = inspection;
    let previousRecord = record;
    let previousFreeze = freeze;
    let settled = false;
    let lastMismatches = ["snapshot"];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nextInspection = admitTaskPacketWithRoot(bundleRoot, packetLocator, root);
      if (nextInspection.errors.length > 0 || nextInspection.packet?.admission.status !== "admitted") {
        return {
          status: nextInspection.errors.length > 0 ? "invalid" : "unadmitted",
          packetId: nextInspection.packet?.id ?? packetId,
          packetDigest: nextInspection.packetDigest,
          aggregateDigest: previousRecord.aggregateDigest,
          freezeLocator,
          mismatches: ["admission"],
          errors: nextInspection.errors,
        };
      }

      let nextFreeze: unknown | undefined;
      try {
        nextFreeze = readOptionalJson(bundleRoot, freezeLocator, true, root);
      } catch (error) {
        return {
          status: "invalid",
          packetId: nextInspection.packet?.id ?? packetId,
          packetDigest: nextInspection.packetDigest,
          aggregateDigest: null,
          freezeLocator,
          mismatches: ["freeze-record"],
          errors: [...nextInspection.errors, freezeError(freezeLocator, errorMessage(error))],
        };
      }
      if (nextFreeze === undefined) {
        return {
          status: "invalid",
          packetId: nextInspection.packet?.id ?? packetId,
          packetDigest: nextInspection.packetDigest,
          aggregateDigest: null,
          freezeLocator,
          mismatches: ["freeze-record"],
          errors: [...nextInspection.errors, freezeError(freezeLocator, "Freeze record disappeared during snapshot.")],
        };
      }
      const nextErrors = validateFreezeRecord(freezeLocator, nextFreeze);
      if (nextErrors.length > 0) {
        return {
          status: "invalid",
          packetId: nextInspection.packet?.id ?? packetId,
          packetDigest: nextInspection.packetDigest,
          aggregateDigest: null,
          freezeLocator,
          mismatches: ["freeze-record"],
          errors: [...nextInspection.errors, ...nextErrors],
        };
      }

      const nextRecord = nextFreeze as TaskPacketFreezeRecord;
      const packetDrift = compareFreezeRecord(previousRecord, nextInspection);
      const freezeDrift = !sameDigest(digestMetadata(previousFreeze), digestMetadata(nextFreeze));
      const nextMismatches = compareFreezeRecord(nextRecord, nextInspection);
      const finalInspection = admitTaskPacketWithRoot(bundleRoot, packetLocator, root);
      if (finalInspection.errors.length > 0 || finalInspection.packet?.admission.status !== "admitted") {
        return {
          status: finalInspection.errors.length > 0 ? "invalid" : "unadmitted",
          packetId: finalInspection.packet?.id ?? packetId,
          packetDigest: finalInspection.packetDigest,
          aggregateDigest: nextRecord.aggregateDigest,
          freezeLocator,
          mismatches: ["admission"],
          errors: finalInspection.errors,
        };
      }
      const finalMismatches = compareFreezeRecord(nextRecord, finalInspection);
      lastMismatches = [
        ...packetDrift,
        ...(freezeDrift ? ["freeze-record"] : []),
        ...nextMismatches,
        ...finalMismatches,
      ];
      if (lastMismatches.length === 0) {
        currentInspection = finalInspection;
        record = nextRecord;
        mismatches = [];
        settled = true;
        break;
      }
      previousInspection = finalInspection;
      previousRecord = nextRecord;
      previousFreeze = nextFreeze;
    }
    if (!settled) {
      currentInspection = previousInspection;
      record = previousRecord;
      mismatches = lastMismatches;
    }
  }
  return {
    status: currentInspection.errors.length > 0 ? "invalid" : mismatches.length > 0 ? "changed" : "frozen",
    packetId: currentInspection.packet?.id ?? packetId,
    packetDigest: currentInspection.packetDigest,
    aggregateDigest: record.aggregateDigest,
    freezeLocator,
    mismatches,
    errors: currentInspection.errors,
  };
}

export function formatErrors(errors: readonly ArtifactValidationError[]): string {
  return errors.map((error) => `${error.artifact} [${error.schemaVersion}] ${error.field}: ${error.message}`).join("\n");
}

export function assertTaskPacketFreezeRecord(record: TaskPacketFreezeRecord): void {
  const errors = validateFreezeRecord(record.packetLocator, record);
  if (errors.length > 0) throw new Error(formatErrors(errors));
  const expectedAggregate = aggregateDigest(
    record.packetId,
    record.packetLocator,
    record.preAdmissionDigest,
    record.packetDigest,
    record.components,
    record.frozenAt,
  );
  if (!sameDigest(record.aggregateDigest, expectedAggregate)) {
    throw new Error("Freeze record aggregate digest does not match its components.");
  }
}

function resolveComponent(
  bundleRoot: string,
  reference: ArtifactReference,
  field: string,
  artifact: string,
  errors: ArtifactValidationError[],
  root: BundleRootHandle,
  maxCompressedBytes?: number,
  archive?: { limits: TaskPacket["agentInput"]["fixture"]["source"]["limits"]; includePaths: readonly string[] },
): Digest | null {
  try {
    if (maxCompressedBytes === undefined) return resolveBundleArtifactDigest(bundleRoot, reference, root);
    const bytes = resolveTaskArchive(bundleRoot, reference, maxCompressedBytes, root);
    if (archive !== undefined) validateTaskArchive(bytes, archive.limits, archive.includePaths);
    return digestBytes(bytes);
  } catch (error) {
    errors.push(packetError(artifact, field, errorMessage(error)));
    return null;
  }
}

function resolveReviewRecord(
  bundleRoot: string,
  reference: ArtifactReference,
  expectedPreAdmissionDigest: Digest,
  expectedAdmission: TaskPacket["admission"],
  field: string,
  artifact: string,
  errors: ArtifactValidationError[],
  root: BundleRootHandle,
): Digest | null {
  try {
    const bytes = resolveBundleArtifact(bundleRoot, reference, MAX_TASK_PACKET_METADATA_BYTES, root);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateJsonKeys(text);
    const record = JSON.parse(text) as unknown;
    const bound = record !== null && typeof record === "object" && !Array.isArray(record)
      ? (record as { preAdmissionDigest?: unknown }).preAdmissionDigest
      : undefined;
    if (!isDigest(bound) || !sameDigest(bound, expectedPreAdmissionDigest)) {
      throw new Error("Review record does not bind the packet's pre-admission digest.");
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Review record does not bind the packet's admission decision.");
    }
    const reviewed = record as { decision?: unknown; reviewedAt?: unknown; reviewedBy?: unknown };
    const review = expectedAdmission.review;
    if (review === null || reviewed.decision !== expectedAdmission.status
        || reviewed.reviewedAt !== review.reviewedAt || reviewed.reviewedBy !== review.reviewedBy) {
      throw new Error("Review record does not bind the packet's admission decision.");
    }
    return digestBytes(bytes);
  } catch (error) {
    errors.push(packetError(artifact, field, errorMessage(error)));
    return null;
  }
}

function freezeCandidate(packetLocator: string, inspection: TaskPacketInspection, frozenAt = new Date().toISOString()): TaskPacketFreezeRecord {
  const packet = inspection.packet;
  const preAdmissionDigest = inspection.preAdmissionDigest;
  const packetDigest = inspection.packetDigest;
  const components = inspection.components;
  if (packet === null || preAdmissionDigest === null || packetDigest === null || components === null) {
    throw new Error("Cannot freeze an incomplete task-packet inspection.");
  }
  return {
    schemaVersion: TASK_PACKET_FREEZE_SCHEMA_VERSION,
    packetId: packet.id,
    packetLocator,
    preAdmissionDigest,
    packetDigest,
    components,
    aggregateDigest: aggregateDigest(packet.id, packetLocator, preAdmissionDigest, packetDigest, components, frozenAt),
    frozenAt,
  };
}

export function assertFreezeLocatorPathWithinLimits(freezeLocator: string, packetLocator: string): void {
  const leafLength = freezeLocator.slice(freezeLocator.lastIndexOf("/") + 1).length;
  if (freezeLocator.length + FREEZE_QUARANTINE_SUFFIX.length > 960
      || leafLength + FREEZE_QUARANTINE_SUFFIX.length > 255) {
    throw new Error(`Freeze locator "${freezeLocator}" for packet "${packetLocator}" exceeds safe path limits including quarantine.`);
  }
}

function validateFreezeRecord(freezeLocator: string, document: unknown): ArtifactValidationError[] {
  if (isRecord(document) && document.schemaVersion !== TASK_PACKET_FREEZE_SCHEMA_VERSION) {
    return [
      {
        artifact: freezeLocator,
        schemaVersion: TASK_PACKET_FREEZE_SCHEMA_VERSION,
        field: "/schemaVersion",
        message: `must equal ${TASK_PACKET_FREEZE_SCHEMA_VERSION}`,
      },
    ];
  }
  return validateArtifact(freezeLocator, document);
}

function validateTaskPacket(packetLocator: string, document: unknown): ArtifactValidationError[] {
  if (isRecord(document) && document.schemaVersion !== TASK_PACKET_SCHEMA_VERSION) {
    return [packetError(packetLocator, "/schemaVersion", `must equal ${TASK_PACKET_SCHEMA_VERSION}`)];
  }
  return validateArtifact(packetLocator, document);
}

function aggregateDigest(
  packetId: string,
  packetLocator: string,
  preAdmissionDigest: Digest,
  packetDigest: Digest,
  components: TaskPacketComponents,
  frozenAt: string,
): Digest {
  return digestMetadata({ packetId, packetLocator, preAdmissionDigest, packetDigest, components, frozenAt });
}

function compareFreezeRecord(record: TaskPacketFreezeRecord, inspection: TaskPacketInspection): string[] {
  const mismatches: string[] = [];
  if (record.packetId !== inspection.packet?.id) mismatches.push("packetId");
  if (record.packetLocator !== inspection.packetLocator) mismatches.push("packetLocator");
  if (!sameDigest(record.preAdmissionDigest, inspection.preAdmissionDigest)) mismatches.push("pre-admission");
  if (!sameDigest(record.packetDigest, inspection.packetDigest)) mismatches.push("packet");

  const current = inspection.components;
  if (current === null) {
    mismatches.push("components");
    return mismatches;
  }
  for (const component of ["prompt", "fixture", "verifier", "reviewRecord"] as const) {
    if (!sameDigest(record.components[component], current[component])) mismatches.push(`components.${component}`);
  }
  for (const component of ["reference", "controlledPerturbation"] as const) {
    if (!sameComponent(record.components[component], current[component])) mismatches.push(`components.${component}`);
  }
  if (inspection.packetDigest !== null && inspection.packet !== null && inspection.preAdmissionDigest !== null) {
    const aggregate = aggregateDigest(
      inspection.packet.id,
      inspection.packetLocator,
      inspection.preAdmissionDigest!,
      inspection.packetDigest,
      current,
      record.frozenAt,
    );
    if (!sameDigest(record.aggregateDigest, aggregate)) mismatches.push("aggregate");
  } else {
    mismatches.push("aggregate");
  }
  return mismatches;
}

function sameDigest(left: Digest | null, right: Digest | null): boolean {
  if (left === null || right === null) return left === right;
  return left.algorithm === right.algorithm && left.value === right.value;
}

function isDigest(value: unknown): value is Digest {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as { algorithm?: unknown }).algorithm === "sha256"
    && typeof (value as { value?: unknown }).value === "string"
    && /^[a-f0-9]{64}$/.test((value as { value: string }).value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameComponent(left: TaskPacketComponent, right: TaskPacketComponent): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "referenced" || right.status !== "referenced") return true;
  return sameDigest(left.digest, right.digest);
}

function readOptionalJson(
  bundleRoot: string,
  locator: string,
  retryTransientLink = false,
  rootHandle?: BundleRootHandle,
): unknown | undefined {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readBundleFile(bundleRoot, locator, rootHandle, true));
      assertNoDuplicateJsonKeys(text);
      return JSON.parse(text);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      if (!retryTransientLink || attempt >= MAX_TRANSIENT_LINK_READ_RETRIES || !(error instanceof Error)
          || !error.message.includes("not an isolated regular file")) throw error;
      if (removeTemporaryFreezeLinks(bundleRoot, locator, rootHandle)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function removeTemporaryFreezeLinks(bundleRoot: string, locator: string, rootHandle?: BundleRootHandle): boolean {
  const rootIdentity = rootHandle ?? openBundleRoot(bundleRoot);
  const ownsRoot = rootHandle === undefined;
  const root = rootIdentity.path;
  const rootDescriptor = rootIdentity.descriptor;
  let removed = false;
  try {
    assertBundleRoot(root, rootDescriptor, locator);
    const destination = assertBundlePathWithoutLinks(root, locator);
    const parent = dirname(destination);
    const parentDescriptor = openFreezeParent(root, parent, locator, rootDescriptor);
    const originalCwd = process.cwd();
    let changedCwd = false;
    try {
      process.chdir(parent);
      changedCwd = true;
      assertBundleRoot(root, rootDescriptor, locator);
      assertFreezeParent(root, parent, parentDescriptor, locator);
      if (hasAlias(`${relative(parent, destination)}.quarantine`, lstatSync(relative(parent, destination)))) return false;
      const destinationStat = lstatSync(relative(parent, destination));
      const ownership = readPublicationOwnership(destination, destinationStat, locator);
      if (ownership === undefined || !isPublicationOwnershipCurrent(destination, ownership, locator)) return false;
      const stagingName = ownership.marker.stagingPath;
      if (typeof stagingName !== "string") return false;

      const directory = opendirSync(".");
      let scanned = 0;
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          scanned += 1;
          if (scanned > MAX_FREEZE_RECOVERY_ENTRIES) {
            throw new Error("Freeze recovery directory exceeds its entry limit.");
          }
          const name = entry.name;
          if (name !== stagingName) continue;
          try {
            const temporaryStat = lstatSync(name);
            if (temporaryStat.isFile() && TEMPORARY_FREEZE_LINK_PATTERN.test(name)
                && temporaryStat.dev === destinationStat.dev && temporaryStat.ino === destinationStat.ino) {
              const targetDescriptor = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
              try {
                const openedTarget = fstatSync(targetDescriptor);
                if (!openedTarget.isFile() || openedTarget.nlink < 2
                    || openedTarget.dev !== destinationStat.dev || openedTarget.ino !== destinationStat.ino) continue;
                assertFreezeParent(root, parent, parentDescriptor, locator);
                const currentDestination = lstatSync(relative(parent, destination));
                const currentTemporary = lstatSync(name);
                if (!sameFileIdentity(currentDestination, currentTemporary)
                    || !sameFileIdentity(openedTarget, currentTemporary)) continue;
                if (preserveRecoveredTemporaryLink(name, destination, targetDescriptor)) removed = true;
                assertFreezeParent(root, parent, parentDescriptor, locator);
              } finally {
                closeSync(targetDescriptor);
              }
            }
          } catch (error) {
            if (!isErrno(error, "ENOENT")) throw error;
          }
        }
      } finally {
        directory.closeSync();
      }

      if (removed) fsyncSync(parentDescriptor);
    } finally {
      if (changedCwd) process.chdir(originalCwd);
      closeSync(parentDescriptor);
    }
  } finally {
    if (ownsRoot) closeBundleRoot(rootIdentity);
  }
  return removed;
}

function preserveRecoveredTemporaryLink(name: string, destination: string, descriptor: number): boolean {
  const expected = fstatSync(descriptor);
  const recoveryName = `${destination}.recovered`;
  try {
    lstatSync(recoveryName);
    return false;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  try {
    const current = lstatSync(name);
    if (!sameFileIdentity(expected, current)) return false;
    linkSync(name, recoveryName);
    const linked = lstatSync(recoveryName);
    if (!sameFileIdentity(expected, linked)) {
      // Keep the unexpected recovery alias: Node has no descriptor-bound
      // unlink, and removing it by pathname could delete a replacement.
      return false;
    }
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function readBundleFile(
  bundleRoot: string,
  locator: string,
  rootHandle?: BundleRootHandle,
  allowPublicationAliases = false,
): Buffer {
  if (!isSafeArtifactRelativePath(locator)) throw new Error(`Artifact path "${locator}" is unsafe.`);
  const rootIdentity = rootHandle ?? openBundleRoot(bundleRoot);
  const ownsRoot = rootHandle === undefined;
  const root = rootIdentity.path;
  const rootDescriptor = rootIdentity.descriptor;
  try {
    const path = resolve(root, locator);
    const descriptor = openBundleRegularFile(bundleRoot, locator, "Artifact path", rootIdentity);
    try {
      const opened = fstatSync(descriptor);
      const openedTimes = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || (opened.nlink > 1 && (!allowPublicationAliases || !hasPublicationAliases(path, locator, opened)))) {
        throw new Error(`Artifact path "${locator}" is not an isolated regular file.`);
      }
      if (!Number.isSafeInteger(opened.size) || opened.size > MAX_TASK_PACKET_METADATA_BYTES) {
        throw new Error(`Artifact path "${locator}" exceeds its metadata size limit.`);
      }
      assertBundleRoot(root, rootDescriptor, locator);
      const current = lstatSync(assertBundlePathWithoutLinks(root, locator));
      if (opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new Error(`Artifact path "${locator}" changed after bundle-root verification.`);
      }
      const bytes = Buffer.alloc(opened.size);
      for (let offset = 0; offset < opened.size;) {
        const read = readSync(descriptor, bytes, offset, opened.size - offset, offset);
        if (read === 0) throw new Error(`Artifact path "${locator}" changed while it was being read.`);
        offset += read;
      }
      const trailing = Buffer.allocUnsafe(1);
      if (readSync(descriptor, trailing, 0, 1, opened.size) !== 0) {
        throw new Error(`Artifact path "${locator}" changed while it was being read.`);
      }
      const completed = fstatSync(descriptor);
      const completedTimes = fstatSync(descriptor, { bigint: true });
      if (!completed.isFile() || (completed.nlink > 1 && (!allowPublicationAliases || !hasPublicationAliases(path, locator, completed)))
          || completed.dev !== opened.dev || completed.ino !== opened.ino
          || completed.size !== opened.size || completedTimes.mtimeNs !== openedTimes.mtimeNs
          || completedTimes.ctimeNs !== openedTimes.ctimeNs
          || completed.size > MAX_TASK_PACKET_METADATA_BYTES || bytes.length !== opened.size) {
        throw new Error(`Artifact path "${locator}" changed while it was being read.`);
      }
      assertBundleRoot(root, rootDescriptor, locator);
      const finalPath = lstatSync(assertBundlePathWithoutLinks(root, locator));
      if (finalPath.dev !== completed.dev || finalPath.ino !== completed.ino) {
        throw new Error(`Artifact path "${locator}" changed after bundle-root verification.`);
      }
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  } finally {
    if (ownsRoot) closeBundleRoot(rootIdentity);
  }
}

function hasPublicationAliases(path: string, locator: string, target: { dev: number; ino: number; nlink: number }): boolean {
  const ownership = readPublicationOwnership(path, target, locator);
  if (ownership === undefined) return false;
  const openedTarget = aliasIdentity(path, target);
  const quarantine = aliasIdentity(`${path}.quarantine`, target);
  const recovered = aliasIdentity(`${path}.recovered`, target);
  const staging = hasStagingAlias(path, target, ownership);
  if (openedTarget === undefined || (staging !== undefined && quarantine === undefined && recovered === undefined)) return false;
  const accounted = Number(quarantine !== undefined) + Number(recovered !== undefined) + Number(staging !== undefined);
  if (accounted === 0 || !isPublicationOwnershipCurrent(path, ownership, locator)) return false;
  const currentTarget = aliasIdentity(path, target);
  const currentQuarantine = aliasIdentity(`${path}.quarantine`, target);
  const currentRecovered = aliasIdentity(`${path}.recovered`, target);
  const currentStaging = hasStagingAlias(path, target, ownership);
  return currentTarget !== undefined && sameFileIdentity(openedTarget, currentTarget)
    && sameOptionalIdentity(quarantine, currentQuarantine)
    && sameOptionalIdentity(recovered, currentRecovered)
    && sameOptionalIdentity(staging, currentStaging)
    && isPublicationOwnershipCurrent(path, ownership, locator)
    && currentTarget.nlink === 1 + accounted;
}

function hasStagingAlias(
  path: string,
  target: { dev: number; ino: number },
  ownership: PublicationOwnership,
): FileIdentity | undefined {
  const stagingPath = ownership.marker.stagingPath;
  if (typeof stagingPath !== "string") return undefined;
  try {
    const staging = lstatSync(resolve(dirname(path), stagingPath));
    return sameFileIdentity(target, staging) ? staging : undefined;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function readStagingPath(path: string, locator: string): string | undefined {
  const markerSuffix = ".quarantine.marker";
  return path.endsWith(markerSuffix)
    ? readPublicationStagingPath(path.slice(0, -markerSuffix.length), locator)
    : undefined;
}

function hasAlias(path: string, target: { dev: number; ino: number }): boolean {
  try {
    return sameFileIdentity(target, lstatSync(path));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

type FileIdentity = { dev: number; ino: number; nlink?: number };

function aliasIdentity(path: string, target: FileIdentity): FileIdentity | undefined {
  try {
    const alias = lstatSync(path);
    return sameFileIdentity(target, alias) ? alias : undefined;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function sameOptionalIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameFileIdentity(left, right);
}

function assertBundlePathWithoutLinks(bundleRoot: string, locator: string): string {
  let path = bundleRoot;
  const segments = locator.split("/");
  for (const [index, segment] of segments.entries()) {
    path = resolve(path, segment);
    const entry = lstatSync(path);
    if (!isContained(bundleRoot, path) || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${locator}" escapes its declared root.`);
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      throw new Error(`Artifact path "${locator}" is not an isolated regular file.`);
    }
  }
  return path;
}

function assertBundleRoot(root: string, descriptor: number, locator: string): void {
  const opened = fstatSync(descriptor);
  const current = lstatSync(root);
  if (!opened.isDirectory() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`Artifact path "${locator}" bundle root changed during verification.`);
  }
}

function openFreezeParent(root: string, parent: string, locator: string, rootDescriptor: number): number {
  assertBundleRoot(root, rootDescriptor, locator);
  assertFreezeParentPath(root, parent, locator);

  const descriptor = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const currentStat = lstatSync(parent);
    if (!opened.isDirectory() || currentStat.isSymbolicLink()
        || opened.dev !== currentStat.dev || opened.ino !== currentStat.ino) {
      throw new Error(`Artifact path "${locator}" parent changed during recovery.`);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertFreezeParent(root: string, parent: string, descriptor: number, locator: string): void {
  assertFreezeParentPath(root, parent, locator);
  const opened = fstatSync(descriptor);
  const current = lstatSync(parent);
  const cwd = lstatSync(".");
  if (!opened.isDirectory() || current.isSymbolicLink() || cwd.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino
      || opened.dev !== cwd.dev || opened.ino !== cwd.ino) {
    throw new Error(`Artifact path "${locator}" parent changed during recovery.`);
  }
}

function assertFreezeParentPath(root: string, parent: string, locator: string): void {
  if (!isContained(root, parent)) throw new Error(`Artifact path "${locator}" escapes its declared root.`);
  let current = root;
  const segments = relative(root, parent) === "" ? [] : relative(root, parent).split(sep);
  for (const segment of segments) {
    current = resolve(current, segment);
    const entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${locator}" crosses a symbolic link.`);
    }
  }
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function packetError(artifact: string, field: string, message: string): ArtifactValidationError {
  return { artifact, schemaVersion: "ebo.task-packet/v1", field, message };
}

function freezeError(artifact: string, message: string): ArtifactValidationError {
  return { artifact, schemaVersion: TASK_PACKET_FREEZE_SCHEMA_VERSION, field: "/", message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to read task packet.";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}
