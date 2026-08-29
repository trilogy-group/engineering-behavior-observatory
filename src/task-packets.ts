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
  writeMetadataAtomicallySync,
  type ArtifactValidationError,
} from "./artifacts.js";
import {
  isSafeArtifactRelativePath,
  resolveBundleArtifact,
  type ArtifactReference,
  type Digest,
} from "./contracts.js";

export type TaskPacket = {
  schemaVersion: "ebo.task-packet/v1";
  id: string;
  agentInput: {
    prompt: string;
    fixture: {
      source: ArtifactReference;
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

export type TaskPacketComponents = {
  prompt: Digest;
  fixture: Digest | null;
  reference: Digest | null;
  verifier: Digest | null;
  reviewRecord: Digest | null;
  controlledPerturbation: Digest | null;
};

export type TaskPacketFreezeRecord = {
  schemaVersion: "ebo.task-packet-freeze/v1";
  packetId: string;
  packetLocator: string;
  packetDigest: Digest;
  components: TaskPacketComponents;
  aggregateDigest: Digest;
  frozenAt: string;
};

export type TaskPacketInspection = {
  packetLocator: string;
  packet: TaskPacket | null;
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
      packetDigest: null,
      components: null,
      modelVisible: null,
      errors: [packetError(packetLocator, "/", errorMessage(error))],
    };
  }

  const errors = validateArtifact(packetLocator, document);
  if (errors.length > 0) {
    return { packetLocator, packet: null, packetDigest: null, components: null, modelVisible: null, errors };
  }

  const packet = document as TaskPacket;
  const components: TaskPacketComponents = {
    prompt: digestBytes(Buffer.from(packet.agentInput.prompt, "utf8")),
    fixture: resolveComponent(bundleRoot, packet.agentInput.fixture.source, "/agentInput/fixture/source", packetLocator, errors),
    reference: "locator" in packet.restricted.referenceSolution
      ? resolveComponent(bundleRoot, packet.restricted.referenceSolution, "/restricted/referenceSolution", packetLocator, errors)
      : null,
    verifier: resolveComponent(bundleRoot, packet.restricted.verifier, "/restricted/verifier", packetLocator, errors),
    reviewRecord: packet.admission.review === null
      ? null
      : resolveComponent(bundleRoot, packet.admission.review.reviewRecord, "/admission/review/reviewRecord", packetLocator, errors),
    controlledPerturbation: "reference" in packet.controlledPerturbation
      ? resolveComponent(bundleRoot, packet.controlledPerturbation.reference, "/controlledPerturbation/reference", packetLocator, errors)
      : null,
  };

  return {
    packetLocator,
    packet,
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
  const packetDigest = inspection.packetDigest!;
  const components = inspection.components!;
  const candidate: TaskPacketFreezeRecord = {
    schemaVersion: TASK_PACKET_FREEZE_SCHEMA_VERSION,
    packetId: packet.id,
    packetLocator,
    packetDigest,
    components,
    aggregateDigest: aggregateDigest(packet.id, packetLocator, packetDigest, components),
    frozenAt: new Date().toISOString(),
  };

  const existing = readOptionalJson(bundleRoot, freezeLocator);
  if (existing !== undefined) {
    const errors = validateArtifact(freezeLocator, existing);
    if (errors.length > 0) throw new Error(formatErrors(errors));
    const record = existing as TaskPacketFreezeRecord;
    const mismatches = compareFreezeRecord(record, inspection);
    if (mismatches.length > 0) {
      throw new Error(`Frozen task packet changed: ${mismatches.join(", ")}.`);
    }
    return record;
  }

  writeMetadataAtomicallySync(bundleRoot, freezeLocator, candidate);
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
): Digest | null {
  try {
    return digestBytes(resolveBundleArtifact(bundleRoot, reference));
  } catch (error) {
    errors.push(packetError(artifact, field, errorMessage(error)));
    return null;
  }
}

function aggregateDigest(
  packetId: string,
  packetLocator: string,
  packetDigest: Digest,
  components: TaskPacketComponents,
): Digest {
  return digestMetadata({ packetId, packetLocator, packetDigest, components });
}

function compareFreezeRecord(record: TaskPacketFreezeRecord, inspection: TaskPacketInspection): string[] {
  const mismatches: string[] = [];
  if (record.packetId !== inspection.packet?.id) mismatches.push("packetId");
  if (record.packetLocator !== inspection.packetLocator) mismatches.push("packetLocator");
  if (!sameDigest(record.packetDigest, inspection.packetDigest)) mismatches.push("packet");

  const current = inspection.components;
  if (current === null) {
    mismatches.push("components");
    return mismatches;
  }
  for (const component of ["prompt", "fixture", "reference", "verifier", "reviewRecord", "controlledPerturbation"] as const) {
    if (!sameDigest(record.components[component], current[component])) mismatches.push(`components.${component}`);
  }
  if (inspection.packetDigest !== null && inspection.packet !== null) {
    const aggregate = aggregateDigest(inspection.packet.id, inspection.packetLocator, inspection.packetDigest, current);
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
