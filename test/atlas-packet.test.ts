import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAtlasBundle, type AtlasBundleRequest } from "../src/atlas-bundle.js";
import { tableFromIPC } from "apache-arrow";
import { buildPacket, refreshSharedEnvironment, sharedJson, sharedText, verifyPacket, withoutHiddenReasoning, type PacketManifest } from "../src/atlas-packet.js";
import { verifyAtlasBundle as verifyPacketBundle } from "../src/atlas-bundle.js";
import { createAtlasFixture } from "./atlas-fixture.js";

test("evidence packets: three variants, verification, withholding and claims that must validate", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-packet-"));
  try {
    await createAtlasFixture(join(root, "study"));
    const viewer = join(root, "viewer-dist");
    mkdirSync(join(viewer, "assets"), { recursive: true });
    writeFileSync(join(viewer, "index.html"), "<!doctype html><title>viewer</title>");
    writeFileSync(join(viewer, "assets", "index.js"), "export {};");
    const claims = { study: "synthetic", source: { file: "report.md", title: "Synthetic report" }, number_kinds: {},
      claims: [{ id: "C1", type: "descriptive", text: "Seven attempts were captured.", source_section: "Summary", support: [],
        numbers: [{ id: "attempts", label: "attempts", value: 7, kind: "lab", expr: { sql: "SELECT count(*) FROM attempts" } }] }] };
    writeFileSync(join(root, "claims.json"), JSON.stringify(claims));
    const request: AtlasBundleRequest = { schemaVersion: "ebo.atlas-bundle-request/v1", id: "synthetic", title: "Synthetic study",
      cohorts: [{ id: "all", atlasRequest: "study/atlas.json" }], claims: "claims.json" };
    writeFileSync(join(root, "request.json"), JSON.stringify(request));
    await buildAtlasBundle(join(root, "request.json"), join(root, "bundle"));

    const built: Record<string, PacketManifest> = {};
    for (const variant of ["internal", "partner", "restricted"] as const) {
      built[variant] = await buildPacket(join(root, "bundle"), join(root, `packet-${variant}`), { variant, viewerRoot: viewer });
      assert.deepEqual(verifyPacket(join(root, `packet-${variant}`)), { ok: true, changed: [], missing: [], unlisted: [] }, variant);
      assert.ok(readdirSync(join(root, `packet-${variant}`, "claims")).some((f) => /^C1-[0-9a-f]{10}\.html$/u.test(f)), `${variant}: claim page`);
      for (const page of ["index.html", "claims/index.html", "evaluations/index.html", "metrics/index.html", "verify.html", "viewer/index.html", "ro-crate-metadata.json"])
        assert.ok(existsSync(join(root, `packet-${variant}`, page)), `${variant}: ${page}`);
      assert.deepEqual(built[variant]!.assistant, { enabled: false, endpoint: null, model: null, dataPolicy: null }, "the assistant slot is reserved and disabled");
    }
    const internal = built.internal!, restricted = built.restricted!;
    assert.equal(internal.withheld.length, 0);
    assert.match(readFileSync(join(root, "packet-internal", "verify.html"), "utf8"), /if \(!contained\(f\.path\)\)/u, "the browser verifier checks each path before fetching it");
    assert.ok(internal.files.some(({ path }) => path.startsWith("viewer/bundle/native/")));
    assert.ok(existsSync(join(root, "packet-internal", "evidence", "index.html")));
    // Restricted: native records, audits and tables are withheld (listed with digests); unit text is structural.
    assert.ok(restricted.withheld.some(({ path }) => path.startsWith("viewer/bundle/native/")) && restricted.withheld.some(({ path }) => path.startsWith("viewer/bundle/tables/")));
    assert.ok(restricted.withheld.every(({ sha256 }) => /^sha256:[0-9a-f]{64}$/u.test(sha256)));
    assert.ok(!restricted.files.some(({ path }) => path.startsWith("viewer/bundle/native/") || path === "viewer/bundle/audit.json"));
    assert.equal(existsSync(join(root, "packet-restricted", "evidence")), false);
    const restrictedAssessments = readFileSync(join(root, "packet-restricted", "viewer/bundle/assessments.json"), "utf8");
    assert.equal(/"text":/u.test(restrictedAssessments.replace(/"claims":\[[^\]]*\]/gu, "")), false, "cited native text is withheld");
    // Shared variants drop local paths and keep no write paths in restricted units.
    const partnerAssessments = readFileSync(join(root, "packet-partner", "viewer/bundle/assessments.json"), "utf8");
    assert.equal(/"(path|bundle|bundle_root)":/u.test(partnerAssessments), false, "local paths are dropped from shared documents");
    const restrictedUnits = tableFromIPC(readFileSync(join(root, "packet-restricted", "viewer/bundle/units.arrow")));
    assert.ok(Array.from({ length: restrictedUnits.numRows }, (_, i) => restrictedUnits.getChild("writes")!.get(i)?.length ?? 0).every((n) => n === 0), "restricted units carry no write paths");
    const commands = restrictedUnits.getChild("command");
    assert.ok(commands === null || Array.from({ length: restrictedUnits.numRows }, (_, i) => commands.get(i)).every((c) => c === null), "restricted units carry no raw commands");
    const embedChars = restrictedUnits.getChild("embed_chars");
    assert.ok(embedChars === null || Array.from({ length: restrictedUnits.numRows }, (_, i) => Number(embedChars.get(i)) === String(restrictedUnits.getChild("embed_text")!.get(i)).length).every(Boolean));
    // The RO-Crate is generated from the manifest and lists every file.
    const crate = JSON.parse(readFileSync(join(root, "packet-internal", "ro-crate-metadata.json"), "utf8")) as { "@graph": Array<{ "@id": string }> };
    assert.ok(internal.files.every(({ path }) => crate["@graph"].some((n) => n["@id"] === path)));

    appendFileSync(join(root, "packet-internal", "index.html"), "<!-- changed -->");
    writeFileSync(join(root, "packet-internal", "extra.txt"), "x");
    appendFileSync(join(root, "packet-internal", "ro-crate-metadata.json"), " ");
    const tampered = verifyPacket(join(root, "packet-internal"));
    assert.deepEqual([tampered.ok, tampered.changed, tampered.unlisted], [false, ["index.html", "ro-crate-metadata.json"], ["extra.txt"]]);
    const packetManifest = join(root, "packet-internal", "manifest.json");
    const escaping = JSON.parse(readFileSync(packetManifest, "utf8")) as PacketManifest;
    escaping.files[0]!.path = "../../etc/hosts";
    writeFileSync(packetManifest, JSON.stringify(escaping));
    assert.throws(() => verifyPacket(join(root, "packet-internal")), /not a contained relative path/u, "verification never reads outside the packet");
    await assert.rejects(buildPacket(join(root, "bundle"), join(root, "packet-internal"), { variant: "internal", viewerRoot: viewer }), /not empty/u);

    // A manifest path that escapes its root is rejected before anything is read or written.
    const manifestPath = join(root, "bundle", "manifest.json");
    const original = readFileSync(manifestPath, "utf8");
    const escaped = JSON.parse(original) as { files: Array<{ path: string }> };
    escaped.files[0]!.path = "../outside.json";
    writeFileSync(manifestPath, JSON.stringify(escaped));
    assert.throws(() => verifyPacketBundle(join(root, "bundle")), /not a contained relative path/u);
    await assert.rejects(buildPacket(join(root, "bundle"), join(root, "packet-escape"), { variant: "internal", viewerRoot: viewer }), /not a contained relative path/u);
    writeFileSync(manifestPath, original);

    // Source metadata is shared like any other text: a local path in the study title does not reach the packet.
    writeFileSync(join(root, "request.json"), JSON.stringify({ ...request, title: "Study at /workspace/acme/private-study" }));
    await buildAtlasBundle(join(root, "request.json"), join(root, "bundle-titled"));
    await buildPacket(join(root, "bundle-titled"), join(root, "packet-titled"), { variant: "partner", viewerRoot: viewer });
    for (const f of ["index.html", "manifest.json", "ro-crate-metadata.json", "README.md"]) assert.equal(readFileSync(join(root, "packet-titled", f), "utf8").includes("/workspace/acme"), false, f);
    writeFileSync(join(root, "request.json"), JSON.stringify(request));

    // A claim that no longer recomputes: internal packets show it; partner and restricted packets refuse to build.
    writeFileSync(join(root, "claims.json"), JSON.stringify({ ...claims, claims: [{ ...claims.claims[0], numbers: [{ ...claims.claims[0]!.numbers[0], value: 8 }] }] }));
    await buildAtlasBundle(join(root, "request.json"), join(root, "bundle-failing"));
    await buildPacket(join(root, "bundle-failing"), join(root, "packet-failing-internal"), { variant: "internal", viewerRoot: viewer });
    const failingPage = readdirSync(join(root, "packet-failing-internal", "claims")).find((f) => f.startsWith("C1-"))!;
    assert.match(readFileSync(join(root, "packet-failing-internal", "claims", failingPage), "utf8"), /does not hold/u);
    await assert.rejects(buildPacket(join(root, "bundle-failing"), join(root, "packet-failing-partner"), { variant: "partner", viewerRoot: viewer }), /needs validated claims/u);
    assert.equal(existsSync(join(root, "packet-failing-partner")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared native records drop hidden reasoning blocks and fields", () => {
  assert.equal(sharedText("cd /Users/alex/repo && ls /workspace/acme/private.ts src/app.ts"), "cd [LOCAL_PATH]/repo && ls [LOCAL_PATH] src/app.ts", "home directories and absolute local paths go, workspace-relative paths stay");
  assert.equal(sharedText(`${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}\nMIIE\n${"-".repeat(5)}END RSA PRIVATE KEY${"-".repeat(5)}`).includes("MIIE"), false);
  const record = { type: "assistant", message: { content: [{ type: "thinking", thinking: "private", signature: "sig" }, { type: "text", text: "visible" }], reasoning_content: "private" } };
  assert.deepEqual(withoutHiddenReasoning(record), { type: "assistant", message: { content: [{ type: "text", text: "visible" }] } });
  assert.deepEqual(withoutHiddenReasoning({ result: { signature: "verified" } }), { result: { signature: "verified" } }, "an ordinary signature field is evidence");
  assert.deepEqual(sharedJson({ password: { value: "plain-value" }, note: "ok" }), { password: "[REDACTED_SECRET]", note: "ok" }, "a secret-named field is replaced whatever it holds");
  process.env.EBO_PACKET_TEST_HOST = "build-host.internal.example";
  try {
    refreshSharedEnvironment();
    assert.equal(sharedText("ssh build-host.internal.example"), "ssh [REDACTED_SECRET]", "environment values are sensitive, as in portable exports");
  } finally { delete process.env.EBO_PACKET_TEST_HOST; refreshSharedEnvironment(); }
});
