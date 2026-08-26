import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", name), "utf8"));
const schema = (name: string): object =>
  JSON.parse(readFileSync(join(repositoryRoot, "schemas", name), "utf8"));

function validator(schemaName: string): ValidateFunction {
  return new Ajv2020({ allErrors: true }).compile(schema(schemaName));
}

function expectInvalid(validate: ValidateFunction, document: unknown, field: string): void {
  assert.equal(validate(document), false);
  assert.match(JSON.stringify(validate.errors ?? []), new RegExp(field));
}

type InvalidCase = {
  field: string;
  operation: "remove" | "replace";
  path: string[];
  value?: unknown;
};

function applyInvalidCase(packet: Record<string, unknown>, invalidCase: InvalidCase): unknown {
  const document = structuredClone(packet) as Record<string, unknown>;
  const parent = invalidCase.path.slice(0, -1).reduce<Record<string, unknown>>(
    (value, key) => value[key] as Record<string, unknown>,
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
  taskSet: unknown[];
  modelSet: unknown[];
  harnessSet: unknown[];
  trialCount: number;
}): number {
  return experiment.taskSet.length * experiment.modelSet.length * experiment.harnessSet.length * experiment.trialCount;
}

test("task packets preserve a public materialization surface", () => {
  const packet = fixture("task-packet.valid.v1.json") as {
    agentInput: { fixture: { materializer: { excludedSurfaces: string[] } } };
    restricted: object;
  };
  const validate = validator("task-packet.v1.schema.json");

  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    Object.keys(JSON.parse(JSON.stringify(packet.agentInput))).sort(),
    ["fixture", "prompt"],
  );
  assert.deepEqual(
    packet.agentInput.fixture.materializer.excludedSurfaces.sort(),
    ["referenceSolution", "reviewRecord", "verifier"],
  );
  assert.deepEqual(Object.keys(packet.restricted).sort(), ["referenceSolution", "reviewRecord", "verifier"]);
});

test("task packet validation fails closed for required evidence and versions", () => {
  const validate = validator("task-packet.v1.schema.json");
  const valid = fixture("task-packet.valid.v1.json") as Record<string, unknown>;

  for (const invalidCase of fixture("task-packet.invalid-cases.v1.json") as InvalidCase[]) {
    expectInvalid(validate, applyInvalidCase(valid, invalidCase), invalidCase.field);
  }
});

test("experiment fixtures describe variable-sized matrices as data", () => {
  const validate = validator("experiment.v1.schema.json");
  const eighteen = fixture("experiment.18-cell.v1.json") as Parameters<typeof expandMatrix>[0];
  const twentyFour = fixture("experiment.24-cell.v1.json") as Parameters<typeof expandMatrix>[0];

  assert.equal(validate(eighteen), true, JSON.stringify(validate.errors));
  assert.equal(validate(twentyFour), true, JSON.stringify(validate.errors));
  assert.equal(expandMatrix(eighteen), 18);
  assert.equal(expandMatrix(twentyFour), 24);
});
