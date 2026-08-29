import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";

import {
  closeBundleRoot,
  isSafeArtifactRelativePath,
  openBundleRoot,
  resolveBundleArtifact,
  type BundleRootHandle,
  type Digest,
} from "./contracts.js";

export type ArtifactValidationError = {
  artifact: string;
  schemaVersion: string;
  field: string;
  message: string;
};

export type ArtifactIdentity = {
  id: string;
  relativePath: string;
};

const addFormats = formats.default as unknown as (instance: Ajv2020) => void;
const schemaDirectory = fileURLToPath(new URL("../../schemas/", import.meta.url));
const runBundleSchemaId = "urn:ebo:schema:run-bundle:v1";
const validators = loadValidators();

export const SUPPORTED_ARTIFACT_SCHEMA_VERSIONS = [...validators.keys()];

export function canonicalizeMetadata(value: unknown): string {
  return canonicalJson(value, new Set<object>());
}

export function digestBytes(bytes: Uint8Array): Digest {
  return { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") };
}

export function digestMetadata(metadata: unknown): Digest {
  return digestBytes(Buffer.from(canonicalizeMetadata(metadata)));
}

export function verifyDigest(bytes: Uint8Array, expected: Digest): boolean {
  const actual = digestBytes(bytes);
  return expected.algorithm === actual.algorithm && expected.value === actual.value;
}

export function assertUniqueArtifactIdentities(identities: readonly ArtifactIdentity[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const ancestorPaths = new Set<string>();

  for (const identity of identities) {
    if (identity.id.trim() === "" || ids.has(identity.id)) {
      throw new Error(`Duplicate artifact identity "${identity.id}".`);
    }
    if (!isSafeArtifactRelativePath(identity.relativePath)) {
      throw new Error(`Artifact path "${identity.relativePath}" is unsafe.`);
    }

    const normalizedPath = identity.relativePath.toLowerCase();
    if (paths.has(normalizedPath) || ancestorPaths.has(normalizedPath)) {
      throw new Error(`Artifact path "${identity.relativePath}" collides with another artifact path.`);
    }
    for (let boundary = normalizedPath.lastIndexOf("/"); boundary > 0; boundary = normalizedPath.lastIndexOf("/", boundary - 1)) {
      const ancestor = normalizedPath.slice(0, boundary);
      if (paths.has(ancestor)) {
        throw new Error(`Artifact path "${identity.relativePath}" collides with another artifact path.`);
      }
      ancestorPaths.add(ancestor);
    }
    ids.add(identity.id);
    paths.add(normalizedPath);
  }
}

export function validateArtifact(artifact: string, document: unknown): ArtifactValidationError[] {
  const schemaVersion = schemaVersionOf(document);
  const validate = validators.get(schemaVersion);

  if (validate === undefined) {
    return [{ artifact, schemaVersion, field: "/schemaVersion", message: "Unsupported schema version." }];
  }

  const errors = validate(document)
    ? []
    : (validate.errors ?? []).map((error) => validationError(artifact, schemaVersion, error));

  if (schemaVersion === "run-manifest/v1" && isRecord(document) && Array.isArray(document.evidence)) {
    errors.push(...runManifestIntegrityErrors(artifact, schemaVersion, document));
  }

  return errors;
}

export function validateRunManifestEvidence(
  artifact: string,
  manifest: unknown,
  bundleRoot: string,
): ArtifactValidationError[] {
  if (!isRecord(manifest) || manifest.schemaVersion !== "run-manifest/v1" || !Array.isArray(manifest.evidence)) return [];
  const errors: ArtifactValidationError[] = [];

  for (const descriptor of manifest.evidence) {
    if (!isRecord(descriptor) || typeof descriptor.id !== "string" || typeof descriptor.relativePath !== "string"
        || typeof descriptor.digest !== "string" || typeof descriptor.sizeBytes !== "number") continue;
    try {
      const bytes = resolveBundleArtifact(bundleRoot, {
        locator: descriptor.relativePath,
        digest: runDigest(descriptor.digest),
      });
      if (bytes.length !== descriptor.sizeBytes) throw new Error("Artifact size does not match its manifest descriptor.");
    } catch (error) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}`,
        message: error instanceof Error ? error.message : "Evidence could not be verified.",
      });
    }
  }
  return errors;
}

export function validateExportManifest(
  artifact: string,
  exportManifest: unknown,
  containingManifest: unknown | undefined,
): ArtifactValidationError[] {
  if (!isRecord(exportManifest) || exportManifest.schemaVersion !== "export-manifest/v1"
      || !["ready", "exported"].includes(String(exportManifest.status))) return [];
  if (!isRecord(containingManifest) || containingManifest.schemaVersion !== "run-manifest/v1" || !Array.isArray(containingManifest.evidence)) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: "/bundleId", message: "Ready exports require their containing run manifest." }];
  }
  if (exportManifest.bundleId !== containingManifest.bundleId) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: "/bundleId", message: "Export bundle ID does not match its containing run manifest." }];
  }

  const evidenceById = new Map<string, Record<string, unknown>>();
  for (const descriptor of containingManifest.evidence) {
    if (isRecord(descriptor) && typeof descriptor.id === "string") evidenceById.set(descriptor.id, descriptor);
  }
  const errors: ArtifactValidationError[] = [];
  let hasNonExportArtifact = false;
  for (const id of Array.isArray(exportManifest.artifactIds) ? exportManifest.artifactIds : []) {
    const descriptor = typeof id === "string" ? evidenceById.get(id) : undefined;
    if (descriptor === undefined || descriptor.sharingClass === "unknown" || descriptor.sharingClass !== exportManifest.sharingClass) {
      errors.push({ artifact, schemaVersion: "export-manifest/v1", field: "/artifactIds", message: `Export cannot include artifact ${String(id)}.` });
      continue;
    }
    if (exportManifest.sharingClass === "partner" || exportManifest.sharingClass === "public") {
      validateSanitizedProvenance(artifact, "export-manifest/v1", descriptor, evidenceById, errors);
    }
    hasNonExportArtifact ||= descriptor.kind !== "export-manifest";
  }
  if (!hasNonExportArtifact) errors.push({ artifact, schemaVersion: "export-manifest/v1", field: "/artifactIds", message: "Ready exports must include non-export evidence." });
  return errors;
}

export async function readVerifiedArtifact(
  artifactRoot: string,
  relativePath: string,
  expectedDigest: Digest,
): Promise<Buffer> {
  const { root, path } = await resolveExistingArtifactPath(artifactRoot, relativePath);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || opened.nlink > 1 || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
    await assertExistingArtifactPath(root, relativePath);
    const bytes = await handle.readFile();
    if (!verifyDigest(bytes, expectedDigest)) {
      throw new Error(`Artifact "${relativePath}" digest does not match its source reference.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function writeMetadataAtomically(
  artifactRoot: string,
  relativePath: string,
  metadata: unknown,
  signal?: AbortSignal,
): Promise<Digest> {
  const bytes = Buffer.from(canonicalizeMetadata(metadata));
  const { parent, path } = await prepareArtifactPath(artifactRoot, relativePath);
  const temporaryPath = resolve(parent, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (signal?.aborted) throw new Error("Artifact metadata write interrupted.");
    await rename(temporaryPath, path);
    await syncDirectory(parent);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }

  const digest = digestBytes(bytes);
  await readVerifiedArtifact(artifactRoot, relativePath, digest);
  return digest;
}

export function writeMetadataAtomicallyIfAbsentSync(
  artifactRoot: string,
  relativePath: string,
  metadata: unknown,
  rootHandle?: BundleRootHandle,
): { created: boolean; digest: Digest } {
  const bytes = Buffer.from(canonicalizeMetadata(metadata));
  const rootIdentity = rootHandle ?? openBundleRoot(artifactRoot);
  const ownsRoot = rootHandle === undefined;
  const root = rootIdentity.path;
  const digest = digestBytes(bytes);
  const rootDescriptor = rootIdentity.descriptor;
  let created = false;
  try {
    assertPublishRootHandle(root, rootDescriptor, relativePath);
    const { createdDirectories, parent, path } = prepareArtifactPathSync(root, relativePath, rootDescriptor);
    assertPublishRootHandle(root, rootDescriptor, relativePath);
    const parentDescriptor = openPublishParent(root, parent, relativePath, rootDescriptor);
    const destination = relative(parent, path);
    const originalCwd = process.cwd();
    let changedCwd = false;
    try {
      // ponytail: synchronous cwd critical section anchors relative operations;
      // replace with descriptor-relative fs calls if Node exposes openat/linkat.
      process.chdir(parent);
      changedCwd = true;
      assertPublishRootHandle(root, rootDescriptor, relativePath);
      assertPublishParentHandle(root, parent, parentDescriptor, relativePath);
      if (lstatIfPresent(destination) !== undefined) {
        syncCreatedDirectories(root, createdDirectories, parentDescriptor);
        return { created: false, digest };
      }

      const temporaryPath = `.${randomUUID()}.tmp`;
      let descriptor: number | undefined;

      try {
        descriptor = openSync(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
        assertPublishRootHandle(root, rootDescriptor, relativePath);
        assertPublishParentHandle(root, parent, parentDescriptor, relativePath);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        const openedTemporary = fstatSync(descriptor);
        const namedTemporary = lstatSync(temporaryPath);
        if (!sameFileIdentity(openedTemporary, namedTemporary)) {
          throw new Error(`Artifact path "${relativePath}" temporary publication entry changed.`);
        }
        assertPublishRootHandle(root, rootDescriptor, relativePath);
        assertPublishParentHandle(root, parent, parentDescriptor, relativePath);
        let linkedHere = false;
        try {
          linkSync(temporaryPath, destination);
          linkedHere = true;
          const published = lstatSync(destination);
          const currentTemporary = fstatSync(descriptor);
          if (!sameFileIdentity(currentTemporary, published)) {
            throw new Error(`Artifact path "${relativePath}" published a different temporary entry.`);
          }
          assertPublishedDigest(descriptor, digest, currentTemporary, fstatSync(descriptor, { bigint: true }), relativePath);
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            linkedHere = false;
          } else {
            if (linkedHere) removeOwnedPath(destination, descriptor);
            throw error;
          }
        }
        try {
          assertPublishParentHandle(root, parent, parentDescriptor, relativePath);
        } catch (error) {
          if (linkedHere) removeOwnedPath(destination, descriptor);
          created = false;
          throw error;
        }
      } finally {
        if (descriptor !== undefined) {
          try {
            removeOwnedPath(temporaryPath, descriptor);
          } finally {
            closeSync(descriptor);
            descriptor = undefined;
          }
        }
        assertPublishRootHandle(root, rootDescriptor, relativePath);
        syncCreatedDirectories(root, createdDirectories, parentDescriptor);
      }
    } finally {
      if (changedCwd) process.chdir(originalCwd);
      closeSync(parentDescriptor);
    }
  } finally {
    if (ownsRoot) closeBundleRoot(rootIdentity);
  }

  return { created, digest };
}

function loadValidators(): Map<string, ValidateFunction> {
  const readSchema = (name: string): object => JSON.parse(readFileSync(`${schemaDirectory}${name}`, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  addFormats(ajv);
  ajv.addSchema(readSchema("task-packet.v1.schema.json"));
  ajv.addSchema(readSchema("task-packet-freeze.v1.schema.json"));
  ajv.addSchema(readSchema("experiment.v1.schema.json"));
  ajv.addSchema(readSchema("run-bundles/v1.json"));

  return new Map([
    ["ebo.task-packet/v1", requiredValidator(ajv, "https://ebo.dev/schemas/task-packet.v1.schema.json")],
    ["ebo.task-packet-freeze/v1", requiredValidator(ajv, "https://ebo.dev/schemas/task-packet-freeze.v1.schema.json")],
    ["ebo.experiment/v1", requiredValidator(ajv, "https://ebo.dev/schemas/experiment.v1.schema.json")],
    ["run-manifest/v1", requiredValidator(ajv, runBundleSchemaId)],
    ["verifier-result/v1", requiredValidator(ajv, `${runBundleSchemaId}#/$defs/verifierResult`)],
    ["capture-report/v1", requiredValidator(ajv, `${runBundleSchemaId}#/$defs/captureReport`)],
    ["export-manifest/v1", requiredValidator(ajv, `${runBundleSchemaId}#/$defs/exportManifest`)],
  ]);
}

function requiredValidator(ajv: Ajv2020, schemaId: string): ValidateFunction {
  const validate = ajv.getSchema(schemaId);
  if (validate === undefined) throw new Error(`Missing bundled schema ${schemaId}.`);
  return validate;
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Metadata must contain only finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Metadata must not contain cycles.");
    if (Object.keys(value).some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error("Metadata arrays must not contain non-index properties.");
    }
    ancestors.add(value);
    try {
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("Metadata arrays must not contain holes.");
        entries.push(canonicalJson(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("Metadata must contain only JSON values.");
  }
  if (ancestors.has(value)) throw new Error("Metadata must not contain cycles.");

  ancestors.add(value);
  try {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function schemaVersionOf(document: unknown): string {
  return isRecord(document) && typeof document.schemaVersion === "string" ? document.schemaVersion : "unknown";
}

function validationError(artifact: string, schemaVersion: string, error: ErrorObject): ArtifactValidationError {
  const missing = error.keyword === "required" && typeof error.params.missingProperty === "string"
    ? `/${escapeJsonPointer(error.params.missingProperty)}`
    : "";
  return {
    artifact,
    schemaVersion,
    field: `${error.instancePath}${missing}` || "/",
    message: error.message ?? error.keyword,
  };
}

function runManifestIntegrityErrors(
  artifact: string,
  schemaVersion: string,
  manifest: Record<string, unknown>,
): ArtifactValidationError[] {
  const errors: ArtifactValidationError[] = [];
  const evidence = manifest.evidence as unknown[];

  try {
    assertUniqueArtifactIdentities(evidence.map((entry) => ({
      id: isRecord(entry) && typeof entry.id === "string" ? entry.id : "",
      relativePath: isRecord(entry) && typeof entry.relativePath === "string" ? entry.relativePath : "",
    })));
  } catch (error) {
    errors.push({ artifact, schemaVersion, field: "/evidence", message: error instanceof Error ? error.message : "Duplicate evidence identity." });
  }

  const evidenceClasses = new Map<string, string>();
  const evidenceById = new Map<string, Record<string, unknown>>();
  for (const descriptor of evidence) {
    if (!isRecord(descriptor)) continue;
    const { digest, id, kind, authority, relativePath } = descriptor;
    if (typeof id === "string") evidenceById.set(id, descriptor);
    if (typeof relativePath === "string" && (relativePath.toLowerCase() === "manifest.json" || relativePath.toLowerCase().startsWith("manifest.json/"))) {
      errors.push({ artifact, schemaVersion, field: "/evidence", message: "Evidence cannot reuse the containing manifest path." });
    }
    if (typeof digest !== "string" || typeof kind !== "string" || typeof authority !== "string") continue;

    const evidenceClass = `${kind}:${authority}`;
    const existing = evidenceClasses.get(digest);
    if (existing !== undefined && existing !== evidenceClass) {
      errors.push({ artifact, schemaVersion, field: "/evidence", message: `Evidence reuses ${digest} across evidence classes.` });
    }
    evidenceClasses.set(digest, evidenceClass);
  }

  for (const descriptor of evidenceById.values()) {
    validateSanitizedProvenance(artifact, schemaVersion, descriptor, evidenceById, errors);
  }

  if (isRecord(manifest.attempt) && manifest.attempt.retryOf === manifest.attempt.id) {
    errors.push({ artifact, schemaVersion, field: "/attempt/retryOf", message: "Retry lineage cannot reference the current attempt." });
  }
  const sourceEvidence = [...evidenceById.values()].filter((descriptor) => descriptor.sanitizedFrom === undefined);
  const run = isRecord(manifest.run) ? manifest.run : undefined;
  if (run !== undefined && isRecord(run.native)) {
    validateNativeReference(artifact, schemaVersion, "sessionId", "session", "session", run.native, sourceEvidence, errors);
    validateNativeReference(artifact, schemaVersion, "traceId", "telemetry", "trace", run.native, sourceEvidence, errors);
  }
  const harness = run !== undefined && isRecord(run.harness) ? run.harness : undefined;
  if (run !== undefined && harness !== undefined && Array.isArray(run.runtime)
      && !run.runtime.some((component) => isRecord(component)
        && component.version === harness.version
        && (component.name === harness.id || component.source === harness.id))) {
    errors.push({ artifact, schemaVersion, field: "/run/runtime", message: "Declared harness is not represented by its runtime composition." });
  }
  const terminal = isRecord(manifest.terminal) ? manifest.terminal : undefined;
  if (terminal !== undefined && typeof terminal.workspaceArtifactId === "string"
      && !sourceEvidence.some((descriptor) => descriptor.id === terminal.workspaceArtifactId && descriptor.kind === "workspace")) {
    errors.push({ artifact, schemaVersion, field: "/terminal/workspaceArtifactId", message: "Terminal workspace must reference retained workspace evidence." });
  }
  return errors;
}

function validateSanitizedProvenance(
  artifact: string,
  schemaVersion: string,
  descriptor: Record<string, unknown>,
  evidenceById: ReadonlyMap<string, Record<string, unknown>>,
  errors: ArtifactValidationError[],
): void {
  if (!isRecord(descriptor.sanitizedFrom) || typeof descriptor.id !== "string" || typeof descriptor.digest !== "string") return;
  const field = `/evidence/${escapeJsonPointer(descriptor.id)}/sanitizedFrom`;
  const shared = descriptor.sharingClass === "partner" || descriptor.sharingClass === "public";
  const seen = new Set([descriptor.id]);
  const sharedDigest = descriptor.digest;
  let current = descriptor;

  while (isRecord(current.sanitizedFrom)) {
    const { artifactId, digest } = current.sanitizedFrom;
    if (typeof artifactId !== "string" || typeof digest !== "string" || seen.has(artifactId)) {
      errors.push({ artifact, schemaVersion, field, message: "Sanitized provenance cannot contain a cycle." });
      return;
    }
    const source = evidenceById.get(artifactId);
    if (source === undefined) {
      errors.push({ artifact, schemaVersion, field, message: "Sanitized provenance must reference retained source evidence." });
      return;
    }
    const currentShared = current.sharingClass === "partner" || current.sharingClass === "public";
    if (["source", "kind", "authority"].some((key) => source[key] !== current[key])
        || (currentShared ? current.nativeReference !== undefined : !sameNativeReference(source.nativeReference, current.nativeReference))
        || source.digest !== digest || source.digest === current.digest || source.digest === sharedDigest || source.relativePath === current.relativePath) {
      errors.push({ artifact, schemaVersion, field, message: "Sanitized provenance does not preserve its source evidence." });
      return;
    }
    seen.add(artifactId);
    current = source;
  }

  if (shared && [...evidenceById.values()].some((candidate) => !seen.has(String(candidate.id)) && candidate.digest === sharedDigest)) {
    errors.push({ artifact, schemaVersion, field, message: "Sanitized shared evidence cannot reuse unrelated retained bytes." });
  }
}

function validateNativeReference(
  artifact: string,
  schemaVersion: string,
  field: "sessionId" | "traceId",
  kind: "session" | "telemetry",
  nativeType: "session" | "trace",
  native: Record<string, unknown>,
  sourceEvidence: readonly Record<string, unknown>[],
  errors: ArtifactValidationError[],
): void {
  if (typeof native[field] === "string" && !sourceEvidence.some((descriptor) =>
    descriptor.kind === kind && isRecord(descriptor.nativeReference)
      && descriptor.nativeReference.type === nativeType && descriptor.nativeReference.id === native[field],
  )) {
    errors.push({ artifact, schemaVersion, field: `/run/native/${field}`, message: `Declared ${field} does not match retained ${kind} evidence.` });
  }
}

function sameNativeReference(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  return isRecord(left) && isRecord(right) && left.type === right.type && left.id === right.id;
}

function runDigest(value: string): Digest {
  return { algorithm: "sha256", value: value.slice("sha256:".length) };
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

async function resolveExistingArtifactPath(artifactRoot: string, relativePath: string): Promise<{ root: string; path: string }> {
  const root = await realpath(artifactRoot);
  return { root, path: await assertExistingArtifactPath(root, relativePath) };
}

async function assertExistingArtifactPath(root: string, relativePath: string): Promise<string> {
  assertSafeArtifactPath(relativePath);
  let path = root;
  const segments = relativePath.split("/");

  for (const [index, segment] of segments.entries()) {
    path = resolve(path, segment);
    const entry = await lstat(path);
    if (!isContained(root, path) || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${relativePath}" escapes its declared root.`);
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
  }

  return path;
}

async function prepareArtifactPath(artifactRoot: string, relativePath: string): Promise<{ parent: string; path: string }> {
  assertSafeArtifactPath(relativePath);
  const root = await realpath(artifactRoot);
  const segments = relativePath.split("/");
  let parent = root;

  for (const segment of segments.slice(0, -1)) {
    parent = resolve(parent, segment);
    if (!isContained(root, parent)) throw new Error(`Artifact path "${relativePath}" escapes its declared root.`);
    await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await lstat(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${relativePath}" crosses a symbolic link.`);
    }
  }

  const path = resolve(parent, segments.at(-1)!);
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { parent, path };
}

function prepareArtifactPathSync(
  artifactRoot: string,
  relativePath: string,
  rootDescriptor: number,
): { createdDirectories: string[]; parent: string; path: string } {
  assertSafeArtifactPath(relativePath);
  const root = realpathSync(artifactRoot);
  const segments = relativePath.split("/");
  let parent = root;
  let parentDescriptor = rootDescriptor;
  const createdDirectories: string[] = [];
  const originalCwd = process.cwd();
  let changedCwd = false;

  try {
    for (const segment of segments.slice(0, -1)) {
      assertPublishDirectoryHandle(root, parent, parentDescriptor, rootDescriptor, relativePath);
      process.chdir(parent);
      changedCwd = true;
      assertPublishDirectoryHandle(root, parent, parentDescriptor, rootDescriptor, relativePath);

      const next = resolve(parent, segment);
      if (!isContained(root, next)) throw new Error(`Artifact path "${relativePath}" escapes its declared root.`);
      try {
        mkdirSync(segment);
        createdDirectories.push(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      assertPublishDirectoryHandle(root, parent, parentDescriptor, rootDescriptor, relativePath);

      let childDescriptor: number | undefined;
      try {
        const current = lstatSync(next);
        if (current.isSymbolicLink() || !current.isDirectory()) {
          throw new Error(`Artifact path "${relativePath}" crosses a symbolic link.`);
        }
        childDescriptor = openSync(segment, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        const child = fstatSync(childDescriptor);
        if (!child.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
            || child.dev !== current.dev || child.ino !== current.ino) {
          throw new Error(`Artifact path "${relativePath}" crosses a symbolic link.`);
        }
      } catch (error) {
        if (childDescriptor !== undefined) closeSync(childDescriptor);
        throw error;
      }

      if (parentDescriptor !== rootDescriptor) closeSync(parentDescriptor);
      parentDescriptor = childDescriptor;
      parent = next;
    }

    assertPublishDirectoryHandle(root, parent, parentDescriptor, rootDescriptor, relativePath);
    const path = resolve(parent, segments.at(-1)!);
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { createdDirectories, parent, path };
  } finally {
    if (parentDescriptor !== rootDescriptor) closeSync(parentDescriptor);
    if (changedCwd) process.chdir(originalCwd);
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function removeOwnedPath(path: string, descriptor: number): void {
  const quarantine = `${path}.quarantine-${randomUUID()}`;
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!sameFileIdentity(opened, current)) {
      throw new Error(`Publication path "${path}" changed before cleanup.`);
    }
    renameSync(path, quarantine);
    const quarantined = lstatSync(quarantine);
    if (!sameFileIdentity(opened, quarantined)) {
      throw new Error(`Publication path "${path}" changed during quarantine.`);
    }
    rmSync(quarantine, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertPublishedDigest(
  descriptor: number,
  expected: Digest,
  opened: Stats,
  openedTimes: BigIntStats,
  relativePath: string,
): void {
  const size = opened.size;
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < size;) {
    const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (read === 0) throw new Error(`Artifact path "${relativePath}" changed while it was being published.`);
    hash.update(chunk.subarray(0, read));
    offset += read;
  }
  const trailing = Buffer.allocUnsafe(1);
  if (readSync(descriptor, trailing, 0, 1, size) !== 0) {
    throw new Error(`Artifact path "${relativePath}" changed while it was being published.`);
  }
  const completed = fstatSync(descriptor);
  const completedTimes = fstatSync(descriptor, { bigint: true });
  if (!sameFileIdentity(opened, completed) || completed.size !== size
      || completedTimes.mtimeNs !== openedTimes.mtimeNs || completedTimes.ctimeNs !== openedTimes.ctimeNs
      || hash.digest("hex") !== expected.value) {
    throw new Error(`Artifact path "${relativePath}" changed while it was being published.`);
  }
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openPublishParent(root: string, parent: string, relativePath: string, rootDescriptor: number): number {
  assertPublishRootHandle(root, rootDescriptor, relativePath);
  assertPublishParentPath(root, parent, relativePath);

  const descriptor = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(parent);
    if (!opened.isDirectory() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Artifact path "${relativePath}" parent changed during publication.`);
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertPublishParentHandle(root: string, parent: string, descriptor: number, relativePath: string): void {
  assertPublishParentPath(root, parent, relativePath);
  const opened = fstatSync(descriptor);
  const current = lstatSync(parent);
  const cwd = lstatSync(".");
  if (!opened.isDirectory() || current.isSymbolicLink() || cwd.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino
      || opened.dev !== cwd.dev || opened.ino !== cwd.ino) {
    throw new Error(`Artifact path "${relativePath}" parent changed during publication.`);
  }
}

function assertPublishDirectoryHandle(
  root: string,
  parent: string,
  descriptor: number,
  rootDescriptor: number,
  relativePath: string,
): void {
  assertPublishRootHandle(root, rootDescriptor, relativePath);
  assertPublishParentPath(root, parent, relativePath);
  const opened = fstatSync(descriptor);
  const current = lstatSync(parent);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
      || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`Artifact path "${relativePath}" parent changed during publication.`);
  }
}

function assertPublishParentPath(root: string, parent: string, relativePath: string): void {
  if (!isContained(root, parent)) throw new Error(`Artifact path "${relativePath}" escapes its declared root.`);
  const segments = relative(root, parent) === "" ? [] : relative(root, parent).split(sep);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${relativePath}" crosses a symbolic link.`);
    }
  }
}

function assertPublishRootHandle(root: string, descriptor: number, relativePath: string): void {
  const opened = fstatSync(descriptor);
  const current = lstatSync(root);
  if (!opened.isDirectory() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`Artifact path "${relativePath}" bundle root changed during publication.`);
  }
}

function syncCreatedDirectories(root: string, directories: readonly string[], leafDescriptor: number): void {
  fsyncSync(leafDescriptor);
  const paths = new Set<string>([...directories].reverse().concat(root));
  for (const path of paths) {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertSafeArtifactPath(relativePath: string): void {
  if (!isSafeArtifactRelativePath(relativePath)) {
    throw new Error(`Artifact path "${relativePath}" is unsafe.`);
  }
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
