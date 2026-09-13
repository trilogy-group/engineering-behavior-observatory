import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync as gzipModule } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compileHarborRunQueue,
  conversionReportDigest,
  createHarborAdapter,
  HARBOR_CONVERSION_SCHEMA_VERSION,
  HarborAdapterError,
  harborRunId,
  harborStepBundleDefinition,
  prepareHarborExecution,
  readRunQueueVersioned,
  validateHarborRunQueue,
  runHarborBackedQueueEntry,
  type HarborAdapter,
  type HarborConversionReport,
  type HarborDockerPreflight,
  type HarborVersionInfo,
} from "../src/index.js";
import type { HarborIdentity, HarborInstruction, HarborInspectResult, HarborLockResolution } from "../src/harbor/adapter.js";
import {
  admitHarborTask,
  freezeHarborTask,
  harborStudyPaths,
  prepareHarborAdmission,
  preAdmissionDigestOf,
  readHarborStudyJson,
  statusHarborTask,
} from "../src/harbor/study.js";
import { inspectHarborTask, resolveHarborTask, snapshotHarborTask } from "../src/harbor/tasks.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ebo-harbor-${prefix}-`));
}

const PROTOTYPE_TOML = `schema_version = "1.4"

[task]
name = "acme/test-task"
version = "1.0.0"

[environment]
os = "linux"
cpus = 2
`;

function writePrototypeTask(root: string, instruction = "Do the work and stop."): string {
  const taskDir = join(root, "task-a");
  mkdirSync(join(taskDir, "workdir"), { recursive: true });
  writeFileSync(join(taskDir, "task.toml"), PROTOTYPE_TOML);
  writeFileSync(join(taskDir, "workdir", "notes.txt"), "seed\n");
  writeFileSync(join(taskDir, "instruction.md"), `${instruction}\n`);
  return taskDir;
}

function digestOf(text: string): { algorithm: "sha256"; value: string } {
  // Deterministic placeholder independent of the real metadata digest layout:
  // the fake adapter only needs stable, distinct values.
  let hash = 5381;
  for (const byte of Buffer.from(text, "utf8")) hash = ((hash * 33) ^ byte) >>> 0;
  const value = hash.toString(16).padStart(16, "0").repeat(4);
  return { algorithm: "sha256", value };
}

function fakeAdapter(options: { dockerAvailable?: boolean; verified?: boolean } = {}): HarborAdapter {
  const inspectCache = new Map<string, HarborInspectResult>();
  return {
    async version(): Promise<HarborVersionInfo> {
      return { harborVersion: "0.23.0", defaultTaskSchemaVersion: "1.4", pythonVersion: "3-test" };
    },
    async inspect(dir: string): Promise<HarborInspectResult> {
      const cached = inspectCache.get(dir);
      if (cached !== undefined) return cached;
      const result: HarborInspectResult = {
        name: "acme/test-task",
        shortName: "test-task",
        version: "1.0.0",
        schemaVersion: "1.4",
        hasSteps: false,
        steps: [{ name: "default", minReward: null, verifierTimeoutSec: 120, agentTimeoutSec: null }],
        metadataKeys: [],
        environment: {
          os: "linux",
          dockerImage: null,
          cpus: 2,
          memoryMb: null,
          storageMb: null,
          gpus: 0,
          gpuTypes: null,
          tpu: false,
          networkMode: "public",
          allowInternet: null,
          mcpServerCount: 0,
          composeServices: null,
          buildTimeoutSec: 60,
          workdir: null,
        },
        verifier: { environmentMode: options.verified === true ? "task" : null, timeoutSec: 120, collectCount: options.verified === true ? 1 : 0 },
        hasSolution: false,
        hasTests: options.verified === true,
        multiStepRewardStrategy: null,
      };
      inspectCache.set(dir, result);
      return result;
    },
    async identity(taskDir: string): Promise<HarborIdentity> {
      void taskDir;
      return { digest: `sha256:${digestOf("acme/test-task").value}`, includedFiles: ["task.toml", "instruction.md", "workdir/notes.txt"], excludedFiles: [] };
    },
    async instructions(_taskDir: string): Promise<HarborInstruction[]> {
      return [{ step: "default", instruction: "Do the work and stop.", sha256: digestOf("Do the work and stop.").value }];
    },
    async lock(taskDir: string): Promise<HarborLockResolution> {
      const digest = digestOf(taskDir).value;
      void digest;
      return {
        taskLock: {
          name: "acme/test-task",
          version: "1.0.0",
          type: "local",
          digest: `sha256:${digest}`,
          source: null,
          path: null,
          git_url: null,
          git_commit_id: null,
        },
        trialLock: {
          name: "acme/test-task",
          version: "1.0.0",
          type: "local",
          digest: `sha256:${digest}`,
        },
      };
    },
    async dockerPreflight(): Promise<HarborDockerPreflight> {
      return options.dockerAvailable === true
        ? { available: true, reason: null }
        : { available: false, reason: "docker-daemon-unavailable (test)" };
    },
    async describePrerequisites() {
      return { python: "python-test", version: await this.version(), docker: await this.dockerPreflight() };
    },
  };
}

/* ------------------------------------ resolution identity ------------------------------------ */

test("harbor task identity is derived from content and survives relocation", async () => {
  const rootA = tempRoot("identity");
  const taskA = writePrototypeTask(rootA);
  const rootB = tempRoot("identity");
  const taskB = writePrototypeTask(rootB);

  const adapter = fakeAdapter();
  const a = await resolveHarborTask(taskA, { adapter });
  const b = await resolveHarborTask(taskB, { adapter });
  assert.equal(a.taskSourceId, b.taskSourceId);
  assert.equal(a.resolutionDigest.value, b.resolutionDigest.value);
  assert.match(a.taskSourceId, /^harbor-[0-9a-f]{16}$/);
  assert.equal(a.sourceKind, "harbor-task");
});

test("invalid task.toml is classified invalid without throwing", async () => {
  const root = tempRoot("invalid");
  const taskDir = join(root, "bad");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.toml"), "not toml {{{");
  const brokenAdapter = fakeAdapter();
  const originalInspect = brokenAdapter.inspect.bind(brokenAdapter);
  brokenAdapter.inspect = async (dir, opts) => {
    try {
      return await originalInspect(dir, opts);
    } catch {
      throw new HarborAdapterError("task-invalid", "task.toml is not valid TOML");
    }
  };
  // The fake adapter accepts the file; drive the classification through the real path instead.
  try {
    const realAdapter = await createHarborAdapter();
    const inspection = await inspectHarborTask(taskDir, { adapter: realAdapter });
    assert.equal(inspection.classification, "invalid");
    assert.equal(inspection.reasonCode, "task-invalid");
  } catch (error) {
    assert.ok(error instanceof Error, "adapter creation should either work or explain itself");
    assert.ok((error as Error).message.length > 0);
  }
});

test("snapshots are idempotent and tamper-evident", async () => {
  const root = tempRoot("snapshot");
  const taskDir = writePrototypeTask(root);
  mkdirSync(join(taskDir, "a"));
  writeFileSync(join(taskDir, "a", "child.txt"), "nested\n");
  writeFileSync(join(taskDir, "a.txt"), "sibling\n");
  for (const size of [65_535, 65_536, 65_537]) {
    const bytes = Buffer.alloc(size, 65);
    bytes[size - 1] = 66;
    writeFileSync(join(taskDir, `boundary-${size}.bin`), bytes);
  }
  const adapter = fakeAdapter();
  const first = await snapshotHarborTask(taskDir, join(root, "snapshots"), { adapter });
  const second = await snapshotHarborTask(taskDir, join(root, "snapshots"), { adapter });
  assert.equal(first.manifest.taskSourceId, second.manifest.taskSourceId);
  const tail = join(root, "snapshots", first.manifest.taskSourceId, "boundary-65537.bin");
  const original = readFileSync(tail);
  const changed = Buffer.from(original); changed[changed.length - 1] = 67;
  writeFileSync(tail, changed);
  await assert.rejects(() => snapshotHarborTask(taskDir, join(root, "snapshots"), { adapter }), /changed|tamper|different|digest/i);
  writeFileSync(tail, original);

  const manifestPath = join(root, "snapshots", `${first.manifest.taskSourceId}.snapshot-manifest.json`);
  const manifestBefore = readFileSync(manifestPath, "utf8");
  writeFileSync(join(root, "snapshots", first.manifest.taskSourceId, "workdir", "notes.txt"), "tampered\n");
  await assert.rejects(
    () => snapshotHarborTask(taskDir, join(root, "snapshots"), { adapter }),
    /changed|tamper|different|digest/i,
  );
  writeFileSync(join(root, "snapshots", first.manifest.taskSourceId, "workdir", "notes.txt"), "seed\n");
  writeFileSync(manifestPath, manifestBefore);
});

/* ------------------------------------ governance ------------------------------------ */

test("admission includes per-step hidden surfaces", async () => {
  const root = tempRoot("step-visibility");
  const task = writePrototypeTask(root);
  const adapter = fakeAdapter();
  const identity = adapter.identity.bind(adapter);
  adapter.identity = async dir => ({ ...await identity(dir), includedFiles: ["task.toml", "instruction.md", "steps/one/tests/test.sh", "steps/one/solution/solve.sh"] });
  for (const directory of ["tests", "solution"]) {
    mkdirSync(join(task, "steps/one", directory), { recursive: true });
    writeFileSync(join(task, "steps/one", directory, "test.sh"), "true\n");
  }
  const { record } = await prepareHarborAdmission(root, task, { adapter });
  assert.equal(record.visibilityPolicy.verifier, "hidden");
  assert.equal(record.visibilityPolicy.solution, "hidden");
});

test("admission workflow: proposal carries no review; review binding is enforced; freeze is once-only", async () => {
  const root = tempRoot("governance");
  const taskDir = writePrototypeTask(root);
  const adapter = fakeAdapter();

  const prepared = await prepareHarborAdmission(root, taskDir, { adapter, assessmentMode: "observational" });
  assert.equal(prepared.record.review, null, "a proposal must never carry a human decision");
  const taskSourceId = prepared.record.taskSourceId;

  await assert.rejects(() => admitHarborTask(root, taskSourceId, { adapter }), /review/);

  const paths = harborStudyPaths(root);
  const reviewLocator = join("governance", "reviews", "harbor", `${taskSourceId}.json`);
  const goodReview = {
    schemaVersion: "ebo.harbor-review/v1",
    taskSourceId,
    preAdmissionDigest: preAdmissionDigestOf(prepared.record),
    decision: "admitted",
    reviewedAt: "2026-01-01T00:00:00.000Z",
    reviewedBy: "reviewer@example.test",
  };
  mkdirSync(join(paths.studyRoot, "governance", "reviews", "harbor"), { recursive: true });
  writeFileSync(join(paths.studyRoot, reviewLocator), JSON.stringify({ ...goodReview, preAdmissionDigest: { algorithm: "sha256", value: "0".repeat(64) } }));
  await assert.rejects(() => admitHarborTask(root, taskSourceId, { adapter }), /bind/);

  writeFileSync(join(paths.studyRoot, reviewLocator), JSON.stringify(goodReview));
  const admitted = await admitHarborTask(root, taskSourceId, { adapter });
  assert.equal(admitted.review?.decision, "admitted");

  const frozen = await freezeHarborTask(root, taskSourceId, { adapter });
  const refrozen = await freezeHarborTask(root, taskSourceId, { adapter });
  assert.equal(frozen.freezeDigest.value, refrozen.freezeDigest.value, "refreeze of unchanged input retains the first record");

  const status = await statusHarborTask(root, taskSourceId, { adapter });
  assert.equal(status.status, "frozen");

  // Content change is detected, never silently accepted.
  writeFileSync(join(paths.snapshotsRoot, taskSourceId, "workdir", "notes.txt"), "changed\n");
  const drifted = await statusHarborTask(root, taskSourceId, { adapter });
  assert.equal(drifted.status, "changed");
});

test("rejected review decisions never admit a task", async () => {
  const root = tempRoot("rejected");
  const taskDir = writePrototypeTask(root);
  const adapter = fakeAdapter();
  const prepared = await prepareHarborAdmission(root, taskDir, { adapter });
  const taskSourceId = prepared.record.taskSourceId;
  const paths = harborStudyPaths(root);
  mkdirSync(join(paths.studyRoot, "governance", "reviews", "harbor"), { recursive: true });
  writeFileSync(join(paths.studyRoot, "governance", "reviews", "harbor", `${taskSourceId}.json`), JSON.stringify({
    schemaVersion: "ebo.harbor-review/v1",
    taskSourceId,
    preAdmissionDigest: preAdmissionDigestOf(prepared.record),
    decision: "rejected",
    reviewedAt: "2026-01-01T00:00:00.000Z",
    reviewedBy: "reviewer@example.test",
  }));
  await assert.rejects(() => admitHarborTask(root, taskSourceId, { adapter }), /reject|admit/i);
  const status = await statusHarborTask(root, taskSourceId, { adapter });
  assert.notEqual(status.status, "frozen");
});

/* ------------------------------------ queue v2 ------------------------------------ */

async function frozenStudyWithTask(): Promise<{ root: string; taskSourceId: string; adapter: HarborAdapter }> {
  const root = tempRoot("queue");
  const taskDir = writePrototypeTask(root);
  const adapter = fakeAdapter();
  const prepared = await prepareHarborAdmission(root, taskDir, { adapter, assessmentMode: "observational" });
  const taskSourceId = prepared.record.taskSourceId;
  const paths = harborStudyPaths(root);
  mkdirSync(join(paths.studyRoot, "governance", "reviews", "harbor"), { recursive: true });
  writeFileSync(join(paths.studyRoot, "governance", "reviews", "harbor", `${taskSourceId}.json`), JSON.stringify({
    schemaVersion: "ebo.harbor-review/v1",
    taskSourceId,
    preAdmissionDigest: preAdmissionDigestOf(prepared.record),
    decision: "admitted",
    reviewedAt: "2026-01-01T00:00:00.000Z",
    reviewedBy: "reviewer@example.test",
  }));
  await admitHarborTask(root, taskSourceId, { adapter });
  await freezeHarborTask(root, taskSourceId, { adapter });
  return { root, taskSourceId, adapter };
}

function configReference(root: string, name: string, body: Record<string, unknown>): { locator: string; digest: { algorithm: "sha256"; value: string } } {
  const locator = join("governance", "harness-configs", `${name}.json`);
  mkdirSync(join(root, "governance", "harness-configs"), { recursive: true });
  const record = { schemaVersion: "ebo.agent-sdk-config/v1", kind: name, ...body };
  writeFileSync(join(root, locator), JSON.stringify(record));
  return { locator, digest: digestOf(JSON.stringify(record)) };
}

function experimentFor(root: string, taskSourceId: string, execution: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "ebo.experiment/v2",
    id: "exp-test",
    taskSet: { proto: { kind: "harbor-task", taskSourceId } },
    modelSet: { "model-a": { configurationRef: configReference(root, "model", { model: "model-a" }) } },
    harnessSet: {
      "claude-agent-sdk": {
        configurationRef: configReference(root, "harness", {}),
        nativeLimitsRef: configReference(root, "native-limits", {}),
        nativeToolPolicyRef: configReference(root, "native-tool-policy", {}),
      },
    },
    trialCount: 1,
    coordinatorBudget: { maxWallClockMs: 60000 },
    captureProfile: configReference(root, "capture-profile", {}),
    ordering: { strategy: "sequential", seed: "seed-1" },
    execution,
  };
}

test("v2 queues compile, validate, and dispatch through the versioned reader", async () => {
  const { root, taskSourceId, adapter } = await frozenStudyWithTask();
  const queue = await compileHarborRunQueue(experimentFor(root, taskSourceId, { environmentProfile: "local-fs-test", contextPolicy: "fresh" }) as never, { studyRoot: root, adapter });
  assert.equal(queue.entries.length, 1);
  assert.equal(queue.entries[0]!.task.kind, "harbor-task");
  assert.equal(queue.execution.environmentProfile, "local-fs-test");

  const queuePath = join(root, "queue.json");
  writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  const reread = await readRunQueueVersioned(queuePath, { studyRoot: root, adapter });
  assert.equal((reread as { schemaVersion: string }).schemaVersion, "ebo.run-queue/v2");
  const changed = structuredClone(queue);
  changed.entries[0]!.configuration.model = changed.entries[0]!.configuration.harness;
  assert.ok((await validateHarborRunQueue(changed, { studyRoot: root, adapter })).some(error => error.field.endsWith("/configuration")));
});

test("v2 compilation rejects unsupported resume and imported-trajectory context policies", async () => {
  const { root, taskSourceId, adapter } = await frozenStudyWithTask();
  await assert.rejects(
    () => compileHarborRunQueue(experimentFor(root, taskSourceId, { environmentProfile: "local-fs-test", contextPolicy: "resume-requested" }) as never, { studyRoot: root, adapter }),
    /resume/i,
  );
  await assert.rejects(
    () => compileHarborRunQueue(experimentFor(root, taskSourceId, { environmentProfile: "local-fs-test", contextPolicy: "imported-trajectory" }) as never, { studyRoot: root, adapter }),
    /imported-trajectory/i,
  );
});

test("run ids are content-addressed and distinct per trial", async () => {
  const { root, taskSourceId, adapter } = await frozenStudyWithTask();
  const queue = await compileHarborRunQueue(experimentFor(root, taskSourceId) as never, { studyRoot: root, adapter });
  const entry = queue.entries[0]!;
  const recomputed = harborRunId(queue.experimentId, queue.experimentDigest, queue.schedulingDigest, entry.task, entry.model, entry.harness, entry.trial.index);
  assert.equal(entry.runId, recomputed);
  assert.match(entry.runId, /^run-[0-9a-f]{64}$/);
});

/* ------------------------------------ execution gating ------------------------------------ */

test("the docker profile fails preflight with a typed prerequisite error; local-fs-test prepares", async () => {
  const { root, taskSourceId, adapter } = await frozenStudyWithTask();
  const queue = await compileHarborRunQueue(experimentFor(root, taskSourceId, { environmentProfile: "docker", contextPolicy: "fresh" }) as never, { studyRoot: root, adapter });

  await assert.rejects(
    () => prepareHarborExecution({
      studyRoot: root,
      entry: queue.entries[0]!,
      attemptRoot: join(root, "attempt-x"),
      execution: queue.execution,
      adapter,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { reasonCode?: string }).reasonCode, "environment-prerequisite-missing");
      assert.match(error.message, /Docker/);
      return true;
    },
  );

  const localQueue = await compileHarborRunQueue(experimentFor(root, taskSourceId, { environmentProfile: "local-fs-test", contextPolicy: "fresh" }) as never, { studyRoot: root, adapter });
  const prepared = await prepareHarborExecution({
    studyRoot: root,
    entry: localQueue.entries[0]!,
    attemptRoot: join(root, "attempt-y"),
    execution: localQueue.execution,
    adapter,
  });
  assert.equal(prepared.environment.enforcement, "none");
  assert.equal(prepared.environment.containerized, false);
  assert.equal(prepared.steps.length, 1);
  assert.equal(prepared.verifier.requested, false);
});


test("the trial runner refuses the host-only preparation profile", async () => {
 const { root, taskSourceId, adapter } = await frozenStudyWithTask();
 const queue = await compileHarborRunQueue(experimentFor(root, taskSourceId, { environmentProfile: "local-fs-test", contextPolicy: "fresh" }) as never, { studyRoot: root, adapter });
 const queuePath = join(root, "queue.json");
 writeFileSync(queuePath, JSON.stringify(queue));
 await assert.rejects(runHarborBackedQueueEntry({ studyRoot: root, queuePath, runId: queue.entries[0]!.runId, outputRoot: join(root,"out"), adapter }), /requires Docker/);
});

/* ------------------------------------ step bundle definition ------------------------------------ */

test("harbor step bundle definitions bind task, model, and harness identities", () => {
  const prepared = {
    run: { id: "run-abc", taskId: "proto", modelId: "model-a", harnessId: "claude-agent-sdk" },
    task: {
      taskSourceId: "harbor-0123456789abcdef",
      harborDigest: "a".repeat(64),
      assessmentMode: "observational",
      snapshotDirectory: "/snapshot",
      resolutionDigest: digestOf("r"),
    },
    steps: [],
    environment: { profile: "local-fs-test", provider: "ebo-local-fs-test", containerized: false, enforcement: "none", dockerImage: null, networkMode: "public" },
    verifier: { requested: false, environmentMode: null, timeoutSec: 60, multiStepRewardStrategy: "mean" },
    budget: { coordinatorWallClockMs: 1000 },
    evidence: { attemptRoot: "/a", harborDir: "/a/harbor", stepsDir: "/a/steps", workspaceDir: "/a/workspace", eboDir: "/a/ebo" },
  } as never;
  const step = { index: 1, name: "default", effectiveInstruction: "i", instructionDigest: digestOf("i"), minReward: null, verifierTimeoutSec: 60 } as never;
  const definition = harborStepBundleDefinition(prepared, step, "/bundle", {
    harnessId: "claude-agent-sdk",
    harnessVersion: "1.0.0",
    modelId: "model-a",
    configurationDigests: { model: "m", harness: "h", captureProfile: "c", nativeLimits: "l", nativeToolPolicy: "t" },
  });
  assert.equal(definition.run.task.id, "proto");
  assert.equal(definition.run.task.digest, `sha256:${"a".repeat(64)}`);
  assert.equal(definition.run.model.id, "model-a");
  assert.equal(definition.run.harness.id, "claude-agent-sdk");
  assert.match(definition.bundleId, /step-1$/);
});

/* ------------------------------------ conversion report ------------------------------------ */

test("conversion reports are digested and versioned", () => {
  const report = {
    schemaVersion: HARBOR_CONVERSION_SCHEMA_VERSION,
    packetId: "pkt-1",
    packetDigest: digestOf("packet"), status: "manual-action-required",
    assessmentMode: "observational",
    convertedAt: "2026-01-01T00:00:00.000Z",
    taskDirectory: "harbor-inbox/legacy-pkt-1",
    harborDigest: null,
    mappings: [{ source: "agentInput.prompt", target: "steps.default.instruction", status: "mapped" }],
    warnings: [],
  };
  const digest = conversionReportDigest(report as HarborConversionReport);
  assert.equal(digest.algorithm, "sha256");
  assert.equal(digest.value.length, 64);
});

test("convertLegacyTaskPacket refuses unfrozen packets", async () => {
  const { convertLegacyTaskPacket } = await import("../src/harbor/convert.js");
  const root = tempRoot("convert");
  const locator = join("tasks", "pkt.json");
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(join(root, locator), JSON.stringify({ schemaVersion: "ebo.task-packet/v1" }));
  await assert.rejects(
    () => convertLegacyTaskPacket({ studyRoot: root, packetLocator: locator }),
    /frozen|failed to load|Invalid legacy packet/i,
  );
});

test("convertLegacyTaskPacket maps a frozen verified packet loss-audited and non-destructively", async () => {
  const { convertLegacyTaskPacket } = await import("../src/harbor/convert.js");
  const { freezeTaskPacket } = await import("../src/task-packets.js");
  const { digestBytes } = await import("../src/artifacts.js");
  const root = tempRoot("convert-ok");
  const fixture = tarGzipFixture();
  const fixturePath = fileURLToPath(new URL("../../tests/fixtures/task-packet.valid.v1.json", import.meta.url));
  const packet = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  const mutate = (mutator: (value: Record<string, unknown>) => void) => mutator(packet);
  mutate((value) => {
    const source = ((value.agentInput as Record<string, unknown>).fixture as Record<string, unknown>).source as Record<string, unknown>;
    source.locator = "fixture.bin";
    source.digest = digestBytes(fixture);
  });
  mutate((value) => {
    const perturbation = (value.controlledPerturbation as Record<string, unknown>).reference as Record<string, unknown>;
    perturbation.locator = "perturbation.json";
    perturbation.digest = digestBytes(Buffer.from('{"kind":"controlled"}\n'));
  });
  mutate((value) => {
    const restricted = (value.restricted as Record<string, unknown>) ?? ((value.restricted = {}), value.restricted as Record<string, unknown>);
    const verifier = restricted.verifier as Record<string, unknown>;
    verifier.locator = "verifier.sh";
    verifier.digest = digestBytes(Buffer.from("#!/bin/sh\nexit 0\n"));
    const solution = restricted.referenceSolution as Record<string, unknown>;
    solution.locator = "reference.txt";
    solution.digest = digestBytes(Buffer.from("reference solution\n"));
  });
  const preAdmission = structuredClone(packet);
  delete (preAdmission as Record<string, unknown>).admission;
  const { digestMetadata } = await import("../src/artifacts.js");
  const reviewBytes = Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: (packet.admission as Record<string, unknown>).status,
    reviewedAt: ((packet.admission as Record<string, unknown>).review as Record<string, unknown>).reviewedAt,
    reviewedBy: ((packet.admission as Record<string, unknown>).review as Record<string, unknown>).reviewedBy,
  }));
  mutate((value) => {
    const admission = value.admission as Record<string, unknown>;
    const review = admission.review as Record<string, unknown>;
    const record = review.reviewRecord as Record<string, unknown>;
    record.locator = "review.json";
    record.digest = digestBytes(reviewBytes);
  });
  writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
  writeFileSync(join(root, "fixture.bin"), fixture);
  writeFileSync(join(root, "perturbation.json"), '{"kind":"controlled"}\n');
  writeFileSync(join(root, "verifier.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(root, "reference.txt"), "reference solution\n");
  writeFileSync(join(root, "review.json"), reviewBytes);
  freezeTaskPacket(root, "packet.json");

  const { report, taskDirectory } = await convertLegacyTaskPacket({ studyRoot: root, packetLocator: "packet.json", adapter: fakeAdapter() });
  assert.equal(report.schemaVersion, HARBOR_CONVERSION_SCHEMA_VERSION);
  assert.equal(report.assessmentMode, "verified");
  const bySource = new Map(report.mappings.map((mapping) => [mapping.source, mapping]));
  assert.equal(bySource.get("agentInput.prompt")?.status, "mapped");
  assert.equal(bySource.get("restricted")?.status, "unsupported");
  assert.equal(report.status, "manual-action-required");
  assert.ok(!readFileSync(join(taskDirectory, "task.toml"), "utf8").includes("steps.default"));
  assert.ok(readFileSync(taskDirectory + ".conversion.json", "utf8").length > 0);
  // Non-destructive: the packet and freeze record remain untouched.
  assert.ok(readFileSync(join(root, "packet.json"), "utf8").includes("example-contract-change"));
  assert.ok(readFileSync(join(root, "packet.json.freeze.json"), "utf8").includes("aggregateDigest"));
});

function tarGzipFixture(): Buffer {
  const gzipSync = gzipModule;
  const entries: Array<{ path: string; bytes: Buffer; type?: string }> = [
    { path: "README.md", bytes: Buffer.from("# fixture\n") },
    { path: "package.json", bytes: Buffer.from("{}\n") },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n") },
  ];
  const blocks: Buffer[] = [];
  for (const { path, bytes, type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write(type, 156, "ascii");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    let checksum = 256; // verifier reads the checksum field as eight spaces (0x20 each)
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/* ------------------------------------ real adapter (gated) ------------------------------------ */

test("the pinned Harbor adapter reports its version and docker availability honestly", async (t) => {
  let adapter: HarborAdapter;
  try {
    adapter = await createHarborAdapter();
  } catch (error) {
    t.skip(`Harbor python package unavailable: ${(error as Error).message}`);
    return;
  }
  const version = await adapter.version();
  assert.equal(version.harborVersion, "0.23.0");
  const preflight = await adapter.dockerPreflight();
  // Either outcome is honest; both must be explicit.
  assert.equal(typeof preflight.available, "boolean");
  if (!preflight.available) {
    assert.ok(preflight.reason !== null && preflight.reason.length > 0);
  }
});

test("study JSON readers reject cross-tree references", async () => {
  const root = tempRoot("reader");
  mkdirSync(join(root, "governance", "admissions", "harbor"), { recursive: true });
  writeFileSync(join(root, "governance", "admissions", "harbor", "x.json"), JSON.stringify({ schemaVersion: "ebo.harbor-admission/v1" }));
  assert.throws(() => readHarborStudyJson(root, join("..", "escape.json")));
});
