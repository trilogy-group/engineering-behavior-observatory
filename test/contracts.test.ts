import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";

import {
  assertAdmittedTaskPackets,
  assertControlledPerturbationDigest,
  assertDeclaredOrder,
  assertNoSelectedSymlinks as validateArchiveSelection,
  assertArchiveMeasurements,
  assertResolvedExperimentConfigurationDigests,
  declaredMatrixCells,
  resolveBundleConfiguration,
  resolveTaskArchive,
  type ArtifactReference,
  type ArchiveEntry,
  type Digest,
  type ExperimentConfiguration,
  type DeclaredOrder,
  type ResolvedTaskPacket,
  type TaskConditionSet,
} from "../src/contracts.js";
import { resolveBundleConfiguration as exportedResolveBundleConfiguration } from "../src/index.js";

const addFormats = formats.default as unknown as (instance: Ajv2020) => void;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const longRelativePath = Array.from({ length: 513 }, () => "a").join("/");
const rootReservedPath = "a".repeat(961);
const tooDeepRelativePath = Array.from({ length: 65 }, () => "a").join("/");
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", name), "utf8"));
const schema = (name: string): object =>
  JSON.parse(readFileSync(join(repositoryRoot, "schemas", name), "utf8"));

function validator(schemaName: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true });

  addFormats(ajv);
  return ajv.compile(schema(schemaName));
}

function validatorWithoutFormatAssertion(schemaName: string): ValidateFunction {
  return new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema(schemaName));
}

function expectInvalid(validate: ValidateFunction, document: unknown, field: string): void {
  assert.equal(validate(document), false);
  assert.match(JSON.stringify(validate.errors ?? []), new RegExp(field));
}

type Document = Record<string, unknown>;
type InvalidCase = {
  field: string;
  operation: "remove" | "replace";
  path: string[];
  value?: unknown;
};

function assertNoSelectedSymlinks(
  entries: readonly ArchiveEntry[],
  includePaths: readonly string[],
  archiveEntries: readonly ArchiveEntry[] = entries,
): void {
  validateArchiveSelection(entries, includePaths, archiveEntries);
}

function applyInvalidCase(source: Document, invalidCase: InvalidCase): unknown {
  const document = structuredClone(source) as Document;
  const parent = invalidCase.path.slice(0, -1).reduce<Document>(
    (value, key) => value[key] as Document,
    document,
  );
  const key = invalidCase.path.at(-1)!;

  if (invalidCase.operation === "remove") {
    delete parent[key];
  } else {
    parent[key] = invalidCase.value;
  }

  return document;
}

function expandMatrix(experiment: {
  taskSet: Document;
  modelSet: Document;
  harnessSet: Document;
  trialCount: number;
}): number {
  return Object.keys(experiment.taskSet).length
    * Object.keys(experiment.modelSet).length
    * Object.keys(experiment.harnessSet).length
    * experiment.trialCount;
}

function admittedResolutions(taskSet: TaskConditionSet): Record<string, ResolvedTaskPacket> {
  const preAdmissionDigest: Digest = { algorithm: "sha256", value: "1".repeat(64) };

  return Object.fromEntries(
    Object.entries(taskSet).map(([taskId, condition]) => [
      taskId,
      {
        digest: condition.packetRef.digest,
        preAdmissionDigest,
        reviewRecordDigest: condition.packetRef.digest,
        resolvedReviewRecordDigest: condition.packetRef.digest,
        reviewRecordPreAdmissionDigest: preAdmissionDigest,
        controlledPerturbation: {
          declaration: { status: "referenced", digest: condition.packetRef.digest },
          resolvedDigest: condition.packetRef.digest,
        },
        referenceSolution: {
          declaration: { status: "referenced", digest: condition.packetRef.digest },
          resolvedDigest: condition.packetRef.digest,
        },
        verifierDigest: condition.packetRef.digest,
        resolvedVerifierDigest: condition.packetRef.digest,
        admission: { status: "admitted", reviewedAt: "2026-08-26T00:00:00Z" },
      },
    ]),
  );
}

function resolvedConfigurationDigests(experiment: ExperimentConfiguration): Record<string, Digest> {
  const references = [
    ...Object.values(experiment.modelSet).map((condition) => condition.configurationRef),
    ...Object.values(experiment.harnessSet).flatMap((condition) => [
      condition.configurationRef,
      condition.nativeLimitsRef,
      condition.nativeToolPolicyRef,
    ]),
    experiment.captureProfile,
    ...(experiment.ordering.strategy === "permuted" && experiment.ordering.permutationAlgorithmRef !== undefined
      ? [experiment.ordering.permutationAlgorithmRef]
      : []),
  ];

  return Object.fromEntries(references.map((reference) => [reference.locator, reference.digest]));
}

test("task packets expose only a verified, allowlisted materialization surface", () => {
  const packet = fixture("task-packet.valid.v1.json") as {
    agentInput: {
      fixture: {
        source: { kind: string; format: string; limits: object; digest: object };
        materializer: { kind: string; includePaths: string[] };
      };
    };
    restricted: { referenceSolution: object };
  };
  const validate = validator("task-packet.v1.schema.json");

  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(packet.agentInput.fixture.source.kind, "sanitized-archive");
  assert.equal(packet.agentInput.fixture.source.format, "tar-gzip-v1");
  assert.equal(packet.agentInput.fixture.materializer.kind, "verified-archive-literal-paths-no-links-v1");
  assert.deepEqual(packet.agentInput.fixture.materializer.includePaths, ["README.md", "package.json", "src"]);
  assert.doesNotMatch(JSON.stringify(packet.agentInput), /referenceSolution|reviewRecord|verifier/);
  assert.deepEqual(Object.keys(packet.restricted.referenceSolution).sort(), ["digest", "locator"]);
});

test("task packet validation rejects unsafe sources, missing evidence, and bad review states", () => {
  const validate = validator("task-packet.v1.schema.json");
  const admitted = fixture("task-packet.valid.v1.json") as Document;
  const proposed = fixture("task-packet.proposed.v1.json") as Document;

  assert.equal(validate(admitted), true, JSON.stringify(validate.errors));
  assert.equal(validate(proposed), true, JSON.stringify(validate.errors));
  assert.equal("components" in admitted, false);
  assert.deepEqual((proposed.admission as Document).review, null);
  assert.deepEqual(Object.keys(proposed.restricted as Document).sort(), ["referenceSolution", "verifier"]);

  const verifierOnly = structuredClone(admitted) as Document;
  (verifierOnly.restricted as Document).referenceSolution = { status: "not-provided" };
  assert.equal(validate(verifierOnly), true, JSON.stringify(validate.errors));

  const blankPrompt = structuredClone(admitted) as Document;
  (blankPrompt.agentInput as Document).prompt = " ";
  expectInvalid(validate, blankPrompt, "prompt");

  const blankRestrictedLocator = structuredClone(admitted) as Document;
  ((blankRestrictedLocator.restricted as Document).verifier as Document).locator = " ";
  expectInvalid(validate, blankRestrictedLocator, "locator");

  const explicitPort = structuredClone(admitted) as Document;
  (explicitPort.provenance as Document).repositoryUrl = "https://git.example.test:8443/org/repository.git";
  assert.equal(validate(explicitPort), true, JSON.stringify(validate.errors));

  const ipv6Host = structuredClone(admitted) as Document;
  (ipv6Host.provenance as Document).repositoryUrl = "https://[2001:db8::1]/org/repository.git";
  assert.equal(validatorWithoutFormatAssertion("task-packet.v1.schema.json")(ipv6Host), true);

  const ipv4EmbeddedIpv6Host = structuredClone(admitted) as Document;
  (ipv4EmbeddedIpv6Host.provenance as Document).repositoryUrl = "https://[::ffff:192.0.2.128]/org/repository.git";
  assert.equal(validatorWithoutFormatAssertion("task-packet.v1.schema.json")(ipv4EmbeddedIpv6Host), true);

  const malformedIpv6Host = structuredClone(admitted) as Document;
  (malformedIpv6Host.provenance as Document).repositoryUrl = "https://[.]/repository.git";
  expectInvalid(validatorWithoutFormatAssertion("task-packet.v1.schema.json"), malformedIpv6Host, "repositoryUrl");

  const dotSegmentRepository = structuredClone(admitted) as Document;
  (dotSegmentRepository.provenance as Document).repositoryUrl = "https://git.example.test/org/../other/repository.git";
  expectInvalid(validate, dotSegmentRepository, "repositoryUrl");

  const blankLicense = structuredClone(admitted) as Document;
  (blankLicense.provenance as Document).license = " ";
  expectInvalid(validate, blankLicense, "license");

  const unperturbed = structuredClone(admitted) as Document;
  unperturbed.controlledPerturbation = { status: "not-applied" };
  assert.equal(validate(unperturbed), true, JSON.stringify(validate.errors));

  for (const includePath of ["README.md/", "src/"]) {
    const trailingSlash = structuredClone(admitted) as Document;
    ((trailingSlash.agentInput as Document).fixture as Document).materializer = {
      ...((trailingSlash.agentInput as Document).fixture as Document).materializer as Document,
      includePaths: [includePath],
    };
    expectInvalid(validate, trailingSlash, "includePaths");
  }

  for (const includePath of ["./README.md", "src/./index.ts"]) {
    const dotSegment = structuredClone(admitted) as Document;
    ((dotSegment.agentInput as Document).fixture as Document).materializer = {
      ...((dotSegment.agentInput as Document).fixture as Document).materializer as Document,
      includePaths: [includePath],
    };
    expectInvalid(validate, dotSegment, "includePaths");
  }

  for (const locator of ["fixtures/./task.tar.gz", "fixtures//task.tar.gz", "fixtures/task.tar.gz/"]) {
    const nonCanonicalSource = structuredClone(admitted) as Document;
    (((nonCanonicalSource.agentInput as Document).fixture as Document).source as Document).locator = locator;
    expectInvalid(validate, nonCanonicalSource, "locator");
  }

  for (const locator of ["perturbations/./change.json", "perturbations/change.json/"]) {
    const nonCanonicalPerturbation = structuredClone(admitted) as Document;
    ((nonCanonicalPerturbation.controlledPerturbation as Document).reference as Document).locator = locator;
    expectInvalid(validate, nonCanonicalPerturbation, "locator");
  }

  const windowsDeviceInclude = structuredClone(admitted) as Document;
  (((windowsDeviceInclude.agentInput as Document).fixture as Document).materializer as Document).includePaths = ["src/NUL.txt"];
  expectInvalid(validate, windowsDeviceInclude, "includePaths");

  const gitInclude = structuredClone(admitted) as Document;
  (((gitInclude.agentInput as Document).fixture as Document).materializer as Document).includePaths = [".git/config"];
  expectInvalid(validate, gitInclude, "includePaths");

  const trailingWindowsAlias = structuredClone(admitted) as Document;
  (((trailingWindowsAlias.agentInput as Document).fixture as Document).materializer as Document).includePaths = ["src/foo."];
  expectInvalid(validate, trailingWindowsAlias, "includePaths");

  const tooLongComponent = "a".repeat(256);
  const tooLongInclude = structuredClone(admitted) as Document;
  (((tooLongInclude.agentInput as Document).fixture as Document).materializer as Document).includePaths = [`src/${tooLongComponent}`];
  expectInvalid(validate, tooLongInclude, "includePaths");

  const tooLongAggregateInclude = structuredClone(admitted) as Document;
  (((tooLongAggregateInclude.agentInput as Document).fixture as Document).materializer as Document).includePaths = [longRelativePath];
  expectInvalid(validate, tooLongAggregateInclude, "includePaths");

  const rootReservedInclude = structuredClone(admitted) as Document;
  (((rootReservedInclude.agentInput as Document).fixture as Document).materializer as Document).includePaths = [rootReservedPath];
  expectInvalid(validate, rootReservedInclude, "includePaths");

  const tooDeepInclude = structuredClone(admitted) as Document;
  (((tooDeepInclude.agentInput as Document).fixture as Document).materializer as Document).includePaths = [tooDeepRelativePath];
  expectInvalid(validate, tooDeepInclude, "includePaths");

  const archiveBomb = structuredClone(admitted) as Document;
  ((((archiveBomb.agentInput as Document).fixture as Document).source as Document).limits as Document).maxMembers = 100001;
  expectInvalid(validate, archiveBomb, "maxMembers");

  const malformedReviewTime = structuredClone(admitted) as Document;
  ((malformedReviewTime.admission as Document).review as Document).reviewedAt = "unknown";
  expectInvalid(validatorWithoutFormatAssertion("task-packet.v1.schema.json"), malformedReviewTime, "reviewedAt");

  const blankReviewer = structuredClone(admitted) as Document;
  ((blankReviewer.admission as Document).review as Document).reviewedBy = " ";
  expectInvalid(validate, blankReviewer, "reviewedBy");

  const lowercaseReviewTime = structuredClone(admitted) as Document;
  ((lowercaseReviewTime.admission as Document).review as Document).reviewedAt = "2026-08-26t00:00:00z";
  assert.equal(validate(lowercaseReviewTime), true, JSON.stringify(validate.errors));

  const leapSecondReviewTime = structuredClone(admitted) as Document;
  ((leapSecondReviewTime.admission as Document).review as Document).reviewedAt = "2016-12-31T23:59:60Z";
  assert.equal(validate(leapSecondReviewTime), true, JSON.stringify(validate.errors));

  for (const invalidCase of fixture("task-packet.invalid-cases.v1.json") as InvalidCase[]) {
    expectInvalid(validate, applyInvalidCase(admitted, invalidCase), invalidCase.field);
  }
});

test("controlled perturbation references reject tampered digests", () => {
  const packet = fixture("task-packet.valid.v1.json") as Document;
  const reference = (packet.controlledPerturbation as Document).reference as ArtifactReference;

  assert.doesNotThrow(() => assertControlledPerturbationDigest(reference, reference.digest));
  assert.throws(
    () => assertControlledPerturbationDigest(reference, { algorithm: "sha256", value: "0".repeat(64) }),
    /Controlled perturbation digest/,
  );
});

test("literal archive selection rejects unsafe or colliding destinations", () => {
  assert.doesNotThrow(() => assertNoSelectedSymlinks([
    { path: "src", kind: "directory" },
    { path: "src/index.ts", kind: "file" },
  ], ["src"]));
  assert.throws(
    () => assertNoSelectedSymlinks([{ path: "src/config", kind: "symlink" }], ["src"]),
    /src\/config.*unsafe/,
  );
  assert.throws(
    () => assertNoSelectedSymlinks([{ path: "src/../../restricted/verifier.json", kind: "file" }], ["src"]),
    /unsafe/,
  );
  assert.throws(() => assertNoSelectedSymlinks([{ path: "src/config", kind: "hardlink" }], ["src"]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([], ["src"]), /No archive entries/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: "src/./index.ts", kind: "file" }], ["src"]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: "src/.", kind: "directory" }], ["src"]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: "README.md/", kind: "file" }], ["README.md"]), /unsafe/);
  assert.doesNotThrow(() => assertNoSelectedSymlinks([{ path: ".editorconfig", kind: "file" }], [".editorconfig"]));
  assert.throws(() => assertNoSelectedSymlinks([
    { path: "src", kind: "directory" },
    { path: "src/", kind: "directory" },
  ], ["src"]), /collides/);
  assert.throws(() => assertNoSelectedSymlinks([
    { path: "src", kind: "file" },
    { path: "src/index.ts", kind: "file" },
  ], ["src"]), /file destination/);
  assert.throws(() => assertNoSelectedSymlinks([
    { path: "src", kind: "file" },
    { path: "src/subdir", kind: "directory" },
  ], ["src"]), /file destination/);
  assert.throws(() => assertNoSelectedSymlinks([
    { path: "src/Config.ts", kind: "file" },
    { path: "src/config.ts", kind: "file" },
  ], ["src"]), /collides/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: "README.md", kind: "file" }], ["src"]), /selected no entries/);
  assert.throws(() => assertNoSelectedSymlinks([
    { path: "src/index.ts", kind: "file" },
    { path: "restricted/verifier.json", kind: "file" },
  ], ["src"]), /outside the declared allowlist/);
  assert.throws(() => assertNoSelectedSymlinks(
    [{ path: "src/a.ts", kind: "file" }],
    ["src"],
    [{ path: "src/a.ts", kind: "file" }, { path: "src/b.ts", kind: "file" }],
  ), /omitted selected entry/);
  assert.throws(() => assertNoSelectedSymlinks(
    [{ path: "src/config", kind: "file" }],
    ["src"],
    [{ path: "src/config", kind: "symlink" }],
  ), /does not match its archive member kind/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: "src/NUL.txt", kind: "file" }], ["src/NUL.txt"]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: ".git/config", kind: "file" }], [".git"]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: "src/foo.", kind: "file" }], ["src/foo."]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks(
    [{ path: "README.md", kind: "file" }],
    ["README.md"],
    [{ path: "README.md/", kind: "file" }],
  ), /unsafe/);
  assert.doesNotThrow(() => assertNoSelectedSymlinks(
    [{ path: "src/index.ts", kind: "file" }],
    ["src"],
    [{ path: "src-old/file.ts", kind: "file" }, { path: "src/index.ts", kind: "file" }],
  ));
  assert.doesNotThrow(() => assertNoSelectedSymlinks(
    [{ path: "src/index.ts", kind: "file" }],
    ["src"],
    [
      { path: "src/index.ts", kind: "file" },
      { path: "docs/A.txt", kind: "file" },
      { path: "docs/a.txt", kind: "file" },
    ],
  ));
  assert.throws(() => assertNoSelectedSymlinks(
    [{ path: "src", kind: "directory" }, { path: "SRC/index.ts", kind: "file" }],
    ["src", "SRC"],
  ), /case-inconsistent ancestor/);
  assert.throws(() => assertNoSelectedSymlinks(
    [{ path: "src/a.ts", kind: "file" }, { path: "SRC/b.ts", kind: "file" }],
    ["src", "SRC"],
  ), /case-inconsistent ancestor/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: `src/${"a".repeat(256)}`, kind: "file" }], ["src"]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: longRelativePath, kind: "file" }], [longRelativePath]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: rootReservedPath, kind: "file" }], [rootReservedPath]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks([{ path: tooDeepRelativePath, kind: "file" }], [tooDeepRelativePath]), /unsafe/);
  assert.throws(() => assertNoSelectedSymlinks(
    [{ path: "src/config.ts", kind: "file" }],
    ["src/config.ts"],
    [{ path: "src/Config.ts", kind: "file" }],
  ), /does not match its archive member kind/);
  assert.doesNotThrow(() => assertNoSelectedSymlinks([{ path: "_config.yml", kind: "file" }], ["_config.yml"]));
  assert.doesNotThrow(() => assertNoSelectedSymlinks([{ path: "-generated", kind: "file" }], ["-generated"]));

  const boundaryEntries = Array.from(
    { length: 100000 },
    (_, index): ArchiveEntry => ({ path: `src/file-${index}.ts`, kind: "file" }),
  );
  assert.doesNotThrow(() => assertNoSelectedSymlinks(boundaryEntries, ["src"]));
  assert.doesNotThrow(() => assertNoSelectedSymlinks(
    boundaryEntries,
    boundaryEntries.map((entry) => entry.path),
    boundaryEntries,
  ));
  const deepPrefix = Array.from({ length: 63 }, () => "d").join("/");
  const deepEntries = Array.from(
    { length: 100000 },
    (_, index): ArchiveEntry => ({ path: `${deepPrefix}/${index}`, kind: "file" }),
  );
  assert.doesNotThrow(() => assertNoSelectedSymlinks(deepEntries, [deepPrefix], deepEntries));
  assert.doesNotThrow(() => assertArchiveMeasurements(
    { maxCompressedBytes: 10, maxExpandedBytes: 20, maxMembers: 2 },
    { compressedBytes: 10, expandedBytes: 20, memberCount: 2 },
  ));
  assert.throws(() => assertArchiveMeasurements(
    { maxCompressedBytes: 10, maxExpandedBytes: 20, maxMembers: 1 },
    { compressedBytes: 10, expandedBytes: 20, memberCount: 2 },
  ), /materialization limits/);
  assert.throws(() => assertArchiveMeasurements(
    { maxCompressedBytes: 10, maxExpandedBytes: 20, maxMembers: 2 },
    { compressedBytes: Number.NaN, expandedBytes: 20, memberCount: 2 },
  ), /measurements/);
  assert.throws(() => assertArchiveMeasurements(
    { maxCompressedBytes: Number.NaN, maxExpandedBytes: 20, maxMembers: 2 },
    { compressedBytes: 10, expandedBytes: 20, memberCount: 2 },
  ), /limits/);
  assert.throws(() => assertArchiveMeasurements(
    { maxCompressedBytes: 10, maxExpandedBytes: -1, maxMembers: 2 },
    { compressedBytes: 10, expandedBytes: 20, memberCount: 2 },
  ), /limits/);
  assert.throws(() => assertArchiveMeasurements(
    { maxCompressedBytes: 10, maxExpandedBytes: 20, maxMembers: 2 },
    { compressedBytes: -1, expandedBytes: 20, memberCount: 2 },
  ), /measurements/);
});

test("configuration references stay inside the bundle without following links", () => {
  const bundleRoot = mkdtempSync(join(tmpdir(), "ebo-contracts-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "ebo-contracts-outside-"));
  const configurationPath = join(bundleRoot, "models", "model-a.json");
  const archivePath = join(bundleRoot, "fixtures", "task.tar.gz");
  const archiveReference = {
    locator: "fixtures/task.tar.gz",
    digest: { algorithm: "sha256" as const, value: createHash("sha256").update("archive").digest("hex") },
  };
  const configurationReference = {
    locator: "models/model-a.json",
    digest: { algorithm: "sha256" as const, value: createHash("sha256").update("{}").digest("hex") },
  };

  try {
    mkdirSync(join(bundleRoot, "models"));
    mkdirSync(join(bundleRoot, "fixtures"));
    writeFileSync(configurationPath, "{}");
    writeFileSync(archivePath, "archive");
    const outsideConfiguration = join(outsideRoot, "configuration.json");
    writeFileSync(outsideConfiguration, "{}");
    linkSync(outsideConfiguration, join(bundleRoot, "models", "hardlink.json"));
    const verifiedConfiguration = resolveBundleConfiguration(bundleRoot, configurationReference);
    assert.deepEqual(verifiedConfiguration, Buffer.from("{}"));
    writeFileSync(configurationPath, "changed");
    assert.deepEqual(verifiedConfiguration, Buffer.from("{}"));
    writeFileSync(configurationPath, "{}");
    assert.throws(() => resolveBundleConfiguration(bundleRoot, configurationReference, 1), /maximum bytes/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, configurationReference, Number.NaN), /positive safe integer/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, configurationReference, Number.POSITIVE_INFINITY), /positive safe integer/);
    const verifiedArchive = resolveTaskArchive(bundleRoot, archiveReference, 7);
    assert.deepEqual(verifiedArchive, Buffer.from("archive"));
    writeFileSync(archivePath, "changed");
    assert.deepEqual(verifiedArchive, Buffer.from("archive"));
    writeFileSync(archivePath, "archive");
    assert.throws(() => resolveTaskArchive(bundleRoot, archiveReference, 6), /maximum bytes/);
    assert.equal(exportedResolveBundleConfiguration, resolveBundleConfiguration);
    assert.throws(
      () => resolveTaskArchive(bundleRoot, { ...archiveReference, digest: { algorithm: "sha256", value: "0".repeat(64) } }, 7),
      /digest does not match/,
    );
    symlinkSync("../../outside.json", join(bundleRoot, "models", "escaped.json"));
    symlinkSync("../../outside.tar.gz", join(bundleRoot, "fixtures", "escaped.tar.gz"));
    symlinkSync("model-a.json", join(bundleRoot, "models", "aliased.json"));
    assert.throws(() => resolveBundleConfiguration(bundleRoot, { ...configurationReference, locator: "models/escaped.json" }), /escapes/);
    assert.throws(() => resolveTaskArchive(bundleRoot, { ...archiveReference, locator: "fixtures/escaped.tar.gz" }, 7), /escapes/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, { ...configurationReference, locator: "models/aliased.json" }), /escapes/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, { ...configurationReference, locator: "models/./model-a.json" }), /unsafe/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, { ...configurationReference, locator: "models/NUL.json" }), /unsafe/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, { ...configurationReference, locator: "models/hardlink.json" }), /isolated regular file/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, { ...configurationReference, locator: "models/.git/model.json" }), /unsafe/);
    assert.throws(() => resolveBundleConfiguration(bundleRoot, { ...configurationReference, locator: "models" }), /not an isolated regular file/);
  } finally {
    rmSync(bundleRoot, { force: true, recursive: true });
    rmSync(outsideRoot, { force: true, recursive: true });
  }
});

test("experiment fixtures pin identity and preserve native harness limits", () => {
  const validate = validator("experiment.v1.schema.json");
  const eighteen = fixture("experiment.18-cell.v1.json") as Parameters<typeof expandMatrix>[0];
  const twentyFour = fixture("experiment.24-cell.v1.json") as Parameters<typeof expandMatrix>[0] & {
    ordering: { declaredOrder: DeclaredOrder };
  };

  assert.equal(validate(eighteen), true, JSON.stringify(validate.errors));
  assert.equal(validate(twentyFour), true, JSON.stringify(validate.errors));
  assert.equal(expandMatrix(eighteen), 18);
  assert.equal(expandMatrix(twentyFour), 24);
  assert.equal(new Set(Object.keys(eighteen.taskSet)).size, Object.keys(eighteen.taskSet).length);
  assert.equal("budgets" in eighteen, false);
  assert.ok((eighteen.harnessSet["harness-a"] as Document).nativeLimitsRef);
  assert.ok((eighteen.harnessSet["harness-a"] as Document).nativeToolPolicyRef);
  assert.deepEqual(Object.keys(twentyFour.taskSet), ["2", "10"]);
  assert.deepEqual(twentyFour.ordering.declaredOrder.taskIds, ["10", "2"]);
  assert.doesNotThrow(() => assertDeclaredOrder(twentyFour, twentyFour.ordering.declaredOrder));
  assert.deepEqual(
    [...declaredMatrixCells(twentyFour.ordering.declaredOrder, twentyFour.trialCount)].slice(0, 4),
    [
      { taskId: "10", modelId: "model-a", harnessId: "harness-a", trialIndex: 1 },
      { taskId: "10", modelId: "model-a", harnessId: "harness-a", trialIndex: 2 },
      { taskId: "10", modelId: "model-a", harnessId: "harness-b", trialIndex: 1 },
      { taskId: "10", modelId: "model-a", harnessId: "harness-b", trialIndex: 2 },
    ],
  );
  const huge = declaredMatrixCells(twentyFour.ordering.declaredOrder, 2147483647);
  assert.deepEqual(huge.next().value, { taskId: "10", modelId: "model-a", harnessId: "harness-a", trialIndex: 1 });
  for (const invalidTrialCount of [0, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => declaredMatrixCells(twentyFour.ordering.declaredOrder, invalidTrialCount).next(), /Trial count/);
  }

  const configurationExperiment = fixture("experiment.18-cell.v1.json") as ExperimentConfiguration;
  const configurationDigests = resolvedConfigurationDigests(configurationExperiment);
  assert.doesNotThrow(() => assertResolvedExperimentConfigurationDigests(configurationExperiment, configurationDigests));
  configurationDigests["models/model-a.json"] = { algorithm: "sha256", value: "0".repeat(64) };
  assert.throws(
    () => assertResolvedExperimentConfigurationDigests(configurationExperiment, configurationDigests),
    /model "model-a" digest/,
  );
  const duplicateModel = structuredClone(configurationExperiment);
  duplicateModel.modelSet["model-c"] = duplicateModel.modelSet["model-a"];
  assert.throws(
    () => assertResolvedExperimentConfigurationDigests(duplicateModel, resolvedConfigurationDigests(duplicateModel)),
    /Model "model-c" duplicates/,
  );

  const caseAliasedConfiguration = structuredClone(configurationExperiment);
  caseAliasedConfiguration.modelSet["model-b"]!.configurationRef = {
    ...caseAliasedConfiguration.modelSet["model-b"]!.configurationRef,
    locator: "models/MODEL-A.json",
  };
  assert.throws(
    () => assertResolvedExperimentConfigurationDigests(caseAliasedConfiguration, resolvedConfigurationDigests(caseAliasedConfiguration)),
    /case-aliases/,
  );

  const caseAliasedTaskPacket = structuredClone(configurationExperiment);
  caseAliasedTaskPacket.taskSet["task-a"]!.packetRef = {
    ...caseAliasedTaskPacket.taskSet["task-a"]!.packetRef,
    locator: "models/MODEL-A.json",
  };
  assert.throws(
    () => assertResolvedExperimentConfigurationDigests(caseAliasedTaskPacket, resolvedConfigurationDigests(caseAliasedTaskPacket)),
    /case-aliases/,
  );

  const declaredConfiguration: ExperimentConfiguration = {
    schemaVersion: "ebo.experiment/v1",
    id: "declared-configuration",
    taskSet: twentyFour.taskSet as TaskConditionSet,
    modelSet: configurationExperiment.modelSet,
    harnessSet: configurationExperiment.harnessSet,
    trialCount: 2,
    coordinatorBudget: { maxWallClockMs: 1 },
    captureProfile: configurationExperiment.captureProfile,
    ordering: { seed: "fixed", strategy: "declared", declaredOrder: twentyFour.ordering.declaredOrder },
  };
  assert.doesNotThrow(() => assertResolvedExperimentConfigurationDigests(
    declaredConfiguration,
    resolvedConfigurationDigests(declaredConfiguration),
  ));
});

test("experiment validation rejects mutable references, duplicate-array conditions, and unsafe numbers", () => {
  const validate = validator("experiment.v1.schema.json");
  const experiment = fixture("experiment.18-cell.v1.json") as Document;

  for (const invalidCase of fixture("experiment.invalid-cases.v1.json") as InvalidCase[]) {
    expectInvalid(validate, applyInvalidCase(experiment, invalidCase), invalidCase.field);
  }

  const declared = fixture("experiment.24-cell.v1.json") as Document;
  expectInvalid(
    validate,
    applyInvalidCase(declared, {
      field: "declaredOrder",
      operation: "remove",
      path: ["ordering", "declaredOrder"],
    }),
    "declaredOrder",
  );

  const trailingConfigurationLocator = structuredClone(experiment);
  ((trailingConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef = {
    ...(((trailingConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef as Document),
    locator: "models/model-a.json/",
  };
  expectInvalid(validate, trailingConfigurationLocator, "locator");

  const windowsDeviceConfigurationLocator = structuredClone(experiment);
  ((windowsDeviceConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef = {
    ...(((windowsDeviceConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef as Document),
    locator: "models/NUL.json",
  };
  expectInvalid(validate, windowsDeviceConfigurationLocator, "locator");

  const gitConfigurationLocator = structuredClone(experiment);
  ((gitConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef = {
    ...(((gitConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef as Document),
    locator: "models/.git/model.json",
  };
  expectInvalid(validate, gitConfigurationLocator, "locator");

  const tooLongConfigurationLocator = structuredClone(experiment);
  ((tooLongConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef = {
    ...(((tooLongConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef as Document),
    locator: `models/${"a".repeat(256)}.json`,
  };
  expectInvalid(validate, tooLongConfigurationLocator, "locator");

  const tooLongAggregateConfigurationLocator = structuredClone(experiment);
  ((tooLongAggregateConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef = {
    ...(((tooLongAggregateConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef as Document),
    locator: longRelativePath,
  };
  expectInvalid(validate, tooLongAggregateConfigurationLocator, "locator");

  const tooDeepConfigurationLocator = structuredClone(experiment);
  ((tooDeepConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef = {
    ...(((tooDeepConfigurationLocator.modelSet as Document)["model-a"] as Document).configurationRef as Document),
    locator: tooDeepRelativePath,
  };
  expectInvalid(validate, tooDeepConfigurationLocator, "locator");

  const declaredOrder = (fixture("experiment.24-cell.v1.json") as {
    taskSet: Document;
    modelSet: Document;
    harnessSet: Document;
    ordering: { declaredOrder: DeclaredOrder };
  });
  assert.throws(
    () => assertDeclaredOrder(declaredOrder, { ...declaredOrder.ordering.declaredOrder, taskIds: ["10"] }),
    /task/,
  );
  assert.throws(
    () => assertDeclaredOrder(declaredOrder, { ...declaredOrder.ordering.declaredOrder, taskIds: ["10", "missing"] }),
    /task/,
  );
  assert.throws(
    () => assertDeclaredOrder(declaredOrder, { ...declaredOrder.ordering.declaredOrder, taskIds: ["10", "10"] }),
    /task/,
  );
});

test("task resolution accepts only matching admitted packets", () => {
  const experiment = fixture("experiment.18-cell.v1.json") as { taskSet: TaskConditionSet };
  const resolutions = admittedResolutions(experiment.taskSet);

  assert.doesNotThrow(() => assertAdmittedTaskPackets(experiment.taskSet, resolutions));

  const unresolved = { ...resolutions };
  delete unresolved["task-a"];
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, unresolved), /task-a.*did not resolve/);

  for (const status of ["proposed", "rejected"] as const) {
    resolutions["task-a"] = {
      ...resolutions["task-a"],
      admission: { status, reviewedAt: null },
    };
    assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, resolutions), /task-a.*not admitted/);
  }

  resolutions["task-a"] = {
    digest: { algorithm: "sha256", value: "0".repeat(64) },
    preAdmissionDigest: { algorithm: "sha256", value: "0".repeat(64) },
    reviewRecordDigest: experiment.taskSet["task-a"]!.packetRef.digest,
    resolvedReviewRecordDigest: experiment.taskSet["task-a"]!.packetRef.digest,
    reviewRecordPreAdmissionDigest: { algorithm: "sha256", value: "0".repeat(64) },
    controlledPerturbation: {
      declaration: { status: "referenced", digest: experiment.taskSet["task-a"]!.packetRef.digest },
      resolvedDigest: experiment.taskSet["task-a"]!.packetRef.digest,
    },
    referenceSolution: {
      declaration: { status: "referenced", digest: experiment.taskSet["task-a"]!.packetRef.digest },
      resolvedDigest: experiment.taskSet["task-a"]!.packetRef.digest,
    },
    verifierDigest: experiment.taskSet["task-a"]!.packetRef.digest,
    resolvedVerifierDigest: experiment.taskSet["task-a"]!.packetRef.digest,
    admission: { status: "admitted", reviewedAt: "2026-08-26T00:00:00Z" },
  };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, resolutions), /task-a.*digest/);

  const staleReview = admittedResolutions(experiment.taskSet);
  staleReview["task-a"] = {
    ...staleReview["task-a"],
    preAdmissionDigest: { algorithm: "sha256", value: "0".repeat(64) },
  };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, staleReview), /reviewed pre-admission packet digest/);

  const malformedReview = admittedResolutions(experiment.taskSet);
  malformedReview["task-a"]!.admission.reviewedAt = "2025-02-29T00:00:00Z";
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, malformedReview), /RFC 3339/);

  const lowercaseReview = admittedResolutions(experiment.taskSet);
  lowercaseReview["task-a"]!.admission.reviewedAt = "2026-08-26t00:00:00z";
  assert.doesNotThrow(() => assertAdmittedTaskPackets(experiment.taskSet, lowercaseReview));

  const leapSecondReview = admittedResolutions(experiment.taskSet);
  leapSecondReview["task-a"]!.admission.reviewedAt = "2016-12-31T23:59:60Z";
  assert.doesNotThrow(() => assertAdmittedTaskPackets(experiment.taskSet, leapSecondReview));

  const offsetLeapSecondReview = admittedResolutions(experiment.taskSet);
  offsetLeapSecondReview["task-a"]!.admission.reviewedAt = "2017-01-01T00:59:60+01:00";
  assert.doesNotThrow(() => assertAdmittedTaskPackets(experiment.taskSet, offsetLeapSecondReview));

  const impossibleLeapSecondReview = admittedResolutions(experiment.taskSet);
  impossibleLeapSecondReview["task-a"]!.admission.reviewedAt = "2026-08-26T12:34:60Z";
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, impossibleLeapSecondReview), /RFC 3339/);

  const tamperedVerifier = admittedResolutions(experiment.taskSet);
  tamperedVerifier["task-a"]!.resolvedVerifierDigest = { algorithm: "sha256", value: "0".repeat(64) };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, tamperedVerifier), /verifier digest/);

  const tamperedPerturbation = admittedResolutions(experiment.taskSet);
  tamperedPerturbation["task-a"]!.controlledPerturbation = {
    declaration: { status: "referenced", digest: experiment.taskSet["task-a"]!.packetRef.digest },
    resolvedDigest: { algorithm: "sha256", value: "0".repeat(64) },
  };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, tamperedPerturbation), /controlled perturbation digest/);

  const unresolvedReferencedPerturbation = admittedResolutions(experiment.taskSet);
  unresolvedReferencedPerturbation["task-a"]!.controlledPerturbation = {
    declaration: { status: "referenced", digest: experiment.taskSet["task-a"]!.packetRef.digest },
    resolvedDigest: null,
  };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, unresolvedReferencedPerturbation), /controlled perturbation digest/);

  const tamperedReviewRecord = admittedResolutions(experiment.taskSet);
  tamperedReviewRecord["task-a"]!.resolvedReviewRecordDigest = { algorithm: "sha256", value: "0".repeat(64) };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, tamperedReviewRecord), /review record digest/);

  const unboundReviewRecord = admittedResolutions(experiment.taskSet);
  unboundReviewRecord["task-a"]!.reviewRecordPreAdmissionDigest = { algorithm: "sha256", value: "0".repeat(64) };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, unboundReviewRecord), /reviewed pre-admission packet digest/);

  const tamperedReferenceSolution = admittedResolutions(experiment.taskSet);
  tamperedReferenceSolution["task-a"]!.referenceSolution = {
    declaration: { status: "referenced", digest: experiment.taskSet["task-a"]!.packetRef.digest },
    resolvedDigest: { algorithm: "sha256", value: "0".repeat(64) },
  };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, tamperedReferenceSolution), /reference solution digest/);

  const unavailableOptionalArtifacts = admittedResolutions(experiment.taskSet);
  unavailableOptionalArtifacts["task-a"]!.controlledPerturbation = {
    declaration: { status: "not-applied" },
    resolvedDigest: null,
  };
  unavailableOptionalArtifacts["task-a"]!.referenceSolution = {
    declaration: { status: "not-provided" },
    resolvedDigest: null,
  };
  assert.doesNotThrow(() => assertAdmittedTaskPackets(experiment.taskSet, unavailableOptionalArtifacts));

  const constructorTaskSet = Object.assign(Object.create(null), {
    constructor: experiment.taskSet["task-a"],
  }) as TaskConditionSet;
  assert.throws(
    () => assertAdmittedTaskPackets(constructorTaskSet, {}),
    /constructor.*did not resolve/,
  );

  const duplicateTaskSet = {
    ...experiment.taskSet,
    "task-d": experiment.taskSet["task-a"],
  } as TaskConditionSet;
  assert.throws(
    () => assertAdmittedTaskPackets(duplicateTaskSet, admittedResolutions(duplicateTaskSet)),
    /task-d.*duplicates/,
  );
});
