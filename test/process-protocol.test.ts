import { strict as assert } from "node:assert";
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BoundedDiagnosticCapture,
  JsonlEvidenceWriter,
  ProtocolEvidenceRecorder,
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
    assert.equal(processResult.stderrPath, stderrPath);
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

test("request observation inputs cannot override their fixed kind", async () => {
  const root = temporaryRoot();
  try {
    const writer = new JsonlEvidenceWriter(join(root, "fixed-kind.jsonl"));
    const recorder = new ProtocolEvidenceRecorder(writer, "fake-harness");
    const input = { source: "fake-harness", method: "event", kind: "response" as const };
    const observation = await recorder.recordRequest(input);
    assert.equal(observation.kind, "request");
    await recorder.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process timer grace periods reject values above Node's maximum", () => {
  assert.throws(() => spawnProtocolProcess({
    ...nodeScript(""),
    source: "fake-harness",
    shutdownGraceMs: 2_147_483_648,
  }), /Node timer maximum/);
  assert.throws(() => spawnProtocolProcess({
    ...nodeScript(""),
    source: "fake-harness",
    killGraceMs: 2_147_483_648,
  }), /Node timer maximum/);
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

test("rejects conflicting writer and evidence paths", () => {
  const root = temporaryRoot();
  try {
    const writer = new JsonlEvidenceWriter(join(root, "actual.jsonl"));
    assert.throws(() => spawnProtocolProcess({
      ...nodeScript(""),
      source: "fake-harness",
      writer,
      evidencePath: join(root, "other.jsonl"),
    }), /conflicts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps frame limits independent from the evidence envelope", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({ok:true}))"),
      source: "fake-harness",
      maxLineBytes: 16,
      evidencePath: join(root, "small-limit.jsonl"),
    });
    assert.equal(processResult.status, "completed");
    assert.equal(processResult.stdoutFrames, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not expose a pre-existing diagnostic path as this process evidence", async () => {
  const root = temporaryRoot();
  try {
    const stderrPath = join(root, "existing.log");
    writeFileSync(stderrPath, "previous attempt");
    const processResult = await runProtocolProcess({
      ...nodeScript("console.error('new diagnostic')"),
      source: "fake-harness",
      evidencePath: join(root, "protocol.jsonl"),
      stderrPath,
    });
    assert.equal(processResult.stderrPath, undefined);
    assert.match(processResult.error ?? "", /stderr evidence could not be persisted/);
    assert.equal(readFileSync(stderrPath, "utf8"), "previous attempt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates each internally owned protocol evidence file exclusively", async () => {
  const root = temporaryRoot();
  try {
    const evidencePath = join(root, "exclusive.jsonl");
    const first = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({first:true}))"),
      source: "fake-harness",
      evidencePath,
    });
    const original = readFileSync(evidencePath, "utf8");
    await assert.rejects(runProtocolProcess({
      ...nodeScript(""),
      source: "fake-harness",
      evidencePath,
    }), /EEXIST|already exists/);
    assert.equal(first.status, "completed");
    assert.equal(readFileSync(evidencePath, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds an unterminated stdout frame before accumulating it", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("process.stdout.write('x'.repeat(1000000))"),
      source: "fake-harness",
      maxLineBytes: 32,
      evidencePath: join(root, "oversized.jsonl"),
    });
    assert.equal(processResult.status, "malformed");
    assert.match(processResult.protocolError?.message ?? "", /exceeds/);
    assert.equal(processResult.protocolError?.line, 1);
    assert.equal(processResult.stdoutFrames, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps recorder failures separate from malformed protocol output", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({ok:true}))"),
      source: "fake-harness",
      evidencePath: join(root, "recorder-error.jsonl"),
      onFrame: () => { throw new Error("adapter observer failed"); },
    });
    assert.equal(processResult.status, "failed");
    assert.equal(processResult.protocolError, undefined);
    assert.match(processResult.recorderError ?? "", /adapter observer failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds a frame observer that never settles", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({ok:true}))"),
      source: "fake-harness",
      shutdownGraceMs: 10,
      evidencePath: join(root, "observer-timeout.jsonl"),
      onFrame: async () => new Promise<void>(() => undefined),
    });
    assert.equal(processResult.status, "failed");
    assert.match(processResult.recorderError ?? "", /observer exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fences a late frame observer before it can append after finalization", async () => {
  const root = temporaryRoot();
  let lateError: Error | undefined;
  try {
    const evidencePath = join(root, "late-observer.jsonl");
    const writer = new JsonlEvidenceWriter(evidencePath);
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({ready:true})); setTimeout(()=>{}, 10000)"),
      source: "fake-harness",
      writer,
      shutdownGraceMs: 5,
      onFrame: async (_payload, recorder) => {
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 30));
        try {
          await recorder.recordNotification({ source: "fake-harness", method: "late" });
        } catch (error) {
          lateError = error instanceof Error ? error : new Error(String(error));
        }
      },
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 40));
    await writer.close();
    assert.equal(processResult.status, "failed");
    assert.match(lateError?.message ?? "", /fenced/);
    assert.equal(readFileSync(evidencePath, "utf8").includes('"method":"late"'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("records recorder-triggered termination distinctly", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({ok:true})); setTimeout(()=>{}, 10000)"),
      source: "fake-harness",
      shutdownGraceMs: 10,
      evidencePath: join(root, "recorder-termination.jsonl"),
      onFrame: () => { throw new Error("observer failed"); },
    });
    assert.equal(processResult.status, "failed");
    assert.equal(processResult.termination, "recorder-error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshots caller payloads before observer mutation", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({state:'before'}))"),
      source: "fake-harness",
      evidencePath: join(root, "payload.jsonl"),
      onFrame: (payload) => { (payload as { state: string }).state = "after"; },
    });
    const frame = processResult.observations.find((record) => record.kind === "frame");
    assert.equal((frame?.payload as { state?: string }).state, "before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshots direct writer records when append is called", async () => {
  const root = temporaryRoot();
  try {
    const path = join(root, "writer.jsonl");
    const writer = new JsonlEvidenceWriter(path);
    const record = { state: "before" };
    const append = writer.append(record);
    record.state = "after";
    await append;
    await writer.close();
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { state: "before" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct JSONL appends reject values that JSON cannot preserve", async () => {
  const root = temporaryRoot();
  try {
    const writer = new JsonlEvidenceWriter(join(root, "invalid-direct-record.jsonl"));
    await assert.rejects(writer.append({ value: Number.NaN }), /finite JSON number/);
    await assert.rejects(writer.append({ value: new Map([["key", "value"]]) }), /JSON object or array/);
    await writer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not retain observations whose append fails", async () => {
  const root = temporaryRoot();
  try {
    const writer = new JsonlEvidenceWriter(join(root, "append-failure.jsonl"), { maxLineBytes: 256 });
    const recorder = new ProtocolEvidenceRecorder(writer, "fake-harness");
    await assert.rejects(recorder.recordNotification({
      source: "fake-harness",
      method: "event",
      payload: { detail: "x".repeat(512) },
    }), /exceeds/);
    await recorder.recordProcess("exited");
    await recorder.close();
    const observations = recorder.observations;
    assert.deepEqual(observations.map((record) => [record.sequence, record.kind]), [[1, "process"]]);
    assert.deepEqual(readFileSync(join(root, "append-failure.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).sequence), [1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns detached recorder observations", async () => {
  const root = temporaryRoot();
  try {
    const writer = new JsonlEvidenceWriter(join(root, "detached.jsonl"));
    const recorder = new ProtocolEvidenceRecorder(writer, "fake-harness");
    const returned = await recorder.recordNotification({ source: "fake-harness", method: "event", payload: { value: 1 } });
    returned.method = "mutated";
    (returned.payload as { value: number }).value = 2;
    assert.equal(recorder.observations[0]?.method, "event");
    assert.equal((recorder.observations[0]?.payload as { value: number }).value, 1);
    await recorder.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects values that JSONL cannot preserve", async () => {
  const root = temporaryRoot();
  try {
    const writer = new JsonlEvidenceWriter(join(root, "json-values.jsonl"));
    const recorder = new ProtocolEvidenceRecorder(writer, "fake-harness");
    await assert.rejects(recorder.recordNotification({ source: "fake-harness", method: "event", payload: new Map([["x", 1]]) }), /JSON object or array/);
    await assert.rejects(recorder.recordNotification({ source: "fake-harness", method: "event", payload: Number.NaN }), /finite JSON number/);
    await assert.rejects(recorder.recordRequest({ source: "fake-harness", method: "event", id: Number.NaN }), /Protocol identity/);
    await assert.rejects(recorder.recordResponse({ source: "fake-harness", method: "event", id: Number.POSITIVE_INFINITY }), /Protocol identity/);
    await recorder.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not process frames queued after malformed output", async () => {
  const root = temporaryRoot();
  let observed = 0;
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("process.stdout.write('not-json\\n' + JSON.stringify({after:true}) + '\\n')"),
      source: "fake-harness",
      evidencePath: join(root, "queued-malformed.jsonl"),
      onFrame: () => { observed += 1; },
    });
    assert.equal(processResult.status, "malformed");
    assert.equal(observed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains valid frames queued before an oversized frame", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("process.stdout.write(JSON.stringify({before:true}) + '\\n' + 'x'.repeat(1000))"),
      source: "fake-harness",
      maxLineBytes: 32,
      evidencePath: join(root, "before-oversized.jsonl"),
    });
    assert.equal(processResult.status, "malformed");
    assert.equal(processResult.stdoutFrames, 1);
    assert.equal((processResult.observations.find((record) => record.kind === "frame")?.payload as { before?: boolean }).before, true);
    assert.equal(processResult.protocolError?.line, 2);
    assert.deepEqual(processResult.observations.slice(0, 2).map((record) => record.kind), ["frame", "error"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds in-memory observations while retaining the complete JSONL stream", async () => {
  const root = temporaryRoot();
  try {
    const processResult = await runProtocolProcess({
      ...nodeScript("for (let i=0;i<1100;i++) console.log(JSON.stringify({i}))"),
      source: "fake-harness",
      maxInMemoryObservations: 10,
      evidencePath: join(root, "bounded-memory.jsonl"),
    });
    assert.equal(processResult.status, "completed");
    assert.equal(processResult.observations.length, 10);
    assert.ok(processResult.droppedObservations > 0);
    assert.ok(readFileSync(join(root, "bounded-memory.jsonl"), "utf8").trim().split("\n").length > 1000);
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

test("fences caller-owned recorders before publishing process completion", async () => {
  const root = temporaryRoot();
  try {
    const evidencePath = join(root, "fenced-completion.jsonl");
    const writer = new JsonlEvidenceWriter(evidencePath);
    const protocol = spawnProtocolProcess({
      ...nodeScript("console.log(JSON.stringify({ready:true}))"),
      source: "fake-harness",
      writer,
    });
    const result = await protocol.wait();
    await assert.rejects(protocol.evidence.recordNotification({ source: "fake-harness", method: "late" }), /fenced/);
    await writer.close();
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(evidencePath, "utf8").includes('"method":"late"'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown with diagnostic persistence failure remains failed and partial", async () => {
  const root = temporaryRoot();
  try {
    const stderrPath = join(root, "existing.log");
    writeFileSync(stderrPath, "previous");
    const protocol = spawnProtocolProcess({
      ...nodeScript("setTimeout(()=>{}, 10000)"),
      source: "fake-harness",
      evidencePath: join(root, "shutdown-error.jsonl"),
      stderrPath,
    });
    const processResult = await protocol.shutdown();
    assert.equal(processResult.status, "failed");
    assert.equal(processResult.partial, true);
    assert.equal(processResult.stderrPath, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the first process termination cause wins concurrent shutdown requests", async () => {
  const root = temporaryRoot();
  try {
    const protocol = spawnProtocolProcess({
      ...nodeScript("setTimeout(()=>{}, 10000)"),
      source: "fake-harness",
      evidencePath: join(root, "termination-order.jsonl"),
    });
    const interrupt = protocol.interrupt();
    const shutdown = protocol.shutdown();
    const result = await Promise.all([interrupt, shutdown]).then(([first]) => first);
    assert.equal(result.status, "interrupted");
    assert.equal(result.termination, "interrupted");
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
