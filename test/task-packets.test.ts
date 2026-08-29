import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitTaskPacket,
  defaultFreezeLocator,
  digestBytes,
  digestMetadata,
  freezeTaskPacket,
  main,
  modelVisibleTaskPacket,
  statusTaskPacket,
  writeMetadataAtomicallyIfAbsentSync,
  type TaskPacket,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = (name: string) => join(repositoryRoot, "tests", "fixtures", name);

function packetFixture(name = "task-packet.valid.v1.json"): TaskPacket {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as TaskPacket;
}

function createBundle(packet = packetFixture()): { root: string; packet: TaskPacket } {
  const root = mkdtempSync(join(tmpdir(), "ebo-task-packet-"));
  const components = {
    fixture: Buffer.from("fixture bytes"),
    perturbation: Buffer.from('{"kind":"controlled"}\n'),
    reference: Buffer.from("reference solution\n"),
    verifier: Buffer.from("#!/bin/sh\nexit 0\n"),
    review: Buffer.from('{"decision":"pass"}\n'),
  };
  packet.agentInput.fixture.source.locator = "fixture.bin";
  packet.agentInput.fixture.source.digest = digestBytes(components.fixture);
  if ("reference" in packet.controlledPerturbation) {
    packet.controlledPerturbation.reference.locator = "perturbation.json";
    packet.controlledPerturbation.reference.digest = digestBytes(components.perturbation);
  }
  if ("locator" in packet.restricted.referenceSolution) {
    packet.restricted.referenceSolution.locator = "reference.txt";
    packet.restricted.referenceSolution.digest = digestBytes(components.reference);
  }
  packet.restricted.verifier.locator = "verifier.sh";
  packet.restricted.verifier.digest = digestBytes(components.verifier);
  if (packet.admission.review !== null) {
    packet.admission.review.reviewRecord.locator = "review.json";
    const preAdmission = structuredClone(packet);
    delete (preAdmission as unknown as Record<string, unknown>).admission;
    components.review = Buffer.from(JSON.stringify({ preAdmissionDigest: digestMetadata(preAdmission) }));
    packet.admission.review.reviewRecord.digest = digestBytes(components.review);
  }

  writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
  for (const [name, bytes] of Object.entries(components)) writeFileSync(join(root, `${name}.bin`), bytes);
  writeFileSync(join(root, "perturbation.json"), components.perturbation);
  writeFileSync(join(root, "reference.txt"), components.reference);
  writeFileSync(join(root, "verifier.sh"), components.verifier);
  writeFileSync(join(root, "review.json"), components.review);
  return { root, packet };
}

test("freezing a packet is idempotent and keeps the model projection private", () => {
  const { root, packet } = createBundle();
  try {
    const cwd = process.cwd();
    const first = freezeTaskPacket(root, "packet.json");
    assert.equal(process.cwd(), cwd);
    const second = freezeTaskPacket(root, "packet.json");
    assert.deepEqual(second, first);
    assert.equal(first.components.prompt.algorithm, "sha256");
    assert.equal(first.components.fixture!.value, digestBytes(Buffer.from("fixture bytes")).value);
    assert.equal(statusTaskPacket(root, "packet.json").status, "frozen");
    assert.deepEqual(modelVisibleTaskPacket(packet), packet.agentInput);
    assert.doesNotMatch(JSON.stringify(modelVisibleTaskPacket(packet)), /referenceSolution|reviewRecord|verifier/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status identifies every frozen component mutation", () => {
  for (const mutation of ["prompt", "fixture", "reference", "verifier", "reviewRecord", "controlledPerturbation"]) {
    const { root, packet } = createBundle();
    try {
      freezeTaskPacket(root, "packet.json");
      if (mutation === "prompt") {
        packet.agentInput.prompt = "A changed prompt.";
        writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
      } else {
        const paths: Record<string, string> = {
          fixture: "fixture.bin",
          reference: "reference.txt",
          verifier: "verifier.sh",
          reviewRecord: "review.json",
          controlledPerturbation: "perturbation.json",
        };
        writeFileSync(join(root, paths[mutation]!), Buffer.from(`changed ${mutation}`));
      }
      const status = statusTaskPacket(root, "packet.json");
      assert.ok(status.mismatches.some((value) => value.endsWith(`.${mutation}`)), `${mutation}: ${JSON.stringify(status)}`);
      assert.notEqual(status.status, "frozen");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("freeze preserves unavailable declaration states", () => {
  const packet = packetFixture();
  packet.restricted.referenceSolution = { status: "unsupported" };
  packet.controlledPerturbation = { status: "not-applied" };
  const { root } = createBundle(packet);
  try {
    const record = freezeTaskPacket(root, "packet.json");
    assert.deepEqual(record.components.reference, { status: "unsupported" });
    assert.deepEqual(record.components.controlledPerturbation, { status: "not-applied" });
    assert.equal(statusTaskPacket(root, "packet.json").status, "frozen");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("admission requires a passing recorded human decision", () => {
  const proposed = createBundle(packetFixture("task-packet.proposed.v1.json"));
  try {
    const result = admitTaskPacket(proposed.root, "packet.json");
    assert.ok(result.errors.some((error) => error.field === "/admission/status"));
    assert.equal(main(["task-packet", "admit", proposed.root, "packet.json"], () => 0), 1);
  } finally {
    rmSync(proposed.root, { force: true, recursive: true });
  }

  const unknown = createBundle();
  try {
    unknown.packet.sharing.classification = "unknown" as TaskPacket["sharing"]["classification"];
    writeFileSync(join(unknown.root, "packet.json"), JSON.stringify(unknown.packet, null, 2));
    assert.ok(admitTaskPacket(unknown.root, "packet.json").errors.some((error) => error.field.includes("classification")));
  } finally {
    rmSync(unknown.root, { force: true, recursive: true });
  }
});

test("admission rejects a review record bound to another packet", () => {
  const { root, packet } = createBundle();
  try {
    const foreign = structuredClone(packet);
    foreign.id = "foreign-packet";
    delete (foreign as unknown as Record<string, unknown>).admission;
    const review = Buffer.from(JSON.stringify({ preAdmissionDigest: digestMetadata(foreign) }));
    writeFileSync(join(root, "review.json"), review);
    packet.admission.review!.reviewRecord.digest = digestBytes(review);
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    const result = admitTaskPacket(root, "packet.json");
    assert.ok(result.errors.some((error) => /pre-admission digest/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("inspection enforces the fixture compressed-byte limit", () => {
  const { root, packet } = createBundle();
  try {
    packet.agentInput.fixture.source.limits.maxCompressedBytes = 1;
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    const result = admitTaskPacket(root, "packet.json");
    assert.ok(result.errors.some((error) => /exceeds its maximum bytes/.test(error.message)));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("create-if-absent metadata writes preserve the first freeze", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-freeze-race-"));
  try {
    assert.equal(writeMetadataAtomicallyIfAbsentSync(root, "freeze.json", { winner: "first" }).created, true);
    assert.equal(writeMetadataAtomicallyIfAbsentSync(root, "freeze.json", { winner: "second" }).created, false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "freeze.json"), "utf8")), { winner: "first" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status recovers an interrupted freeze-record hard link", () => {
  const { root } = createBundle();
  const freezePath = join(root, "packet.json.freeze.json");
  const temporaryLink = join(root, ".11111111-1111-4111-8111-111111111111.tmp");
  try {
    freezeTaskPacket(root, "packet.json");
    linkSync(freezePath, temporaryLink);
    assert.equal(lstatSync(freezePath).nlink, 2);
    assert.equal(statusTaskPacket(root, "packet.json").status, "frozen");
    assert.equal(existsSync(temporaryLink), false);
  } finally {
    try {
      unlinkSync(temporaryLink);
    } catch {
      // The helper process may already have removed the transient link.
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("freeze publication rejects a symlinked ancestor", () => {
  const { root } = createBundle();
  const outside = mkdtempSync(join(tmpdir(), "ebo-freeze-outside-"));
  try {
    symlinkSync(outside, join(root, "nested"));
    assert.throws(() => freezeTaskPacket(root, "packet.json", "nested/freeze.json"), /symbolic link/);
    assert.equal(existsSync(join(outside, "freeze.json")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("freeze validates its constructed record and bounds the default locator", () => {
  const { root } = createBundle();
  try {
    writeFileSync(join(root, ".packet.json"), readFileSync(join(root, "packet.json")));
    assert.throws(() => freezeTaskPacket(root, ".packet.json", "freeze.json"), /packetLocator/);
    assert.equal(existsSync(join(root, "freeze.json")), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }

  const nearLimit = Array.from({ length: 4 }, () => "a".repeat(239)).join("/");
  assert.throws(() => defaultFreezeLocator(nearLimit), /exceeds safe path limits/);
});

test("status never reports an unadmitted packet as frozen", () => {
  const { root, packet } = createBundle();
  try {
    freezeTaskPacket(root, "packet.json");
    packet.admission.status = "rejected";
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "unadmitted");
    assert.deepEqual(status.mismatches, ["admission"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status reports a malformed freeze record as invalid", () => {
  const { root } = createBundle();
  try {
    writeFileSync(join(root, "packet.json.freeze.json"), "{\n");
    const status = statusTaskPacket(root, "packet.json");
    assert.equal(status.status, "invalid");
    assert.deepEqual(status.mismatches, ["freeze-record"]);
    assert.equal(status.errors[0]?.schemaVersion, "ebo.task-packet-freeze/v1");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("task-packet CLI exposes validate, freeze, and status", () => {
  const { root } = createBundle();
  try {
    let output = "";
    assert.equal(main(["task-packet", "validate", root, "packet.json"], (message) => (output += message)), 0);
    assert.match(output, /Validated task packet/);
    output = "";
    assert.equal(main(["task-packet", "freeze", root, "packet.json"], (message) => (output += message)), 0);
    assert.match(output, /Frozen task packet.*aggregate sha256:/);
    output = "";
    assert.equal(main(["task-packet", "status", root, "packet.json"], (message) => (output += message)), 0);
    assert.match(output, /Task packet status: frozen/);
    assert.match(output, /Aggregate digest: sha256:/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
