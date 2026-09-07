# Human calibration and adjudication

EBO supplies a local, static workflow for people to review evidence-grounded
behavior assertions. It does not assign reviewers, authenticate users, host a
review service, or treat synthetic fixture decisions as research labels.

## Select a reproducible sample

Create a source file that points to capture-qualified Agent SDK bundles and
their judge-produced assertions. Paths are local operator inputs; native
evidence is revalidated through the existing assertion resolver before a
candidate can enter a sample.

```json
{
  "schemaVersion": "ebo.review-source-set/v1",
  "sources": [
    {
      "bundleRoot": "/local/restricted/runs/run-1",
      "assertionPath": "/local/restricted/judgments/run-1/assertion.json",
      "taskContext": "Reviewable task prompt or bounded operator-authored task synopsis."
    }
  ]
}
```

Sampling criteria use explicit, non-overlapping strata. Each stratum has its
own requested size and may filter by task, model, harness, verifier outcome,
terminal state, behavior category, confidence, or judge abstention. A single
stratum with empty filters is an unstratified sample.

```json
{
  "schemaVersion": "ebo.review-sample-criteria/v1",
  "seed": "study-2026-09-wave-1",
  "strata": [
    {
      "id": "high-confidence-verification",
      "sampleSize": 20,
      "filters": {
        "categoryIds": ["verification-completion"],
        "confidence": { "min": 0.75 },
        "abstentions": [false]
      }
    },
    {
      "id": "judge-abstentions",
      "sampleSize": 10,
      "filters": { "abstentions": [true] }
    }
  ]
}
```

```sh
node dist/src/cli.js calibration sample sources.json criteria.json selection.json
```

The saved selection retains the criteria and seed, every source root, source and
eligible population sizes, eligible and selected assertion IDs, per-stratum requested,
eligible, and selected counts, and any zero-candidate strata. Ordering is a
SHA-256 function of the seed, stratum, assertion ID, and assertion digest.
Repeated request-derived assertion IDs across runs remain distinct through
their digest-bound identity. Where a CLI selector is ambiguous, append the
digest as `<assertion-id>@sha256:<digest>`.
Observational runs always record verifier outcome as `unavailable`; normal
completion is never substituted for verifier success.

## Generate and inspect a static packet

```sh
node dist/src/cli.js calibration packet selection.json review-packet
open review-packet/index.html
node dist/src/cli.js calibration inspect \
  review-packet/packet.json <assertion-id> [event-id]
```

`index.html` contains the supplied task context, condition context, assertion,
rationale, alternative explanation, and links to local pages that render the
exact cited native records. Each evidence page also links to its source artifact
and names the native locator. All task, assertion, and evidence content is
HTML-escaped. Links remain relative to the packet and its declared local bundle
root. The packet copies only cited records, keeps them `restricted-local-only`
with mode `0600`, and is not a partner or public export. Moving the packet
separately from its source bundles breaks the original-artifact links by design.
Packet files are staged together and the completed directory is published in
one rename, so `packet.json` never names partially rendered evidence pages.
All selection, packet, history, and summary destinations are rejected when they
would be written inside a source run bundle.

## Import human decisions

Get the exact assertion and current history bindings without manufacturing a
decision:

```sh
node dist/src/cli.js calibration binding selection.json <assertion-id>
node dist/src/cli.js calibration binding selection.json <assertion-id> history.json
```

A person supplies the reviewer identity, timestamp, decision, and rationale.
`insufficient-evidence` is the human abstention state. The first decision uses
`previousHistory: null`; later decisions use the binding printed for the
current history.

```json
{
  "schemaVersion": "ebo.human-review-decision/v1",
  "id": "review-001",
  "kind": "review",
  "assertion": {
    "id": "<assertion-id>",
    "schemaVersion": "ebo.behavior-assertion/v1",
    "digest": "sha256:<assertion-digest>"
  },
  "reviewer": { "kind": "human", "id": "<reviewer-id>" },
  "decidedAt": "2026-09-07T12:00:00Z",
  "state": "confirmed",
  "rationale": "<human-authored rationale>",
  "previousHistory": null
}
```

```sh
node dist/src/cli.js calibration import selection.json history.json decision.json
```

Import appends to one history and never rewrites an earlier decision. It rejects
unknown or changed assertions, stale history bindings, invalid adjudication
targets, and reuse of a decision ID with different content. Reimporting the
exact same decision is idempotent.
Imports serialize through a per-history local lock. Locks owned by a dead
same-host process or left before the current boot are recovered automatically;
an active import makes a concurrent command fail closed for an idempotent retry.

An adjudication is another explicit human decision. It names at least two prior
review decisions for the same assertion:

```sh
node dist/src/cli.js calibration adjudicate \
  selection.json history.json adjudication.json
```

Its JSON uses `kind: "adjudication"` and an `adjudicates` array of prior review
decision IDs. This records lineage; it does not infer or automate adjudication.

## Summarize calibration

```sh
node dist/src/cli.js calibration summarize \
  selection.json history.json calibration-summary.json
```

The summary reports totals and category-level counts. Judge-human agreement is
over latest judge-human decision pairs on non-abstaining assertions.
Human-human agreement is over distinct-reviewer pairs on the same assertion,
excluding human abstentions. Adjudication counts use human adjudication
decisions as their separate denominator. Every agreement result names its
population and denominator; with no comparable reviews it is `unavailable`
with denominator zero, never perfect agreement. Disputed, inconsistent,
unreviewed, insufficient-evidence, and judge-abstained assertions are excluded
from confirmed eligibility. A review appended after adjudication makes that
adjudication non-current until the updated review population is adjudicated.
These are calibration summaries, not comparison
or Behavior Atlas aggregates.
