import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalizeMetadata,
  compileRunQueue,
  inspectRunQueue,
  LocalRunQueue,
  readRunQueue,
  validateRunQueue,
  writeRunQueue,
  type ExperimentConfiguration,
  type FrozenTaskInput,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function fixture(name: string): ExperimentConfiguration {
  return JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", name), "utf8")) as ExperimentConfiguration;
}

function compileOptions(experiment: ExperimentConfiguration): {
  resolvedDigests: Record<string, ExperimentConfiguration["captureProfile"]["digest"]>;
  frozenTasks: Record<string, FrozenTaskInput>;
  permutationAlgorithms?: Record<string, unknown>;
} {
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
  const frozenTasks = Object.fromEntries(
    Object.entries(experiment.taskSet).map(([id, condition], index) => [id, {
      packetId: id,
      packetLocator: condition.packetRef.locator,
      packetDigest: condition.packetRef.digest,
      freezeLocator: `${condition.packetRef.locator}.freeze.json`,
      aggregateDigest: { algorithm: "sha256", value: String(index + 1).padStart(64, "0") },
    }]),
  ) as Record<string, FrozenTaskInput>;
  const options = {
    resolvedDigests: Object.fromEntries(references.map((reference) => [reference.locator, reference.digest])),
    frozenTasks,
  };
  if (experiment.ordering.strategy === "permuted" && experiment.ordering.permutationAlgorithmRef !== undefined) {
    return {
      ...options,
      permutationAlgorithms: { [experiment.ordering.permutationAlgorithmRef.locator]: "fisher-yates-v1" },
    };
  }
  return options;
}

function withOrdering(
  source: ExperimentConfiguration,
  strategy: "sequential" | "seeded-shuffle" | "balanced",
): ExperimentConfiguration {
  const experiment = structuredClone(source);
  const declaredOrder = {
    taskIds: Object.keys(experiment.taskSet),
    modelIds: Object.keys(experiment.modelSet),
    harnessIds: Object.keys(experiment.harnessSet),
  };
  experiment.ordering = strategy === "sequential"
    ? { seed: "fixed", strategy, declaredOrder }
    : strategy === "seeded-shuffle"
      ? { seed: "fixed", strategy }
      : { seed: "fixed", strategy, declaredOrder, balanceBy: "model" };
  return experiment;
}

test("compiles arbitrary matrices with stable serialized identities", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const options = compileOptions(experiment);
  const first = compileRunQueue(experiment, options);
  const second = compileRunQueue(structuredClone(experiment), compileOptions(experiment));

  assert.equal(first.entries.length, 18);
  assert.equal(canonicalizeMetadata(first), canonicalizeMetadata(second));
  assert.equal(new Set(first.entries.map((entry) => entry.runId)).size, 18);
  assert.equal(first.entries[0]!.task.packetRef.digest.value, "a".repeat(64));
  assert.equal(first.entries[0]!.configuration.model.digest.value, "d".repeat(64));
  assert.deepEqual(first.captureProfile, experiment.captureProfile);
  assert.equal(first.entries[0]!.trial.index, first.entries[0]!.trialIndex);

  const twentyFour = fixture("experiment.24-cell.v1.json");
  const queue = compileRunQueue(twentyFour, compileOptions(twentyFour));
  assert.equal(queue.entries.length, 24);
  assert.deepEqual(
    queue.entries.slice(0, 4).map(({ taskId, modelId, harnessId, trialIndex }) => ({ taskId, modelId, harnessId, trialIndex })),
    [
      { taskId: "10", modelId: "model-a", harnessId: "harness-a", trialIndex: 1 },
      { taskId: "10", modelId: "model-a", harnessId: "harness-a", trialIndex: 2 },
      { taskId: "10", modelId: "model-a", harnessId: "harness-b", trialIndex: 1 },
      { taskId: "10", modelId: "model-a", harnessId: "harness-b", trialIndex: 2 },
    ],
  );
});

test("sequential, seeded-shuffle, and balanced ordering are reproducible", () => {
  for (const strategy of ["sequential", "seeded-shuffle", "balanced"] as const) {
    const experiment = withOrdering(fixture("experiment.24-cell.v1.json"), strategy);
    const queue = compileRunQueue(experiment, compileOptions(experiment));
    assert.equal(validateRunQueue(queue).length, 0);
    assert.equal(queue.ordering.strategy, strategy);
    assert.deepEqual(
      queue.entries.map(({ runId }) => runId),
      compileRunQueue(experiment, compileOptions(experiment)).entries.map(({ runId }) => runId),
    );
  }

  const oddGroups = compileRunQueue(
    withOrdering(fixture("experiment.18-cell.v1.json"), "balanced"),
    compileOptions(withOrdering(fixture("experiment.18-cell.v1.json"), "balanced")),
  );
  assert.equal(oddGroups.entries.filter((entry) => entry.modelId === "model-a").length, 9);
  assert.equal(oddGroups.entries.filter((entry) => entry.modelId === "model-b").length, 9);
  for (let index = 1; index < oddGroups.entries.length; index += 1) {
    assert.notEqual(oddGroups.entries[index]!.modelId, oddGroups.entries[index - 1]!.modelId);
  }

  const evenExperiment = withOrdering(fixture("experiment.24-cell.v1.json"), "balanced");
  const evenGroups = compileRunQueue(evenExperiment, compileOptions(evenExperiment));
  for (let index = 0; index < evenGroups.entries.length; index += 3) {
    assert.deepEqual(evenGroups.entries.slice(index, index + 3).map((entry) => entry.modelId), ["model-a", "model-b", "model-c"]);
  }
});

test("matrix compilation rejects unfrozen, duplicate, and unresolved inputs", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const options = compileOptions(experiment);
  const missing = { ...options.frozenTasks };
  delete missing["task-a"];
  assert.throws(() => compileRunQueue(experiment, { ...options, frozenTasks: missing }), /task-a.*no frozen record/);

  const duplicate = structuredClone(experiment);
  duplicate.taskSet["task-b"]!.packetRef = duplicate.taskSet["task-a"]!.packetRef;
  const duplicateOptions = compileOptions(duplicate);
  assert.throws(() => compileRunQueue(duplicate, duplicateOptions), /task-b.*duplicates a packet digest/);

  const unresolved = compileOptions(experiment);
  unresolved.resolvedDigests["models/model-a.json"] = { algorithm: "sha256", value: "0".repeat(64) };
  assert.throws(() => compileRunQueue(experiment, unresolved), /model "model-a" digest/);

  const unsupported = compileOptions(experiment);
  unsupported.permutationAlgorithms = {
    [experiment.ordering.strategy === "permuted" ? experiment.ordering.permutationAlgorithmRef!.locator : "algorithm.json"]: "unknown",
  };
  assert.throws(() => compileRunQueue(experiment, unsupported), /Unsupported permutation algorithm/);
});

test("queue validation binds entry references to the supplied experiment", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(experiment, compileOptions(experiment));
  const altered = structuredClone(queue);
  altered.entries[0]!.task.packetRef = structuredClone(altered.entries[1]!.task.packetRef);
  altered.entries[0]!.configuration.model = structuredClone(altered.entries[0]!.model.configurationRef);
  assert.match(validateRunQueue(altered, experiment).map((error) => error.message).join("\n"), /Task packet reference/);
});

test("a persisted local queue is validated and consumed in order", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(experiment, compileOptions(experiment));
  const root = mkdtempSync(join(tmpdir(), "ebo-run-queue-"));
  try {
    const path = join(root, "queue.json");
    writeRunQueue(path, queue);
    assert.doesNotThrow(() => writeRunQueue(path, queue));
    assert.throws(() => writeRunQueue(path, { ...queue, seed: "changed" }), /different queue/);
    assert.equal(readFileSync(path, "utf8"), canonicalizeMetadata(queue));
    const loaded = readRunQueue(path, experiment);
    assert.deepEqual(inspectRunQueue(loaded), inspectRunQueue(queue));
    const local = new LocalRunQueue(loaded);
    assert.equal(local.remaining, 18);
    assert.equal(local.next()!.runId, queue.entries[0]!.runId);
    for (let index = 1; index < queue.entries.length; index += 1) local.next();
    assert.equal(local.remaining, 0);
    assert.equal(local.next(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
