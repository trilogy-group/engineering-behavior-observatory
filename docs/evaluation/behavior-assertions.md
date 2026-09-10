# Behavior assertions and evidence resolution

`ebo.behavior-assertion/v1` records one semantic assessment or abstention for
one declared behavior dimension. The initial `ebo.behavior-vocabulary/v1` is a
small data file at
[`ontology/behavior-categories.v1.json`](../../ontology/behavior-categories.v1.json).
Its eight entries are the categories in the canonical specification; unmapped
observations do not force a new category.

Each assertion binds the normalized-dataset schema version and canonical
digest, run and attempt IDs, vocabulary version, one category/dimension pair,
and evaluator/rubric identities. An assessment is constructive, adverse,
mixed, or context-dependent and retains confidence on the explicit
`evaluator-reported-0-to-1` scale, rationale, an alternative explanation, and
at least one citation. Confidence is not a calibrated probability. An abstention instead retains its reason and
may name the missing event or evidence capability; citations are optional.

A citation names both a normalized event ID and that event's exact native
source reference. `validateBehaviorAssertion` first applies the existing
normalized-dataset integrity validator, then checks the dataset digest and
assertion identity, declared dimension, event ownership, native reference, and
resolver-provided run/attempt/digest. Changed datasets, foreign attempts,
dangling events or native records, and stale digests fail closed.

`ebo.behavior-review/v1` is a separate record bound to the assertion digest.
Its states are `proposed`, `confirmed`, `disputed`, `rejected`, and
`insufficient-evidence`. Proposed records cannot carry a reviewer; all other
states require an explicitly identified human reviewer and rationale. The
library derives confirmed aggregation eligibility only after revalidating the
assertion against its dataset and native resolver, and then finding a valid
`confirmed` review of a non-abstaining assertion. A judge assertion cannot set
human confirmation itself.

The callable validator accepts any `ebo.normalized-dataset/v1` and its
source-specific native resolver. The current CLI rebuilds and validates the
normalized dataset from a retained Claude Agent SDK, Codex, OpenHands, Pi, or
DeepSeek run bundle through `validateRetainedBehaviorAssertion`:

```sh
ebo assertions validate <run-bundle-root> <assertion.json> [review.json]
```

This command validates contracts and evidence only. It does not run a judge,
change review state, adjudicate a dispute, aggregate results, or build an
Atlas.
