# Comparison and aggregation

`ebo aggregate build` creates a deterministic local read model from a current
corpus index, structural observations, proposed behavior assertions, human
calibration lineage, and per-measure comparison eligibility reports. It reads
JSON/JSONL directly and writes one derived JSON document outside the source
corpus; it does not alter retained bundles.

```sh
node dist/src/cli.js aggregate build request.json aggregate.json
```

The request uses paths relative to `request.json`:

```json
{
  "schemaVersion": "ebo.aggregation-request/v1",
  "sources": {
    "corpusRoot": "corpus",
    "corpusIndex": "corpus-index.jsonl",
    "observationSets": [{ "bundleRoot": "corpus/run-a", "path": "derived/observations/run-a.json" }],
    "assertions": [{ "bundleRoot": "corpus/run-a", "path": "derived/assertions/assertion-a.json" }],
    "calibrations": [{
      "selection": "derived/review/selection.json",
      "history": "derived/review/history.json"
    }]
  },
  "groupBy": ["task", "model", "harness"],
  "selectedAttemptPolicy": "all-attempts",
  "recurrence": { "minimumOccurrences": 2 },
  "comparisons": [{
    "id": "matched-verifier-outcome",
    "measure": "verified:verifier-passed",
    "left": { "model": "model-a" },
    "right": { "model": "model-b" },
    "matchBy": ["task", "harness", "trial"],
    "eligibilityGates": [{
      "request": "derived/comparisons/model-a-model-b.request.json",
      "report": "derived/comparisons/model-a-model-b.report.json"
    }]
  }]
}
```

Grouping dimensions are `task`, `model`, `harness`, `trial`, and
`capture-qualification`. `all-attempts` is the evidence-preserving default.
`trial` is the queue's retained numeric trial index; legacy bundles without it
remain unavailable and are excluded from trial-matched comparisons.
`latest-attempt-per-run` selects the highest declared attempt number regardless
of terminal state and reports every excluded earlier attempt; it never searches
for or substitutes a completed retry.

Each metric names its run, attempt, operation, assertion, or reviewed-assertion
population and carries numerator, denominator, units, exclusions, and a claim
status. Empty denominators are `unavailable`. Observational completion is only
a terminal-state measure; task-success rates come only from available verified
attempt outcomes. Duplicate identical inputs are counted once, while conflicting
records with the same identity fail the build.

Observation and assertion sources name their retained bundle so the build can
recompute structural observations, resolve assertion citations, and reject
stale derived evidence. Calibration selections are likewise reloaded from their
digest-bound sources before their review history contributes to a metric.

Matched comparisons require one candidate on each side for every caller-chosen
match key and one eligibility report whose candidate IDs are those two run IDs.
Missing, ambiguous, unavailable, or ungated pairs are exclusions. Supported
measures are `attempt:infrastructure-failure`,
`attempt:terminal-completed`, `verified:verifier-passed`, and any numeric
`structural:<extractor-id>` observation. The supplied comparison gate applies
only to that candidate pair, must name the exact measure, and must include the
measure's required capability;
an unsupported gate makes the comparison
unavailable, and partial-capability or declared-condition caveats remain in the
output.

Each eligibility report carries the digest of its source comparison request.
The aggregate build reloads that request and recomputes the report before using
the gate, so an edited or stale report cannot authorize a matched difference.

The caller supplies the recurrence threshold. A divergent matched unit below
that threshold is a `case-study`; reaching it yields only a
`recurring-description`. Neither state establishes causality or statistical
significance, and the report never emits a composite model ranking.
