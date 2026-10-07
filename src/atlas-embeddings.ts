import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactSecrets } from "./redaction.js";

/**
 * Unit embeddings for the Atlas cloud. The bundle carries one vector per embedded unit; the viewer lays them out
 * with Embedding Atlas's own UMAP and clustering. Vectors are cached per (model, dimensions, text digest), so a
 * rebuild embeds only new or changed text. Only `embed_text` is sent: behavior summaries and message text capped for
 * embedding, never tool output or file contents.
 */
export type EmbeddingConfig = { provider: "fireworks"; model: string; dimensions: number; cache: string };
export const DEFAULT_EMBEDDING_MODEL = "accounts/fireworks/models/qwen3-embedding-8b";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export async function embedTexts(texts: readonly string[], config: EmbeddingConfig, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; batch?: number; concurrency?: number } = {}): Promise<Float32Array> {
  const env = options.env ?? process.env;
  const key = env.FIREWORKS_API_KEY;
  const cacheFile = join(config.cache, `${sha(`${config.provider}\0${config.model}\0${config.dimensions}`).slice(0, 16)}.json`);
  mkdirSync(config.cache, { recursive: true });
  const cache: Record<string, number[]> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, number[]> : {};
  const missing = [...new Set(texts.filter((t) => !(sha(t) in cache)))];
  if (missing.length && !key) throw new Error("FIREWORKS_API_KEY is required to embed units that are not in the embedding cache.");
  const batch = options.batch ?? 64, concurrency = options.concurrency ?? 4, request = options.fetch ?? fetch;
  const batches = Array.from({ length: Math.ceil(missing.length / batch) }, (_, i) => missing.slice(i * batch, (i + 1) * batch));
  let next = 0;
  const save = () => { writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache)); renameSync(`${cacheFile}.tmp`, cacheFile); };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const input = batches[next++]!;
      for (let attempt = 1; ; attempt++) {
        const response = await request("https://api.fireworks.ai/inference/v1/embeddings", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key!}` },
          body: JSON.stringify({ model: config.model, input, dimensions: config.dimensions }),
        });
        if (response.ok) {
          const body = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
          for (const { index, embedding } of body.data) {
            if (embedding.length !== config.dimensions) throw new Error(`Embedding has ${embedding.length} dimensions, expected ${config.dimensions}.`);
            cache[sha(input[index]!)] = embedding;
          }
          break;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 6) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
        throw new Error(`Fireworks embeddings failed with HTTP ${response.status}: ${redactSecrets((await response.text()).slice(0, 500)).text}`);
      }
    }
  }));
  if (missing.length) save();
  const out = new Float32Array(texts.length * config.dimensions);
  texts.forEach((t, i) => out.set(cache[sha(t)]!, i * config.dimensions));
  return out;
}
