# Optional Jev citation audits

Jev checks the factual support of a semantic judge's atomic claims. EBO validates
source citations and explicit workspace bindings first. The audit is advisory:
it never changes the assertion, behavioral assessment, aggregation denominator,
or human calibration state. Confidence is recorded, never an acceptance rule.

## Run

```sh
ebo judge run <bundle> <observations.json> <request.json> <new-judgment-root>
ebo shadow run <bundle> <new-judgment-root/assertion.json> <new-audit.json>
```

Set `TYPESAFE_API_KEY` in the calling environment. The adapter uses the fixed
`jev-1.13.0` model and `https://api.typesafe.ai/v1/systemone`. Each claim gets one
Choice question against its own citations, with `supports`, `contradicts`, and
`insufficient` outcomes. See the [API](https://docs.typesafe.ai/api) and
[Choice contract](https://docs.typesafe.ai/primitives/choice).

The retained audit includes the assertion digest, exact claim citations, native
record digests, projected evidence, request, response, probabilities, confidence,
usage and elapsed time. Reasoning, credentials and local identifiers are removed
from outbound state using the existing export sanitizer. Native bundles remain
immutable. Audit and review files are restricted local artifacts, not approved
partner exports.

Records preserve short metadata and the head and tail of long strings. Marked
omissions are evidence limitations. The adapter allows 8192 characters per record,
28000 UTF-8 bytes per request, 65536 response bytes, and 30 seconds per call.
Oversized evidence and provider errors produce failed audit entries, not votes.
There is no automatic retry or fallback. Interrupted CLI runs retain completed
entries and mark remaining claims failed. Repeat a run into a new output file.

Legacy assertions remain valid. To audit one, rerun the semantic judge with the
new prompt; do not infer claim boundaries by splitting old rationale text.

## Resolve findings

Review both flagged claims and a sample of `supports` answers against the full
native evidence. Record one review file per claim:

```json
{
  "schemaVersion": "ebo.shadow-review/v1",
  "auditDigest": "sha256:<canonical audit digest>",
  "claimId": "claim-1",
  "reviewer": { "kind": "human", "id": "reviewer-id" },
  "verdict": "unsupported",
  "cause": "citation-gap",
  "rationale": "The claim requires the later test result; this citation is a collection-only run.",
  "reviewedAt": "2026-09-22T12:00:00Z"
}
```

Use `shadowDigest(audit)` from the package API to obtain the canonical digest.
`verdict` is `supported`, `unsupported`, or `unresolved`. Causes are `none`,
`citation-gap`, `truncation`, `judge-error`, `jev-error`, or `workspace-mismatch`.
Use `reviewer.kind: "model"` for agent reviews. Optional `durationMs` and
`baselineDurationMs` record measured review and comparable unaided review times.

```sh
ebo shadow review <audit.json> <review.json> <new-retained-review.json>
```

Binding checks reject stale audits and unknown claim IDs. Files are write-once.
If a decision changes, retain a new review and explicitly select it for the
report; multiple resolutions for the same claim are rejected. A citation repair
or revised behavioral judgment is a new assertion, followed by a new audit.

Atlas requests accept optional sources:

```json
"shadowAudits": [
  { "audit": "audit.json", "reviews": ["retained-review.json"] }
]
```

The case shows Jev's outcome, claim, citations, projected evidence, and resolution.
Behavioral scores remain those of the semantic judge. Shared Atlas summaries
exclude these audit details along with other unapproved semantic evidence.

## Freeze and evaluate a holdout

Select independent attempts across tasks and harnesses before viewing Jev answers.
Keep the development examples used to change prompts in a separate population.
Create a source file with `population: "holdout"` (or `"development"`) and a
`sources` array of `{bundleRoot, assertion, task, harness}`. Paths are relative to
that file; task and harness must match the retained manifest.

```sh
ebo shadow select <sources.json> <new-selection.json>
```

The selection records exact assertion digests and a timestamp. Run the selected
audits, review supported and flagged claims, then create summary sources:

```json
{
  "selection": "selection.json",
  "audits": ["audit.json"],
  "reviews": ["retained-review.json"]
}
```

```sh
ebo shadow summarize <summary-sources.json> <new-summary.json>
```

Holdout summaries reject audits started before the selection. The operator must
also keep development and holdout attempts disjoint; timestamps alone do not
prove independence. Metrics include flag precision, missed unsupported claims,
false supports, review coverage, causes, failures, tasks and harnesses. Every rate
includes its denominator; zero-denominator metrics are null. Timing savings are
null without paired baseline measurements. Mixed/model review populations are
explicit and do not constitute human calibration.

Expand the reviewed sample before setting routing thresholds. Promote a use only
when its false-support rate, flag precision and review cost meet the study's
predeclared acceptance criteria. This integration has no automatic promotion path.
