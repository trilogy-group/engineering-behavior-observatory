/**
 * Secret redaction shared by portable exports, Atlas reports and evidence packets.
 *
 * One implementation decides both what is redacted and what the final scan
 * rejects, so a sanitized document never fails its own scan. Known credential
 * formats are always redacted. Assignments to secret-named variables are
 * classified by context. A quoted value, or the value of a shell-style
 * assignment (`KEY=value`, `--key=value`), is a literal and is redacted unless
 * it is an environment reference or a placeholder. In a code-style assignment
 * (`key = expr`, `key: expr`) only syntactic references (dotted paths, calls,
 * environment lookups, constant names, keywords) are kept and reported as not
 * secret. Bare words are redacted: over-redaction is preferred to a leak.
 */

export const SECRET_PLACEHOLDER = "[REDACTED_SECRET]";

export type SecretTokenKind =
  | "private-key"
  | "aws-access-key"
  | "github-token"
  | "anthropic-api-key"
  | "openai-style-api-key"
  | "fireworks-api-key"
  | "slack-token"
  | "google-api-key"
  | "jwt"
  | "authorization-header"
  | "bearer-token";

export type NotSecretReason =
  | "placeholder"
  | "environment-reference"
  | "constant-name"
  | "identifier-path"
  | "expression"
  | "keyword"
  | "too-short";

export type SecretFinding =
  | { kind: SecretTokenKind; disposition: "redacted" }
  | { kind: "secret-field"; disposition: "redacted"; name: string }
  | { kind: "secret-assignment"; disposition: "redacted"; name: string }
  | { kind: "secret-assignment"; disposition: "not-secret"; name: string; reason: NotSecretReason };

export type SecretFindingSink = (finding: SecretFinding) => void;

const TOKEN_PATTERNS: ReadonlyArray<{ kind: SecretTokenKind; pattern: RegExp }> = [
  {
    kind: "private-key",
    pattern: /()(?:-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|$))/gu,
  },
  { kind: "aws-access-key", pattern: /()\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu },
  { kind: "github-token", pattern: /()\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/gu },
  { kind: "anthropic-api-key", pattern: /()\bsk-ant-[A-Za-z0-9_-]{12,}/gu },
  { kind: "openai-style-api-key", pattern: /()\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu },
  { kind: "fireworks-api-key", pattern: /()\bfw_[A-Za-z0-9]{20,}/gu },
  { kind: "slack-token", pattern: /()\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
  { kind: "google-api-key", pattern: /()\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/gu },
  { kind: "jwt", pattern: /()\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
  { kind: "authorization-header", pattern: /(\bauthorization\s*[:=])(?!\s*\[REDACTED_)\s*[^\r\n]+/giu },
  { kind: "bearer-token", pattern: /(\bbearer\s+)[A-Za-z0-9._~+/=-]{20,}/giu },
];

const SECRET_NAME = /(api[_-]?key|(?:access|oauth|refresh|id|auth)?[_-]?token|client[_-]?secret|secret(?:[_-]?(?:access[_-]?)?key)?|private[_-]?key|access[_-]?key|credentials?(?:[_-]?json)?|database[_-]?url|connection[_-]?string|passwd|password)(\\?["']?)([ \t]*)(:=|[:=](?![=>~]))([ \t]*)/giu;
const QUOTES = new Set(["\"", "'", "`"]);
const IDENTIFIER_CHAR = /[A-Za-z0-9_$.-]/u;
const UNQUOTED_VALUE = /^(?:Bearer\s+)?(?:\$\{[^}\s]*\}|[^\s,;"'`)}\]])+/iu;
// A complete plain environment reference: `$NAME`, `${NAME}`, `%NAME%`.
const PLAIN_REFERENCE = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|%[A-Za-z_][A-Za-z0-9_]*%)$/u;
// `${NAME:-word}`, `${NAME=word}`, `${NAME:+word}`, `${NAME:?message}`: the word can be a literal credential.
const PARAMETER_EXPANSION = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:?[-=+?])([\s\S]*?)\}?$/u;
const SHELL_REFERENCE = /^(?:\$[A-Za-z_{(]|%[A-Za-z_][A-Za-z0-9_]*%)/u;
const CALL_EXPRESSION = /^(?:new\s+)?[A-Za-z_$][\w$.]*\(/u;
const KEYWORD = /^(?:null|undefined|true|false|none|nil|string|number|boolean|bigint|object|any|unknown|str|bytes|int|float|bool)$/iu;
const ENVIRONMENT_REFERENCE = /^(?:process\.env\b|os\.environ\b|os\.getenv\b|import\.meta\.env\b|Deno\.env\b|env\.|getenv\b|secrets\.|\$[A-Za-z_{]|%[A-Za-z_][A-Za-z0-9_]*%)/u;
const QUOTED_PLACEHOLDER = /^(?:|\[[A-Z_]+(?::[^\]]*)?\]|<[^<>]*>|\{\{[^}]*\}\}|\*+|x{3,}|\.{3})$/iu;
// EBO's own markers, including a marker cut short by a display-length bound.
const EBO_PLACEHOLDER_PREFIX = /^\[(?:REDACTED|LOCAL)_/u;
const CONSTANT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+(?:\(\))?$/u;

/** Normalize a JSON field name for secret-field and policy comparisons. */
export function normalizeFieldName(value: string): string {
  return value.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}

const SECRET_FIELDS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "blobencryptionkey",
  "clientsecret",
  "connectionstring",
  "credential",
  "credentials",
  "credentialsjson",
  "databaseurl",
  "idtoken",
  "oauthtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "token",
]);

/** Structured fields whose whole value is a credential, whatever it contains. */
export function isSecretFieldName(key: string): boolean {
  return SECRET_FIELDS.has(normalizeFieldName(key));
}

/** Redact every secret in a string, reporting each match (including references kept as not secret). */
export function redactSecrets(text: string, onFinding?: SecretFindingSink): { text: string; redacted: number } {
  let output = text;
  let redacted = 0;
  for (const { kind, pattern } of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (_match, prefix: string) => {
      redacted += 1;
      onFinding?.({ kind, disposition: "redacted" });
      return `${prefix}${SECRET_PLACEHOLDER}`;
    });
  }
  const assignments = scanAssignments(output);
  let rebuilt = "";
  let cursor = 0;
  for (const assignment of assignments) {
    onFinding?.(assignment.finding);
    if (assignment.finding.disposition !== "redacted") continue;
    rebuilt += `${output.slice(cursor, assignment.valueStart)}${SECRET_PLACEHOLDER}`;
    cursor = assignment.valueEnd;
    redacted += 1;
  }
  return { text: cursor === 0 ? output : rebuilt + output.slice(cursor), redacted };
}

/** True when the string still holds a value that redactSecrets would redact. */
export function containsSecret(text: string): boolean {
  for (const { pattern } of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    const matched = pattern.test(text);
    pattern.lastIndex = 0;
    if (matched) return true;
  }
  return scanAssignments(text).some(({ finding }) => finding.disposition === "redacted");
}

type Assignment = { finding: SecretFinding; valueStart: number; valueEnd: number };

function scanAssignments(text: string): Assignment[] {
  const assignments: Assignment[] = [];
  SECRET_NAME.lastIndex = 0;
  for (let match = SECRET_NAME.exec(text); match !== null; match = SECRET_NAME.exec(text)) {
    const name = identifierAround(text, match.index, match.index + match[1]!.length);
    // `KEY=value` with nothing between name, operator and value is a shell, env-file, flag or query assignment.
    const shell = match[2] === "" && match[3] === "" && match[4] === "=" && match[5] === "";
    const start = match.index + match[0].length;
    // Command text often embeds JSON with escaped quotes: token=\"value\".
    const escaped = text[start] === "\\" && QUOTES.has(text[start + 1] ?? "");
    const quote = text[escaped ? start + 1 : start] ?? "";
    if (QUOTES.has(quote)) {
      const valueStart = start + (escaped ? 2 : 1);
      const close = escaped ? escapedClosingQuote(text, valueStart, quote) : closingQuote(text, valueStart, quote);
      const valueEnd = close === -1 ? lineEnd(text, valueStart) : close;
      const value = text.slice(valueStart, valueEnd);
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, valueEnd);
      // Values EBO already replaced were reported by the redaction that replaced them.
      if (EBO_PLACEHOLDER_PREFIX.test(value)) continue;
      const expansion = classifyReference(value);
      if (expansion !== undefined) {
        assignments.push(expansionAssignment(expansion, name, valueStart, valueEnd));
        continue;
      }
      const finding: SecretFinding = QUOTED_PLACEHOLDER.test(value)
        ? { kind: "secret-assignment", disposition: "not-secret", name, reason: "placeholder" }
        : { kind: "secret-assignment", disposition: "redacted", name };
      assignments.push({ finding, valueStart, valueEnd });
      continue;
    }
    const raw = UNQUOTED_VALUE.exec(text.slice(start, start + 4096))?.[0];
    if (raw === undefined) continue;
    const bearer = /^Bearer\s+/iu.exec(raw)?.[0] ?? "";
    const value = raw.slice(bearer.length);
    if (EBO_PLACEHOLDER_PREFIX.test(value)) continue;
    const expansion = classifyReference(value);
    if (expansion !== undefined) {
      assignments.push(expansionAssignment(expansion, name, start + bearer.length, start + raw.length));
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, start + raw.length);
      continue;
    }
    const reason = notSecretReason(value, shell);
    assignments.push({
      finding: reason === undefined
        ? { kind: "secret-assignment", disposition: "redacted", name }
        : { kind: "secret-assignment", disposition: "not-secret", name, reason },
      valueStart: start + bearer.length,
      valueEnd: start + raw.length,
    });
    SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, start + raw.length);
  }
  SECRET_NAME.lastIndex = 0;
  return assignments;
}

type ReferenceClass = { kind: "reference" } | { kind: "literal-word"; start: number; end: number };

/**
 * Environment references in any context. A complete plain reference stays; a parameter expansion stays unless its
 * default, assigned or alternate word is a literal, in which case only that word is redacted. Error messages
 * (`${NAME:?message}`) are not values.
 */
function classifyReference(value: string): ReferenceClass | undefined {
  if (PLAIN_REFERENCE.test(value)) return { kind: "reference" };
  const expansion = PARAMETER_EXPANSION.exec(value);
  if (expansion === null) return undefined;
  const [, operator, word] = expansion as unknown as [string, string, string];
  if (operator.endsWith("?") || word === "" || PLAIN_REFERENCE.test(word) || EBO_PLACEHOLDER_PREFIX.test(word)) return { kind: "reference" };
  const end = value.length - (value.endsWith("}") ? 1 : 0);
  return { kind: "literal-word", start: end - word.length, end };
}

function expansionAssignment(reference: ReferenceClass, name: string, valueStart: number, valueEnd: number): Assignment {
  return reference.kind === "reference"
    ? { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "environment-reference" }, valueStart, valueEnd }
    : { finding: { kind: "secret-assignment", disposition: "redacted", name }, valueStart: valueStart + reference.start, valueEnd: valueStart + reference.end };
}

function notSecretReason(value: string, shell: boolean): NotSecretReason | undefined {
  if (value === "" || QUOTED_PLACEHOLDER.test(value)) return "placeholder";
  if (shell) {
    // Shell values are literals: `TOKEN=ABCDEFGHIJ` and `TOKEN=a.b.c` are credentials, not references.
    if (SHELL_REFERENCE.test(value)) return "environment-reference";
    return value.length < 8 ? "too-short" : undefined;
  }
  if (/^[[<{(`]/u.test(value)) return "placeholder";
  if (ENVIRONMENT_REFERENCE.test(value)) return "environment-reference";
  if (CONSTANT_NAME.test(value)) return "constant-name";
  if (IDENTIFIER_PATH.test(value)) return "identifier-path";
  if (CALL_EXPRESSION.test(value)) return "expression";
  if (KEYWORD.test(value)) return "keyword";
  return value.length < 8 ? "too-short" : undefined;
}

function identifierAround(text: string, start: number, end: number): string {
  let left = start;
  while (left > 0 && IDENTIFIER_CHAR.test(text[left - 1]!)) left -= 1;
  return text.slice(left, end).replace(/^[.-]+/u, "");
}

function closingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index;
    else if (text[index] === "\n" || text[index] === "\r") return -1;
  }
  return -1;
}

function escapedClosingQuote(text: string, from: number, quote: string): number {
  const end = lineEnd(text, from);
  const index = text.indexOf(`\\${quote}`, from);
  return index === -1 || index > end ? -1 : index;
}

function lineEnd(text: string, from: number): number {
  const index = text.slice(from).search(/[\r\n]/u);
  return index === -1 ? text.length : from + index;
}
