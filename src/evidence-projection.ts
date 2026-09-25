import { canonicalizeMetadata } from "./artifacts.js";

import { visibleEvidence } from "./exports.js";
export { visibleEvidence } from "./exports.js";

/** Keep scalar metadata (exit codes, cwd, paths) while bounding long output strings. */
export function boundedEvidence(value: unknown, maxChars: number): { content: string; truncated: boolean } {
  const projected = visibleEvidence(value);
  const original = canonicalizeMetadata(projected);
  let content = original;
  let stringLimit = Math.floor(maxChars / 2);
  while (content.length > maxChars && stringLimit >= 64) {
    const bound = (entry: unknown): unknown => typeof entry === "string" && entry.length > stringLimit
      ? ends(entry, stringLimit)
      : Array.isArray(entry) ? entry.map(bound)
      : entry !== null && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, bound(child)])) : entry;
    content = canonicalizeMetadata(bound(projected));
    stringLimit = Math.floor(stringLimit / 2);
  }
  // ponytail: structurally huge records use a marked excerpt; add native paging if needed.
  if (content.length > maxChars) content = ends(original, maxChars);
  return { content, truncated: original.length > maxChars };
}

function ends(text: string, limit: number): string {
  const marker = `...[OMITTED MIDDLE; originalChars=${text.length}]...`;
  const head = Math.floor((limit - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(-(limit - marker.length - head));
}

/** Only explicit native cwd fields establish workspace identity. Relative paths do not. */
export function evidenceWorkspaces(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) { entry.forEach(visit); return; }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (["cwd", "workdir", "workingDirectory", "working_directory", "workspaceCwd"].includes(key) && typeof child === "string") found.add(child);
      visit(child);
    }
  };
  visit(visibleEvidence(value));
  return [...found].sort();
}
