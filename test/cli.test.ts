import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../src/cli.js";

test("help succeeds without configuring an evaluation", () => {
  let output = "";

  assert.equal(main(["--help"], (message) => (output += message)), 0);
  assert.match(output, /^Usage: ebo \[--help\]/);
});
