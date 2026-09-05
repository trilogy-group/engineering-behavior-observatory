import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { RunBundleAssembler } from "../src/run-bundles.js";
import type { HookEvent, HookInput, Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  buildCorpusIndex,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  main,
  queryCorpusIndex,
  runAgentSdkQueueEntry,
  validateCorpusIndex,
  writeRunQueue,
  compileRunQueue,
  type ClaudeAgentSdkTelemetryConfiguration,
  type ExperimentConfiguration,
  type RunManifest,
  type TaskPacket,
  type VerifierResult,
} from "../src/index.js";

type QueryInput = { prompt: string; options?: Options };
type QueryHandle = AsyncIterable<SDKMessage> & { close: () => void };

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const SESSION_ID = "session-runner";
const receivedReceipt: ClaudeAgentSdkTelemetryConfiguration["checkReceipt"] =
  () => ({ status: "received", signals: ["traces", "metrics", "logs"] });

const DEFAULT_VERIFIER = `
const fs = require("node:fs");
const path = require("node:path");
const workspace = process.argv[2];
if (fs.existsSync(path.join(workspace, "crash.txt"))) throw new Error("verifier fixture crash");
let content = "";
try { content = fs.readFileSync(path.join(workspace, "result.txt"), "utf8"); } catch {}
const passed = content.trim() === "done";
process.stdout.write(JSON.stringify({ assertions: [{ id: "result-file", status: passed ? "passed" : "failed" }] }));
if (!passed) process.exitCode = 1;
`;

test("executes one frozen queue entry end to end and retains a qualified bundle", async () => {
  const fixture = createRunnerFixture();
  const query = fakeQuery({ resultContent: "done\n", extraFiles: { "node_modules/cache.txt": "generated\n" } });
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot: fixture.outputRoot,
      workspaceRoot: fixture.workspaceRoot,
      query: query.query,
      checkTelemetryReceipt: receivedReceipt,
    });

    assert.equal(query.calls(), 1, "the attempt must not retry silently");
    assert.equal(summary.runId, fixture.runId);
    assert.equal(summary.bundlePath, join(fixture.outputRoot, fixture.runId, summary.attemptId));
    assert.deepEqual(summary.terminal, { state: "completed", failureClass: "none", stopReason: "none", workspaceArtifactId: "workspace" });
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    assert.equal(summary.sessionId, SESSION_ID);
    assert.equal(summary.retainedWorkspacePath, undefined);
    assert.deepEqual(readdirSync(fixture.workspaceRoot), [], "successful packaging still cleans up the source workspace");

    const manifest = readManifest(summary.bundlePath);
    const workspaceEvidence = manifest.evidence.find((descriptor) => descriptor.kind === "workspace");
    assert.ok(workspaceEvidence, "a workspace outcome must be retained");
    assert.equal(workspaceEvidence.mediaType, "text/x-diff", "the small change must retain an applicable patch");
    assert.equal(manifest.run.verifier?.locator, "restricted/verifier.cjs");
    assert.equal(manifest.run.verifier?.format, "commonjs");

    const verifier = readVerifierResult(summary.bundlePath, manifest);
    assert.equal(verifier.status, "passed");
    assert.equal(verifier.verifier?.locator, "restricted/verifier.cjs");
    assert.equal(verifier.status === "passed" ? verifier.workspace.artifactId : undefined, workspaceEvidence.id);
    assert.equal(verifier.status === "passed" ? verifier.workspace.fingerprint : undefined, workspaceEvidence.fingerprint);
    assert.ok(readFileSync(join(summary.bundlePath, "session.jsonl"), "utf8").trim().length > 0);
    assert.ok(readFileSync(join(summary.bundlePath, "hooks.jsonl"), "utf8").trim().length > 0);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("workspace capture failure preserves model output and reports a recoverable path", async (t) => {
  const fixture = createRunnerFixture({ assessmentMode: "observational" });
  t.mock.method(RunBundleAssembler.prototype, "captureWorkspaceOutcome", async () => {
    throw new Error("ENOSPC: injected workspace packaging failure");
  });
  const query = fakeQuery({ resultContent: "completed work worth preserving\n" });
  try {
    const summary = await runAgentSdkQueueEntry({
      ...fixture,
      query: query.query,
      checkTelemetryReceipt: receivedReceipt,
    });
    assert.equal(summary.captureQualification, "unqualified");
    assert.equal(summary.terminal.workspaceArtifactId, undefined);
    const retainedPath = summary.retainedWorkspacePath;
    assert.ok(retainedPath, "failed packaging must identify the retained source workspace");
    assert.equal(readFileSync(join(retainedPath, "result.txt"), "utf8"), "completed work worth preserving\n");
    const manifest = readManifest(summary.bundlePath);
    assert.deepEqual(summary.terminal, manifest.terminal);
    assert.equal(manifest.evidence.some(({ kind }) => kind === "workspace"), false);
    assert.ok(existsSync(join(summary.bundlePath, "session.jsonl")));
    assert.equal(query.calls(), 1);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("captures, exports, and indexes an observational task without verifier claims", async () => {
  const fixture = createRunnerFixture({ assessmentMode: "observational" });
  const query = fakeQuery({ resultContent: "open-ended workspace result\n" });
  const corpusRoot = join(fixture.parent, "corpus");
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot: join(corpusRoot, "runs"),
      workspaceRoot: fixture.workspaceRoot,
      query: query.query,
      checkTelemetryReceipt: receivedReceipt,
    });

    assert.equal(summary.assessmentMode, "observational");
    assert.equal(summary.classification, "completed");
    assert.equal(summary.captureQualification, "qualified");
    assert.equal(query.calls(), 1);

    const manifest = readManifest(summary.bundlePath);
    assert.equal(manifest.run.assessmentMode, "observational");
    assert.equal(manifest.run.verifier, undefined);
    assert.equal(manifest.evidence.some(({ kind }) => kind === "verifier"), false);
    const reportDescriptor = manifest.evidence.find(({ kind }) => kind === "capture-report")!;
    const report = JSON.parse(readFileSync(join(summary.bundlePath, reportDescriptor.relativePath), "utf8")) as {
      assessmentMode: string;
      capabilities: { outcome: { status: string } };
      missingEvidence: Array<{ kind: string }>;
    };
    assert.equal(report.assessmentMode, "observational");
    assert.equal(report.capabilities.outcome.status, "available");
    assert.equal(report.missingEvidence.some(({ kind }) => kind === "verifier"), false);

    const policyPath = join(fixture.parent, "observational-policy.json");
    writeFileSync(policyPath, JSON.stringify({
      sharingClass: "partner",
      maxArtifactBytes: 8 * 1024 * 1024,
      maxStringBytes: 64 * 1024,
    }));
    const exportRoot = join(corpusRoot, "exports", "observational");
    const output: string[] = [];
    assert.equal(await main(["export", "create", summary.bundlePath, policyPath, exportRoot], (message) => output.push(message)), 0, output.join(""));
    const entries = buildCorpusIndex(corpusRoot);
    assert.deepEqual(validateCorpusIndex(corpusRoot, entries), []);
    assert.equal(queryCorpusIndex(entries, { manifestKind: "run", assessmentMode: "observational" }).length, 1);
    assert.equal(queryCorpusIndex(entries, { manifestKind: "export", assessmentMode: "observational" }).length, 1);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

for (const invalid of [
  {
    name: "wrong-kind",
    records: { limits: { schemaVersion: "ebo.agent-sdk-config/v1", kind: "model", model: "claude-test" } },
    message: /kind "model" instead of the required "native-limits"/,
  },
  {
    name: "unknown-field",
    records: {
      tools: {
        schemaVersion: "ebo.agent-sdk-config/v1",
        kind: "native-tool-policy",
        tools: ["Read"],
        permissionMode: "dontAsk",
        env: { ANTHROPIC_API_KEY: "leak" },
      },
    },
    message: /unknown field "env"/,
  },
  {
    name: "nested-envelope-field",
    records: {
      capture: {
        schemaVersion: "ebo.agent-sdk-config/v1",
        kind: "capture-profile",
        telemetry: { endpoint: "http://127.0.0.1:4318", kind: "capture-profile" },
      },
    },
    message: /unknown field "kind"/,
  },
] as const) {
  test(`rejects an ${invalid.name} configuration before the SDK query without fabricating a bundle`, async () => {
    const fixture = createRunnerFixture({ records: invalid.records });
    const query = fakeQuery({ resultContent: "done\n" });
    try {
      await assert.rejects(
        runAgentSdkQueueEntry({
          bundleRoot: fixture.bundleRoot,
          queuePath: fixture.queuePath,
          runId: fixture.runId,
          outputRoot: fixture.outputRoot,
          workspaceRoot: fixture.workspaceRoot,
          query: query.query,
        }),
        invalid.message,
      );
      assert.equal(query.calls(), 0, "no Agent SDK query may start after a configuration preflight failure");
      assert.equal(existsSync(fixture.outputRoot), false, "no attempt bundle may be fabricated");
    } finally {
      rmSync(fixture.parent, { recursive: true, force: true });
    }
  });
}

test("rejects a missing run ID before any attempt evidence exists", async () => {
  const fixture = createRunnerFixture();
  try {
    await assert.rejects(
      runAgentSdkQueueEntry({
        bundleRoot: fixture.bundleRoot,
        queuePath: fixture.queuePath,
        runId: "run-absent",
        outputRoot: fixture.outputRoot,
        workspaceRoot: fixture.workspaceRoot,
      }),
      /Run "run-absent" is not in the queue/,
    );
    assert.equal(existsSync(fixture.outputRoot), false);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retains a task-failure bundle for a real failed verifier assertion", async () => {
  const fixture = createRunnerFixture();
  const query = fakeQuery({ resultContent: "wrong\n" });
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot: fixture.outputRoot,
      workspaceRoot: fixture.workspaceRoot,
      query: query.query,
      checkTelemetryReceipt: receivedReceipt,
    });
    assert.equal(summary.classification, "task-failure");
    assert.deepEqual(summary.terminal, { state: "failed", failureClass: "task", stopReason: "none", workspaceArtifactId: "workspace" });
    assert.equal(summary.captureQualification, "qualified");
    const verifier = readVerifierResult(summary.bundlePath, readManifest(summary.bundlePath));
    assert.equal(verifier.status, "failed");
    assert.equal(query.calls(), 1);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("classifies a real verifier crash as verifier-error instead of task failure", async () => {
  const fixture = createRunnerFixture();
  const query = fakeQuery({ resultContent: "done\n", extraFiles: { "crash.txt": "boom\n" } });
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot: fixture.outputRoot,
      workspaceRoot: fixture.workspaceRoot,
      query: query.query,
      checkTelemetryReceipt: receivedReceipt,
    });
    assert.equal(summary.classification, "verifier-error");
    assert.equal(summary.terminal.state, "failed");
    assert.equal(summary.terminal.failureClass, "infrastructure");
    const verifier = readVerifierResult(summary.bundlePath, readManifest(summary.bundlePath));
    assert.equal(verifier.status, "error");
    assert.equal(query.calls(), 1);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("retains a readable partial bundle after interruption without retrying", async () => {
  const fixture = createRunnerFixture();
  const controller = new AbortController();
  const query = fakeQuery({ resultContent: "done\n", interrupt: controller });
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot: fixture.outputRoot,
      workspaceRoot: fixture.workspaceRoot,
      query: query.query,
      signal: controller.signal,
    });
    assert.equal(summary.terminal.state, "interrupted");
    assert.equal(summary.classification, "interrupted");
    assert.equal(query.calls(), 1, "an interrupted attempt must not retry");
    const manifest = readManifest(summary.bundlePath);
    assert.equal(manifest.terminal.state, "interrupted");
    assert.ok(readFileSync(join(summary.bundlePath, "session.jsonl"), "utf8").trim().length > 0);
    assert.equal(manifest.evidence.some((descriptor) => descriptor.kind === "verifier"), false);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("never replaces an existing attempt destination", async () => {
  const fixture = createRunnerFixture();
  const attemptId = "attempt-fixed-1";
  try {
    const first = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot: fixture.outputRoot,
      workspaceRoot: fixture.workspaceRoot,
      attemptId,
      query: fakeQuery({ resultContent: "done\n" }).query,
      checkTelemetryReceipt: receivedReceipt,
    });
    const retainedManifest = readFileSync(join(first.bundlePath, "manifest.json"));
    const secondQuery = fakeQuery({ resultContent: "done\n" });
    await assert.rejects(
      runAgentSdkQueueEntry({
        bundleRoot: fixture.bundleRoot,
        queuePath: fixture.queuePath,
        runId: fixture.runId,
        outputRoot: fixture.outputRoot,
        workspaceRoot: fixture.workspaceRoot,
        attemptId,
        query: secondQuery.query,
      }),
      /already exists and is never replaced/,
    );
    assert.equal(secondQuery.calls(), 0);
    assert.deepEqual(readFileSync(join(first.bundlePath, "manifest.json")), retainedManifest);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("rejects a supplied attempt ID that is not one safe path component", async () => {
  const fixture = createRunnerFixture();
  const query = fakeQuery({ resultContent: "done\n" });
  try {
    for (const attemptId of ["../../../escaped", "a/b", "..", ".hidden", "a\\b", ""]) {
      await assert.rejects(
        runAgentSdkQueueEntry({
          bundleRoot: fixture.bundleRoot,
          queuePath: fixture.queuePath,
          runId: fixture.runId,
          outputRoot: fixture.outputRoot,
          workspaceRoot: fixture.workspaceRoot,
          attemptId,
          query: query.query,
        }),
        /one safe path component/,
        JSON.stringify(attemptId),
      );
    }
    assert.equal(query.calls(), 0);
    assert.equal(existsSync(fixture.outputRoot), false, "no attempt evidence may exist outside or inside the output root");
    assert.equal(existsSync(join(fixture.parent, "escaped")), false);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("exports the produced bundle and validates the source/export corpus pair", async () => {
  const fixture = createRunnerFixture();
  const corpusRoot = join(fixture.parent, "corpus");
  const outputRoot = join(corpusRoot, "runs");
  // A declared secret embedding the attempt ID must stay an exact-secret
  // match: correlation rewriting cannot run first and hide it from redaction.
  const attemptId = "attempt-export-1";
  const embeddedSecret = `confidential-prefix-${attemptId}-suffix`;
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot,
      workspaceRoot: fixture.workspaceRoot,
      attemptId,
      query: fakeQuery({ resultContent: "done\n", messageText: `note ${embeddedSecret} end` }).query,
      checkTelemetryReceipt: receivedReceipt,
    });
    assert.equal(summary.classification, "completed");

    const policyPath = join(fixture.parent, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      sharingClass: "partner",
      maxArtifactBytes: 4 * 1024 * 1024,
      maxStringBytes: 64 * 1024,
      sensitiveValues: [embeddedSecret],
    }));
    const exportRoot = join(corpusRoot, "exports", "run-a");
    const output: string[] = [];
    const exitCode = await main(["export", "create", summary.bundlePath, policyPath, exportRoot], (message) => output.push(message));
    assert.equal(exitCode, 0, output.join(""));
    assert.match(output.join(""), /Created partner portable export \(ready\)/);

    const exportManifest = JSON.parse(readFileSync(join(exportRoot, "manifest.json"), "utf8")) as {
      artifacts: Array<{ relativePath: string }>;
    };
    let redactedSecretSeen = false;
    for (const file of ["manifest.json", ...exportManifest.artifacts.map(({ relativePath }) => relativePath)]) {
      const text = readFileSync(join(exportRoot, file), "utf8");
      for (const correlation of [SESSION_ID, fixture.runId, summary.attemptId]) {
        assert.equal(text.includes(correlation), false, `exported ${file} must not retain source correlation ${correlation}`);
      }
      assert.equal(text.includes("confidential-prefix"), false, `exported ${file} must not retain any part of the declared secret`);
      redactedSecretSeen ||= text.includes("[REDACTED_SECRET]");
    }
    assert.equal(redactedSecretSeen, true, "the declared secret must be redacted, not rewritten away");

    const entries = buildCorpusIndex(corpusRoot);
    assert.equal(queryCorpusIndex(entries, { manifestKind: "run", runId: fixture.runId }).length, 1);
    assert.equal(queryCorpusIndex(entries, { manifestKind: "export", exportStatus: "ready" }).length, 1);
    assert.deepEqual(validateCorpusIndex(corpusRoot, entries), []);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test("agent-sdk run and export create report usage for incomplete arguments", async () => {
  const output: string[] = [];
  assert.equal(await main(["agent-sdk", "run", "bundle-root", "queue.json"], (message) => output.push(message)), 1);
  assert.match(output.join(""), /Usage: ebo agent-sdk run/);
  output.length = 0;
  assert.equal(await main(["export", "create", "bundle-root"], (message) => output.push(message)), 1);
  assert.match(output.join(""), /Usage: ebo export create/);
});

test("approved live Agent SDK operational runner proves a tool-using trajectory", {
  skip: process.env.EBO_LIVE_AGENT_SDK_RUNNER !== "1",
  timeout: 600_000,
}, async () => {
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined, "unset stale API-key auth before the approved OAuth proof");
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined, "unset stale auth-token override before the approved OAuth proof");
  assert.notEqual(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "", "", "the live proof authenticates through CLAUDE_CODE_OAUTH_TOKEN");

  const requests: Array<{ path: string; body: string }> = [];
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolvePromise) => receiver.listen(0, "127.0.0.1", resolvePromise));
  const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  const model = process.env.EBO_LIVE_AGENT_SDK_MODEL ?? "sonnet";
  const fixture = createRunnerFixture({
    assessmentMode: "observational",
    modelId: model,
    prompt: "Use the Write tool to create a file named result.txt in the current working directory containing exactly the single line: done",
    records: {
      tools: {
        schemaVersion: "ebo.agent-sdk-config/v1",
        kind: "native-tool-policy",
        tools: ["Read", "Write", "Edit"],
        allowedTools: ["Read", "Write", "Edit"],
        disallowedTools: [],
        permissionMode: "dontAsk",
      },
      limits: { schemaVersion: "ebo.agent-sdk-config/v1", kind: "native-limits", maxTurns: 8, maxBudgetUsd: 1 },
      capture: {
        schemaVersion: "ebo.agent-sdk-config/v1",
        kind: "capture-profile",
        telemetry: {
          endpoint,
          protocol: "http/json",
          exportIntervalMs: 100,
          logUserPrompts: false,
          logToolDetails: false,
          logToolContent: false,
          logRawApiBodies: false,
        },
      },
    },
  });
  const corpusRoot = join(fixture.parent, "corpus");
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot: fixture.bundleRoot,
      queuePath: fixture.queuePath,
      runId: fixture.runId,
      outputRoot: join(corpusRoot, "runs"),
      workspaceRoot: fixture.workspaceRoot,
      checkTelemetryReceipt: (correlation) => {
        const paths = new Set(requests.map((request) => request.path));
        const signals = [
          ...(paths.has("/v1/traces") ? ["traces" as const] : []),
          ...(paths.has("/v1/metrics") ? ["metrics" as const] : []),
          ...(paths.has("/v1/logs") ? ["logs" as const] : []),
        ];
        const correlated = requests.every(({ body }) => Object.values(correlation.attributes).every((value) => body.includes(value)));
        return correlated && signals.length === 3
          ? { status: "received", signals }
          : { status: "missing", signals, reason: "partial-receipt" };
      },
    });

    const manifest = readManifest(summary.bundlePath);
    assert.equal(summary.classification, "completed", JSON.stringify(summary));
    assert.equal(summary.assessmentMode, "observational");
    assert.equal(summary.terminal.state, "completed");
    assert.equal(summary.captureQualification, "qualified", JSON.stringify(summary));
    assert.equal(typeof summary.sessionId, "string");

    const sessionRecords = readFileSync(join(summary.bundlePath, "session.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { nativeType?: string; message?: { message?: { content?: unknown } } });
    assert.ok(sessionRecords.length > 0, "the native session stream must be retained");
    assert.equal(sessionRecords.filter((record) => record.nativeType === "result").length, 1, "the stream must retain its result identity");
    const hookRecords = readFileSync(join(summary.bundlePath, "hooks.jsonl"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { hook?: string });
    const toolEvidence = hookRecords.some((record) => record.hook === "PreToolUse" || record.hook === "PostToolUse")
      || sessionRecords.some((record) => JSON.stringify(record).includes('"tool_use"'));
    assert.ok(toolEvidence, "at least one tool-related SDK message or lifecycle hook must be retained");

    const workspaceEvidence = manifest.evidence.find((descriptor) => descriptor.kind === "workspace");
    assert.ok(workspaceEvidence, "a final workspace outcome must be retained");
    assert.equal(manifest.evidence.some(({ kind }) => kind === "verifier"), false);

    const policyPath = join(fixture.parent, "policy.json");
    writeFileSync(policyPath, JSON.stringify({
      sharingClass: "partner",
      maxArtifactBytes: 8 * 1024 * 1024,
      maxStringBytes: 64 * 1024,
    }));
    const output: string[] = [];
    const exportRoot = join(corpusRoot, "exports", "live");
    assert.equal(await main(["export", "create", summary.bundlePath, policyPath, exportRoot], (message) => output.push(message)), 0, output.join(""));
    const entries = buildCorpusIndex(corpusRoot);
    assert.deepEqual(validateCorpusIndex(corpusRoot, entries), []);
    assert.equal(queryCorpusIndex(entries, { manifestKind: "export", exportStatus: "ready" }).length, 1);

    process.stdout.write(`live-agent-sdk-runner ${JSON.stringify({
      classification: summary.classification,
      qualification: summary.captureQualification,
      messageRecords: sessionRecords.length,
      hookRecords: hookRecords.length,
      collectorPaths: [...new Set(requests.map((request) => request.path))].sort(),
      assessmentMode: summary.assessmentMode,
    })}\n`);
  } finally {
    await new Promise<void>((resolvePromise, reject) => receiver.close((error) => error === undefined ? resolvePromise() : reject(error)));
    rmSync(fixture.parent, { recursive: true, force: true });
  }
});

type RunnerFixture = {
  parent: string;
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot: string;
};

type RunnerFixtureOptions = {
  assessmentMode?: TaskPacket["assessmentMode"];
  modelId?: string;
  prompt?: string;
  verifierSource?: string;
  records?: Partial<Record<"model" | "harness" | "limits" | "tools" | "capture", unknown>>;
};

function createRunnerFixture(options: RunnerFixtureOptions = {}): RunnerFixture {
  const parent = mkdtempSync(join(tmpdir(), "ebo-agent-sdk-runner-"));
  const bundleRoot = join(parent, "bundle");
  mkdirSync(bundleRoot);
  const modelId = options.modelId ?? "claude-test";
  const verifiedPacket = JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", "task-packet.valid.v1.json"), "utf8")) as Extract<TaskPacket, { assessmentMode: "verified" }>;
  const packet: TaskPacket = options.assessmentMode === "observational"
    ? (({ restricted: _restricted, ...task }) => ({ ...task, assessmentMode: "observational" as const }))(verifiedPacket)
    : verifiedPacket;
  packet.agentInput.prompt = options.prompt ?? "Create a file named result.txt containing exactly the single line: done";
  const writeRef = (reference: { locator: string; digest: { algorithm: "sha256"; value: string } }, locator: string, bytes: Buffer) => {
    reference.locator = locator;
    reference.digest = digestBytes(bytes);
    const path = join(bundleRoot, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };

  writeRef(packet.agentInput.fixture.source, "components/fixture.tar.gz", fixtureArchive());
  if (!("reference" in packet.controlledPerturbation)
      || packet.assessmentMode === "verified" && !("locator" in packet.restricted.referenceSolution)) {
    throw new Error("Fixture packet must include referenced components.");
  }
  writeRef(packet.controlledPerturbation.reference, "components/perturbation.json", Buffer.from('{"kind":"controlled"}\n'));
  if (packet.assessmentMode === "verified") {
    writeRef(packet.restricted.referenceSolution as { locator: string; digest: { algorithm: "sha256"; value: string } }, "restricted/reference.txt", Buffer.from("reference solution\n"));
    writeRef(packet.restricted.verifier, "restricted/verifier.cjs", Buffer.from(options.verifierSource ?? DEFAULT_VERIFIER));
  }
  const preAdmission = structuredClone(packet) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  writeRef(packet.admission.review!.reviewRecord, "restricted/review.json", Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: packet.admission.status,
    reviewedAt: packet.admission.review!.reviewedAt,
    reviewedBy: packet.admission.review!.reviewedBy,
  })));
  const packetPath = join(bundleRoot, "packets/task-a.json");
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(packet));
  freezeTaskPacket(bundleRoot, "packets/task-a.json");

  const records = {
    model: options.records?.model ?? { schemaVersion: "ebo.agent-sdk-config/v1", kind: "model", model: modelId },
    harness: options.records?.harness ?? { schemaVersion: "ebo.agent-sdk-config/v1", kind: "harness", adapter: "claude-agent-sdk" },
    limits: options.records?.limits ?? { schemaVersion: "ebo.agent-sdk-config/v1", kind: "native-limits", maxTurns: 8, maxBudgetUsd: 1 },
    tools: options.records?.tools ?? {
      schemaVersion: "ebo.agent-sdk-config/v1",
      kind: "native-tool-policy",
      tools: ["Read", "Edit", "Write"],
      allowedTools: ["Read", "Edit", "Write"],
      disallowedTools: [],
      permissionMode: "dontAsk",
    },
    capture: options.records?.capture ?? {
      schemaVersion: "ebo.agent-sdk-config/v1",
      kind: "capture-profile",
      telemetry: {
        endpoint: "http://127.0.0.1:4318",
        protocol: "http/json",
        exportIntervalMs: 1000,
        logUserPrompts: false,
        logToolDetails: false,
        logToolContent: false,
        logRawApiBodies: false,
      },
      workspaceOutcome: { excludeDirectoryNames: ["node_modules"] },
    },
  };

  const experiment: ExperimentConfiguration = {
    schemaVersion: "ebo.experiment/v1",
    id: "agent-sdk-runner-fixture",
    taskSet: { "task-a": { packetRef: { locator: "packets/task-a.json", digest: digestMetadata(packet) } } },
    modelSet: { [modelId]: { configurationRef: { locator: "configs/model.json", digest: digestBytes(Buffer.alloc(0)) } } },
    harnessSet: {
      "agent-sdk": {
        configurationRef: { locator: "configs/harness.json", digest: digestBytes(Buffer.alloc(0)) },
        nativeLimitsRef: { locator: "configs/limits.json", digest: digestBytes(Buffer.alloc(0)) },
        nativeToolPolicyRef: { locator: "configs/tools.json", digest: digestBytes(Buffer.alloc(0)) },
      },
    },
    trialCount: 1,
    ordering: {
      seed: "runner-fixture",
      strategy: "sequential",
      declaredOrder: { taskIds: ["task-a"], modelIds: [modelId], harnessIds: ["agent-sdk"] },
    },
    coordinatorBudget: { maxWallClockMs: 300_000 },
    captureProfile: { locator: "configs/capture.json", digest: digestBytes(Buffer.alloc(0)) },
  } as ExperimentConfiguration;
  writeRef(experiment.modelSet[modelId]!.configurationRef, "configs/model.json", Buffer.from(JSON.stringify(records.model)));
  writeRef(experiment.harnessSet["agent-sdk"]!.configurationRef, "configs/harness.json", Buffer.from(JSON.stringify(records.harness)));
  writeRef(experiment.harnessSet["agent-sdk"]!.nativeLimitsRef, "configs/limits.json", Buffer.from(JSON.stringify(records.limits)));
  writeRef(experiment.harnessSet["agent-sdk"]!.nativeToolPolicyRef, "configs/tools.json", Buffer.from(JSON.stringify(records.tools)));
  writeRef(experiment.captureProfile, "configs/capture.json", Buffer.from(JSON.stringify(records.capture)));

  const queue = compileRunQueue(experiment, { bundleRoot });
  const queuePath = join(parent, "queue.json");
  writeRunQueue(queuePath, queue);
  const workspaceRoot = join(parent, "workspaces");
  mkdirSync(workspaceRoot);
  return {
    parent,
    bundleRoot,
    queuePath,
    runId: queue.entries[0]!.runId,
    outputRoot: join(parent, "out"),
    workspaceRoot,
  };
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

function fakeQuery(behavior: {
  resultContent: string;
  extraFiles?: Record<string, string>;
  interrupt?: AbortController;
  messageText?: string;
}): { query: (input: QueryInput) => QueryHandle; calls: () => number } {
  let calls = 0;
  const query = (input: QueryInput): QueryHandle => {
    calls += 1;
    let closed = false;
    const messages: SDKMessage[] = behavior.interrupt === undefined
      ? [systemInitMessage(), assistantMessage(behavior.messageText), sdkResult()]
      : [systemInitMessage(), assistantMessage(behavior.messageText)];
    return {
      close: () => {
        closed = true;
      },
      async *[Symbol.asyncIterator]() {
        for (const hook of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"] as const) {
          await input.options?.hooks?.[hook]?.[0]?.hooks[0]?.(hookInput(hook), undefined, { signal: new AbortController().signal });
        }
        const workspace = String(input.options?.cwd);
        writeFileSync(join(workspace, "result.txt"), behavior.resultContent);
        for (const [name, content] of Object.entries(behavior.extraFiles ?? {})) {
          const path = join(workspace, name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
        }
        for (const message of messages) {
          if (closed) break;
          yield message;
          behavior.interrupt?.abort("fixture interruption");
        }
      },
    };
  };
  return { query, calls: () => calls };
}

function systemInitMessage(): SDKMessage {
  // Mirrors the native init message: the session ID also appears embedded in
  // an encoded transcript-path string that absolute-path redaction cannot cover.
  return {
    type: "system",
    subtype: "init",
    uuid: "system-1",
    session_id: SESSION_ID,
    transcript_path: `-private-tmp-encoded-workspace/${SESSION_ID}.jsonl`,
  } as unknown as SDKMessage;
}

function assistantMessage(text?: string): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-1",
    session_id: SESSION_ID,
    message: { role: "assistant", content: text === undefined ? [] : [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

function sdkResult(): SDKMessage {
  return {
    type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false,
    num_turns: 1, stop_reason: null, total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-test": { inputTokens: 1, outputTokens: 1, costUSD: 0.01 } },
    permission_denials: [], result: "done", session_id: SESSION_ID, uuid: "result-1",
  } as unknown as SDKResultMessage;
}

function hookInput(hook: HookEvent): HookInput {
  return {
    hook_event_name: hook,
    session_id: SESSION_ID,
    transcript_path: "/restricted/session.jsonl",
    cwd: "/attempt/workspace",
  } as unknown as HookInput;
}

function readManifest(bundleRoot: string): RunManifest {
  return JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as RunManifest;
}

function readVerifierResult(bundleRoot: string, manifest: RunManifest): VerifierResult {
  const descriptor = manifest.evidence.find((entry) => entry.kind === "verifier");
  assert.ok(descriptor, "a verifier result must be retained");
  return JSON.parse(readFileSync(join(bundleRoot, descriptor.relativePath), "utf8")) as VerifierResult;
}
