#!/usr/bin/env node
/**
 * Codex Responses normalization shim (operator-side example).
 *
 * Not part of EBO's runtime. It demonstrates the single wire fix needed to run
 * the Codex harness against a Responses provider that rejects a replayed
 * reasoning item serialized as `"content": null`.
 *
 * Observed against xAI (2026-09): Codex replays a prior reasoning item with
 * `content: null`; xAI returns
 * `400 invalid-argument: Could not decode the compaction blob`.
 * Omitting the field, or sending `[]`, is accepted. This shim removes only that
 * null field from `reasoning` items and forwards everything else unchanged.
 *
 *   UPSTREAM=https://api.x.ai XAI_API_KEY=... node responses-normalizer.mjs [port]
 *
 * Then declare the provider with `base_url = "http://127.0.0.1:<port>/v1"`.
 */
import http from 'node:http';

const upstream = process.env.UPSTREAM ?? 'https://api.x.ai';
const port = Number(process.argv[2] ?? 8091);
const credentialEnv = process.env.CREDENTIAL_ENV ?? 'XAI_API_KEY';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = normalize(child);
    if (out.type === 'reasoning' && out.content === null) delete out.content;
    return out;
  }
  return value;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = Buffer.concat(chunks);
  if (req.method === 'POST' && req.url?.includes('/responses')) {
    try {
      body = Buffer.from(JSON.stringify(normalize(JSON.parse(body.toString('utf8')))));
    } catch { /* forward unchanged when the body is not JSON */ }
  }
  const authorization = req.headers.authorization ?? (process.env[credentialEnv] ? `Bearer ${process.env[credentialEnv]}` : undefined);
  const upstreamResponse = await fetch(`${upstream}${req.url}`, {
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'] ?? 'application/json',
      accept: req.headers.accept ?? '*/*',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  res.writeHead(upstreamResponse.status, { 'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json' });
  if (upstreamResponse.body) for await (const chunk of upstreamResponse.body) res.write(chunk);
  res.end();
});

server.listen(port, '127.0.0.1', () => process.stderr.write(`responses normalizer on http://127.0.0.1:${port}/v1 -> ${upstream}\n`));
