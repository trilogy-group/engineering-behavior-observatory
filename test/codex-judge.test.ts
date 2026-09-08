import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCodexSemanticJudge } from "../src/codex-judge.js";
import type { SemanticJudgeRequest } from "../src/semantic-judge.js";

test("approved existing-auth native Codex judge smoke", { skip: process.env.EBO_LIVE_CODEX_JUDGE_SMOKE !== "1" }, async (context) => {
  const model = process.env.EBO_LIVE_CODEX_JUDGE_MODEL;
  assert.ok(model, "Supply an existing authenticated model route.");
  const result = await runCodexSemanticJudge("Synthetic fixture only: no event evidence is provided. Return an abstention, with no citations.", {
    evaluator: { backend: "codex-app-server", provider: "openai", model, effort: "low" },
    limits: { maxOutputChars: 16000, maxInputChars: 20000, maxWallClockMs: 30000, maxCitations: 1, maxTurns: 1 },
  } as SemanticJudgeRequest);
  assert.equal(result.status, "completed", JSON.stringify(result));
  if (result.status === "completed") {
    assert.equal((result.response as { judgment: { disposition: string } }).judgment.disposition, "abstained");
    context.diagnostic(JSON.stringify({ model, effort: "low", status: result.status, disposition: "abstained", usage: "unavailable" }));
  }
});

test("native judge isolates ambient state, retains failures, matches owned turns and reaps timeouts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-judge-test-"));
  const executable = join(root, "codex");
  cpSync(resolve("test/fixtures/codex/fake-judge.mjs"), executable);
  chmodSync(executable, 0o700);
  const saved = { ...process.env };
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://must-not-connect.invalid";
  process.env.ANTHROPIC_API_KEY = "synthetic-secret";
  process.env.EBO_JUDGE_SECRET_SENTINEL = "synthetic-secret";
  try {
    const request = { evaluator: { backend: "codex-app-server", executable, provider: "openai", model: "fixture", effort: "low" },
      limits: { maxOutputChars: 16000, maxWallClockMs: 200, maxCitations: 2 } } as SemanticJudgeRequest;
    const success = await runCodexSemanticJudge("success", request);
    assert.equal(success.status, "completed", JSON.stringify(success));
    assert.equal(success.usage, undefined);
    const raw = success.raw as { frames: string[] };
    const start = raw.frames.map((frame) => JSON.parse(frame)).find((frame) => frame.result?.thread);
    assert.equal(start.result.thread.ephemeral, true);
    for (const prompt of ["timeout", "exit", "foreign", "tool", "malformed"]) {
      const result = await runCodexSemanticJudge(prompt, request);
      assert.equal(result.status, "failed", prompt);
      assert.ok(result.raw);
      if (result.status === "failed" && ["timeout", "foreign"].includes(prompt)) assert.equal(result.kind, "timeout");
    }
    assert.equal(process.env.EBO_JUDGE_SECRET_SENTINEL, "synthetic-secret");
    assert.equal(existsSync(executable), true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed pinned native judge exposes zero tools on the model wire", { skip: process.env.EBO_NATIVE_CODEX_CONTRACT !== "1" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-native-wire-"));
  const originalCodexHome = process.env.CODEX_HOME;
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (body !== "") requests.push(JSON.parse(body));
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Synthetic wire inspection completed." } }));
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        let length = buffered[1]! & 127;
        let offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        if (buffered.length < offset + 4 + length) return;
        const opcode = buffered[0]! & 15;
        const mask = buffered.subarray(offset, offset + 4);
        const body = buffered.subarray(offset + 4, offset + 4 + length);
        for (let index = 0; index < body.length; index++) body[index] = body[index]! ^ mask[index % 4]!;
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        const value = JSON.parse(body.toString("utf8"));
        requests.push(value);
        const reply = Buffer.from(JSON.stringify(value.generate === false
          ? { type: "response.completed", response: { id: "synthetic-warmup", status: "completed", output: [] } }
          : { type: "error", error: { type: "invalid_request_error", message: "Synthetic wire inspection completed." } }));
        const header = reply.length < 126 ? Buffer.from([0x81, reply.length]) : Buffer.from([0x81, 126, reply.length >> 8, reply.length & 255]);
        socket.write(Buffer.concat([header, reply]));
        if (value.generate !== false) socket.end();
      }
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(root, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-wire-test-key" }), { mode: 0o600 });
    process.env.CODEX_HOME = root;
    const executable = join(root, "codex-wrapper");
    writeFileSync(executable, `#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nif(!args.includes('--version'))args.push('-c','openai_base_url="http://127.0.0.1:${port}/v1"','-c','features.enable_request_compression=false');\nconst result=spawnSync('codex',args,{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`, { mode: 0o700 });
    const results = [];
    for (const model of ["gpt-5.6-sol", "gpt-5.5"]) results.push(await runCodexSemanticJudge("Synthetic evidence-only wire test.", { evaluator: { executable, model, effort: "low" },
      limits: { maxOutputChars: 16000, maxWallClockMs: 10000, maxCitations: 1 } } as SemanticJudgeRequest));
    const generations = requests.filter((request) => request.generate !== false);
    assert.equal(new Set(generations.map((request) => request.model)).size, 2, `Both native tool modes must send a model request: ${JSON.stringify(results)}`);
    for (const request of generations) assert.deepEqual(request.response?.tools ?? request.tools ?? [], [], JSON.stringify({ keys: Object.keys(request), responseKeys: Object.keys(request.response ?? {}), tools: request.response?.tools ?? request.tools }));
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
