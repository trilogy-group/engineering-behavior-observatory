import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";

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

test("task packets expose only a verified, allowlisted materialization surface", () => {
  const packet = fixture("task-packet.valid.v1.json") as {
    agentInput: {
      fixture: {
        source: { kind: string; digest: object };
        materializer: { kind: string; includePaths: string[] };
      };
    };
    components: object;
    restricted: { referenceSolution: object };
  };
  const validate = validator("task-packet.v1.schema.json");

  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(packet.agentInput.fixture.source.kind, "sanitized-archive");
  assert.equal(packet.agentInput.fixture.materializer.kind, "verified-archive");
  assert.deepEqual(packet.agentInput.fixture.materializer.includePaths, ["README.md", "package.json", "src/**"]);
  assert.doesNotMatch(JSON.stringify(packet.agentInput), /referenceSolution|reviewRecord|verifier/);
  assert.deepEqual(Object.keys(packet.components), ["agentInput"]);
  assert.deepEqual(Object.keys(packet.restricted.referenceSolution).sort(), ["digest", "locator"]);
});

test("task packet validation rejects unsafe sources, missing evidence, and bad review states", () => {
  const validate = validator("task-packet.v1.schema.json");
  const admitted = fixture("task-packet.valid.v1.json") as Document;
  const proposed = fixture("task-packet.proposed.v1.json") as Document;

  assert.equal(validate(admitted), true, JSON.stringify(validate.errors));
  assert.equal(validate(proposed), true, JSON.stringify(validate.errors));

  for (const invalidCase of fixture("task-packet.invalid-cases.v1.json") as InvalidCase[]) {
    expectInvalid(validate, applyInvalidCase(admitted, invalidCase), invalidCase.field);
  }
});

test("experiment fixtures pin identity and preserve native harness limits", () => {
  const validate = validator("experiment.v1.schema.json");
  const eighteen = fixture("experiment.18-cell.v1.json") as Parameters<typeof expandMatrix>[0];
  const twentyFour = fixture("experiment.24-cell.v1.json") as Parameters<typeof expandMatrix>[0];

  assert.equal(validate(eighteen), true, JSON.stringify(validate.errors));
  assert.equal(validate(twentyFour), true, JSON.stringify(validate.errors));
  assert.equal(expandMatrix(eighteen), 18);
  assert.equal(expandMatrix(twentyFour), 24);
  assert.equal(new Set(Object.keys(eighteen.taskSet)).size, Object.keys(eighteen.taskSet).length);
  assert.equal("budgets" in eighteen, false);
  assert.ok((eighteen.harnessSet["harness-a"] as Document).nativeLimitsRef);
});

test("experiment validation rejects mutable references, duplicate-array conditions, and unsafe numbers", () => {
  const validate = validator("experiment.v1.schema.json");
  const experiment = fixture("experiment.18-cell.v1.json") as Document;

  for (const invalidCase of fixture("experiment.invalid-cases.v1.json") as InvalidCase[]) {
    expectInvalid(validate, applyInvalidCase(experiment, invalidCase), invalidCase.field);
  }
});
