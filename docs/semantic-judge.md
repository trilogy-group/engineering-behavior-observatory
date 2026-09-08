# Evidence-grounded semantic judge

`ebo judge run` evaluates one declared behavior dimension against a bounded,
caller-selected projection of a qualified Claude Agent SDK, Codex, OpenHands,
or DeepSeek retained run bundle and an
`ebo.structural-observation-set/v1` file:

```sh
node dist/src/cli.js judge run \
  <run-bundle-root> <observations.json> <request.json> <output-root>
```

The output root must not exist and must be outside the immutable run bundle.
Every rerun therefore creates a new record. Runs with the same rubric,
selection, limits, and evidence share an input digest even when their output
roots or judge identities differ.

## Request

The request is caller-owned configuration; EBO does not select a study model
or retry a judgment:

```json
{
  "schemaVersion": "ebo.semantic-judge-request/v1",
  "id": "verification-run-001",
  "behavior": {
    "vocabularyVersion": "1.0.0",
    "categoryId": "verification-completion",
    "dimensionId": "verification-completion"
  },
  "rubric": {
    "id": "verification-rubric",
    "version": "1.0.0",
    "instructions": "Assess whether retained evidence shows validation before completion."
  },
  "evaluator": {
    "provider": "anthropic",
    "model": "<existing authenticated Claude Agent SDK route>",
    "effort": "low"
  },
  "selection": {
    "eventIds": ["<normalized-event-id>"],
    "structuralObservationIds": ["<structural-observation-id>"],
    "includeOutcomeObservations": true
  },
  "limits": {
    "maxEvidenceItems": 16,
    "maxRecordChars": 4096,
    "maxInputChars": 64000,
    "maxOutputChars": 8192,
    "maxCitations": 8,
    "maxWallClockMs": 30000,
    "maxTurns": 1,
    "maxBudgetUsd": 0.1
  },
  "blinding": { "evaluatedModelIdentity": "redact" }
}
```

Selection is exact. Unknown IDs fail before execution. Optional outcome
observations are added only when requested, and the total must remain within
`maxEvidenceItems`. Per-record truncation and whole-input omission are recorded
in `input.json`; omitted event IDs cannot be cited. Exact evaluated-model
strings are redacted from evidence values and keys when requested. Citation
IDs and native references are never rewritten, and the input records the
remaining harness, native-type, behavioral, and citation clues that may still
reveal origin.

Selected structural observations automatically include their normalized source
events so their claims remain citable. An explicitly selected observation with
no normalized source event, including an exact zero fact, is rejected before
execution; the same kind of automatically included outcome is recorded as
omitted instead of being shown to the judge as uncitable support.

## Backend and trust boundary

The default backend is the installed TypeScript Claude Agent SDK. The caller
supplies model, effort, wall-clock, turn, output, citation, and optional cost
limits. The runner passes no tools, settings sources, skills, plugins, MCP
servers, additional directories, or persistent session. It uses an empty
temporary working directory, strict empty MCP configuration, `dontAsk`
permissions, and a custom system prompt that treats the delimited trajectory
payload as untrusted data rather than instructions.

The SDK subprocess inherits the parent environment for authentication and
routing, but EBO removes ambient model and effort override variables before
launch so the caller request remains authoritative. The retained evaluator
metadata records that policy without retaining secret values.
Ambient OpenTelemetry and Claude telemetry/tracing controls are also removed;
restricted rubric and trajectory content is never sent to a parent-configured
collector, and a console exporter cannot corrupt the SDK protocol channel.

For the native Codex backend, set `evaluator.backend` to `codex-app-server`,
`provider` to `openai`, and supply `model` and `effort`. The optional
`executable` selects the installed `codex` executable (default: PATH); its version
must be `0.150.1`. Set `maxTurns` to `1` and omit `maxBudgetUsd`: this backend
does not support USD budget enforcement. No automatic provider fallback occurs.
Backend selection is independent of the evaluated harness.
The selected model must exist in the pinned executable's bundled catalog.
EBO copies that exact entry into a temporary catalog with apply-patch and
experimental tool declarations removed; its digest is retained with the raw
runtime response. Unknown catalog models fail before a turn starts.

Codex owns a fresh stdio app-server child with an empty working directory and
temporary HOME/CODEX_HOME. Only an existing `auth.json` login is copied into it;
personal settings, plugins, MCP, hooks, memories, shell, browser, image,
delegation, plan, and interactive tools are disabled. The child environment
allows only PATH, locale, and temporary-directory variables. Analytics and
telemetry exporters are disabled. The thread is ephemeral with no instruction
sources, read-only sandbox and no sandbox network access; supplied evidence
enters only through the prompt. Unexpected tool requests fail the judgment.
Timeouts interrupt the owned turn and reap the process group before deleting
the temporary home. Missing cost/API timing remains unavailable.
`runRetainedSemanticJudge` also accepts an optional `signal`; CLI SIGINT and
SIGTERM propagate through it to either backend. Interrupted calls retain a
failed record and bounded received output. Timeout and interruption take
precedence over a late successful terminal message; native startup probes
consume the same wall-clock budget as the turn.

The native structured response uses `turn/start.outputSchema` and completion
must match both owned thread and turn IDs. See the
[official app-server contract](https://developers.openai.com/codex/app-server/).
New assertions carry optional `evaluator.configurationDigest`, binding the
prompt version, rubric instructions, evaluator parameters, limits and blinding.
Existing v1 requests and assertions remain readable without rewriting them.

The response can contain only an assessed proposal or an abstention. Assessed
responses require confidence, rationale, an alternative explanation, and at
least one packaged citation. Abstentions require a reason, rationale, and
alternative explanation and may cite packaged events. Extra fields such as a
claimed `confirmed` review state are rejected. The runner constructs trusted
run, attempt, dataset, rubric, behavior, and evaluator bindings itself, then
calls `validateBehaviorAssertion`; fabricated, stale, foreign, digest-mismatched,
or ownership-invalid citations cannot produce a proposed assertion.

## Retention

Raw input and output files are mode `0600` and marked `restricted`. A valid
response writes `input.json`, `raw-response.json`, `assertion.json`, and
`judgment.json`. Malformed responses, invalid citations, provider errors, and
timeouts instead write `failure.json` beside any bounded raw output. No failed
record enters review, no retry occurs, and native evidence is never changed.
Timing, cost, and usage are recorded only when the backend reports them;
otherwise the record says they are unavailable.

`ebo.semantic-judge-request/v1`, `ebo.semantic-judge-input/v1`, and
`ebo.semantic-judgment/v1` are registered artifacts and can be independently
checked with `ebo validate`.

This runner does not confirm assertions, create human reviews, adjudicate,
aggregate rates, build an Atlas, or publish evidence.

The opt-in live wiring test requires an already authenticated route discovered
by the operator; it never invents a model ID:

```sh
EBO_LIVE_SEMANTIC_JUDGE_SMOKE=1 \
EBO_LIVE_SEMANTIC_JUDGE_MODEL='<existing-route>' \
node --test --test-name-pattern='approved live semantic judge smoke' \
  dist/test/semantic-judge.test.js
```

The optional installed-runtime contract test intercepts a synthetic local
model request, uses a dummy credential, and verifies an empty tool list:

```sh
EBO_NATIVE_CODEX_CONTRACT=1 node --test dist/test/codex-judge.test.js
EBO_LIVE_CODEX_JUDGE_SMOKE=1 EBO_LIVE_CODEX_JUDGE_MODEL='<existing-route>' \
  node --test --test-name-pattern='approved existing-auth' dist/test/codex-judge.test.js
```
