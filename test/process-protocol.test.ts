import { strict as assert } from "node:assert";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BoundedDiagnosticCapture,
  JsonlEvidenceWriter,
  runProtocolProcess,
  spawnProtocolProcess,
} from "../src/index.js";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "ebo-process-protocol-"));
}

function nodeScript(source: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ["-e", source] };
}

test("records JSONL frames, source-owned observations, and bounded stderr", async () => {
  const root = temporaryRoot();
  try {
    const evidencePath = join(root, "protocol.jsonl");
    const stderrPath = join(root, "diagnostics", "stderr.log");
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({event:'ready'})); console.error('123456789')"),
      source: "fake-harness",
      evidencePath,
      stderrPath,
      maxStderrBytes: 4,
      onFrame: async (_payload, recorder) => {
        await recorder.recordRequest({
          source: "fake-harness",
          method: "session/prompt",
          id: 7,
          sourceIdentity: "session-1",
          payload: { prompt: "hello" },
        });
        await recorder.recordResponse({
          source: "fake-harness",
          method: "session/prompt",
          id: 7,
          sourceIdentity: "session-1",
          payload: { accepted: true },
        });
        await recorder.recordNotification({
          source: "fake-harness",
          method: "session.status",
          sourceIdentity: "session-1",
          payload: { status: "idle" },
        });
        await recorder.recordCompletion({
          source: "fake-harness",
          status: "documented-idle",
          evidence: { session: "session-1", status: "idle" },
        });
        await recorder.recordCapability({
          source: "fake-harness",
          name: "prompt-cancel",
          status: "unsupported",
        });
      },
    });

    assert.equal(processResult.status, "completed");
    assert.equal(processResult.protocolOnly, true);
    assert.equal(processResult.stdoutFrames, 1);
    assert.equal(processResult.stderr.text, "1234");
    assert.equal(processResult.stderr.truncated, true);
    assert.equal(readFileSync(stderrPath, "utf8"), "1234");
    assert.deepEqual(
      processResult.observations.filter((record) => ["request", "response", "notification"].includes(record.kind)).map((record) => [record.kind, record.method, record.id, record.sourceIdentity]),
      [
        ["request", "session/prompt", 7, "session-1"],
        ["response", "session/prompt", 7, "session-1"],
        ["notification", "session.status", undefined, "session-1"],
      ],
    );
    const lines = readFileSync(evidencePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
    assert.equal(lines.length, processResult.observations.length);
    assert.deepEqual(lines.map((line) => line.sequence), lines.map((_line, index) => index + 1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains the original JSONL frame text when parsed values lose precision", async () => {
  const root = temporaryRoot();
  try {
    const raw = '{"id":9007199254740993,"id":1,"method":"session/status"}';
    const processResult = await runProtocolProcess({
      ...nodeScript(`console.log(${JSON.stringify(raw)})`),
      source: "fake-harness",
      evidencePath: join(root, "raw.jsonl"),
    });
    const frame = processResult.observations.find((record) => record.kind === "frame");
    assert.equal(frame?.raw, raw);
    assert.equal((frame?.payload as { id?: number }).id, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed protocol output stops the process and retains a readable partial record", async () => {
  const root = temporaryRoot();
  try {
    const evidencePath = join(root, "malformed.jsonl");
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log('not-json'); console.error('diagnostic')"),
      source: "fake-harness",
      evidencePath,
    });
    assert.equal(processResult.status, "malformed");
    assert.equal(processResult.partial, true);
    assert.equal(processResult.protocolError?.line, 1);
    assert.equal(processResult.stdoutFrames, 0);
    assert.match(readFileSync(evidencePath, "utf8"), /Malformed JSONL protocol output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupts after delivered frames and flushes partial evidence", async () => {
  const root = temporaryRoot();
  try {
    const evidencePath = join(root, "interrupted.jsonl");
    const protocol = spawnProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({notification:1})); setTimeout(()=>{}, 10000)"),
      source: "fake-harness",
      evidencePath,
    });
    setTimeout(() => void protocol.interrupt(), 100);
    const processResult = await protocol.wait();
    assert.equal(processResult.status, "interrupted");
    assert.equal(processResult.termination, "interrupted");
    assert.equal(processResult.partial, true);
    assert.equal(processResult.stdoutFrames, 1);
    assert.match(readFileSync(evidencePath, "utf8"), /notification/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean shutdown is explicit and does not imply prompt completion", async () => {
  const root = temporaryRoot();
  try {
    const writer = new JsonlEvidenceWriter(join(root, "shutdown.jsonl"));
    const protocol = spawnProtocolProcess({
      ...nodeScript("setTimeout(()=>{}, 10000)"),
      source: "fake-harness",
      writer,
    });
    await protocol.shutdown();
    const processResult = await protocol.wait();
    assert.equal(processResult.status, "shutdown");
    assert.equal(processResult.termination, "shutdown");
    assert.equal(processResult.observations.some((record) => record.kind === "completion"), false);
    await writer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already-aborted process signal still produces a partial result", async () => {
  const root = temporaryRoot();
  try {
    const controller = new AbortController();
    controller.abort();
    const processResult = await runProtocolProcess({
      ...nodeScript("setTimeout(()=>{}, 10000)"),
      source: "fake-harness",
      evidencePath: join(root, "already-interrupted.jsonl"),
      signal: controller.signal,
    });
    assert.equal(processResult.status, "interrupted");
    assert.equal(processResult.partial, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic capture keeps its bound while draining all bytes", () => {
  const capture = new BoundedDiagnosticCapture(3);
  capture.write(Buffer.from("abcdef"));
  capture.write(Buffer.from("gh"));
  assert.equal(capture.result().text, "abc");
  assert.equal(capture.result().sizeBytes, 8);
  assert.equal(capture.result().truncated, true);
});
