import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { tableFromIPC } from "apache-arrow";

import { ATLAS_TABLES, buildAtlasBundle, flattenText, verifyAtlasBundle, type AtlasBundleRequest } from "../src/atlas-bundle.js";
import { loadAtlas } from "../src/atlas.js";
import { laneData } from "../src/atlas-lanes.js";
import { main } from "../src/cli.js";
import { createAtlasFixture } from "./atlas-fixture.js";

test("flattened event text keeps string leaves, labels short ones and skips identifiers", () => {
  assert.deepEqual(flattenText({ id: "x1", role: "user", content: [{ type: "text", text: "line one\nline two" }], input: '{"command":"ls"}', isError: false, exitCode: 0 }),
    ["role: user", "type: text", "line one\nline two", "command: ls", "isError: false", "exitCode: 0"]);
});

test("an Atlas bundle holds Atlas tables v1 built from the validated cohort, and verification detects changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-bundle-"));
  try {
    const atlasRequest = await createAtlasFixture(join(root, "study"));
    const source = await loadAtlas(atlasRequest);
    const requestPath = join(root, "bundle-request.json");
    const request: AtlasBundleRequest = { schemaVersion: "ebo.atlas-bundle-request/v1", id: "synthetic-study", title: "Synthetic study",
      cohorts: [{ id: "all", atlasRequest: "study/atlas.json" }], condition: { pattern: "^synthetic-(?<condition>attempt)-\\d+$" } };
    writeFileSync(requestPath, JSON.stringify(request));
    const out = join(root, "bundle");
    // Deterministic stand-in embeddings: one dimension per character code bucket, no provider call.
    const embed = async (texts: readonly string[], config: { dimensions: number }) => {
      const out = new Float32Array(texts.length * config.dimensions);
      texts.forEach((t, i) => { for (const ch of t) out[i * config.dimensions + (ch.charCodeAt(0) % config.dimensions)]! += 1; });
      return out;
    };
    const manifest = await buildAtlasBundle(requestPath, out, { now: () => new Date("2026-10-07T00:00:00.000Z"), embed });

    assert.deepEqual(Object.keys(manifest.tables).sort(), Object.keys(ATLAS_TABLES).sort());
    const runs = source.input.corpusEntries.filter(({ manifestKind }) => manifestKind === "run");
    assert.equal(manifest.tables.attempts!.rows, runs.length);
    assert.equal(manifest.tables.assessments!.rows, source.input.assertions.length);
    assert.equal(manifest.cohorts[0]!.report, "reports/all.json");

    const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    const c = await db.connect();
    const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
    const table = (name: string) => `'${join(out, "tables", `${name}.parquet`)}'`;
    try {
      const columns = await rows(`DESCRIBE SELECT * FROM ${table("events")}`);
      assert.deepEqual(columns.map(({ column_name }) => column_name), ATLAS_TABLES.events!.map(([name]) => name), "column order is part of the contract");
      const events = source.input.assertions.length ? await rows(`SELECT count(*) AS n FROM ${table("events")}`) : [];
      assert.ok(Number(events[0]!.n) > 0);
      assert.deepEqual(await rows(`SELECT DISTINCT condition FROM ${table("attempts")}`), [{ condition: "attempt" }], "arms come from the condition pattern");
      const unresolved = await rows(`SELECT count(*) AS n FROM ${table("citations")} WHERE NOT resolved`);
      assert.equal(Number(unresolved[0]!.n), 0, "every citation resolves to a bundled event");
      const orphans = await rows(`SELECT count(*) AS n FROM ${table("observation_sources")} s ANTI JOIN ${table("events")} e USING (event_key)`);
      assert.equal(Number(orphans[0]!.n), 0);
      const local = await rows(`SELECT bundle_root FROM ${table("attempts")} LIMIT 1`);
      assert.match(String(local[0]!.bundle_root), /^study\//u, "paths are relative to the request, not local absolute paths");
    } finally {
      c.closeSync();
      db.closeSync();
    }

    // Viewer documents: the cloud in Arrow IPC with one embedding per row, swimlanes, audits, native records, assessments.
    const units = tableFromIPC(readFileSync(join(out, "units.arrow")));
    assert.equal(units.numRows, manifest.cloud.units);
    assert.equal(readFileSync(join(out, "embeddings.f32")).byteLength, manifest.cloud.units * manifest.cloud.embeddings.dimensions * 4);
    const lanes = JSON.parse(readFileSync(join(out, "lanes.json"), "utf8")) as { attempts: unknown[] };
    assert.equal(lanes.attempts.length, runs.length);
    const assessments = JSON.parse(readFileSync(join(out, "assessments.json"), "utf8")) as { assessments: Array<{ citations: Array<{ native: { resolved: boolean } }> }> };
    assert.equal(assessments.assessments.length, source.input.assertions.length);
    assert.ok(assessments.assessments.every(({ citations }) => citations.every(({ native }) => native.resolved)), "every citation resolves to a native line");
    assert.deepEqual(verifyAtlasBundle(out), { ok: true, changed: [], missing: [], unlisted: [] });
    appendFileSync(join(out, "reports", "all.json"), " ");
    writeFileSync(join(out, "extra.txt"), "not listed");
    const tampered = verifyAtlasBundle(out);
    assert.deepEqual([tampered.ok, tampered.changed, tampered.unlisted], [false, ["reports/all.json"], ["extra.txt"]]);
    assert.equal(await main(["atlas", "bundle", "verify", out], () => undefined), 1);

    await assert.rejects(buildAtlasBundle(requestPath, out, { embed }), /not empty/u, "a bundle is never overwritten");
    // A failed build (here the embedding provider) leaves nothing at the destination and no partial directory.
    const failed = join(root, "bundle-failed");
    await assert.rejects(buildAtlasBundle(requestPath, failed, { embed: async () => { throw new Error("provider unavailable"); } }), /provider unavailable/u);
    assert.equal(existsSync(failed), false);
    assert.deepEqual(readdirSync(root).filter((f) => f.includes(".partial-")), []);
    // Without a provider in the request, embeddings are local: no network, deterministic.
    const local = join(root, "bundle-local");
    const localManifest = await buildAtlasBundle(requestPath, local);
    assert.equal(localManifest.cloud.embeddings.provider, "local");
    assert.deepEqual(readFileSync(join(local, "embeddings.f32")), readFileSync(join(local, "embeddings.f32")));
    writeFileSync(requestPath, JSON.stringify({ ...request, cohorts: [...request.cohorts, request.cohorts[0]] }));
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-2"), { embed }), /unique/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, condition: { pattern: "^(?<arm>.+)$" } }));
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-3"), { embed }), /named group "condition"/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, condition: { pattern: "^nothing-(?<condition>matches)$" } }));
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-4"), { embed }), /does not match the condition pattern/u, "a naming mistake is an error, not a synthesized arm");
    assert.ok(readFileSync(join(out, "manifest.json"), "utf8").includes('"schemaVersion": "ebo.atlas-bundle/v1"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lane usage: final records without token dimensions are not usage, and their cost still counts", () => {
  const event = (attributes: Record<string, unknown>) => ({ nativeTime: { status: "known", value: "2026-10-07T00:00:00.000Z" }, attributes }) as never;
  const attempt = { attempt_id: "a", task_id: null, condition: null, trial_id: null, harness_id: null, model_id: null, terminal_state: null, failure_class: null, capture_qualification: null };
  const durationOnly = laneData(attempt, [], [event({ resourceSemantics: "cumulative-final", durationMs: 1200 })]);
  assert.deepEqual([durationOnly.lane.usage_semantics, durationOnly.lane.tokens_total], ["none", null], "no token evidence is unavailable, not zero");
  const withIncrements = laneData(attempt, [], [event({ resourceSemantics: "increment", inputTokens: 10, outputTokens: 5 }), event({ resourceSemantics: "cumulative-final", totalCostUsd: 0.5 })]);
  assert.deepEqual([withIncrements.lane.usage_semantics, withIncrements.lane.tokens_total, withIncrements.lane.cost_usd], ["per-turn", 15, 0.5]);
});
