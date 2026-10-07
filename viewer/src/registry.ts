// Viewer state and commands: the one path by which anything changes on screen.
// Every user interaction and every fragment link is a named command with a JSON-schema argument; commands return the
// resulting state and a short description of what changed. State is composed from providers (the shell and each
// panel), serializes to the URL, and is kept in a history for undo. The registry is also what a later Agent Mode will
// expose as tools (docs: ebo-atlas-agent-mode-design-note), so tests drive the viewer through it rather than pixels.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Source = "user" | "assistant" | "url" | "system";

export interface CommandDef<A = any> {
  name: string;
  description: string;
  /** JSON Schema for the argument object. */
  args: Record<string, unknown>;
  /** Runs the change and resolves when the UI has settled; returns a short description of what changed. */
  run: (args: A) => Promise<string | void> | string | void;
  /** Commands that only read (exports, describe) do not enter the undo history. */
  readOnly?: boolean;
}

export interface StateProvider {
  key: string;
  get: () => Json;
  apply: (state: any) => Promise<void> | void;
}

export interface CommandEvent { command: string; args: unknown; source: Source; description: string; state: Record<string, Json> }

const commands = new Map<string, CommandDef>();
const providers = new Map<string, StateProvider>();
const history: Record<string, Json>[] = [];
const bus = new EventTarget();
let running: Promise<unknown> = Promise.resolve();

export function register<A>(def: CommandDef<A>): void {
  if (commands.has(def.name)) throw new Error(`Command ${def.name} is registered twice.`);
  commands.set(def.name, def as CommandDef);
}

export function provide(provider: StateProvider): void {
  providers.set(provider.key, provider);
}

export function getState(): Record<string, Json> {
  return Object.fromEntries([...providers.values()].map((p) => [p.key, p.get()]));
}

/** Apply a full or partial state, provider by provider, in registration order. */
export async function setState(state: Record<string, Json>, source: Source = "system"): Promise<void> {
  depth += 1;
  try { for (const provider of providers.values()) if (provider.key in state) await provider.apply(state[provider.key]); } finally { depth -= 1; }
  emit({ command: "setState", args: null, source, description: "Restored a viewer state.", state: getState() });
}

const boundaryHooks: Array<() => void> = [];
/** Called at the start of every command, e.g. to record a component's own pending change first. */
export function onCommandBoundary(hook: () => void): void { boundaryHooks.push(hook); }

/** Run a command. Commands run one at a time, in order, so an assistant's steps and a user's clicks never interleave. */
export function run(name: string, args: Record<string, unknown> = {}, source: Source = "user"): Promise<CommandEvent> {
  const next = running.then(async () => {
    for (const hook of boundaryHooks) hook();
    const def = commands.get(name);
    if (!def) throw new Error(`Unknown viewer command: ${name}`);
    const before = getState();
    depth += 1;
    let description: string;
    try { description = (await def.run(args)) || def.description; } finally { depth -= 1; }
    const state = getState();
    if (!def.readOnly && JSON.stringify(before) !== JSON.stringify(state)) history.push(before);
    const event = { command: name, args, source, description, state };
    emit(event);
    return event;
  });
  running = next.catch(() => undefined);
  return next;
}

function emit(event: CommandEvent) {
  bus.dispatchEvent(new CustomEvent("command", { detail: event }));
}

/** Is a command running? Changes a component makes on its own (outside commands) are recorded separately. */
export const commandRunning = () => depth > 0;
let depth = 0;

/**
 * Record a change a component made through its own controls (for example a pan in the embedding view) as a history
 * entry and an event, given the state before it.
 */
export function recordChange(command: string, description: string, before: Record<string, Json>, source: Source = "user"): void {
  const state = getState();
  if (JSON.stringify(before) === JSON.stringify(state)) return;
  history.push(before);
  emit({ command, args: null, source, description, state });
}

/** Every command, including read-only ones, emits an event saying who issued it (user, assistant, url). */
export function subscribe(listener: (event: CommandEvent) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<CommandEvent>).detail);
  bus.addEventListener("command", handler);
  return () => bus.removeEventListener("command", handler);
}

export function listCommands(): Array<Pick<CommandDef, "name" | "description" | "args" | "readOnly">> {
  return [...commands.values()].map(({ name, description, args, readOnly }) => ({ name, description, args, ...(readOnly ? { readOnly } : {}) }));
}

register({
  name: "undo",
  description: "Undo the last command that changed the viewer.",
  args: { type: "object", properties: {}, additionalProperties: false },
  readOnly: true,
  run: async () => {
    const previous = history.pop();
    if (!previous) return "Nothing to undo.";
    for (const provider of providers.values()) if (provider.key in previous) await provider.apply(previous[provider.key]);
    return "Undid the last change.";
  },
});

// ---- URL: the state serializes to the fragment ------------------------------------------------------------------

/** base64url of UTF-8 JSON. */
export function encodeState(state: Record<string, Json>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeState(text: string): Record<string, Json> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}

// ---- Addressable controls ----------------------------------------------------------------------------------------

/** Attributes that make a control addressable: its stable target id and the command it runs. */
export function target(command: string, id?: string | number): string {
  return `data-ebo-target="${escAttr(id === undefined ? command : `${command}:${id}`)}" data-ebo-command="${escAttr(command)}"`;
}

function escAttr(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Panels describe themselves from data, not pixels: a summary and the numbers they show. */
export interface Describable { describe(): Promise<{ summary: string; data: Json }> | { summary: string; data: Json } }
const describers = new Map<string, Describable>();
export function describable(key: string, panel: Describable) { describers.set(key, panel); }
export async function describe(key?: string) {
  const entries = [...describers.entries()].filter(([k]) => key === undefined || k === key);
  return Object.fromEntries(await Promise.all(entries.map(async ([k, d]) => [k, await d.describe()])));
}
