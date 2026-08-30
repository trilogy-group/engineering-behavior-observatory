import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  canonicalizeMetadata,
  compileRunQueue,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  inspectRunQueue,
  LocalRunQueue,
  main,
  MAX_RUN_QUEUE_ENTRIES,
  readRunQueue,
  validateRunQueue,
  writeRunQueue,
  type ExperimentConfiguration,
  type FrozenTaskInput,
  type ResolvedTaskPacket,
  type TaskPacket,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function fixture(name: string): ExperimentConfiguration {
  return JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", name), "utf8")) as ExperimentConfiguration;
}

function fixtureArchive(): Buffer {
  const entries = [
    { path: "README.md", bytes: Buffer.from("# fixture\n") },
    { path: "package.json", bytes: Buffer.from("{}\n") },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n") },
  ];
  const blocks = entries.map(({ path, bytes, type = "0" }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function bundleFixture(): { root: string; experiment: ExperimentConfiguration } {
  const root = mkdtempSync(join(tmpdir(), "ebo-scheduler-bundle-"));
  const packet = JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", "task-packet.valid.v1.json"), "utf8")) as TaskPacket;
  const writeRef = (reference: { locator: string; digest: { algorithm: "sha256"; value: string } }, locator: string, bytes: Buffer) => {
    reference.locator = locator;
    reference.digest = digestBytes(bytes);
    const path = join(root, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };

  writeRef(packet.agentInput.fixture.source, "components/fixture.tar.gz", fixtureArchive());
  if (!("reference" in packet.controlledPerturbation) || !("locator" in packet.restricted.referenceSolution)) {
    throw new Error("Fixture packet must include referenced components.");
  }
  writeRef(packet.controlledPerturbation.reference, "components/perturbation.json", Buffer.from("{\"kind\":\"controlled\"}\n"));
  writeRef(packet.restricted.referenceSolution, "components/reference.txt", Buffer.from("reference solution\n"));
  writeRef(packet.restricted.verifier, "components/verifier.sh", Buffer.from("#!/bin/sh\nexit 0\n"));
  const preAdmission = structuredClone(packet) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  const review = Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: packet.admission.status,
    reviewedAt: packet.admission.review!.reviewedAt,
    reviewedBy: packet.admission.review!.reviewedBy,
  }));
  writeRef(packet.admission.review!.reviewRecord, "components/review.json", review);
  const packetPath = join(root, "packets/task-a.json");
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(packet));
  const freezeLocator = "freezes/task-a.json";
  freezeTaskPacket(root, "packets/task-a.json", freezeLocator);

  const experiment = fixture("experiment.18-cell.v1.json");
  experiment.id = "bundle-fixture";
  experiment.taskSet = {
    "task-a": { packetRef: { locator: "packets/task-a.json", digest: digestMetadata(packet) } },
  };
  experiment.modelSet = { "model-a": experiment.modelSet["model-a"]! };
  experiment.harnessSet = { "harness-a": experiment.harnessSet["harness-a"]! };
  experiment.trialCount = 1;
  experiment.ordering = {
    seed: "bundle-seed",
    strategy: "permuted",
    permutationAlgorithmRef: { locator: "algorithms/fisher-yates-v1.json", digest: digestBytes(Buffer.from("{\"algorithm\":\"fisher-yates-v1\"}")) },
  };
  writeRef(experiment.modelSet["model-a"]!.configurationRef, "configs/model.json", Buffer.from("{}"));
  writeRef(experiment.harnessSet["harness-a"]!.configurationRef, "configs/harness.json", Buffer.from("{}"));
  writeRef(experiment.harnessSet["harness-a"]!.nativeLimitsRef, "configs/limits.json", Buffer.from("{}"));
  writeRef(experiment.harnessSet["harness-a"]!.nativeToolPolicyRef, "configs/tools.json", Buffer.from("{}"));
  writeRef(experiment.captureProfile, "configs/capture.json", Buffer.from("{}"));
  const algorithm = Buffer.from("{\"algorithm\":\"fisher-yates-v1\"}");
  if (experiment.ordering.strategy !== "permuted" || experiment.ordering.permutationAlgorithmRef === undefined) {
    throw new Error("Fixture experiment must use a pinned permutation reference.");
  }
  writeRef(experiment.ordering.permutationAlgorithmRef, "algorithms/fisher-yates-v1.json", algorithm);
  return { root, experiment };
}

function compileOptions(
  experiment: ExperimentConfiguration,
  permutationDefinition = Buffer.from("{\"algorithm\":\"fisher-yates-v1\"}"),
): {
  resolvedDigests: Record<string, ExperimentConfiguration["captureProfile"]["digest"]>;
  frozenTasks: Record<string, FrozenTaskInput>;
  resolvedPackets: Record<string, ResolvedTaskPacket>;
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
    Object.entries(experiment.taskSet).map(([id, condition]) => {
      const preAdmissionDigest = { algorithm: "sha256" as const, value: "1".repeat(64) };
      const packetLocator = condition.packetRef.locator;
      const packetDigest = condition.packetRef.digest;
      const frozenAt = "2026-08-26T00:00:00Z";
      const components = {
        prompt: packetDigest,
        fixture: packetDigest,
        reference: { status: "not-provided" as const },
        verifier: packetDigest,
        reviewRecord: packetDigest,
        controlledPerturbation: { status: "not-applied" as const },
      };
      return [id, {
        schemaVersion: "ebo.task-packet-freeze/v1" as const,
        packetId: id,
        packetLocator,
        preAdmissionDigest,
        packetDigest,
        components,
        aggregateDigest: digestMetadata({ packetId: id, packetLocator, preAdmissionDigest, packetDigest, components, frozenAt }),
        frozenAt,
      }];
    }),
  ) as Record<string, FrozenTaskInput>;
  const resolvedPackets = Object.fromEntries(
    Object.entries(experiment.taskSet).map(([id, condition]) => [id, {
      packetId: id,
      digest: condition.packetRef.digest,
      preAdmissionDigest: { algorithm: "sha256", value: "1".repeat(64) },
      reviewRecordDigest: condition.packetRef.digest,
      resolvedReviewRecordDigest: condition.packetRef.digest,
      reviewRecordPreAdmissionDigest: { algorithm: "sha256", value: "1".repeat(64) },
      controlledPerturbation: {
        declaration: { status: "not-applied" as const },
        resolvedDigest: null,
      },
      referenceSolution: {
        declaration: { status: "not-provided" as const },
        resolvedDigest: null,
      },
      verifierDigest: condition.packetRef.digest,
      resolvedVerifierDigest: condition.packetRef.digest,
      admission: { status: "admitted" as const, reviewedAt: "2026-08-26T00:00:00Z" },
      freezeRecord: frozenTasks[id],
    }]),
  ) as Record<string, ResolvedTaskPacket>;
  if (experiment.ordering.strategy === "permuted" && experiment.ordering.permutationAlgorithmRef !== undefined) {
    experiment.ordering.permutationAlgorithmRef.digest = digestBytes(permutationDefinition);
  }
  const options = {
    resolvedDigests: Object.fromEntries(references.map((reference) => [reference.locator, reference.digest])),
    frozenTasks,
    resolvedPackets,
  };
  if (experiment.ordering.strategy === "permuted" && experiment.ordering.permutationAlgorithmRef !== undefined) {
    return {
      ...options,
      permutationAlgorithms: { [experiment.ordering.permutationAlgorithmRef.locator]: permutationDefinition },
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
  assert.deepEqual(first.coordinatorBudget, experiment.coordinatorBudget);
  assert.equal(first.entries[0]!.trial.index, first.entries[0]!.trialIndex);

  const customFreezeQueue = compileRunQueue(experiment, {
    ...compileOptions(experiment),
    freezeLocators: { "task-a": "freezes/task-a.json" },
  });
  assert.equal(customFreezeQueue.entries.find((entry) => entry.taskId === "task-a")!.task.freezeLocator, "freezes/task-a.json");

  const changedExperiment = structuredClone(experiment);
  changedExperiment.captureProfile = {
    ...changedExperiment.captureProfile,
    digest: { algorithm: "sha256", value: "9".repeat(64) },
  };
  assert.notEqual(
    first.entries[0]!.runId,
    compileRunQueue(changedExperiment, compileOptions(changedExperiment)).entries[0]!.runId,
  );

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

  const missingAdmissionEvidence = compileOptions(experiment);
  delete missingAdmissionEvidence.resolvedPackets["task-a"]!.freezeRecord;
  assert.throws(
    () => compileRunQueue(experiment, missingAdmissionEvidence),
    /task-a.*no admitted freeze record/,
  );

  const forgedAdmissionEvidence = compileOptions(experiment);
  const forgedFreeze = structuredClone(forgedAdmissionEvidence.resolvedPackets["task-a"]!.freezeRecord!);
  forgedFreeze.packetId = "forged-task";
  forgedFreeze.aggregateDigest = digestMetadata({
    packetId: forgedFreeze.packetId,
    packetLocator: forgedFreeze.packetLocator,
    preAdmissionDigest: forgedFreeze.preAdmissionDigest,
    packetDigest: forgedFreeze.packetDigest,
    components: forgedFreeze.components,
    frozenAt: forgedFreeze.frozenAt,
  });
  forgedAdmissionEvidence.resolvedPackets["task-a"]!.freezeRecord = forgedFreeze;
  forgedAdmissionEvidence.frozenTasks["task-a"] = forgedFreeze;
  assert.throws(
    () => compileRunQueue(experiment, forgedAdmissionEvidence),
    /task-a.*not bound to its admitted packet evidence/,
  );

  const forgedComponentEvidence = compileOptions(experiment);
  const forgedComponents = structuredClone(forgedComponentEvidence.resolvedPackets["task-a"]!.freezeRecord!);
  forgedComponents.components.verifier = { algorithm: "sha256", value: "0".repeat(64) };
  forgedComponents.aggregateDigest = digestMetadata({
    packetId: forgedComponents.packetId,
    packetLocator: forgedComponents.packetLocator,
    preAdmissionDigest: forgedComponents.preAdmissionDigest,
    packetDigest: forgedComponents.packetDigest,
    components: forgedComponents.components,
    frozenAt: forgedComponents.frozenAt,
  });
  forgedComponentEvidence.frozenTasks["task-a"] = forgedComponents;
  assert.throws(
    () => compileRunQueue(experiment, forgedComponentEvidence),
    /task-a.*supplied freeze record does not match/,
  );

  const duplicate = structuredClone(experiment);
  duplicate.taskSet["task-b"]!.packetRef = duplicate.taskSet["task-a"]!.packetRef;
  const duplicateOptions = compileOptions(duplicate);
  assert.throws(() => compileRunQueue(duplicate, duplicateOptions), /task-b.*duplicates a packet digest/);

  const unresolved = compileOptions(experiment);
  unresolved.resolvedDigests["models/model-a.json"] = { algorithm: "sha256", value: "0".repeat(64) };
  assert.throws(() => compileRunQueue(experiment, unresolved), /model "model-a" digest/);

  const unknownExperiment = fixture("experiment.18-cell.v1.json");
  const unsupported = compileOptions(unknownExperiment, Buffer.from("{\"algorithm\":\"unknown\"}"));
  assert.throws(() => compileRunQueue(unknownExperiment, unsupported), /Unsupported permutation algorithm/);
  const unversionedExperiment = fixture("experiment.18-cell.v1.json");
  const unversioned = compileOptions(unversionedExperiment, Buffer.from("{\"algorithm\":\"fisher-yates\"}"));
  assert.throws(() => compileRunQueue(unversionedExperiment, unversioned), /Unsupported permutation algorithm/);
});

test("queue validation binds entry references to the supplied experiment", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(experiment, compileOptions(experiment));
  const altered = structuredClone(queue);
  altered.entries[0]!.task.packetRef = structuredClone(altered.entries[1]!.task.packetRef);
  altered.entries[0]!.configuration.model = structuredClone(altered.entries[0]!.model.configurationRef);
  assert.match(
    validateRunQueue(altered, experiment, "run-queue.json", compileOptions(experiment)).map((error) => error.message).join("\n"),
    /Task packet reference/,
  );
});

test("queue validation checks the supplied experiment and frozen task record", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(experiment, compileOptions(experiment));
  const altered = structuredClone(queue);
  altered.entries[0]!.task.packetId = "changed-task";
  assert.match(
    validateRunQueue(altered, experiment, "run-queue.json", compileOptions(experiment)).map((error) => error.message).join("\n"),
    /Frozen task identity/,
  );

  const invalidExperiment = structuredClone(experiment) as ExperimentConfiguration & { extra?: boolean };
  invalidExperiment.extra = true;
  assert.match(validateRunQueue(queue, invalidExperiment).map((error) => error.message).join("\n"), /must NOT have additional properties/);

  const unknownBytes = Buffer.from("{\"algorithm\":\"unknown\"}");
  const unsupported = compileOptions(experiment, unknownBytes);
  assert.match(
    validateRunQueue(queue, experiment, "run-queue.json", unsupported).map((error) => error.message).join("\n"),
    /Unsupported permutation algorithm/,
  );

  const rejectedPackets = compileOptions(experiment).resolvedPackets;
  rejectedPackets["task-a"]!.admission = { status: "rejected", reviewedAt: null };
  assert.match(
    validateRunQueue(queue, experiment, "run-queue.json", { resolvedPackets: rejectedPackets })
      .map((error) => error.message).join("\n"),
    /not admitted/,
  );
});

test("oversized matrices fail before eager expansion", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  experiment.trialCount = MAX_RUN_QUEUE_ENTRIES + 1;
  assert.throws(() => compileRunQueue(experiment), /local queue limit/);

  const normalExperiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(normalExperiment, compileOptions(normalExperiment));
  assert.match(validateRunQueue(queue, experiment).map((error) => error.message).join("\n"), /local queue limit/);
  const oversizedQueue = compileRunQueue(normalExperiment, compileOptions(normalExperiment));
  oversizedQueue.matrix.trialCount = MAX_RUN_QUEUE_ENTRIES + 1;
  assert.match(validateRunQueue(oversizedQueue).map((error) => error.message).join("\n"), /local queue limit/);
});

test("strategy-inapplicable ordering fields are rejected", () => {
  const experiment = fixture("experiment.18-cell.v1.json") as ExperimentConfiguration & { ordering: Record<string, unknown> };
  experiment.ordering = {
    seed: "fixed",
    strategy: "sequential",
    declaredOrder: {
      taskIds: Object.keys(experiment.taskSet),
      modelIds: Object.keys(experiment.modelSet),
      harnessIds: Object.keys(experiment.harnessSet),
    },
    balanceBy: "model",
  };
  assert.match(validateRunQueue(experiment).map((error) => error.message).join("\n"), /must NOT be valid/);
});

test("standalone queue ordering rejects inapplicable fields", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(experiment, compileOptions(experiment));
  const invalid = structuredClone(queue);
  invalid.ordering.balanceBy = "model";
  assert.match(validateRunQueue(invalid).map((error) => error.message).join("\n"), /must NOT be valid/);
});

test("standalone queues reject conflicting identities for one condition ID", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(experiment, compileOptions(experiment));
  const invalid = structuredClone(queue);
  const sameModel = invalid.entries.find((entry, index) => index > 0 && entry.modelId === invalid.entries[0]!.modelId)!;
  const otherModel = invalid.entries.find((entry) => entry.modelId !== sameModel.modelId)!;
  sameModel.model.configurationRef = structuredClone(otherModel.model.configurationRef);
  sameModel.configuration.model = structuredClone(otherModel.model.configurationRef);
  assert.match(validateRunQueue(invalid).map((error) => error.message).join("\n"), /Conflicting model identity/);

  const conflictingLocator = structuredClone(queue);
  conflictingLocator.captureProfile = {
    locator: conflictingLocator.entries[0]!.model.configurationRef.locator,
    digest: { algorithm: "sha256", value: "0".repeat(64) },
  };
  assert.match(validateRunQueue(conflictingLocator).map((error) => error.message).join("\n"), /conflicting digests/);

  const missingEntry = structuredClone(queue);
  missingEntry.entries.pop();
  assert.match(validateRunQueue(missingEntry).map((error) => error.message).join("\n"), /persisted matrix/);
  const reordered = structuredClone(queue);
  [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1]!, reordered.entries[0]!];
  assert.match(validateRunQueue(reordered).map((error) => error.message).join("\n"), /persisted ordering/);

  const alteredPolicy = structuredClone(queue);
  alteredPolicy.ordering = { strategy: "balanced", balanceBy: "model" };
  assert.match(validateRunQueue(alteredPolicy).map((error) => error.message).join("\n"), /Scheduling digest/);
});

test("queue validation rejects another valid artifact schema", () => {
  assert.match(
    validateRunQueue(fixture("experiment.18-cell.v1.json")).map((error) => error.message).join("\n"),
    /Expected an ebo.run-queue\/v1 artifact/,
  );
});

test("bundle-root queue validation rechecks real frozen sources", () => {
  const { root, experiment } = bundleFixture();
  try {
    const experimentPath = join(root, "experiment.json");
    const cliQueuePath = join(root, "queue-cli.json");
    writeFileSync(experimentPath, canonicalizeMetadata(experiment));
    let output = "";
    assert.equal(
      main([
        "matrix",
        "compile",
        experimentPath,
        root,
        cliQueuePath,
        "--freeze-locator",
        "task-a=freezes/task-a.json",
      ], (message) => (output += message)),
      0,
    );
    assert.match(output, /Compiled 1 run entry/);

    const queue = compileRunQueue(experiment, {
      bundleRoot: root,
      freezeLocators: { "task-a": "freezes/task-a.json" },
    });
    assert.deepEqual(validateRunQueue(queue, undefined, "queue.json", { bundleRoot: root }), []);
    assert.deepEqual(validateRunQueue(queue, experiment, "queue.json", { bundleRoot: root }), []);

    for (const ordering of [
      { seed: "bundle-seed", strategy: "sequential" as const },
      { seed: "bundle-seed", strategy: "balanced" as const, balanceBy: "model" as const },
    ]) {
      const variant = { ...structuredClone(experiment), ordering };
      const variantQueue = compileRunQueue(variant, {
        bundleRoot: root,
        freezeLocators: { "task-a": "freezes/task-a.json" },
      });
      assert.deepEqual(validateRunQueue(variantQueue, variant, "queue.json", { bundleRoot: root }), []);
    }

    writeFileSync(join(root, "configs/model.json"), "changed");
    assert.match(
      validateRunQueue(queue, undefined, "queue.json", { bundleRoot: root }).map((error) => error.message).join("\n"),
      /digest does not match/,
    );

    writeFileSync(join(root, "configs/model.json"), "{}");
    const packetPath = join(root, "packets/task-a.json");
    const originalPacket = readFileSync(packetPath);
    const changedPacket = JSON.parse(originalPacket.toString("utf8")) as TaskPacket;
    changedPacket.agentInput.prompt = "stale after freeze";
    writeFileSync(packetPath, JSON.stringify(changedPacket));
    assert.match(
      validateRunQueue(queue, undefined, "queue.json", { bundleRoot: root }).map((error) => error.message).join("\n"),
      /Task packet is not frozen/,
    );
    writeFileSync(packetPath, originalPacket);

    const unknownAlgorithm = Buffer.from("{\"algorithm\":\"unknown\"}");
    writeFileSync(join(root, "algorithms/fisher-yates-v1.json"), unknownAlgorithm);
    const invalidAlgorithmQueue = structuredClone(queue);
    invalidAlgorithmQueue.ordering.permutationAlgorithmRef!.digest = digestBytes(unknownAlgorithm);
    assert.match(
      validateRunQueue(invalidAlgorithmQueue, undefined, "queue.json", { bundleRoot: root }).map((error) => error.message).join("\n"),
      /Unsupported permutation algorithm/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted local queue is validated and consumed in order", () => {
  const experiment = fixture("experiment.18-cell.v1.json");
  const queue = compileRunQueue(experiment, compileOptions(experiment));
  const root = mkdtempSync(join(tmpdir(), "ebo-run-queue-"));
  try {
    const path = join(root, "queue.json");
    const experimentPath = join(root, "experiment.json");
    writeFileSync(experimentPath, canonicalizeMetadata(experiment));
    writeRunQueue(path, queue);
    assert.doesNotThrow(() => writeRunQueue(path, queue));
    const alteredExperiment = structuredClone(experiment);
    alteredExperiment.coordinatorBudget.maxWallClockMs += 1;
    const alteredQueue = compileRunQueue(alteredExperiment, compileOptions(alteredExperiment));
    assert.throws(() => writeRunQueue(path, alteredQueue), /different queue/);
    const alteredControls = structuredClone(queue);
    alteredControls.coordinatorBudget.maxWallClockMs += 1;
    assert.match(validateRunQueue(alteredControls).map((error) => error.message).join("\n"), /Scheduling digest/);
    assert.throws(() => new LocalRunQueue(alteredControls), /Scheduling digest/);
    assert.equal(readFileSync(path, "utf8"), canonicalizeMetadata(queue));
    const loaded = readRunQueue(path, experiment, compileOptions(experiment));
    let output = "";
    assert.equal(main(["queue", "validate", path, experimentPath], (message) => (output += message)), 0);
    assert.match(output, /Validated run queue/);
    assert.equal(main(["queue", "validate", path, "--bundle-root"], () => undefined), 1);
    assert.equal(main(["matrix", "compile", experimentPath, "--bundle-root"], () => undefined), 1);
    assert.deepEqual(inspectRunQueue(loaded), inspectRunQueue(queue));
    const local = new LocalRunQueue(loaded);
    assert.equal(local.remaining, 18);
    local.queue.entries[0]!.task.packetId = "caller-mutation";
    const dequeued = local.next()!;
    dequeued.task.packetId = "dequeued-mutation";
    assert.equal(dequeued.runId, queue.entries[0]!.runId);
    assert.equal(local.queue.entries[0]!.task.packetId, queue.entries[0]!.task.packetId);
    for (let index = 1; index < queue.entries.length; index += 1) local.next();
    assert.equal(local.remaining, 0);
    assert.equal(local.next(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
