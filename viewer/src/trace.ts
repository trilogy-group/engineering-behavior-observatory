// Chrome trace JSON (legacy JSON trace format) for ui.perfetto.dev or chrome://tracing.
// One process per arm, threads per attempt (actions, plus extra action threads for overlapping calls, and turns); every lane starts at 0 so attempts
// line up; tool calls are complete events, messages and compactions instants, cumulative tokens and context per request as counter tracks.
import type { LaneMeta, Unit } from "./lanes";

export function downloadTrace(task: string, lanes: LaneMeta[], byLane: Map<string, Unit[]>, usage: Record<string, [number, number][]>, context: Record<string, [number, number][]> = {}) {
  const ev: any[] = [];
  const arms = [...new Set(lanes.map((l) => l.condition))];
  arms.forEach((a, i) => ev.push({ ph: "M", name: "process_name", pid: i + 1, tid: 0, args: { name: a } }, { ph: "M", name: "process_sort_index", pid: i + 1, tid: 0, args: { sort_index: i } }));
  lanes.forEach((l, n) => {
    const pid = arms.indexOf(l.condition) + 1, base = (n + 1) * 100;
    const us = byLane.get(l.attempt_id) ?? [];
    const t0 = Math.min(...us.filter((u) => u.t0_ms != null).map((u) => u.t0_ms!));
    const ts = (ms: number | null) => Math.round(((ms ?? t0) - t0) * 1000);
    // JSON traces need properly nested slices per thread: overlapping (parallel) calls go to extra threads.
    const tracks: { name: string; ends: number[] }[] = [];
    const place = (group: string, slot0: number, start: number, end: number) => {
      let k = 0;
      for (;; k++) {
        const key = `${group}:${k}`;
        let t = tracks.find((x) => x.name === key);
        if (!t) { t = { name: key, ends: [] }; tracks.push(t); ev.push({ ph: "M", name: "thread_name", pid, tid: base + slot0 + k, args: { name: `trial ${l.trial_id} · ${group}${k ? " " + (k + 1) : ""}` } }, { ph: "M", name: "thread_sort_index", pid, tid: base + slot0 + k, args: { sort_index: base + slot0 + k } }); }
        if ((t.ends.at(-1) ?? -1) <= start) { t.ends.push(end); return base + slot0 + k; }
      }
    };
    const sorted = [...us].sort((a, b) => (a.t0_ms ?? 0) - (b.t0_ms ?? 0) || a.seq - b.seq);
    for (const u of sorted) {
      const args = { row_id: u.row_id, attempt_id: u.attempt_id, seq: u.seq, status: u.status, category: u.cat, cluster: u.cluster_label, occurrences: u.occ || undefined, cited: u.cited || undefined, text: u.text };
      const s0 = ts(u.t0_ms), dur = Math.max(1, ts(u.t1_ms) - s0);
      if (u.unit_kind === "tool") ev.push({ ph: "X", name: u.command_head || u.tool_kind || "tool", cat: u.cat, pid, tid: place("actions", 0, s0, s0 + dur), ts: s0, dur, args });
      else if (u.unit_kind === "episode") ev.push({ ph: "X", name: "turn", cat: "episode", pid, tid: place("turns", 50, s0, s0 + dur), ts: s0, dur, args });
      else if (u.unit_kind === "message") ev.push({ ph: "i", s: "t", name: "message", cat: "message", pid, tid: base + 50, ts: s0, args });
      else if (u.unit_kind === "compaction") ev.push({ ph: "i", s: "p", name: "compaction", cat: "compaction", pid, tid: base, ts: s0, args });
    }
    for (const [t, v] of usage[l.attempt_id] ?? []) ev.push({ ph: "C", name: `tokens · trial ${l.trial_id}`, pid, ts: ts(t), args: { cumulative: v } });
    for (const [t, v] of context[l.attempt_id] ?? []) ev.push({ ph: "C", name: `context · trial ${l.trial_id}`, pid, ts: ts(t), args: { tokens: v } });
  });
  const blob = new Blob([JSON.stringify({ traceEvents: ev, displayTimeUnit: "ms", otherData: { source: "EBO Atlas lab", task } })], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ebo-trace-${task}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
