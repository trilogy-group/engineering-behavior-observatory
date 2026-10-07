import { assertNoDuplicateJsonKeys } from "./artifacts.js";

/**
 * System One decision models: a state plus typed questions in, typed answers with probabilities out. One interface
 * serves every provider in the fixed registry below; each call is retained as a decision record with the exact
 * request, the raw response, the answering model, usage and timing. A failed call is recorded as failed and never
 * becomes an answer.
 */
export const DECISION_PROVIDERS = {
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", apiKeyEnv: "TYPESAFE_API_KEY", defaultModel: "jev-1.13.0" },
  fireworks: { endpoint: "https://api.fireworks.ai/inference/v1/systemone", apiKeyEnv: "FIREWORKS_API_KEY", modelEnv: "FIREWORKS_SYSTEMONE_MODEL" },
} as const;
export type DecisionProviderId = keyof typeof DECISION_PROVIDERS;

export type DecisionText = string | Record<string, unknown> | unknown[];
export type DecisionQuestion =
  | { type: "choice"; instructions: DecisionText; criteria: Record<string, DecisionText | null> }
  | { type: "noul"; instructions: DecisionText; criteria?: { true?: DecisionText; false?: DecisionText } }
  | { type: "score"; instructions: DecisionText; criteria: DecisionText[] };
export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
export type DecisionUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

export type DecisionRecord = {
  schemaVersion: "ebo.decision-record/v1";
  provider: DecisionProviderId;
  requestedModel: string;
  /** Versioned model identity the provider reported. */
  model?: string;
  request: { model: string; state: unknown; questions: Record<string, DecisionQuestion> };
  status: "completed" | "failed";
  answers?: Record<string, DecisionAnswer>;
  usage?: DecisionUsage;
  response?: unknown;
  /** Every non-2xx response, retried or final: status and bounded, redacted body. */
  failedResponses?: Array<{ attempt: number; status: number; body: string }>;
  error?: string;
  startedAt: string;
  durationMs: number;
  /** Provider-reported server processing time header, verbatim (Fireworks `fireworks-server-processing-time`). */
  serverProcessingTime?: string;
  attempts: number;
};

export type DecisionProviderConfig = { provider: DecisionProviderId; model?: string };

export type DecideOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Retries for 429, 502 and 503 responses, honoring Retry-After up to `maxRetryDelayMs`. */
  maxRetries?: number;
  maxRetryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
};

const MAX_RESPONSE_BYTES = 1 << 20;
// Providers round probabilities (Jev to two decimals), so a distribution may sum to 1 only within rounding.
const PROBABILITY_TOLERANCE = 0.03;

/** Resolve the model a provider config names: explicit, then the provider's environment variable, then its default. */
export function resolveDecisionModel(config: DecisionProviderConfig, env: Record<string, string | undefined> = process.env): string {
  const provider = DECISION_PROVIDERS[config.provider];
  const model = config.model ?? ("modelEnv" in provider ? env[provider.modelEnv] : undefined) ?? ("defaultModel" in provider ? provider.defaultModel : undefined);
  if (model === undefined || model.trim() === "") {
    throw new Error(`Decision provider ${config.provider} needs a model (set ${"modelEnv" in provider ? provider.modelEnv : "model"}).`);
  }
  return model;
}

/** Ask one provider every question about one state in a single request. */
export async function decide(
  config: DecisionProviderConfig,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
  options: DecideOptions = {},
): Promise<DecisionRecord> {
  const env = options.env ?? process.env;
  const provider = DECISION_PROVIDERS[config.provider];
  if (provider === undefined) throw new Error(`Unknown decision provider ${String(config.provider)}.`);
  validateQuestions(questions);
  const model = resolveDecisionModel(config, env);
  const apiKey = env[provider.apiKeyEnv];
  const request = { model, state, questions };
  const now = options.now ?? (() => new Date());
  const started = performance.now();
  const record: DecisionRecord = {
    schemaVersion: "ebo.decision-record/v1", provider: config.provider, requestedModel: model, request,
    status: "failed", startedAt: now().toISOString(), durationMs: 0, attempts: 0,
  };
  const redact = (value: string) => apiKey === undefined || apiKey === "" ? value : value.replaceAll(apiKey, "[REDACTED]");
  try {
    if (apiKey === undefined || apiKey === "") throw new Error(`${provider.apiKeyEnv} is required for decision provider ${config.provider}.`);
    const body = JSON.stringify(request);
    const authorizationHeader = `Bearer ${apiKey}`;
    const maxRetries = options.maxRetries ?? 3;
    for (;;) {
      record.attempts += 1;
      const signals = [AbortSignal.timeout(options.timeoutMs ?? 120_000), ...(options.signal === undefined ? [] : [options.signal])];
      const response = await (options.fetch ?? fetch)(provider.endpoint, {
        method: "POST",
        headers: { Authorization: authorizationHeader, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.any(signals),
      });
      const text = await boundedText(response);
      const server = response.headers.get("fireworks-server-processing-time");
      if (server !== null) record.serverProcessingTime = server.slice(0, 64);
      if (response.ok) {
        assertNoDuplicateJsonKeys(text);
        const raw = JSON.parse(text) as unknown;
        record.response = raw;
        const parsed = parseDecisionResponse(raw, questions);
        record.model = parsed.model;
        record.answers = parsed.answers;
        record.usage = parsed.usage;
        record.status = "completed";
        break;
      }
      (record.failedResponses ??= []).push({ attempt: record.attempts, status: response.status, body: redact(text).slice(0, 4096) });
      if ([429, 502, 503].includes(response.status) && record.attempts <= maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Math.min(options.maxRetryDelayMs ?? 30_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (record.attempts - 1));
        await (options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(delay);
        continue;
      }
      throw new Error(`${config.provider} HTTP ${response.status}: ${text.slice(0, 512)}`);
    }
  } catch (error) {
    record.status = "failed";
    delete record.answers;
    record.error = redact(error instanceof Error ? error.message : String(error)).slice(0, 4096);
  } finally {
    record.durationMs = Math.round(performance.now() - started);
  }
  return record;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error(`Decision response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateQuestions(questions: Record<string, DecisionQuestion>): void {
  const entries = Object.entries(questions);
  if (entries.length === 0 || entries.length > 256) throw new Error("A decision request needs 1 to 256 questions.");
  for (const [id, question] of entries) {
    if (question.type === "choice") {
      const options = Object.keys(question.criteria);
      if (options.length < 2 || options.length > 208) throw new Error(`Choice question ${id} needs 2 to 208 options.`);
    } else if (question.type === "score") {
      if (question.criteria.length < 2 || question.criteria.length > 10) throw new Error(`Score question ${id} needs 2 to 10 levels.`);
    } else if (question.type !== "noul") throw new Error(`Question ${id} has an unknown type.`);
  }
}

/** Validate a provider response against the questions asked; any mismatch fails the whole call. */
/**
 * A completed record's answers, model and usage must be exactly what its retained provider response states for the
 * questions it asked; a failed record carries no answers.
 */
export function verifyDecisionRecord(record: DecisionRecord): void {
  if (record.status !== "completed") {
    if (record.answers !== undefined) throw new Error("A failed decision record carries answers.");
    return;
  }
  const parsed = parseDecisionResponse(record.response, record.request.questions);
  if (JSON.stringify(sortKeys(parsed.answers)) !== JSON.stringify(sortKeys(record.answers)) || parsed.model !== record.model
      || JSON.stringify(sortKeys(parsed.usage)) !== JSON.stringify(sortKeys(record.usage))) {
    throw new Error("Decision record answers, model or usage differ from its retained provider response.");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
}

export function parseDecisionResponse(raw: unknown, questions: Record<string, DecisionQuestion>): { model: string; answers: Record<string, DecisionAnswer>; usage: DecisionUsage } {
  const body = asRecord(raw);
  const answers = asRecord(body?.answers);
  if (body === undefined || answers === undefined || typeof body.model !== "string") throw new Error("Decision response lacks model or answers.");
  if (Object.keys(answers).sort().join("\n") !== Object.keys(questions).sort().join("\n")) throw new Error("Decision response answers differ from the questions asked.");
  const parsed: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = asRecord(answers[id]);
    if (answer?.type !== question.type) throw new Error(`Answer ${id} has the wrong type.`);
    if (question.type === "noul") {
      const value = answer.noul;
      if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new Error(`Answer ${id} has an invalid noul.`);
      parsed[id] = { type: "noul", noul: value };
      continue;
    }
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const probabilities = distribution(answer.probabilities, keys, id);
    const confidence = answer.confidence;
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) throw new Error(`Answer ${id} has an invalid confidence.`);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !keys.includes(answer.choice)) throw new Error(`Answer ${id} chose an undeclared option.`);
      parsed[id] = { type: "choice", choice: answer.choice, probabilities, confidence };
    } else {
      const score = answer.score;
      if (typeof score !== "number" || !(score >= 0 && score <= keys.length - 1)) throw new Error(`Answer ${id} has an out-of-range score.`);
      parsed[id] = { type: "score", score, probabilities, confidence };
    }
  }
  const usage = asRecord(body.usage);
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) throw new Error("Decision response lacks token usage.");
  const cachedInputTokens = count(usage?.cached_input_tokens);
  return { model: body.model, answers: parsed, usage: { inputTokens, outputTokens, ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }) } };
}

function distribution(value: unknown, keys: readonly string[], id: string): Record<string, number> {
  const record = asRecord(value);
  if (record === undefined || Object.keys(record).sort().join("\n") !== [...keys].sort().join("\n")) throw new Error(`Answer ${id} probabilities differ from its options.`);
  let total = 0;
  for (const key of keys) {
    const probability = record[key];
    if (typeof probability !== "number" || !(probability >= 0 && probability <= 1)) throw new Error(`Answer ${id} has an invalid probability.`);
    total += probability;
  }
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) throw new Error(`Answer ${id} probabilities do not sum to 1.`);
  return Object.fromEntries(keys.map((key) => [key, record[key] as number]));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
