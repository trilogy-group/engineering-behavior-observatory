# Third-party provider routes

Sanitized examples of routing an EBO harness to a non-default provider. They
contain no credentials, no local absolute paths, and no task material. Copy a
record into a caller-owned bundle, replace the model IDs and executable path
with real values, compute the normal EBO artifact digests, and reference it from
the experiment's model/harness/etc. fields.

| Harness | File | Notes |
| :--- | :--- | :--- |
| Codex | [`codex/model.json`](codex/model.json), [`codex/harness.json`](codex/harness.json), [`codex/responses-normalizer.mjs`](codex/responses-normalizer.mjs) | Responses API provider, `env_key` credential, launch config, optional wire shim |
| Pi | [`pi/model.json`](pi/model.json) | OpenAI-completions route registered by name |
| DeepSeek | [`deepseek/xai.cordis.patch.yml`](deepseek/xai.cordis.patch.yml), [`deepseek/model.json`](deepseek/model.json) | Cordis provider patch |

## Credential handling

Every record names an environment variable, never a value. Exported variables
must also appear in the Harbor worker runtime `environmentKeys` (or the local
run environment) for the value to reach the harness. The Codex adapter copies
only the variable named by `credentialEnv`; the Pi and DeepSeek records name
`apiKeyEnv`/`env_key`.

## Codex specifics

- Codex supports only `wire_api = "responses"`. A provider must accept
  Codex's tool and reasoning item shapes.
- Launch-level config (`features.*`, `web_search`) belongs in the harness
  record's `arguments`; the thread `config` bag does not apply it.
- `features.multi_agent=false` and `features.apps=false` remove `namespace`
  tools that non-OpenAI Responses endpoints reject; `web_search=disabled`
  removes the hosted search tool.
- With `credentialEnv` set, the adapter does not symlink the ChatGPT
  `auth.json`, so account connector apps stay out of the request.
- Some Responses providers reject Codex's replayed reasoning item when its
  optional `content` is serialized as JSON `null` (xAI: `Could not decode the
  compaction blob`). `codex/responses-normalizer.mjs` is a one-field,
  operator-side shim for that strictness; prefer it over patching the adapter.

These routes are experimental. Verify a provider's Responses interop end to end
before trusting a comparison; see
[the Codex harness guide](../../docs/harnesses/codex-harness.md).
