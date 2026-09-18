# EBO 1.0.2

Behavioral and provider-routing corrections. Runtime pins, schemas, and
contracts are unchanged from v1.0.1.

## Changes

- **DeepSeek inactivity window (fix).** `activityTimeoutMs` is now an
  inactivity window that restarts on every retained notification, with a
  supplied context budget kept as an overall cap. Previously the adapter set one
  absolute deadline after `session/prompt` and never extended it, so a long but
  continuously streaming turn was truncated at a fixed duration and reported
  `stopReason: budget`. A spaced-activity fixture covers the corrected behavior.
- **Codex third-party provider routes (feature).** A Codex model record may
  declare any provider id, an optional `config` bag (`model_providers`,
  `model_context_window`, `model_auto_compact_token_limit`), and a
  `credentialEnv`. The adapter forwards that credential into the isolated child
  and, for such routes, no longer symlinks the ChatGPT `auth.json`, so provider
  auth and account connector apps stay out of the request. A harness record may
  pass recorded launch arguments to the `app-server` subcommand
  (`features.*`, `web_search`). Applied provider, model, and effort are still
  verified from native evidence.
- **Sanitized route examples (docs).** `examples/third-party-provider-routes/`
  adds credential- and path-free Codex, Pi, and DeepSeek provider records, plus a
  minimal Responses normalization example for a provider that rejects a
  replayed reasoning item serialized with `content: null`.
- **Harbor runbook (docs).** Records that a control-runtime venv must live
  outside temporary storage, and that a `changed` snapshot status is often a
  missing `EBO_HARBOR_PYTHON`/`SMOLVM_LIB_DIR` rather than content drift.
- **Codex harness guide (docs).** Documents third-party provider routes, that
  Codex 0.153.4 is Responses-only, and the localized reasoning-replay
  incompatibility.

## Verification

`npm run acceptance` runs from a clean checkout on the pinned Node 24.19.0: the
deterministic suite, fixture digests, documentation links, package scan, and two
byte-identical package builds. Results are written under
`.ebo/releases/1.0.2/`. The prior suite passed at 667 tests with 12 opt-in skips.

No provider-route behavior is a clean native route for every provider. The xAI
Codex route required operator-side request normalization for one incompatibility;
the route stays experimental until its Responses interop is verified end to end.
See the [v1.0.0 support boundary](../1.0.0/KNOWN_LIMITATIONS.md).

## Reproducibility

[`reproducibility.json`](reproducibility.json) pins the runtime versions,
commands, determinism exclusions, and fixture digests for this release.
