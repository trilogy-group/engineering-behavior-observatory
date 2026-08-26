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

function contractErrors(manifest: JsonObject): string[] {
  const errors = schemaErrors(schemaId, manifest);
  const evidence = manifest.evidence;

  if (!Array.isArray(evidence)) {
    return errors;
  }

  const ids = evidence.map((descriptor) => (descriptor as JsonObject).id);

  if (new Set(ids).size !== ids.length) {
    errors.push("/evidence contains duplicate artifact IDs");
  }

  return errors;
}

function assertContractValid(manifest: JsonObject): void {
  assert.deepEqual(contractErrors(manifest), []);
}

function assertContractInvalid(manifest: JsonObject): void {
  assert.notDeepEqual(contractErrors(manifest), []);
}

function assertPartnerExportSafe(manifest: JsonObject, exportManifest: JsonObject): void {
  if (exportManifest.sharingClass !== "partner" || !["ready", "exported"].includes(String(exportManifest.status))) {
    return;
  }

  const evidenceById = new Map(
    (manifest.evidence as JsonObject[]).map((descriptor) => [descriptor.id, descriptor]),
  );

  for (const artifactId of exportManifest.artifactIds as string[]) {
    const descriptor = evidenceById.get(artifactId);

    assert.ok(descriptor, `export references unknown artifact ${artifactId}`);
    assert.ok(
      ["partner", "public"].includes(String(descriptor.sharingClass)),
      `partner export cannot include ${artifactId} with ${String(descriptor.sharingClass)} sharing class`,
    );
  }
}

test("validates retained run-bundle fixtures and their references", () => {
  for (const fixture of ["complete", "task-failed", "interrupted", "telemetry-incomplete"]) {
    const bundleRoot = resolve(fixtureRoot, fixture);
    const manifest = readJson(resolve(bundleRoot, "manifest.json"));

    assertContractValid(manifest);

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
        assert.deepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, readJson(artifactPath)), []);
      }
      if (descriptor.kind === "export-manifest") {
        const exportManifest = readJson(artifactPath);

        assert.deepEqual(schemaErrors(`${schemaId}#/$defs/exportManifest`, exportManifest), []);
        assertPartnerExportSafe(manifest, exportManifest);
      }
    }
  }
});

test("blocks a ready partner export that lists restricted source artifacts", () => {
  const bundleRoot = resolve(fixtureRoot, "complete");
  const manifest = readJson(resolve(bundleRoot, "manifest.json"));
  const exportManifest = readJson(resolve(bundleRoot, "export/manifest.json"));
  const readyExport = structuredClone(exportManifest);

  assert.equal(exportManifest.status, "blocked");
  readyExport.status = "ready";
  assert.throws(() => assertPartnerExportSafe(manifest, readyExport));
});

test("rejects contradictory and incomplete contract records", () => {
  const complete = readJson(resolve(fixtureRoot, "complete/manifest.json"));
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
  assertContractInvalid(duplicateArtifact);

  const missingCaptureReport = structuredClone(complete);
  missingCaptureReport.evidence = (missingCaptureReport.evidence as JsonObject[]).filter(
    (descriptor) => descriptor.kind !== "capture-report",
  );
  assertContractInvalid(missingCaptureReport);

  const duplicateCaptureReport = structuredClone(complete);
  const captureReport = (duplicateCaptureReport.evidence as JsonObject[]).find(
    (descriptor) => descriptor.kind === "capture-report",
  );
  (duplicateCaptureReport.evidence as JsonObject[]).push({ ...captureReport, id: "second-capture-report" });
  assertContractInvalid(duplicateCaptureReport);

  const serverRuntime = structuredClone(complete);
  (serverRuntime.run as JsonObject).runtime = [
    { source: "openhands-agent-server", name: "agent-server", version: "1.0.0" },
  ];
  assertContractValid(serverRuntime);

  const missingSemanticReason = structuredClone(telemetryReport);
  ((missingSemanticReason.capabilities as JsonObject).semantic as JsonObject).status = "missing";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, missingSemanticReason), []);

  const wrongOptionalBetaAuthority = structuredClone(telemetryReport);
  ((wrongOptionalBetaAuthority.missingEvidence as JsonObject[])[0].affects as string[]) = ["semantic"];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, wrongOptionalBetaAuthority), []);

  const passedWithFailure = structuredClone(verifier);
  (passedWithFailure.assertions as JsonObject[])[0].status = "failed";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, passedWithFailure), []);

  const failedWithoutFailure = structuredClone(verifier);
  failedWithoutFailure.status = "failed";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/verifierResult`, failedWithoutFailure), []);
});
