import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";

import {
  assertAdmittedTaskPackets,
  assertControlledPerturbationDigest,
  assertDeclaredOrder,
  assertNoSelectedSymlinks,
  assertResolvedExperimentConfigurationDigests,
  declaredMatrixCells,
  type ArtifactReference,
  type Digest,
  type ExperimentConfiguration,
  type DeclaredOrder,
  type ResolvedTaskPacket,
  type TaskConditionSet,
} from "../src/contracts.js";

const addFormats = formats.default as unknown as (instance: Ajv2020) => void;

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", name), "utf8"));
const schema = (name: string): object =>
  JSON.parse(readFileSync(join(repositoryRoot, "schemas", name), "utf8"));

function validator(schemaName: string): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true });

  addFormats(ajv);
  return ajv.compile(schema(schemaName));
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
  return Object.fromEntries(
    Object.entries(taskSet).map(([taskId, condition]) => [
      taskId,
      { digest: condition.packetRef.digest, reviewedDigest: condition.packetRef.digest, admission: { status: "admitted" } },
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
        source: { kind: string; digest: object };
        materializer: { kind: string; includePaths: string[] };
      };
    };
    restricted: { referenceSolution: object };
  };
  const validate = validator("task-packet.v1.schema.json");

  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(packet.agentInput.fixture.source.kind, "sanitized-archive");
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

  const explicitPort = structuredClone(admitted) as Document;
  (explicitPort.provenance as Document).repositoryUrl = "https://git.example.test:8443/org/repository.git";
  assert.equal(validate(explicitPort), true, JSON.stringify(validate.errors));

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

test("literal archive selection rejects every symlink entry", () => {
  assert.doesNotThrow(() => assertNoSelectedSymlinks([
    { path: "src", kind: "directory" },
    { path: "src/index.ts", kind: "file" },
  ]));
  assert.throws(
    () => assertNoSelectedSymlinks([{ path: "src/config", kind: "symlink" }]),
    /src\/config.*unsafe/,
  );
  assert.throws(
    () => assertNoSelectedSymlinks([{ path: "src/../../restricted/verifier.json", kind: "file" }]),
    /unsafe/,
  );
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
      admission: { status },
    };
    assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, resolutions), /task-a.*not admitted/);
  }

  resolutions["task-a"] = {
    digest: { algorithm: "sha256", value: "0".repeat(64) },
    reviewedDigest: { algorithm: "sha256", value: "0".repeat(64) },
    admission: { status: "admitted" },
  };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, resolutions), /task-a.*digest/);

  const staleReview = admittedResolutions(experiment.taskSet);
  staleReview["task-a"] = { ...staleReview["task-a"], digest: { algorithm: "sha256", value: "0".repeat(64) } };
  assert.throws(() => assertAdmittedTaskPackets(experiment.taskSet, staleReview), /review does not match/);

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
