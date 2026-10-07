import { checkKindsOf, findCommand, shellWrites, unwrap, type Occurrence } from "./occurrences.js";
import { toolOperations, type ToolOperation } from "./structural-observations.js";
import type { NativeEvidenceReference, UniformEvent } from "./uniform-events.js";

/**
 * Behavior units (units 1.0.0): the comparable steps of an attempt that the Atlas cloud, swimlanes and evidence drawer
 * share. A tool unit is one EBO tool operation (call, result and hooks, paired by EBO's harness-aware rules); a message
 * unit is one completed visible message; compaction and delegation units are EBO occurrences; an episode is a message
 * plus the tool units that follow it. Unit ids are `<attemptId>/<first event id>`, stable across builds. Occurrence tags
 * are the EBO occurrences a unit's events belong to. Command classification (tool kind, command head, check kinds,
 * writes) reads command text and is heuristic, as in occurrences.
 */
export const ATLAS_UNITS_VERSION = "1.0.0";

export type AtlasUnit = {
  unit_id: string; attempt_id: string; seq: number; unit_kind: "message" | "tool" | "compaction" | "delegation" | "episode";
  subkind: string | null; role: string | null; episode_id: string | null; tool_name: string | null; tool_kind: string | null;
  command: string | null; command_head: string | null; check_kind: string | null; check_kinds: string[]; writes: string[]; target: string | null;
  status: string | null; exit_code: number | null; duration_seconds: number | null; input_chars: number | null; output_chars: number | null;
  output_lines: number | null; lines_added: number | null; lines_removed: number | null; error_signature: string | null;
  tool_count: number | null; error_count: number | null; t_start: string | null; t_end: string | null; event_count: number;
  first_event_key: string; occurrences: string[]; embed: boolean; embed_text: string; embed_chars: number;
};
export type AtlasUnitEvent = { unit_id: string; event_key: string; part: string };

const MESSAGE_CHARS = 1200, EPISODE_MESSAGE_CHARS = 600, SUMMARY_CHARS = 1500;   // embedding input only; stored text is complete
const SHELL = new Set(["bash", "shell", "exec_command", "commandexecution", "run_terminal_cmd", "execute", "terminal", "bashoutput", "killshell"]);
const READ = new Set(["read", "view", "read_file", "cat", "open_file", "notebookread"]);
const EDIT = new Set(["edit", "write", "multiedit", "apply_patch", "str_replace", "str_replace_editor", "create", "write_file", "edit_file", "notebookedit", "patch", "filechange"]);
const SEARCH = new Set(["glob", "grep", "find", "search", "ls", "list", "list_dir", "codebase_search", "file_search", "rg"]);
const WEB = new Set(["webfetch", "websearch", "fetch", "web_search", "browse"]);
const DELEGATE = new Set(["task", "agent", "subagent", "spawn_agent", "dispatch_agent"]);
const PLAN = new Set(["todowrite", "todo", "todo_write", "update_plan", "plan"]);
const INSPECT = new Set(["ls", "cat", "head", "tail", "sed", "rg", "grep", "find", "wc", "tree", "stat", "file", "nl", "awk", "jq", "du", "echo", "printf", "diff"]);

export function toolKind(name: string | undefined | null): string {
  const n = (name ?? "").toLowerCase();
  return SHELL.has(n) ? "shell" : READ.has(n) ? "read" : EDIT.has(n) ? "edit" : SEARCH.has(n) ? "search" : WEB.has(n) ? "web"
    : DELEGATE.has(n) ? "delegate" : PLAN.has(n) ? "plan" : "other";
}

/** The program and subcommand a shell command starts with (wrappers, cd, env assignments and flags removed). */
export function commandHead(command: string): { head: string; segments: number } {
  const segs = unwrap(command).split(/&&|\|\||;|\n/u).map((s) => s.trim()).filter(Boolean);
  const kept = segs.filter((s) => !/^(cd|export|set|source|\.)\b/u.test(s) && !/^\w+=\S*$/u.test(s));
  let first = (kept.length ? kept : segs)[0] ?? "";
  first = first.replace(/^(?:\w+=\S+\s+)+/u, "").replace(/^(?:timeout\s+\S+\s+|time\s+|sudo\s+)/u, "");
  const block = /^(for|while|until|if)\b/u.exec(first);
  if (block) return { head: `${block[1]!}-block`, segments: segs.length };
  let tokens = first.split(/\s+/u).filter(Boolean);
  if (tokens.length) {
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.startsWith("--") && !t.includes("=") && i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-") && ["pnpm", "npm", "yarn", "bun", "npx"].includes(tokens[0]!)) { i += 2; continue; }
      if (t.startsWith("-") && t !== "-m") { i += 1; continue; }
      break;
    }
    tokens = [tokens[0]!, ...tokens.slice(i)];
  }
  if (tokens.length > 2 && ["-m", "exec", "run", "dlx", "x"].includes(tokens[1]!)) return { head: tokens.slice(0, 3).join(" ").slice(0, 60), segments: segs.length };
  const head = tokens.length > 1 && /^[A-Za-z][\w:.-]*$/u.test(tokens[1]!) ? tokens.slice(0, 2).join(" ") : tokens[0] ?? "";
  return { head: head.slice(0, 60), segments: segs.length };
}

/** The first check a command runs, else what its first segment does (vcs, install, inspect, other). */
function primaryCheck(command: string, kinds: string[]): string {
  if (kinds.length) return kinds[0]!;
  const first = commandHead(command).head.split(" ")[0]?.split("/").at(-1) ?? "";
  if (INSPECT.has(first)) return "inspect";
  if (first === "git") return "vcs";
  if (/^(pnpm|npm|yarn|bun) (i|install|add)\b/u.test(commandHead(command).head) || /\bpip install\b/u.test(command)) return "install";
  return "other";
}

const MASKS: Array<[RegExp, string]> = [[/(?:[A-Za-z]:)?(?:\/[\w.@+-]+){2,}\/?/gu, "<path>"], [/\b[0-9a-f]{8,}\b/giu, "<hex>"], [/\b\d+(?:\.\d+)?\b/gu, "<n>"]];
const ERROR_LINE = /(error|failed|failure|fail\b|exception|traceback|cannot|not found|denied|refused|timed out|✗|✕)/iu;
/** The first error line of a failed call's output, with paths, hex ids and numbers masked, so similar failures group. */
export function errorSignature(text: string): string | null {
  for (const line of text.slice(0, 6000).split(/\r?\n/u)) {
    if (!ERROR_LINE.test(line)) continue;
    let s = line.trim();
    for (const [pattern, replacement] of MASKS) s = s.replace(pattern, replacement);
    return s.slice(0, 140);
  }
  return null;
}

function pathHint(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parts = value.replace(/\\/gu, "/").split("/").filter((p) => p && p !== "." && p !== "workspace" && p !== "repo");
  return parts.length ? parts.slice(-3).join("/").slice(0, 120) : null;
}

/** Area and file type of a target, not the file itself: `src/components/*.tsx (test)`. */
function targetClass(target: string | null): string | null {
  if (!target) return null;
  const parts = target.split("/"), name = parts.at(-1)!;
  const ext = name.includes(".") && !name.startsWith(".") ? `*.${name.split(".").at(-1)!}` : parts.length === 1 ? name : "*";
  const area = parts.slice(0, -1).slice(-2).join("/") || ".";
  return `${area}/${ext}${/(\.|_|-)(test|spec)\.|__tests__|\/tests?\//u.test(target) ? " (test)" : ""}`;
}

function findKey(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) { for (const item of value) { const r = findKey(item, keys, depth + 1); if (r !== undefined) return r; } return undefined; }
  for (const [k, v] of Object.entries(value)) if (keys.includes(k) && v !== null && v !== "") return v;
  for (const v of Object.values(value)) { const r = findKey(v, keys, depth + 1); if (r !== undefined) return r; }
  return undefined;
}

/** Visible text of a message: `text` blocks and plain strings; hidden reasoning and tool results are skipped. */
export function visibleText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (typeof value === "string") { if (depth === 0) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) visibleText(v, out, depth + 1); return out; }
  if (value === null || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  if (["thinking", "redacted_thinking", "reasoning", "tool_result", "tool-result", "tool_use", "toolCall"].includes(String(record.type)) || record.channel === "analysis") return out;
  if ((record.type === "text" || record.type === "agentMessage" || record.type === "userMessage") && typeof record.text === "string") { out.push(record.text); return out; }
  for (const [key, v] of Object.entries(record)) if (!["signature", "encrypted_content", "encryptedContent", "thinking"].includes(key)) visibleText(v, out, depth + 1);
  return out;
}

/** Human-readable text of a tool result: every string leaf except identifiers and signatures, one per line. */
export function resultText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) resultText(v, out, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!["signature", "id", "toolCallId", "tool_use_id", "callId"].includes(k)) resultText(v, out, depth + 1);
  }
  return out;
}

function editLines(input: unknown): { added: number; removed: number } {
  let added = 0, removed = 0;
  const walk = (o: unknown, depth = 0): void => {
    if (depth > 8 || o === null || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach((v) => walk(v, depth + 1)); return; }
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (typeof v !== "string") { walk(v, depth + 1); continue; }
      if (/old|search|original|before/u.test(key)) removed += v.split("\n").length;
      else if (/new|content|replacement|after|patch|text/u.test(key)) {
        if (key === "patch" || v.trimStart().startsWith("*** Begin Patch")) {
          for (const line of v.split("\n")) { if (line.startsWith("+") && !line.startsWith("+++")) added++; else if (line.startsWith("-") && !line.startsWith("---")) removed++; }
        } else added += v.split("\n").length;
      }
    }
  };
  walk(input);
  return { added, removed };
}

const nativeEventType = (event: UniformEvent) => {
  const a = event.attributes;
  return [a.eventType, a.itemType, a.method].find((v): v is string => typeof v === "string") ?? event.source.nativeType;
};

/**
 * The record that carries one completed message, per harness: streaming chunks, start records and duplicate stream
 * copies are not messages. Returns the message role, or undefined when the event is not a message record.
 */
function messageRole(event: UniformEvent): string | undefined {
  const type = nativeEventType(event);
  const role = typeof event.attributes.role === "string" ? event.attributes.role : undefined;
  switch (event.source.harness) {
    case "codex-app-server": return type === "agentMessage" ? "agent" : type === "userMessage" ? "user" : undefined;
    case "deepseek-harness": return type === "assistant/message" ? "assistant" : type === "user/message" ? "user" : undefined;
    case "pi-sdk": return event.source.nativeType === "history:message" && (role === "user" || role === "assistant") ? role : undefined;
    case "claude-agent-sdk":
      if (type === "assistant" && event.actor.kind === "model") return "assistant";
      if (type === "user" && event.actor.kind === "harness") return "harness";
      return type === "UserPromptSubmit" ? "user" : undefined;
    default:
      if (event.phase === "before" || event.phase === "during" || /chunk|delta|start/u.test(type)) return undefined;
      return role === "user" || role === "assistant" || role === "agent" ? role : event.actor.kind === "user" ? "user" : event.actor.kind === "model" || event.actor.kind === "agent" ? "assistant" : undefined;
  }
}

const time = (event: UniformEvent) => (event.nativeTime.status === "known" ? event.nativeTime.value : null);
const seconds = (a: string | null, b: string | null) => (a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) ? (Date.parse(b) - Date.parse(a)) / 1000 : null);
const EXIT_TEXT = /(?:Exit code|Process exited with code|exit status|exited with code|command failed)\s*[:=]?\s*(-?\d+)/iu;

export type UnitInput = {
  attemptId: string;
  events: readonly UniformEvent[];
  occurrences: readonly Occurrence[];
  resolveContent: (reference: NativeEvidenceReference) => unknown;
};

/** Derive one attempt's units and their event links. */
export function deriveUnits({ attemptId, events, occurrences, resolveContent }: UnitInput): { units: AtlasUnit[]; links: AtlasUnitEvent[] } {
  const index = new Map(events.map((event, i) => [event.id, i]));
  const contentOf = (event: UniformEvent) => (event.content.status === "known" ? event.content.value.map(({ nativeReference }) => resolveContent(nativeReference)).filter((v) => v !== undefined) : []);
  const occurrenceTags = new Map<string, Set<string>>();
  for (const occurrence of occurrences) for (const id of occurrence.eventIds) {
    const tags = occurrenceTags.get(id) ?? new Set<string>();
    tags.add(occurrence.type);
    occurrenceTags.set(id, tags);
  }
  type Draft = Omit<AtlasUnit, "seq" | "episode_id" | "embed" | "embed_text" | "embed_chars" | "first_event_key" | "event_count" | "occurrences"> & { first: number; eventParts: Array<[string, string]> };
  const blank = (kind: AtlasUnit["unit_kind"], first: UniformEvent): Draft => ({
    unit_id: `${attemptId}/${first.id}`, attempt_id: attemptId, unit_kind: kind, subkind: null, role: null, tool_name: null, tool_kind: null,
    command: null, command_head: null, check_kind: null, check_kinds: [], writes: [], target: null, status: null, exit_code: null, duration_seconds: null,
    input_chars: null, output_chars: null, output_lines: null, lines_added: null, lines_removed: null, error_signature: null, tool_count: null,
    error_count: null, t_start: time(first), t_end: time(first), first: index.get(first.id)!, eventParts: [],
  });
  const drafts: Draft[] = [];
  const texts = new Map<Draft, string>();   // message text and compaction summaries, for the embedding text
  const claimed = new Set<string>();

  for (const operation of toolOperations(events) as ToolOperation[]) {
    const ordered = [...operation.events].sort((a, b) => index.get(a.id)! - index.get(b.id)!);
    const unit = blank("tool", ordered[0]!);
    const results = ordered.filter(({ phase }) => phase === "after");
    // Content references with a role (Cursor: tool-input, tool-result, tool-error on one whole record) are split by
    // role, each taking its own field of the record; without roles, the call side is input and the result side output.
    const refs = ordered.flatMap((event) => (event.content.status === "known" ? event.content.value.map((ref) => ({ event, ref })) : []));
    const seenRefs = new Set<string>();
    const unique = refs.filter(({ ref }) => { const k = `${ref.nativeReference.artifactId}\0${ref.nativeReference.recordLocator}\0${ref.role ?? ""}`; if (seenRefs.has(k)) return false; seenRefs.add(k); return true; });
    const TOOL_ROLES: Record<string, { input: boolean; field: string }> = { "tool-input": { input: true, field: "args" }, "tool-result": { input: false, field: "result" }, "tool-error": { input: false, field: "result" } };
    const roleOf = (ref: { role?: string }) => (ref.role === undefined ? undefined : TOOL_ROLES[ref.role]);
    const pick = (value: unknown, field: string) => (value !== null && typeof value === "object" && field in value ? (value as Record<string, unknown>)[field] : value);
    const isInput = ({ event, ref }: { event: UniformEvent; ref: { role?: string } }) => roleOf(ref)?.input ?? event.phase !== "after";
    const resolveRef = ({ ref }: { ref: { role?: string; nativeReference: NativeEvidenceReference } }) => {
      const value = resolveContent(ref.nativeReference), role = roleOf(ref);
      return value === undefined || !role ? value : pick(value, role.field);
    };
    const input = unique.filter(isInput).map(resolveRef).filter((v) => v !== undefined);
    const output = unique.filter((x) => !isInput(x)).map(resolveRef).filter((v) => v !== undefined);
    const outputText = output.flatMap((v) => resultText(v)).join("\n");
    unit.tool_name = operation.toolName ?? null;
    unit.tool_kind = toolKind(operation.toolName);
    const command = [...input, ...output].map((v) => findCommand(v)).find((v) => v !== undefined);
    if (command !== undefined && (unit.tool_kind === "shell" || unit.tool_kind === "other")) {
      unit.tool_kind = "shell";
      unit.command = unwrap(command);
      unit.command_head = commandHead(command).head;
      unit.check_kinds = checkKindsOf(command);
      unit.check_kind = primaryCheck(command, unit.check_kinds);
      unit.writes = shellWrites(command);
    } else {
      unit.target = pathHint(findKey(input, ["file_path", "filePath", "path", "file", "target_file", "notebook_path", "pattern", "url", "query"]));
      if (unit.tool_kind === "edit") { const { added, removed } = editLines(input); unit.lines_added = added; unit.lines_removed = removed; }
    }
    const exitCodes = ordered.flatMap(({ attributes }) => (typeof attributes.exitCode === "number" ? [attributes.exitCode] : []));
    const exitText = EXIT_TEXT.exec(outputText.slice(0, 1500));
    unit.exit_code = exitCodes.at(-1) ?? (exitText ? Number(exitText[1]) : null);
    const failed = operation.failed || (unit.exit_code !== null && unit.exit_code !== 0);
    unit.status = results.length || operation.failed ? (failed ? "error" : "ok") : null;
    unit.error_signature = failed ? errorSignature(outputText) : null;
    unit.input_chars = input.length ? JSON.stringify(input).length : null;
    // Output size only when the result content resolved; an unresolved result is unavailable, not empty.
    unit.output_chars = output.length ? outputText.length : null;
    unit.output_lines = output.length ? (outputText ? outputText.split("\n").length : 0) : null;
    unit.t_start = time(ordered[0]!);
    unit.t_end = results.length ? time(results.at(-1)!) : null;
    unit.duration_seconds = seconds(unit.t_start, unit.t_end);
    unit.eventParts = ordered.map((event) => [event.id, event.phase === "after" ? "result" : event.phase === "before" ? "call" : "progress"]);
    ordered.forEach(({ id }) => claimed.add(id));
    drafts.push(unit);
  }

  for (const occurrence of occurrences.filter(({ type }) => type === "compaction" || type === "delegation")) {
    const ordered = occurrence.eventIds.map((id) => events[index.get(id)!]!).filter(Boolean);
    if (!ordered.length) continue;
    const unit = blank(occurrence.type as "compaction" | "delegation", ordered[0]!);
    unit.unit_id = `${attemptId}/${occurrence.type}/${ordered[0]!.id}`;
    unit.subkind = typeof occurrence.attributes.trigger === "string" ? occurrence.attributes.trigger : typeof occurrence.attributes.kind === "string" ? occurrence.attributes.kind : null;
    const summary = ordered.flatMap(contentOf).flatMap((v) => visibleText(v)).find((t) => t.trim().length > 40);
    if (summary) texts.set(unit, summary.trim());
    unit.t_end = time(ordered.at(-1)!);
    unit.eventParts = ordered.map((event) => [event.id, occurrence.type]);
    drafts.push(unit);
  }

  for (const event of events) {
    if (claimed.has(event.id) || (event.family !== "message" && nativeEventType(event) !== "UserPromptSubmit")) continue;
    const role = messageRole(event);
    if (!role) continue;
    const text = contentOf(event).flatMap((v) => visibleText(v)).join("\n").trim();
    // An Agent SDK continuation message opens a compacted session; the compaction unit carries it.
    if (!text || (role === "harness" && text.startsWith("This session is being continued"))) continue;
    const unit = blank("message", event);
    unit.role = role; unit.subkind = role;
    unit.eventParts = [[event.id, "message"]];
    texts.set(unit, text);
    drafts.push(unit);
  }

  // Chronological order: native time when known, else carried forward in dataset order.
  drafts.sort((a, b) => a.first - b.first);
  let carried = "";
  const sortTime = new Map<Draft, string>();
  for (const d of drafts) { const t = d.t_start ?? d.t_end ?? carried; sortTime.set(d, t); carried = t || carried; }
  drafts.sort((a, b) => (sortTime.get(a)! < sortTime.get(b)! ? -1 : sortTime.get(a)! > sortTime.get(b)! ? 1 : a.first - b.first));

  // Episodes: a message plus the tool units that follow it until the next message.
  const episodes: Array<{ lead: Draft; members: Draft[] }> = [];
  for (const d of drafts) {
    if (d.unit_kind === "message" && d.role !== "harness") episodes.push({ lead: d, members: [d] });
    else if ((d.unit_kind === "tool" || d.unit_kind === "compaction") && episodes.length) episodes.at(-1)!.members.push(d);
  }
  const episodeOf = new Map<Draft, string>();
  const episodeUnits: Array<{ draft: Draft; summary: string; members: Draft[] }> = [];
  const VERB: Record<string, string> = { shell: "ran commands", read: "read files", edit: "edited files", search: "searched", plan: "updated the plan", delegate: "delegated subtasks", web: "used the web", other: "used other tools" };
  for (const { lead, members } of episodes) {
    const tools = members.filter((m) => m.unit_kind === "tool");
    if (!tools.length) continue;
    const count = <T>(xs: T[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>())].sort((a, b) => b[1] - a[1]);
    const errors = tools.filter((t) => t.status === "error");
    const parts = count(tools.map((t) => t.tool_kind ?? "other")).map(([k, n]) => `${VERB[k] ?? k}${n > 1 ? ` (${n})` : ""}`);
    const heads = count(tools.flatMap((t) => (t.command_head ? [t.command_head] : [])));
    if (heads.length) parts.push(`commands: ${heads.slice(0, 4).map(([h]) => h).join(", ")}`);
    const checks = count(tools.flatMap((t) => (t.check_kind && !["other", "inspect"].includes(t.check_kind) ? [t.check_kind] : [])));
    if (checks.length) parts.push(`checks: ${checks.map(([k]) => k).join(", ")}`);
    if (errors.length) parts.push(`hit failures${errors[0]!.error_signature ? `: ${errors[0]!.error_signature}` : ""}`);
    const draft: Draft = { ...lead, unit_id: `${attemptId}/episode/${lead.eventParts[0]![0]}`, unit_kind: "episode", t_end: tools.at(-1)!.t_end ?? tools.at(-1)!.t_start,
      status: errors.length ? "error" : "ok", tool_count: tools.length, error_count: errors.length, eventParts: members.flatMap((m) => m.eventParts) };
    for (const m of members) episodeOf.set(m, draft.unit_id);
    texts.set(draft, texts.get(lead) ?? "");
    episodeUnits.push({ draft, summary: parts.join("; "), members });
  }

  const units: AtlasUnit[] = [];
  const links: AtlasUnitEvent[] = [];
  const embedText = (d: Draft, summary?: string): string => {
    const text = texts.get(d) ?? "";
    switch (d.unit_kind) {
      case "message": return `${d.role === "harness" ? "[injected by harness] " : ""}${text.slice(0, MESSAGE_CHARS)}`;
      case "episode": return `${text.slice(0, EPISODE_MESSAGE_CHARS)}\n→ ${summary ?? ""}`;
      case "compaction": return `context compacted${text ? `: ${text.slice(0, SUMMARY_CHARS)}` : ""}`;
      case "delegation": return `delegation event: ${d.subkind ?? "delegation"}`;
      default: {
        const tc = targetClass(d.target);
        let s = d.tool_kind === "shell" ? `run \`${d.command_head ?? d.tool_name ?? "command"}\`${d.check_kinds.length ? ` (${d.check_kinds.join(" + ")})` : ""}`
          + (d.writes.length ? ` — writes ${targetClass(d.writes[0]!) ?? d.writes[0]!}${d.writes.length > 1 ? ` (+${d.writes.length - 1} more)` : ""}` : "")
          : d.tool_kind === "edit" ? `edit ${tc ?? "a file"} (${(d.lines_added ?? 0) + (d.lines_removed ?? 0) <= 10 ? "small edit" : (d.lines_added ?? 0) + (d.lines_removed ?? 0) <= 80 ? "medium edit" : "large rewrite"})`
          : d.tool_kind === "read" ? `read ${tc ?? "a file"}` : d.tool_kind === "search" ? `search ${d.target ?? "the repository"}`
          : d.tool_kind === "plan" ? "update the task plan" : `use tool ${d.tool_name ?? "unknown"}${tc ? ` on ${tc}` : ""}`;
        if (d.status === "error") s += ` — failed${d.error_signature ? `: ${d.error_signature}` : ""}`;
        if ((d.duration_seconds ?? 0) >= 30) s += " [long-running]";
        return s;
      }
    }
  };
  // Episodes sit right after their lead message.
  const position = new Map(drafts.map((d, i) => [d, i]));
  const ordered = [...drafts.map((draft) => ({ draft, summary: undefined as string | undefined, at: position.get(draft)! })),
    ...episodeUnits.map(({ draft, summary, members }) => ({ draft, summary, at: position.get(members[0]!)! + 0.5 }))].sort((a, b) => a.at - b.at);
  ordered.forEach(({ draft, summary }, seq) => {
    const text = embedText(draft, summary);
    const { first: _first, eventParts, ...rest } = draft;
    const tags = new Set(eventParts.flatMap(([id]) => [...(occurrenceTags.get(id) ?? [])]));
    units.push({ ...rest, seq, episode_id: draft.unit_kind === "episode" ? null : episodeOf.get(draft) ?? null,
      event_count: eventParts.length, first_event_key: `${attemptId}/${eventParts[0]![0]}`, occurrences: [...tags].sort(),
      embed: ["message", "tool", "episode", "compaction"].includes(draft.unit_kind), embed_text: text, embed_chars: text.length });
    if (draft.unit_kind !== "episode") for (const [id, part] of eventParts) links.push({ unit_id: draft.unit_id, event_key: `${attemptId}/${id}`, part });
  });
  return { units, links };
}
