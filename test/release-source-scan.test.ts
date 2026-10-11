import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { containsPortableSecretPattern } from "../src/exports.js";

test("release source scan accepts reference-only Bearer headers and rejects credential literals", async () => {
  const { maskSourceIdentifierAssignments } = await import(pathToFileURL(resolve("scripts/release-source-scan.mjs")).href);
  const scan = (source: string) => containsPortableSecretPattern(maskSourceIdentifierAssignments(source, "fixture.ts", ts), "text/plain");
  assert.equal(scan('const headers = {Authorization: `Bearer ${key!}`};'), false);
  assert.equal(scan('const headers = {Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`};'), false);
  for (const source of [
    'const headers = {Authorization: "Bearer syntheticcredentialvalue"};',
    'const headers = {Authorization: `Bearer syntheticcredentialvalue${key}`};',
    'const headers = {Authorization: `Bearer ${"syntheticcredentialvalue"}`};',
    'const headers = {Authorization: `Bearer ${key}syntheticcredentialvalue`};',
    'const headers = {Authorization: `Bearer ${({value:"syntheticcredentialvalue"}).value}`};',
    'const headers = {Authorization: `Bearer ${["syntheticcredentialvalue"][0]}`};',
    '// Authorization: Bearer syntheticcredentialvalue',
    'const headers = { apiKey: "syntheticcredentialvalue" };',
  ]) assert.equal(scan(source), true, source);
  assert.equal(scan(readFileSync("src/atlas-embeddings.ts", "utf8")), false);
});
