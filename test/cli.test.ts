import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("help succeeds without configuring an evaluation", () => {
  let output = "";

  assert.equal(main(["--help"], (message) => (output += message)), 0);
  assert.match(output, /^Usage: ebo \[--help\]/);
});

test("the installed package exposes an executable ebo binary", () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "ebo-bin-"));

  try {
    writeFileSync(join(installationRoot, "package.json"), '{"private":true}');
    const npmEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: installationRoot,
      npm_config_userconfig: join(installationRoot, ".npmrc"),
    };
    delete npmEnvironment.npm_config_allow_scripts;
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", repositoryRoot],
      { cwd: installationRoot, env: npmEnvironment, stdio: "pipe" },
    );

    const output = execFileSync(
      join(installationRoot, "node_modules", ".bin", "ebo"),
      ["--help"],
      { encoding: "utf8" },
    );

    assert.match(output, /^Usage: ebo \[--help\]/);
  } finally {
    rmSync(installationRoot, { force: true, recursive: true });
  }
});

test("generated output ignores are root-scoped", () => {
  const isIgnored = (path: string) =>
    spawnSync("git", ["check-ignore", "-q", path], { cwd: repositoryRoot })
      .status === 0;

  for (const path of [
    ".ebo/attempt.json",
    "collector/log.json",
    "workspaces/task",
    "run-bundles/attempt.json",
    "exports/portable.json",
  ]) {
    assert.equal(isIgnored(path), true, `${path} should be ignored`);
  }

  for (const path of [
    "src/collector/client.ts",
    "src/exports/format.ts",
    "test/fixtures/run-bundles/example.json",
    "schemas/run-bundles/v1.json",
  ]) {
    assert.equal(isIgnored(path), false, `${path} should remain trackable`);
  }
});
