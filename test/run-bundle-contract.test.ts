import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/run-bundles");
const schemaId = "urn:ebo:schema:run-bundle:v1";
const schema = JSON.parse(readFileSync(resolve(repositoryRoot, "schemas/run-bundles/v1.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });

ajv.addSchema(schema);

type JsonObject = Record<string, unknown>;

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function assertJsonMedia(mediaType: unknown, artifact: Buffer): number {
  const content = new TextDecoder("utf-8", { fatal: true }).decode(artifact);

  if (mediaType === "application/json") {
    JSON.parse(content);
    return 1;
  }
  if (mediaType === "application/x-ndjson") {
    let records = 0;

    for (const line of content.split(/\r?\n/)) {
      if (line.trim() !== "") {
        JSON.parse(line);
        records += 1;
      }
    }
    return records;
  }

  return 0;
}

function assertNativeEvidenceRecords(kind: unknown, records: number): void {
  if (kind === "session" || kind === "hook" || kind === "telemetry") {
    assert.ok(records > 0, "retained native evidence must contain a record");
  }
}

function validator(reference: string) {
  const validate = ajv.getSchema(reference);

  assert.ok(validate, `missing validator for ${reference}`);
  return validate;
}

function schemaErrors(reference: string, value: unknown): string[] {
  const validate = validator(reference);

  return validate(value)
    ? []
    : (validate.errors ?? []).map((error: { instancePath: string; message?: string }) =>
      `${error.instancePath} ${error.message}`,
    );
}

function contractErrors(manifest: JsonObject, artifacts = new Map<string, JsonObject>()): string[] {
  const errors = schemaErrors(schemaId, manifest);
  if (errors.length > 0) {
    return errors;
  }
  const evidence = manifest.evidence;

  if (!Array.isArray(evidence)) {
    return errors;
  }

  const ids = evidence.map((descriptor) => (descriptor as JsonObject).id);

  if (new Set(ids).size !== ids.length) {
    errors.push("/evidence contains duplicate artifact IDs");
  }

  const descriptorByPath = new Map<string, JsonObject>();

  for (const descriptor of evidence as JsonObject[]) {
    const relativePath = String(descriptor.relativePath);
    const existingDescriptor = descriptorByPath.get(relativePath.toLowerCase());

    if (existingDescriptor !== undefined) {
      errors.push(`/evidence reuses ${relativePath}`);
    }
    descriptorByPath.set(relativePath.toLowerCase(), descriptor);
  }
  for (const relativePath of descriptorByPath.keys()) {
    if (relativePath === "manifest.json" || relativePath.startsWith("manifest.json/")) {
      errors.push("/evidence cannot reuse the containing manifest path");
    }
    for (let boundary = relativePath.lastIndexOf("/"); boundary > 0; boundary = relativePath.lastIndexOf("/", boundary - 1)) {
      if (descriptorByPath.has(relativePath.slice(0, boundary))) {
        errors.push(`/evidence path ${relativePath} collides with an artifact ancestor`);
      }
    }
  }

  const attempt = manifest.attempt as JsonObject;

  if (attempt.retryOf === attempt.id) {
    errors.push("/attempt/retryOf cannot reference the current attempt");
  }

  const declaredSessionId = (((manifest.run as JsonObject).native as JsonObject | undefined)?.sessionId);
  const declaredTraceId = (((manifest.run as JsonObject).native as JsonObject | undefined)?.traceId);
  const sessionDescriptors = (evidence as JsonObject[]).filter((descriptor) => descriptor.kind === "session");
  const telemetryDescriptors = (evidence as JsonObject[]).filter((descriptor) => descriptor.kind === "telemetry");
  const verifierStatuses: unknown[] = [];
  const verifierWorkspaceBindings: JsonObject[] = [];

  if (declaredSessionId !== undefined && !sessionDescriptors.some((descriptor) =>
        ((descriptor.nativeReference as JsonObject | undefined)?.id) === declaredSessionId,
  )) {
    errors.push("/run/native/sessionId does not match retained session evidence");
  }
  if (declaredTraceId !== undefined && !telemetryDescriptors.some((descriptor) =>
        ((descriptor.nativeReference as JsonObject | undefined)?.id) === declaredTraceId,
  )) {
    errors.push("/run/native/traceId does not match retained telemetry evidence");
  }

  const runtime = (manifest.run as JsonObject).runtime;
  const harness = (manifest.run as JsonObject).harness as JsonObject;
  if (Array.isArray(runtime)) {
    const runtimeIds = runtime.map((component) => {
      const value = component as JsonObject;
      return JSON.stringify([value.source, value.name, value.version]);
    });
    if (new Set(runtimeIds).size !== runtimeIds.length) {
      errors.push("/run/runtime contains duplicate components");
    }
    if (!runtime.some((component) => {
      const value = component as JsonObject;
      return value.version === harness.version && (value.name === harness.id || value.source === harness.id);
    })) {
      errors.push("/run/harness is not represented by its runtime composition");
    }
  }

  for (const descriptor of evidence as JsonObject[]) {
    if (descriptor.kind !== "capture-report" && descriptor.kind !== "verifier") {
      continue;
    }

    const report = artifacts.get(String(descriptor.id));

    if (report === undefined) {
      continue;
    }
    const artifactSchema = descriptor.kind === "verifier"
      ? `${schemaId}#/$defs/verifierResult`
      : `${schemaId}#/$defs/captureReport`;
    const artifactErrors = schemaErrors(artifactSchema, report);
    if (artifactErrors.length > 0) {
      errors.push(`/evidence/${String(descriptor.id)} does not satisfy its artifact schema`);
      continue;
    }
    if (report.bundleId !== manifest.bundleId) {
      errors.push(`/evidence/${String(descriptor.id)} bundle ID does not match the manifest`);
    }

    if (descriptor.kind === "verifier") {
      const assertionIds = (report.assertions as JsonObject[]).map((assertion) => assertion.id);

      if (new Set(assertionIds).size !== assertionIds.length) {
        errors.push(`/evidence/${String(descriptor.id)} contains duplicate verifier assertion IDs`);
      }
      const terminal = manifest.terminal as JsonObject;
      if (terminal.state === "completed" && report.status !== "passed") {
        errors.push(`/evidence/${String(descriptor.id)} contradicts the manifest terminal outcome`);
      }
      verifierStatuses.push(report.status);
      if (report.status === "passed" || report.status === "failed") {
        verifierWorkspaceBindings.push(report.workspace as JsonObject);
      }
      continue;
    }

    const capabilities = report.capabilities as JsonObject;
    const missingEvidenceIdentities = new Set<string>();
    for (const missingEvidence of report.missingEvidence as JsonObject[]) {
      const identity = JSON.stringify([
        missingEvidence.kind,
        missingEvidence.reason,
        [...(missingEvidence.affects as string[])].sort(),
      ]);
      if (missingEvidenceIdentities.has(identity)) {
        errors.push("/capture-report/missingEvidence contains equivalent records");
      }
      missingEvidenceIdentities.add(identity);
    }
    const missingEffects = new Set(
      (report.missingEvidence as JsonObject[]).flatMap((entry) => entry.affects as string[]),
    );
    for (const [capability, authority] of Object.entries({
      semantic: "semantic",
      timingResource: "timing-resource",
      outcome: "outcome",
    })) {
      if ((capabilities[capability] as JsonObject).status === "available" &&
          !(evidence as JsonObject[]).some((item) => item.authority === authority)) {
        errors.push(`/capture-report/${capability} is available without ${authority} evidence`);
      }
      if ((capabilities[capability] as JsonObject).status === "available" && missingEffects.has(authority)) {
        errors.push(`/capture-report/${capability} is available but declared missing`);
      }
    }
  }

  const terminal = manifest.terminal as JsonObject;
  if ((terminal.state === "completed" && !verifierStatuses.includes("passed")) ||
      (terminal.state === "failed" && terminal.failureClass === "task" && !verifierStatuses.includes("failed"))) {
    errors.push("/terminal outcome requires a matching retained verifier result");
  }
  if ((terminal.state === "completed" || (terminal.state === "failed" && terminal.failureClass === "task"))
      && !(evidence as JsonObject[]).some((descriptor) => descriptor.kind === "workspace")) {
    errors.push("/terminal outcome requires retained workspace evidence");
  }
  const captureReport = [...artifacts.entries()]
    .find(([artifactId]) => (evidence as JsonObject[]).some((descriptor) =>
      descriptor.id === artifactId && descriptor.kind === "capture-report",
    ))?.[1];
  const outcomeStatus = (captureReport?.capabilities as JsonObject | undefined)?.outcome as JsonObject | undefined;
  const workspaceDescriptors = (evidence as JsonObject[]).filter((descriptor) => descriptor.kind === "workspace");
  const hasOutcomeWorkspace = verifierWorkspaceBindings.some((binding) => workspaceDescriptors.some((descriptor) =>
    descriptor.id === binding.artifactId && JSON.stringify(descriptor.digest) === JSON.stringify(binding.digest),
  ));
  if (outcomeStatus?.status === "available" && !hasOutcomeWorkspace) {
    errors.push("/capture-report/outcome requires retained workspace and an executed verifier");
  }
  if (hasOutcomeWorkspace && outcomeStatus?.status !== "available") {
    errors.push("/capture-report/outcome must be available when retained verifier evidence has an outcome");
  }

  return errors;
}

function assertContractValid(manifest: JsonObject, artifacts?: Map<string, JsonObject>): void {
  assert.deepEqual(contractErrors(manifest, artifacts), []);
}

function assertContractInvalid(manifest: JsonObject, artifacts?: Map<string, JsonObject>): void {
  assert.notDeepEqual(contractErrors(manifest, artifacts), []);
}

function assertExportSafe(manifest: JsonObject, exportManifest: JsonObject): void {
  assert.equal(exportManifest.bundleId, manifest.bundleId, "export manifest bundle ID must match the containing bundle");
  if (!["ready", "exported"].includes(String(exportManifest.status))) {
    return;
  }

  const evidenceById = new Map(
    (manifest.evidence as JsonObject[]).map((descriptor) => [descriptor.id, descriptor]),
  );
  let hasNonExportArtifact = false;

  for (const artifactId of exportManifest.artifactIds as string[]) {
    const descriptor = evidenceById.get(artifactId);

    assert.ok(descriptor, `export references unknown artifact ${artifactId}`);
    assert.notEqual(descriptor.sharingClass, "unknown", "ready or exported manifests cannot include unknown artifacts");
    assert.equal(
      descriptor.sharingClass,
      exportManifest.sharingClass,
      `${String(exportManifest.sharingClass)} export cannot include ${artifactId} with ${String(descriptor.sharingClass)} sharing class`,
    );
    if (["partner", "public"].includes(String(exportManifest.sharingClass))) {
      assertSanitizedProvenance(descriptor, evidenceById, String(exportManifest.sharingClass));
    }
    hasNonExportArtifact ||= descriptor.kind !== "export-manifest";
  }
  assert.ok(hasNonExportArtifact, "ready or exported manifests must include non-export evidence");
}

function assertSanitizedProvenance(
  descriptor: JsonObject,
  evidenceById: ReadonlyMap<unknown, JsonObject>,
  sharingClass: string,
): void {
  const seen = new Set([String(descriptor.id)]);
  let current = descriptor;

  while (true) {
    const sanitizedFrom = current.sanitizedFrom as JsonObject | undefined;
    assert.ok(sanitizedFrom, `${sharingClass} export requires sanitized artifact provenance`);
    const sourceId = String(sanitizedFrom.artifactId);
    assert.ok(!seen.has(sourceId), "sanitized artifact provenance cannot contain a cycle");
    const sourceDescriptor = evidenceById.get(sourceId);
    assert.ok(sourceDescriptor, "sanitized artifact must reference retained source evidence");
    assert.equal(sourceDescriptor.kind, current.kind, "sanitized provenance must preserve evidence kind");
    assert.equal(sourceDescriptor.authority, current.authority, "sanitized provenance must preserve evidence authority");
    assert.deepEqual(sourceDescriptor.nativeReference ?? null, current.nativeReference ?? null, "sanitized provenance must preserve native reference");
    assert.deepEqual(sourceDescriptor.digest, sanitizedFrom.digest, "sanitized provenance must bind the source digest");
    assert.notEqual(sourceDescriptor.relativePath, current.relativePath, "sanitized artifact must have a distinct retained path");
    seen.add(sourceId);
    if (sourceDescriptor.sanitizedFrom === undefined) return;
    current = sourceDescriptor;
  }
}

test("validates retained run-bundle fixtures and their references", () => {
  for (const fixture of ["complete", "task-failed", "interrupted", "telemetry-incomplete"]) {
    const bundleRoot = resolve(fixtureRoot, fixture);
    const manifest = readJson(resolve(bundleRoot, "manifest.json"));
    const artifacts = new Map<string, JsonObject>();

    for (const descriptor of manifest.evidence as JsonObject[]) {
      const artifactPath = resolve(bundleRoot, String(descriptor.relativePath));
      const artifact = readFileSync(artifactPath);

      assert.equal(artifactPath.startsWith(`${bundleRoot}${sep}`), true);
      assert.equal(statSync(artifactPath).isFile(), true);
      assert.equal(descriptor.sizeBytes, artifact.length);
      assert.equal(descriptor.digest, `sha256:${createHash("sha256").update(artifact).digest("hex")}`);
      assertNativeEvidenceRecords(descriptor.kind, assertJsonMedia(descriptor.mediaType, artifact));

      if (descriptor.kind === "verifier") {
        const verifierResult = readJson(artifactPath);

        assert.deepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, verifierResult), []);
        artifacts.set(String(descriptor.id), verifierResult);
      }
      if (descriptor.kind === "capture-report") {
        const captureReport = readJson(artifactPath);

        assert.deepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, captureReport), []);
        artifacts.set(String(descriptor.id), captureReport);
      }
      if (descriptor.kind === "export-manifest") {
        const exportManifest = readJson(artifactPath);

        assert.deepEqual(schemaErrors(`${schemaId}#/$defs/exportManifest`, exportManifest), []);
        assertExportSafe(manifest, exportManifest);
      }
      if (descriptor.kind === "workspace") {
        const workspaceRoot = mkdtempSync(join(tmpdir(), "ebo-workspace-patch-"));

        try {
          const result = spawnSync("git", ["apply", "--check", artifactPath], { cwd: workspaceRoot, encoding: "utf8" });

          assert.equal(result.status, 0, result.stderr);
        } finally {
          rmSync(workspaceRoot, { force: true, recursive: true });
        }
      }
    }

    assertContractValid(manifest, artifacts);
  }
});

test("blocks a ready partner export that lists restricted source artifacts", () => {
  const bundleRoot = resolve(fixtureRoot, "complete");
  const manifest = readJson(resolve(bundleRoot, "manifest.json"));
  const exportManifest = readJson(resolve(bundleRoot, "export/manifest.json"));
  const readyExport = structuredClone(exportManifest);

  assert.equal(exportManifest.status, "blocked");
  readyExport.status = "ready";
  assert.throws(() => assertExportSafe(manifest, readyExport));

  const publicUnknown = structuredClone(readyExport);
  publicUnknown.sharingClass = "public";
  publicUnknown.artifactIds = ["unknown-artifact"];
  assert.throws(() => assertExportSafe(manifest, publicUnknown));

  const publicRestricted = structuredClone(readyExport);
  publicRestricted.sharingClass = "public";
  publicRestricted.artifactIds = ["session"];
  assert.throws(() => assertExportSafe(manifest, publicRestricted));

  const publicManifest = structuredClone(manifest);
  (publicManifest.evidence as JsonObject[])[0].sharingClass = "public";
  assert.throws(() => assertExportSafe(publicManifest, publicRestricted), /sanitized artifact provenance/);

  const sanitizedPublicManifest = structuredClone(manifest);
  const sourceSession = (sanitizedPublicManifest.evidence as JsonObject[])[0]!;
  (sanitizedPublicManifest.evidence as JsonObject[]).push({
    ...sourceSession,
    id: "sanitized-session",
    source: "ebo-sanitizer",
    sharingClass: "public",
    relativePath: "sanitized/session.jsonl",
    sanitizedFrom: { artifactId: sourceSession.id, digest: sourceSession.digest },
  });
  const sanitizedPublicExport = structuredClone(publicRestricted);
  sanitizedPublicExport.artifactIds = ["sanitized-session"];
  assert.deepEqual(schemaErrors(schemaId, sanitizedPublicManifest), []);
  assert.doesNotThrow(() => assertExportSafe(sanitizedPublicManifest, sanitizedPublicExport));

  const reclassifiedPublicManifest = structuredClone(sanitizedPublicManifest);
  const reclassifiedSession = (reclassifiedPublicManifest.evidence as JsonObject[]).find(
    (descriptor) => descriptor.id === "sanitized-session",
  )!;
  const workspaceSource = (reclassifiedPublicManifest.evidence as JsonObject[]).find(
    (descriptor) => descriptor.kind === "workspace",
  )!;
  reclassifiedSession.sanitizedFrom = { artifactId: workspaceSource.id, digest: workspaceSource.digest };
  assert.throws(() => assertExportSafe(reclassifiedPublicManifest, sanitizedPublicExport), /preserve evidence kind/);

  const reidentifiedPublicManifest = structuredClone(sanitizedPublicManifest);
  const reidentifiedSession = (reidentifiedPublicManifest.evidence as JsonObject[]).find(
    (descriptor) => descriptor.id === "sanitized-session",
  )!;
  reidentifiedSession.nativeReference = { type: "session", id: "other-session" };
  assert.throws(() => assertExportSafe(reidentifiedPublicManifest, sanitizedPublicExport), /preserve native reference/);

  const cyclicPublicManifest = structuredClone(manifest);
  const cyclicSource = (cyclicPublicManifest.evidence as JsonObject[])[0]!;
  (cyclicPublicManifest.evidence as JsonObject[]).push(
    {
      ...cyclicSource,
      id: "sanitized-a",
      source: "ebo-sanitizer",
      sharingClass: "public",
      relativePath: "sanitized/a.jsonl",
      sanitizedFrom: { artifactId: "sanitized-b", digest: cyclicSource.digest },
    },
    {
      ...cyclicSource,
      id: "sanitized-b",
      source: "ebo-sanitizer",
      sharingClass: "public",
      relativePath: "sanitized/b.jsonl",
      sanitizedFrom: { artifactId: "sanitized-a", digest: cyclicSource.digest },
    },
  );
  const cyclicPublicExport = structuredClone(publicRestricted);
  cyclicPublicExport.artifactIds = ["sanitized-a"];
  assert.throws(() => assertExportSafe(cyclicPublicManifest, cyclicPublicExport), /provenance cannot contain a cycle/);

  const emptyReadyExport = structuredClone(readyExport);
  emptyReadyExport.artifactIds = [];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/exportManifest`, emptyReadyExport), []);

  const unknownArtifactManifest = structuredClone(manifest);
  (unknownArtifactManifest.evidence as JsonObject[])[0].sharingClass = "unknown";
  const unknownArtifactExport = structuredClone(readyExport);
  unknownArtifactExport.sharingClass = "restricted";
  unknownArtifactExport.artifactIds = ["session"];
  assert.throws(() => assertExportSafe(unknownArtifactManifest, unknownArtifactExport), /unknown artifacts/);

  const selfReferentialExport = structuredClone(readyExport);
  selfReferentialExport.sharingClass = "internal";
  selfReferentialExport.artifactIds = ["export-manifest"];
  assert.throws(() => assertExportSafe(manifest, selfReferentialExport));
});

test("native JSON media is structurally inspectable", () => {
  assert.doesNotThrow(() => assertJsonMedia("application/x-ndjson", Buffer.from('{"event":"tool"}\n')));
  assert.throws(() => assertJsonMedia("application/json", Buffer.from("not json")));
  assert.throws(() => assertJsonMedia("application/x-ndjson", Buffer.from('{"event":"tool"}\nnot json\n')));
  assert.throws(() => assertJsonMedia("application/json", Buffer.from([0x22, 0xff, 0x22])));
  assert.throws(() => assertNativeEvidenceRecords("session", assertJsonMedia("application/x-ndjson", Buffer.from(" \n"))));
  assert.throws(() => assertNativeEvidenceRecords("hook", assertJsonMedia("application/x-ndjson", Buffer.from(" \n"))));
  assert.throws(() => assertNativeEvidenceRecords("telemetry", assertJsonMedia("application/x-ndjson", Buffer.from(" \n"))));
});

test("rejects contradictory and incomplete contract records", () => {
  const complete = readJson(resolve(fixtureRoot, "complete/manifest.json"));
  const completeCaptureReport = readJson(resolve(fixtureRoot, "complete/capture-report.json"));
  const completeVerifier = readJson(resolve(fixtureRoot, "complete/verifier.json"));
  const completeArtifacts = new Map([
    ["capture-report", completeCaptureReport],
    ["verifier", completeVerifier],
  ]);
  const telemetryReport = readJson(resolve(fixtureRoot, "telemetry-incomplete/capture-report.json"));
  const interrupted = readJson(resolve(fixtureRoot, "interrupted/manifest.json"));
  const interruptedReport = readJson(resolve(fixtureRoot, "interrupted/capture-report.json"));
  const interruptedArtifacts = new Map([["capture-report", interruptedReport]]);
  const taskFailed = readJson(resolve(fixtureRoot, "task-failed/manifest.json"));
  const taskFailedArtifacts = new Map([
    ["capture-report", readJson(resolve(fixtureRoot, "task-failed/capture-report.json"))],
    ["verifier", readJson(resolve(fixtureRoot, "task-failed/verifier.json"))],
  ]);
  const verifier = readJson(resolve(fixtureRoot, "complete/verifier.json"));

  const invalidTerminal = structuredClone(complete);
  invalidTerminal.terminal = { state: "completed", failureClass: "task", stopReason: "none" };
  assertContractInvalid(invalidTerminal);

  const infrastructureFailed = structuredClone(interrupted);
  infrastructureFailed.terminal = { state: "failed", failureClass: "infrastructure", stopReason: "none" };
  assertContractValid(infrastructureFailed, interruptedArtifacts);

  const contradictoryInfrastructureFailure = structuredClone(infrastructureFailed);
  contradictoryInfrastructureFailure.terminal = { state: "failed", failureClass: "task", stopReason: "none" };
  assertContractInvalid(contradictoryInfrastructureFailure, interruptedArtifacts);

  const verifierError = structuredClone(completeVerifier);
  verifierError.status = "error";
  verifierError.assertions = [];
  delete verifierError.exitCode;
  assert.deepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, verifierError), []);
  const infrastructureError = structuredClone(infrastructureFailed);
  const verifierDescriptor = (complete.evidence as JsonObject[]).find((descriptor) => descriptor.kind === "verifier")!;
  (infrastructureError.evidence as JsonObject[]).push({ ...verifierDescriptor });
  const interruptedVerifierError = structuredClone(verifierError);
  interruptedVerifierError.bundleId = infrastructureError.bundleId;
  assertContractValid(infrastructureError, new Map([
    ["capture-report", interruptedReport],
    ["verifier", interruptedVerifierError],
  ]));

  const executedVerifierWithoutWorkspace = structuredClone(infrastructureFailed);
  (executedVerifierWithoutWorkspace.evidence as JsonObject[]).push({ ...verifierDescriptor });
  const interruptedPassedVerifier = structuredClone(completeVerifier);
  interruptedPassedVerifier.bundleId = executedVerifierWithoutWorkspace.bundleId;
  assertContractValid(executedVerifierWithoutWorkspace, new Map([
    ["capture-report", interruptedReport],
    ["verifier", interruptedPassedVerifier],
  ]));

  const errorAsOutcome = structuredClone(complete);
  errorAsOutcome.terminal = { state: "failed", failureClass: "infrastructure", stopReason: "none" };
  assertContractInvalid(errorAsOutcome, new Map([
    ["capture-report", completeCaptureReport],
    ["verifier", verifierError],
  ]));

  const verifierWithOtherWorkspace = structuredClone(completeVerifier);
  (verifierWithOtherWorkspace.workspace as JsonObject).digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  assertContractInvalid(complete, new Map([
    ["capture-report", completeCaptureReport],
    ["verifier", verifierWithOtherWorkspace],
  ]));

  const firstAttemptRetry = structuredClone(complete);
  (firstAttemptRetry.attempt as JsonObject).retryOf = "prior-attempt";
  assertContractInvalid(firstAttemptRetry, completeArtifacts);

  const unlinkedRetry = structuredClone(complete);
  (unlinkedRetry.attempt as JsonObject).number = 2;
  assertContractInvalid(unlinkedRetry, completeArtifacts);

  const reorderedMissingEvidence = structuredClone(interruptedReport);
  (reorderedMissingEvidence.capabilities as JsonObject).outcome = { status: "not-checked" };
  reorderedMissingEvidence.missingEvidence = [
    { kind: "outcome-and-timing", reason: "not-checked", affects: ["timing-resource", "outcome"] },
    { kind: "outcome-and-timing", reason: "not-checked", affects: ["outcome", "timing-resource"] },
  ];
  assert.deepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, reorderedMissingEvidence), []);
  assertContractInvalid(interrupted, new Map([["capture-report", reorderedMissingEvidence]]));

  assert.doesNotThrow(() => assertContractInvalid({ evidence: [] }));

  const invalidPath = structuredClone(complete);
  (invalidPath.evidence as JsonObject[])[0].relativePath = "../outside.json";
  assertContractInvalid(invalidPath);

  const manifestPathAlias = structuredClone(complete);
  (manifestPathAlias.evidence as JsonObject[])[0].relativePath = "manifest.json";
  assertContractInvalid(manifestPathAlias, completeArtifacts);

  const manifestDescendantAlias = structuredClone(complete);
  (manifestDescendantAlias.evidence as JsonObject[])[0].relativePath = "manifest.json/session.jsonl";
  assertContractInvalid(manifestDescendantAlias, completeArtifacts);

  const ancestorPathAlias = structuredClone(complete);
  (ancestorPathAlias.evidence as JsonObject[])[0].relativePath = "logs";
  (ancestorPathAlias.evidence as JsonObject[])[1].relativePath = "logs/session.jsonl";
  assertContractInvalid(ancestorPathAlias, completeArtifacts);

  const invalidAuthority = structuredClone(complete);
  (invalidAuthority.evidence as JsonObject[])[0].authority = "outcome";
  assertContractInvalid(invalidAuthority);

  const duplicateArtifact = structuredClone(complete);
  (duplicateArtifact.evidence as JsonObject[])[1].id = (duplicateArtifact.evidence as JsonObject[])[0].id;
  assertContractInvalid(duplicateArtifact, completeArtifacts);

  const sharingClassAlias = structuredClone(complete);
  (sharingClassAlias.evidence as JsonObject[]).push({
    ...(sharingClassAlias.evidence as JsonObject[])[0],
    id: "partner-session-alias",
    sharingClass: "partner",
  });
  assertContractInvalid(sharingClassAlias, completeArtifacts);

  const authorityAlias = structuredClone(complete);
  (authorityAlias.evidence as JsonObject[]).push({
    ...(authorityAlias.evidence as JsonObject[])[0],
    id: "outcome-session-alias",
    kind: "workspace",
    authority: "outcome",
  });
  assertContractInvalid(authorityAlias, completeArtifacts);

  const caseFoldedAlias = structuredClone(complete);
  (caseFoldedAlias.evidence as JsonObject[]).push({
    ...(caseFoldedAlias.evidence as JsonObject[])[0],
    id: "case-folded-session-alias",
    relativePath: "SESSION.jsonl",
  });
  assertContractInvalid(caseFoldedAlias, completeArtifacts);

  const nativeIdentityAlias = structuredClone(complete);
  const sessionDescriptor = (nativeIdentityAlias.evidence as JsonObject[]).find((descriptor) => descriptor.kind === "session")!;
  (nativeIdentityAlias.evidence as JsonObject[]).push({
    ...sessionDescriptor,
    id: "session-native-alias",
    nativeReference: { type: "session", id: "session-alias-1" },
  });
  ((nativeIdentityAlias.run as JsonObject).native as JsonObject).sessionId = "session-alias-1";
  assertContractInvalid(nativeIdentityAlias, completeArtifacts);

  const missingCaptureReport = structuredClone(complete);
  missingCaptureReport.evidence = (missingCaptureReport.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind !== "capture-report",
  );
  assertContractInvalid(missingCaptureReport, completeArtifacts);

  const duplicateCaptureReport = structuredClone(complete);
  const captureReport = (duplicateCaptureReport.evidence as JsonObject[]).find(
    (descriptor) => descriptor.kind === "capture-report",
  );
  (duplicateCaptureReport.evidence as JsonObject[]).push({ ...captureReport, id: "second-capture-report" });
  assertContractInvalid(duplicateCaptureReport, completeArtifacts);

  const serverRuntime = structuredClone(complete);
  (serverRuntime.run as JsonObject).harness = { id: "openhands-agent-server", version: "1.0.0" };
  (serverRuntime.run as JsonObject).runtime = [
    { source: "openhands-agent-server", name: "agent-server", version: "1.0.0" },
  ];
  assertContractValid(serverRuntime, completeArtifacts);

  const stoppedWithUnexecutedVerifier = structuredClone(complete);
  stoppedWithUnexecutedVerifier.terminal = { state: "stopped", failureClass: "none", stopReason: "budget" };
  const unexecutedVerifier = structuredClone(completeVerifier);
  unexecutedVerifier.status = "not-run";
  unexecutedVerifier.assertions = [{ id: "example-check", status: "not-run" }];
  delete unexecutedVerifier.exitCode;
  assert.deepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, unexecutedVerifier), []);
  assertContractInvalid(stoppedWithUnexecutedVerifier, new Map([
    ["capture-report", completeCaptureReport],
    ["verifier", unexecutedVerifier],
  ]));

  const mismatchedHarnessRuntime = structuredClone(complete);
  (mismatchedHarnessRuntime.run as JsonObject).runtime = [
    { source: "openhands-agent-server", name: "agent-server", version: "1.0.0" },
  ];
  assertContractInvalid(mismatchedHarnessRuntime, completeArtifacts);

  const selfRetry = structuredClone(complete);
  (selfRetry.attempt as JsonObject).retryOf = (selfRetry.attempt as JsonObject).id;
  assertContractInvalid(selfRetry, completeArtifacts);

  const mismatchedNativeTrace = structuredClone(complete);
  ((mismatchedNativeTrace.evidence as JsonObject[]).find((descriptor) => descriptor.kind === "telemetry")!.nativeReference as JsonObject).id = "other-trace";
  assertContractInvalid(mismatchedNativeTrace, completeArtifacts);

  const missingNativeTrace = structuredClone(taskFailed);
  ((missingNativeTrace.run as JsonObject).native as JsonObject).traceId = "trace-task-failed-1";
  assertContractInvalid(missingNativeTrace, taskFailedArtifacts);

  const duplicateRuntime = structuredClone(complete);
  ((duplicateRuntime.run as JsonObject).runtime as JsonObject[]).push({
    ...((duplicateRuntime.run as JsonObject).runtime as JsonObject[])[0],
  });
  assertContractInvalid(duplicateRuntime, completeArtifacts);

  const distinctDelimiterRuntime = structuredClone(complete);
  (distinctDelimiterRuntime.run as JsonObject).harness = { id: "a\u0000b", version: "d" };
  (distinctDelimiterRuntime.run as JsonObject).runtime = [
    { source: "a\u0000b", name: "c", version: "d" },
    { source: "a", name: "b\u0000c", version: "d" },
  ];
  assertContractValid(distinctDelimiterRuntime, completeArtifacts);

  const mismatchedCaptureReport = new Map(completeArtifacts);
  mismatchedCaptureReport.set("capture-report", {
    ...completeCaptureReport,
    bundleId: "other-bundle",
  });
  assertContractInvalid(complete, mismatchedCaptureReport);

  const mismatchedVerifier = new Map(completeArtifacts);
  mismatchedVerifier.set("verifier", { ...completeVerifier, bundleId: "other-bundle" });
  assertContractInvalid(complete, mismatchedVerifier);

  const completedWithFailedVerifier = new Map(completeArtifacts);
  completedWithFailedVerifier.set("verifier", {
    ...completeVerifier,
    status: "failed",
    assertions: [{ id: "example-check", status: "failed" }],
  });
  assertContractInvalid(complete, completedWithFailedVerifier);

  const taskFailedWithPassingVerifier = structuredClone(taskFailed);
  const failedVerifierDescriptor = (taskFailedWithPassingVerifier.evidence as JsonObject[]).find(
    (descriptor) => descriptor.kind === "verifier",
  )!;
  (taskFailedWithPassingVerifier.evidence as JsonObject[]).push({
    ...failedVerifierDescriptor,
    id: "passing-verifier",
    relativePath: "passing-verifier.json",
  });
  const taskFailedWithPassingArtifacts = new Map(taskFailedArtifacts);
  taskFailedWithPassingArtifacts.set("passing-verifier", {
    ...completeVerifier,
    bundleId: taskFailed.bundleId,
  });
  assertContractValid(taskFailedWithPassingVerifier, taskFailedWithPassingArtifacts);

  const blockedExportWithOtherBundle = readJson(resolve(fixtureRoot, "complete/export/manifest.json"));
  blockedExportWithOtherBundle.bundleId = "other-bundle";
  assert.throws(() => assertExportSafe(complete, blockedExportWithOtherBundle));

  const duplicateVerifierAssertion = new Map(completeArtifacts);
  duplicateVerifierAssertion.set("verifier", {
    ...completeVerifier,
    status: "failed",
    assertions: [
      ...completeVerifier.assertions as JsonObject[],
      { id: "example-check", status: "failed" },
    ],
  });
  assertContractInvalid(complete, duplicateVerifierAssertion);

  const qualifiedWithoutEvidence = structuredClone(complete);
  qualifiedWithoutEvidence.evidence = (qualifiedWithoutEvidence.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind === "capture-report",
  );
  assertContractInvalid(qualifiedWithoutEvidence, completeArtifacts);

  const completedWithoutVerifier = structuredClone(complete);
  completedWithoutVerifier.evidence = (completedWithoutVerifier.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind !== "verifier",
  );
  assertContractInvalid(completedWithoutVerifier, completeArtifacts);

  const taskFailedWithoutVerifier = structuredClone(taskFailed);
  taskFailedWithoutVerifier.evidence = (taskFailedWithoutVerifier.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind !== "verifier",
  );
  assertContractInvalid(taskFailedWithoutVerifier, taskFailedArtifacts);

  const mismatchedNativeSession = structuredClone(complete);
  ((mismatchedNativeSession.run as JsonObject).native as JsonObject).sessionId = "other-session";
  assertContractInvalid(mismatchedNativeSession, completeArtifacts);

  const missingNativeSession = structuredClone(complete);
  missingNativeSession.evidence = (missingNativeSession.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind !== "session",
  );
  assertContractInvalid(missingNativeSession, completeArtifacts);

  const trailingPeriodPath = structuredClone(complete);
  (trailingPeriodPath.evidence as JsonObject[])[0].relativePath = "session.jsonl.";
  assertContractInvalid(trailingPeriodPath, completeArtifacts);

  const deviceNamePath = structuredClone(complete);
  (deviceNamePath.evidence as JsonObject[])[0].relativePath = "NUL.json";
  assertContractInvalid(deviceNamePath, completeArtifacts);

  const missingWorkspace = structuredClone(complete);
  missingWorkspace.evidence = (missingWorkspace.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind !== "workspace",
  );
  assertContractInvalid(missingWorkspace, completeArtifacts);

  const missingSemanticReason = structuredClone(telemetryReport);
  ((missingSemanticReason.capabilities as JsonObject).semantic as JsonObject).status = "missing";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, missingSemanticReason), []);

  const qualifiedTelemetryGap = structuredClone(telemetryReport);
  qualifiedTelemetryGap.qualification = "qualified";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, qualifiedTelemetryGap), []);

  const incompleteFullyQualified = structuredClone(taskFailedArtifacts.get("capture-report")!);
  incompleteFullyQualified.qualification = "incomplete";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, incompleteFullyQualified), []);

  const incompleteUnsupportedSemantic = structuredClone(completeCaptureReport);
  incompleteUnsupportedSemantic.qualification = "incomplete";
  (incompleteUnsupportedSemantic.capabilities as JsonObject).semantic = { status: "unsupported" };
  incompleteUnsupportedSemantic.missingEvidence = [{ kind: "semantic-events", reason: "unsupported", affects: ["semantic"] }];
  assert.deepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, incompleteUnsupportedSemantic), []);

  const incompleteUnsupportedOutcome = structuredClone(completeCaptureReport);
  incompleteUnsupportedOutcome.qualification = "incomplete";
  (incompleteUnsupportedOutcome.capabilities as JsonObject).outcome = { status: "unsupported" };
  incompleteUnsupportedOutcome.missingEvidence = [{ kind: "outcome-verifier", reason: "unsupported", affects: ["outcome"] }];
  assert.deepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, incompleteUnsupportedOutcome), []);

  const qualifiedUnsupportedTiming = structuredClone(completeCaptureReport);
  (qualifiedUnsupportedTiming.capabilities as JsonObject).timingResource = { status: "unsupported" };
  qualifiedUnsupportedTiming.missingEvidence = [{ kind: "telemetry", reason: "unsupported", affects: ["timing-resource"] }];
  assert.deepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, qualifiedUnsupportedTiming), []);

  const unsupportedReasonWithMissingStatus = structuredClone(telemetryReport);
  (unsupportedReasonWithMissingStatus.missingEvidence as JsonObject[])[0].reason = "unsupported";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, unsupportedReasonWithMissingStatus), []);

  const unsupportedStatusWithoutReason = structuredClone(telemetryReport);
  ((unsupportedStatusWithoutReason.capabilities as JsonObject).timingResource as JsonObject).status = "unsupported";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, unsupportedStatusWithoutReason), []);

  const notCheckedReasonWithMissingStatus = structuredClone(interruptedReport);
  (notCheckedReasonWithMissingStatus.missingEvidence as JsonObject[])[0].reason = "not-emitted";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, notCheckedReasonWithMissingStatus), []);

  const notCheckedStatusWithoutReason = structuredClone(interruptedReport);
  ((notCheckedStatusWithoutReason.capabilities as JsonObject).timingResource as JsonObject).status = "missing";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, notCheckedStatusWithoutReason), []);

  const nonJsonVerifierDescriptor = structuredClone(complete);
  ((nonJsonVerifierDescriptor.evidence as JsonObject[]).find((descriptor) => descriptor.kind === "verifier")!).mediaType = "text/plain";
  assertContractInvalid(nonJsonVerifierDescriptor, completeArtifacts);

  const missingOutcomeWithVerifier = new Map(completeArtifacts);
  missingOutcomeWithVerifier.set("capture-report", {
    ...completeCaptureReport,
    qualification: "incomplete",
    capabilities: {
      ...completeCaptureReport.capabilities as JsonObject,
      outcome: { status: "missing" },
    },
    missingEvidence: [{ kind: "outcome-verifier", reason: "not-collected", affects: ["outcome"] }],
  });
  assertContractInvalid(complete, missingOutcomeWithVerifier);

  const declaredTimingGap = new Map(completeArtifacts);
  declaredTimingGap.set("capture-report", {
    ...completeCaptureReport,
    missingEvidence: [{ kind: "telemetry", reason: "not-checked", affects: ["timing-resource"] }],
  });
  assertContractInvalid(complete, declaredTimingGap);

  const wrongOptionalBetaAuthority = structuredClone(telemetryReport);
  ((wrongOptionalBetaAuthority.missingEvidence as JsonObject[])[0].affects as string[]) = [
    "timing-resource",
    "semantic",
  ];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, wrongOptionalBetaAuthority), []);

  const duplicateCapabilityEffects = structuredClone(telemetryReport);
  (duplicateCapabilityEffects.missingEvidence as JsonObject[])[0].affects = ["timing-resource", "timing-resource"];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, duplicateCapabilityEffects), []);

  const duplicateMissingEvidence = structuredClone(telemetryReport);
  (duplicateMissingEvidence.missingEvidence as JsonObject[]).push(
    structuredClone((duplicateMissingEvidence.missingEvidence as JsonObject[])[0]),
  );
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, duplicateMissingEvidence), []);

  const budgetStopped = structuredClone(complete);
  budgetStopped.terminal = { state: "stopped", failureClass: "none", stopReason: "budget" };
  assertContractValid(budgetStopped, completeArtifacts);

  const invalidStopped = structuredClone(budgetStopped);
  invalidStopped.terminal = { state: "stopped", failureClass: "infrastructure", stopReason: "budget" };
  assertContractInvalid(invalidStopped, completeArtifacts);

  const passedWithFailure = structuredClone(verifier);
  (passedWithFailure.assertions as JsonObject[])[0].status = "failed";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, passedWithFailure), []);

  const passedWithNonzeroExit = structuredClone(verifier);
  passedWithNonzeroExit.exitCode = 1;
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, passedWithNonzeroExit), []);

  const passedWithNotRun = structuredClone(verifier);
  (passedWithNotRun.assertions as JsonObject[])[0].status = "not-run";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, passedWithNotRun), []);

  const passedWithOnlyNotRun = structuredClone(verifier);
  passedWithOnlyNotRun.assertions = [{ id: "example-check", status: "not-run" }];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, passedWithOnlyNotRun), []);

  const passedWithoutAssertions = structuredClone(verifier);
  passedWithoutAssertions.assertions = [];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, passedWithoutAssertions), []);

  const notRunWithPassedAssertion = structuredClone(verifier);
  notRunWithPassedAssertion.status = "not-run";
  notRunWithPassedAssertion.assertions = [{ id: "example-check", status: "passed" }];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, notRunWithPassedAssertion), []);

  const notRunWithExitCode = structuredClone(verifier);
  notRunWithExitCode.status = "not-run";
  notRunWithExitCode.assertions = [{ id: "example-check", status: "not-run" }];
  notRunWithExitCode.exitCode = 0;
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, notRunWithExitCode), []);

  const failedWithoutFailure = structuredClone(verifier);
  failedWithoutFailure.status = "failed";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, failedWithoutFailure), []);

  const malformedVerifier = new Map(completeArtifacts);
  malformedVerifier.set("verifier", { ...completeVerifier, assertions: undefined });
  assert.doesNotThrow(() => assertContractInvalid(complete, malformedVerifier));

  const malformedCaptureReport = new Map(completeArtifacts);
  malformedCaptureReport.set("capture-report", { ...completeCaptureReport, capabilities: undefined });
  assert.doesNotThrow(() => assertContractInvalid(complete, malformedCaptureReport));
});
