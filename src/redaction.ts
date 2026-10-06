/**
 * Secret redaction shared by portable exports, Atlas reports and evidence packets.
 *
 * One implementation decides both what is redacted and what the final scan
 * rejects, so a sanitized document never fails its own scan. Known credential
 * formats are always redacted. Assignments to secret-named variables are
 * classified by context. A quoted value, or the value of a shell-style
 * assignment (`KEY=value`, `--key=value`), is scanned as a shell word: its
 * literal parts are redacted, complete environment references (`$VAR`,
 * `${VAR}`, `%VAR%`) stay, and in a parameter expansion only a literal default,
 * assigned or alternate word is redacted. In a code-style assignment
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
const UNQUOTED_VALUE = /^(?:Bearer\s+)?[^\s,;"'`)}\]]+/iu;
const CALL_EXPRESSION = /^(?:new\s+)?[A-Za-z_$][\w$.]*\(/u;
const KEYWORD = /^(?:null|undefined|true|false|none|nil|string|number|boolean|bigint|object|any|unknown|str|bytes|int|float|bool)$/iu;
const ENVIRONMENT_REFERENCE = /^(?:process\.env\b|os\.environ\b|os\.getenv\b|import\.meta\.env\b|Deno\.env\b|env\.|getenv\b|secrets\.)/u;
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
    for (const { start, end } of assignment.redactions) {
      rebuilt += `${output.slice(cursor, start)}${SECRET_PLACEHOLDER}`;
      cursor = end;
    }
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

type Range = { start: number; end: number };
type Assignment = { finding: SecretFinding; redactions: Range[] };

function scanAssignments(text: string): Assignment[] {
  const assignments: Assignment[] = [];
  SECRET_NAME.lastIndex = 0;
  for (let match = SECRET_NAME.exec(text); match !== null; match = SECRET_NAME.exec(text)) {
    const name = identifierAround(text, match.index, match.index + match[1]!.length);
    // `KEY=value` with nothing between name, operator and value is a shell, env-file, flag or query assignment.
    const shell = match[2] === "" && match[3] === "" && match[4] === "=" && match[5] === "";
    const start = match.index + match[0].length;
    // Command text often embeds JSON with escaped quotes: token=\"<value>\".
    const escaped = text[start] === "\\" && QUOTES.has(text[start + 1] ?? "");
    // Shell values, and code values that begin with an environment reference, follow shell quoting and expansion.
    if (!escaped && (shell || /^[$%]/u.test(text[start] ?? ""))) {
      const word = scanShellWord(text, start, lineEnd(text, start), "top");
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, word.end);
      const assignment = classifyWord(word, name, start);
      if (assignment !== undefined) assignments.push(assignment);
      continue;
    }
    const quote = text[escaped ? start + 1 : start] ?? "";
    if (QUOTES.has(quote)) {
      const valueStart = start + (escaped ? 2 : 1);
      const close = escaped ? escapedClosingQuote(text, valueStart, quote) : closingQuote(text, valueStart, quote);
      const valueEnd = close === -1 ? lineEnd(text, valueStart) : close;
      const value = text.slice(valueStart, valueEnd);
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, valueEnd);
      if (!escaped && quote !== "'" && /[$%]/u.test(value)) {
        const assignment = classifyWord(scanShellWord(text, valueStart, valueEnd, "double"), name, valueStart);
        if (assignment !== undefined) assignments.push(assignment);
        continue;
      }
      const rest = escaped ? [] : expressionLiterals(text, valueEnd + 1);
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, rest.end ?? valueEnd);
      // Values EBO already replaced were reported by the redaction that replaced them.
      if (EBO_PLACEHOLDER_PREFIX.test(value) && rest.length === 0) continue;
      const own = EBO_PLACEHOLDER_PREFIX.test(value) || QUOTED_PLACEHOLDER.test(value) ? [] : [{ start: valueStart, end: valueEnd }];
      assignments.push(own.length + rest.length === 0
        ? { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "placeholder" }, redactions: [] }
        : { finding: { kind: "secret-assignment", disposition: "redacted", name }, redactions: [...own, ...rest] });
      continue;
    }
    const raw = UNQUOTED_VALUE.exec(text.slice(start, start + 4096))?.[0];
    if (raw === undefined) continue;
    const bearer = /^Bearer\s+/iu.exec(raw)?.[0] ?? "";
    const value = raw.slice(bearer.length);
    SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, start + raw.length);
    if (EBO_PLACEHOLDER_PREFIX.test(value)) continue;
    const reason = notSecretReason(value);
    // A reference can be followed by more of the expression (`process.env.PREFIX + "literal"`); its literals count.
    const rest = expressionLiterals(text, start + raw.length);
    SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, rest.end ?? start + raw.length);
    const own = reason === undefined ? [{ start: start + bearer.length, end: start + raw.length }] : [];
    assignments.push(own.length + rest.length > 0
      ? { finding: { kind: "secret-assignment", disposition: "redacted", name }, redactions: [...own, ...rest] }
      : { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: reason! }, redactions: [] });
  }
  SECRET_NAME.lastIndex = 0;
  return assignments;
}

/**
 * String literals in the rest of a code expression, from `from` to the end of the statement: a newline, or `;`, `,`
 * or a closing bracket at bracket depth zero. Literal contents with letters or digits are returned for redaction,
 * except the key of a lookup that directly follows the value (`os.environ['NAME']`, `getenv("NAME", ...)`).
 */
function expressionLiterals(text: string, from: number): Range[] & { end?: number } {
  const literals: Range[] & { end?: number } = [];
  // The value token may already have consumed the opening bracket of a call or subscript (`os.getenv(`).
  const opened = text[from - 1] === "(" || text[from - 1] === "[";
  let depth = opened ? 1 : 0;
  let index = from;
  const lookup = (opened ? /^\s*/u : /^\s*[[(]\s*/u).exec(text.slice(from, from + 64));
  const keyAt = lookup === null ? -1 : from + lookup[0].length;
  for (; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\n" || character === "\r") break;
    if (QUOTES.has(character)) {
      const close = closingQuote(text, index + 1, character);
      const end = close === -1 ? lineEnd(text, index + 1) : close;
      const content = text.slice(index + 1, end);
      if (index !== keyAt && /[A-Za-z0-9]/u.test(content) && !EBO_PLACEHOLDER_PREFIX.test(content) && !QUOTED_PLACEHOLDER.test(content)) literals.push({ start: index + 1, end });
      index = end;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) { if (depth === 0) break; depth -= 1; }
    else if ((character === ";" || character === ",") && depth === 0) break;
  }
  literals.end = index;
  return literals;
}

type ShellWord = { source: string; start: number; end: number; literals: Array<Range & { quoted: boolean }>; references: number; incomplete: boolean };

/**
 * Scan one shell word from `start`: quoted strings, `$NAME`, `${...}` with balanced braces (its default or
 * assigned word may contain quotes and spaces) and `$(...)`. Literal text is collected for redaction; references are
 * counted. `top` ends at unquoted whitespace or a shell operator, `double` scans double-quoted content to `limit`.
 */
function scanShellWord(text: string, start: number, limit: number, mode: "top" | "double"): ShellWord {
  const word: ShellWord = { source: text, start, end: start, literals: [], references: 0, incomplete: false };
  word.end = scanWordPart(text, start, limit, word, mode);
  return word;
}

function scanWordPart(text: string, from: number, limit: number, word: ShellWord, mode: "top" | "brace" | "double"): number {
  let index = from;
  let literalStart = from;
  const quoted = mode === "double";
  const flush = (end: number) => { if (end > literalStart) word.literals.push({ start: literalStart, end, quoted }); };
  while (index < limit) {
    const character = text[index]!;
    if (mode === "top" && /[\s;&|<>()`]/u.test(character)) break;
    if (mode === "brace" && character === "}") break;
    if (mode === "double" && character === "\"") break;
    if (character === "\\") { index += 2; continue; }
    if (!quoted && character === "'") {
      flush(index);
      const close = text.indexOf("'", index + 1);
      const end = close === -1 || close >= limit ? limit : close;
      word.literals.push({ start: index + 1, end, quoted: true });
      if (end === limit) word.incomplete = true;
      index = end + 1;
      literalStart = index;
      continue;
    }
    if (!quoted && character === "\"") {
      flush(index);
      const end = scanWordPart(text, index + 1, limit, word, "double");
      if (end >= limit) word.incomplete = true;
      index = end + 1;
      literalStart = index;
      continue;
    }
    if (character === "%" || character === "$") {
      const rest = text.slice(index, Math.min(limit, index + 256));
      const simple = character === "%" ? /^%[A-Za-z_][A-Za-z0-9_]*%/u.exec(rest) : /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/u.exec(rest);
      if (simple !== null) {
        flush(index);
        word.references += 1;
        index += simple[0].length;
        literalStart = index;
        continue;
      }
      const braced = /^\$\{[#!]?[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
      if (braced !== null) {
        flush(index);
        word.references += 1;
        let cursor = index + braced[0].length;
        const operator = /^:?[-=+?]/u.exec(text.slice(cursor, cursor + 2))?.[0];
        if (operator !== undefined) cursor += operator.length;
        if (text[cursor] !== "}") {
          // `${NAME:?message}` carries an error message; other words (defaults, pattern operands) are literal.
          const before = word.literals.length;
          cursor = scanWordPart(text, cursor, limit, word, "brace");
          if (operator?.endsWith("?") === true) word.literals.length = before;
        }
        if (cursor >= limit || text[cursor] !== "}") word.incomplete = true;
        index = cursor + 1;
        literalStart = index;
        continue;
      }
      if (rest.startsWith("$(")) {
        // A command substitution can embed a credential; its text is literal.
        flush(index);
        let depth = 0;
        let cursor = index + 1;
        for (; cursor < limit; cursor += 1) {
          if (text[cursor] === "(") depth += 1;
          else if (text[cursor] === ")" && --depth === 0) break;
        }
        word.literals.push({ start: index + 2, end: Math.min(cursor, limit), quoted: false });
        if (cursor >= limit) word.incomplete = true;
        index = cursor + 1;
        literalStart = index;
        continue;
      }
    }
    index += 1;
  }
  flush(Math.min(index, limit));
  return Math.min(index, limit);
}

/**
 * Literal parts of a scanned value are redacted and complete references stay. An unterminated quote or expansion is
 * redacted whole. An unquoted literal shorter than eight characters with no reference is not a credential.
 */
function classifyWord(word: ShellWord, name: string, valueStart: number): Assignment | undefined {
  if (word.end <= valueStart) return undefined;
  const redacted = (redactions: Range[]): Assignment => ({ finding: { kind: "secret-assignment", disposition: "redacted", name }, redactions });
  if (word.incomplete) return redacted([{ start: word.start, end: word.end }]);
  const slice = ({ start, end }: Range) => word.source.slice(start, end);
  const literals = word.literals.filter((literal) => /[A-Za-z0-9]/u.test(slice(literal)) && !EBO_PLACEHOLDER_PREFIX.test(slice(literal)));
  if (literals.length === 0) {
    if (word.references > 0) return { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "environment-reference" }, redactions: [] };
    return word.literals.length > 0 ? undefined : { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "placeholder" }, redactions: [] };
  }
  const joined = literals.map(slice).join("");
  if (word.references === 0 && QUOTED_PLACEHOLDER.test(joined)) {
    return { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "placeholder" }, redactions: [] };
  }
  if (word.references === 0 && literals.every(({ quoted }) => !quoted) && joined.length < 8) {
    return { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "too-short" }, redactions: [] };
  }
  return redacted(literals.map(({ start, end }) => ({ start, end })));
}

function notSecretReason(value: string): NotSecretReason | undefined {
  if (value === "" || QUOTED_PLACEHOLDER.test(value) || /^[[<{(`]/u.test(value)) return "placeholder";
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
