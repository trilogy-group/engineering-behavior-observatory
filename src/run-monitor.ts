import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Live monitor for a campaign in progress. A campaign runner (an operation that consumes EBO) keeps an
 * `ebo.campaign-status/v1` file current; this module combines it with the attempts' own EBO run bundles (manifest
 * terminal, latest capture report, native stream event names) into an allowlisted `ebo.monitor-snapshot/v1`.
 * The snapshot never carries prompts, completions, commands, logs, credentials or paths outside the status
 * directory. The server is read-only and loopback-only and serves no campaign files.
 */
export const CAMPAIGN_STATUS_FORMAT = "ebo.campaign-status/v1";
export const MONITOR_SNAPSHOT_FORMAT = "ebo.monitor-snapshot/v1";
export const RUN_MONITOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "monitor");
const TOKENS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer", "src", "tokens.css");
const QUIET_MS = 120_000;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

type Json = any; // parsed runner and bundle JSON, read defensively field by field
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const time = (v: unknown): number | null => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const readJson = (path: string): Json => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

/** Incremental JSONL reader: keeps a byte offset per file and returns only complete new lines. */
class JsonlTail {
  private readonly files = new Map<string, { offset: number; rest: string; ino: number }>();
  read(path: string): Json[] {
    let st; try { st = statSync(path); } catch { return []; }
    let prev = this.files.get(path);
    if (!prev || prev.ino !== st.ino || st.size < prev.offset) prev = { offset: 0, rest: "", ino: st.ino };
    this.files.set(path, prev);
    if (st.size === prev.offset) return [];
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(st.size - prev.offset);
      readSync(fd, buf, 0, buf.length, prev.offset);
      prev.offset = st.size;
      const lines = (prev.rest + buf.toString("utf8")).split("\n");
      prev.rest = lines.pop() ?? "";
      const out: Json[] = [];
      for (const line of lines) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* a malformed line is skipped, not fatal */ } }
      return out;
    } finally { closeSync(fd); }
  }
}

// Native stream files in a run bundle. Only event type names are read, never content.
const NATIVE_STREAM = /^(session|pi-events|hooks|events|stream)[\w.-]*\.jsonl$/u;
const typeOf = (o: Json): string | null => {
  const p = o?.payload;
  return str(p && typeof p === "object" ? p.type ?? p.method ?? p.kind : null) ?? str(o?.nativeType) ?? str(o?.type) ?? str(o?.method);
};
// Tool calls started, per native vocabulary: Pi `tool_execution_start`, Codex `item/started` for tool items, Claude
// Agent SDK `tool_use` content blocks. Harnesses without a mapping report null rather than a guessed zero.
const CODEX_TOOL_ITEMS = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "dynamicToolCall"]);
function toolStarts(o: Json, type: string | null): number | null {
  const blocks = o?.message?.message?.content ?? o?.payload?.message?.content ?? o?.message?.content;
  if (Array.isArray(blocks)) return blocks.filter((c: Json) => c?.type === "tool_use").length;
  if (type === "tool_execution_start") return 1;
  if (type === "item/started") return CODEX_TOOL_ITEMS.has(o?.payload?.params?.item?.type) ? 1 : 0;
  return null;
}

type Request = [n: number | null, at: number | null, prompt: number | null, completion: number | null, cached: number | null, costUsd: number | null];
type Accumulator = { requests: Request[]; reasoning: number; types: Map<string, number>; lines: number; tools: number; toolsKnown: boolean };

export function createRunMonitor(statusPath: string) {
  const root = dirname(resolve(statusPath));
  const tail = new JsonlTail();
  const acc = new Map<string, Accumulator>();
  const lastState = new Map<string, string>();
  const transitions: Array<{ at: number; id: string; from: string; to: string }> = [];
  const within = (path: string) => { const r = relative(root, path); return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : null; };
  const at = (p: unknown) => (typeof p === "string" ? (isAbsolute(p) ? p : resolve(root, p)) : null);

  function bundles(dir: string): string[] {
    if (existsSync(join(dir, "manifest.json"))) return [dir];
    const out: string[] = [];
    let runs: string[]; try { runs = readdirSync(dir); } catch { return out; }
    for (const run of runs) {
      let attempts: string[]; try { attempts = readdirSync(join(dir, run)); } catch { continue; }
      for (const a of attempts) if (existsSync(join(dir, run, a, "manifest.json"))) out.push(join(dir, run, a));
    }
    return out;
  }

  function attempt(entry: Json, now: number) {
    const id = String(entry.id);
    let a = acc.get(id);
    if (!a) { a = { requests: [], reasoning: 0, types: new Map(), lines: 0, tools: 0, toolsKnown: false }; acc.set(id, a); }
    const log = at(entry.requestLog);
    if (log) for (const r of tail.read(log)) {
      const u = r?.usage && typeof r.usage === "object" ? r.usage : {};
      const messages = r?.endpoint === "messages" || "cache_read_input_tokens" in u || "cache_creation_input_tokens" in u;
      // Messages input_tokens excludes cache reads and writes; context includes all three.
      const input = num(u.input_tokens);
      const cached = messages ? num(u.cache_read_input_tokens) : num(u.prompt_tokens_details?.cached_tokens) ?? num(u.input_tokens_details?.cached_tokens);
      // Responses input_tokens already includes cached input.
      const prompt = messages && input !== null ? input + (cached ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) : num(u.prompt_tokens) ?? input;
      a.requests.push([num(r?.requestNumber), time(r?.at), prompt, messages ? num(u.output_tokens) : num(u.completion_tokens) ?? num(u.output_tokens), cached, num(r?.costUsd ?? r?.cost ?? u.cost)]);
      a.reasoning += (messages ? num(u.output_tokens_details?.thinking_tokens) : num(u.completion_tokens_details?.reasoning_tokens) ?? num(u.output_tokens_details?.reasoning_tokens)) ?? 0;
    }
    const state = str(entry.state) ?? "pending";
    let terminal: Json = null, qualification: string | null = null, captureState: string | null = null, harnessVersion: string | null = null;
    const dir = at(entry.runBundles);
    for (const bundle of dir ? bundles(dir) : []) {
      let files: string[]; try { files = readdirSync(bundle); } catch { continue; }
      for (const f of files) {
        if (!NATIVE_STREAM.test(f)) continue;
        for (const o of tail.read(join(bundle, f))) {
          const t = typeOf(o);
          a.lines++;
          if (t) a.types.set(t, (a.types.get(t) ?? 0) + 1);
          const n = toolStarts(o, t);
          if (n !== null) { a.toolsKnown = true; a.tools += n; }
        }
      }
      const manifest = readJson(join(bundle, "manifest.json"));
      harnessVersion = str(manifest?.run?.harness?.version) ?? harnessVersion;
      // While the runner reports the attempt running, the manifest terminal is provisional and is not shown.
      if (state !== "running" && manifest?.terminal) terminal = { state: str(manifest.terminal.state), failureClass: str(manifest.terminal.failureClass), stopReason: str(manifest.terminal.stopReason) };
      // Capture reports are numbered (capture/report-NNNN-<id>.json); the highest number is the latest.
      let reports: string[] = []; try { reports = readdirSync(join(bundle, "capture")).filter((f) => /^report-\d+.*\.json$/u.test(f)).sort(); } catch { /* none yet */ }
      const latest = reports.length ? readJson(join(bundle, "capture", reports[reports.length - 1]!)) : null;
      // structuralQualification.status is EBO's verdict once the bundle is qualified; qualification is the live capture state.
      qualification = str(latest?.structuralQualification?.status) ?? qualification;
      captureState = str(latest?.qualification) ?? captureState;
    }
    const s = entry.spend ?? null;
    const startedAt = time(entry.startedAt), endedAt = time(entry.endedAt), lastResponseAt = time(s?.lastResponseAt);
    const sum = (i: 2 | 3 | 4) => a!.requests.reduce((n, r) => n + (r[i] ?? 0), 0);
    return {
      id, harness: String(entry.harness), harnessVersion, model: String(entry.model), replicate: num(entry.replicate), probe: entry.probe === true,
      api: str(entry.api), state, exitCode: num(entry.exitCode), passed: typeof entry.passed === "boolean" ? entry.passed : null,
      directory: dir ? within(dir) : null,
      startedAt, endedAt, elapsedMs: startedAt ? (endedAt ?? now) - startedAt : null,
      maxWallClockMs: num(entry.maxWallClockMs), budgetUsd: num(entry.budgetUsd),
      spend: s && { chargedUsd: num(s.chargedUsd), estimated: s.estimated === true, reservedUsd: num(s.reservedUsd), requests: num(s.requests), accountingErrors: num(s.accountingErrors), budgetStopped: s.budgetStopped === true, lastResponseAt },
      quiet: state === "running" && lastResponseAt !== null && now - lastResponseAt > QUIET_MS,
      terminal, qualification, captureState,
      taskAssessment: entry.taskAssessment && {
        status: str(entry.taskAssessment.status), reasonCode: str(entry.taskAssessment.reasonCode),
        reason: str(entry.taskAssessment.reason), assessedAt: time(entry.taskAssessment.assessedAt),
      },
      tokens: { prompt: sum(2), completion: sum(3), cached: sum(4), reasoning: a.reasoning },
      requests: a.requests,
      native: { lines: a.lines, toolCalls: a.toolsKnown ? a.tools : null, types: [...a.types].sort((x, y) => y[1] - x[1]).slice(0, 12) },
    };
  }

  function snapshot() {
    const now = Date.now();
    const status = readJson(resolve(statusPath));
    if (status?.format !== CAMPAIGN_STATUS_FORMAT) throw new Error(`${statusPath} is not an ${CAMPAIGN_STATUS_FORMAT} file.`);
    const c = status.campaign ?? {};
    const entries: Json[] = Array.isArray(status.attempts) ? status.attempts : [];
    const all = entries.filter((e) => str(e?.id) && str(e?.harness) && str(e?.model)).map((e) => attempt(e, now));
    const probes = all.filter((a: MonitorAttemptLike) => a.probe), attempts = all.filter((a: MonitorAttemptLike) => !a.probe);
    for (const a of all) {
      const before = lastState.get(a.id);
      if (before !== a.state) { if (before !== undefined) transitions.push({ at: now, id: a.id, from: before, to: a.state }); lastState.set(a.id, a.state); }
    }
    transitions.splice(0, Math.max(0, transitions.length - 200));
    const charged = (xs: MonitorAttemptLike[]) => xs.reduce((n, a) => n + (a.spend?.chargedUsd ?? 0), 0);
    // Provider charges and usage estimates are separate quantities; each amount belongs to exactly one total.
    const billed = (xs: MonitorAttemptLike[]) => xs.filter((a) => !a.spend?.estimated), estimated = (xs: MonitorAttemptLike[]) => xs.filter((a) => a.spend?.estimated);
    const pid = num(c.runnerPid);
    return {
      format: MONITOR_SNAPSHOT_FORMAT, generatedAt: now, campaign: str(c.id) ?? basename(root),
      state: str(c.state) ?? "unknown", note: str(c.note), stage: str(c.stage), pidAlive: pid ? pidAlive(pid) : null,
      startedAt: time(c.startedAt), deadline: time(c.deadline),
      lastWrite: Math.max(time(c.updatedAt) ?? 0, ...all.map((a: MonitorAttemptLike) => a.spend?.lastResponseAt ?? 0)) || null,
      config: {
        maxConcurrent: num(status.limits?.maxConcurrent), plannedAttempts: attempts.length,
        budgetPerAttemptUsd: num(status.limits?.budgetPerAttemptUsd), wallClockPerAttemptMs: num(status.limits?.wallClockPerAttemptMs),
        creditAtStartUsd: num(status.account?.creditAtStartUsd), provider: str(status.account?.provider),
        currentCreditUsd: num(status.account?.currentCreditUsd), creditUpdatedAt: time(status.account?.creditUpdatedAt),
        // Unknown stays null: an absent flag is not evidence that the last refresh succeeded.
        creditRefreshFailed: typeof status.account?.creditRefreshFailed === "boolean" ? status.account.creditRefreshFailed : null,
        models: Array.isArray(status.models) ? status.models.filter((m: unknown) => typeof m === "string") : [...new Set(attempts.map((a: MonitorAttemptLike) => a.model))],
      },
      totals: {
        chargedUsd: charged(billed(attempts)), reservedUsd: attempts.reduce((n: number, a: MonitorAttemptLike) => n + (a.spend?.reservedUsd ?? 0), 0), probeChargedUsd: charged(billed(probes)),
        estimatedUsd: charged(estimated(attempts)),
        requests: attempts.reduce((n: number, a: MonitorAttemptLike) => n + (a.spend?.requests ?? 0), 0),
        pending: attempts.filter((a: MonitorAttemptLike) => a.state === "pending").length,
        running: attempts.filter((a: MonitorAttemptLike) => a.state === "running").length,
        finished: attempts.filter((a: MonitorAttemptLike) => a.state !== "pending" && a.state !== "running").length,
      },
      probes, attempts, transitions: transitions.slice(-60),
    };
  }
  return { snapshot };
}
type MonitorAttemptLike = { id: string; probe: boolean; model: string; state: string; spend: { chargedUsd: number | null; estimated?: boolean; reservedUsd: number | null; requests: number | null; lastResponseAt: number | null } | null };

function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }

const PAGE: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/monitor.css": ["monitor.css", "text/css; charset=utf-8"],
  "/monitor.js": ["monitor.js", "text/javascript; charset=utf-8"],
};

/** Serves the monitor page, `/snapshot.json` and an SSE stream at `/events` for one campaign status file. */
export async function serveRunMonitor(statusPath: string, port = 13013, intervalMs = 2000, pageRoot = RUN_MONITOR_ROOT): Promise<Server> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid monitor port.");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250) throw new Error("The refresh interval must be at least 250 ms.");
  if (!existsSync(join(pageRoot, "index.html"))) throw new Error(`The monitor page is missing (${pageRoot}).`);
  const monitor = createRunMonitor(statusPath);
  let current = JSON.stringify(monitor.snapshot()); // fails fast on a missing or foreign status file
  const clients = new Set<ServerResponse>();
  const timer = setInterval(() => {
    try { current = JSON.stringify(monitor.snapshot()); } catch { return; } // a half-written status file keeps the last frame
    for (const res of clients) res.write(`data: ${current}\n\n`);
  }, intervalMs);
  const keepAlive = setInterval(() => { for (const res of clients) res.write(": keep-alive\n\n"); }, 15_000);
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
      if (!req.headers.host || !LOOPBACK.includes(new URL(`http://${req.headers.host}`).hostname)) { res.writeHead(403).end(); return; }
      if (req.headers.origin && !LOOPBACK.includes(new URL(req.headers.origin).hostname)) { res.writeHead(403).end(); return; }
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        res.write(`retry: 3000\ndata: ${current}\n\n`);
        clients.add(res); req.on("close", () => clients.delete(res));
        return;
      }
      if (path === "/snapshot.json") { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(current); return; }
      if (path === "/tokens.css") { res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }).end(existsSync(TOKENS) ? readFileSync(TOKENS) : ""); return; }
      const page = PAGE[path];
      if (!page) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": page[1] }).end(req.method === "HEAD" ? undefined : readFileSync(join(pageRoot, page[0])));
    } catch { res.writeHead(400).end(); }
  });
  server.on("close", () => { clearInterval(timer); clearInterval(keepAlive); for (const res of clients) res.end(); });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  return server;
}
