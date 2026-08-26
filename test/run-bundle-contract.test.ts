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
    const existingDescriptor = descriptorByPath.get(relativePath);

    if (existingDescriptor !== undefined) {
      errors.push(`/evidence reuses ${relativePath}`);
    }
    descriptorByPath.set(relativePath, descriptor);
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

  if (declaredSessionId !== undefined && !sessionDescriptors.some((descriptor) =>
        ((descriptor.nativeReference as JsonObject | undefined)?.id) === declaredSessionId,
  )) {
    errors.push("/run/native/sessionId does not match retained session evidence");
  }
  if (declaredTraceId !== undefined && telemetryDescriptors.length > 0 &&
      !telemetryDescriptors.some((descriptor) =>
        ((descriptor.nativeReference as JsonObject | undefined)?.id) === declaredTraceId,
      )) {
    errors.push("/run/native/traceId does not match retained telemetry evidence");
  }

  const runtime = (manifest.run as JsonObject).runtime;
  if (Array.isArray(runtime)) {
    const runtimeIds = runtime.map((component) => {
      const value = component as JsonObject;
      return JSON.stringify([value.source, value.name, value.version]);
    });
    if (new Set(runtimeIds).size !== runtimeIds.length) {
      errors.push("/run/runtime contains duplicate components");
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
      continue;
    }

    const capabilities = report.capabilities as JsonObject;
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
  const captureReport = [...artifacts.entries()]
    .find(([artifactId]) => (evidence as JsonObject[]).some((descriptor) =>
      descriptor.id === artifactId && descriptor.kind === "capture-report",
    ))?.[1];
  const outcomeStatus = (captureReport?.capabilities as JsonObject | undefined)?.outcome as JsonObject | undefined;
  if (verifierStatuses.some((status) => status === "passed" || status === "failed")
      && outcomeStatus?.status !== "available") {
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

  const emptyReadyExport = structuredClone(readyExport);
  emptyReadyExport.artifactIds = [];
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/exportManifest`, emptyReadyExport), []);
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
  const taskFailed = readJson(resolve(fixtureRoot, "task-failed/manifest.json"));
  const taskFailedArtifacts = new Map([
    ["capture-report", readJson(resolve(fixtureRoot, "task-failed/capture-report.json"))],
    ["verifier", readJson(resolve(fixtureRoot, "task-failed/verifier.json"))],
  ]);
  const verifier = readJson(resolve(fixtureRoot, "complete/verifier.json"));

  const invalidTerminal = structuredClone(complete);
  invalidTerminal.terminal = { state: "completed", failureClass: "task", stopReason: "none" };
  assertContractInvalid(invalidTerminal);

  assert.doesNotThrow(() => assertContractInvalid({ evidence: [] }));

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

  const authorityAlias = structuredClone(complete);
  (authorityAlias.evidence as JsonObject[]).push({
    ...(authorityAlias.evidence as JsonObject[])[0],
    id: "outcome-session-alias",
    kind: "workspace",
    authority: "outcome",
  });
  assertContractInvalid(authorityAlias, completeArtifacts);

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
  (serverRuntime.run as JsonObject).runtime = [
    { source: "openhands-agent-server", name: "agent-server", version: "1.0.0" },
  ];
  assertContractValid(serverRuntime, completeArtifacts);

  const selfRetry = structuredClone(complete);
  (selfRetry.attempt as JsonObject).retryOf = (selfRetry.attempt as JsonObject).id;
  assertContractInvalid(selfRetry, completeArtifacts);

  const mismatchedNativeTrace = structuredClone(complete);
  ((mismatchedNativeTrace.evidence as JsonObject[]).find((descriptor) => descriptor.kind === "telemetry")!.nativeReference as JsonObject).id = "other-trace";
  assertContractInvalid(mismatchedNativeTrace, completeArtifacts);

  const duplicateRuntime = structuredClone(complete);
  ((duplicateRuntime.run as JsonObject).runtime as JsonObject[]).push({
    ...((duplicateRuntime.run as JsonObject).runtime as JsonObject[])[0],
  });
  assertContractInvalid(duplicateRuntime, completeArtifacts);

  const distinctDelimiterRuntime = structuredClone(complete);
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

  const missingSemanticReason = structuredClone(telemetryReport);
  ((missingSemanticReason.capabilities as JsonObject).semantic as JsonObject).status = "missing";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, missingSemanticReason), []);

  const qualifiedTelemetryGap = structuredClone(telemetryReport);
  qualifiedTelemetryGap.qualification = "qualified";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, qualifiedTelemetryGap), []);

  const unsupportedReasonWithMissingStatus = structuredClone(telemetryReport);
  (unsupportedReasonWithMissingStatus.missingEvidence as JsonObject[])[0].reason = "unsupported";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, unsupportedReasonWithMissingStatus), []);

  const unsupportedStatusWithoutReason = structuredClone(telemetryReport);
  ((unsupportedStatusWithoutReason.capabilities as JsonObject).timingResource as JsonObject).status = "unsupported";
  assert.notDeepEqual(schemaErrors(`${schemaId}#/$defs/captureReport`, unsupportedStatusWithoutReason), []);

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
