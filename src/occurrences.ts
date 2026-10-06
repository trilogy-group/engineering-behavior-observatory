import type { AdapterCapability, NativeEvidenceReference, UniformAttributeValue, UniformEvent } from "./uniform-events.js";

/**
 * Instance-level occurrences: one failure and the response to it, one validation run, one source change, one
 * repeated operation, one compaction, one delegation. Each cites exactly its own events. Rules that read command
 * text are labeled heuristic.
 */
export const OCCURRENCE_RULES_VERSION = "1.0.0";
export const OCCURRENCE_TYPES = ["failure-response", "validation-run", "source-change", "repeated-operation", "compaction", "delegation"] as const;
export type OccurrenceType = typeof OCCURRENCE_TYPES[number];

export type Occurrence = {
  schemaVersion: "ebo.occurrence/v1";
  id: string;
  type: OccurrenceType;
  rule: { id: string; version: typeof OCCURRENCE_RULES_VERSION; heuristic: boolean };
  eventIds: string[];
  citations: NativeEvidenceReference[];
  attributes: Record<string, UniformAttributeValue>;
  span: { start?: string; end?: string };
};

export type OccurrenceCoverage =
  | { type: OccurrenceType; status: "available"; count: number }
  | { type: OccurrenceType; status: "unavailable"; reason: string };

export type OccurrenceOperation = {
  id: string;
  events: readonly UniformEvent[];
  toolName?: string;
  inputDigest?: string;
  failed: boolean;
};

export type OccurrenceInput = {
  attemptId: string;
  events: readonly UniformEvent[];
  operations: readonly OccurrenceOperation[];
  toolCapability: AdapterCapability;
  delegationCapability: AdapterCapability;
  isCompaction: (event: UniformEvent) => boolean;
  /** Resolves a native content reference; undefined when the retained capture is not available. */
  resolveContent?: (reference: NativeEvidenceReference) => unknown;
};

const VALIDATION_KINDS = new Set(["test", "typecheck", "lint", "build"]);
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "str_replace", "str_replace_editor", "create",
  "write_file", "edit_file", "notebookedit", "patch", "filechange"]);

export function extractOccurrences(input: OccurrenceInput): { occurrences: Occurrence[]; coverage: OccurrenceCoverage[] } {
  const operations = [...input.operations].map((operation) => ({ ...operation, events: ordered(operation.events) }))
    .sort((left, right) => compareEvents(left.events[0]!, right.events[0]!));
  const details = new Map(operations.map((operation) => [operation.id, describe(operation, input.resolveContent)]));
  const eventsById = new Map(operations.flatMap(({ events }) => events.map((event) => [event.id, event] as const)));
  const occurrences: Occurrence[] = [];
  const add = (type: OccurrenceType, heuristic: boolean, events: readonly UniformEvent[], attributes: Record<string, UniformAttributeValue | undefined>) => {
    const sorted = ordered(uniqueEvents(events));
    const times = sorted.flatMap(({ nativeTime }) => nativeTime.status === "known" && Number.isFinite(Date.parse(nativeTime.value)) ? [nativeTime.value] : [])
      .sort((left, right) => Date.parse(left) - Date.parse(right));
    occurrences.push({
      schemaVersion: "ebo.occurrence/v1",
      id: `${input.attemptId}/occ/${type}/${sorted[0]!.id}`,
      type,
      rule: { id: type, version: OCCURRENCE_RULES_VERSION, heuristic },
      eventIds: sorted.map(({ id }) => id),
      citations: uniqueReferences(sorted.map(({ source }) => source.nativeReference)),
      attributes: Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, UniformAttributeValue] => entry[1] !== undefined)),
      span: { ...(times[0] === undefined ? {} : { start: times[0] }), ...(times.at(-1) === undefined ? {} : { end: times.at(-1) }) },
    });
  };

  // Within each session and order domain: consecutive failures of one tool, then the next operation of that tool
  // that starts after the last failure ended (a parallel call that was already running is not a response).
  const scopes = new Map<string, typeof operations>();
  for (const operation of operations) scopes.set(operationScope(operation), [...scopes.get(operationScope(operation)) ?? [], operation]);
  for (const scoped of scopes.values()) {
    for (let index = 0; index < scoped.length;) {
      const first = scoped[index]!;
      if (!first.failed) { index += 1; continue; }
      let end = index;
      while (end < scoped.length && scoped[end]!.failed && scoped[end]!.toolName === first.toolName) end += 1;
      const failures = scoped.slice(index, end);
      const failedAt = failures.flatMap(({ events }) => events).sort(compareEvents).at(-1)!;
      const next = scoped.slice(end).find((operation) => operation.toolName === first.toolName && compareEvents(operation.events[0]!, failedAt) > 0);
      add("failure-response", false, [...failures, ...(next === undefined ? [] : [next])].flatMap(({ events }) => events), {
        toolName: first.toolName, failures: failures.length,
        nextOutcome: next === undefined ? "none" : details.get(next.id)!.result,
      });
      index = end;
    }
  }
  occurrences.sort((left, right) => compareEvents(eventsById.get(left.eventIds[0]!)!, eventsById.get(right.eventIds[0]!)!));

  const seen = new Map<string, OccurrenceOperation>();
  for (const operation of operations) {
    const detail = details.get(operation.id)!;
    const validation = detail.checkKinds.filter((kind) => VALIDATION_KINDS.has(kind));
    if (validation.length > 0) {
      add("validation-run", true, operation.events, {
        toolName: operation.toolName, checkKinds: limited(detail.checkKinds), result: detail.result,
        reportedExitCode: reportedExitCode(operation, input.resolveContent), outputRedirected: detail.outputRedirected,
      });
    }
    if (detail.change !== undefined) {
      add("source-change", detail.change !== "explicit-mutation", operation.events, {
        toolName: operation.toolName, detectedBy: detail.change, paths: limited(detail.writes),
      });
    }
    if (operation.toolName !== undefined && operation.inputDigest !== undefined) {
      const signature = JSON.stringify([operation.toolName, operation.inputDigest]);
      const earlier = seen.get(signature);
      if (earlier === undefined) seen.set(signature, operation);
      else add("repeated-operation", false, operation.events, { toolName: operation.toolName, firstEventId: earlier.events[0]!.id });
    }
  }

  // Explicit mutation records outside tool operations (Codex fileChange items, file-change hooks).
  const changed = new Set(occurrences.filter(({ type }) => type === "source-change").flatMap(({ eventIds }) => eventIds));
  const operationEvents = new Set(operations.flatMap(({ events }) => events.map(({ id }) => id)));
  for (const event of ordered(input.events.filter(({ id, attributes }) => attributes.mutation === true && !changed.has(id) && !operationEvents.has(id)))) {
    add("source-change", false, [event], { toolName: text(event.attributes.toolName) ?? text(event.attributes.itemType) ?? text(event.attributes.hook), detectedBy: "explicit-mutation" });
  }

  // Records of one compaction live in different native records (hooks, session markers, stream start/end) with no
  // shared identity. Adjacent records form one boundary until a tool event or a non-harness message intervenes or a
  // record kind repeats, so a partial boundary stays on its own instead of borrowing another boundary's records.
  let boundary: UniformEvent[] = [];
  const closeBoundary = () => {
    if (boundary.length > 0) add("compaction", true, boundary, { records: boundary.length, grouping: "adjacent-records" });
    boundary = [];
  };
  const compactionKind = (event: UniformEvent) => `${event.source.nativeType}:${String(event.attributes.hook ?? event.attributes.subtype ?? event.attributes.lifecycle ?? "")}`;
  for (const event of ordered(input.events)) {
    if (input.isCompaction(event)) {
      if (boundary.some((part) => compactionKind(part) === compactionKind(event))) closeBoundary();
      boundary.push(event);
    // Harness-authored messages (the continuation summary a compaction writes) belong to the boundary.
    } else if (event.family === "tool" || event.family === "message" && event.actor.kind !== "harness") closeBoundary();
  }
  closeBoundary();

  const delegationAvailable = input.delegationCapability.status !== "unsupported";
  if (delegationAvailable) {
    const groups = new Map<string, UniformEvent[]>();
    for (const event of ordered(input.events.filter(({ family }) => family === "delegation"))) {
      const key = text(event.attributes.taskId) ?? text(event.attributes.agentId)
        ?? (event.scope.kind === "operation" ? text(event.scope.id) : undefined) ?? `event:${event.id}`;
      groups.set(key, [...groups.get(key) ?? [], event]);
    }
    for (const [key, events] of groups) {
      add("delegation", false, events, { taskId: key.startsWith("event:") ? undefined : key, records: events.length });
    }
  }

  const count = (type: OccurrenceType) => occurrences.filter((occurrence) => occurrence.type === type).length;
  const toolReason = input.toolCapability.status === "unsupported"
    ? input.toolCapability.detail ?? "The adapter does not expose tool operations." : undefined;
  const contentReason = input.resolveContent === undefined ? "Native tool content is not available to classify commands." : undefined;
  const coverage: OccurrenceCoverage[] = OCCURRENCE_TYPES.map((type) => {
    const reason = type === "delegation" && !delegationAvailable
      ? input.delegationCapability.detail ?? "The adapter does not expose delegation."
      : ["failure-response", "repeated-operation"].includes(type) ? toolReason
        : ["validation-run", "source-change"].includes(type) ? toolReason ?? contentReason : undefined;
    return reason === undefined ? { type, status: "available", count: count(type) } : { type, status: "unavailable", reason };
  });
  const unavailable = new Set(coverage.filter(({ status }) => status === "unavailable").map(({ type }) => type));
  return { occurrences: occurrences.filter(({ type }) => !unavailable.has(type)), coverage };
}

type OperationDetail = {
  checkKinds: string[];
  writes: string[];
  outputRedirected?: boolean;
  change?: "explicit-mutation" | "edit-tool" | "shell-write";
  result: "passed" | "failed" | "unknown";
};

function describe(operation: OccurrenceOperation, resolveContent: OccurrenceInput["resolveContent"]): OperationDetail {
  const command = resolveContent === undefined ? undefined : operation.events.flatMap((event) =>
    event.content.status === "known" ? event.content.value.map(({ nativeReference }) => nativeReference) : [])
    .map((reference) => findCommand(resolveContent(reference))).find((value) => value !== undefined);
  const checkKinds = command === undefined ? [] : checkKindsOf(command);
  const writes = command === undefined ? [] : shellWrites(command);
  const explicitMutation = operation.events.some(({ attributes }) => attributes.mutation === true);
  const editTool = EDIT_TOOLS.has((operation.toolName ?? "").toLowerCase());
  const passed = operation.events.some(({ attributes }) => attributes.isError === false || attributes.status === "completed"
    || attributes.exitCode === 0);
  const exited = operation.events.some(({ attributes }) => typeof attributes.exitCode === "number" && attributes.exitCode !== 0);
  return {
    checkKinds,
    writes,
    ...(command === undefined || checkKinds.length === 0 ? {} : { outputRedirected: /(?<![0-9&])>\s*[^\s&]/u.test(unwrap(command)) }),
    // A failed edit or shell write is an attempt, not an observed change.
    ...(explicitMutation ? { change: "explicit-mutation" as const } : operation.failed || exited ? {}
      : editTool ? { change: "edit-tool" as const } : writes.length > 0 ? { change: "shell-write" as const } : {}),
    result: operation.failed || exited ? "failed" : passed ? "passed" : "unknown",
  };
}

const EXIT_TEXT = /(?:Exit code|Process exited with code|exit status|exited with code|command failed with exit code)\s*[:=]?\s*(-?\d+)/giu;

/**
 * The last exit code the tool output reports. A check inside a pipeline (`pnpm test | tail`) can fail while the
 * tool call itself succeeds; its output still says so. Read from text, so validation runs are heuristic.
 */
function reportedExitCode(operation: OccurrenceOperation, resolveContent: OccurrenceInput["resolveContent"]): number | undefined {
  if (resolveContent === undefined) return undefined;
  for (const event of [...operation.events].reverse()) {
    if (event.phase !== "after" || event.content.status !== "known") continue;
    for (const { nativeReference } of event.content.value) {
      const content = resolveContent(nativeReference);
      if (content === undefined) continue;
      const matches = [...(typeof content === "string" ? content : JSON.stringify(content)).matchAll(EXIT_TEXT)];
      const code = matches.length === 0 ? undefined : Number(matches.at(-1)![1]);
      if (code !== undefined && Number.isSafeInteger(code)) return code;
    }
  }
  return undefined;
}

/** The shell command of a tool call: a `command`/`cmd` field, looking inside JSON-encoded argument strings. */
export function findCommand(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["command", "cmd"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    if (Array.isArray(candidate) && candidate.length > 0 && candidate.every((part) => typeof part === "string")) return candidate.join(" ");
  }
  for (const [key, nested] of Object.entries(record)) {
    if (["content", "output", "result", "aggregatedOutput", "tool_response", "stdout", "stderr"].includes(key)) continue;
    const parsed = typeof nested === "string" && ["arguments", "args", "input"].includes(key) && nested.trimStart().startsWith("{")
      ? parseJson(nested) : nested;
    const found = findCommand(parsed, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Per-segment command analysis (lab units v0.3): every check a command runs, by the program of each segment.
const SEGMENT_SPLIT = /&&|\|\||;|\n|\|/u;
const ENV_ASSIGN = /^[A-Z_][A-Z0-9_]*=\S*$/u;
const PACKAGE_RUNNERS = new Set(["pnpm", "npm", "yarn", "npx", "bun", "corepack", "pnpx"]);
const SOURCE_EXTENSION = "(?:tsx?|jsx?|mjs|cjs|css|scss|json|md|py|ya?ml|toml|html|svg)";
const SOURCE_PATH = new RegExp(`(?<![\\w.])((?:\\.{0,2}/)?[\\w@.-]+(?:/[\\w@.\\[\\]()-]+)+\\.${SOURCE_EXTENSION})\\b`, "gu");
const IGNORED_PATH = /(^|\/)(tmp|node_modules|\.cache|coverage|dist|build|\.git)\/|jest-cache/u;
const WRITE_SIGNAL = /writeFileSync|appendFileSync|fs\.write|\.write_text\(|open\([^)]*,\s*['"][wa]|\bsed\s+-i|\bperl\s+-\w*i|\bapply_patch\b|\*\*\* (?:Update|Add|Delete) File:|\btee\b|cat\s*>|>\s*[\w./~-]|\bcp\b|\bmv\b|\brm\b/u;

export function unwrap(command: string): string {
  const trimmed = command.trim();
  return /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/u.exec(trimmed)?.[2] ?? trimmed;
}

function segments(command: string): string[][] {
  return unwrap(command).split(SEGMENT_SPLIT).flatMap((segment) => {
    let tokens = segment.trim().split(/\s+/u).filter(Boolean);
    while (tokens.length > 0 && (ENV_ASSIGN.test(tokens[0]!) || ["env", "time", "exec", "timeout", "sudo"].includes(tokens[0]!) || /^\d+[smh]?$/u.test(tokens[0]!))) tokens = tokens.slice(1);
    return tokens.length === 0 || tokens[0] === "cd" ? [] : [tokens];
  });
}

export function checkKindsOf(command: string): string[] {
  const kinds: string[] = [];
  for (const tokens of segments(command)) {
    const program = tokens[0]!.split("/").at(-1)!;
    const words: string[] = [];
    if (["tsc", "vue-tsc", "mypy", "pyright"].includes(program)) words.push("typecheck");
    else if (["eslint", "biome", "ruff", "stylelint"].includes(program)) words.push("lint");
    else if (["prettier", "black", "gofmt"].includes(program)) words.push("format");
    else if (["jest", "vitest", "mocha", "pytest", "playwright"].includes(program)) words.push("test");
    else if (["cargo", "go"].includes(program) && tokens[1] === "test") words.push("test");
    else if (PACKAGE_RUNNERS.has(program) || ["expo", "deno", "turbo", "nx"].includes(program)) {
      const args = tokens.slice(1, 7).filter((token) => !token.startsWith("-")).join(" ").toLowerCase();
      if (/\b(tsc|typecheck|type-check|check-types)\b/u.test(args)) words.push("typecheck");
      if (/\b(eslint|lint|design[-:]?lint)\b/u.test(args)) words.push("lint");
      if (/\b(jest|vitest|test(:\w+)?|playwright)\b/u.test(args)) words.push("test");
      if (/\b(build|export)\b/u.test(args) && program !== "corepack") words.push("build");
      if (/\b(prettier|format)\b/u.test(args)) words.push("format");
    } else if (["python", "python3"].includes(program) && /-m\s+pytest/u.test(tokens.slice(1, 3).join(" "))) words.push("test");
    for (const word of words) if (!kinds.includes(word)) kinds.push(word);
  }
  return kinds;
}

/** Source paths a shell command writes: redirects, write calls, in-place edits, cp/mv/rm/tee targets, patch headers. */
export function shellWrites(command: string): string[] {
  const source = unwrap(command);
  if (!WRITE_SIGNAL.test(source)) return [];
  const paths: string[] = [];
  for (const match of source.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/gu)) paths.push(match[1]!);
  for (const match of source.matchAll(/(?<![0-9&<])>>?\s*([^\s;&|]+)/gu)) paths.push(match[1]!.replace(/^['"]|['"]$/gu, ""));
  if (/writeFileSync|appendFileSync|fs\.write|\.write_text\(|open\([^)]*,\s*['"][wa]/u.test(source)) {
    for (const match of source.matchAll(/(?:writeFileSync|appendFileSync)\(\s*['"]([^'"]+)/gu)) paths.push(match[1]!);
    if (!paths.some((path) => new RegExp(`\\.${SOURCE_EXTENSION}$`, "u").test(path))) {
      paths.push(...[...source.matchAll(SOURCE_PATH)].map((match) => match[1]!).slice(0, 3));
    }
  }
  for (const tokens of segments(source)) {
    const program = tokens[0]!.split("/").at(-1)!;
    if (["sed", "perl"].includes(program) && tokens.slice(1).some((token) => token.startsWith("-i") || program === "perl" && token.startsWith("-") && token.includes("i"))) {
      paths.push(...tokens.slice(1).filter((token) => new RegExp(SOURCE_PATH.source, "u").test(token)).map(stripQuotes));
    }
    if (["cp", "mv", "tee"].includes(program) && tokens.length > 1) paths.push(stripQuotes(tokens.at(-1)!));
    if (program === "rm") paths.push(...tokens.slice(1).filter((token) => !token.startsWith("-")).map(stripQuotes));
  }
  return [...new Set(paths.filter((path) => new RegExp(`\\.${SOURCE_EXTENSION}$`, "u").test(path) && !IGNORED_PATH.test(path)))];
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/gu, "");
}

/** Session and native-order domain of an operation's first event. */
function operationScope(operation: OccurrenceOperation): string {
  const first = operation.events[0]!;
  const session = text(first.attributes.sessionId) ?? (first.scope.kind === "session" ? text(first.scope.id) : undefined) ?? "";
  return JSON.stringify([session, first.nativeOrder.status === "known" ? first.nativeOrder.domain : ""]);
}

function ordered(events: readonly UniformEvent[]): UniformEvent[] {
  return [...events].sort(compareEvents);
}

function compareEvents(left: UniformEvent, right: UniformEvent): number {
  const leftTime = left.nativeTime.status === "known" ? Date.parse(left.nativeTime.value) : Number.POSITIVE_INFINITY;
  const rightTime = right.nativeTime.status === "known" ? Date.parse(right.nativeTime.value) : Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  const leftOrder = left.nativeOrder.status === "known" ? left.nativeOrder.value : Number.POSITIVE_INFINITY;
  const rightOrder = right.nativeOrder.status === "known" ? right.nativeOrder.value : Number.POSITIVE_INFINITY;
  return leftOrder === rightOrder ? left.id.localeCompare(right.id) : leftOrder < rightOrder ? -1 : 1;
}

function uniqueEvents(events: readonly UniformEvent[]): UniformEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function uniqueReferences(references: readonly NativeEvidenceReference[]): NativeEvidenceReference[] {
  return [...new Map(references.map((reference) => [JSON.stringify([reference.artifactId, reference.recordLocator]), reference])).values()]
    .map((reference) => ({ ...reference }));
}

/** Attribute lists hold at most 16 values; longer lists are omitted rather than cut. */
function limited(values: readonly string[]): readonly string[] | undefined {
  return values.length > 0 && values.length <= 16 && values.every((value) => [...value].length <= 512) ? [...values] : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}
