import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

import {
  assertNoDuplicateJsonKeys,
  assertUniqueArtifactIdentities,
  canonicalizeMetadata,
  digestBytes,
  validateArtifact,
  validateRunManifestEvidence,
} from "./artifacts.js";
import { isSafeArtifactRelativePath, readTaskArchive, resolveBundleArtifact } from "./contracts.js";
import { readPortableRunBundleExport } from "./exports.js";
import type { PortableExportArtifact, PortableExportManifest, PortableExportPolicy } from "./exports.js";
import type { RunBundleEvidenceDescriptor, RunManifest } from "./run-bundles.js";
import { readBoundedFile } from "./scheduler.js";

type DigestString = `sha256:${string}`;

export type CorpusSourceIssue = {
  field: string;
  message: string;
};

export type CorpusIndexEntry = {
  schemaVersion: "ebo.corpus-index-entry/v1";
  manifestKind: "run" | "export" | "unknown";
  manifestPath: string;
  manifestDigest: DigestString;
  bundleId?: string;
  runId?: string;
  trialId?: string;
  attemptId?: string;
  attemptNumber?: number;
  retryOf?: string;
  taskId?: string;
  fixtureId?: string;
  modelProvider?: string;
  modelId?: string;
  harnessId?: string;
  harnessVersion?: string;
  assessmentMode?: string;
  configurationDigest?: DigestString;
  terminalState?: string;
  failureClass?: string;
  stopReason?: string;
  verifierLocator?: string;
  verifierDigest?: DigestString;
  verifierArtifactIds: string[];
  verifierStatuses: string[];
  captureArtifactIds: string[];
  captureQualification?: string;
  exportArtifactIds: string[];
  exportStatus?: string;
  sharingClass?: string;
  policyDigest?: DigestString;
  sourceManifestDigest?: DigestString;
  issues: CorpusSourceIssue[];
};

export type CorpusIndexQuery = Partial<Pick<CorpusIndexEntry,
  | "manifestKind"
  | "runId"
  | "attemptId"
  | "taskId"
  | "modelId"
  | "harnessId"
  | "assessmentMode"
  | "terminalState"
  | "failureClass"
  | "captureQualification"
  | "exportStatus"
  | "sharingClass"
>> & { verifierStatus?: string };

export type CorpusIndexValidationIssue = {
  kind: "duplicate" | "missing" | "digest-mismatch" | "stale" | "unindexed" | "evidence";
  manifestPath: string;
  message: string;
};

const INDEX_SCHEMA_VERSION = "ebo.corpus-index-entry/v1" as const;
const MAX_CORPUS_MANIFESTS = 100_000;
const MAX_CORPUS_INDEX_BYTES = 512 * 1024 * 1024;
const MAX_PORTABLE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_PORTABLE_ARCHIVE_MEMBERS = 10_000;
const TAR_BLOCK_BYTES = 512;

/** Rebuild the non-authoritative corpus view from current run and export manifests. */
export function buildCorpusIndex(corpusRoot: string): CorpusIndexEntry[] {
  const root = resolve(corpusRoot);
  return discoverManifestPaths(root).map((manifestPath) => projectManifest(root, manifestPath));
}

export function writeCorpusIndex(path: string, entries: readonly CorpusIndexEntry[]): void {
  const bytes = Buffer.from(entries.map((entry) => canonicalizeMetadata(entry)).join("\n") + (entries.length === 0 ? "" : "\n"));
  if (bytes.length > MAX_CORPUS_INDEX_BYTES) throw new Error("Corpus index exceeds its local byte limit.");
  writeAtomically(path, bytes, true);
}

export function readCorpusIndex(path: string): CorpusIndexEntry[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(path, "Corpus index", undefined, MAX_CORPUS_INDEX_BYTES),
  );
  if (text.trim() === "") return [];
  return text.trimEnd().split("\n").map((line, index) => {
    assertNoDuplicateJsonKeys(line);
    const entry = JSON.parse(line) as unknown;
    assertCorpusIndexEntry(entry, index + 1);
    return entry;
  });
}

export function queryCorpusIndex(
  entries: readonly CorpusIndexEntry[],
  query: CorpusIndexQuery,
): CorpusIndexEntry[] {
  const filters = Object.entries(query) as Array<[keyof CorpusIndexQuery, string]>;
  return entries.filter((entry) => filters.every(([field, value]) => field === "verifierStatus"
    ? entry.verifierStatuses.includes(value)
    : entry[field] === value));
}

export function validateCorpusIndex(
  corpusRoot: string,
  entries: readonly CorpusIndexEntry[],
): CorpusIndexValidationIssue[] {
  const issues: CorpusIndexValidationIssue[] = [];
  const indexed = new Map<string, CorpusIndexEntry>();
  for (const entry of entries) {
    if (indexed.has(entry.manifestPath)) {
      issues.push({ kind: "duplicate", manifestPath: entry.manifestPath, message: "Manifest path occurs more than once in the index." });
    } else indexed.set(entry.manifestPath, entry);
  }

  const current = new Map(buildCorpusIndex(corpusRoot).map((entry) => [entry.manifestPath, entry]));
  for (const [manifestPath, entry] of indexed) {
    const rebuilt = current.get(manifestPath);
    if (rebuilt === undefined) {
      issues.push({ kind: "missing", manifestPath, message: "Indexed manifest is missing from the corpus." });
    } else if (entry.manifestDigest !== rebuilt.manifestDigest) {
      issues.push({ kind: "digest-mismatch", manifestPath, message: "Indexed manifest digest does not match current bytes." });
    } else if (canonicalizeMetadata(entry) !== canonicalizeMetadata(rebuilt)) {
      issues.push({ kind: "stale", manifestPath, message: "Indexed fields no longer match the current manifest or evidence." });
    }
  }
  for (const [manifestPath, entry] of current) {
    if (!indexed.has(manifestPath)) {
      issues.push({ kind: "unindexed", manifestPath, message: "Corpus manifest is absent from the index." });
    }
    for (const issue of entry.issues) {
      issues.push({ kind: "evidence", manifestPath, message: `${issue.field}: ${issue.message}` });
    }
  }
  return issues.sort(compareValidationIssues);
}

/** Package exactly one ready/exported derivative; unrelated sibling files are ignored. */
export async function packPortableExport(
  exportRoot: string,
  archivePath: string,
  policy: PortableExportPolicy,
): Promise<DigestString> {
  await readPortableRunBundleExport(exportRoot, policy);
  const files = readApprovedPortableExport(exportRoot);
  const archive = gzipSync(createTar(files), { level: 9 });
  if (archive.length > MAX_PORTABLE_ARCHIVE_BYTES) throw new Error("Portable archive exceeds its byte limit.");
  writeAtomically(archivePath, archive, false);
  return digestString(digestBytes(archive));
}

/** Unpack a bounded archive only when its contents exactly match the approved export manifest. */
export function unpackPortableExport(archivePath: string, destinationRoot: string): PortableExportManifest {
  const archive = readBoundedFile(archivePath, "Portable archive", undefined, MAX_PORTABLE_ARCHIVE_BYTES);
  const members = readTaskArchive(archive, {
    maxCompressedBytes: MAX_PORTABLE_ARCHIVE_BYTES,
    maxExpandedBytes: MAX_PORTABLE_ARCHIVE_BYTES,
    maxMembers: MAX_PORTABLE_ARCHIVE_MEMBERS,
  }, ["bundle"]);
  if (members.some(({ kind, path }) => kind !== "file" || !path.startsWith("bundle/"))) {
    throw new Error("Portable archive contains an unsupported member.");
  }
  const byPath = new Map(members.map((member) => [member.path.slice("bundle/".length), member.bytes]));
  if (byPath.size !== members.length) throw new Error("Portable archive contains duplicate paths.");
  const manifestBytes = byPath.get("manifest.json");
  if (manifestBytes === undefined) throw new Error("Portable archive omits manifest.json.");
  const manifest = parseApprovedExportManifest(manifestBytes);
  const expected = new Set(["manifest.json", ...manifest.artifacts.map(({ relativePath }) => relativePath)]);
  if (expected.size !== byPath.size || [...byPath.keys()].some((path) => !expected.has(path))) {
    throw new Error("Portable archive contents do not exactly match its export manifest.");
  }
  verifyPortableArtifacts(manifest, (artifact) => byPath.get(artifact.relativePath));

  const destination = resolve(destinationRoot);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  try {
    for (const [relativePath, bytes] of [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const path = join(destination, ...relativePath.split("/"));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    }
    readApprovedPortableExport(destination);
    return structuredClone(manifest);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function discoverManifestPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === "manifest.json") {
        if (!entry.isFile()) throw new Error(`Corpus manifest "${path}" is not a regular file.`);
        const locator = relative(root, path).split(sep).join("/");
        if (!isSafeArtifactRelativePath(locator)) throw new Error(`Corpus manifest path "${locator}" is unsafe.`);
        paths.push(locator);
        if (paths.length > MAX_CORPUS_MANIFESTS) throw new Error("Corpus exceeds the local manifest limit.");
      }
    }
  };
  visit(root);
  return paths.sort();
}

function projectManifest(root: string, manifestPath: string): CorpusIndexEntry {
  const bytes = readBoundedFile(join(root, ...manifestPath.split("/")), "Corpus manifest");
  const manifestRoot = dirname(join(root, ...manifestPath.split("/")));
  const entry: CorpusIndexEntry = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    manifestKind: "unknown",
    manifestPath,
    manifestDigest: digestString(digestBytes(bytes)),
    verifierArtifactIds: [],
    verifierStatuses: [],
    captureArtifactIds: [],
    exportArtifactIds: [],
    issues: [],
  };
  let document: unknown;
  try {
    document = parseJson(bytes, `Corpus manifest ${manifestPath}`);
  } catch (error) {
    entry.issues.push({ field: "/", message: errorMessage(error) });
    return entry;
  }
  const schemaVersion = isRecord(document) ? document.schemaVersion : undefined;
  entry.manifestKind = schemaVersion === "run-manifest/v1" ? "run"
    : schemaVersion === "export-manifest/v1" ? "export" : "unknown";
  entry.issues.push(...validateArtifact(manifestPath, document).map(({ field, message }) => ({ field, message })));
  if (!isRecord(document)) return entry;
  if (typeof document.bundleId === "string") entry.bundleId = document.bundleId;
  if (entry.manifestKind === "run") projectRun(entry, document as unknown as RunManifest, manifestRoot);
  if (entry.manifestKind === "export") projectExport(entry, document as unknown as PortableExportManifest, manifestRoot);
  entry.issues = uniqueSourceIssues(entry.issues);
  return entry;
}

function projectRun(entry: CorpusIndexEntry, manifest: RunManifest, manifestRoot: string): void {
  entry.issues.push(...validateRunManifestEvidence(entry.manifestPath, manifest, manifestRoot)
    .map(({ field, message }) => ({ field, message })));
  if (isRecord(manifest.run)) {
    assignString(entry, "runId", manifest.run.id);
    assignString(entry, "trialId", entry.runId);
    assignString(entry, "taskId", isRecord(manifest.run.task) ? manifest.run.task.id : undefined);
    assignString(entry, "fixtureId", isRecord(manifest.run.fixture) ? manifest.run.fixture.id : undefined);
    assignString(entry, "modelProvider", isRecord(manifest.run.model) ? manifest.run.model.provider : undefined);
    assignString(entry, "modelId", isRecord(manifest.run.model) ? manifest.run.model.id : undefined);
    assignString(entry, "harnessId", isRecord(manifest.run.harness) ? manifest.run.harness.id : undefined);
    assignString(entry, "harnessVersion", isRecord(manifest.run.harness) ? manifest.run.harness.version : undefined);
    assignString(entry, "assessmentMode", manifest.run.assessmentMode ?? "verified");
    if (isRecord(manifest.run.verifier)) {
      assignString(entry, "verifierLocator", manifest.run.verifier.locator);
      assignDigest(entry, "verifierDigest", manifest.run.verifier.digest);
    }
  }
  if (isRecord(manifest.attempt)) {
    assignString(entry, "attemptId", manifest.attempt.id);
    const attemptNumber = numberValue(manifest.attempt.number);
    if (attemptNumber !== undefined) entry.attemptNumber = attemptNumber;
    assignString(entry, "retryOf", manifest.attempt.retryOf);
  }
  if (isRecord(manifest.configuration)) assignDigest(entry, "configurationDigest", manifest.configuration.digest);
  if (isRecord(manifest.terminal)) {
    assignString(entry, "terminalState", manifest.terminal.state);
    assignString(entry, "failureClass", manifest.terminal.failureClass);
    assignString(entry, "stopReason", manifest.terminal.stopReason);
  }
  projectEvidence(entry, manifestRoot, Array.isArray(manifest.evidence) ? manifest.evidence : []);
}

function projectExport(entry: CorpusIndexEntry, manifest: PortableExportManifest, manifestRoot: string): void {
  assignString(entry, "exportStatus", manifest.status);
  assignString(entry, "sharingClass", manifest.sharingClass);
  assignString(entry, "assessmentMode", manifest.assessmentMode ?? "verified");
  assignDigest(entry, "policyDigest", manifest.policyDigest);
  assignDigest(entry, "sourceManifestDigest", manifest.sourceManifestDigest);
  if (isRecord(manifest.correlations)) {
    assignString(entry, "runId", manifest.correlations.runId);
    assignString(entry, "trialId", entry.runId);
    assignString(entry, "attemptId", manifest.correlations.attemptId);
  }
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  entry.exportArtifactIds = artifacts
    .filter(isRecord)
    .map(({ id }) => id)
    .filter((id): id is string => typeof id === "string");
  projectEvidence(entry, manifestRoot, artifacts);
  if (["ready", "exported"].includes(String(manifest.status))) {
    try {
      readApprovedPortableExport(manifestRoot);
    } catch (error) {
      entry.issues.push({ field: "/artifacts", message: errorMessage(error) });
    }
  }
}

function projectEvidence(
  entry: CorpusIndexEntry,
  root: string,
  descriptors: readonly unknown[],
): void {
  for (const candidate of descriptors) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
    const descriptor = candidate as Pick<RunBundleEvidenceDescriptor | PortableExportArtifact, "id" | "kind" | "relativePath" | "digest">;
    if (descriptor.kind === "verifier") {
      entry.verifierArtifactIds.push(descriptor.id);
      const document = readDescriptorJson(root, candidate, entry.issues);
      if (isRecord(document) && typeof document.status === "string") entry.verifierStatuses.push(document.status);
    } else if (descriptor.kind === "capture-report") {
      entry.captureArtifactIds.push(descriptor.id);
      const document = readDescriptorJson(root, candidate, entry.issues);
      if (isRecord(document)) assignString(entry, "captureQualification", document.qualification);
    } else if (descriptor.kind === "export-manifest") entry.exportArtifactIds.push(descriptor.id);
  }
  entry.verifierArtifactIds.sort();
  entry.verifierStatuses.sort();
  entry.captureArtifactIds.sort();
  entry.exportArtifactIds.sort();
}

function readDescriptorJson(
  root: string,
  descriptor: Record<string, unknown>,
  issues: CorpusSourceIssue[],
): unknown {
  const { id, relativePath, digest } = descriptor;
  if (typeof id !== "string" || typeof relativePath !== "string" || typeof digest !== "string"
      || digestValue(digest) === undefined) return undefined;
  try {
    return parseJson(resolveBundleArtifact(root, {
      locator: relativePath,
      digest: parseDigest(digest),
    }), `Evidence ${id}`);
  } catch (error) {
    issues.push({ field: `/evidence/${id}`, message: errorMessage(error) });
    return undefined;
  }
}

function readApprovedPortableExport(exportRoot: string): Map<string, Buffer> {
  const root = resolve(exportRoot);
  const manifestBytes = readBoundedFile(join(root, "manifest.json"), "Portable export manifest");
  const manifest = parseApprovedExportManifest(manifestBytes);
  const files = new Map<string, Buffer>([["bundle/manifest.json", manifestBytes]]);
  verifyPortableArtifacts(manifest, (artifact) => {
    const bytes = resolveBundleArtifact(root, {
      locator: artifact.relativePath,
      digest: parseDigest(artifact.digest),
    }, MAX_PORTABLE_ARCHIVE_BYTES);
    files.set(`bundle/${artifact.relativePath}`, bytes);
    return bytes;
  });
  if (files.size > MAX_PORTABLE_ARCHIVE_MEMBERS) throw new Error("Portable export exceeds the archive member limit.");
  const totalBytes = [...files.values()].reduce((total, bytes) => total + bytes.length, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PORTABLE_ARCHIVE_BYTES) {
    throw new Error("Portable export exceeds the archive byte limit.");
  }
  return files;
}

function parseApprovedExportManifest(bytes: Buffer): PortableExportManifest {
  const manifest = parseJson(bytes, "Portable export manifest") as PortableExportManifest;
  const errors = validateArtifact("manifest.json", manifest);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  if (!isRecord(manifest) || !["ready", "exported"].includes(String(manifest.status))) {
    throw new Error("Portable export manifest must be ready or exported.");
  }
  if (!["partner", "public"].includes(String(manifest.sharingClass))) {
    throw new Error("Portable export manifest must use partner or public sharing.");
  }
  if (!Array.isArray(manifest.artifacts)) throw new Error("Portable export manifest has no artifacts.");
  assertUniqueArtifactIdentities(manifest.artifacts.map(({ id, relativePath }) => ({ id, relativePath })));
  if (JSON.stringify(manifest.artifactIds) !== JSON.stringify(manifest.artifacts.map(({ id }) => id))) {
    throw new Error("Portable export artifact index does not match its descriptors.");
  }
  return manifest;
}

function verifyPortableArtifacts(
  manifest: PortableExportManifest,
  read: (artifact: PortableExportArtifact) => Buffer | undefined,
): void {
  for (const artifact of manifest.artifacts) {
    const bytes = read(artifact);
    if (bytes === undefined) throw new Error(`Portable export omits artifact ${artifact.id}.`);
    if (bytes.length !== artifact.sizeBytes || digestString(digestBytes(bytes)) !== artifact.digest) {
      throw new Error(`Portable artifact ${artifact.id} does not match its descriptor.`);
    }
  }
}

function createTar(files: ReadonlyMap<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const split = splitUstarPath(path);
    let headerPath = path;
    if (split === undefined) {
      const pax = paxPathRecord(path);
      blocks.push(tarHeader(`PaxHeaders/${createHash("sha256").update(path).digest("hex").slice(0, 24)}`, pax.length, "x"));
      blocks.push(pax, padding(pax.length));
      headerPath = `files/${createHash("sha256").update(path).digest("hex")}`;
    }
    blocks.push(tarHeader(headerPath, bytes.length, "0"), bytes, padding(bytes.length));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return Buffer.concat(blocks);
}

function tarHeader(path: string, size: number, type: "0" | "x"): Buffer {
  const split = splitUstarPath(path);
  if (split === undefined) throw new Error(`Portable archive path "${path}" cannot be encoded.`);
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  header.write(split.name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("EBO", 265, 32, "ascii");
  header.write("EBO", 297, 32, "ascii");
  if (split.prefix !== "") header.write(split.prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0");
  header.write(checksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitUstarPath(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let boundary = path.lastIndexOf("/"); boundary > 0; boundary = path.lastIndexOf("/", boundary - 1)) {
    const prefix = path.slice(0, boundary);
    const name = path.slice(boundary + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return undefined;
}

function paxPathRecord(path: string): Buffer {
  const content = `path=${path}\n`;
  let length = Buffer.byteLength(content) + 2;
  while (true) {
    const record = `${length} ${content}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record);
    length = actual;
  }
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error("Portable archive value exceeds TAR field limits.");
  buffer.write(`${octal.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function padding(size: number): Buffer {
  return Buffer.alloc((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
}

function writeAtomically(path: string, bytes: Buffer, overwrite: boolean): void {
  const destination = resolve(path);
  const parent = dirname(destination);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (overwrite) renameSync(temporary, destination);
    else {
      linkSync(temporary, destination);
      unlinkSync(temporary);
    }
    const parentDescriptor = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function assertCorpusIndexEntry(value: unknown, line: number): asserts value is CorpusIndexEntry {
  if (!isRecord(value)) throw new Error(`Corpus index line ${line} is invalid.`);
  const stringArrays = [value.verifierArtifactIds, value.verifierStatuses, value.captureArtifactIds, value.exportArtifactIds];
  const optionalStrings = [
    value.bundleId, value.runId, value.trialId, value.attemptId, value.retryOf, value.taskId, value.fixtureId,
    value.modelProvider, value.modelId, value.harnessId, value.harnessVersion, value.assessmentMode, value.terminalState,
    value.failureClass, value.stopReason, value.verifierLocator, value.captureQualification, value.exportStatus,
    value.sharingClass,
  ];
  if (value.schemaVersion !== INDEX_SCHEMA_VERSION
      || !["run", "export", "unknown"].includes(String(value.manifestKind))
      || typeof value.manifestPath !== "string" || !isSafeArtifactRelativePath(value.manifestPath)
      || digestValue(value.manifestDigest) === undefined
      || stringArrays.some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string"))
      || optionalStrings.some((item) => item !== undefined && typeof item !== "string")
      || (value.attemptNumber !== undefined && (typeof value.attemptNumber !== "number"
        || !Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1))
      || [value.manifestDigest, value.configurationDigest, value.verifierDigest, value.policyDigest, value.sourceManifestDigest]
        .some((digest) => digest !== undefined && digestValue(digest) === undefined)
      || !Array.isArray(value.issues)
      || value.issues.some((issue) => !isRecord(issue) || typeof issue.field !== "string" || typeof issue.message !== "string")) {
    throw new Error(`Corpus index line ${line} is invalid.`);
  }
}

function uniqueSourceIssues(issues: readonly CorpusSourceIssue[]): CorpusSourceIssue[] {
  return [...new Map(issues.map((issue) => [`${issue.field}\0${issue.message}`, issue])).values()]
    .sort((left, right) => left.field.localeCompare(right.field) || left.message.localeCompare(right.message));
}

function compareValidationIssues(left: CorpusIndexValidationIssue, right: CorpusIndexValidationIssue): number {
  return left.manifestPath.localeCompare(right.manifestPath)
    || left.kind.localeCompare(right.kind)
    || left.message.localeCompare(right.message);
}

function parseJson(bytes: Buffer, label: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseDigest(value: string): { algorithm: "sha256"; value: string } {
  const digest = digestValue(value);
  if (digest === undefined) throw new Error("Artifact digest is invalid.");
  return { algorithm: "sha256", value: digest.slice("sha256:".length) };
}

function digestString(value: { algorithm: "sha256"; value: string }): DigestString {
  return `sha256:${value.value}`;
}

function digestValue(value: unknown): DigestString | undefined {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) ? value as DigestString : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

type StringField = "runId" | "trialId" | "attemptId" | "retryOf" | "taskId" | "fixtureId"
  | "modelProvider" | "modelId" | "harnessId" | "harnessVersion" | "terminalState"
  | "assessmentMode"
  | "failureClass" | "stopReason" | "verifierLocator" | "captureQualification" | "exportStatus"
  | "sharingClass";
type DigestField = "configurationDigest" | "verifierDigest" | "policyDigest" | "sourceManifestDigest";

function assignString(entry: CorpusIndexEntry, field: StringField, value: unknown): void {
  if (typeof value === "string") entry[field] = value;
}

function assignDigest(entry: CorpusIndexEntry, field: DigestField, value: unknown): void {
  const digest = digestValue(value);
  if (digest !== undefined) entry[field] = digest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
