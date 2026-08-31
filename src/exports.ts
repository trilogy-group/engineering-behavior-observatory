import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  assertNoDuplicateJsonKeys,
  assertUniqueArtifactIdentities,
  canonicalizeMetadata,
  digestMetadata,
  inspectRetainedArtifact,
  readVerifiedArtifact,
  validateArtifact,
  validateRunManifestEvidence,
  writeArtifactAtomically,
  writeMetadataAtomically,
} from "./artifacts.js";
import type { Digest } from "./contracts.js";
import type { RunBundleEvidenceDescriptor, RunManifest } from "./run-bundles.js";

type DigestString = `sha256:${string}`;
type PortableKind = Exclude<RunBundleEvidenceDescriptor["kind"], "export-manifest">;
type TransformationAction =
  | "sanitized"
  | "canonicalized"
  | "removed-field"
  | "redacted-secret"
  | "redacted-local-identifier"
  | "rewritten-correlation"
  | "truncated";

export type PortableExportPolicy = {
  sharingClass: "partner" | "public";
  maxArtifactBytes: number;
  maxStringBytes: number;
  sensitiveValues?: readonly string[];
};

export type PortableExportArtifact = {
  id: string;
  sourceArtifactId: string;
  kind: PortableKind;
  mediaType: string;
  digest: DigestString;
  sizeBytes: number;
  relativePath: string;
  sourceDigest: DigestString;
  diagnosticSource?: {
    verifierId: string;
    stream: "stdout" | "stderr";
    locatorDigest: DigestString;
    sizeBytes: number;
  };
};

export type PortableExportManifest = {
  schemaVersion: "export-manifest/v1";
  bundleId: string;
  status: "ready" | "exported";
  sharingClass: "partner" | "public";
  policyDigest: DigestString;
  artifactIds: string[];
  sourceManifestDigest: DigestString;
  correlations: {
    bundleId: string;
    runId: string;
    attemptId: string;
    sessionId?: string;
    traceId?: string;
  };
  artifacts: PortableExportArtifact[];
  transformations: Array<{ artifactId: string; action: TransformationAction; count: number }>;
  excludedArtifacts: Array<{ artifactId: string; reason: "source-export-manifest" }>;
};

export type CreatePortableRunBundleExportOptions = {
  sourceRoot: string;
  destinationRoot: string;
  policy: PortableExportPolicy;
};

type SourceDiagnostic = {
  stream: "stdout" | "stderr";
  locator: string;
  digest: DigestString;
  sizeBytes: number;
  truncated: boolean;
};

type PortableDiagnosticOutput = { artifact: PortableExportArtifact; truncated: boolean };

const MAX_SOURCE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const HIDDEN_FIELDS = new Set([
  "chainofthought",
  "extendedthinking",
  "hiddenreasoning",
  "rawapibody",
  "rawrequestbody",
  "rawresponsebody",
  "reasoning",
  "thinking",
]);
const SECRET_FIELDS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "connectionstring",
  "credential",
  "credentials",
  "credentialsjson",
  "databaseurl",
  "idtoken",
  "oauthtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "token",
]);
// "eborunid"/"eboattemptid" are the normalized EBO OTel resource-attribute keys
// ("ebo.run.id"/"ebo.attempt.id") retained inside native telemetry evidence.
const CORRELATION_FIELDS = new Set(["attemptid", "bundleid", "id", "runid", "sessionid", "traceid", "eborunid", "eboattemptid"]);
const LOCAL_IDENTIFIER_FIELDS = new Set(["login", "owner", "user", "username"]);
const TRUNCATABLE_FIELDS = new Set([
  "body",
  "commandoutput",
  "content",
  "diff",
  "filecontent",
  "input",
  "output",
  "patch",
  "prompt",
  "stderr",
  "stdout",
  "text",
  "toolinput",
  "toolresult",
]);
const SECRET_PATTERNS = [
  /()(?:-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|$))()/gu,
  /()(?:\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b)()/gu,
  /((?:authorization)\s*[:=])(?!(?:\s*)\[REDACTED_)\s*[^\r\n]+()/giu,
  /((?:authorization|api[_-]?key|(?:access|oauth|refresh|id)?[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|credentials?(?:[_-]?json)?|database[_-]?url|connection[_-]?string|password)\s*[:=]\s*")(?!\[REDACTED_SECRET\]")(?:\\.|[^"\\])*(")/giu,
  /((?:authorization|api[_-]?key|(?:access|oauth|refresh|id)?[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|credentials?(?:[_-]?json)?|database[_-]?url|connection[_-]?string|password)\s*[:=]\s*')(?!\[REDACTED_SECRET\]')(?:\\.|[^'\\])*(')/giu,
  /((?:authorization|api[_-]?key|(?:access|oauth|refresh|id)?[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|credentials?(?:[_-]?json)?|database[_-]?url|connection[_-]?string|password)\s*[:=])(?!(?:\s*(?:Bearer\s+)?)\[REDACTED_)\s*(?:Bearer\s+)?[^\s,"'}\]]{8,}()/giu,
];
const LOCAL_IDENTIFIER_PATTERNS = [
  /((?:user(?:name)?|owner|login)\s*[:=]\s*")(?!\[LOCAL_USER\]")(?:\\.|[^"\\])*(")/giu,
  /((?:user(?:name)?|owner|login)\s*[:=]\s*')(?!\[LOCAL_USER\]')(?:\\.|[^'\\])*(')/giu,
  /((?:user(?:name)?|owner|login)\s*[:=])(?!(?:\s*)\[LOCAL_USER\])\s*[^\s,"'}\]]+()/giu,
];
const LOCAL_PATH = /(^|[\s"'=:(+\-])(?:[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*|\/(?!\/)[^\s"']+)/gu;

/** Create one separately rooted, sanitized derivative of an M2 run bundle. */
export async function createPortableRunBundleExport(
  options: CreatePortableRunBundleExportOptions,
): Promise<PortableExportManifest> {
  validatePolicy(options.policy);
  const sourceRoot = resolve(options.sourceRoot);
  const destinationRoot = resolve(options.destinationRoot);
  const destinationWithinSource = relative(sourceRoot, destinationRoot);
  if (destinationWithinSource === "" || (!destinationWithinSource.startsWith("..") && !isAbsolute(destinationWithinSource))) {
    throw new Error("Portable export destination must be outside the restricted source bundle.");
  }

  const { manifest: sourceManifest, digest: sourceManifestDigest } = await readSourceManifest(sourceRoot);
  const sourceErrors = [
    ...validateArtifact("manifest.json", sourceManifest),
    ...validateRunManifestEvidence("manifest.json", sourceManifest, sourceRoot),
  ];
  if (sourceErrors.length > 0) throw new Error(formatValidationErrors(sourceErrors));
  for (const descriptor of sourceManifest.evidence) {
    if (descriptor.sharingClass === "unknown") {
      throw new Error(`Artifact ${descriptor.id} has an unknown sharing classification.`);
    }
    if (!["restricted", "internal"].includes(descriptor.sharingClass)) {
      throw new Error(`Artifact ${descriptor.id} is not a restricted or internal M2 source artifact.`);
    }
  }

  const policyDigest = digestString(digestMetadata(policyRecord(options.policy)));
  const correlations = correlationProjection(sourceManifest, policyDigest);
  const replacements = correlationReplacements(sourceManifest, correlations);
  const sensitiveValues = effectiveSensitiveValues(options.policy);
  const localIdentifiers = [homedir(), userInfo().username].filter((value) => value.length > 1);
  const artifacts: PortableExportArtifact[] = [];
  const transformations: PortableExportManifest["transformations"] = [];
  const excludedArtifacts: PortableExportManifest["excludedArtifacts"] = [];

  await mkdir(dirname(destinationRoot), { recursive: true, mode: 0o700 });
  await mkdir(destinationRoot, { mode: 0o700 });
  try {
    const portableDiagnostics = new Map<string, PortableDiagnosticOutput>();
    let diagnosticIndex = sourceManifest.evidence.length;
    for (const verifier of sourceManifest.evidence.filter(({ kind }) => kind === "verifier")) {
      const verifierBytes = await readVerifiedArtifact(
        sourceRoot, verifier.relativePath, digestValue(verifier.digest), MAX_SOURCE_ARTIFACT_BYTES,
      );
      for (const [index, diagnostic] of sourceDiagnostics(parseJson(verifierBytes, "Verifier evidence")).entries()) {
        if (portableDiagnostics.has(diagnostic.locator)) {
          throw new Error(`Verifier diagnostic ${diagnostic.locator} is referenced more than once.`);
        }
        const sourceBytes = await readVerifiedArtifact(
          sourceRoot, diagnostic.locator, digestValue(diagnostic.digest), MAX_SOURCE_ARTIFACT_BYTES,
        );
        if (sourceBytes.length !== diagnostic.sizeBytes) {
          throw new Error(`Verifier diagnostic ${diagnostic.locator} size does not match its source reference.`);
        }
        const id = `diagnostic-${createHash("sha256").update(`${verifier.id}\0${String(index)}\0${diagnostic.locator}`).digest("hex").slice(0, 24)}`;
        const relativePath = `evidence/${String(diagnosticIndex++).padStart(4, "0")}.txt`;
        const counts = new Map<TransformationAction, number>([["sanitized", 1]]);
        const outputBytes = sanitizeArtifact(
          sourceBytes,
          "text/plain",
          options.policy,
          replacements,
          sensitiveValues,
          localIdentifiers,
          counts,
          "diagnostic",
        );
        const digest = await writeArtifactAtomically(destinationRoot, relativePath, outputBytes, undefined, { overwrite: false });
        const artifact: PortableExportArtifact = {
          id,
          sourceArtifactId: id,
          kind: "diagnostic",
          mediaType: "text/plain",
          digest: digestString(digest),
          sizeBytes: outputBytes.length,
          relativePath,
          sourceDigest: diagnostic.digest,
          diagnosticSource: {
            verifierId: verifier.id,
            stream: diagnostic.stream,
            locatorDigest: digestText(diagnostic.locator),
            sizeBytes: diagnostic.sizeBytes,
          },
        };
        artifacts.push(artifact);
        transformations.push(...[...counts.entries()].map(([action, count]) => ({ artifactId: id, action, count })));
        portableDiagnostics.set(diagnostic.locator, { artifact, truncated: diagnostic.truncated || counts.has("truncated") });
      }
    }

    for (const [index, descriptor] of sourceManifest.evidence.entries()) {
      if (descriptor.kind === "export-manifest") {
        excludedArtifacts.push({ artifactId: descriptor.id, reason: "source-export-manifest" });
        continue;
      }
      assertSupportedPair(descriptor.kind, descriptor.mediaType);
      const sourceBytes = await readVerifiedArtifact(
        sourceRoot,
        descriptor.relativePath,
        digestValue(descriptor.digest),
        MAX_SOURCE_ARTIFACT_BYTES,
      );
      if (sourceBytes.length !== descriptor.sizeBytes) {
        throw new Error(`Artifact ${descriptor.id} size does not match its source descriptor.`);
      }
      const counts = new Map<TransformationAction, number>([["sanitized", 1]]);
      const outputBytes = sanitizeArtifact(
        sourceBytes,
        descriptor.mediaType,
        options.policy,
        replacements,
        sensitiveValues,
        localIdentifiers,
        counts,
        descriptor.kind,
        portableDiagnostics,
      );
      const relativePath = `evidence/${String(index).padStart(4, "0")}${extensionFor(descriptor.mediaType)}`;
      const digest = await writeArtifactAtomically(destinationRoot, relativePath, outputBytes, undefined, { overwrite: false });
      artifacts.push({
        id: descriptor.id,
        sourceArtifactId: descriptor.id,
        kind: descriptor.kind,
        mediaType: descriptor.mediaType,
        digest: digestString(digest),
        sizeBytes: outputBytes.length,
        relativePath,
        sourceDigest: descriptor.digest,
      });
      transformations.push(...[...counts.entries()].map(([action, count]) => ({ artifactId: descriptor.id, action, count })));
    }

    const manifest: PortableExportManifest = {
      schemaVersion: "export-manifest/v1",
      bundleId: correlations.bundleId,
      status: "ready",
      sharingClass: options.policy.sharingClass,
      policyDigest,
      artifactIds: artifacts.map(({ id }) => id),
      sourceManifestDigest,
      correlations,
      artifacts,
      transformations,
      excludedArtifacts,
    };
    const schemaErrors = validateArtifact("manifest.json", manifest);
    if (schemaErrors.length > 0) throw new Error(formatValidationErrors(schemaErrors));
    await writeMetadataAtomically(destinationRoot, "manifest.json", manifest, undefined, { overwrite: false });
    const readback = await readPortableRunBundleExport(destinationRoot, options.policy, sourceManifest, sourceRoot);
    if (readback.sourceManifestDigest !== sourceManifestDigest) {
      throw new Error("Portable export source-manifest digest changed before readback.");
    }
    return structuredClone(manifest);
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Read back and revalidate a completed portable export tree. */
export async function readPortableRunBundleExport(
  exportRoot: string,
  policy: PortableExportPolicy,
  sourceManifest?: RunManifest,
  sourceRoot?: string,
): Promise<PortableExportManifest> {
  validatePolicy(policy);
  const root = resolve(exportRoot);
  const manifestBytes = await verifiedManifestBytes(root);
  const manifest = parseJson(manifestBytes, "Portable export manifest") as PortableExportManifest;
  const schemaErrors = validateArtifact("manifest.json", manifest);
  if (schemaErrors.length > 0) throw new Error(formatValidationErrors(schemaErrors));
  if (manifest.status !== "ready" && manifest.status !== "exported") throw new Error("Portable export is not ready.");
  if (manifest.sharingClass !== policy.sharingClass || manifest.policyDigest !== digestString(digestMetadata(policyRecord(policy)))) {
    throw new Error("Portable export policy does not match the requested policy.");
  }

  assertUniqueArtifactIdentities(manifest.artifacts.map(({ id, relativePath }) => ({ id, relativePath })));
  if (JSON.stringify(manifest.artifactIds) !== JSON.stringify(manifest.artifacts.map(({ id }) => id))) {
    throw new Error("Portable export artifact index does not match its descriptors.");
  }
  const included = new Set(manifest.artifactIds);
  const includedSources = new Set(manifest.artifacts.map(({ sourceArtifactId }) => sourceArtifactId));
  const excluded = new Set(manifest.excludedArtifacts.map(({ artifactId }) => artifactId));
  if (includedSources.size !== manifest.artifacts.length || excluded.size !== manifest.excludedArtifacts.length
      || [...excluded].some((id) => included.has(id) || includedSources.has(id))) {
    throw new Error("Portable export exclusions are duplicate or included artifacts.");
  }
  if (manifest.transformations.some(({ artifactId, count }) => !included.has(artifactId) || !Number.isSafeInteger(count) || count < 1)) {
    throw new Error("Portable export transformation references are invalid.");
  }
  const transformationKeys = new Set(manifest.transformations.map(({ artifactId, action }) => `${artifactId}\0${action}`));
  if (transformationKeys.size !== manifest.transformations.length) {
    throw new Error("Portable export contains duplicate transformation records.");
  }
  if (manifest.artifacts.some(({ id }) => !manifest.transformations.some(({ artifactId }) => artifactId === id))) {
    throw new Error("Portable export omits an artifact transformation record.");
  }

  const artifactBytes: Buffer[] = [];
  for (const artifact of manifest.artifacts) {
    assertSupportedPair(artifact.kind, artifact.mediaType);
    const bytes = await readVerifiedArtifact(root, artifact.relativePath, digestValue(artifact.digest), policy.maxArtifactBytes);
    if (bytes.length !== artifact.sizeBytes) throw new Error(`Portable artifact ${artifact.id} size does not match its descriptor.`);
    parseSanitizedArtifact(bytes, artifact.mediaType);
    artifactBytes.push(bytes);
  }
  validatePortableDiagnosticReferences(manifest, artifactBytes);
  if (sourceManifest !== undefined) await validateSourceReferences(manifest, sourceManifest, sourceRoot);
  scanPortableTree(
    [manifestBytes, ...artifactBytes],
    effectiveSensitiveValues(policy),
    sourceManifest === undefined ? [] : sourceCorrelationValues(sourceManifest),
  );
  return structuredClone(manifest);
}

async function readSourceManifest(root: string): Promise<{ manifest: RunManifest; digest: DigestString }> {
  const inspected = await inspectRetainedArtifact(root, "manifest.json");
  if (inspected.sizeBytes > 8 * 1024 * 1024) throw new Error("Run manifest exceeds the export byte limit.");
  const bytes = await readVerifiedArtifact(root, "manifest.json", inspected.digest, 8 * 1024 * 1024);
  return { manifest: parseJson(bytes, "Run manifest") as RunManifest, digest: digestString(inspected.digest) };
}

async function verifiedManifestBytes(root: string): Promise<Buffer> {
  const inspected = await inspectRetainedArtifact(root, "manifest.json");
  if (inspected.sizeBytes > 8 * 1024 * 1024) throw new Error("Portable export manifest exceeds the readback byte limit.");
  return readVerifiedArtifact(root, "manifest.json", inspected.digest, 8 * 1024 * 1024);
}

function sanitizeArtifact(
  bytes: Buffer,
  mediaType: string,
  policy: PortableExportPolicy,
  replacements: ReadonlyMap<string, string>,
  sensitiveValues: readonly string[],
  localIdentifiers: readonly string[],
  counts: Map<TransformationAction, number>,
  kind?: PortableKind,
  portableDiagnostics: ReadonlyMap<string, PortableDiagnosticOutput> = new Map(),
): Buffer {
  if (mediaType === "application/json") {
    increment(counts, "canonicalized");
    const output = Buffer.from(canonicalizeMetadata(sanitizeValue(
      kind === "verifier"
        ? rewriteVerifierDiagnosticReferences(parseJson(bytes, "JSON evidence"), portableDiagnostics)
        : parseJson(bytes, "JSON evidence"),
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts,
    )));
    if (output.length > policy.maxArtifactBytes) throw new Error("Sanitized JSON evidence exceeds the configured artifact limit.");
    return output;
  }
  if (mediaType === "application/x-ndjson") {
    const lines = decode(bytes, "JSONL evidence").split(/\r?\n/gu).filter((line) => line.trim() !== "");
    if (lines.length === 0) throw new Error("JSONL evidence is empty.");
    increment(counts, "canonicalized", lines.length);
    const sanitized = lines.map((line) => canonicalizeMetadata(sanitizeValue(
      parseJson(Buffer.from(line), "JSONL evidence record"), policy, replacements, sensitiveValues, localIdentifiers, counts,
    )));
    const retained: string[] = [];
    for (const line of sanitized) {
      if (Buffer.byteLength(`${[...retained, line].join("\n")}\n`) > policy.maxArtifactBytes) break;
      retained.push(line);
    }
    if (retained.length === 0) throw new Error("Sanitized JSONL record exceeds the configured artifact limit.");
    if (retained.length !== sanitized.length) increment(counts, "truncated", sanitized.length - retained.length);
    return Buffer.from(`${retained.join("\n")}\n`);
  }
  const sanitized = rewriteString(
    decode(bytes, "text evidence"), policy, replacements, sensitiveValues, localIdentifiers, counts, false, true, true,
  );
  const bounded = truncateUtf8(sanitized, policy.maxArtifactBytes);
  if (bounded !== sanitized) increment(counts, "truncated");
  return Buffer.from(bounded);
}

function sourceDiagnostics(value: unknown): SourceDiagnostic[] {
  if (!isRecord(value) || value.diagnostics === undefined) return [];
  if (!Array.isArray(value.diagnostics)) throw new Error("Verifier diagnostics must be an array.");
  return value.diagnostics.map((entry) => {
    if (!isRecord(entry) || !["stdout", "stderr"].includes(String(entry.stream))
        || typeof entry.locator !== "string" || typeof entry.digest !== "string"
        || !Number.isSafeInteger(entry.sizeBytes) || typeof entry.truncated !== "boolean") {
      throw new Error("Verifier diagnostic reference is invalid.");
    }
    return {
      stream: entry.stream as SourceDiagnostic["stream"],
      locator: entry.locator,
      digest: entry.digest as DigestString,
      sizeBytes: entry.sizeBytes as number,
      truncated: entry.truncated,
    };
  });
}

function rewriteVerifierDiagnosticReferences(
  value: unknown,
  diagnostics: ReadonlyMap<string, PortableDiagnosticOutput>,
): unknown {
  if (diagnostics.size === 0 || !isRecord(value) || !Array.isArray(value.diagnostics)) return value;
  const output = structuredClone(value);
  for (const diagnostic of output.diagnostics as unknown[]) {
    if (!isRecord(diagnostic) || typeof diagnostic.locator !== "string") {
      throw new Error("Verifier diagnostic reference is invalid.");
    }
    const portable = diagnostics.get(diagnostic.locator);
    if (portable === undefined) throw new Error(`Verifier diagnostic ${diagnostic.locator} was not exported.`);
    diagnostic.locator = portable.artifact.relativePath;
    diagnostic.digest = portable.artifact.digest;
    diagnostic.sizeBytes = portable.artifact.sizeBytes;
    diagnostic.truncated = portable.truncated;
    delete diagnostic.source;
  }
  return output;
}

function sanitizeValue(
  value: unknown,
  policy: PortableExportPolicy,
  replacements: ReadonlyMap<string, string>,
  sensitiveValues: readonly string[],
  localIdentifiers: readonly string[],
  counts: Map<TransformationAction, number>,
  fieldName?: string,
  truncatable = false,
): unknown {
  const normalizedField = fieldName === undefined ? undefined : normalizeFieldName(fieldName);
  if (typeof value === "string") {
    // Correlation values are also rewritten as substrings: native evidence
    // embeds session and workspace identities inside encoded path strings that
    // survive absolute-path redaction.
    return rewriteString(
      value,
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts,
      normalizedField !== undefined && CORRELATION_FIELDS.has(normalizedField),
      truncatable,
      true,
      normalizedField !== undefined && LOCAL_IDENTIFIER_FIELDS.has(normalizedField),
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(
      entry, policy, replacements, sensitiveValues, localIdentifiers, counts, fieldName, truncatable,
    ));
  }
  if (!isRecord(value)) return value;
  const sourceFieldCount = Object.keys(value).length;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (HIDDEN_FIELDS.has(normalizeFieldName(key))) {
      increment(counts, "removed-field");
      continue;
    }
    if (SECRET_FIELDS.has(normalizeFieldName(key))) {
      output[key] = "[REDACTED_SECRET]";
      increment(counts, "redacted-secret");
      continue;
    }
    output[key] = sanitizeValue(
      entry,
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts,
      key,
      truncatable || TRUNCATABLE_FIELDS.has(normalizeFieldName(key)),
    );
  }
  if (sourceFieldCount > 0 && Object.keys(output).length === 0) {
    throw new Error("Sanitization removed every field from an evidence record.");
  }
  return output;
}

function rewriteString(
  input: string,
  policy: PortableExportPolicy,
  replacements: ReadonlyMap<string, string>,
  sensitiveValues: readonly string[],
  localIdentifiers: readonly string[],
  counts: Map<TransformationAction, number>,
  rewriteCorrelation: boolean,
  truncateContent: boolean,
  rewriteTextCorrelations = false,
  rewriteLocalIdentifier = false,
): string {
  let output = input;
  const correlation = rewriteCorrelation ? replacements.get(output) : undefined;
  if (correlation !== undefined) {
    output = correlation;
    increment(counts, "rewritten-correlation");
  }
  if (rewriteTextCorrelations) {
    for (const [source, replacement] of replacements) {
      if (source.length < 8) continue;
      const occurrences = countOccurrences(output, source);
      if (occurrences > 0) {
        output = output.replaceAll(source, replacement);
        increment(counts, "rewritten-correlation", occurrences);
      }
    }
  }
  for (const secret of sensitiveValues) {
    const occurrences = countOccurrences(output, secret);
    if (occurrences > 0) {
      output = output.replaceAll(secret, "[REDACTED_SECRET]");
      increment(counts, "redacted-secret", occurrences);
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: unknown, suffix: unknown) => {
      increment(counts, "redacted-secret");
      return `${typeof prefix === "string" ? prefix : ""}[REDACTED_SECRET]${typeof suffix === "string" ? suffix : ""}`;
    });
  }
  output = output.replace(LOCAL_PATH, (_match, prefix: unknown) => {
    increment(counts, "redacted-local-identifier");
    return `${typeof prefix === "string" ? prefix : ""}[LOCAL_PATH]`;
  });
  for (const pattern of LOCAL_IDENTIFIER_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: unknown, suffix: unknown) => {
      increment(counts, "redacted-local-identifier");
      return `${typeof prefix === "string" ? prefix : ""}[LOCAL_USER]${typeof suffix === "string" ? suffix : ""}`;
    });
  }
  if (rewriteLocalIdentifier) {
    for (const identifier of localIdentifiers.filter((value) => value !== homedir())) {
      if (output === identifier) {
        output = "[LOCAL_USER]";
        increment(counts, "redacted-local-identifier");
      }
    }
  }
  if (!truncateContent) return output;
  const bounded = truncateUtf8(output, policy.maxStringBytes);
  if (bounded !== output) increment(counts, "truncated");
  return bounded;
}

function scanPortableTree(
  buffers: readonly Buffer[],
  sensitiveValues: readonly string[],
  sourceCorrelations: readonly string[],
): void {
  for (const bytes of buffers) {
    const text = decode(bytes, "portable export");
    const secretPatternIndex = SECRET_PATTERNS.findIndex((pattern) => pattern.test(text));
    const failure = [
      ["known sensitive value", sensitiveValues.some((value) => text.includes(value))],
      ["secret pattern", secretPatternIndex >= 0],
      ["absolute path", LOCAL_PATH.test(text)],
      ["local identifier", LOCAL_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(text))],
      ["source correlation", sourceCorrelations.filter((value) => value.length >= 8).some((value) => text.includes(value))],
      ["hidden content field", /"(?:chain[_-]?of[_-]?thought|extended[_-]?thinking|hidden[_-]?reasoning|reasoning|thinking|raw[_-]?(?:api|request|response)[_-]?body)"\s*:/iu.test(text)],
    ].find(([, matched]) => matched);
    if (failure !== undefined) {
      resetPatterns();
      throw new Error(`Portable export failed the final secret scan: ${String(failure[0])}.`);
    }
    resetPatterns();
  }
}

async function validateSourceReferences(
  manifest: PortableExportManifest,
  source: RunManifest,
  sourceRoot?: string,
): Promise<void> {
  const sourceById = new Map(source.evidence.map((descriptor) => [descriptor.id, descriptor]));
  if (manifest.sourceManifestDigest === undefined) throw new Error("Portable export omits its source-manifest digest.");
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === "diagnostic") {
      const verifier = artifact.diagnosticSource === undefined
        ? undefined
        : sourceById.get(artifact.diagnosticSource.verifierId);
      if (artifact.diagnosticSource === undefined || verifier?.kind !== "verifier") {
        throw new Error(`Portable diagnostic ${artifact.id} does not reference a source verifier.`);
      }
      if (sourceRoot === undefined) {
        throw new Error("Source root is required to validate portable diagnostic provenance.");
      }
      const verifierBytes = await readVerifiedArtifact(
        sourceRoot, verifier.relativePath, digestValue(verifier.digest), MAX_SOURCE_ARTIFACT_BYTES,
      );
      const sourceDiagnostic = sourceDiagnostics(parseJson(verifierBytes, "Source verifier evidence")).find((diagnostic) =>
        diagnostic.stream === artifact.diagnosticSource?.stream
          && digestText(diagnostic.locator) === artifact.diagnosticSource.locatorDigest);
      if (sourceDiagnostic === undefined || sourceDiagnostic.digest !== artifact.sourceDigest
          || sourceDiagnostic.sizeBytes !== artifact.diagnosticSource.sizeBytes) {
        throw new Error(`Portable diagnostic ${artifact.id} does not match its source diagnostic reference.`);
      }
      continue;
    }
    const descriptor = sourceById.get(artifact.sourceArtifactId);
    if (descriptor === undefined || descriptor.digest !== artifact.sourceDigest
        || descriptor.kind !== artifact.kind || descriptor.mediaType !== artifact.mediaType) {
      throw new Error(`Portable artifact ${artifact.id} does not match its source reference.`);
    }
  }
  for (const excluded of manifest.excludedArtifacts) {
    if (sourceById.get(excluded.artifactId)?.kind !== "export-manifest") {
      throw new Error(`Portable exclusion ${excluded.artifactId} is not a source export manifest.`);
    }
  }
  const represented = new Set([
    ...manifest.artifacts.map(({ sourceArtifactId }) => sourceArtifactId),
    ...manifest.excludedArtifacts.map(({ artifactId }) => artifactId),
  ]);
  if (source.evidence.some(({ id }) => !represented.has(id))) {
    throw new Error("Portable export does not account for every source artifact.");
  }
}

function validatePortableDiagnosticReferences(
  manifest: PortableExportManifest,
  artifactBytes: readonly Buffer[],
): void {
  const artifactsByPath = new Map(manifest.artifacts.map((artifact) => [artifact.relativePath, artifact]));
  const artifactsById = new Map(manifest.artifacts.map((artifact) => [artifact.id, artifact]));
  const referencedDiagnostics = new Set<string>();
  for (const [index, verifier] of manifest.artifacts.entries()) {
    if (verifier.kind !== "verifier") continue;
    const document = parseJson(artifactBytes[index]!, `Portable verifier ${verifier.id}`);
    if (!isRecord(document) || document.diagnostics === undefined) continue;
    if (!Array.isArray(document.diagnostics)) throw new Error(`Portable verifier ${verifier.id} diagnostics are invalid.`);
    for (const diagnostic of document.diagnostics) {
      if (!isRecord(diagnostic) || typeof diagnostic.locator !== "string") {
        throw new Error(`Portable verifier ${verifier.id} diagnostic reference is invalid.`);
      }
      const sidecar = artifactsByPath.get(diagnostic.locator);
      if (sidecar?.kind !== "diagnostic" || sidecar.digest !== diagnostic.digest
          || sidecar.sizeBytes !== diagnostic.sizeBytes
          || sidecar.diagnosticSource?.verifierId !== verifier.id
          || sidecar.diagnosticSource?.stream !== diagnostic.stream) {
        throw new Error(`Portable verifier ${verifier.id} diagnostic reference is not bound to its sidecar.`);
      }
      referencedDiagnostics.add(sidecar.id);
    }
  }
  for (const diagnostic of manifest.artifacts.filter(({ kind }) => kind === "diagnostic")) {
    if (diagnostic.diagnosticSource === undefined
        || artifactsById.get(diagnostic.diagnosticSource.verifierId)?.kind !== "verifier"
        || !referencedDiagnostics.has(diagnostic.id)) {
      throw new Error(`Portable diagnostic ${diagnostic.id} is not referenced by its verifier.`);
    }
  }
}

function parseSanitizedArtifact(bytes: Buffer, mediaType: string): void {
  if (mediaType === "application/json") {
    parseJson(bytes, "Portable JSON evidence");
  } else if (mediaType === "application/x-ndjson") {
    const lines = decode(bytes, "Portable JSONL evidence").split(/\r?\n/gu).filter((line) => line.trim() !== "");
    if (lines.length === 0) throw new Error("Portable JSONL evidence is empty.");
    for (const line of lines) parseJson(Buffer.from(line), "Portable JSONL evidence record");
  } else {
    decode(bytes, "Portable text evidence");
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  const text = decode(bytes, label);
  assertNoDuplicateJsonKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
}

function assertSupportedPair(kind: RunBundleEvidenceDescriptor["kind"], mediaType: string): asserts kind is PortableKind {
  const allowed: Partial<Record<RunBundleEvidenceDescriptor["kind"], readonly string[]>> = {
    session: ["application/x-ndjson"],
    hook: ["application/x-ndjson"],
    telemetry: ["application/json"],
    workspace: ["text/x-diff"],
    verifier: ["application/json"],
    diagnostic: ["text/plain"],
    "capture-report": ["application/json"],
  };
  if (kind === "export-manifest") return;
  if (!allowed[kind]?.includes(mediaType)) throw new Error(`Artifact kind ${kind} has unsupported media type ${mediaType}.`);
}

function correlationProjection(manifest: RunManifest, salt: DigestString): PortableExportManifest["correlations"] {
  return {
    bundleId: rewrittenId("bundle", manifest.bundleId, salt),
    runId: rewrittenId("run", manifest.run.id, salt),
    attemptId: rewrittenId("attempt", manifest.attempt.id, salt),
    ...(manifest.run.native?.sessionId === undefined ? {} : { sessionId: rewrittenId("session", manifest.run.native.sessionId, salt) }),
    ...(manifest.run.native?.traceId === undefined ? {} : { traceId: rewrittenId("trace", manifest.run.native.traceId, salt) }),
  };
}

function correlationReplacements(
  manifest: RunManifest,
  projected: PortableExportManifest["correlations"],
): Map<string, string> {
  const replacements: Array<[string, string]> = [
    [manifest.bundleId, projected.bundleId],
    [manifest.run.id, projected.runId],
    [manifest.attempt.id, projected.attemptId],
  ];
  if (manifest.run.native?.sessionId !== undefined && projected.sessionId !== undefined) {
    replacements.push([manifest.run.native.sessionId, projected.sessionId]);
  }
  if (manifest.run.native?.traceId !== undefined && projected.traceId !== undefined) {
    replacements.push([manifest.run.native.traceId, projected.traceId]);
  }
  return new Map(replacements);
}

function sourceCorrelationValues(manifest: RunManifest): string[] {
  return [
    manifest.bundleId,
    manifest.run.id,
    manifest.attempt.id,
    ...(manifest.run.native?.sessionId === undefined ? [] : [manifest.run.native.sessionId]),
    ...(manifest.run.native?.traceId === undefined ? [] : [manifest.run.native.traceId]),
  ];
}

function rewrittenId(kind: string, value: string, salt: DigestString): string {
  return `${kind}-${createHash("sha256").update(`${salt}\0${value}`).digest("hex").slice(0, 24)}`;
}

function digestText(value: string): DigestString {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function policyRecord(policy: PortableExportPolicy): Record<string, unknown> {
  return {
    sharingClass: policy.sharingClass,
    maxArtifactBytes: policy.maxArtifactBytes,
    maxStringBytes: policy.maxStringBytes,
    sensitiveValueDigests: [...new Set(policy.sensitiveValues ?? [])]
      .sort()
      .map((value) => createHash("sha256").update(value).digest("hex")),
  };
}

function effectiveSensitiveValues(policy: PortableExportPolicy): string[] {
  const environment = Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && value.length >= 8
      && !["logname", "user", "username"].includes(normalizeFieldName(key)))
    .map(([, value]) => value!);
  return [...new Set([...(policy.sensitiveValues ?? []).filter((value) => value !== ""), ...environment])]
    .sort((left, right) => right.length - left.length);
}

function validatePolicy(policy: PortableExportPolicy): void {
  if (!(["partner", "public"] as const).includes(policy.sharingClass)) throw new Error("Portable export sharing class is invalid.");
  for (const [name, value] of [["artifact", policy.maxArtifactBytes], ["string", policy.maxStringBytes]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Portable export ${name} limit must be a positive safe integer.`);
  }
  if (policy.maxStringBytes > policy.maxArtifactBytes) throw new Error("Portable export string limit cannot exceed the artifact limit.");
}

function extensionFor(mediaType: string): string {
  return mediaType === "application/json" ? ".json"
    : mediaType === "application/x-ndjson" ? ".jsonl"
      : mediaType === "text/x-diff" ? ".patch" : ".txt";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function countOccurrences(value: string, search: string): number {
  if (search === "") return 0;
  let count = 0;
  for (let index = value.indexOf(search); index !== -1; index = value.indexOf(search, index + search.length)) count += 1;
  return count;
}

function increment(counts: Map<TransformationAction, number>, action: TransformationAction, count = 1): void {
  counts.set(action, (counts.get(action) ?? 0) + count);
}

function digestValue(value: DigestString): Digest {
  return { algorithm: "sha256", value: value.slice("sha256:".length) };
}

function digestString(value: Digest): DigestString {
  return `sha256:${value.value}`;
}

function decode(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function formatValidationErrors(errors: Array<{ artifact: string; field: string; message: string }>): string {
  return errors.map((error) => `${error.artifact} ${error.field}: ${error.message}`).join("\n");
}

function normalizeFieldName(value: string): string {
  return value.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}

function resetPatterns(): void {
  LOCAL_PATH.lastIndex = 0;
  for (const pattern of SECRET_PATTERNS) pattern.lastIndex = 0;
  for (const pattern of LOCAL_IDENTIFIER_PATTERNS) pattern.lastIndex = 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
