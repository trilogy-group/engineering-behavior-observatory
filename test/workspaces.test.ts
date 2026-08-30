import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cleanupWorkspace,
  digestBytes,
  digestMetadata,
  digestWorkspace,
  freezeTaskPacket,
  materializeWorkspace,
  type TaskPacket,
} from "../src/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function tarGzipArchive(entries: Array<{ path: string; bytes: Buffer; type?: string; mode?: number }>): Buffer {
  const blocks = entries.map(({ path, bytes, type = "0", mode = 0o644 }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write(mode.toString(8).padStart(7, "0"), 100, "ascii");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function fixtureArchive(extra: Array<{ path: string; bytes: Buffer; type?: string; mode?: number }> = []): Buffer {
  return tarGzipArchive([
    { path: "README.md", bytes: Buffer.from("# fixture\n") },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n") },
    ...extra,
  ]);
}

function createBundle(
  archive = fixtureArchive(),
  includePaths = ["README.md", "src"],
): { root: string; packet: TaskPacket } {
  const root = mkdtempSync(join(tmpdir(), "ebo-workspace-bundle-"));
  const packet = JSON.parse(readFileSync(join(repositoryRoot, "tests/fixtures/task-packet.valid.v1.json"), "utf8")) as TaskPacket;
  const components = {
    archive,
    perturbation: Buffer.from('{"kind":"controlled"}\n'),
    reference: Buffer.from("reference solution\n"),
    verifier: Buffer.from("#!/bin/sh\nexit 0\n"),
    review: Buffer.alloc(0),
  };

  packet.agentInput.fixture.source.locator = "fixture.bin";
  packet.agentInput.fixture.source.digest = digestBytes(archive);
  packet.agentInput.fixture.materializer.includePaths = includePaths;
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
  packet.admission.review!.reviewRecord.locator = "review.json";
  const preAdmission = structuredClone(packet) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  components.review = Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: packet.admission.status,
    reviewedAt: packet.admission.review!.reviewedAt,
    reviewedBy: packet.admission.review!.reviewedBy,
  }));
  packet.admission.review!.reviewRecord.digest = digestBytes(components.review);

  writeFileSync(join(root, "packet.json"), JSON.stringify(packet, null, 2));
  writeFileSync(join(root, "fixture.bin"), archive);
  writeFileSync(join(root, "perturbation.json"), components.perturbation);
  writeFileSync(join(root, "reference.txt"), components.reference);
  writeFileSync(join(root, "verifier.sh"), components.verifier);
  writeFileSync(join(root, "review.json"), components.review);
  return { root, packet };
}

test("materializes frozen fixtures reproducibly and cleans successful attempts", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const first = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "attempt-one",
      workspaceParent: parent,
    });
    const second = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "attempt-two",
      workspaceParent: parent,
    });

    assert.equal(first.startingDigest.value, second.startingDigest.value);
    assert.equal(first.workspaceFingerprint, second.workspaceFingerprint);
    assert.equal(first.workspaceFingerprint, await digestWorkspace(first.workspacePath));
    assert.equal(first.state, "ready");
    assert.equal(statSync(first.workspacePath).mode & 0o7777, 0o700);
    assert.equal(statSync(join(first.workspacePath, "README.md")).mode & 0o7777, 0o600);
    assert.equal(statSync(join(first.workspacePath, "src")).mode & 0o7777, 0o700);
    assert.equal(existsSync(join(first.workspacePath, "restricted")), false);
    assert.equal(existsSync(join(first.workspacePath, "reference.txt")), false);
    assert.equal(readFileSync(join(first.workspacePath, "README.md"), "utf8"), "# fixture\n");
    assert.equal(readFileSync(join(first.workspacePath, "src/index.ts"), "utf8"), "export {};\n");
    assert.equal(readdirSync(first.workspacePath).includes("packet.json"), false);
    assert.equal(first.workspacePath.includes("attempt-one"), true);

    await cleanupWorkspace(first);
    await second.cleanup("success");
    assert.equal(first.state, "cleaned");
    assert.equal(existsSync(first.workspacePath), false);
    assert.equal(existsSync(second.workspacePath), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("materializes concurrent attempts without process-wide directory interference", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const [first, second] = await Promise.all([
      materializeWorkspace({ bundleRoot: root, packetLocator: "packet.json", attemptId: "concurrent-one", workspaceParent: parent }),
      materializeWorkspace({ bundleRoot: root, packetLocator: "packet.json", attemptId: "concurrent-two", workspaceParent: parent }),
    ]);
    assert.equal(first.workspaceFingerprint, second.workspaceFingerprint);
    await Promise.all([first.cleanup("success"), second.cleanup("success")]);
    assert.equal(existsSync(first.workspacePath), false);
    assert.equal(existsSync(second.workspacePath), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("keeps workspaces private while preserving executable fixture and setup modes", async () => {
  const { root } = createBundle(
    fixtureArchive([{ path: "tool.sh", bytes: Buffer.from("#!/bin/sh\n"), mode: 0o755 }]),
    ["README.md", "src", "tool.sh"],
  );
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const result = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "private-modes",
      workspaceParent: parent,
      setup: (workspacePath) => writeFileSync(join(workspacePath, "setup.sh"), "#!/bin/sh\n", { mode: 0o755 }),
    });
    assert.equal(statSync(result.workspacePath).mode & 0o7777, 0o700);
    assert.equal(statSync(join(result.workspacePath, "tool.sh")).mode & 0o7777, 0o700);
    assert.equal(statSync(join(result.workspacePath, "setup.sh")).mode & 0o7777, 0o700);
    await result.cleanup("success");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("rejects malicious archive paths and selected links before creating a workspace", async () => {
  const cases = [
    fixtureArchive([{ path: "src/../../outside.txt", bytes: Buffer.from("escape") }]),
    fixtureArchive([{ path: "src/link", bytes: Buffer.from("../../outside.txt"), type: "2" }]),
  ];

  for (const archive of cases) {
    const { root } = createBundle(archive);
    const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));
    try {
      await assert.rejects(
        materializeWorkspace({ bundleRoot: root, packetLocator: "packet.json", attemptId: "unsafe", workspaceParent: parent }),
        /unsafe|No archive entries|authoritative archive enumeration|not frozen/,
      );
      assert.deepEqual(readdirSync(parent), []);
    } finally {
      rmSync(root, { force: true, recursive: true });
      rmSync(parent, { force: true, recursive: true });
    }
  }
});

test("does not expose restricted packet content even when an archive selects it", async () => {
  const { root } = createBundle(
    fixtureArchive([{ path: "restricted/verifier.json", bytes: Buffer.from("secret") }]),
    ["README.md", "src", "restricted"],
  );
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    await assert.rejects(
      materializeWorkspace({ bundleRoot: root, packetLocator: "packet.json", attemptId: "restricted", workspaceParent: parent }),
      /Restricted packet content/,
    );
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("retains failed setup attempts only when configured", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const retained = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "failed-retained",
      workspaceParent: parent,
      retainOnFailure: true,
      setup: () => { throw new Error("setup failed"); },
    });
    assert.equal(retained.state, "failed");
    assert.equal(retained.retained, true);
    assert.equal(existsSync(retained.workspacePath), true);
    assert.match(retained.error ?? "", /setup failed/);
    await retained.cleanup("failure");
    assert.equal(existsSync(retained.workspacePath), true);
    await retained.cleanup("success");
    assert.equal(retained.state, "cleaned");
    assert.equal(existsSync(retained.workspacePath), false);

    const removed = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "failed-removed",
      workspaceParent: parent,
      setup: () => { throw new Error("setup failed"); },
    });
    assert.equal(removed.state, "failed");
    assert.equal(removed.retained, false);
    assert.equal(existsSync(removed.workspacePath), false);

    const insecure = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "failed-insecure",
      workspaceParent: parent,
      retainOnFailure: true,
      setup: (workspacePath) => {
        chmodSync(workspacePath, 0o755);
        throw new Error("insecure setup failed");
      },
    });
    assert.equal(insecure.state, "failed");
    assert.equal(insecure.retained, false);
    assert.equal(existsSync(insecure.workspacePath), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("rejects a replaced workspace root without touching the replacement target", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const result = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "replaced-root",
      workspaceParent: parent,
      retainOnFailure: true,
      setup: (workspacePath) => {
        rmSync(workspacePath, { force: true, recursive: true });
        symlinkSync(root, workspacePath);
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.retained, false);
    assert.equal(existsSync(result.workspacePath), false);
    assert.equal(existsSync(join(root, "packet.json")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("does not retain or delete a replacement workspace directory", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const result = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "replacement-directory",
      workspaceParent: parent,
      retainOnFailure: true,
      setup: (workspacePath) => {
        const replacement = mkdtempSync(join(parent, "replacement-"));
        chmodSync(replacement, 0o700);
        writeFileSync(join(replacement, "marker.txt"), "leave me");
        rmSync(workspacePath, { force: true, recursive: true });
        renameSync(replacement, workspacePath);
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.retained, false);
    assert.equal(existsSync(result.workspacePath), true);
    assert.equal(readFileSync(join(result.workspacePath, "marker.txt"), "utf8"), "leave me");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("refuses cleanup after a ready workspace is replaced", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const result = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "cleanup-replacement",
      workspaceParent: parent,
    });
    const replacement = mkdtempSync(join(parent, "replacement-"));
    chmodSync(replacement, 0o700);
    writeFileSync(join(replacement, "marker.txt"), "leave me");
    rmSync(result.workspacePath, { force: true, recursive: true });
    renameSync(replacement, result.workspacePath);
    await assert.rejects(result.cleanup("success"), /Workspace root changed before cleanup/);
    assert.equal(readFileSync(join(result.workspacePath, "marker.txt"), "utf8"), "leave me");
    assert.equal(result.state, "ready");
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("rejects a replaced workspace descendant before following it", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    const result = await materializeWorkspace({
      bundleRoot: root,
      packetLocator: "packet.json",
      attemptId: "replaced-descendant",
      workspaceParent: parent,
      retainOnFailure: true,
      setup: (workspacePath) => {
        rmSync(join(workspacePath, "src"), { force: true, recursive: true });
        symlinkSync(root, join(workspacePath, "src"));
      },
    });
    assert.equal(result.state, "failed");
    assert.equal(result.retained, false);
    assert.equal(existsSync(result.workspacePath), false);
    assert.equal(existsSync(join(root, "packet.json")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("stops on a fixture digest mismatch before setup or workspace creation", async () => {
  const { root } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));
  let setupStarted = false;

  try {
    freezeTaskPacket(root, "packet.json");
    writeFileSync(join(root, "fixture.bin"), Buffer.from("tampered fixture"));
    await assert.rejects(
      materializeWorkspace({
        bundleRoot: root,
        packetLocator: "packet.json",
        attemptId: "digest-mismatch",
        workspaceParent: parent,
        setup: () => { setupStarted = true; },
      }),
      /digest does not match|Frozen task packet changed|not frozen/,
    );
    assert.equal(setupStarted, false);
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("rejects a packet replacement that no longer matches the frozen snapshot", async () => {
  const { root, packet } = createBundle();
  const parent = mkdtempSync(join(tmpdir(), "ebo-workspace-parent-"));

  try {
    freezeTaskPacket(root, "packet.json");
    packet.agentInput.prompt = "replacement packet";
    writeFileSync(join(root, "packet.json"), JSON.stringify(packet));
    await assert.rejects(
      materializeWorkspace({ bundleRoot: root, packetLocator: "packet.json", attemptId: "packet-replaced", workspaceParent: parent }),
      /changed|not frozen/,
    );
    assert.deepEqual(readdirSync(parent), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(parent, { force: true, recursive: true });
  }
});

test("rejects a workspace parent inside the bundle before creating it", async () => {
  const { root } = createBundle();
  const parent = join(root, "generated-workspaces");

  try {
    freezeTaskPacket(root, "packet.json");
    await assert.rejects(
      materializeWorkspace({ bundleRoot: root, packetLocator: "packet.json", attemptId: "nested-parent", workspaceParent: parent }),
      /Workspace parent must be outside/,
    );
    assert.equal(existsSync(parent), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
