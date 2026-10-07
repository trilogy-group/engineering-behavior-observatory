import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { tableFromIPC } from "apache-arrow";

import { ATLAS_TABLES, buildAtlasBundle, flattenText, verifyAtlasBundle, type AtlasBundleRequest } from "../src/atlas-bundle.js";
import { loadAtlas } from "../src/atlas.js";
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
    writeFileSync(requestPath, JSON.stringify({ ...request, cohorts: [...request.cohorts, request.cohorts[0]] }));
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-2"), { embed }), /unique/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, condition: { pattern: "^(?<arm>.+)$" } }));
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-3"), { embed }), /named group "condition"/u);
    assert.ok(readFileSync(join(out, "manifest.json"), "utf8").includes('"schemaVersion": "ebo.atlas-bundle/v1"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
