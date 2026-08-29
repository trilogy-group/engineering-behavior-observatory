import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  admitTaskPacket,
  digestBytes,
  freezeTaskPacket,
  main,
  modelVisibleTaskPacket,
  statusTaskPacket,
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
    const first = freezeTaskPacket(root, "packet.json");
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
