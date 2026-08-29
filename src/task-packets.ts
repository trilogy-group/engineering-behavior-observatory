import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  digestBytes,
  digestMetadata,
  validateArtifact,
  writeMetadataAtomicallyIfAbsentSync,
  type ArtifactValidationError,
} from "./artifacts.js";
import {
  isSafeArtifactRelativePath,
  resolveBundleArtifact,
  resolveTaskArchive,
  type ArtifactReference,
  type Digest,
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

export function inspectTaskPacket(bundleRoot: string, packetLocator: string): TaskPacketInspection {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBundleFile(bundleRoot, packetLocator)));
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

  const errors = validateArtifact(packetLocator, document);
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
      packet.agentInput.fixture.source.limits.maxCompressedBytes,
    ),
    reference: "locator" in packet.restricted.referenceSolution
      ? { status: "referenced", digest: resolveComponent(bundleRoot, packet.restricted.referenceSolution, "/restricted/referenceSolution", packetLocator, errors) }
      : { status: packet.restricted.referenceSolution.status },
    verifier: resolveComponent(bundleRoot, packet.restricted.verifier, "/restricted/verifier", packetLocator, errors),
    reviewRecord: packet.admission.review === null
      ? null
      : resolveReviewRecord(
        bundleRoot,
        packet.admission.review.reviewRecord,
        preAdmissionDigest,
        "/admission/review/reviewRecord",
        packetLocator,
        errors,
      ),
    controlledPerturbation: "reference" in packet.controlledPerturbation
      ? { status: "referenced", digest: resolveComponent(bundleRoot, packet.controlledPerturbation.reference, "/controlledPerturbation/reference", packetLocator, errors) }
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
  const inspection = inspectTaskPacket(bundleRoot, packetLocator);
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

export function modelVisibleTaskPacket(packet: TaskPacket): TaskPacket["agentInput"] {
  return structuredClone(packet.agentInput);
}

export function defaultFreezeLocator(packetLocator: string): string {
  return `${packetLocator}.freeze.json`;
}

export function freezeTaskPacket(
  bundleRoot: string,
  packetLocator: string,
  freezeLocator = defaultFreezeLocator(packetLocator),
): TaskPacketFreezeRecord {
  if (packetLocator === freezeLocator) {
    throw new Error("Freeze record must use a path distinct from the task packet.");
  }

  const inspection = assertTaskPacketAdmitted(bundleRoot, packetLocator);
  const packet = inspection.packet!;
  const preAdmissionDigest = inspection.preAdmissionDigest!;
  const packetDigest = inspection.packetDigest!;
  const components = inspection.components!;
  const candidate: TaskPacketFreezeRecord = {
    schemaVersion: TASK_PACKET_FREEZE_SCHEMA_VERSION,
    packetId: packet.id,
    packetLocator,
    preAdmissionDigest,
    packetDigest,
    components,
    aggregateDigest: aggregateDigest(packet.id, packetLocator, preAdmissionDigest, packetDigest, components),
    frozenAt: new Date().toISOString(),
  };

  const write = writeMetadataAtomicallyIfAbsentSync(bundleRoot, freezeLocator, candidate);
  if (!write.created) {
    const winner = readOptionalJson(bundleRoot, freezeLocator);
    if (winner === undefined) throw new Error("Freeze record disappeared after concurrent creation.");
    const errors = validateArtifact(freezeLocator, winner);
    if (errors.length > 0) throw new Error(formatErrors(errors));
    const mismatches = compareFreezeRecord(winner as TaskPacketFreezeRecord, inspection);
    if (mismatches.length > 0) throw new Error(`Frozen task packet changed: ${mismatches.join(", ")}.`);
    return winner as TaskPacketFreezeRecord;
  }

  return candidate;
}

export function statusTaskPacket(
  bundleRoot: string,
  packetLocator: string,
  freezeLocator = defaultFreezeLocator(packetLocator),
): TaskPacketStatus {
  const inspection = inspectTaskPacket(bundleRoot, packetLocator);
  const packetId = inspection.packet?.id ?? null;
  const packetDigest = inspection.packetDigest;
  const freeze = readOptionalJson(bundleRoot, freezeLocator);

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

  const freezeErrors = validateArtifact(freezeLocator, freeze);
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

  const record = freeze as TaskPacketFreezeRecord;
  const mismatches = compareFreezeRecord(record, inspection);
  return {
    status: inspection.errors.length > 0 ? "invalid" : mismatches.length > 0 ? "changed" : "frozen",
    packetId,
    packetDigest,
    aggregateDigest: record.aggregateDigest,
    freezeLocator,
    mismatches,
    errors: inspection.errors,
  };
}

export function formatErrors(errors: readonly ArtifactValidationError[]): string {
  return errors.map((error) => `${error.artifact} [${error.schemaVersion}] ${error.field}: ${error.message}`).join("\n");
}

function resolveComponent(
  bundleRoot: string,
  reference: ArtifactReference,
  field: string,
  artifact: string,
  errors: ArtifactValidationError[],
  maxCompressedBytes?: number,
): Digest | null {
  try {
    const bytes = maxCompressedBytes === undefined
      ? resolveBundleArtifact(bundleRoot, reference)
      : resolveTaskArchive(bundleRoot, reference, maxCompressedBytes);
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
  field: string,
  artifact: string,
  errors: ArtifactValidationError[],
): Digest | null {
  try {
    const bytes = resolveBundleArtifact(bundleRoot, reference);
    const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const bound = record !== null && typeof record === "object" && !Array.isArray(record)
      ? (record as { preAdmissionDigest?: unknown }).preAdmissionDigest
      : undefined;
    if (!isDigest(bound) || !sameDigest(bound, expectedPreAdmissionDigest)) {
      throw new Error("Review record does not bind the packet's pre-admission digest.");
    }
    return digestBytes(bytes);
  } catch (error) {
    errors.push(packetError(artifact, field, errorMessage(error)));
    return null;
  }
}

function aggregateDigest(
  packetId: string,
  packetLocator: string,
  preAdmissionDigest: Digest,
  packetDigest: Digest,
  components: TaskPacketComponents,
): Digest {
  return digestMetadata({ packetId, packetLocator, preAdmissionDigest, packetDigest, components });
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

function sameComponent(left: TaskPacketComponent, right: TaskPacketComponent): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "referenced" || right.status !== "referenced") return true;
  return sameDigest(left.digest, right.digest);
}

function readOptionalJson(bundleRoot: string, locator: string): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readBundleFile(bundleRoot, locator)));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function readBundleFile(bundleRoot: string, locator: string): Buffer {
  if (!isSafeArtifactRelativePath(locator)) throw new Error(`Artifact path "${locator}" is unsafe.`);
  const root = realpathSync(bundleRoot);
  let path = root;
  for (const segment of locator.split("/")) {
    path = resolve(path, segment);
    const entry = lstatSync(path);
    if (!isContained(root, path) || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${locator}" escapes its declared root.`);
    }
  }

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink > 1) throw new Error(`Artifact path "${locator}" is not an isolated regular file.`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function packetError(artifact: string, field: string, message: string): ArtifactValidationError {
  return { artifact, schemaVersion: "ebo.task-packet/v1", field, message };
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
