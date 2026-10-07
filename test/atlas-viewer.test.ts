import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveContained, serveAtlasBundle } from "../src/atlas-viewer.js";

test("the Atlas viewer server serves the viewer and one bundle, read-only and contained", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-viewer-"));
  try {
    const viewer = join(root, "viewer"), bundle = join(root, "bundle"), outside = join(root, "outside");
    mkdirSync(join(viewer, "assets"), { recursive: true });
    mkdirSync(join(bundle, "native"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(viewer, "index.html"), "<!doctype html><title>viewer</title>");
    writeFileSync(join(viewer, "assets", "index.js"), "export {};");
    writeFileSync(join(bundle, "units.arrow"), Buffer.from([1, 2, 3]));
    writeFileSync(join(bundle, "native", "a.json"), "{}");
    writeFileSync(join(outside, "secret.txt"), "not part of the bundle");
    symlinkSync(join(outside, "secret.txt"), join(bundle, "escape.txt"));

    assert.ok(resolveContained(bundle, "/native/a.json")?.endsWith("native/a.json"));
    assert.equal(resolveContained(bundle, "/../outside/secret.txt"), undefined, "parent segments are refused");
    assert.equal(resolveContained(bundle, "/%2e%2e/outside/secret.txt"), undefined, "encoded parent segments are refused");
    assert.equal(resolveContained(bundle, "/escape.txt"), undefined, "a symlink out of the root is refused");
    assert.equal(resolveContained(bundle, "/native"), undefined, "directories are not listed");

    const server = await serveAtlasBundle(bundle, 0, viewer);
    try {
      const { port } = server.address() as AddressInfo;
      const get = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
      const index = await get("/");
      assert.equal(index.status, 200);
      assert.match(index.headers.get("content-type") ?? "", /text\/html/u);
      assert.equal((await get("/assets/index.js")).status, 200);
      const units = await get("/bundle/units.arrow");
      assert.equal(units.status, 200);
      assert.deepEqual([...new Uint8Array(await units.arrayBuffer())], [1, 2, 3]);
      assert.equal((await get("/bundle/escape.txt")).status, 404);
      assert.equal((await get("/bundle/missing.json")).status, 404);
      assert.equal((await get("/bundle/%2e%2e/outside/secret.txt")).status, 404);
      assert.equal((await get("/bundle/units.arrow", { method: "POST" })).status, 405);
      // fetch drops a custom Host header, so this request goes through node:http
      const foreignHost = await new Promise<number>((done, fail) => {
        request({ host: "127.0.0.1", port, path: "/", headers: { host: "example.com" } }, (res) => { res.resume(); done(res.statusCode ?? 0); }).on("error", fail).end();
      });
      assert.equal(foreignHost, 403, "foreign hosts are refused");
      assert.equal((await get("/", { headers: { origin: "http://example.com" } })).status, 403, "foreign origins are refused");
    } finally {
      await new Promise((done) => server.close(done));
    }

    await assert.rejects(serveAtlasBundle(outside, 0, viewer), /not an Atlas bundle/u);
    await assert.rejects(serveAtlasBundle(bundle, 0, outside), /viewer is not built/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
