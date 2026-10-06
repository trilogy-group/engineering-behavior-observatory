import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  RETAINED_CODEX_APP_SERVER_VERSIONS,
  RETAINED_CURSOR_SDK_VERSIONS,
  RETAINED_DEEPSEEK_SDK_VERSIONS,
  RETAINED_OPENHANDS_AGENT_SERVER_VERSIONS,
  RETAINED_PI_SDK_VERSIONS,
} from "../src/index.js";

// A pin bump appends to the retained list: captures made by any released pin stay readable.
test("every harness version pinned by a release stays readable as retained evidence", () => {
  const retained: Record<string, readonly string[]> = {
    piSdk: RETAINED_PI_SDK_VERSIONS,
    deepseekClient: RETAINED_DEEPSEEK_SDK_VERSIONS,
    codexAppServer: RETAINED_CODEX_APP_SERVER_VERSIONS,
    openhandsAgentServer: RETAINED_OPENHANDS_AGENT_SERVER_VERSIONS,
    cursorSdk: RETAINED_CURSOR_SDK_VERSIONS,
  };
  const releaseRoot = resolve("release");
  let checked = 0;
  for (const release of readdirSync(releaseRoot)) {
    const path = join(releaseRoot, release, "reproducibility.json");
    if (!existsSync(path)) continue;
    const runtime = (JSON.parse(readFileSync(path, "utf8")) as { runtime?: Record<string, string> }).runtime ?? {};
    for (const [key, versions] of Object.entries(retained)) {
      if (runtime[key] === undefined) continue;
      assert.ok(versions.includes(runtime[key]), `release ${release} pinned ${key} ${runtime[key]}, which retained readback rejects`);
      checked += 1;
    }
  }
  assert.ok(checked > 0);
});
