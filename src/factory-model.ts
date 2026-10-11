/** Secret-free provider selection shared by capture, frozen configuration and retained readback. */
export const FACTORY_BYOK_MODEL_ID = "custom:ebo-byok";
export const FACTORY_BYOK_ENV_NAME = "EBO_FACTORY_BYOK_API_KEY";
export type FactoryModelRoute = { kind: "factory-managed" } | {
  kind: "byok";
  provider: "generic-chat-completion-api";
  baseUrl: string;
  maxOutputTokens: number;
  extraArgs?: {
    temperature?: number;
    top_p?: number;
    reasoning_effort?: "none" | "low" | "medium" | "high" | "max";
    thinking?: { type: "enabled" | "disabled" };
  };
};

export function validateFactoryModelRoute(value: unknown): asserts value is FactoryModelRoute {
  const route = record(value);
  if (!route || !["factory-managed", "byok"].includes(String(route.kind))) throw new Error("Invalid Factory model route.");
  const allowed = route.kind === "factory-managed" ? ["kind"] : ["kind", "provider", "baseUrl", "maxOutputTokens", "extraArgs"];
  if (Object.keys(route).some(key => !allowed.includes(key))) throw new Error("Unknown Factory route field; credentials belong in environment variables.");
  if (route.kind === "factory-managed") return;
  if (route.provider !== "generic-chat-completion-api") throw new Error("Factory BYOK requires generic-chat-completion-api.");
  let url: URL;
  try { url = new URL(String(route.baseUrl)); } catch { throw new Error("Factory BYOK baseUrl must be an absolute HTTP(S) URL."); }
  if (typeof route.baseUrl !== "string" || !["https:", "http:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) throw new Error("Factory BYOK baseUrl must have no credentials, query or fragment.");
  if (!Number.isSafeInteger(route.maxOutputTokens) || (route.maxOutputTokens as number) < 1) throw new Error("Factory BYOK maxOutputTokens must be a positive integer.");
  if (route.extraArgs === undefined) return;
  const args = record(route.extraArgs);
  if (!args || Object.keys(args).some(key => !["temperature", "top_p", "reasoning_effort", "thinking"].includes(key))) throw new Error("Unknown Factory BYOK extraArgs field.");
  if (args.temperature !== undefined && (typeof args.temperature !== "number" || !Number.isFinite(args.temperature) || args.temperature < 0 || args.temperature > 2)
    || args.top_p !== undefined && (typeof args.top_p !== "number" || !Number.isFinite(args.top_p) || args.top_p <= 0 || args.top_p > 1)
    || args.reasoning_effort !== undefined && !["none", "low", "medium", "high", "max"].includes(String(args.reasoning_effort))) throw new Error("Invalid Factory BYOK sampling or reasoning argument.");
  if (args.thinking !== undefined) {
    const thinking = record(args.thinking);
    if (!thinking || Object.keys(thinking).length !== 1 || !["enabled", "disabled"].includes(String(thinking.type))) throw new Error("Invalid Factory BYOK thinking argument.");
  }
}

export function factoryModelSelection(model: string, route: FactoryModelRoute = { kind: "factory-managed" }) {
  validateFactoryModelRoute(route);
  if (!model.trim() || model.startsWith("custom:")) throw new Error("Factory model must name the managed or upstream model, not a custom selector.");
  return { model, nativeModelId: route.kind === "byok" ? FACTORY_BYOK_MODEL_ID : model, route };
}

export function factoryCredentialEnvironment(route?: FactoryModelRoute): string {
  if (route?.kind === "byok") return "FIREWORKS_API_KEY";
  return "FACTORY_API_KEY";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
