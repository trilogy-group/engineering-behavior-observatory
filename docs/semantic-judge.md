# Evidence-grounded semantic judge

`ebo judge run` evaluates one declared behavior dimension against a bounded,
caller-selected projection of a qualified Claude Agent SDK run bundle and an
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

The only backend is the installed TypeScript Claude Agent SDK. The caller
supplies model, effort, wall-clock, turn, output, citation, and optional cost
limits. The runner passes no tools, settings sources, skills, plugins, MCP
servers, additional directories, or persistent session. It uses an empty
temporary working directory, strict empty MCP configuration, `dontAsk`
permissions, and a custom system prompt that treats the delimited trajectory
payload as untrusted data rather than instructions.

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
