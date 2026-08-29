import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("help succeeds without configuring an evaluation", () => {
  let output = "";

  assert.equal(main(["--help"], (message) => (output += message)), 0);
  assert.match(output, /^Usage: ebo \[--help\]/);
});

test("a clean source checkout packs an executable ebo binary", () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "ebo-bin-"));
  const sourceRoot = join(installationRoot, "source");
  const consumerRoot = join(installationRoot, "consumer");

  try {
    for (const file of execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
    }).toString().split("\0").filter(Boolean)) {
      const destination = join(sourceRoot, file);

      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repositoryRoot, file), destination);
    }
    assert.equal(existsSync(join(sourceRoot, "dist")), false);

    const npmEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: installationRoot,
      npm_config_userconfig: join(installationRoot, ".npmrc"),
    };
    delete npmEnvironment.npm_config_allow_scripts;

    execFileSync(
      "npm",
      ["ci"],
      { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" },
    );
    const [{ filename }] = JSON.parse(
      execFileSync("npm", ["pack", "--json"], {
        cwd: sourceRoot,
        encoding: "utf8",
        env: npmEnvironment,
      }),
    ) as Array<{ filename: string }>;

    assert.equal(existsSync(join(sourceRoot, "dist", "src", "cli.js")), true);
    mkdirSync(consumerRoot);
    writeFileSync(join(consumerRoot, "package.json"), '{"private":true}');
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", join(sourceRoot, filename)],
      { cwd: consumerRoot, env: npmEnvironment, stdio: "pipe" },
    );

    const output = execFileSync(
      join(consumerRoot, "node_modules", ".bin", "ebo"),
      ["--help"],
      { encoding: "utf8" },
    );

    assert.match(output, /^Usage: ebo \[--help\]/);
  } finally {
    rmSync(installationRoot, { force: true, recursive: true });
  }
});

test("build removes stale compiled tests before test discovery", () => {
  const installationRoot = mkdtempSync(join(tmpdir(), "ebo-clean-build-"));
  const sourceRoot = join(installationRoot, "source");

  try {
    for (const file of execFileSync("git", ["ls-files", "-z"], {
      cwd: repositoryRoot,
    }).toString().split("\0").filter(Boolean)) {
      const destination = join(sourceRoot, file);

      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(repositoryRoot, file), destination);
    }

    const npmEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: installationRoot,
      npm_config_userconfig: join(installationRoot, ".npmrc"),
    };
    delete npmEnvironment.npm_config_allow_scripts;
    const staleTest = join(sourceRoot, "dist", "test", "stale.test.js");

    execFileSync("npm", ["ci"], { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" });
    execFileSync("npm", ["run", "build"], { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" });
    writeFileSync(staleTest, "throw new Error('stale test should be removed');\n");
    execFileSync("npm", ["run", "build"], { cwd: sourceRoot, env: npmEnvironment, stdio: "pipe" });

    assert.equal(existsSync(staleTest), false);
  } finally {
    rmSync(installationRoot, { force: true, recursive: true });
  }
});

test("CLI import ignores a non-filesystem argv entry", () => {
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('./dist/src/cli.js')", "does-not-exist"],
      { cwd: repositoryRoot, stdio: "pipe" },
    ),
  );
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
