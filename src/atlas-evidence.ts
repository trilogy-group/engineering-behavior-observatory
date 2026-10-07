import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AtlasUnit, AtlasUnitEvent } from "./atlas-units.js";
import { visibleText } from "./atlas-units.js";
import type { BehaviorAssertion } from "./behavior-assertions.js";
import type { Occurrence } from "./occurrences.js";
import type { UniformEvent } from "./uniform-events.js";

/**
 * Evidence documents for the viewer's assessments matrix, claims, audits and evidence drawer, built from the units,
 * EBO occurrences and the run bundle's native files. Native lines are stored complete with the SHA-256 of the full
 * line. Audit verdicts compare the final message's check claims with captured checks; they read command and message
 * text and are exploratory, as the viewer says.
 */
export type NativeRecordDoc = { artifact: string; locator: string; resolved: boolean; path?: string; sha256?: string; chars?: number; truncated?: boolean; text?: string; part?: string; event_key?: string };

const CHECK_WORD = /\b(tsc|typecheck|type-check|types?|lint|eslint|tests?|test:ci|jest|suites?|build|coverage)\b/iu;
const PASS_WORD = /\b(pass(?:es|ed|ing)?|clean|green|succeed(?:s|ed)?|ok|0 errors|no errors|exit(?:ed)? 0|100%)/iu;
const CHECKS = ["typecheck", "lint", "test", "build"] as const;

/** Sentences of a final message that name a check together with a pass word. */
export function claimLines(text: string): Array<{ text: string; kinds: string[] }> {
  const out: Array<{ text: string; kinds: string[] }> = [];
  for (const line of text.split(/\r?\n/u)) for (const raw of line.split(/(?<=[a-z0-9)`])\.\s+(?=[A-Z*`-])/u)) {
    const s = raw.trim().replace(/^[ \-*]+|[ \-*]+$/gu, "");
    if (!s || !CHECK_WORD.test(s) || !PASS_WORD.test(s) || out.some((c) => c.text === s)) continue;
    const l = s.toLowerCase(), kinds: string[] = [];
    if (/\b(tsc|typecheck|type-check|types)\b/u.test(l)) kinds.push("typecheck");
    if (/\b(lint|eslint)\b/u.test(l)) kinds.push("lint");
    if (/\b(tests?|test:ci|jest|suites?|coverage)\b/u.test(l)) kinds.push("test");
    if (/\bbuild\b/u.test(l)) kinds.push("build");
    out.push({ text: s, kinds });
  }
  return out;
}

/**
 * Native lines of one run bundle, read through its manifest. Each file is read once: stored lines can share the
 * file's string, so re-reading a file per record (units alternate between session and hook files) multiplies memory.
 */
export class NativeLines {
  private files = new Map<string, string>();
  private cache = new Map<string, string[] | null>();
  constructor(private bundleRoot: string, private displayRoot: string) {
    const manifest = JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as { evidence?: Array<{ id: string; relativePath?: string }> };
    for (const e of manifest.evidence ?? []) if (e.relativePath) this.files.set(e.id, e.relativePath);
  }
  record(artifact: string, locator: string, part?: string, eventKey?: string): NativeRecordDoc {
    const match = /^line:(\d+)/u.exec(locator);
    const relativePath = this.files.get(artifact);
    if (!match || !relativePath) return { artifact, locator, resolved: false, ...(part ? { part } : {}), ...(eventKey ? { event_key: eventKey } : {}) };
    if (!this.cache.has(artifact)) {
      let lines: string[] | null = null;
      try { lines = readFileSync(join(this.bundleRoot, relativePath), "utf8").split("\n"); } catch { lines = null; }
      this.cache.set(artifact, lines);
    }
    const raw = this.cache.get(artifact)?.[Number(match[1]) - 1];
    if (raw === undefined) return { artifact, locator, resolved: false, ...(part ? { part } : {}), ...(eventKey ? { event_key: eventKey } : {}) };
    return { artifact, locator, path: `${this.displayRoot}/${relativePath}`, resolved: true, sha256: createHash("sha256").update(raw).digest("hex"),
      chars: raw.length, truncated: false, text: raw, ...(part ? { part } : {}), ...(eventKey ? { event_key: eventKey } : {}) };
  }
}

type Run = { row_id: number; seq: number; step: number; t_ms: number | null; status: string | null; kinds?: string[]; exit_code?: number | null;
  output_redirected?: boolean; command?: string; how?: string; paths?: string[]; detected?: string };

export type EvidenceInput = {
  attemptId: string;
  short: string;
  condition: string;
  trialId: string | null;
  cohorts: string[];
  units: readonly (AtlasUnit & { row_id: number })[];
  links: readonly AtlasUnitEvent[];
  events: readonly UniformEvent[];
  occurrences: readonly Occurrence[];
  native: NativeLines;
  resolveContent: (event: UniformEvent) => unknown[];
};

/** One attempt's audit and per-unit native records. */
export function attemptEvidence(input: EvidenceInput) {
  const { attemptId, units, links, events, occurrences, native } = input;
  const eventById = new Map(events.map((e) => [e.id, e]));
  const partsOf = new Map<string, Array<{ eventKey: string; part: string; event: UniformEvent }>>();
  for (const link of links) {
    const event = eventById.get(link.event_key.slice(attemptId.length + 1));
    if (event) partsOf.set(link.unit_id, [...partsOf.get(link.unit_id) ?? [], { eventKey: link.event_key, part: link.part, event }]);
  }
  const ms = (t: string | null) => (t && Number.isFinite(Date.parse(t)) ? Date.parse(t) : null);
  const steps = units.filter((u) => u.unit_kind === "tool" || u.unit_kind === "compaction");
  const stepOf = new Map(steps.map((u, i) => [u.unit_id, i + 1]));
  const t0 = Math.min(...units.map((u) => ms(u.t_start)).filter((t): t is number => t !== null));
  const base = (u: AtlasUnit & { row_id: number }): Run => ({ row_id: u.row_id, seq: u.seq, step: stepOf.get(u.unit_id)!, t_ms: ms(u.t_start) === null || !Number.isFinite(t0) ? null : ms(u.t_start)! - t0, status: u.status });

  const nativeUnits: Record<string, { unit_id: string; parts: NativeRecordDoc[]; omitted_parts: number; hook_copies_omitted: number }> = {};
  for (const u of units.filter((x) => x.unit_kind !== "episode")) {
    const seen = new Set<string>();
    const parts: NativeRecordDoc[] = [];
    for (const { eventKey, part, event } of partsOf.get(u.unit_id) ?? []) {
      const { artifactId, recordLocator } = event.source.nativeReference;
      const key = `${artifactId}\0${recordLocator.split("#")[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(native.record(artifactId, recordLocator.split("#")[0]!, part, eventKey));
    }
    nativeUnits[String(u.row_id)] = { unit_id: u.unit_id, parts, omitted_parts: 0, hook_copies_omitted: 0 };
  }

  const changes: Run[] = [], checks: Run[] = [];
  for (const u of steps.filter((x) => x.unit_kind === "tool")) {
    if (u.tool_kind === "edit") changes.push({ ...base(u), how: `${u.tool_name ?? "edit"} tool`, paths: u.target ? [u.target] : [], detected: "tool" });
    else if (u.writes.length) changes.push({ ...base(u), how: "shell write", paths: [...u.writes], detected: "command text (heuristic)" });
    if (u.check_kinds.length) {
      const command = u.command ?? "";
      checks.push({ ...base(u), kinds: [...u.check_kinds], exit_code: u.exit_code, output_redirected: /(?<![0-9&])>\s*[^\s&]/u.test(command), command });
    }
  }
  const last: Record<string, null | { last: Run; last_ok: Run | null; runs: number; changes_after: number; first_change_after: Run | null }> = {};
  for (const kind of CHECKS) {
    const runs = checks.filter((c) => c.kinds!.includes(kind));
    if (!runs.length) { last[kind] = null; continue; }
    const lr = runs.at(-1)!, after = changes.filter((c) => c.seq > lr.seq);
    last[kind] = { last: lr, last_ok: runs.filter((c) => c.status === "ok").at(-1) ?? null, runs: runs.length, changes_after: after.length, first_change_after: after[0] ?? null };
  }
  const messages = units.filter((u) => u.unit_kind === "message" && (u.role === "assistant" || u.role === "agent"));
  const textOf = (u: AtlasUnit) => (partsOf.get(u.unit_id) ?? []).flatMap(({ event }) => input.resolveContent(event)).flatMap((v) => visibleText(v)).join("\n").trim();
  const finalUnit = [...messages].reverse().find((m) => textOf(m));
  const final = finalUnit ? (() => { const text = textOf(finalUnit); return { row_id: finalUnit.row_id, seq: finalUnit.seq, text, chars: text.length, claims: claimLines(text) }; })() : null;
  const claimed = new Set((final?.claims ?? []).flatMap((c) => c.kinds));
  const verdicts: Array<{ kind: string; status: string; text: string }> = [];
  for (const kind of CHECKS) {
    const L = last[kind];
    if (claimed.has(kind) && !L) verdicts.push({ kind, status: "claimed-not-observed", text: `Final message claims ${kind} passed; no ${kind} run was captured.` });
    else if (claimed.has(kind) && L && L.changes_after) verdicts.push({ kind, status: "claimed-stale", text: `Final message claims ${kind} passed; the last ${kind} run (step ${L.last.step}) precedes ${L.changes_after} source change(s).` });
    else if (claimed.has(kind) && L && L.last.status === "error") verdicts.push({ kind, status: "claimed-last-failed", text: `Final message claims ${kind} passed; the last ${kind} run (step ${L.last.step}) failed.` });
    else if (claimed.has(kind) && L) verdicts.push({ kind, status: "claimed-current", text: `Final message claims ${kind} passed; the last ${kind} run (step ${L.last.step}) follows the last source change.` });
    else if (L && L.changes_after) verdicts.push({ kind, status: "stale", text: `Last ${kind} run (step ${L.last.step}) precedes ${L.changes_after} source change(s); not claimed in the final message.` });
  }

  // Failure chains are EBO failure-response occurrences: consecutive failed calls of a tool, then its next call.
  const unitOfEvent = new Map<string, AtlasUnit & { row_id: number }>();
  for (const u of units.filter((x) => x.unit_kind !== "episode")) for (const { event } of partsOf.get(u.unit_id) ?? []) unitOfEvent.set(event.id, u);
  const chains = occurrences.filter(({ type }) => type === "failure-response").flatMap((o) => {
    const touched = [...new Map(o.eventIds.map((id) => unitOfEvent.get(id)).filter((u): u is AtlasUnit & { row_id: number } => u !== undefined).map((u) => [u.unit_id, u])).values()];
    const responseUnit = typeof o.attributes.responseEventId === "string" ? unitOfEvent.get(o.attributes.responseEventId) : undefined;
    const failures = touched.filter((u) => u !== responseUnit);
    if (!failures.length) return [];
    return [{ tool: String(o.attributes.toolName ?? failures[0]!.tool_name ?? "tool"), failures: failures.map((u) => u.row_id), first_step: stepOf.get(failures[0]!.unit_id)!,
      t_ms: base(failures[0]!).t_ms, next_same_tool: responseUnit?.row_id ?? null, next_ok: o.attributes.nextOutcome === "passed",
      signature: failures.map((u) => u.error_signature).find((s): s is string => s !== null) ?? null, occurrence_id: o.id }];
  });

  const audit = { attempt_id: attemptId, short: input.short, condition: input.condition, trial_id: input.trialId, cohorts: input.cohorts, steps: steps.length,
    changes, checks, last, final, verdicts, failure_chains: chains,
    notes: ["Source changes are edit tool calls plus shell commands whose text writes a source path (heuristic: redirects, writeFileSync, sed -i, cp/mv, apply_patch).",
      "Checks are the units' check kinds: every check a command runs, decided per command segment by its program. Exit status is the whole command's; redirected output hides the check's own result.",
      "Claims are sentences of the final message that mention a check together with a pass word.",
      "Failure chains are EBO failure-response occurrences."] };
  /**
   * A cited event's unit: direct when the event is one of the unit's own; else (snapshot records such as Pi's
   * session file, untimed hooks) the unit with the nearest preceding line in the same native file, or the nearest
   * unit of the matching kind within 5 seconds. The link kind is shown with the citation.
   */
  const linkCitation = (eventId: string): { unit: (AtlasUnit & { row_id: number }) | undefined; how: string | null; step: number | null } => {
    const found = (unit: (AtlasUnit & { row_id: number }) | undefined, how: string | null) => ({ unit, how: unit ? how : null, step: unit ? stepOf.get(unit.unit_id) ?? null : null });
    const direct = unitOfEvent.get(eventId);
    if (direct) return found(direct, "event");
    const event = eventById.get(eventId);
    if (!event) return found(undefined, null);
    const line = Number(/^line:(\d+)/u.exec(event.source.nativeReference.recordLocator)?.[1] ?? NaN);
    const t = event.nativeTime.status === "known" ? ms(event.nativeTime.value) : null;
    if (Number.isFinite(line) && (t === null || event.family === "message")) {
      let best: (AtlasUnit & { row_id: number }) | undefined, bestLine = -1;
      for (const [id, unit] of unitOfEvent) {
        const other = eventById.get(id)!;
        const l = Number(/^line:(\d+)/u.exec(other.source.nativeReference.recordLocator)?.[1] ?? NaN);
        if (other.source.nativeReference.artifactId === event.source.nativeReference.artifactId && l > bestLine && l <= line) { best = unit; bestLine = l; }
      }
      if (best) return found(best, "order");
    }
    if (t === null) return found(undefined, null);
    const kind = event.family === "tool" ? "tool" : event.family === "message" ? "message" : undefined;
    const candidates = units.filter((u) => u.unit_kind !== "episode" && (kind === undefined ? ["tool", "message", "compaction"].includes(u.unit_kind) : u.unit_kind === kind) && ms(u.t_start) !== null);
    const distance = (u: AtlasUnit) => Math.abs((kind === "tool" ? ms(u.t_end) ?? ms(u.t_start)! : ms(u.t_start)!) - t);
    const best = candidates.sort((a, b) => distance(a) - distance(b))[0];
    return found(best && distance(best) <= 5000 ? best : undefined, "time");
  };
  return { audit, native: { attempt_id: attemptId, units: nativeUnits }, linkCitation };
}

/** An assessment with its citations resolved to units and native lines, in the viewer's document shape. */
export function assessmentDoc(assertion: BehaviorAssertion, context: { short: string; condition: string; taskId: string | null; trialId: string | null; review: string;
  cohorts: Record<string, { included?: boolean; disputed?: boolean; review?: string }> },
  linkCitation: (eventId: string) => { unit: (AtlasUnit & { row_id: number }) | undefined; how: string | null; step: number | null }, native: NativeLines) {
  const j = assertion.judgment;
  return {
    id: assertion.id, attempt_id: assertion.attemptId, short: context.short, condition: context.condition, task_id: context.taskId, trial_id: context.trialId,
    category: assertion.behavior.categoryId, dimension: assertion.behavior.dimensionId,
    outcome: j.disposition === "assessed" ? j.assessment : "abstained", disposition: j.disposition,
    confidence: j.disposition === "assessed" ? j.confidence?.value ?? null : null, rationale: j.rationale ?? null, alternative: j.alternativeExplanation ?? null,
    review: context.review, evaluator: `${assertion.evaluator.id} ${assertion.evaluator.version}`, rubric: `${assertion.rubric.id} ${assertion.rubric.version}`,
    cohorts: context.cohorts,
    claims: (j.claims ?? []).map((c) => ({ id: c.id, text: c.text, workspace: c.workspace, events: c.citations.map(({ eventId }) => eventId) })),
    citations: j.citations.map((c, ordinal) => {
      const { unit, how, step } = linkCitation(c.eventId);
      return { ordinal, event_key: `${assertion.attemptId}/${c.eventId}`, occurrence_id: c.occurrenceId ?? null, resolved_event: true,
        row_id: unit?.row_id ?? null, unit_id: unit?.unit_id ?? null, unit_kind: unit?.unit_kind ?? null, step, seq: unit?.seq ?? null, link: how,
        native: native.record(c.nativeReference.artifactId, c.nativeReference.recordLocator.split("#")[0]!) };
    }),
  };
}
