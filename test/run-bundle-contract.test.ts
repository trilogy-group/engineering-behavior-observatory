import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
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
  const evidence = manifest.evidence;

  if (!Array.isArray(evidence)) {
    return errors;
  }

  const ids = evidence.map((descriptor) => (descriptor as JsonObject).id);

  if (new Set(ids).size !== ids.length) {
    errors.push("/evidence contains duplicate artifact IDs");
  }

  const sharingClassByPath = new Map<string, string>();

  for (const descriptor of evidence as JsonObject[]) {
    const relativePath = String(descriptor.relativePath);
    const sharingClass = String(descriptor.sharingClass);
    const existingSharingClass = sharingClassByPath.get(relativePath);

    if (existingSharingClass !== undefined && existingSharingClass !== sharingClass) {
      errors.push(`/evidence aliases ${relativePath} across sharing classes`);
    }
    sharingClassByPath.set(relativePath, sharingClass);
  }

  const attempt = manifest.attempt as JsonObject;

  if (attempt.retryOf === attempt.id) {
    errors.push("/attempt/retryOf cannot reference the current attempt");
  }

  for (const descriptor of evidence as JsonObject[]) {
    if (descriptor.kind !== "capture-report") {
      continue;
    }

    const report = artifacts.get(String(descriptor.id));

    if (report === undefined) {
      continue;
    }
    if (report.bundleId !== manifest.bundleId) {
      errors.push(`/evidence/${String(descriptor.id)} bundle ID does not match the manifest`);
    }

    const capabilities = report.capabilities as JsonObject;
    for (const [capability, authority] of Object.entries({
      semantic: "semantic",
      timingResource: "timing-resource",
      outcome: "outcome",
    })) {
      if ((capabilities[capability] as JsonObject).status === "available" &&
          !(evidence as JsonObject[]).some((item) => item.authority === authority)) {
        errors.push(`/capture-report/${capability} is available without ${authority} evidence`);
      }
    }
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
  if (!["ready", "exported"].includes(String(exportManifest.status))) {
    return;
  }

  const evidenceById = new Map(
    (manifest.evidence as JsonObject[]).map((descriptor) => [descriptor.id, descriptor]),
  );

  for (const artifactId of exportManifest.artifactIds as string[]) {
    const descriptor = evidenceById.get(artifactId);

    assert.ok(descriptor, `export references unknown artifact ${artifactId}`);
    assert.equal(
      descriptor.sharingClass,
      exportManifest.sharingClass,
      `${String(exportManifest.sharingClass)} export cannot include ${artifactId} with ${String(descriptor.sharingClass)} sharing class`,
    );
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

      if (descriptor.kind === "verifier") {
        assert.deepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, readJson(artifactPath)), []);
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
  assert.doesNotThrow(() => assertExportSafe(publicManifest, publicRestricted));
});

test("rejects contradictory and incomplete contract records", () => {
  const complete = readJson(resolve(fixtureRoot, "complete/manifest.json"));
  const completeCaptureReport = readJson(resolve(fixtureRoot, "complete/capture-report.json"));
  const completeArtifacts = new Map([["capture-report", completeCaptureReport]]);
  const telemetryReport = readJson(resolve(fixtureRoot, "telemetry-incomplete/capture-report.json"));
  const verifier = readJson(resolve(fixtureRoot, "complete/verifier.json"));

  const invalidTerminal = structuredClone(complete);
  invalidTerminal.terminal = { state: "completed", failureClass: "task", stopReason: "none" };
  assertContractInvalid(invalidTerminal);

  const invalidPath = structuredClone(complete);
  (invalidPath.evidence as JsonObject[])[0].relativePath = "../outside.json";
  assertContractInvalid(invalidPath);

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
  (serverRuntime.run as JsonObject).runtime = [
    { source: "openhands-agent-server", name: "agent-server", version: "1.0.0" },
  ];
  assertContractValid(serverRuntime, completeArtifacts);

  const selfRetry = structuredClone(complete);
  (selfRetry.attempt as JsonObject).retryOf = (selfRetry.attempt as JsonObject).id;
  assertContractInvalid(selfRetry, completeArtifacts);

  const mismatchedCaptureReport = new Map(completeArtifacts);
  mismatchedCaptureReport.set("capture-report", {
    ...completeCaptureReport,
    bundleId: "other-bundle",
  });
  assertContractInvalid(complete, mismatchedCaptureReport);

  const qualifiedWithoutEvidence = structuredClone(complete);
  qualifiedWithoutEvidence.evidence = (qualifiedWithoutEvidence.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind === "capture-report",
  );
  assertContractInvalid(qualifiedWithoutEvidence, completeArtifacts);

  const missingSemanticReason = structuredClone(telemetryReport);
  ((missingSemanticReason.capabilities as JsonObject).semantic as JsonObject).status = "missing";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, missingSemanticReason), []);

  const wrongOptionalBetaAuthority = structuredClone(telemetryReport);
  ((wrongOptionalBetaAuthority.missingEvidence as JsonObject[])[0].affects as string[]) = [
    "timing-resource",
    "semantic",
  ];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, wrongOptionalBetaAuthority), []);

  const passedWithFailure = structuredClone(verifier);
  (passedWithFailure.assertions as JsonObject[])[0].status = "failed";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, passedWithFailure), []);

  const failedWithoutFailure = structuredClone(verifier);
  failedWithoutFailure.status = "failed";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, failedWithoutFailure), []);
});
