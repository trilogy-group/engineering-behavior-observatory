# Run behavioral evaluation

Use LLM-as-judge for the default evaluation workflow:

**Capture → qualify → extract → judge → aggregate → Atlas.**

Human review is an optional branch for experiments that require intervention,
calibration, or adjudication. It is not a prerequisite for behavior charts.
Capture-only studies can stop before judging.

## Prepare study-owned requests

For each retained attempt, produce the structural observation set using the
[operator workflow](operator-guide.md#6-normalize-and-extract-structural-observations).
Create one [judge request](../evaluation/semantic-judge.md) per desired dimension.
The [ontology](../../ontology/behavior-categories.v1.json) lists the eight
available categories. Select the dimensions relevant to your study; running
all eight is not a software requirement.

Keep the evaluator, effort, rubric version, and evidence-selection method
consistent across compared runs. Configure those in the request files rather
than embedding model IDs in a script. Evidence IDs must belong to the retained
attempt. The runner validates and resolves them before judging.

For bounded chronological sampling, select complete tool calls/results and
messages across the beginning, middle, and end. Check native event types:
streaming chunks are not interchangeable with complete messages, and removing
names containing `delta` does not exclude every harness's streaming events.
Record the selection method and exact IDs. Inspect each resulting `input.json`
for truncation. The rubric should acknowledge sampling and permit abstention;
absence from a sample is not proof that an action never occurred.

## Run a batch

Save `batch.json` alongside the study's `requests`, `observations`, and
`judgments` directories. Paths resolve relative to the batch file, not the shell:

```json
{
  "jobs": [
    {
      "bundleRoot": "corpus/run-a",
      "observations": "observations/run-a.json",
      "request": "requests/run-a-verification.json",
      "outputRoot": "judgments/run-a-verification"
    },
    {
      "bundleRoot": "corpus/run-b",
      "observations": "observations/run-b.json",
      "request": "requests/run-b-verification.json",
      "outputRoot": "judgments/run-b-verification"
    }
  ]
}
```

```sh
ebo judge batch study/batch.json
```

The batch accepts 1–256 jobs, executes sequentially, and requires distinct,
new output directories. Each job uses the existing `judge run` implementation,
including its limits, evidence checks, signal handling, and retained failure
records. Output is one judgment record per completed invocation. A failure or
interruption stops the batch; completed outputs remain intact. Resume with a
new batch containing only remaining jobs and new paths for retried judgments.
There are no automatic retries, provider fallbacks, or model defaults.

An assessed assertion and an evidence-based abstention are both legitimate
evaluation outputs. Malformed output, unavailable evidence, and provider
failure are not behavioral-quality labels. Inspect `judgment.json` and
`assertion.json` before including results in aggregation.

## Aggregate without human review

The aggregation request lists retained assertions and leaves calibration empty:

```json
{
  "schemaVersion": "ebo.aggregation-request/v1",
  "sources": {
    "corpusRoot": "corpus",
    "corpusIndex": "index.jsonl",
    "observationSets": [
      {"bundleRoot": "corpus/run-a", "path": "observations/run-a.json"},
      {"bundleRoot": "corpus/run-b", "path": "observations/run-b.json"}
    ],
    "assertions": [
      {"bundleRoot": "corpus/run-a", "path": "judgments/run-a-verification/assertion.json"},
      {"bundleRoot": "corpus/run-b", "path": "judgments/run-b-verification/assertion.json"}
    ],
    "calibrations": []
  },
  "groupBy": ["harness", "model"],
  "selectedAttemptPolicy": "all-attempts",
  "recurrence": {"minimumOccurrences": 2},
  "comparisons": []
}
```

Save this as `study/aggregation.json`, then save `study/atlas.json`:

```json
{
  "schemaVersion": "ebo.atlas-request/v1",
  "aggregationRequest": "aggregation.json",
  "title": "Behavioral evaluation",
  "operatorNarrative": "Model assessments with cited evidence. Human adjudication is optional."
}
```

```sh
ebo corpus build study/corpus study/index.jsonl
ebo aggregate build study/aggregation.json study/aggregate.json
ebo atlas build study/atlas.json study/atlas-export
```

Open `study/atlas-export/index.html`. Charts count **judge-assessed attempt-dimensions**:
agreeing repeated judgments count once; conflicting judgments and abstentions
are excluded with reasons. A single assessed attempt contributes a denominator
of one, not zero because it lacks human review. Review states remain separate,
including any later disagreement with the judge. `proposed` means no human
adjudication, not an unfinished model evaluation. Confidence is evaluator-reported,
not a calibrated probability.

The export is for restricted local inspection unless it passes the separate
sharing workflow. A model assessment does not grant approval to share native
records. Keep original capture bundles unchanged.

## Optional human-intervention experiment

When the study calls for human review, follow the
[calibration guide](../evaluation/human-calibration.md), then add its selection
and history paths to `sources.calibrations`. These records describe the human
decisions and agreement population; they do not overwrite model assertions.

## Verify the workflow without a provider call

From a built checkout:

```sh
node --test dist/test/semantic-judge.test.js dist/test/atlas.test.js
```

The tests exercise batch execution with a fixture backend, relative paths,
new-output protection, fail-fast behavior, and model-only Atlas denominators.
Live-provider tests remain explicitly opt-in.
