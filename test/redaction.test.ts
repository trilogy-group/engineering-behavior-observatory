import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDerivedExport, type LocatedSecretFinding } from "../src/exports.js";
import { containsSecret, redactSecrets, type SecretFinding } from "../src/redaction.js";

const policy = { sharingClass: "partner" as const, maxArtifactBytes: 1024 * 1024, maxStringBytes: 64 * 1024 };

function redact(text: string): { text: string; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  const result = redactSecrets(text, (finding) => findings.push(finding));
  assert.equal(containsSecret(result.text), false, `redacted text still fails the scan: ${result.text}`);
  return { text: result.text, findings };
}

test("redacts known credential formats and keeps their kind", () => {
  const cases: Array<[string, string, SecretFinding["kind"]]> = [
    ["sk-ant-EBO-SENTINEL-CREDENTIAL-0001", "sk-ant-EBO-SENTINEL", "anthropic-api-key"],
    ["export FIREWORKS=fw_SyntheticPlantedKey0123456789", "fw_Synthetic", "fireworks-api-key"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz123456", "ghp_abcdef", "github-token"],
    ["sk-proj-abcdefghijklmnopqrstuvwxyz0123", "sk-proj-abc", "openai-style-api-key"],
    ["xoxb-1234567890-abcdefghij", "xoxb-1234567890", "slack-token"],
    [`key AIza${"A1b2C3d4E5".repeat(3)}abcde`, "AIzaA1b2", "google-api-key"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl", "eyJhbGciOiJIUzI1NiJ9", "jwt"],
    ["curl -H 'X-Auth: Bearer abcdefghijklmnopqrstuvwxyz0123'", "abcdefghijklmnopqrstuvwxyz0123", "bearer-token"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA==", "authorization-header"],
    ["-----BEGIN PRIVATE KEY-----\ncHJpdmF0ZQ==\n-----END PRIVATE KEY-----", "cHJpdmF0ZQ==", "private-key"],
  ];
  for (const [input, leaked, kind] of cases) {
    const { text, findings } = redact(input);
    assert.equal(text.includes(leaked), false, `${kind} leaked`);
    assert.ok(text.includes("[REDACTED_SECRET]"));
    assert.ok(findings.some((finding) => finding.kind === kind && finding.disposition === "redacted"), kind);
  }
});

test("reports secret-named references as not secret and leaves them intact", () => {
  const cases: Array<[string, string, string]> = [
    ["const sessionApiKey = /const sessionAuth = /", "sessionApiKey", "too-short"],
    ["const client = new Client({ apiKey: input.apiKey });", "apiKey", "identifier-path"],
    ["const token = getToken(scope);", "token", "expression"],
    ["type Config = { apiKey: string };", "apiKey", "keyword"],
    ["const apiKey = process.env.FIREWORKS_API_KEY;", "apiKey", "environment-reference"],
    ["api_key = os.environ['FIREWORKS_API_KEY']", "api_key", "environment-reference"],
    ["export FIREWORKS_API_KEY=$FIREWORKS_TOKEN", "FIREWORKS_API_KEY", "environment-reference"],
    ["token = DEFAULT_TOKEN_NAME", "token", "constant-name"],
    ["max_token: 4096", "max_token", "too-short"],
    ["password: \"<your password>\"", "password", "placeholder"],
    ["apiKey: [LOCAL_PATH]", "apiKey", "placeholder"],
  ];
  for (const [input, name, reason] of cases) {
    const { text, findings } = redact(input);
    if (reason === "placeholder" && input.includes("[LOCAL_PATH]")) {
      assert.deepEqual(findings, [], "EBO's own markers are not findings");
      assert.equal(text, input);
      continue;
    }
    assert.equal(text, input, `${input} was changed`);
    assert.deepEqual(findings, [{ kind: "secret-assignment", disposition: "not-secret", name, reason }], input);
  }
  for (const comparison of ["if (sessionApiKey === undefined) {}", "apiKey => apiKey.trim()", "token != null"]) {
    assert.deepEqual(redact(comparison).findings, [], comparison);
  }
});

test("redacts secret-named assignments whose values look like secrets", () => {
  const cases: Array<[string, string]> = [
    ["password=\"correct horse battery staple\"", "correct horse battery staple"],
    ["refresh_token=generic-token-value-12345", "generic-token-value-12345"],
    ["id_token='generic-token-value-12345'", "generic-token-value-12345"],
    ["curl -d \"{\\\"token\\\":\\\"abc123secretvalue\\\",\\\"n\\\":1}\"", "abc123secretvalue"],
    ["export SERVICE_API_KEY=a8f3k29dk3m2x9", "a8f3k29dk3m2x9"],
    ["export SERVICE_API_KEY=SYNTHETICUPPERCASECREDENTIAL", "SYNTHETICUPPERCASECREDENTIAL"],
    ["password=correcthorsebatterystaple", "correcthorsebatterystaple"],
    ["const fixture = 'api_key=syntheticcredential;'", "syntheticcredential"],
    ["curl 'https://example.test/hook?token=abcdef.ghijkl.mnopqr'", "abcdef.ghijkl.mnopqr"],
    ["deploy --api-key=letteronlycredential", "letteronlycredential"],
    ["return { sessionApiKey: sessionAuth };", "sessionAuth"],
    ["authorization=Bearer syntheticcredentialvalue", "syntheticcredentialvalue"],
  ];
  for (const [input, value] of cases) {
    const { text, findings } = redact(input);
    assert.equal(text.includes(value), false, `${input} leaked`);
    assert.ok(findings.some(({ disposition }) => disposition === "redacted"), input);
  }
  assert.equal(redact("curl -d \"{\\\"token\\\":\\\"abc123secretvalue\\\",\\\"n\\\":1}\"").text,
    "curl -d \"{\\\"token\\\":\\\"[REDACTED_SECRET]\\\",\\\"n\\\":1}\"");
});

test("derived exports redact and continue on cited command text, recording each match", () => {
  const command = "cd /workspace; sed -i '196s/const sessionApiKey = /const sessionAuth = /; 233s/{ sessionApiKey }/{ sessionApiKey: sessionAuth }/' src/queue.ts"
    + " && ANTHROPIC_API_KEY=sk-ant-EBO-SENTINEL-CREDENTIAL-0001 FIREWORKS=fw_SyntheticPlantedKey0123456789 npm test";
  const findings: LocatedSecretFinding[] = [];
  const output = sanitizeDerivedExport(
    { message: { content: [{ type: "tool_use", input: { command } }] } },
    policy,
    [],
    (finding) => findings.push(finding),
  ) as { message: { content: Array<{ input: { command: string } }> } };
  const sanitized = output.message.content[0]!.input.command;
  assert.equal(sanitized.includes("sk-ant-EBO-SENTINEL"), false);
  assert.equal(sanitized.includes("fw_Synthetic"), false);
  assert.ok(sanitized.includes("{ sessionApiKey: [REDACTED_SECRET] }"), "a bare word in a code assignment is redacted, not guessed to be an identifier");
  const path = "/message/content/0/input/command";
  assert.deepEqual(findings.filter(({ disposition }) => disposition === "not-secret").map(({ path: at, ...finding }) => ({ at, ...finding })), [
    { at: path, kind: "secret-assignment", disposition: "not-secret", name: "sessionApiKey", reason: "too-short" },
  ]);
  assert.deepEqual(findings.filter(({ disposition }) => disposition === "redacted").map(({ kind, path: at }) => [kind, at]), [
    ["anthropic-api-key", path],
    ["fireworks-api-key", path],
    ["secret-assignment", path],
  ]);
  assert.equal(JSON.stringify(findings).includes("SENTINEL"), false, "findings never retain matched values");

  const fields: LocatedSecretFinding[] = [];
  sanitizeDerivedExport({ env: { apiKey: "anything" } }, policy, [], (finding) => fields.push(finding));
  assert.deepEqual(fields, [{ kind: "secret-field", disposition: "redacted", name: "apiKey", path: "/env/apiKey" }]);
});

test("environment references stay while literal fallbacks inside parameter expansions are redacted", () => {
  const kept: Array<[string, string]> = [
    ["API_KEY=\"$API_KEY\"", "API_KEY"],
    ["API_KEY=\"${API_KEY}\"", "API_KEY"],
    ["export API_KEY=${API_KEY}", "API_KEY"],
    ["TOKEN=\"${TOKEN:?TOKEN is required}\"", "TOKEN"],
    ["TOKEN=${TOKEN:-$FALLBACK_TOKEN}", "TOKEN"],
    ["set PASSWORD=%PASSWORD%", "PASSWORD"],
  ];
  for (const [input, name] of kept) {
    const { text, findings } = redact(input);
    assert.equal(text, input, `${input} was changed`);
    assert.deepEqual(findings, [{ kind: "secret-assignment", disposition: "not-secret", name, reason: "environment-reference" }], input);
  }
  const redactedWords: Array<[string, string]> = [
    ["API_KEY=\"${API_KEY:-EBO_FALLBACK_SECRET_123456}\"", "API_KEY=\"${API_KEY:-[REDACTED_SECRET]}\""],
    ["export API_KEY=${API_KEY:-EBO_FALLBACK_SECRET_123456} && run", "export API_KEY=${API_KEY:-[REDACTED_SECRET]} && run"],
    ["TOKEN=${TOKEN:=correcthorse}", "TOKEN=${TOKEN:=[REDACTED_SECRET]}"],
    ["password: ${DB_PASSWORD:-hunter2pass}", "password: ${DB_PASSWORD:-[REDACTED_SECRET]}"],
    ["PASSWORD=${PASSWORD:-\"correct horse battery staple\"} run", "PASSWORD=${PASSWORD:-\"[REDACTED_SECRET]\"} run"],
    ["API_KEY=${API_KEY}EBO_LITERAL_SECRET_123456", "API_KEY=${API_KEY}[REDACTED_SECRET]"],
    ["API_KEY=$KEY_PREFIX-EBO_LITERAL_SECRET_123456", "API_KEY=$KEY_PREFIX[REDACTED_SECRET]"],
    ["API_KEY=$SAFE:correcthorsebatterystaple", "API_KEY=$SAFE[REDACTED_SECRET]"],
    ["TOKEN=${TOKEN:-incomplete fallback", "TOKEN=[REDACTED_SECRET]"],
  ];
  for (const [input, expected] of redactedWords) {
    const { text, findings } = redact(input);
    assert.equal(text, expected);
    assert.ok(findings.some(({ disposition }) => disposition === "redacted"), input);
    assert.equal(containsSecret(input), true, `the final scan rejects ${input}`);
    assert.equal(containsSecret(text), false, `the final scan accepts ${text}`);
  }
});
