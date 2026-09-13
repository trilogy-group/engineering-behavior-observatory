// Deterministic HTTP provider; the actual pinned Pi SDK still owns tools,
// sessions, callbacks and persistence. No model credentials or network calls.
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { runHarborWorker, type HarborWorkerInput } from '../src/harbor/worker.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function startProvider(input: HarborWorkerInput) {
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  if (request.messages.some((m: {role: string}) => m.role === 'tool')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\ndata: [DONE]\n\n');
  } else {
    // Hidden tests and reference solution must not be staged before capture.
    for (const path of ['/tests/test.sh', '/solution/solve.sh']) {
      try { await access(path); res.writeHead(500); res.end('hidden surface exposed'); return; } catch {}
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'write-' + input.stepIndex, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'step-' + input.stepIndex + '.txt', content: 'done\n' }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  }
});
return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as HarborWorkerInput;
const server = startProvider(input);
await new Promise<void>(resolve => server.listen(18881, '127.0.0.1', resolve));
process.env.PI_SYNTHETIC_API_KEY = 'synthetic-offline';
try {
  const result = await runHarborWorker(input);
  process.exitCode = result.terminal.state === 'completed' ? 0 : 1;
} finally { server.closeAllConnections(); server.close(); }
}
