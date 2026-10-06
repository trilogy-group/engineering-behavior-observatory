import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  captureDevinCli,
  DEVIN_CLI_CAPABILITIES,
  DEVIN_CLI_VERSION,
  describeAndValidateDevinDataset,
  normalizeDevinCapture,
  qualifyRetainedDevinCapture,
  type DevinCliCapture,
  type DevinCliConfiguration,
} from "../src/devin.js";
import { captureDevinCliRun, DEVIN_CONTRACT_DIGEST, resolveDevinConfigurationRecord, runDevinQueueEntry } from "../src/devin-run.js";
import { decodeOtlpProtobuf } from "../src/otlp-protobuf.js";
import {
  compileRunQueue,
  createPortableRunBundleExport,
  createRetainedBehaviorEvidence,
  createRetainedStructuralObservationSet,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  main,
  qualifyRunBundle,
  readPortableRunBundleExport,
  writeRunQueue,
  type ExperimentConfiguration,
  type PortableExportPolicy,
  type RunBundleDefinition,
  type RunManifest,
  type TaskPacket,
} from "../src/index.js";

const fixture = resolve("test/fixtures/devin/fake-acp-server.mjs");
const CREDENTIAL_ENV = "EBO_FAKE_DEVIN_KEY";
const CREDENTIAL_VALUE = "fixture-credential-value-9c1d";
const REASONING_SENTINEL = "FIXTURE-HIDDEN-THOUGHT-7f3a";
process.env[CREDENTIAL_ENV] = CREDENTIAL_VALUE;
process.env.EBO_FAKE_DEVIN_EMPTY = "";

type EvidenceRecord = {
  sequence: number;
  kind: string;
  method?: string;
  id?: unknown;
  status?: string;
  payload?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  parseError?: string;
  raw?: string;
};

test("Devin ACP success turn ends on the native session/prompt response and normalizes without copying reasoning", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "success", ["logs", "metrics"]);
    assert.equal(capture.terminalStatus, "completed");
    assert.equal(capture.terminal?.stopReason, "end_turn");
    assert.equal(capture.sessionId, "fixture-session");
    assert.equal(capture.qualification, "qualified");
    assert.deepEqual(capture.gaps, []);
    assert.equal(capture.process.status, "completed");

    const records = await readEvidence(join(root, "session.jsonl"));
    const kinds = records.map(({ kind, method }) => `${kind}:${method ?? ""}`);
    assert.ok(kinds.includes("request:initialize"));
    assert.ok(kinds.includes("request:session/new"));
    assert.ok(kinds.includes("request:session/prompt"));
    assert.ok(kinds.includes("response:session/prompt"));
    assert.ok(kinds.includes("completion:session/prompt"));
    assert.ok(kinds.includes("process:"));
    const completion = records.find(({ kind }) => kind === "completion");
    assert.equal(completion?.status, "end_turn");
    const promptResponse = records.findIndex(({ kind, method }) => kind === "response" && method === "session/prompt");
    const processExit = records.findIndex(({ kind }) => kind === "process");
    assert.ok(promptResponse < processExit, "native terminal evidence precedes process exit");
    assert.ok(records.some(({ payload }) => isRecord(payload?.update) && payload.update.sessionUpdate === "agent_thought_chunk"));

    const evidenceText = await readFile(join(root, "session.jsonl"), "utf8");
    assert.equal(evidenceText.includes(CREDENTIAL_VALUE), false);
    assert.equal(JSON.stringify(capture.telemetry).includes(CREDENTIAL_VALUE), false);
    assert.ok(capture.telemetry.effectiveConfiguration.environmentKeys.includes(CREDENTIAL_ENV));
    assert.equal(capture.telemetry.effectiveConfiguration.appliedModel, "swe-2-high");
    assert.equal(capture.telemetry.effectiveConfiguration.appliedMode, "accept-edits");
    assert.equal(capture.telemetry.runtime.version, DEVIN_CLI_VERSION);
    assert.deepEqual(capture.telemetry.usage.final, { totalTokens: 11006, inputTokens: 10985, outputTokens: 21, cachedReadTokens: 10840 });
    assert.equal(capture.telemetry.usage.updates.length, 1);
    assert.equal(capture.telemetry.usage.agentStopped?.toolCalls, 1);

    assert.equal(capture.telemetry.telemetry.receipt.status, "received");
    assert.equal(capture.telemetry.telemetry.receipt.signals.logs.status, "received");
    assert.equal(capture.telemetry.telemetry.receipt.signals.metrics.status, "received");
    const logRecord = capture.telemetry.telemetry.records.find(({ signal }) => signal === "logs");
    assert.equal(logRecord?.contentType, "application/x-protobuf");
    assert.equal(logRecord?.parseError, undefined);
    const resourceLogs = (logRecord?.payload as { resourceLogs: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }> }).resourceLogs;
    assert.ok(resourceLogs[0]!.resource.attributes.some(({ key, value }) => key === "service.name" && value.stringValue === "devin-local"));
    assert.ok(resourceLogs[0]!.resource.attributes.some(({ key }) => key === "ebo.attempt_id"));
    const metricRecord = capture.telemetry.telemetry.records.find(({ signal }) => signal === "metrics");
    assert.ok(JSON.stringify(metricRecord?.payload).includes("devin.token.usage"));
    for (const record of capture.telemetry.telemetry.records) {
      const body = Buffer.from(record.body, "base64");
      assert.equal(body.length, record.sizeBytes, "the original OTLP body is retained alongside its projection");
      assert.equal(record.bodyDigest, `sha256:${digestBytes(body).value}`);
      assert.deepEqual(decodeOtlpProtobuf(record.signal, body), record.payload, "the projection re-derives from the retained body");
    }

    const retainedOptions = { sessionId: "fixture-session", expectsCompletion: true, harnessVersion: DEVIN_CLI_VERSION, runtimeVersions: [DEVIN_CLI_VERSION] };
    assert.equal(qualifyRetainedDevinCapture(capture, retainedOptions).promptRequestId, capture.promptRequestId);
    assert.throws(() => qualifyRetainedDevinCapture(capture, { ...retainedOptions, sessionId: "foreign-session" }), /session identity differs/u);
    assert.throws(() => qualifyRetainedDevinCapture(capture, { ...retainedOptions, runtimeVersions: [DEVIN_CLI_VERSION, "3000.10.0"] }), /runtime version differs/u);
    assert.throws(() => qualifyRetainedDevinCapture(capture, { ...retainedOptions, harnessVersion: "3000.10.0" }), /Unsupported retained Devin runtime/u);
    const { dataset, coverage } = await describeAndValidateDevinDataset(capture);
    const families = dataset.events.map(({ family }) => family);
    assert.deepEqual([...new Set(families)].sort(), ["message", "outcome", "runtime", "tool"]);
    assert.equal(dataset.events.filter(({ family }) => family === "tool").length, 2, "tool start and terminal update only; progress updates stay native");
    const outcome = dataset.events.find(({ family }) => family === "outcome");
    assert.equal(outcome?.attributes.stopReason, "end_turn");
    assert.equal(outcome?.attributes.totalTokens, 11006);
    assert.equal(outcome?.attributes.outputTokens, 21);
    assert.equal(outcome?.attributes.usageSemantics, "final-request", "session/prompt usage is the final request, not a turn total");
    assert.equal(outcome?.attributes.resourceSemantics, undefined);
    const stopped = dataset.events.find(({ family, attributes }) => family === "runtime" && attributes.resourceSemantics !== undefined);
    assert.equal(stopped?.attributes.resourceSemantics, "cumulative-final");
    assert.equal(stopped?.attributes.outputTokens, 118, "only agent_stopped carries the cumulative turn total");
    const terminalTool = dataset.events.find(({ family, phase }) => family === "tool" && phase === "after");
    assert.equal(terminalTool?.attributes.status, "completed");
    assert.equal(terminalTool?.attributes.exitCode, 0);
    assert.equal(terminalTool?.relations.parent.status, "known");
    assert.ok(dataset.events.every(({ scope }) => scope.kind !== "session" || scope.id === "fixture-session"));
    assert.equal(JSON.stringify(dataset.events).includes(REASONING_SENTINEL), false);
    assert.equal(JSON.stringify(dataset.events).includes("DONE"), false, "content stays a native reference");
    assert.ok(dataset.events.every(({ nativeTime }) => nativeTime.status === "known"));
    assert.ok(dataset.events.every(({ attributes }) => attributes.nativeTimeSource === "capture-receipt"));
    assert.ok(dataset.unmapped.length > 0);
    assert.equal(coverage.adapter.id, DEVIN_CLI_CAPABILITIES.adapterId);
    assert.equal(coverage.records.mapped + coverage.records.unmapped, coverage.records.total);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin tool failure stays a completed turn with the native failed status and exit code", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "tool-failure");
    assert.equal(capture.terminalStatus, "completed");
    const { events } = await normalizeDevinCapture(capture);
    const terminalTool = events.find(({ family, phase }) => family === "tool" && phase === "after");
    assert.equal(terminalTool?.attributes.status, "failed");
    const toolEvents = events.filter(({ family }) => family === "tool");
    assert.equal(toolEvents.length, 2);
    assert.ok(toolEvents.some(({ attributes }) => attributes.exitCode === 1 || attributes.status === "failed"));
    assert.equal(capture.telemetry.telemetry.receipt.status, "not-checked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin cancellation sends session/cancel and keeps the native cancelled stop reason", async () => {
  const root = await temporaryRoot();
  try {
    const controller = new AbortController();
    const capturePromise = runFake(root, "interrupt", [], controller.signal);
    await waitForRecord(join(root, "session.jsonl"), (record) => record.kind === "notification"
      && isRecord(record.payload?.update) && record.payload.update.sessionUpdate === "tool_call_update");
    controller.abort();
    const capture = await capturePromise;
    assert.equal(capture.terminalStatus, "interrupted");
    assert.equal(capture.terminal?.stopReason, "cancelled");
    assert.equal(capture.qualification, "qualified-with-gaps");
    const records = await readEvidence(join(root, "session.jsonl"));
    assert.ok(records.some(({ kind, method }) => kind === "notification" && method === "session/cancel"));
    const stopped = records.find(({ method }) => method === "_cognition.ai/agent_stopped");
    assert.equal(stopped?.payload?.cause, "cancelled");
    const { events } = await normalizeDevinCapture(capture);
    assert.equal(events.find(({ family }) => family === "outcome")?.attributes.stopReason, "cancelled");
    assert.equal(events.find(({ family, phase }) => family === "tool" && phase === "after")?.attributes.canceled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin missing usage stays absent instead of becoming zero", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "missing-usage");
    assert.equal(capture.terminalStatus, "completed");
    assert.equal(capture.terminal?.usage, undefined);
    assert.equal(capture.telemetry.usage.final, undefined);
    assert.deepEqual(capture.telemetry.usage.updates, []);
    const { events } = await normalizeDevinCapture(capture);
    const outcome = events.find(({ family }) => family === "outcome");
    assert.equal(outcome?.attributes.stopReason, "end_turn");
    assert.equal("totalTokens" in (outcome?.attributes ?? {}), false);
    assert.equal(events.some(({ attributes }) => attributes.usageSemantics === "request-context-snapshot"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin malformed ACP frames are retained and end the attempt without a native terminal", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "malformed");
    assert.equal(capture.terminalStatus, undefined);
    assert.equal(capture.process.status, "malformed");
    assert.equal(capture.qualification, "qualified-with-gaps");
    assert.ok(capture.gaps.some(({ kind }) => kind === "capture-error"));
    assert.equal(capture.process.protocolError?.raw, "this is not json");
    const records = await readEvidence(join(root, "session.jsonl"));
    assert.ok(records.some(({ kind }) => kind === "error"));
    assert.ok(records.some(({ kind }) => kind === "process"));
    assert.ok(records.some(({ payload }) => isRecord(payload?.update) && payload.update.sessionUpdate === "agent_thought_chunk"), "frames before the malformed line stay retained");
    const { dataset } = await describeAndValidateDevinDataset(capture);
    assert.equal(dataset.events.some(({ family }) => family === "outcome"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin child crash keeps partial evidence, stderr, and an explicit capture gap", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "crash", ["logs", "metrics"]);
    assert.equal(capture.terminalStatus, undefined);
    assert.equal(capture.process.status, "failed");
    assert.equal(capture.process.launch.exitCode, 3);
    assert.ok(capture.gaps.some(({ kind, detail }) => kind === "capture-error" && detail.includes("exited before session/prompt")));
    assert.ok((await readFile(join(root, "diagnostics/stderr.txt"), "utf8")).includes("panicked"));
    assert.equal(capture.telemetry.telemetry.receipt.status, "missing");
    assert.equal(capture.telemetry.telemetry.receipt.signals.logs.status, "received");
    const records = await readEvidence(join(root, "session.jsonl"));
    assert.ok(records.some(({ payload }) => isRecord(payload?.update) && payload.update.sessionUpdate === "tool_call"));
    assert.equal(records.some(({ kind, method }) => kind === "response" && method === "session/prompt"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin permission requests are answered with the configured decision and retained in both directions", async () => {
  const root = await temporaryRoot();
  try {
    const allowed = await runFake(root, "permission");
    assert.equal(allowed.terminalStatus, "completed");
    const records = await readEvidence(join(root, "session.jsonl"));
    const request = records.find(({ kind, method }) => kind === "request" && method === "session/request_permission");
    const response = records.find(({ kind, method }) => kind === "response" && method === "session/request_permission");
    assert.ok(request);
    assert.deepEqual(response?.payload?.outcome, { outcome: "selected", optionId: "allow_once" });
    const { events } = await normalizeDevinCapture(allowed);
    const permission = events.find(({ family }) => family === "permission");
    assert.equal(permission?.attributes.toolCallId, "call_fixture0001#abcdef");
    assert.equal(permission?.attributes.optionCount, 3);
    assert.equal(events.find(({ family, phase }) => family === "tool" && phase === "after")?.attributes.status, "completed");

    const rejectRoot = join(root, "reject");
    await mkdir(rejectRoot);
    const rejected = await runFake(rejectRoot, "permission", [], undefined, "reject-once");
    assert.equal(rejected.terminalStatus, "completed");
    const rejectRecords = await readEvidence(join(rejectRoot, "session.jsonl"));
    const rejectResponse = rejectRecords.find(({ kind, method }) => kind === "response" && method === "session/request_permission");
    assert.deepEqual(rejectResponse?.payload?.outcome, { outcome: "selected", optionId: "reject_once" });
    const rejectedEvents = await normalizeDevinCapture(rejected);
    assert.equal(rejectedEvents.events.find(({ family, phase }) => family === "tool" && phase === "after")?.attributes.status, "failed");

    const missingRoot = join(root, "missing-option");
    await mkdir(missingRoot);
    const missing = await runFake(missingRoot, "permission-without-options");
    assert.ok(missing.gaps.some(({ kind }) => kind === "permission-option-missing"));
    const missingRecords = await readEvidence(join(missingRoot, "session.jsonl"));
    assert.deepEqual(missingRecords.find(({ kind, method }) => kind === "response" && method === "session/request_permission")?.payload?.outcome, { outcome: "cancelled" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin foreign session traffic is retained but never attributed to the owned session", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "foreign-session");
    assert.equal(capture.terminalStatus, "completed");
    assert.ok(capture.gaps.some(({ kind }) => kind === "foreign-permission-request"));
    assert.equal(capture.telemetry.usage.updates.length, 1, "foreign usage updates are not collected");
    assert.equal(capture.telemetry.usage.agentStopped?.toolCalls, 1, "foreign agent_stopped statistics are ignored");
    const records = await readEvidence(join(root, "session.jsonl"));
    assert.ok(records.some(({ payload }) => payload?.sessionId === "foreign-session"), "foreign frames stay in native evidence");
    const { dataset } = await describeAndValidateDevinDataset(capture);
    assert.ok(dataset.events.every(({ scope, attributes }) => scope.id !== "foreign-session" && attributes.toolCallId !== "call_foreign"));
    assert.equal(dataset.events.filter(({ family }) => family === "tool").length, 2);
    assert.equal(dataset.events.filter(({ family }) => family === "runtime").length, 2);
    assert.ok(dataset.unmapped.length >= 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin unsupported client requests, missing agent_stopped, and non-end_turn stops stay explicit", async () => {
  const root = await temporaryRoot();
  try {
    const unsupported = await runFake(join(root, "a"), "unsupported-request");
    assert.equal(unsupported.terminalStatus, "completed");
    assert.ok(unsupported.gaps.some(({ kind }) => kind === "unsupported-client-request"));
    const records = await readEvidence(join(root, "a/session.jsonl"));
    const declined = records.find(({ kind, method }) => kind === "response" && method === "fs/read_text_file");
    assert.ok(isRecord(declined?.payload?.error));

    const noStop = await runFake(join(root, "b"), "no-agent-stopped");
    assert.equal(noStop.terminalStatus, "completed");
    assert.equal(noStop.telemetry.usage.agentStopped, undefined);
    assert.ok(noStop.gaps.some(({ kind }) => kind === "agent-stopped-missing"));

    const maxTokens = await runFake(join(root, "c"), "max-tokens");
    assert.equal(maxTokens.terminalStatus, "failed", "only end_turn completes; other native stop reasons are failed turns with retained evidence");
    assert.equal(maxTokens.terminal?.stopReason, "max_tokens");
    assert.ok(maxTokens.gaps.some(({ kind }) => kind === "terminal-stop-reason"));
    assert.equal(maxTokens.qualification, "qualified-with-gaps");

    const promptError = await runFake(join(root, "d"), "prompt-error");
    assert.equal(promptError.terminalStatus, "failed");
    assert.ok(isRecord(promptError.terminal?.error));
    const { events } = await normalizeDevinCapture(promptError);
    assert.equal(events.find(({ family }) => family === "outcome")?.attributes.error, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin mode and model mismatches are gaps, and unauthenticated children fail before any prompt", async () => {
  const root = await temporaryRoot();
  try {
    const mode = await runFake(join(root, "a"), "mode-mismatch", [], undefined, "allow-once", "swe-2-high", "plan");
    assert.ok(mode.gaps.some(({ kind }) => kind === "mode-mismatch"), JSON.stringify(mode.gaps));
    assert.equal(mode.telemetry.effectiveConfiguration.appliedMode, "accept-edits");
    const applied = await runFake(join(root, "a2"), "success", [], undefined, "allow-once", "swe-2-high", "plan");
    assert.deepEqual(applied.gaps, []);
    assert.equal(applied.telemetry.effectiveConfiguration.appliedMode, "plan");
    const model = await runFake(join(root, "b"), "model-mismatch", [], undefined, "allow-once", "swe-1-7-lightning-medium");
    assert.ok(model.gaps.some(({ kind }) => kind === "model-mismatch"), JSON.stringify(model.gaps));
    const protocol = await runFake(join(root, "c"), "protocol-mismatch");
    assert.ok(protocol.gaps.some(({ kind }) => kind === "protocol-version-mismatch"));

    await mkdir(join(root, "d"), { recursive: true });
    const unauthenticated = await captureDevinCli({
      runId: "run-auth",
      attemptId: "attempt-auth",
      workspacePath: join(root, "d"),
      prompt: "Perform one small task.",
      configuration: { ...fakeConfiguration("success"), credentialEnv: "EBO_FAKE_DEVIN_EMPTY" },
      evidencePath: join(root, "d/session.jsonl"),
      shutdownGraceMs: 500,
    });
    assert.equal(unauthenticated.terminalStatus, undefined);
    assert.equal(unauthenticated.sessionId, undefined);
    assert.ok(unauthenticated.gaps.some(({ kind, detail }) => kind === "capture-error" && detail.includes("session/new")));
    const records = await readEvidence(join(root, "d/session.jsonl"));
    assert.equal(records.some(({ method }) => method === "session/prompt"), false);

    await assert.rejects(captureDevinCli({
      runId: "run-missing",
      attemptId: "attempt-missing",
      workspacePath: join(root, "d"),
      prompt: "Perform one small task.",
      configuration: { ...fakeConfiguration("success"), credentialEnv: "EBO_FAKE_DEVIN_UNSET_VARIABLE" },
      evidencePath: join(root, "d/unset.jsonl"),
    }), /is not set/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captureDevinCli rejects a missing credential before allocating the OTLP receiver and exits cleanly", async () => {
  const root = await temporaryRoot();
  try {
    delete process.env.EBO_DEVIN_UNSET_CREDENTIAL;
    await assert.rejects(runFake(root, "success", ["logs"], undefined, "allow-once", "swe-2-high", "accept-edits", "EBO_DEVIN_UNSET_CREDENTIAL"), /EBO_DEVIN_UNSET_CREDENTIAL is not set/u);
    const script = `
      import { captureDevinCli } from ${JSON.stringify(pathToFileURL(resolve("dist/src/devin.js")).href)};
      try {
        await captureDevinCli({ runId: "r", attemptId: "a", workspacePath: ${JSON.stringify(root)}, prompt: "x", evidencePath: ${JSON.stringify(join(root, "s.jsonl"))},
          configuration: { executable: process.execPath, executableArgs: [${JSON.stringify(fixture)}, "--mode=success"], version: ${JSON.stringify(DEVIN_CLI_VERSION)},
            model: "swe-2-high", mode: "accept-edits", permissionDecision: "allow-once",
            credentialEnv: "EBO_DEVIN_UNSET_CREDENTIAL", telemetry: { signals: ["logs", "metrics"] } } });
      } catch (error) { console.log(error.message); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, EBO_DEVIN_UNSET_CREDENTIAL: undefined }, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const exit = await waitForChild(child);
    clearTimeout(timer);
    assert.equal(exit.signal, null, "the process must exit on its own instead of being kept alive by an orphaned receiver");
    assert.equal(exit.code, 0);
    assert.match(output, /EBO_DEVIN_UNSET_CREDENTIAL is not set/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Devin OTLP receiver retains malformed protobuf bodies with a parse error", async () => {
  const root = await temporaryRoot();
  try {
    const capture = await runFake(root, "otlp-malformed", ["logs", "metrics"]);
    assert.equal(capture.terminalStatus, "completed");
    const malformed = capture.telemetry.telemetry.records.filter(({ parseError }) => parseError !== undefined);
    assert.ok(malformed.length > 0);
    assert.ok(malformed.every(({ sizeBytes, payload }) => sizeBytes === 6 && payload === undefined));
    for (const record of malformed) {
      assert.deepEqual(Buffer.from(record.body, "base64"), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f, 0x00]), "undecodable bodies keep their original bytes");
      assert.equal(record.bodyDigest, `sha256:${digestBytes(Buffer.from(record.body, "base64")).value}`);
    }
    assert.equal(capture.telemetry.telemetry.receipt.signals.metrics.status, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OTLP protobuf decoder rejects truncated input and projects nested attributes", () => {
  assert.throws(() => decodeOtlpProtobuf("logs", new Uint8Array([0x0a, 0x10, 0x01])), /truncated|length|exceeds/iu);
  // ResourceLogs{ resource{ attributes[ key="k" value{ string_value="v" } ] } }
  const bytes = new Uint8Array([0x0a, 0x0c, 0x0a, 0x0a, 0x0a, 0x08, 0x0a, 0x01, 0x6b, 0x12, 0x03, 0x0a, 0x01, 0x76]);
  const decoded = decodeOtlpProtobuf("logs", bytes) as { resourceLogs: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }> };
  assert.deepEqual(decoded.resourceLogs[0]!.resource.attributes, [{ key: "k", value: { stringValue: "v" } }]);
});

test("Devin configuration records validate pins, modes, and permission decisions", async () => {
  const root = await temporaryRoot();
  try {
    const write = (name: string, value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const locator = `configs/${name}.json`;
      mkdirSync(dirname(join(root, locator)), { recursive: true });
      writeFileSync(join(root, locator), bytes);
      return { locator, digest: digestBytes(bytes) };
    };
    const harness = write("harness", { schemaVersion: "ebo.devin-config/v1", kind: "harness", adapter: "devin-cli", executable: "/usr/local/bin/devin", version: DEVIN_CLI_VERSION, contractDigest: DEVIN_CONTRACT_DIGEST, arguments: ["--agent-type", "review"] });
    assert.deepEqual(resolveDevinConfigurationRecord(root, harness, "harness").arguments, ["--agent-type", "review"]);
    const wrongDigest = write("harness-digest", { schemaVersion: "ebo.devin-config/v1", kind: "harness", adapter: "devin-cli", executable: "/usr/local/bin/devin", version: DEVIN_CLI_VERSION, contractDigest: `sha256:${"0".repeat(64)}` });
    assert.throws(() => resolveDevinConfigurationRecord(root, wrongDigest, "harness"), /contractDigest/u);
    const wrongVersion = write("harness-version", { schemaVersion: "ebo.devin-config/v1", kind: "harness", adapter: "devin-cli", executable: "/usr/local/bin/devin", version: "3000.12.0", contractDigest: DEVIN_CONTRACT_DIGEST });
    assert.throws(() => resolveDevinConfigurationRecord(root, wrongVersion, "harness"), /not pinned/u);
    const badMode = write("tools", { schemaVersion: "ebo.devin-config/v1", kind: "native-tool-policy", mode: "dangerous", permissionDecision: "allow-once" });
    assert.throws(() => resolveDevinConfigurationRecord(root, badMode, "native-tool-policy"), /mode is invalid/u);
    const badDecision = write("tools-2", { schemaVersion: "ebo.devin-config/v1", kind: "native-tool-policy", mode: "ask", permissionDecision: "allow-always" });
    assert.throws(() => resolveDevinConfigurationRecord(root, badDecision, "native-tool-policy"), /permissionDecision is invalid/u);
    const badSignal = write("capture", { schemaVersion: "ebo.devin-config/v1", kind: "capture-profile", telemetrySignals: ["traces"] });
    assert.throws(() => resolveDevinConfigurationRecord(root, badSignal, "capture-profile"), /telemetrySignals/u);
    const badCredential = write("model", { schemaVersion: "ebo.devin-config/v1", kind: "model", provider: "cognition", model: "swe-2-high", credentialEnv: "lower" });
    assert.throws(() => resolveDevinConfigurationRecord(root, badCredential, "model"), /credentialEnv/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captureDevinCliRun retains a crashed child as a valid failed partial bundle", async () => {
  const root = await temporaryRoot();
  try {
    const startingWorkspace = join(root, "start");
    const workspace = join(root, "workspace");
    await mkdir(startingWorkspace, { recursive: true });
    await mkdir(workspace, { recursive: true });
    const bundleRoot = join(root, "bundle");
    const result = await captureDevinCliRun({
      definition: devinDefinition(bundleRoot, "crash"),
      startingWorkspacePath: startingWorkspace,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: fakeConfiguration("crash"),
      prompt: "Perform one small task.",
      shutdownGraceMs: 500,
    });
    assert.equal(result.attempt.classification.kind, "infrastructure-failure");
    assert.equal(result.manifest.terminal.state, "failed");
    assert.ok(result.manifest.evidence.some(({ kind }) => kind === "session"));
    const sessionRecords = await readEvidence(join(bundleRoot, "session.jsonl"));
    assert.ok(sessionRecords.some(({ kind, method, payload }) => kind === "notification" && method === "diagnostic/stderr"
      && String(payload?.text).includes("panicked before the tool completed")), "child stderr is retained inside the session evidence");
    const reports = await Promise.all((await readdir(join(bundleRoot, "capture"))).map((name) => readFile(join(bundleRoot, "capture", name), "utf8")));
    assert.ok(reports.some((report) => report.includes('"capture-error"')), "the capture report lists the missing native terminal");
    assert.equal(result.qualification.status, "qualified-with-gaps");
    assert.equal((await qualifyRunBundle(bundleRoot, { startingWorkspacePath: startingWorkspace, semanticEvidenceKinds: ["session"], relatedSessionIds: [] })).status, "qualified-with-gaps");
    const evidence = await createRetainedBehaviorEvidence(bundleRoot);
    assert.equal(evidence.capture.qualification, "qualified-with-gaps");
    assert.equal(evidence.dataset.events.some(({ family }) => family === "outcome"), false, "no invented terminal without an owned prompt response");
    await createRetainedStructuralObservationSet(bundleRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDevinQueueEntry executes a frozen queue entry and produces a normalized bundle", async () => {
  const root = await temporaryRoot();
  try {
    const queueFixture = createQueueFixture(root);
    const outputRoot = join(root, "runs");
    const summary = await runDevinQueueEntry({
      bundleRoot: queueFixture.bundleRoot,
      queuePath: queueFixture.queuePath,
      runId: queueFixture.runId,
      outputRoot,
      workspaceRoot: join(root, "workspaces"),
      probeRuntime: async () => ({ path: process.execPath, version: DEVIN_CLI_VERSION }),
      executableArgs: [fixture, "--mode=success"],
    });
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    assert.equal(summary.sessionId, "fixture-session");
    assert.equal(summary.stopReason, "end_turn");
    assert.ok(summary.normalizedEvents >= 6);
    assert.equal(summary.terminal.state, "completed");
    const manifest = JSON.parse(await readFile(join(summary.bundlePath, "manifest.json"), "utf8")) as RunManifest;
    assert.equal(manifest.run.harness.id, "devin-cli");
    assert.equal(manifest.run.harness.version, DEVIN_CLI_VERSION);
    assert.ok(manifest.run.runtime.some(({ name, version }) => name === "devin-cli" && version === DEVIN_CLI_VERSION));
    assert.ok(manifest.evidence.some(({ kind, nativeReference }) => kind === "session" && nativeReference?.id === "fixture-session"));
    assert.ok(manifest.evidence.some(({ kind }) => kind === "workspace"));
    const telemetry = await readFile(join(summary.bundlePath, "telemetry/devin.json"), "utf8");
    assert.equal(telemetry.includes(CREDENTIAL_VALUE), false);
    assert.ok(telemetry.includes(`"${CREDENTIAL_ENV}"`));
    const files = await readdir(summary.bundlePath, { recursive: true });
    assert.ok(files.includes("session.jsonl"));
    const workspaceEvidence = manifest.evidence.find(({ kind }) => kind === "workspace");
    assert.ok(workspaceEvidence);
    const workspaceBytes = await readFile(join(summary.bundlePath, workspaceEvidence.relativePath));
    const workspaceText = workspaceEvidence.relativePath.endsWith(".gz") ? gunzipSync(workspaceBytes).toString("latin1") : workspaceBytes.toString("utf8");
    assert.ok(workspaceText.includes("devin-result.txt"), "the workspace outcome packages the file the fixture agent wrote");

    const evidence = await createRetainedBehaviorEvidence(summary.bundlePath);
    assert.equal(evidence.dataset.adapter.id, DEVIN_CLI_CAPABILITIES.adapterId);
    assert.equal(evidence.dataset.events.length, summary.normalizedEvents, "reopened evidence reproduces the capture-time normalization");
    assert.equal(evidence.coverage.records.mapped + evidence.coverage.records.unmapped, evidence.coverage.records.total);
    const observations = await createRetainedStructuralObservationSet(summary.bundlePath);
    assert.ok(observations.observations.length > 0);
    assert.equal(await main(["observations", "create", summary.bundlePath, join(root, "observations.json")], () => undefined), 0);
    assert.deepEqual(JSON.parse(await readFile(join(summary.bundlePath, "manifest.json"), "utf8")), manifest, "readback never rewrites the manifest");

    const sessionDescriptor = manifest.evidence.find(({ kind }) => kind === "session")!;
    const sessionPath = join(summary.bundlePath, sessionDescriptor.relativePath);
    const telemetryPath = join(summary.bundlePath, "telemetry/devin.json");
    const originalSession = await readFile(sessionPath);
    const records = originalSession.toString().trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    const mutations: Array<[string, RegExp, () => Promise<void>]> = [
      ["foreign-session", /SESSION_RECORD_IDENTITY_MISMATCH|session identity differs/u, async () => {
        const changed = structuredClone(manifest);
        changed.run.native = { ...changed.run.native, sessionId: "foreign-session" };
        for (const descriptor of changed.evidence) {
          if (descriptor.kind === "session" && descriptor.nativeReference?.type === "session") descriptor.nativeReference.id = "foreign-session";
        }
        await writeFile(join(summary.bundlePath, "manifest.json"), JSON.stringify(changed));
      }],
      ["telemetry-version", /runtime version differs/u, async () => {
        const document = JSON.parse(telemetry) as Record<string, any>;
        document.runtime.version = "3000.10.0";
        const bytes = Buffer.from(JSON.stringify(document));
        const changed = structuredClone(manifest);
        const descriptor = changed.evidence.find(({ relativePath }) => relativePath === "telemetry/devin.json")!;
        descriptor.digest = `sha256:${digestBytes(bytes).value}`;
        descriptor.sizeBytes = bytes.length;
        await writeFile(telemetryPath, bytes);
        await writeFile(join(summary.bundlePath, "manifest.json"), JSON.stringify(changed));
      }],
      ["cancelled-terminal", /end_turn terminal evidence/u, async () => {
        const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record.kind === "response" && record.method === "session/prompt"
          ? { ...record, payload: { ...record.payload, stopReason: "cancelled" } } : record)).join("\n")}\n`);
        const changed = structuredClone(manifest);
        const descriptor = changed.evidence.find(({ id }) => id === sessionDescriptor.id)!;
        descriptor.digest = `sha256:${digestBytes(bytes).value}`;
        descriptor.sizeBytes = bytes.length;
        await writeFile(sessionPath, bytes);
        await writeFile(join(summary.bundlePath, "manifest.json"), JSON.stringify(changed));
      }],
      ["duplicate-prompt", /requires one owned request/u, async () => {
        const prompt = records.find((record) => record.kind === "request" && record.method === "session/prompt")!;
        const bytes = Buffer.from(`${[...records, { ...prompt, sequence: records.length + 1 }].map((record) => JSON.stringify(record)).join("\n")}\n`);
        const changed = structuredClone(manifest);
        const descriptor = changed.evidence.find(({ id }) => id === sessionDescriptor.id)!;
        descriptor.digest = `sha256:${digestBytes(bytes).value}`;
        descriptor.sizeBytes = bytes.length;
        await writeFile(sessionPath, bytes);
        await writeFile(join(summary.bundlePath, "manifest.json"), JSON.stringify(changed));
      }],
    ];
    for (const [name, expected, mutate] of mutations) {
      await writeFile(sessionPath, originalSession);
      await writeFile(telemetryPath, telemetry);
      await writeFile(join(summary.bundlePath, "manifest.json"), JSON.stringify(manifest));
      await mutate();
      await assert.rejects(createRetainedBehaviorEvidence(summary.bundlePath), expected, name);
    }
    await writeFile(sessionPath, originalSession);
    await writeFile(telemetryPath, telemetry);
    await writeFile(join(summary.bundlePath, "manifest.json"), JSON.stringify(manifest));

    await assert.rejects(runDevinQueueEntry({
      bundleRoot: queueFixture.bundleRoot,
      queuePath: queueFixture.queuePath,
      runId: queueFixture.runId,
      outputRoot,
      workspaceRoot: join(root, "workspaces"),
      probeRuntime: async () => ({ path: process.execPath, version: "3000.12.0" }),
      executableArgs: [fixture, "--mode=success"],
    }), /3000\.11\.3 is required/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable export removes Devin thought content while the retained bundle keeps it", async () => {
  const root = await temporaryRoot();
  try {
    const queueFixture = createQueueFixture(root);
    const summary = await runDevinQueueEntry({
      bundleRoot: queueFixture.bundleRoot,
      queuePath: queueFixture.queuePath,
      runId: queueFixture.runId,
      outputRoot: join(root, "runs"),
      workspaceRoot: join(root, "workspaces"),
      probeRuntime: async () => ({ path: process.execPath, version: DEVIN_CLI_VERSION }),
      executableArgs: [fixture, "--mode=success"],
    });
    assert.ok((await readFile(join(summary.bundlePath, "session.jsonl"), "utf8")).includes(REASONING_SENTINEL));
    const policy: PortableExportPolicy = { sharingClass: "partner", maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024 };
    const exportRoot = join(root, "portable");
    const exported = await createPortableRunBundleExport({ sourceRoot: summary.bundlePath, destinationRoot: exportRoot, policy });
    await readPortableRunBundleExport(exportRoot, policy);
    const session = exported.artifacts.find(({ kind }) => kind === "session");
    assert.ok(session);
    const portableSession = await readFile(join(exportRoot, session.relativePath), "utf8");
    assert.equal(portableSession.includes(REASONING_SENTINEL), false);
    assert.ok(portableSession.includes("agent_thought_chunk"), "the update type remains; only its content is removed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI signals cancel and finalize the detached Devin child", async () => {
  const root = await temporaryRoot();
  try {
    const executable = join(root, "fake-devin.mjs");
    writeFileSync(executable, `#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("devin ${DEVIN_CLI_VERSION} (fixture)");\nelse { process.argv.push("--mode=hang"); await import(${JSON.stringify(pathToFileURL(fixture).href)}); }\n`, { mode: 0o700 });
    const queueFixture = createQueueFixture(root, executable);
    const outputRoot = join(root, "cli-runs");
    const child = spawn(process.execPath, [
      resolve("dist/src/cli.js"),
      "devin", "run",
      queueFixture.bundleRoot,
      queueFixture.queuePath,
      queueFixture.runId,
      outputRoot,
      "--workspace-root", join(root, "cli-workspaces"),
    ], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitPromise = waitForChild(child);
    const sessionPath = await waitForNestedRecord(outputRoot, (record) => record.kind === "notification"
      && isRecord(record.payload) && isRecord(record.payload.update) && record.payload.update.sessionUpdate === "tool_call");
    child.kill("SIGINT");
    const exit = await exitPromise;
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    const summary = JSON.parse(stdout.trim()) as { bundlePath: string; classification: string };
    assert.equal(summary.classification, "interrupted");
    const manifest = JSON.parse(await readFile(join(summary.bundlePath, "manifest.json"), "utf8")) as RunManifest;
    assert.ok(manifest.evidence.some(({ kind }) => kind === "session"));
    assert.ok(manifest.evidence.some(({ kind }) => kind === "telemetry"));
    const records = await readEvidence(sessionPath);
    assert.ok(records.some(({ kind, method }) => kind === "notification" && method === "session/cancel"));
    const processRecord = records.find(({ kind }) => kind === "process");
    assert.ok(processRecord?.evidence?.signal === "SIGKILL" || processRecord?.evidence?.signal === "SIGTERM" || processRecord?.evidence?.exitCode !== undefined);
    assert.equal(typeof processRecord?.evidence?.pid, "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runFake(
  root: string,
  fixtureMode: string,
  signals: readonly ("logs" | "metrics")[] = [],
  signal?: AbortSignal,
  permissionDecision: "allow-once" | "reject-once" = "allow-once",
  model = "swe-2-high",
  mode: DevinCliConfiguration["mode"] = "accept-edits",
  credentialEnv = CREDENTIAL_ENV,
): Promise<DevinCliCapture> {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return captureDevinCli({
    runId: `run-${fixtureMode}`,
    attemptId: `attempt-${fixtureMode}`,
    workspacePath: workspace,
    prompt: "Perform one small task.",
    configuration: { ...fakeConfiguration(fixtureMode), permissionDecision, model, mode, credentialEnv, ...(signals.length === 0 ? {} : { telemetry: { signals } }) },
    evidencePath: join(root, "session.jsonl"),
    stderrPath: join(root, "diagnostics/stderr.txt"),
    shutdownGraceMs: 500,
    ...(signal === undefined ? {} : { signal }),
  });
}

function fakeConfiguration(mode: string): DevinCliConfiguration {
  return {
    executable: process.execPath,
    executableArgs: [fixture, `--mode=${mode}`],
    version: DEVIN_CLI_VERSION,
    model: "swe-2-high",
    mode: "accept-edits",
    permissionDecision: "allow-once",
    credentialEnv: CREDENTIAL_ENV,
  };
}

function devinDefinition(bundleRoot: string, suffix: string): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-devin-${suffix}`,
    run: {
      id: `run-devin-${suffix}`,
      assessmentMode: "observational",
      task: { id: "task-devin" },
      fixture: { id: "fixture", digest: `sha256:${"1".repeat(64)}` },
      model: { provider: "cognition", id: "swe-2-high" },
      harness: { id: "devin-cli", version: DEVIN_CLI_VERSION },
      runtime: [],
    },
    attempt: { id: `attempt-devin-${suffix}`, number: 1 },
    configuration: {
      digest: `sha256:${"2".repeat(64)}`,
      budgetDigest: `sha256:${"3".repeat(64)}`,
      toolPolicyDigest: `sha256:${"4".repeat(64)}`,
    },
  };
}

async function readEvidence(path: string): Promise<EvidenceRecord[]> {
  return (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as EvidenceRecord);
}

async function waitForRecord(path: string, predicate: (record: EvidenceRecord) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      if ((await readEvidence(path)).some(predicate)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for Devin session evidence.");
}

async function waitForNestedRecord(root: string, predicate: (record: EvidenceRecord) => boolean): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let paths: string[] = [];
    try {
      paths = await readdir(root, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const path of paths.filter((candidate) => candidate.endsWith("session.jsonl"))) {
      const sessionPath = join(root, path);
      if ((await readEvidence(sessionPath)).some(predicate)) return sessionPath;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for nested Devin session evidence.");
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Devin CLI did not exit after SIGINT.")), 15_000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createQueueFixture(parent: string, executable = process.execPath): { bundleRoot: string; queuePath: string; runId: string } {
  const bundleRoot = join(parent, "queue-bundle");
  mkdirSync(bundleRoot, { recursive: true });
  const packet = JSON.parse(readFileSync(resolve("tests/fixtures/task-packet.valid.v1.json"), "utf8")) as Extract<TaskPacket, { assessmentMode: "verified" }>;
  const observational = (({ restricted: _restricted, ...value }) => ({ ...value, assessmentMode: "observational" as const }))(packet);
  observational.agentInput.prompt = "Create devin-result.txt containing done.";
  const writeReference = (reference: { locator: string; digest: { algorithm: "sha256"; value: string } }, locator: string, bytes: Buffer) => {
    reference.locator = locator;
    reference.digest = digestBytes(bytes);
    const path = join(bundleRoot, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  writeReference(observational.agentInput.fixture.source, "components/fixture.tar.gz", fixtureArchive());
  if (!("reference" in observational.controlledPerturbation)) throw new Error("Fixture requires a controlled perturbation reference.");
  writeReference(observational.controlledPerturbation.reference, "components/perturbation.json", Buffer.from("{}\n"));
  const preAdmission = structuredClone(observational) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  writeReference(observational.admission.review!.reviewRecord, "restricted/review.json", Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: observational.admission.status,
    reviewedAt: observational.admission.review!.reviewedAt,
    reviewedBy: observational.admission.review!.reviewedBy,
  })));
  const packetPath = join(bundleRoot, "packets/task.json");
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(observational));
  freezeTaskPacket(bundleRoot, "packets/task.json");

  const configs = {
    model: { schemaVersion: "ebo.devin-config/v1", kind: "model", provider: "cognition", model: "swe-2-high", credentialEnv: CREDENTIAL_ENV },
    harness: { schemaVersion: "ebo.devin-config/v1", kind: "harness", adapter: "devin-cli", executable, version: DEVIN_CLI_VERSION, contractDigest: DEVIN_CONTRACT_DIGEST },
    limits: { schemaVersion: "ebo.devin-config/v1", kind: "native-limits", shutdownGraceMs: 1_000 },
    tools: { schemaVersion: "ebo.devin-config/v1", kind: "native-tool-policy", mode: "accept-edits", permissionDecision: "allow-once" },
    capture: { schemaVersion: "ebo.devin-config/v1", kind: "capture-profile", telemetrySignals: ["logs", "metrics"], workspaceOutcome: { excludeDirectoryNames: ["node_modules"] } },
  };
  const references = Object.fromEntries(Object.entries(configs).map(([name, value]) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const locator = `configs/${name}.json`;
    const path = join(bundleRoot, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return [name, { locator, digest: digestBytes(bytes) }];
  }));
  const experiment: ExperimentConfiguration = {
    schemaVersion: "ebo.experiment/v1",
    id: "devin-runner-fixture",
    taskSet: { task: { packetRef: { locator: "packets/task.json", digest: digestMetadata(observational) } } },
    modelSet: { "swe-2-high": { configurationRef: references.model! } },
    harnessSet: { "devin-cli": {
      configurationRef: references.harness!,
      nativeLimitsRef: references.limits!,
      nativeToolPolicyRef: references.tools!,
    } },
    trialCount: 1,
    ordering: { seed: "devin", strategy: "sequential", declaredOrder: { taskIds: ["task"], modelIds: ["swe-2-high"], harnessIds: ["devin-cli"] } },
    coordinatorBudget: { maxWallClockMs: 30_000 },
    captureProfile: references.capture!,
  } as ExperimentConfiguration;
  const queue = compileRunQueue(experiment, { bundleRoot });
  const queuePath = join(parent, "queue.json");
  writeRunQueue(queuePath, queue);
  mkdirSync(join(parent, "workspaces"), { recursive: true });
  return { bundleRoot, queuePath, runId: queue.entries[0]!.runId };
}

function fixtureArchive(): Buffer {
  const files = [
    { path: "README.md", bytes: Buffer.from("# fixture\n"), type: "0" },
    { path: "package.json", bytes: Buffer.from("{}\n"), type: "0" },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n"), type: "0" },
  ];
  const blocks = files.map(({ path, bytes, type }) => {
    const header = Buffer.alloc(512);
    header.write(path);
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    header.write(`${header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ebo-devin-test-"));
}

test("approved existing-auth live Devin ACP capture smoke", { skip: process.env.EBO_LIVE_DEVIN_CAPTURE_SMOKE !== "1" }, async (context) => {
  assert.ok(process.env.WINDSURF_API_KEY, "Supply WINDSURF_API_KEY for the live Devin CLI route.");
  const executable = process.env.EBO_LIVE_DEVIN_EXECUTABLE ?? "devin";
  const model = process.env.EBO_LIVE_DEVIN_MODEL ?? "swe-2-high";
  const root = await temporaryRoot();
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const capture = await captureDevinCli({
      runId: "synthetic-live-capture", attemptId: "synthetic-live-capture-1", workspacePath: workspace,
      prompt: "Synthetic test only. Run the shell command `printf 'EBO_SYNTHETIC_CAPTURE_OK\\n' > capture-proof.txt` in the current directory, then reply with exactly DONE. Do nothing else.",
      configuration: { executable, version: DEVIN_CLI_VERSION, model, mode: "accept-edits", permissionDecision: "allow-once", telemetry: { signals: ["logs", "metrics"] } },
      evidencePath: join(root, "session.jsonl"), stderrPath: join(root, "stderr.log"),
      signal: AbortSignal.timeout(120_000), shutdownGraceMs: 3000,
    });
    assert.equal(capture.terminalStatus, "completed", JSON.stringify(capture.gaps));
    assert.equal(capture.terminal?.stopReason, "end_turn");
    assert.equal(await readFile(join(workspace, "capture-proof.txt"), "utf8"), "EBO_SYNTHETIC_CAPTURE_OK\n");
    assert.equal(capture.telemetry.runtime.version, DEVIN_CLI_VERSION);
    assert.equal(capture.telemetry.runtime.userConfiguration, "isolated");
    assert.deepEqual(capture.gaps, []);
    const evidence = await readFile(join(root, "session.jsonl"), "utf8");
    assert.equal(evidence.includes(process.env.WINDSURF_API_KEY), false, "Credential values must never reach retained evidence.");
    const { dataset } = await describeAndValidateDevinDataset(capture);
    const terminalTool = dataset.events.find((event) => event.family === "tool" && event.phase === "after");
    assert.ok(terminalTool, "The live run must normalize a terminal tool event.");
    assert.equal(terminalTool.attributes.exitCode, 0);
    assert.ok(dataset.events.some((event) => event.family === "outcome" && event.attributes.stopReason === "end_turn"));
    context.diagnostic(JSON.stringify({ runtime: capture.telemetry.runtime.version, terminal: capture.terminalStatus, events: dataset.events.length,
      receipt: capture.telemetry.telemetry.receipt, gaps: capture.gaps }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
