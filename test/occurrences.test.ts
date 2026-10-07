import assert from "node:assert/strict";
import test from "node:test";

import { checkKindsOf, extractOccurrences, findCommand, shellWrites, type OccurrenceOperation } from "../src/occurrences.js";
import type { UniformEvent } from "../src/uniform-events.js";

function event(sequence: number, family: UniformEvent["family"], attributes: UniformEvent["attributes"] = {}, phase: UniformEvent["phase"] = "instant"): UniformEvent {
  return {
    schemaVersion: "ebo.uniform-event/v1", id: `event-${sequence}`, runId: "run", attemptId: "attempt",
    source: { harness: "fixture", nativeType: family, nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } },
    nativeOrder: { status: "known", value: sequence, domain: "session" },
    nativeTime: { status: "known", value: new Date(Date.UTC(2026, 9, 4, 0, 0, sequence)).toISOString() },
    actor: { kind: "tool" }, family, phase, scope: { kind: "session", id: "session" },
    relations: { parent: { status: "unknown", reason: "fixture" }, known: [] }, attributes,
    content: { status: "known", value: [{ nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } }] },
  };
}

function call(sequence: number, toolName: string, command: string, result: { isError?: boolean; output?: string } = {}): { operation: OccurrenceOperation; content: Record<string, unknown> } {
  const start = event(sequence * 10, "tool", { toolName, inputDigest: `sha256:${command}` }, "before");
  const end = event(sequence * 10 + 1, "tool", { toolName, ...(result.isError === undefined ? {} : { isError: result.isError }) }, "after");
  return {
    operation: { id: `op-${sequence}`, events: [start, end], toolName, inputDigest: `sha256:${command}`, failed: result.isError === true },
    content: { [`line:${sequence * 10}`]: { input: { command } }, [`line:${sequence * 10 + 1}`]: { output: result.output ?? "" } },
  };
}

const capability = { status: "available" as const };

test("classifies every check a command runs per segment and the source paths it writes", () => {
  assert.deepEqual(checkKindsOf("cd app && pnpm exec jest src/a.test.ts; npx tsc --noEmit | tail -5"), ["test", "typecheck"]);
  assert.deepEqual(checkKindsOf("bash -lc 'pnpm lint && pnpm build'"), ["lint", "build"]);
  assert.deepEqual(checkKindsOf("cat tsc-output.txt && grep -r test src"), []);
  assert.deepEqual(checkKindsOf("cat SKILL.md; npx playwright --version 2>/dev/null; ls /root/.cache"), [], "a version query is not a check run");
  assert.deepEqual(checkKindsOf("npx playwright install chromium && npx tsc --version"), []);
  assert.deepEqual(checkKindsOf("npx jest --listTests && pnpm exec playwright show-report"), []);
  assert.deepEqual(checkKindsOf("npx playwright test e2e/login.spec.ts"), ["test"]);
  assert.deepEqual(checkKindsOf("npx jest add"), ["test"], "a test selector named like a setup command is still a run");
  assert.deepEqual(shellWrites("node -e \"require('fs').writeFileSync('src/app.tsx', s)\""), ["src/app.tsx"]);
  assert.deepEqual(shellWrites("sed -i 's/a/b/' src/lib/util.ts && cat src/lib/util.ts > /tmp/out.log"), ["src/lib/util.ts"]);
  assert.deepEqual(shellWrites("pnpm test 2>&1 | tail"), []);
  assert.equal(findCommand({ data: { arguments: JSON.stringify({ command: "pnpm test" }) } }), "pnpm test");
  assert.equal(findCommand({ command: ["bash", "-lc", "jest"] }), "bash -lc jest");
});

test("extracts instance-sized occurrences that cite only their own events", () => {
  const calls = [
    call(1, "Bash", "pnpm exec jest", { isError: true, output: "Exit code 1" }),
    call(2, "Bash", "pnpm exec jest --watch=false", { isError: true }),
    call(3, "Read", "src/a.ts", { isError: false }),
    call(4, "Bash", "pnpm exec jest", { isError: false, output: "Tests: 4 passed" }),
    call(5, "Edit", "src/a.ts", { isError: false }),
    call(6, "Bash", "pnpm test 2>&1 | tail > /tmp/test.log", { isError: false, output: "ELIFECYCLE Command failed with exit code 1." }),
  ];
  const content = Object.assign({}, ...calls.map(({ content: value }) => value)) as Record<string, unknown>;
  const compactionStart = event(100, "context", { subtype: "compact_boundary" });
  const compactionHook = event(101, "context", { hook: "PreCompact" });
  const operations = calls.map(({ operation }) => operation);
  const events = [...operations.flatMap(({ events: operationEvents }) => operationEvents), compactionStart, compactionHook];
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events, operations, toolCapability: capability,
    delegationCapability: { status: "unsupported", detail: "The fixture adapter does not expose delegation." },
    isCompaction: ({ family, attributes }) => family === "context" && (attributes.subtype === "compact_boundary" || attributes.hook === "PreCompact"),
    resolveContent: ({ recordLocator }) => content[recordLocator],
  });
  const of = (type: string) => occurrences.filter((occurrence) => occurrence.type === type);

  const [chain] = of("failure-response");
  assert.equal(of("failure-response").length, 1);
  assert.deepEqual(chain!.eventIds, ["event-10", "event-11", "event-20", "event-21", "event-40", "event-41"], "two failures of Bash, then its next call");
  assert.deepEqual(chain!.attributes, { toolName: "Bash", failures: 2, lastFailureEventId: "event-21", nextOutcome: "passed", responseEventId: "event-40" });
  assert.equal(chain!.id, "attempt/occ/failure-response/event-10");
  assert.equal(chain!.rule.heuristic, false);

  const validations = of("validation-run");
  assert.equal(validations.length, 4);
  assert.ok(validations.every(({ rule, eventIds }) => rule.heuristic && eventIds.length === 2));
  assert.deepEqual(validations.map(({ attributes }) => attributes.result), ["failed", "failed", "passed", "passed"]);
  assert.equal(validations[0]!.attributes.reportedExitCode, 1);
  assert.equal(validations[3]!.attributes.reportedExitCode, 1, "a check failing inside a pipeline is visible though the call succeeded");
  assert.equal(validations[3]!.attributes.outputRedirected, true);

  assert.deepEqual(of("source-change").map(({ attributes }) => attributes.detectedBy), ["edit-tool"]);
  assert.deepEqual(of("repeated-operation").map(({ eventIds, attributes }) => [eventIds, attributes.firstEventId]), [[["event-40", "event-41"], "event-10"]]);
  assert.deepEqual(of("compaction").map(({ eventIds }) => eventIds), [["event-100", "event-101"]], "records of one boundary form one compaction");

  assert.equal(of("delegation").length, 0);
  assert.deepEqual(coverage.find(({ type }) => type === "delegation"), { type: "delegation", status: "unavailable", reason: "The fixture adapter does not expose delegation." });
  assert.deepEqual(coverage.find(({ type }) => type === "validation-run"), { type: "validation-run", status: "available", count: 4 });
});

test("command-based occurrence types are unavailable without native content, never zero", () => {
  const { operation } = call(1, "Bash", "pnpm exec jest", { isError: false });
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events: [...operation.events], operations: [operation], toolCapability: capability,
    delegationCapability: capability, isCompaction: () => false,
  });
  assert.equal(occurrences.some(({ type }) => type === "validation-run" || type === "source-change"), false);
  assert.equal(coverage.find(({ type }) => type === "validation-run")?.status, "unavailable");
  assert.equal(coverage.find(({ type }) => type === "source-change")?.status, "unavailable");
  assert.deepEqual(coverage.find(({ type }) => type === "delegation"), { type: "delegation", status: "available", count: 0 });
});

test("explicit mutations outside tool operations are source changes", () => {
  const fileChange = event(5, "artifact", { mutation: true, itemType: "fileChange", status: "completed" }, "after");
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: [fileChange], operations: [], toolCapability: capability, delegationCapability: capability,
    isCompaction: () => false, resolveContent: () => undefined,
  });
  assert.deepEqual(occurrences.map(({ type, eventIds, rule, attributes }) => [type, eventIds, rule.heuristic, attributes.detectedBy, attributes.toolName]),
    [["source-change", ["event-5"], false, "explicit-mutation", "fileChange"]]);
});

test("a failure response starts after the failure, in the same session", () => {
  const at = (sequence: number, seconds: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"], session = "s1") => {
    const value = event(sequence, "tool", { ...attributes, sessionId: session }, phase);
    return { ...value, nativeTime: { status: "known" as const, value: new Date(Date.UTC(2026, 9, 4, 0, 0, seconds)).toISOString() } };
  };
  const operation = (id: string, events: UniformEvent[], failed: boolean): OccurrenceOperation => ({ id, events, toolName: "Bash", inputDigest: `sha256:${id}`, failed });
  const failing = operation("a", [at(1, 1, { toolName: "Bash" }, "before"), at(4, 4, { toolName: "Bash", isError: true }, "after")], true);
  const parallel = operation("b", [at(2, 2, { toolName: "Bash" }, "before"), at(5, 5, { toolName: "Bash", isError: false }, "after")], false);
  const otherSession = operation("c", [at(6, 6, { toolName: "Bash" }, "before", "s2"), at(7, 7, { toolName: "Bash", isError: false }, "after", "s2")], false);
  const response = operation("d", [at(8, 8, { toolName: "Bash" }, "before"), at(9, 9, { toolName: "Bash", isError: false }, "after")], false);
  const operations = [failing, parallel, otherSession, response];
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: operations.flatMap(({ events }) => events), operations, toolCapability: capability,
    delegationCapability: capability, isCompaction: () => false, resolveContent: () => undefined,
  });
  const [chain] = occurrences.filter(({ type }) => type === "failure-response");
  assert.deepEqual(chain!.eventIds, ["event-1", "event-4", "event-8", "event-9"], "the running parallel call and the other session's call are not responses");
  assert.equal(chain!.attributes.lastFailureEventId, "event-4");
  assert.equal(chain!.attributes.responseEventId, "event-8");
});

test("a partial compaction stays separate and spans use parsed timestamps", () => {
  const compaction = (sequence: number, hook: string, time: string) => ({ ...event(sequence, "context", { hook }), nativeTime: { status: "known" as const, value: time } });
  const firstStart = compaction(1, "PreCompact", "2026-01-01T07:00:00Z");
  const message = { ...event(2, "message", {}), nativeTime: { status: "known" as const, value: "2026-01-01T07:30:00Z" } };
  const secondStart = compaction(3, "PreCompact", "2026-01-01T10:00:00+02:00");
  const secondEnd = compaction(4, "PostCompact", "2026-01-01T09:00:00Z");
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: [firstStart, message, secondStart, secondEnd], operations: [], toolCapability: capability,
    delegationCapability: capability, isCompaction: ({ family }) => family === "context", resolveContent: () => undefined,
  });
  const compactions = occurrences.filter(({ type }) => type === "compaction");
  assert.deepEqual(compactions.map(({ eventIds }) => eventIds), [["event-1"], ["event-3", "event-4"]]);
  assert.ok(compactions.every(({ rule }) => rule.heuristic), "grouping by adjacency is labeled heuristic");
  assert.deepEqual(compactions[1]!.span, { start: "2026-01-01T10:00:00+02:00", end: "2026-01-01T09:00:00Z" }, "10:00+02:00 is 08:00Z, before 09:00Z");
});

test("failure chains form within their own session, and failed edits are not source changes", () => {
  const at = (sequence: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"], session: string) =>
    event(sequence, "tool", { ...attributes, sessionId: session }, phase);
  const operation = (id: string, toolName: string, events: UniformEvent[], failed: boolean): OccurrenceOperation => ({ id, events, toolName, inputDigest: `sha256:${id}`, failed });
  const firstFailure = operation("a", "Bash", [at(1, { toolName: "Bash" }, "before", "s1"), at(2, { toolName: "Bash", isError: true }, "after", "s1")], true);
  const otherSession = operation("b", "Bash", [at(3, { toolName: "Bash" }, "before", "s2"), at(4, { toolName: "Bash", isError: false }, "after", "s2")], false);
  const secondFailure = operation("c", "Bash", [at(5, { toolName: "Bash" }, "before", "s1"), at(6, { toolName: "Bash", isError: true }, "after", "s1")], true);
  const recovery = operation("d", "Bash", [at(7, { toolName: "Bash" }, "before", "s1"), at(8, { toolName: "Bash", isError: false }, "after", "s1")], false);
  const failedEdit = operation("e", "Edit", [at(9, { toolName: "Edit" }, "before", "s1"), at(10, { toolName: "Edit", isError: true }, "after", "s1")], true);
  const operations = [firstFailure, otherSession, secondFailure, recovery, failedEdit];
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: operations.flatMap(({ events }) => events), operations, toolCapability: capability,
    delegationCapability: capability, isCompaction: () => false, resolveContent: () => undefined,
  });
  const chains = occurrences.filter(({ type, attributes }) => type === "failure-response" && attributes.toolName === "Bash");
  assert.deepEqual(chains.map(({ eventIds, attributes }) => [eventIds, attributes.failures]),
    [[["event-1", "event-2", "event-5", "event-6", "event-7", "event-8"], 2]], "the other session's call does not split the chain");
  assert.equal(occurrences.some(({ type }) => type === "source-change"), false, "a failed edit is an attempt, not a change");
});

test("inferred changes need native success, partitions use the resolved scope, DeepSeek compaction kinds differ", () => {
  const tool = (sequence: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"]) => ({ ...event(sequence, "tool", attributes, phase), scope: { kind: "operation" as const, id: `op-${sequence}` } });
  const operation = (id: string, toolName: string, events: UniformEvent[], failed: boolean, scope?: string): OccurrenceOperation =>
    ({ id, events, toolName, inputDigest: `sha256:${id}`, failed, ...(scope === undefined ? {} : { scope }) });
  // Agent SDK tool events carry no sessionId; the resolved scope separates the main agent from a subagent.
  const mainFailure = operation("a", "Bash", [tool(1, { toolName: "Bash" }, "before"), tool(2, { toolName: "Bash", isError: true }, "after")], true, "main");
  const subagentFailure = operation("b", "Bash", [tool(3, { toolName: "Bash" }, "before"), tool(4, { toolName: "Bash", isError: true }, "after")], true, "subagent");
  const interruptedEdit = operation("c", "Edit", [tool(5, { toolName: "Edit" }, "before")], false, "main");
  const hookConfirmedEdit = operation("d", "Edit", [tool(6, { toolName: "Edit" }, "before"), tool(7, { toolName: "Edit", hook: "PostToolUse" }, "after")], false, "main");
  const compaction = (sequence: number, eventType: string) => ({ ...event(sequence, "context", { eventType }), source: { ...event(sequence, "context").source, nativeType: "session.event" } });
  const operations = [mainFailure, subagentFailure, interruptedEdit, hookConfirmedEdit];
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: [...operations.flatMap(({ events }) => events), compaction(20, "compaction/start"), compaction(21, "compaction/end")],
    operations, toolCapability: capability, delegationCapability: capability, isCompaction: ({ family }) => family === "context", resolveContent: () => undefined,
  });
  const of = (type: string) => occurrences.filter((occurrence) => occurrence.type === type);
  assert.deepEqual(of("failure-response").map(({ attributes }) => attributes.failures), [1, 1], "main-agent and subagent failures are separate chains");
  assert.deepEqual(of("source-change").map(({ eventIds }) => eventIds), [["event-6", "event-7"]], "an unfinished edit is not a change; a PostToolUse-confirmed one is");
  assert.deepEqual(of("compaction").map(({ eventIds }) => eventIds), [["event-20", "event-21"]], "start and end of one DeepSeek compaction form one boundary");
});
