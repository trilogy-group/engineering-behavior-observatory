import type { AtlasUnit } from "./atlas-units.js";
import type { UniformEvent } from "./uniform-events.js";

/**
 * Swimlane data for the Atlas viewer: one lane per attempt with its time span and unit counts, and token-usage
 * series from the normalized runtime events. Usage semantics come from each event's `resourceSemantics`:
 * `increment` (one model request), `cumulative-snapshot` (a running total as reported) and `cumulative-final`
 * (session totals). The context of a request is its input plus cache reads and writes; only the main agent's
 * requests (`usageScope: "assistant"`) form the context series. Untimed usage events take the time of the latest
 * timed event before them. No usage recorded is reported as such, never as zero.
 */
export type LaneMeta = {
  attempt_id: string; task_id: string | null; condition: string | null; trial_id: string | null; harness_id: string | null; model_id: string | null;
  terminal_state: string | null; failure_class: string | null; capture_qualification: string | null; t_start_ms: number | null; t_end_ms: number | null;
  units: number; tools: number; errors: number; compactions: number; cited_units: number;
  usage_semantics: "per-turn" | "final-only" | "none"; tokens_total: number | null; cost_usd: number | null; context_max: number | null;
  output_tokens: "per-request" | "final-only" | "none";
};
export type LanesData = { attempts: LaneMeta[]; usage: Record<string, Array<[number, number]>>; context: Record<string, Array<[number, number]>> };

type Attempt = { attempt_id: string; task_id: string | null; condition: string | null; trial_id: string | null; harness_id: string | null; model_id: string | null;
  terminal_state: string | null; failure_class: string | null; capture_qualification: string | null };

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const ms = (t: string | null | undefined) => (t && Number.isFinite(Date.parse(t)) ? Date.parse(t) : null);

/** Total tokens of one usage record: `totalTokens` when reported, else input, output and cache counts. */
function total(a: Readonly<Record<string, unknown>>): number {
  return typeof a.totalTokens === "number" ? a.totalTokens
    : n(a.inputTokens) + n(a.outputTokens) + n(a.cacheReadInputTokens) + n(a.cacheCreationInputTokens) + n(a.cacheWriteInputTokens);
}

export function laneData(attempt: Attempt, units: readonly AtlasUnit[], events: readonly UniformEvent[]): { lane: LaneMeta; usage?: Array<[number, number]>; context?: Array<[number, number]> } {
  const starts = units.map((u) => ms(u.t_start)).filter((t): t is number => t !== null);
  const ends = units.map((u) => ms(u.t_end) ?? ms(u.t_start)).filter((t): t is number => t !== null);
  const steps = units.filter((u) => u.unit_kind !== "episode");
  let carried: number | null = null;
  const increments: Array<{ t: number; a: Readonly<Record<string, unknown>> }> = [];
  const snapshots: Array<[number, number]> = [];
  const final = { records: 0, tokens: 0, cost: null as number | null };
  for (const event of events) {
    const t = event.nativeTime.status === "known" ? ms(event.nativeTime.value) : null;
    if (t !== null) carried = t;
    const a = event.attributes as Readonly<Record<string, unknown>>;
    const semantics = a.resourceSemantics;
    if (semantics === "increment" && carried !== null) increments.push({ t: carried, a });
    else if (semantics === "cumulative-snapshot" && carried !== null) snapshots.push([carried, total(a)]);
    // A final record counts only when it carries token dimensions (a duration- or cost-only final is not usage).
    else if (semantics === "cumulative-final") {
      // Tokens only from a complete final: a reported total, or both input and output (cache counts may be absent).
      // A partial final (one dimension) is not a total.
      if (typeof a.totalTokens === "number" || (typeof a.inputTokens === "number" && typeof a.outputTokens === "number")) { final.records += 1; final.tokens += total(a); }
      if (typeof a.totalCostUsd === "number") final.cost = (final.cost ?? 0) + a.totalCostUsd;
    }
  }
  let usage: Array<[number, number]> | undefined;
  if (increments.length) {
    let sum = 0;
    usage = increments.map(({ t, a }) => [t, (sum += total(a))]);
  } else if (snapshots.length) usage = snapshots;
  const context = increments.filter(({ a }) => (a.usageScope ?? "assistant") === "assistant")
    .map(({ t, a }) => [t, n(a.inputTokens) + n(a.cacheReadInputTokens) + n(a.cacheCreationInputTokens) + n(a.cacheWriteInputTokens)] as [number, number]);
  const outputPerRequest = increments.some(({ a }) => typeof a.outputTokens === "number");
  const lane: LaneMeta = {
    ...attempt,
    t_start_ms: starts.length ? Math.min(...starts) : null, t_end_ms: ends.length ? Math.max(...ends) : null,
    units: steps.length, tools: steps.filter((u) => u.unit_kind === "tool").length, errors: steps.filter((u) => u.status === "error").length,
    compactions: steps.filter((u) => u.unit_kind === "compaction").length, cited_units: 0,
    usage_semantics: usage ? "per-turn" : final.records ? "final-only" : "none",
    tokens_total: final.records ? final.tokens : usage?.at(-1)?.[1] ?? null,
    cost_usd: final.cost === null ? null : Math.round(final.cost * 1e4) / 1e4,
    context_max: context.length ? Math.max(...context.map(([, v]) => v)) : null,
    output_tokens: outputPerRequest ? "per-request" : final.records ? "final-only" : "none",
  };
  return { lane, ...(usage ? { usage } : {}), ...(context.length ? { context } : {}) };
}
