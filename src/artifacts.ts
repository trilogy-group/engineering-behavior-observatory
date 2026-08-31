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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";

import {
  closeBundleRoot,
  isSafeArtifactRelativePath,
  openBundleRoot,
  removeInterruptedPublicationLink,
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
const RESERVED_MANIFEST_PATHS = new Set(["manifest.json"]);

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

export function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;

  const skipWhitespace = () => {
    while (/\s/.test(text[index] ?? "")) index += 1;
  };
  const readString = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"') return text.slice(start, index);
    }
    throw new Error("Verifier output contains an unterminated JSON string.");
  };
  const readValue = (): void => {
    skipWhitespace();
    if (text[index] === "{") readObject();
    else if (text[index] === "[") readArray();
    else if (text[index] === '"') readString();
    else while (index < text.length && !/[\s,\]}]/.test(text[index]!)) index += 1;
  };
  const readObject = (): void => {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = JSON.parse(readString()) as string;
      if (keys.has(key)) throw new Error("Verifier output contains duplicate JSON object keys.");
      keys.add(key);
      skipWhitespace();
      index += 1;
      readValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      index += 1;
    }
    throw new Error("Verifier output contains an unterminated JSON object.");
  };
  const readArray = (): void => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      readValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      index += 1;
    }
    throw new Error("Verifier output contains an unterminated JSON array.");
  };

  readValue();
  skipWhitespace();
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
  if (schemaVersion === "verifier-result/v1" && isRecord(document) && Array.isArray(document.assertions)) {
    const assertionIds = document.assertions
      .filter((assertion): assertion is Record<string, unknown> => isRecord(assertion) && typeof assertion.id === "string")
      .map((assertion) => assertion.id as string);
    if (new Set(assertionIds).size !== assertionIds.length) {
      errors.push({ artifact, schemaVersion, field: "/assertions", message: "Verifier assertion IDs must be unique." });
    }
    if (Array.isArray(document.diagnostics)) {
      const diagnosticLocators = document.diagnostics
        .filter((diagnostic): diagnostic is Record<string, unknown> => isRecord(diagnostic) && typeof diagnostic.locator === "string")
        .map((diagnostic) => (diagnostic.locator as string).toLowerCase());
      const diagnosticStreams = document.diagnostics
        .filter((diagnostic): diagnostic is Record<string, unknown> => isRecord(diagnostic) && typeof diagnostic.stream === "string")
        .map((diagnostic) => diagnostic.stream as string);
      if (new Set(diagnosticStreams).size !== diagnosticStreams.length) {
        errors.push({ artifact, schemaVersion, field: "/diagnostics", message: "Verifier diagnostic streams must be unique." });
      }
      const seenDiagnosticLocators = new Set<string>();
      if (diagnosticLocators.some((locator) => {
        const collision = hasPortablePathCollision(locator, seenDiagnosticLocators);
        seenDiagnosticLocators.add(locator);
        return collision;
      })) {
        errors.push({ artifact, schemaVersion, field: "/diagnostics", message: "Verifier diagnostic locators must be unique and non-overlapping." });
      }
    }
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
  const expectedBundleId = typeof manifest.bundleId === "string" ? manifest.bundleId : undefined;
  const expectedVerifier = isRecord(manifest.run) && isRecord(manifest.run.verifier)
    ? manifest.run.verifier
    : undefined;
  const workspaceEvidence = new Map<string, Record<string, unknown>>(
    manifest.evidence
      .filter((entry): entry is Record<string, unknown> => isRecord(entry)
        && typeof entry.id === "string" && entry.kind === "workspace")
      .map((entry) => [entry.id as string, entry]),
  );
  const verifierOutcomes: NestedVerifierOutcome[] = [];
  const verifierResults = new Map<string, NestedVerifierOutcome>();
  const evidenceByPath = new Map<string, Record<string, unknown>>(
    manifest.evidence
      .filter((entry): entry is Record<string, unknown> => isRecord(entry)
        && typeof entry.relativePath === "string")
      .map((entry) => [(entry.relativePath as string).toLowerCase(), entry]),
  );
  const evidencePaths = new Set(
    manifest.evidence
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.relativePath === "string")
      .map((entry) => (entry.relativePath as string).toLowerCase()),
  );
  const nestedDiagnosticPaths = new Set<string>();

  for (const descriptor of manifest.evidence) {
    if (!isRecord(descriptor) || typeof descriptor.id !== "string" || typeof descriptor.relativePath !== "string"
        || typeof descriptor.digest !== "string" || typeof descriptor.sizeBytes !== "number") continue;
    try {
      const bytes = resolveBundleArtifact(bundleRoot, {
        locator: descriptor.relativePath,
        digest: runDigest(descriptor.digest),
      });
      if (bytes.length !== descriptor.sizeBytes) throw new Error("Artifact size does not match its manifest descriptor.");
      if (descriptor.kind === "verifier") {
        const verifierErrors = nestedVerifierDiagnosticErrors(
          artifact,
          descriptor.id,
          bytes,
          bundleRoot,
          expectedBundleId,
          expectedVerifier,
          workspaceEvidence,
          descriptor.sanitizedFrom !== undefined,
          isRecord(descriptor.sanitizedFrom) && typeof descriptor.sanitizedFrom.artifactId === "string"
            ? descriptor.sanitizedFrom.artifactId
            : undefined,
          evidenceByPath,
          evidencePaths,
          nestedDiagnosticPaths,
        );
        errors.push(...verifierErrors);
        if (verifierErrors.length === 0) {
          const outcome = nestedVerifierOutcome(bytes);
          if (outcome !== undefined) {
            verifierResults.set(descriptor.id, outcome);
            if (descriptor.sanitizedFrom === undefined) verifierOutcomes.push(outcome);
          }
        }
      }
    } catch (error) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}`,
        message: error instanceof Error ? error.message : "Evidence could not be verified.",
      });
    }
  }
  for (const descriptor of manifest.evidence) {
    if (!isRecord(descriptor) || descriptor.kind !== "verifier" || !isRecord(descriptor.sanitizedFrom)
        || typeof descriptor.id !== "string" || typeof descriptor.sanitizedFrom.artifactId !== "string") continue;
    const source = verifierResults.get(descriptor.sanitizedFrom.artifactId);
    const derivative = verifierResults.get(descriptor.id);
    if (source === undefined || derivative === undefined) continue;
    if (source.status !== derivative.status) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/status`,
        message: "Sanitized verifier must preserve its source outcome status.",
      });
    }
    const sourceAssertions = new Map(source.assertions.map((assertion) => [assertion.id, assertion.status]));
    const derivativeAssertions = new Map(derivative.assertions.map((assertion) => [assertion.id, assertion.status]));
    if (sourceAssertions.size !== derivativeAssertions.size
        || [...sourceAssertions].some(([id, status]) => derivativeAssertions.get(id) !== status)) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/assertions`,
        message: "Sanitized verifier must preserve source assertion outcomes.",
      });
    }
    if (derivative.exitCode !== source.exitCode) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/exitCode`,
        message: "Sanitized verifier must preserve its source exit code.",
      });
    }
    const sourceVerifier = source.verifier;
    const derivativeVerifier = derivative.verifier;
    const sameVerifier = sourceVerifier === undefined
      ? derivativeVerifier === undefined
      : derivativeVerifier !== undefined
        && derivativeVerifier.locator === sourceVerifier.locator
        && derivativeVerifier.digest === sourceVerifier.digest
        && derivativeVerifier.format === sourceVerifier.format;
    if (!sameVerifier) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/verifier`,
        message: "Sanitized verifier must preserve its source verifier binding.",
      });
    }
    if (source.durationMs !== derivative.durationMs) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/durationMs`,
        message: "Sanitized verifier must preserve its source duration.",
      });
    }
    const sameError = derivative.errorRedacted === true
      ? source.status === "error" && derivative.error === "[redacted]"
      : source.error === derivative.error && source.errorRedacted === derivative.errorRedacted;
    if (!sameError) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/error`,
        message: "Sanitized verifier must preserve or explicitly redact its source error.",
      });
    }
    const sourceWorkspace = source.workspace;
    const derivativeWorkspace = derivative.workspace;
    const sameWorkspace = sourceWorkspace === undefined
      ? derivativeWorkspace === undefined
      : derivativeWorkspace !== undefined
        && derivativeWorkspace.artifactId === sourceWorkspace.artifactId
        && derivativeWorkspace.digest === sourceWorkspace.digest
        && derivativeWorkspace.fingerprint === sourceWorkspace.fingerprint;
    if (!sameWorkspace) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/workspace`,
        message: "Sanitized verifier must preserve its source workspace binding.",
      });
    }
    if (derivative.diagnostics.some((diagnostic) => diagnostic.source === undefined
        || !source.diagnostics.some((sourceDiagnostic) => sameDiagnosticOrigin(sourceDiagnostic, diagnostic.source!)))) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/diagnostics`,
        message: "Sanitized verifier diagnostics must identify source diagnostics.",
      });
    }
  }
  const terminal = isRecord(manifest.terminal) ? manifest.terminal : undefined;
  const terminalWorkspace = typeof terminal?.workspaceArtifactId === "string"
    ? workspaceEvidence.get(terminal.workspaceArtifactId)
    : undefined;
  const matchesTerminalWorkspace = (outcome: NestedVerifierOutcome, status: "passed" | "failed") =>
    outcome.status === status
      && outcome.workspace !== undefined
      && terminalWorkspace !== undefined
      && outcome.workspace.artifactId === terminalWorkspace.id
      && outcome.workspace.digest === terminalWorkspace.digest
      && (outcome.workspace.fingerprint === undefined
        ? terminalWorkspace.fingerprint === undefined
        : terminalWorkspace.fingerprint !== undefined && outcome.workspace.fingerprint === terminalWorkspace.fingerprint);
  if (terminal?.state === "completed" && !verifierOutcomes.some((outcome) => matchesTerminalWorkspace(outcome, "passed"))) {
    errors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: "/terminal/state",
      message: "Completed runs require a passed verifier bound to the terminal workspace.",
    });
  }
  if (terminal?.state === "failed" && terminal.failureClass === "task"
      && !verifierOutcomes.some((outcome) => matchesTerminalWorkspace(outcome, "failed"))) {
    errors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: "/terminal/state",
      message: "Task-failed runs require a failed verifier bound to the terminal workspace.",
    });
  }
  return errors;
}

type NestedVerifierOutcome = {
  status: string;
  durationMs?: number;
  error?: string;
  errorRedacted?: boolean;
  assertions: Array<{ id: string; status: string }>;
  verifier?: { locator: string; digest: string; format?: "commonjs" | "module" };
  workspace?: { artifactId: string; digest: string; fingerprint?: string };
  diagnostics: NestedVerifierDiagnostic[];
  exitCode?: number;
};

type NestedVerifierDiagnostic = {
  stream: string;
  locator: string;
  digest: string;
  sizeBytes: number;
  truncated: boolean;
  source?: NestedVerifierDiagnosticOrigin;
};

type NestedVerifierDiagnosticOrigin = Omit<NestedVerifierDiagnostic, "source">;

function isNestedVerifierDiagnostic(value: unknown): value is NestedVerifierDiagnostic {
  if (!isRecord(value) || ![5, 6].includes(Object.keys(value).length)
      || typeof value.stream !== "string" || !["stdout", "stderr"].includes(value.stream)
      || typeof value.locator !== "string" || typeof value.digest !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.sizeBytes)
      || (value.sizeBytes as number) < 0 || typeof value.truncated !== "boolean") return false;
  return !Object.hasOwn(value, "source") || isNestedVerifierDiagnosticOrigin(value.source);
}

function isNestedVerifierDiagnosticOrigin(value: unknown): value is NestedVerifierDiagnosticOrigin {
  return isRecord(value) && Object.keys(value).length === 5
    && typeof value.stream === "string" && ["stdout", "stderr"].includes(value.stream)
    && typeof value.locator === "string" && typeof value.digest === "string"
    && /^sha256:[a-f0-9]{64}$/.test(value.digest) && Number.isSafeInteger(value.sizeBytes)
    && (value.sizeBytes as number) >= 0 && typeof value.truncated === "boolean";
}

function isDiagnosticSourceBinding(value: unknown): value is NestedVerifierDiagnosticOrigin & { verifierId: string } {
  return isRecord(value) && Object.keys(value).length === 6
    && typeof value.verifierId === "string"
    && isNestedVerifierDiagnosticOrigin(Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "verifierId"),
    ));
}

function sameDiagnosticOrigin(left: NestedVerifierDiagnosticOrigin, right: NestedVerifierDiagnosticOrigin): boolean {
  return left.stream === right.stream
    && left.locator === right.locator
    && left.digest === right.digest
    && left.sizeBytes === right.sizeBytes
    && left.truncated === right.truncated;
}

function nestedVerifierOutcome(bytes: Buffer): NestedVerifierOutcome | undefined {
  try {
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(result) || typeof result.status !== "string") return undefined;
    const verifier = isRecord(result.verifier)
      && typeof result.verifier.locator === "string"
      && typeof result.verifier.digest === "string"
      ? {
        locator: result.verifier.locator,
        digest: result.verifier.digest,
        ...(typeof result.verifier.format === "string" ? { format: result.verifier.format as "commonjs" | "module" } : {}),
      }
      : undefined;
    const workspace = isRecord(result.workspace)
      && typeof result.workspace.artifactId === "string"
      && typeof result.workspace.digest === "string"
      ? {
        artifactId: result.workspace.artifactId,
        digest: result.workspace.digest,
        ...(typeof result.workspace.fingerprint === "string" ? { fingerprint: result.workspace.fingerprint } : {}),
      }
      : undefined;
    const assertions = Array.isArray(result.assertions)
      ? result.assertions.flatMap((assertion) => isRecord(assertion)
        && typeof assertion.id === "string" && typeof assertion.status === "string"
        ? [{ id: assertion.id, status: assertion.status }]
        : [])
      : [];
    const diagnostics = Array.isArray(result.diagnostics)
      ? result.diagnostics.flatMap((diagnostic) => {
        if (!isRecord(diagnostic) || typeof diagnostic.stream !== "string" || typeof diagnostic.locator !== "string"
            || typeof diagnostic.digest !== "string" || typeof diagnostic.sizeBytes !== "number"
            || typeof diagnostic.truncated !== "boolean") return [];
        const source = isRecord(diagnostic.source)
          && typeof diagnostic.source.stream === "string"
          && typeof diagnostic.source.locator === "string"
          && typeof diagnostic.source.digest === "string"
          && typeof diagnostic.source.sizeBytes === "number"
          && typeof diagnostic.source.truncated === "boolean"
          ? {
            stream: diagnostic.source.stream,
            locator: diagnostic.source.locator,
            digest: diagnostic.source.digest,
            sizeBytes: diagnostic.source.sizeBytes,
            truncated: diagnostic.source.truncated,
          }
          : undefined;
        return [{
          stream: diagnostic.stream,
          locator: diagnostic.locator,
          digest: diagnostic.digest,
          sizeBytes: diagnostic.sizeBytes,
          truncated: diagnostic.truncated,
          ...(source === undefined ? {} : { source }),
        }];
      })
      : [];
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
    const durationMs = typeof result.durationMs === "number" ? result.durationMs : undefined;
    const error = typeof result.error === "string" ? result.error : undefined;
    const errorRedacted = typeof result.errorRedacted === "boolean" ? result.errorRedacted : undefined;
    return {
      status: result.status,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(error === undefined ? {} : { error }),
      ...(errorRedacted === undefined ? {} : { errorRedacted }),
      assertions,
      diagnostics,
      ...(verifier === undefined ? {} : { verifier }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  } catch {
    return undefined;
  }
}

function nestedVerifierDiagnosticErrors(
  artifact: string,
  verifierId: string,
  bytes: Buffer,
  bundleRoot: string,
  expectedBundleId: string | undefined,
  expectedVerifier: Record<string, unknown> | undefined,
  workspaceEvidence: ReadonlyMap<string, Record<string, unknown>>,
  sanitized: boolean,
  sanitizedSourceVerifierId: string | undefined,
  evidenceByPath: ReadonlyMap<string, Record<string, unknown>>,
  evidencePaths: ReadonlySet<string>,
  nestedDiagnosticPaths: Set<string>,
): ArtifactValidationError[] {
  const scope = `/evidence/${escapeJsonPointer(verifierId)}`;
  let result: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    result = JSON.parse(text);
    assertNoDuplicateJsonKeys(text);
  } catch (error) {
    return [{ artifact, schemaVersion: "run-manifest/v1", field: scope, message: `Verifier artifact could not be parsed: ${error instanceof Error ? error.message : "invalid UTF-8 or JSON."}` }];
  }
  const schemaErrors = validateArtifact(`${artifact}/${verifierId}`, result);
  if (schemaErrors.length > 0) {
    return schemaErrors.map((error) => ({ ...error, artifact, schemaVersion: "run-manifest/v1", field: `${scope}${error.field}` }));
  }
  if (!isRecord(result)) return [];
  const bindingErrors: ArtifactValidationError[] = [];
  if (expectedBundleId !== undefined && result.bundleId !== expectedBundleId) {
    bindingErrors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: `${scope}/bundleId`,
      message: "Verifier bundleId must match its containing run manifest.",
    });
  }
  if (expectedVerifier !== undefined) {
    const actualVerifier = isRecord(result.verifier) ? result.verifier : undefined;
    const expectedFormat = typeof expectedVerifier.format === "string"
      ? expectedVerifier.format
      : typeof expectedVerifier.locator === "string" && expectedVerifier.locator.toLowerCase().endsWith(".mjs")
        ? "module"
        : "commonjs";
    if (actualVerifier === undefined
        || actualVerifier.locator !== expectedVerifier.locator
        || actualVerifier.digest !== expectedVerifier.digest
        || actualVerifier.format !== expectedFormat) {
      bindingErrors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/verifier`,
        message: "Verifier execution reference must match the run configuration.",
      });
    }
  }
  if (isRecord(result.workspace)) {
    const workspaceArtifactId = result.workspace.artifactId;
    const retainedWorkspace = typeof workspaceArtifactId === "string" ? workspaceEvidence.get(workspaceArtifactId) : undefined;
    if (retainedWorkspace === undefined) {
      bindingErrors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/workspace/artifactId`,
        message: "Verifier workspace must reference retained workspace evidence.",
      });
    } else if (retainedWorkspace.digest !== result.workspace.digest
        || (result.workspace.fingerprint === undefined
          ? retainedWorkspace.fingerprint !== undefined
          : retainedWorkspace.fingerprint === undefined || retainedWorkspace.fingerprint !== result.workspace.fingerprint)) {
      bindingErrors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/workspace/digest`,
        message: "Verifier workspace digest must match retained workspace evidence.",
      });
    }
  }
  if (result.diagnostics === undefined) return bindingErrors;
  if (!Array.isArray(result.diagnostics)) {
    return [
      ...bindingErrors,
      { artifact, schemaVersion: "run-manifest/v1", field: `${scope}/diagnostics`, message: "Verifier diagnostics must be an array." },
    ];
  }

  const errors: ArtifactValidationError[] = [...bindingErrors];
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    if (!isNestedVerifierDiagnostic(diagnostic)) {
      errors.push({ artifact, schemaVersion: "run-manifest/v1", field: `${scope}/diagnostics/${index}`, message: "Verifier diagnostic reference is malformed." });
      continue;
    }
    const normalizedLocator = diagnostic.locator.toLowerCase();
    const retainedEvidence = evidenceByPath.get(normalizedLocator);
    const exactSidecar = retainedEvidence !== undefined
      && retainedEvidence.relativePath === diagnostic.locator
      && retainedEvidence.digest === diagnostic.digest
      && retainedEvidence.sizeBytes === diagnostic.sizeBytes;
    const invalidUnsanitizedReference = !sanitized && diagnostic.source !== undefined;
    const sourceOrigin = diagnostic.source;
    const sourceBinding = retainedEvidence !== undefined && isDiagnosticSourceBinding(retainedEvidence.diagnosticSource)
      ? retainedEvidence.diagnosticSource
      : undefined;
    const sourceBindingMatches = sourceBinding !== undefined
      && sourceOrigin !== undefined
      && sourceBinding.verifierId === sanitizedSourceVerifierId
      && sourceBinding.stream === diagnostic.stream
      && sourceOrigin.stream === diagnostic.stream
      && sameDiagnosticOrigin(sourceBinding, sourceOrigin);
    const byteIdentical = sanitized && sourceOrigin !== undefined && diagnostic.digest === sourceOrigin.digest;
    const isSanitizedSidecar = exactSidecar
      && retainedEvidence.kind === "diagnostic"
      && retainedEvidence.authority === "outcome"
      && (retainedEvidence.mediaType === "text/plain" || retainedEvidence.mediaType === "application/octet-stream")
      && (retainedEvidence.sharingClass === "partner" || retainedEvidence.sharingClass === "public")
      && isRecord(retainedEvidence.sanitizedFrom)
      && retainedEvidence.sanitizedFrom.artifactId === sanitizedSourceVerifierId
      && sourceBindingMatches
      && !byteIdentical;
    const invalidSanitizedReference = sanitized && !isSanitizedSidecar;
    const aliasesRetainedEvidence = !sanitized && hasPortablePathCollision(normalizedLocator, evidencePaths);
    if (invalidUnsanitizedReference
        || hasPortablePathCollision(normalizedLocator, RESERVED_MANIFEST_PATHS)
        || invalidSanitizedReference
        || aliasesRetainedEvidence
        || hasPortablePathCollision(normalizedLocator, nestedDiagnosticPaths)) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/diagnostics`,
        message: invalidUnsanitizedReference
          ? "Unsanitized verifier diagnostics cannot carry source provenance."
          : invalidSanitizedReference
          ? "Sanitized verifier diagnostics require classified, source-bound sidecars with changed bytes."
          : "Verifier diagnostics cannot alias retained evidence paths.",
      });
      continue;
    }
    nestedDiagnosticPaths.add(normalizedLocator);
    try {
      const diagnosticBytes = resolveBundleArtifact(bundleRoot, {
        locator: diagnostic.locator,
        digest: runDigest(diagnostic.digest),
      });
      if (diagnosticBytes.length !== diagnostic.sizeBytes) {
        throw new Error("Diagnostic size does not match its result reference.");
      }
    } catch (error) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/diagnostics`,
        message: error instanceof Error ? error.message : "Verifier diagnostic could not be verified.",
      });
    }
  }
  return errors;
}

function hasPortablePathCollision(path: string, existingPaths: ReadonlySet<string>): boolean {
  return [...existingPaths].some((existing) => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`));
}

export function validateExportManifest(
  artifact: string,
  exportManifest: unknown,
  containingManifest: unknown | undefined,
  bundleRoot?: string,
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
  const expectedBundleId = typeof containingManifest.bundleId === "string" ? containingManifest.bundleId : undefined;
  const expectedVerifier = isRecord(containingManifest.run) && isRecord(containingManifest.run.verifier)
    ? containingManifest.run.verifier
    : undefined;
  const workspaceEvidence = new Map<string, Record<string, unknown>>(
    containingManifest.evidence
      .filter((entry): entry is Record<string, unknown> => isRecord(entry)
        && typeof entry.id === "string" && entry.kind === "workspace")
      .map((entry) => [entry.id as string, entry]),
  );
  const evidenceByPath = new Map<string, Record<string, unknown>>(
    containingManifest.evidence
      .filter((entry): entry is Record<string, unknown> => isRecord(entry)
        && typeof entry.relativePath === "string")
      .map((entry) => [(entry.relativePath as string).toLowerCase(), entry]),
  );
  const exportedIds = new Set(
    Array.isArray(exportManifest.artifactIds)
      ? exportManifest.artifactIds.filter((id): id is string => typeof id === "string")
      : [],
  );
  if (bundleRoot !== undefined) {
    errors.push(...validateRunManifestEvidence(artifact, containingManifest, bundleRoot));
  }
  const referencedDiagnosticPaths = new Set<string>();
  const exportedDiagnosticDescriptors: Record<string, unknown>[] = [];
  let hasNonExportArtifact = false;
  for (const id of Array.isArray(exportManifest.artifactIds) ? exportManifest.artifactIds : []) {
    const descriptor = typeof id === "string" ? evidenceById.get(id) : undefined;
    if (descriptor === undefined || descriptor.sharingClass === "unknown" || descriptor.sharingClass !== exportManifest.sharingClass) {
      errors.push({ artifact, schemaVersion: "export-manifest/v1", field: "/artifactIds", message: `Export cannot include artifact ${String(id)}.` });
      continue;
    }
    if (exportManifest.sharingClass === "partner" || exportManifest.sharingClass === "public") {
      validateSanitizedProvenance(artifact, "export-manifest/v1", descriptor, evidenceById, errors);
      if (descriptor.kind === "verifier" && descriptor.sanitizedFrom !== undefined) {
        errors.push(...validateExportedVerifierDiagnostics(
          artifact,
          descriptor,
          bundleRoot,
          expectedBundleId,
          expectedVerifier,
          workspaceEvidence,
          evidenceByPath,
          exportedIds,
        ));
        for (const locator of exportedVerifierDiagnosticLocators(bundleRoot, descriptor)) {
          referencedDiagnosticPaths.add(locator);
        }
      }
      if (descriptor.kind === "diagnostic" && descriptor.sanitizedFrom !== undefined) {
        errors.push(...validateExportedDiagnosticSidecar(artifact, descriptor, bundleRoot, evidenceById));
        exportedDiagnosticDescriptors.push(descriptor);
      }
    }
    hasNonExportArtifact ||= descriptor.kind !== "export-manifest";
  }
  for (const descriptor of exportedDiagnosticDescriptors) {
    if (typeof descriptor.relativePath === "string" && !referencedDiagnosticPaths.has(descriptor.relativePath.toLowerCase())) {
      errors.push({
        artifact,
        schemaVersion: "export-manifest/v1",
        field: `/artifactIds/${escapeJsonPointer(String(descriptor.id))}`,
        message: "Exported diagnostic sidecars must be referenced by an exported sanitized verifier.",
      });
    }
  }
  if (!hasNonExportArtifact) errors.push({ artifact, schemaVersion: "export-manifest/v1", field: "/artifactIds", message: "Ready exports must include non-export evidence." });
  return errors;
}

function exportedVerifierDiagnosticLocators(
  bundleRoot: string | undefined,
  descriptor: Record<string, unknown>,
): string[] {
  if (bundleRoot === undefined || typeof descriptor.relativePath !== "string" || typeof descriptor.digest !== "string") return [];
  try {
    const bytes = resolveBundleArtifact(bundleRoot, {
      locator: descriptor.relativePath,
      digest: runDigest(descriptor.digest),
    });
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(result) && Array.isArray(result.diagnostics)
      ? result.diagnostics.flatMap((diagnostic) => isRecord(diagnostic) && typeof diagnostic.locator === "string"
        ? [diagnostic.locator.toLowerCase()]
        : [])
      : [];
  } catch {
    return [];
  }
}

function validateExportedDiagnosticSidecar(
  artifact: string,
  descriptor: Record<string, unknown>,
  bundleRoot: string | undefined,
  evidenceById: ReadonlyMap<string, Record<string, unknown>>,
): ArtifactValidationError[] {
  const scope = `/artifactIds/${escapeJsonPointer(String(descriptor.id))}`;
  if (bundleRoot === undefined) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: scope, message: "Exported diagnostic sidecars require a bundle root." }];
  }
  const sourceBinding = isDiagnosticSourceBinding(descriptor.diagnosticSource) ? descriptor.diagnosticSource : undefined;
  if (sourceBinding === undefined) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/diagnosticSource`, message: "Exported diagnostic sidecars require source-specific provenance." }];
  }
  if (!isRecord(descriptor.sanitizedFrom) || descriptor.sanitizedFrom.artifactId !== sourceBinding.verifierId) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/sanitizedFrom`, message: "Diagnostic sidecar provenance must name its diagnostic source verifier." }];
  }
  const sourceDescriptor = evidenceById.get(sourceBinding.verifierId);
  if (sourceDescriptor === undefined || sourceDescriptor.kind !== "verifier"
      || typeof sourceDescriptor.relativePath !== "string" || typeof sourceDescriptor.digest !== "string") {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/diagnosticSource/verifierId`, message: "Diagnostic source provenance must reference a retained verifier." }];
  }
  let sourceOutcome: NestedVerifierOutcome | undefined;
  try {
    const sourceBytes = resolveBundleArtifact(bundleRoot, {
      locator: sourceDescriptor.relativePath,
      digest: runDigest(sourceDescriptor.digest),
    });
    sourceOutcome = nestedVerifierOutcome(sourceBytes);
  } catch {
    sourceOutcome = undefined;
  }
  if (sourceOutcome === undefined || !sourceOutcome.diagnostics.some((diagnostic) => sameDiagnosticOrigin(diagnostic, sourceBinding))) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/diagnosticSource`, message: "Diagnostic source provenance must match a retained source diagnostic." }];
  }
  const errors: ArtifactValidationError[] = [];
  if (typeof descriptor.relativePath !== "string" || typeof descriptor.digest !== "string" || typeof descriptor.sizeBytes !== "number") return errors;
  try {
    const sidecarBytes = resolveBundleArtifact(bundleRoot, {
      locator: descriptor.relativePath,
      digest: runDigest(descriptor.digest),
    });
    if (sidecarBytes.length !== descriptor.sizeBytes) throw new Error("Diagnostic sidecar size does not match its descriptor.");
  } catch (error) {
    errors.push({ artifact, schemaVersion: "export-manifest/v1", field: scope, message: error instanceof Error ? error.message : "Diagnostic sidecar could not be verified." });
  }
  if (descriptor.digest === sourceBinding.digest) {
    errors.push({ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/digest`, message: "Diagnostic sidecar bytes must differ from the source diagnostic." });
  }
  return errors;
}

function validateExportedVerifierDiagnostics(
  artifact: string,
  descriptor: Record<string, unknown>,
  bundleRoot: string | undefined,
  expectedBundleId: string | undefined,
  expectedVerifier: Record<string, unknown> | undefined,
  workspaceEvidence: ReadonlyMap<string, Record<string, unknown>>,
  evidenceByPath: ReadonlyMap<string, Record<string, unknown>>,
  exportedIds: ReadonlySet<string>,
): ArtifactValidationError[] {
  const scope = `/artifactIds/${escapeJsonPointer(String(descriptor.id))}`;
  if (bundleRoot === undefined) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: scope, message: "Sanitized verifier exports require a bundle root to validate diagnostics." }];
  }
  let bytes: Buffer;
  try {
    bytes = resolveBundleArtifact(bundleRoot, {
      locator: descriptor.relativePath as string,
      digest: runDigest(descriptor.digest as string),
    });
  } catch (error) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: scope, message: error instanceof Error ? error.message : "Sanitized verifier could not be read." }];
  }
  const evidencePaths = new Set([...evidenceByPath.keys()]);
  const errors = nestedVerifierDiagnosticErrors(
    artifact,
    String(descriptor.id),
    bytes,
    bundleRoot,
    expectedBundleId,
    expectedVerifier,
    workspaceEvidence,
    true,
    isRecord(descriptor.sanitizedFrom) && typeof descriptor.sanitizedFrom.artifactId === "string"
      ? descriptor.sanitizedFrom.artifactId
      : undefined,
    evidenceByPath,
    evidencePaths,
    new Set(),
  );
  if (errors.length > 0) return errors.map((error) => ({ ...error, schemaVersion: "export-manifest/v1", field: `${scope}${error.field.replace(/^\/evidence\/[^/]*/, "")}` }));

  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return [];
  }
  if (!isRecord(result) || !Array.isArray(result.diagnostics)) return [];
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    if (!isRecord(diagnostic) || typeof diagnostic.locator !== "string") continue;
    const sidecar = evidenceByPath.get(diagnostic.locator.toLowerCase());
    if (sidecar !== undefined && typeof sidecar.id === "string" && !exportedIds.has(sidecar.id)) {
      errors.push({
        artifact,
        schemaVersion: "export-manifest/v1",
        field: `${scope}/diagnostics/${index}/locator`,
        message: "Sanitized verifier diagnostic sidecars must be included in the export.",
      });
    }
  }
  return errors;
}

export async function readVerifiedArtifact(
  artifactRoot: string,
  relativePath: string,
  expectedDigest: Digest,
): Promise<Buffer> {
  const { root, path } = await resolveExistingArtifactPath(artifactRoot, relativePath);
  removeInterruptedPublicationLink(path, lstatSync(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || !(await isReadablePublishedArtifact(path, opened))
        || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
    await assertExistingArtifactPath(root, relativePath);
    const bytes = await handle.readFile();
    const completed = await handle.stat();
    if (!completed.isFile() || !(await isReadablePublishedArtifact(path, completed))
        || completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size) {
      throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
    }
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
  options: { overwrite?: boolean } = {},
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
    if (options.overwrite === false) {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Artifact metadata path "${relativePath}" already exists.`);
        }
        throw error;
      }
      await rm(temporaryPath, { force: true });
    } else {
      await rename(temporaryPath, path);
    }
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
  beforeDestinationPublish?: () => void,
  afterDestinationPublish?: () => void,
): { created: boolean; digest: Digest } {
  const bytes = Buffer.from(canonicalizeMetadata(metadata));
  const rootIdentity = rootHandle ?? openBundleRoot(artifactRoot);
  const ownsRoot = rootHandle === undefined;
  let descriptor: number | undefined;
  let temporaryPath: string | undefined;

  try {
    const { createdDirectories, parent, path } = prepareArtifactPathSync(rootIdentity.path, relativePath);
    temporaryPath = resolve(parent, `.${randomUUID()}.tmp`);
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    beforeDestinationPublish?.();

    let created = false;
    try {
      linkSync(temporaryPath, path);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (created) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      temporaryPath = undefined;
    }
    syncPublicationDirectories(rootIdentity.path, createdDirectories, parent);
    if (created) afterDestinationPublish?.();
    return { created, digest: digestExistingPath(path, relativePath) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (temporaryPath !== undefined) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // ponytail: a unique stale temp is harmless; add managed cleanup only if accumulation is observed.
        }
      }
    }
    if (ownsRoot) closeBundleRoot(rootIdentity);
  }
}

function loadValidators(): Map<string, ValidateFunction> {
  const readSchema = (name: string): object => JSON.parse(readFileSync(`${schemaDirectory}${name}`, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  addFormats(ajv);
  ajv.addSchema(readSchema("task-packet.v1.schema.json"));
  ajv.addSchema(readSchema("task-packet-freeze.v1.schema.json"));
  ajv.addSchema(readSchema("experiment.v1.schema.json"));
  ajv.addSchema(readSchema("run-queue.v1.schema.json"));
  ajv.addSchema(readSchema("run-bundles/v1.json"));

  return new Map([
    ["ebo.task-packet/v1", requiredValidator(ajv, "https://ebo.dev/schemas/task-packet.v1.schema.json")],
    ["ebo.task-packet-freeze/v1", requiredValidator(ajv, "https://ebo.dev/schemas/task-packet-freeze.v1.schema.json")],
    ["ebo.experiment/v1", requiredValidator(ajv, "https://ebo.dev/schemas/experiment.v1.schema.json")],
    ["ebo.run-queue/v1", requiredValidator(ajv, "https://ebo.dev/schemas/run-queue.v1.schema.json")],
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
    const diagnosticDerivative = current.kind === "diagnostic" && source.kind === "verifier";
    if (["source", "authority"].some((key) => source[key] !== current[key])
        || (!diagnosticDerivative && source.kind !== current.kind)
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
): { createdDirectories: string[]; parent: string; path: string } {
  assertSafeArtifactPath(relativePath);
  const root = realpathSync(artifactRoot);
  const segments = relativePath.split("/");
  const createdDirectories: string[] = [];
  let parent = root;

  for (const segment of segments.slice(0, -1)) {
    parent = resolve(parent, segment);
    if (!isContained(root, parent)) throw new Error(`Artifact path "${relativePath}" escapes its declared root.`);
    try {
      mkdirSync(parent, { mode: 0o700 });
      createdDirectories.push(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const entry = lstatSync(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${relativePath}" crosses a symbolic link.`);
    }
  }

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
}

function digestExistingPath(path: string, relativePath: string): Digest {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    let opened = fstatSync(descriptor);
    if (opened.nlink > 1) {
      removeInterruptedPublicationLink(path, opened);
      opened = fstatSync(descriptor);
    }
    const openedTimes = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !isReadablePublishedFile(path, opened)
        || !Number.isSafeInteger(opened.size) || opened.size < 0) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < opened.size;) {
      const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (read === 0) throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailing, 0, 1, opened.size) !== 0) {
      throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
    }
    const completed = fstatSync(descriptor);
    const completedTimes = fstatSync(descriptor, { bigint: true });
    if (!completed.isFile() || !isReadablePublishedFile(path, completed)
        || !sameFileIdentity(opened, completed) || completed.size !== opened.size
        || completedTimes.mtimeNs !== openedTimes.mtimeNs || completedTimes.ctimeNs !== openedTimes.ctimeNs) {
      throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
    }
    return { algorithm: "sha256", value: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function isReadablePublishedFile(path: string, target: { dev: number; ino: number; nlink: number }): boolean {
  try {
    const current = lstatSync(path);
    return target.nlink === 1 && current.nlink === 1
      && current.isFile() && !current.isSymbolicLink() && sameFileIdentity(current, target);
  } catch {
    return false;
  }
}

async function isReadablePublishedArtifact(path: string, target: { dev: number; ino: number; nlink: number }): Promise<boolean> {
  try {
    const current = await lstat(path);
    return target.nlink === 1 && current.nlink === 1
      && current.isFile() && !current.isSymbolicLink() && sameFileIdentity(current, target);
  } catch {
    return false;
  }
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectorySync(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncPublicationDirectories(root: string, createdDirectories: readonly string[], parent: string): void {
  const directories = new Set([parent, ...createdDirectories.slice().reverse(), ...createdDirectories.map(dirname), root]);
  for (const directory of directories) syncDirectorySync(directory);
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
