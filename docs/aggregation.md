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

Each group's additive `behaviors` array retains constructive, adverse, mixed,
and context-dependent distributions separately from review agreement. A
partition names the exact vocabulary/category/dimension, rubric id/version,
and evaluator identity/version/configuration digest. Missing legacy evaluator
configuration stays a separate partition. Its denominator is distinct
confirmed attempt-dimensions, not judge calls: agreeing confirmed reruns count
once and conflicting confirmed reruns exclude that attempt. Disputed,
unreviewed, rejected, and abstained assertions cannot contribute; assertion
references expose review outcome and inclusion alongside run/attempt/digest.
An empty denominator is unavailable. These distributions remain descriptive.

Corpus indexing prefers `structuralQualification.status` over legacy
`qualification`. Legacy-only known states remain readable; missing or invalid
structural status is unavailable. Qualified-with-gaps, incomplete, unqualified,
and unavailable remain distinct. Rebuild older corpus indexes before using
them; source manifests and native artifacts are never rewritten.

Every report retains the logical request and corpus-index digests plus the
exact admitted manifest, observation-set, assertion, calibration, and
comparison-gate digests. Moving the report therefore does not detach its
metrics from their rebuild inputs.

Observation and assertion sources name their retained bundle so the build can
recompute structural observations, resolve assertion citations, and reject
stale derived evidence. Calibration selections are likewise reloaded from their
digest-bound sources before their review history contributes to a metric.
Legacy v1 structural sets without the optional declared capability profile stay
readable; aggregation and semantic judging rebuild that profile from the native
bundle before use.

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
These bindings use `ebo.comparison-request/v2` and
`ebo.comparison-report/v2`; the original v1 request/report remain supported by
`ebo comparison check` but do not contain enough lineage for aggregation.

The caller supplies the recurrence threshold. A divergent matched unit below
that threshold is a `case-study`; reaching it yields only a
`recurring-description`. Neither state establishes causality or statistical
significance, and the report never emits a composite model ranking.

<!-- BEGIN OPENSYMPHONY MANAGED MEMORY SYNC -->

## Current model

- COE-560 contributed: PR #3: Define task-packet and experiment contracts (merge `d2bb345`)
- COE-561 contributed: PR #4: Define run-bundle evidence contracts (merge `ef36a82`)
- COE-562 contributed: PR #5: Add artifact validation and integrity primitives (merge `adbb1b9`)
- COE-563 contributed: PR #7: Implement task-packet admission and freeze tooling (merge `eb26151`)
- COE-564 contributed: PR #6: Implement verifier execution and outcome records (merge `39f04d7`)
- COE-565 contributed: PR #8: Implement isolated workspace materialization (merge `454f042`)

## Important invariants

- Preserve the behavior described in the recent captured changes unless current code and tests show it has changed.
- Use capsule source refs to inspect the original PR or Linear issue when context is ambiguous.

## Operational flow

- No generated diagram requested for this sync.

## Known gotchas

- No area-specific gotchas were inferred from the selected memory.

## Recent changes

- COE-560: Define task-packet and experiment contracts
- COE-561: Define run-bundle and evidence contracts
- COE-562: Implement artifact validation and digest primitives
- COE-563: Implement task-packet admission and freeze tooling
- COE-564: Implement verifier execution and outcome records
- COE-565: Implement isolated workspace materialization
- COE-566: Implement configurable run matrices and scheduling
- COE-567: Implement run lifecycle and process-protocol primitives
- COE-585: Implement comparison and aggregation
- COE-586: Build the interactive Behavior Atlas with Grafana and report export
- COE-587: Document operator workflows and extension contracts
- COE-588: Complete release acceptance and reproducibility audit
- COE-597: Complete cross-harness behavioral evaluation and configurable Codex judging

## Source refs

- COE-560
- COE-561
- COE-562
- COE-563
- COE-564
- COE-565
- COE-566
- COE-567
- COE-585
- COE-586
- COE-587
- COE-588
- COE-597

<!-- END OPENSYMPHONY MANAGED MEMORY SYNC -->
