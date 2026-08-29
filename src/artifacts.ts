import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";

import { isSafeArtifactRelativePath, type Digest } from "./contracts.js";

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
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }

  const digest = digestBytes(bytes);
  await readVerifiedArtifact(artifactRoot, relativePath, digest);
  return digest;
}

function loadValidators(): Map<string, ValidateFunction> {
  const readSchema = (name: string): object => JSON.parse(readFileSync(`${schemaDirectory}${name}`, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  addFormats(ajv);
  ajv.addSchema(readSchema("task-packet.v1.schema.json"));
  ajv.addSchema(readSchema("experiment.v1.schema.json"));
  ajv.addSchema(readSchema("run-bundles/v1.json"));

  return new Map([
    ["ebo.task-packet/v1", requiredValidator(ajv, "https://ebo.dev/schemas/task-packet.v1.schema.json")],
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
  for (const descriptor of evidence) {
    if (!isRecord(descriptor)) continue;
    const { digest, kind, authority, relativePath } = descriptor;
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

  if (isRecord(manifest.attempt) && manifest.attempt.retryOf === manifest.attempt.id) {
    errors.push({ artifact, schemaVersion, field: "/attempt/retryOf", message: "Retry lineage cannot reference the current attempt." });
  }
  return errors;
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
