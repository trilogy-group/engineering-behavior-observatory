import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  buildCorpusIndex,
  assessComparisonEligibility,
  compileRunQueue,
  createPortableRunBundleExport,
  createPiPassiveObserver,
  createRetainedBehaviorEvidence,
  createRetainedStructuralObservationSet,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  filterPiToolEnvironment,
  main,
  JsonlEvidenceWriter,
  readPortableRunBundleExport,
  runPiQueueEntry,
  validateCorpusIndex,
  writeRunQueue,
  PI_HARNESS,
  PINNED_PI_SDK_VERSION,
  type ExperimentConfiguration,
  type ComparisonRequest,
  type PiSession,
  type PiSessionFactory,
  type RunManifest,
  type TaskPacket,
} from "../src/index.js";
import { checkRetainedEvaluation } from "./retained-evaluation-helper.js";

const SESSION_ID = "pi-session-fixture";
const HIDDEN_THOUGHT = "private synthetic reasoning that must not export";
const HIDDEN_REASONING_CONTENT = "private reasoning_content must not export";
const HIDDEN_THOUGHT_SIGNATURE = "private thought signature must not export";
const HIDDEN_TEXT_SIGNATURE = "private text signature must not export";
const SYNTHETIC_SECRET = "synthetic-api-key-value-123456";

test("runs a frozen observational Pi entry through capture, export, retained evaluation, and Atlas paths", async () => {
  const fixture = createPiFixture();
  const factory = fakePiSessionFactory();
  try {
    const summary = await runPiQueueEntry({ ...fixture, createSession: factory.createSession });
    assert.equal(factory.calls(), 1);
    assert.equal(summary.assessmentMode, "observational");
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    assert.equal(summary.sessionId, SESSION_ID);
    assert.equal(summary.retainedWorkspacePath, undefined);
    assert.deepEqual(readdirSync(fixture.workspaceRoot), []);

    const manifest = readManifest(summary.bundlePath);
    assert.equal(manifest.run.harness.id, PI_HARNESS);
    assert.equal(manifest.run.harness.version, PINNED_PI_SDK_VERSION);
    assert.equal(manifest.run.native?.sessionId, SESSION_ID);
    assert.ok(manifest.run.runtime.some(({ name, version }) => name === "pi-coding-agent" && version === PINNED_PI_SDK_VERSION));
    assert.equal(manifest.evidence.filter(({ kind }) => kind === "session").length, 3);
    assert.ok(manifest.evidence.some(({ kind }) => kind === "workspace"));
    const composition = readJsonl(join(summary.bundlePath, "pi-events.jsonl")).find(({ nativeType }) => nativeType === "session_created")!.payload as Record<string, any>;
    assert.equal(composition.schemaVersion, "ebo.pi-composition/v1");
    assert.equal(composition.model.queueModelId, "synthetic-model");
    assert.deepEqual(composition.tools.active, ["read", "bash", "edit", "write"]);

    const evidence = await createRetainedBehaviorEvidence(summary.bundlePath);
    assert.equal(evidence.dataset.adapter.harness, PI_HARNESS);
    assert.equal(evidence.dataset.events.filter(({ family }) => family === "tool").length, 2);
    assert.ok(evidence.dataset.unmapped.some(({ reason }) => /Transient message delta/u.test(reason)));
    assert.ok(evidence.dataset.unmapped.some(({ reason }) => /future_event/u.test(reason)));
    const turnScopes = evidence.dataset.events.filter(({ source }) => source.nativeType === "stream:turn_start")
      .map(({ scope }) => scope.id);
    assert.deepEqual(turnScopes, [`${SESSION_ID}:turn:0`, `${SESSION_ID}:turn:1`]);
    const streamTurnEnd = evidence.dataset.events.filter(({ source }) => source.nativeType === "stream:turn_end").at(-1);
    assert.deepEqual(streamTurnEnd?.nativeTime, { status: "known", value: "2023-11-14T22:13:20.400Z" });
    const observations = await createRetainedStructuralObservationSet(summary.bundlePath);
    const toolCount = observations.observations.find(({ id }) => id.endsWith("tool-operation-count"));
    assert.deepEqual(toolCount?.value, { status: "known", value: 1, unit: "identified-logical-tool-operations" });
    const inputTokens = observations.observations.find(({ id }) => id.endsWith("input-token-count"));
    assert.deepEqual(inputTokens?.value, { status: "known", value: 12, unit: "tokens" });
    const compactions = observations.observations.find(({ id }) => id.endsWith("compaction-boundary-record-count"));
    assert.deepEqual(compactions?.value, { status: "known", value: 4, unit: "native-records" });
    const totalCost = observations.observations.find(({ id }) => id.endsWith("total-cost-usd"));
    assert.deepEqual(totalCost?.value, { status: "known", value: 0, unit: "usd" });

    const restrictedBefore = snapshotManifestArtifacts(summary.bundlePath, manifest);
    const exportRoot = join(fixture.parent, "portable");
    const policy = { sharingClass: "partner" as const, maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024, sensitiveValues: [SYNTHETIC_SECRET] };
    const exported = await createPortableRunBundleExport({ sourceRoot: summary.bundlePath, destinationRoot: exportRoot, policy });
    await readPortableRunBundleExport(exportRoot, policy);
    assert.deepEqual(snapshotManifestArtifacts(summary.bundlePath, manifest), restrictedBefore);
    const portableText = exported.artifacts.map(({ relativePath }) => readFileSync(join(exportRoot, relativePath), "utf8")).join("\n");
    assert.equal(portableText.includes(HIDDEN_THOUGHT), false);
    assert.equal(portableText.includes(HIDDEN_REASONING_CONTENT), false);
    assert.equal(portableText.includes(HIDDEN_THOUGHT_SIGNATURE), false);
    assert.equal(portableText.includes(HIDDEN_TEXT_SIGNATURE), false);
    assert.equal(portableText.includes(SYNTHETIC_SECRET), false);
    assert.equal(portableText.includes(fixture.parent), false);

    const corpus = buildCorpusIndex(summary.bundlePath);
    assert.deepEqual(validateCorpusIndex(summary.bundlePath, corpus), []);
    const indexed = corpus[0]!;
    const candidate = {
      id: manifest.run.id,
      manifestDigest: indexed.manifestDigest,
      adapterVersion: observations.normalization.adapter.version,
      task: { id: indexed.taskId!, digest: indexed.taskDigest! },
      fixture: { id: indexed.fixtureId!, digest: indexed.fixtureDigest! },
      model: { id: indexed.modelId!, configurationDigest: indexed.modelConfigurationDigest! },
      harness: { id: indexed.harnessId!, version: indexed.harnessVersion!, configurationDigest: indexed.harnessConfigurationDigest! },
      assessmentMode: "observational" as const,
      captureProfileDigest: indexed.captureProfileDigest!,
      budgetDigest: indexed.budgetDigest!,
      toolPolicyDigest: indexed.toolPolicyDigest!,
      capabilityProfile: observations.normalization.capabilityProfile!,
    };
    const comparison: ComparisonRequest = {
      schemaVersion: "ebo.comparison-request/v2",
      measure: "structural:tool-operation-count",
      left: candidate,
      right: structuredClone(candidate),
      policy: { declaredDifferences: [], requiredCapabilities: ["family:tool"] },
    };
    assert.equal(assessComparisonEligibility(comparison).status, "supported");
    await checkRetainedEvaluation(summary.bundlePath, join(fixture.parent, "retained-evaluation"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("snapshots mutable callbacks, preserves source order, and keeps the passive observer behavior-neutral", async () => {
  const runs = [];
  for (const passiveObserver of [false, true]) {
    const fixture = createPiFixture({ passiveObserver, includeProviderPayloads: true });
    const factory = fakePiSessionFactory();
    try {
      const summary = await runPiQueueEntry({ ...fixture, createSession: factory.createSession });
      const evidence = await createRetainedBehaviorEvidence(summary.bundlePath);
      const eventRecords = readJsonl(join(summary.bundlePath, "pi-events.jsonl"));
      const toolStart = eventRecords.find(({ nativeType }) => nativeType === "tool_execution_start")!;
      assert.equal((toolStart.payload as Record<string, unknown>).toolName, "write", "later callback mutation must not alter retained input");
      assert.deepEqual(eventRecords.map(({ sequence }) => sequence), eventRecords.map((_, index) => index + 1));
      const update = eventRecords.find(({ nativeType }) => nativeType === "message_update")!.payload as Record<string, any>;
      assert.equal(update.message, undefined, "transient updates must not repeat the cumulative message");
      assert.equal(update.assistantMessageEvent.partial, undefined, "transient updates must not repeat the cumulative partial");
      const toolCallStart = eventRecords.filter(({ nativeType }) => nativeType === "message_update")
        .map(({ payload }) => payload as Record<string, any>)
        .find((payload) => payload.assistantMessageEvent.type === "toolcall_start")!;
      assert.equal(toolCallStart.assistantMessageEvent.id, "tool-1");
      assert.equal(toolCallStart.assistantMessageEvent.toolName, "write");
      const observerPath = join(summary.bundlePath, "pi-observer.jsonl");
      assert.equal(existsSync(observerPath), passiveObserver);
      if (passiveObserver) {
        const provider = readJsonl(observerPath).find(({ nativeType }) => nativeType === "before_provider_request")!;
        assert.equal(JSON.stringify(provider).includes(HIDDEN_THOUGHT), true);
      }
      runs.push({
        workspace: readFileSync(join(summary.bundlePath, "workspace.patch"), "utf8"),
        tools: evidence.dataset.events.filter(({ family }) => family === "tool").map(({ attributes, phase }) => ({ attributes, phase })),
        terminal: summary.terminal,
      });
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
  assert.deepEqual(runs[0], runs[1], "passive payload observation must not change tool/model result semantics");
});

test("retains a valid unqualified partial bundle when Pi session creation fails before an identity exists", async () => {
  const fixture = createPiFixture();
  try {
    const summary = await runPiQueueEntry({
      ...fixture,
      createSession: async () => { throw new Error("synthetic provider initialization failure"); },
    });
    assert.equal(summary.classification, "infrastructure-failure");
    assert.equal(summary.captureQualification, "unqualified");
    assert.equal(summary.sessionId, undefined);
    const manifest = readManifest(summary.bundlePath);
    assert.equal(manifest.terminal.state, "failed");
    assert.ok(manifest.evidence.some(({ id }) => id === "pi-events"));
    assert.ok(readFileSync(join(summary.bundlePath, "pi-events.jsonl"), "utf8").includes("synthetic provider initialization failure"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("disposes the SDK session and retains partial history when prompt execution fails", async () => {
  const fixture = createPiFixture();
  let disposed = 0;
  try {
    const createSession: PiSessionFactory = async (input) => ({
      sessionId: SESSION_ID,
      messages: [],
      extensionRunner: { emit: async () => undefined },
      subscribe: () => () => undefined,
      prompt: async () => { throw new Error("synthetic mid-run provider failure"); },
      waitForIdle: async () => undefined,
      abort: async () => undefined,
      exportToJsonl(outputPath) {
        writeFileSync(outputPath!, `${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-09T00:00:00.000Z", cwd: input.workspacePath })}\n`);
        return outputPath!;
      },
      getActiveToolNames: () => [...input.toolPolicy.tools],
      dispose: () => { disposed += 1; },
    });
    const summary = await runPiQueueEntry({ ...fixture, createSession });
    assert.equal(summary.classification, "infrastructure-failure");
    assert.equal(summary.captureQualification, "unqualified");
    assert.equal(disposed, 1);
    assert.ok(readFileSync(join(summary.bundlePath, "pi-events.jsonl"), "utf8").includes("synthetic mid-run provider failure"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retains persisted native history without regenerating it through the branch export helper", async () => {
  const fixture = createPiFixture();
  const base = fakePiSessionFactory();
  try {
    const createSession: PiSessionFactory = async (input) => {
      const session = await base.createSession(input);
      const nativePath = join(input.sessionDirectory, "persisted-native.jsonl");
      mkdirSync(input.sessionDirectory, { recursive: true });
      session.exportToJsonl(nativePath);
      return { ...session, sessionFile: nativePath, exportToJsonl: () => { throw new Error("synthetic session export failure"); } };
    };
    const summary = await runPiQueueEntry({ ...fixture, createSession });
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    const manifest = readManifest(summary.bundlePath);
    assert.ok(manifest.evidence.some(({ id }) => id === "pi-session"));
    assert.match(readFileSync(join(summary.bundlePath, "pi-session.jsonl"), "utf8"), new RegExp(SESSION_ID, "u"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retains and disqualifies an unexpected session-shutdown emission failure", async () => {
  const fixture = createPiFixture();
  const base = fakePiSessionFactory();
  try {
    const createSession: PiSessionFactory = async (input) => {
      const session = await base.createSession(input);
      return {
        ...session,
        extensionRunner: { emit: async () => { throw new Error("synthetic session shutdown failure"); } },
      };
    };
    const summary = await runPiQueueEntry({ ...fixture, createSession });
    assert.equal(summary.classification, "infrastructure-failure");
    assert.equal(summary.captureQualification, "unqualified");
    assert.match(readFileSync(join(summary.bundlePath, "pi-observer.jsonl"), "utf8"), /synthetic session shutdown failure/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("does not invent completion from an unknown assistant stop reason", async () => {
  const fixture = createPiFixture();
  const base = fakePiSessionFactory();
  try {
    const createSession: PiSessionFactory = async (input) => {
      const session = await base.createSession(input);
      (session.messages[0] as { stopReason: string }).stopReason = "pending";
      return session;
    };
    const summary = await runPiQueueEntry({ ...fixture, createSession });
    assert.equal(summary.classification, "infrastructure-failure");
    assert.equal(summary.captureQualification, "unqualified");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retains verifier-backed semantics when the frozen Pi task is verified", async () => {
  const fixture = createPiFixture({ assessmentMode: "verified" });
  try {
    const summary = await runPiQueueEntry({ ...fixture, createSession: fakePiSessionFactory().createSession });
    assert.equal(summary.assessmentMode, "verified");
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    const manifest = readManifest(summary.bundlePath);
    assert.ok(manifest.run.verifier);
    assert.ok(manifest.evidence.some(({ kind }) => kind === "verifier"));
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retained Pi readback rejects unsupported versions, identity mismatches, and corrupt native lineage", async () => {
  const fixture = createPiFixture();
  try {
    const summary = await runPiQueueEntry({ ...fixture, createSession: fakePiSessionFactory().createSession });
    const manifestPath = join(summary.bundlePath, "manifest.json");
    const before = readFileSync(manifestPath);
    const unsupported = JSON.parse(before.toString()) as RunManifest;
    unsupported.run.harness.version = "0.0.0";
    writeFileSync(manifestPath, JSON.stringify(unsupported));
    await assert.rejects(createRetainedBehaviorEvidence(summary.bundlePath), /Unsupported retained Pi runtime/u);
    writeFileSync(manifestPath, before);

    const runtimeMismatch = JSON.parse(before.toString()) as RunManifest;
    runtimeMismatch.run.runtime = runtimeMismatch.run.runtime.filter(({ name }) => name !== "pi-sdk-adapter");
    writeFileSync(manifestPath, JSON.stringify(runtimeMismatch));
    await assert.rejects(createRetainedBehaviorEvidence(summary.bundlePath), /runtime identity pi-sdk-adapter/u);
    writeFileSync(manifestPath, before);

    const mismatched = JSON.parse(before.toString()) as RunManifest;
    mismatched.run.native = { sessionId: "foreign-session" };
    writeFileSync(manifestPath, JSON.stringify(mismatched));
    await assert.rejects(createRetainedBehaviorEvidence(summary.bundlePath), /sessionId|session identity differs/u);
    writeFileSync(manifestPath, before);

    const sessionPath = join(summary.bundlePath, "pi-session.jsonl");
    const sessionBefore = readFileSync(sessionPath);
    const records = readJsonl(sessionPath);
    records[2]!.parentId = "missing-parent";
    const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const corrupt = JSON.parse(before.toString()) as RunManifest;
    const descriptor = corrupt.evidence.find(({ id }) => id === "pi-session")!;
    descriptor.digest = `sha256:${digestBytes(bytes).value}`;
    descriptor.sizeBytes = bytes.length;
    writeFileSync(sessionPath, bytes);
    writeFileSync(manifestPath, JSON.stringify(corrupt));
    await assert.rejects(createRetainedBehaviorEvidence(summary.bundlePath), /unresolved parent identities/u);
    writeFileSync(sessionPath, sessionBefore);
    writeFileSync(manifestPath, before);

    const unsupportedSession = readJsonl(sessionPath);
    unsupportedSession[0]!.version = 2;
    const unsupportedBytes = Buffer.from(`${unsupportedSession.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const unsupportedManifest = JSON.parse(before.toString()) as RunManifest;
    const unsupportedDescriptor = unsupportedManifest.evidence.find(({ id }) => id === "pi-session")!;
    unsupportedDescriptor.digest = `sha256:${digestBytes(unsupportedBytes).value}`;
    unsupportedDescriptor.sizeBytes = unsupportedBytes.length;
    writeFileSync(sessionPath, unsupportedBytes);
    writeFileSync(manifestPath, JSON.stringify(unsupportedManifest));
    await assert.rejects(createRetainedBehaviorEvidence(summary.bundlePath), /Invalid retained Pi session entry/u);
    writeFileSync(sessionPath, sessionBefore);
    writeFileSync(manifestPath, before);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("source-specific prequalification rejects mismatched native tool identities before reporting success", async () => {
  const fixture = createPiFixture();
  const base = fakePiSessionFactory();
  try {
    const createSession: PiSessionFactory = async (input) => {
      const session = await base.createSession(input);
      return {
        ...session,
        exportToJsonl(outputPath) {
          session.exportToJsonl(outputPath);
          const records = readJsonl(outputPath!);
          const result = records.find((record) => record.type === "message" && (record.message as Record<string, unknown> | undefined)?.role === "toolResult")!;
          (result.message as Record<string, unknown>).toolCallId = "foreign-tool";
          writeFileSync(outputPath!, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
          return outputPath!;
        },
      };
    };
    const summary = await runPiQueueEntry({ ...fixture, createSession });
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "unqualified");
    const manifest = readManifest(summary.bundlePath);
    const report = manifest.evidence.find(({ kind }) => kind === "capture-report")!;
    assert.match(readFileSync(join(summary.bundlePath, report.relativePath), "utf8"), /mismatched native history and streamed tool identities/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("CLI help and argument validation expose the operational Pi runner", async () => {
  let output = "";
  assert.equal(main(["--help"], (message) => (output += message)), 0);
  assert.match(output, /ebo pi run <bundle-root>/u);
  output = "";
  assert.equal(await main(["pi", "run"], (message) => (output += message)), 1);
  assert.match(output, /^Usage: ebo pi run/u);
});

test("tool child-process environment is allowlisted and cannot expose provider credentials", () => {
  assert.deepEqual(filterPiToolEnvironment({ PATH: "/bin", HOME: "/home/fixture", ZAI_API_KEY: SYNTHETIC_SECRET, OTHER_SECRET: "hidden" }, new Set(["PATH", "HOME"]), "ZAI_API_KEY"), {
    PATH: "/bin", HOME: "/home/fixture",
  });
  assert.throws(() => filterPiToolEnvironment({ ZAI_API_KEY: SYNTHETIC_SECRET }, new Set(["ZAI_API_KEY"]), "ZAI_API_KEY"), /must not expose/u);
});

test("rejects mismatched queue model identity and silently clamped thinking configuration", async () => {
  for (const options of [
    { configQueueModelId: "different-model" },
    { thinkingLevel: "high" as const, reasoning: false },
  ]) {
    const fixture = createPiFixture(options);
    try {
      await assert.rejects(runPiQueueEntry({ ...fixture, createSession: fakePiSessionFactory().createSession }), /model condition|non-reasoning models require thinkingLevel off/u);
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("accepts the pinned SDK's highest caller-selected thinking levels", async () => {
  for (const thinkingLevel of ["xhigh", "max"] as const) {
    const fixture = createPiFixture({ thinkingLevel, reasoning: true });
    try {
      const summary = await runPiQueueEntry({ ...fixture, createSession: fakePiSessionFactory().createSession });
      assert.equal(summary.captureQualification, "qualified");
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("production Pi session creation preserves explicit xhigh and max mappings", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "synthetic-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address() as AddressInfo;
  const previous = process.env.PI_SYNTHETIC_API_KEY;
  process.env.PI_SYNTHETIC_API_KEY = "synthetic-local-test-key";
  try {
    for (const scenario of [
      { thinkingLevel: "xhigh" as const, declaredToolExtension: false },
      { thinkingLevel: "max" as const, declaredToolExtension: false },
      { thinkingLevel: "max" as const, declaredToolExtension: true },
    ]) {
      const fixture = createPiFixture({ ...scenario, reasoning: true, modelBaseUrl: `http://127.0.0.1:${address.port}/v1` });
      try {
        const summary = await runPiQueueEntry(fixture);
        assert.equal(summary.classification, "completed");
        assert.equal(summary.captureQualification, "qualified");
        const composition = readJsonl(join(summary.bundlePath, "pi-events.jsonl")).find(({ nativeType }) => nativeType === "session_created")!.payload as Record<string, any>;
        assert.equal(composition.tools.active.includes("declared_tool"), scenario.declaredToolExtension);
      } finally {
        rmSync(fixture.parent, { recursive: true, force: true });
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_SYNTHETIC_API_KEY;
    else process.env.PI_SYNTHETIC_API_KEY = previous;
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
  }
});

test("fails closed when a declared digest-pinned skill is not loadable", async () => {
  const fixture = createPiFixture({ malformedSkill: true });
  try {
    const summary = await runPiQueueEntry(fixture);
    assert.equal(summary.classification, "infrastructure-failure");
    assert.equal(summary.captureQualification, "unqualified");
    assert.match(readFileSync(join(summary.bundlePath, "pi-events.jsonl"), "utf8"), /description is required/u);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("rejects a declared extension whose dependency graph is not fully digest-bound", async () => {
  const fixture = createPiFixture({ extensionImport: true });
  try {
    await assert.rejects(runPiQueueEntry(fixture), /must be self-contained/u);
    assert.equal(existsSync(fixture.outputRoot), false, "extension dependency rejection occurs before attempt capture");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("aborts through the public Pi session API and retains the interrupted attempt", async () => {
  const fixture = createPiFixture();
  const controller = new AbortController();
  let resolvePrompt: (() => void) | undefined;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolvePromise) => { markPromptStarted = resolvePromise; });
  let shutdownEmitted = false;
  try {
    const createSession: PiSessionFactory = async (input) => {
      const listeners: Array<(event: AgentSessionEvent) => void> = [];
      const messages: unknown[] = [];
      return {
        sessionId: SESSION_ID,
        messages,
        extensionRunner: { emit: async () => {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          shutdownEmitted = true;
        } },
        subscribe(listener) { listeners.push(listener); return () => undefined; },
        prompt: () => new Promise<void>((resolve) => { resolvePrompt = resolve; markPromptStarted(); }),
        async waitForIdle() {},
        async abort() {
          if (messages.length > 0) return;
          const assistant = { role: "assistant", content: [], provider: input.model.provider, model: input.model.model, stopReason: "aborted", timestamp: Date.now(), usage: zeroUsage() };
          messages.push(assistant);
          emit(listeners, { type: "agent_settled" } as AgentSessionEvent);
          resolvePrompt?.();
        },
        exportToJsonl(outputPath) {
          const records = [
            { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-09T00:00:00.000Z", cwd: input.workspacePath },
            { type: "message", id: "aborted", parentId: null, timestamp: "2026-09-09T00:00:00.001Z", message: messages[0] },
          ];
          writeFileSync(outputPath!, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
          return outputPath!;
        },
        getActiveToolNames: () => [...input.toolPolicy.tools],
        dispose() {},
      };
    };
    const pending = runPiQueueEntry({ ...fixture, signal: controller.signal, createSession });
    await promptStarted;
    controller.abort("synthetic timeout");
    const summary = await pending;
    assert.equal(summary.classification, "interrupted");
    assert.equal(summary.terminal.state, "interrupted");
    assert.equal(summary.captureQualification, "unqualified", "interrupted attempts remain valid partial evidence rather than invented complete capture");
    assert.equal(shutdownEmitted, true, "capture must join adapter finalization before returning from cancellation");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("cancellation during session creation is propagated and joined before capture returns", async () => {
  const fixture = createPiFixture();
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolvePromise) => { markStarted = resolvePromise; });
  let creationSettled = false;
  try {
    const createSession: PiSessionFactory = async ({ signal }) => {
      markStarted();
      await new Promise<void>((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(), { once: true }));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      creationSettled = true;
      throw new Error("synthetic cancelled creation");
    };
    const pending = runPiQueueEntry({ ...fixture, signal: controller.signal, createSession });
    await started;
    controller.abort("synthetic creation cancellation");
    const summary = await pending;
    assert.equal(summary.classification, "interrupted");
    assert.equal(summary.captureQualification, "unqualified");
    assert.equal(creationSettled, true, "capture must join cancellation-aware session construction");
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("recorder failure prevents a qualified success and still disposes the SDK session", async (t) => {
  const fixture = createPiFixture();
  const factory = fakePiSessionFactory();
  const append = JsonlEvidenceWriter.prototype.append;
  t.mock.method(JsonlEvidenceWriter.prototype, "append", function (this: JsonlEvidenceWriter, record: unknown, ...rest: unknown[]) {
    if (typeof record === "object" && record !== null && (record as { nativeType?: string }).nativeType === "tool_execution_start") {
      return Promise.reject(new Error("synthetic recorder failure"));
    }
    return Reflect.apply(append, this, [record, ...rest]);
  });
  try {
    const summary = await runPiQueueEntry({ ...fixture, createSession: factory.createSession });
    assert.equal(summary.classification, "capture-incomplete");
    assert.equal(summary.captureQualification, "unqualified");
    assert.equal(factory.disposals(), 1);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("approved live Pi SDK smoke", { skip: process.env.EBO_LIVE_PI_SDK_SMOKE !== "1" }, async () => {
  assert.ok(process.env.ZAI_API_KEY, "ZAI_API_KEY is required for the approved live smoke");
  const fixture = createPiFixture({ live: true });
  try {
    const summary = await runPiQueueEntry(fixture);
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    assert.match(readFileSync(join(summary.bundlePath, "workspace.patch"), "utf8"), /result\.txt/u);
    const evidence = await createRetainedBehaviorEvidence(summary.bundlePath);
    assert.ok(evidence.dataset.events.some(({ family }) => family === "tool"));
    const observations = await createRetainedStructuralObservationSet(summary.bundlePath);
    assert.ok(observations.observations.some(({ id }) => id.endsWith("tool-operation-count")));
    const exportRoot = join(fixture.parent, "live-export");
    const policy = { sharingClass: "partner" as const, maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024 };
    await createPortableRunBundleExport({ sourceRoot: summary.bundlePath, destinationRoot: exportRoot, policy });
    await readPortableRunBundleExport(exportRoot, policy);
    const retainedRoot = join(process.cwd(), ".ebo", `pi-live-smoke-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`);
    mkdirSync(retainedRoot, { recursive: true, mode: 0o700 });
    cpSync(summary.bundlePath, join(retainedRoot, "run"), { recursive: true, errorOnExist: true, force: false });
    cpSync(exportRoot, join(retainedRoot, "export"), { recursive: true, errorOnExist: true, force: false });
    writeFileSync(join(retainedRoot, "observations.json"), JSON.stringify(observations));
    writeFileSync(join(retainedRoot, "qualification.json"), JSON.stringify({
      classification: summary.classification,
      qualification: summary.captureQualification,
      sessionId: summary.sessionId,
      toolEvents: evidence.dataset.events.filter(({ family }) => family === "tool").length,
    }));
    process.stdout.write(`live-pi-sdk ${JSON.stringify({ classification: summary.classification, qualification: summary.captureQualification, session: Boolean(summary.sessionId), toolEvents: evidence.dataset.events.filter(({ family }) => family === "tool").length, retainedRoot })}\n`);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

type PiFixture = {
  parent: string;
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot: string;
};

function createPiFixture(options: {
  includeProviderPayloads?: boolean;
  passiveObserver?: boolean;
  live?: boolean;
  assessmentMode?: TaskPacket["assessmentMode"];
  configQueueModelId?: string;
  thinkingLevel?: "off" | "high" | "xhigh" | "max";
  reasoning?: boolean;
  malformedSkill?: boolean;
  modelBaseUrl?: string;
  declaredToolExtension?: boolean;
  extensionImport?: boolean;
} = {}): PiFixture {
  const parent = mkdtempSync(join(tmpdir(), "ebo-pi-runner-"));
  const bundleRoot = join(parent, "bundle");
  mkdirSync(bundleRoot);
  const verified = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/task-packet.valid.v1.json"), "utf8")) as Extract<TaskPacket, { assessmentMode: "verified" }>;
  const packet = options.assessmentMode === "verified" ? verified
    : (({ restricted: _restricted, ...task }) => ({ ...task, assessmentMode: "observational" as const }))(verified) as TaskPacket;
  packet.agentInput.prompt = "Create a file named result.txt containing exactly the single line: done";
  const writeRef = (reference: ArtifactReferenceLike, locator: string, bytes: Buffer): void => {
    reference.locator = locator;
    reference.digest = digestBytes(bytes);
    mkdirSync(dirname(join(bundleRoot, locator)), { recursive: true });
    writeFileSync(join(bundleRoot, locator), bytes);
  };
  writeRef(packet.agentInput.fixture.source, "components/fixture.tar.gz", fixtureArchive());
  if (!("reference" in packet.controlledPerturbation)) throw new Error("Fixture packet requires perturbation reference.");
  writeRef(packet.controlledPerturbation.reference, "components/perturbation.json", Buffer.from('{"kind":"controlled"}\n'));
  if (packet.assessmentMode === "verified") {
    if (!("locator" in packet.restricted.referenceSolution)) throw new Error("Verified fixture requires a reference solution.");
    writeRef(packet.restricted.referenceSolution, "restricted/reference.txt", Buffer.from("done\n"));
    writeRef(packet.restricted.verifier, "restricted/verifier.cjs", Buffer.from(`
const fs = require("node:fs");
const path = require("node:path");
const value = fs.readFileSync(path.join(process.argv[2], "result.txt"), "utf8").trim();
process.stdout.write(JSON.stringify({ assertions: [{ id: "result-file", status: value === "done" ? "passed" : "failed" }] }));
if (value !== "done") process.exitCode = 1;
`));
  }
  const preAdmission = structuredClone(packet) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  writeRef(packet.admission.review!.reviewRecord, "restricted/review.json", Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: packet.admission.status,
    reviewedAt: packet.admission.review!.reviewedAt,
    reviewedBy: packet.admission.review!.reviewedBy,
  })));
  mkdirSync(join(bundleRoot, "packets"));
  writeFileSync(join(bundleRoot, "packets/task.json"), JSON.stringify(packet));
  freezeTaskPacket(bundleRoot, "packets/task.json");

  const fixtureConfiguration = (name: string): Record<string, any> => JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/pi/configs", `${name}.json`), "utf8")) as Record<string, any>;
  const records = {
    model: options.live ? {
      schemaVersion: "ebo.pi-config/v1", kind: "model", provider: "zai", queueModelId: "glm-5-3-flash", model: "glm-5.3-flash",
      api: "openai-completions", baseUrl: options.live ? "https://api.z.ai/api/coding/paas/v4" : "https://fixture.invalid/v1", apiKeyEnv: options.live ? "ZAI_API_KEY" : "PI_FIXTURE_API_KEY",
      thinkingLevel: "off", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } : fixtureConfiguration("model"),
    harness: fixtureConfiguration("harness"),
    limits: options.live ? { schemaVersion: "ebo.pi-config/v1", kind: "native-limits", shutdownGraceMs: 1000, maxRetries: 1, retryBaseDelayMs: 1000, providerTimeoutMs: 60_000 } : fixtureConfiguration("limits"),
    tools: options.live ? { schemaVersion: "ebo.pi-config/v1", kind: "native-tool-policy", tools: ["read", "write"], environmentAllowlist: ["PATH", "HOME", "TMPDIR"] } : fixtureConfiguration("tools"),
    capture: {
      ...fixtureConfiguration("capture"),
      passiveObserver: options.passiveObserver ?? true,
      includeProviderPayloads: options.includeProviderPayloads ?? false,
    },
  };
  records.model.queueModelId = options.configQueueModelId ?? records.model.queueModelId;
  records.model.thinkingLevel = options.thinkingLevel ?? records.model.thinkingLevel;
  records.model.reasoning = options.reasoning ?? records.model.reasoning;
  records.model.baseUrl = options.modelBaseUrl ?? records.model.baseUrl;
  if (["xhigh", "max"].includes(records.model.thinkingLevel)) {
    records.model.thinkingLevelMap = { [records.model.thinkingLevel]: records.model.thinkingLevel };
  }
  if (options.malformedSkill) {
    const skill = { locator: "resources/SKILL.md", digest: digestBytes(Buffer.alloc(0)) };
    writeRef(skill, skill.locator, Buffer.from("---\nname: malformed\n---\nbody\n"));
    records.harness.skills = [skill];
  }
  if (options.declaredToolExtension) {
    const extension = { locator: "resources/declared-tool.mjs", digest: digestBytes(Buffer.alloc(0)) };
    writeRef(extension, extension.locator, Buffer.from(`
export default function (pi) {
  pi.registerTool({
    name: "declared_tool",
    label: "Declared tool",
    description: "A deterministic digest-pinned fixture tool.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  });
}
`));
    records.harness.extensions = [extension];
  }
  if (options.extensionImport) {
    const helper = { locator: "resources/helper.mjs", digest: digestBytes(Buffer.alloc(0)) };
    writeRef(helper, helper.locator, Buffer.from("export const value = 1;\n"));
    const extension = { locator: "resources/importing-extension.mjs", digest: digestBytes(Buffer.alloc(0)) };
    writeRef(extension, extension.locator, Buffer.from('import "./helper.mjs";\nexport default function () {}\n'));
    records.harness.extensions = [extension];
  }
  const modelKey = String(records.model.model).replaceAll(".", "-");
  const experiment: ExperimentConfiguration = {
    schemaVersion: "ebo.experiment/v1",
    id: "pi-runner-fixture",
    taskSet: { task: { packetRef: { locator: "packets/task.json", digest: digestMetadata(packet) } } },
    modelSet: { [modelKey]: { configurationRef: { locator: "configs/model.json", digest: digestBytes(Buffer.alloc(0)) } } },
    harnessSet: {
      [PI_HARNESS]: {
        configurationRef: { locator: "configs/harness.json", digest: digestBytes(Buffer.alloc(0)) },
        nativeLimitsRef: { locator: "configs/limits.json", digest: digestBytes(Buffer.alloc(0)) },
        nativeToolPolicyRef: { locator: "configs/tools.json", digest: digestBytes(Buffer.alloc(0)) },
      },
    },
    trialCount: 1,
    ordering: { seed: "pi-fixture", strategy: "sequential", declaredOrder: { taskIds: ["task"], modelIds: [modelKey], harnessIds: [PI_HARNESS] } },
    coordinatorBudget: { maxWallClockMs: 30_000 },
    captureProfile: { locator: "configs/capture.json", digest: digestBytes(Buffer.alloc(0)) },
  } as ExperimentConfiguration;
  writeRef(experiment.modelSet[modelKey]!.configurationRef, "configs/model.json", Buffer.from(JSON.stringify(records.model)));
  writeRef(experiment.harnessSet[PI_HARNESS]!.configurationRef, "configs/harness.json", Buffer.from(JSON.stringify(records.harness)));
  writeRef(experiment.harnessSet[PI_HARNESS]!.nativeLimitsRef, "configs/limits.json", Buffer.from(JSON.stringify(records.limits)));
  writeRef(experiment.harnessSet[PI_HARNESS]!.nativeToolPolicyRef, "configs/tools.json", Buffer.from(JSON.stringify(records.tools)));
  writeRef(experiment.captureProfile, "configs/capture.json", Buffer.from(JSON.stringify(records.capture)));
  const queue = compileRunQueue(experiment, { bundleRoot });
  const queuePath = join(parent, "queue.json");
  writeRunQueue(queuePath, queue);
  const workspaceRoot = join(parent, "workspaces");
  mkdirSync(workspaceRoot);
  return { parent, bundleRoot, queuePath, runId: queue.entries[0]!.runId, outputRoot: join(parent, "runs"), workspaceRoot };
}

function fakePiSessionFactory(): { createSession: PiSessionFactory; calls(): number; disposals(): number } {
  let calls = 0;
  let disposals = 0;
  const createSession: PiSessionFactory = async (input) => {
    calls += 1;
    const listeners: Array<(event: AgentSessionEvent) => void> = [];
    const observerHandlers = new Map<string, (event: any, context: any) => unknown>();
    if (input.captureProfile.passiveObserver !== false) {
      const extension = createPiPassiveObserver(input.observer as any, 0, input.captureProfile.includeProviderPayloads === true) as any;
      extension.factory({ on: (name: string, handler: (event: any, context: any) => unknown) => observerHandlers.set(name, handler) });
    }
    const toolAssistant = {
      role: "assistant", reasoning_content: HIDDEN_REASONING_CONTENT,
      content: [{ type: "thinking", thinking: HIDDEN_THOUGHT }, { type: "toolCall", id: "tool-1", name: "write", arguments: { path: "result.txt", content: "done\n" }, thoughtSignature: HIDDEN_THOUGHT_SIGNATURE }],
      provider: input.model.provider, model: input.model.model, stopReason: "toolUse", timestamp: 1_700_000_000_250,
      usage: zeroUsage(),
    };
    const finalAssistant = {
      role: "assistant", reasoning_content: HIDDEN_REASONING_CONTENT,
      content: [{ type: "text", text: "done", textSignature: HIDDEN_TEXT_SIGNATURE }, { type: "thinking", thinking: HIDDEN_THOUGHT }],
      provider: input.model.provider, model: input.model.model, stopReason: "stop", timestamp: 1_700_000_000_400,
      usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const records: Record<string, unknown>[] = [
      { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-09T00:00:00.000Z", cwd: input.workspacePath },
      { type: "model_change", id: "entry-model", parentId: null, timestamp: "2026-09-09T00:00:00.001Z", provider: input.model.provider, modelId: input.model.model },
      { type: "message", id: "entry-user", parentId: "entry-model", timestamp: "2026-09-09T00:00:00.002Z", message: { role: "user", content: "Create result.txt", timestamp: 1_700_000_000_200 } },
      { type: "compaction", id: "entry-compact", parentId: "entry-user", timestamp: "2026-09-09T00:00:00.003Z", summary: "prior context", firstKeptEntryId: "entry-user", tokensBefore: 42, usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { type: "message", id: "entry-tool-call", parentId: "entry-compact", timestamp: "2026-09-09T00:00:00.004Z", message: toolAssistant },
      { type: "message", id: "entry-tool", parentId: "entry-tool-call", timestamp: "2026-09-09T00:00:00.005Z", message: { role: "toolResult", toolCallId: "tool-1", toolName: "write", content: [], isError: false, timestamp: 1_700_000_000_300, usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
      { type: "message", id: "entry-assistant", parentId: "entry-tool", timestamp: "2026-09-09T00:00:00.006Z", message: finalAssistant },
    ];
    const session: PiSession = {
      sessionId: SESSION_ID,
      messages: [finalAssistant],
      extensionRunner: { emit: async () => undefined },
      subscribe(listener) { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); },
      async prompt() {
        const observerHook = observerHandlers.get("before_provider_request");
        if (observerHook !== undefined) {
          const providerEvent = { type: "before_provider_request", payload: { type: "thinking_delta", delta: HIDDEN_THOUGHT, apiKey: SYNTHETIC_SECRET } };
          const before = structuredClone(providerEvent);
          const result = await observerHook(providerEvent, { sessionManager: { getSessionId: () => SESSION_ID } });
          assert.deepEqual(providerEvent, before, "the production observer must not mutate provider input");
          assert.equal(result, undefined, "the production observer must not replace provider input");
        }
        const compactionHook = observerHandlers.get("session_before_compact");
        if (compactionHook !== undefined) {
          await compactionHook({ type: "session_before_compact", reason: "threshold", willRetry: false, branchEntries: [] }, { sessionManager: { getSessionId: () => SESSION_ID } });
        }
        const mutable = { type: "tool_execution_start", toolCallId: "tool-1", toolName: "write", args: { path: "result.txt", content: "done\n" } } as unknown as AgentSessionEvent;
        emit(listeners, { type: "agent_start" } as AgentSessionEvent);
        emit(listeners, { type: "turn_start", turnIndex: 0, timestamp: 1_700_000_000_000 } as AgentSessionEvent);
        emit(listeners, mutable);
        (mutable as unknown as { toolName: string }).toolName = "mutated-after-callback";
        emit(listeners, { type: "message_update", message: finalAssistant, assistantMessageEvent: { type: "thinking_delta", delta: HIDDEN_THOUGHT } } as unknown as AgentSessionEvent);
        emit(listeners, { type: "message_update", message: finalAssistant, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: HIDDEN_THOUGHT, partial: finalAssistant } } as unknown as AgentSessionEvent);
        emit(listeners, { type: "message_update", message: toolAssistant, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: toolAssistant } } as unknown as AgentSessionEvent);
        writeFileSync(join(input.workspacePath, "result.txt"), "done\n");
        emit(listeners, { type: "tool_execution_end", toolCallId: "tool-1", toolName: "write", result: { content: "done" }, isError: false } as unknown as AgentSessionEvent);
        emit(listeners, { type: "turn_end", turnIndex: 0, message: toolAssistant, toolResults: [] } as unknown as AgentSessionEvent);
        emit(listeners, { type: "turn_start", turnIndex: 1, timestamp: 1_700_000_000_350 } as AgentSessionEvent);
        emit(listeners, { type: "compaction_start", reason: "threshold" } as unknown as AgentSessionEvent);
        emit(listeners, { type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false } as unknown as AgentSessionEvent);
        emit(listeners, { type: "future_event", payload: { retained: true } } as unknown as AgentSessionEvent);
        emit(listeners, { type: "turn_end", turnIndex: 1, message: finalAssistant, toolResults: [] } as unknown as AgentSessionEvent);
        emit(listeners, { type: "agent_end", messages: [finalAssistant], willRetry: false } as unknown as AgentSessionEvent);
        emit(listeners, { type: "agent_settled" } as AgentSessionEvent);
      },
      async waitForIdle() {},
      async abort() {},
      exportToJsonl(outputPath) { writeFileSync(outputPath!, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`); return outputPath!; },
      getActiveToolNames() { return [...input.toolPolicy.tools]; },
      dispose() { disposals += 1; },
    };
    return session;
  };
  return { createSession, calls: () => calls, disposals: () => disposals };
}

function zeroUsage(): Record<string, unknown> {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function emit(listeners: Array<(event: AgentSessionEvent) => void>, event: AgentSessionEvent): void {
  for (const listener of listeners) listener(event);
}

type ArtifactReferenceLike = { locator: string; digest: { algorithm: "sha256"; value: string } };

function fixtureArchive(): Buffer {
  const entries = [
    { path: "README.md", bytes: Buffer.from("# Pi fixture\n"), type: "0" },
    { path: "package.json", bytes: Buffer.from("{}\n"), type: "0" },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n"), type: "0" },
  ];
  const blocks = entries.map(({ path, bytes, type }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readManifest(bundleRoot: string): RunManifest {
  return JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as RunManifest;
}

function snapshotManifestArtifacts(bundleRoot: string, manifest: RunManifest): Map<string, Buffer> {
  return new Map([...["manifest.json"], ...manifest.evidence.map(({ relativePath }) => relativePath)].map((path) => [path, readFileSync(join(bundleRoot, path))]));
}
