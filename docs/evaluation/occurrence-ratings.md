# Occurrence ratings and judge preparation

[Occurrences](structural-observations.md#occurrences) cut an attempt into
instances: one failure and the call that followed, one test run, one source
change. Occurrence ratings answer a few small typed questions about each
instance with a System One decision model. `ebo judge prepare` then builds a
judge request that shows the judge every occurrence of the relevant types as a
compact row, with its ratings, plus full native records for the occurrences that
need a closer look.

Ratings are evidence, not behavior assertions. They carry no rationale or
alternative explanation and never replace the judge's assessment.

## Decision-model providers

`src/decision-models.ts` sends one state and its typed questions (Choice, Noul,
Score) in a single request and validates every answer against the questions:
declared options, probabilities in range and summing to 1 within provider
rounding, and token usage. The fixed provider registry:

| Provider | Endpoint | Credential | Model |
| :--- | :--- | :--- | :--- |
| `typesafe` (Jev) | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-1.13.0` unless `--model` |
| `fireworks` | `https://api.fireworks.ai/inference/v1/systemone` | `FIREWORKS_API_KEY` | `FIREWORKS_SYSTEMONE_MODEL` or `--model` |

Each call is retained as an `ebo.decision-record/v1`: the exact request, the
raw response, every non-2xx response (status and bounded, redacted body), the
answering model, usage, duration and attempts. Responses 429,
502 and 503 are retried up to three times, honoring `Retry-After`. A failed call
is recorded as failed and never becomes an answer; credentials never appear in
records.

## Questions

Question set `1.0.0`:

| Occurrence | Question | Answers |
| :--- | :--- | :--- |
| `failure-response` | `response`: what the next call did about the failure | `addressed-cause`, `retried-unchanged`, `different-approach`, `unclear` |
| `validation-run` | `outcome`: the result the output shows | `all-passed`, `some-failed`, `not-completed`, `no-result-shown` |
| `validation-run` | `targeted`: whether the checks are limited to named files, tests or patterns | yes / no |
| `source-change` | `kind`: the kind of file changed | `implementation`, `test`, `configuration`, `documentation`, `other` |
| `repeated-operation` | `repeat`: why the identical call was repeated | `rerun-after-change`, `polling`, `redundant`, `unclear` |

Facts that code already knows are supplied, not asked: failure flags, exit
codes, check kinds, and the number of source changes between a call and its
repeat. A failure with no later call of the tool is rated `no-response` by
rule. Compactions and delegations are structural only.

The state for one occurrence lists its calls with their inputs and outputs as
text. Hidden reasoning is never included. Long inputs and outputs keep their
head and tail with a marked omission so the request fits the provider's context;
this bounds the request only, and stored evidence stays complete.

## Acceptance policy

A Choice answer is accepted at confidence 0.8 or above; a Noul answer when its
probability is at least 0.4 away from 0.5. Both thresholds are flags. Answers
below the policy are kept with `accepted: false` so a reasoning model or the
judge can treat them as uncertain. The policy is recorded in the artifact, and
validation rejects a rating whose `accepted` flag contradicts it.

```sh
ebo occurrences rate <run-bundle-root> <observations.json> <ratings.json> --provider typesafe
ebo occurrences rate <run-bundle-root> <observations.json> <ratings.json> --provider fireworks --choice-confidence 0.9
```

The observation set must equal the one rebuilt from the bundle. The
`ebo.occurrence-ratings/v1` artifact binds to the observation-set and dataset
digests and holds every rating with its decision record. While the command runs,
each finished decision is appended to `<output>.decisions.partial.jsonl`; the
log is removed once the artifact is written, so an interrupted run keeps every
completed call. The command refuses a destination whose partial log already
exists. Validation derives each label from its answer and accepts rule ratings
only for known rules. The command exits non-zero when any decision failed; the
artifact still records them.

## Judge preparation

```sh
ebo judge prepare <run-bundle-root> <observations.json> <spec.json> <request.json> [--ratings <ratings.json>]
ebo judge run <run-bundle-root> <observations.json> <request.json> <output-root> [--ratings <ratings.json>]
```

The spec (`ebo.judge-prepare-spec/v1`) holds the request fields (behavior,
rubric, evaluator, limits, blinding) and the occurrence types for the ledger.
The prepared request records:

- `selection.occurrences`: the ledger types and, with ratings, their digest.
  `judge run` requires exactly those ratings.
- `selection.eventIds`: full native records chosen in tiers until
  `limits.maxEvidenceItems` events, whole occurrences only: the first user
  message and last two model messages; failure responses, failed validation
  runs and adverse or low-confidence ratings; the last validation run of each
  check kind; then evenly spaced remaining occurrences.
- `selection.frame`: the method and, per type, the population, ledger rows
  (always the whole population) and occurrences given in full. A requested type
  the adapter does not expose stays in the frame with its `unavailable` reason,
  so the judge can abstain instead of reading the gap as absence. The judge
  input recomputes `fullRecords` after packaging: an occurrence counts only when
  all of its events arrived untruncated.

The judge input carries the ledger as `occurrence-ledger` evidence items of
whole rows. Ledger rows are never dropped or cut: when they do not fit
`maxInputChars`, or one row exceeds `maxRecordChars`, packaging fails before the
judge is called and the limit must be raised. Each row lists the occurrence's
events and names one the judge may cite; a citation with `occurrenceId` must use
that event or another event of the occurrence included as a full record. Inputs
with a ledger use prompt version `1.1.0`, which is part of the assertion's
evaluator configuration digest. The citation cap is the request's
`maxCitations` (up to 64).
