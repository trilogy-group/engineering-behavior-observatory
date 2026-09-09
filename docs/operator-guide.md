# Local operator guide

This guide covers one local EBO workflow from an admitted task packet to an
inspectable Behavior Atlas. EBO records evidence; it does not choose study
tasks, models, trial counts, human reviewers, or partner deliverables. Values
such as `example-task` below are examples, not product defaults.

## Prerequisites and safety defaults

- Use Node.js `24.19.0`, pinned by `.nvmrc` and `package.json`.
- Run from the repository root after `npm ci && npm run build`.
- Keep bundle inputs and native run bundles restricted. Create partner/public
  derivatives only with `ebo export create` and a reviewed policy.
- Use observational packets unless a task genuinely has an admitted reference
  solution and verifier. Observational completion means the agent loop ended
  and an outcome was retained; it is not a claim that the request was solved.
- Configure authentication in the process environment, never in packet,
  experiment, queue, or capture-profile JSON.
- Keep telemetry content capture off unless specifically approved. Agent SDK
  traces are beta and detailed hook spans are detailed-beta; native hooks and
  streams remain authoritative. Never use a console telemetry exporter when
  stdout carries a harness protocol.
- A configured collector endpoint does not prove receipt. Retain the reported
  `received`, `missing`, `not-checked`, or `unsupported` state.

Harness prerequisites differ:

| Harness | Runtime boundary | Operator prerequisite |
|---|---|---|
| Claude Agent SDK | direct pinned TypeScript SDK | an existing approved authenticated route; optional OTLP receiver |
| Codex | owned pinned `codex app-server` child | Codex `0.153.4` and existing login; EBO creates an isolated temporary home |
| OpenHands | Agent Server REST/WebSocket | pinned `1.44.1` server and workspace path visible to both processes |
| DeepSeek Harness | official TypeScript client over JSON-RPC stdio | digest-pinned runtime composition; the official client owns framing and teardown |

See [Agent SDK runner](agent-sdk-operational-runner.md),
[Codex](codex-harness.md), [OpenHands](openhands-agent-server.md), and
[DeepSeek](deepseek-harness.md) for their exact configuration and version pins.

## Deterministic smoke workflow

The supplied task-packet contract smoke and Atlas fixture are synthetic and
perform no model call. Together they exercise packet validation/freeze and
create capture-qualified native bundles, normalized events, structural
observations, example judge assertions, synthetic review decisions,
aggregation inputs, and an Atlas request. The fixture decisions exercise
review states; they are not human calibration or evidence about any model.

Run the following in a clean clone:

```sh
nvm use
npm ci
npm run build
node --test --test-name-pattern='task-packet CLI exposes validate, freeze, and status' \
  dist/test/task-packets.test.js
node dist/test/atlas-fixture.js .ebo/operator-smoke
node dist/src/cli.js corpus validate \
  .ebo/operator-smoke/corpus .ebo/operator-smoke/index.jsonl
node dist/src/cli.js observations corpus \
  .ebo/operator-smoke/corpus .ebo/operator-smoke/index.jsonl \
  .ebo/operator-smoke-observations
node dist/src/cli.js aggregate build \
  .ebo/operator-smoke/aggregation.json .ebo/operator-smoke-aggregate.json
node dist/src/cli.js atlas build \
  .ebo/operator-smoke/atlas.json .ebo/operator-smoke-atlas
```

These output paths must not already exist. In a reused clone, choose a new
suffix instead of deleting or overwriting retained evidence.

Open `.ebo/operator-smoke-atlas/index.html`. The expected final CLI line starts
with `Built Atlas:` and reports a `restricted-local-only` view. The Atlas must
show constructive and adverse cases, proposed/confirmed/disputed/rejected/
abstained/unavailable states, a retry, missing evidence, and an unsupported
comparison. Every drilldown must resolve to retained normalized and native
evidence. Use the following only when interactive filtering is needed; the
generated report itself needs no server:

```sh
node dist/src/cli.js atlas serve .ebo/operator-smoke/atlas.json
```

This deterministic fixture begins after task admission and queue execution so
it can run without credentials. The production path below supplies those
earlier stages and uses the same corpus, observation, aggregation, and Atlas
commands after capture.

## Production workflow

Use one caller-owned directory for immutable inputs and separate new
destinations for derived outputs:

```text
study/
├── bundle/
│   ├── packets/example-task.json
│   ├── freezes/example-task.json
│   ├── components/
│   └── configs/
├── experiment.json
├── queue.json
├── runs/
├── exports/
├── index.jsonl
├── observations/
├── judgments/
├── reviews/
├── aggregation.json
└── atlas.json
```

All paths in a packet or experiment are relative to its declared bundle root.
All digests are over the exact referenced bytes. Do not edit a frozen packet or
its referenced components; create a new packet/freeze identity instead.

### 1. Validate, admit, and freeze a packet

```sh
node dist/src/cli.js task-packet validate \
  study/bundle packets/example-task.json
node dist/src/cli.js task-packet admit \
  study/bundle packets/example-task.json
node dist/src/cli.js task-packet freeze \
  study/bundle packets/example-task.json freezes/example-task.json
node dist/src/cli.js task-packet status \
  study/bundle packets/example-task.json freezes/example-task.json
```

Admission requires an existing human decision bound to the pre-admission
packet digest. The command validates that decision; it does not create one.
Keep restricted review records, reference solutions, and verifier sources out
of model-visible input and portable output.

### 2. Compile and inspect a queue

The experiment names caller-chosen task, model, harness, ordering, and capture
configuration references. EBO expands it deterministically; it does not choose
or retry cells.

```sh
node dist/src/cli.js matrix compile \
  study/experiment.json study/bundle study/queue.json \
  --freeze-locator example-task=freezes/example-task.json
node dist/src/cli.js queue inspect study/queue.json
node dist/src/cli.js queue validate \
  study/queue.json study/experiment.json --bundle-root study/bundle
```

### 3. Run one queue entry

Read the `runId` from the persisted queue; `queue inspect` checks its summary
but does not list entries. Execute exactly one entry. The output root and
optional workspace parent must be new or safely reusable parents; EBO never
replaces an existing attempt destination.

```sh
node dist/src/cli.js agent-sdk run \
  study/bundle study/queue.json <run-id> study/runs \
  --workspace-root study/workspaces

# Or, for a queue compiled with the pinned Codex configuration:
node dist/src/cli.js codex run \
  study/bundle study/queue.json <run-id> study/runs \
  --workspace-root study/workspaces
```

OpenHands and DeepSeek are explicit library adapters today; their source-owned
capture functions are documented in their harness guides. Do not route them
through the Agent SDK or Codex commands, and do not build a generic broker.

The run command prints the bundle path. A captured task failure, budget stop,
or infrastructure failure may still return a valid observation. Inspect the
manifest and capture report instead of treating process exit as task success.

### 4. Review capture and create a corpus index

```sh
node dist/src/cli.js validate \
  study/runs/<run-id>/<attempt-id>/manifest.json
node dist/src/cli.js corpus build study/runs study/index.jsonl
node dist/src/cli.js corpus validate study/runs study/index.jsonl
node dist/src/cli.js corpus query study/index.jsonl \
  --run <run-id> --assessment-mode observational
```

Review `terminal`, `failureClass`, `captureQualification`, validation issues,
native session/turn IDs, telemetry receipt, workspace outcome, and retained
workspace paths. Missing evidence remains missing; never convert it to zero,
`false`, a fabricated event, or a successful outcome.

### 5. Export an approved derivative

Export is optional for local analysis. A policy is caller-owned and contains
the sharing class, bounds, and optionally caller-known confidential values that
the built-in secret checks or exporter environment cannot discover:

```json
{
  "sharingClass": "partner",
  "maxArtifactBytes": 16777216,
  "maxStringBytes": 8192,
  "sensitiveValues": ["<caller-known confidential value>"]
}
```

Keep a policy containing `sensitiveValues` with restricted study inputs and do
not commit real values. They are scan inputs and are not copied into the
portable export.

```sh
node dist/src/cli.js export create \
  study/runs/<run-id>/<attempt-id> study/export-policy.json \
  study/exports/<run-id>-<attempt-id>
```

Export fails closed on unknown classifications, unsupported artifacts, digest
changes, local identifiers, hidden reasoning, or secret-scan findings. It
never mutates or grants sharing approval to the source bundle.

### 6. Normalize and extract structural observations

There is deliberately no free-standing `normalize` command. The observation
command selects the retained source adapter, revalidates native references and
coverage, normalizes only capture-qualified evidence, and writes structural
facts outside the native bundle.

```sh
node dist/src/cli.js observations create \
  study/runs/<run-id>/<attempt-id> \
  study/observations/<run-id>-<attempt-id>.json

# Or rebuild observations for a qualified corpus selection:
node dist/src/cli.js observations corpus \
  study/runs study/index.jsonl study/observations \
  --assessment-mode observational
```

The single-run form writes the explicit `<run-id>-<attempt-id>.json` path used
below. The corpus form writes `sha256-<digest>.json` files; locate a selected
attempt before judging it, for example with
`rg -l '"attemptId":"<attempt-id>"' study/observations/sha256-*.json`, and pass
that exact path to `judge run`.

Unmapped native records and unsupported capabilities remain explicit. Native
records remain authoritative and are referenced, not copied into a synthetic
common history.

### 7. Evaluate with a caller-selected judge

Judging is optional. The request selects a behavior dimension, rubric, exact
evidence IDs, limits, blinding, and either the Claude Agent SDK or Codex
app-server backend. EBO does not choose the evaluator or fall back between
providers.

```sh
node dist/src/cli.js judge run \
  study/runs/<run-id>/<attempt-id> \
  study/observations/<run-id>-<attempt-id>.json \
  study/judge-request.json study/judgments/<judgment-id>
node dist/src/cli.js assertions validate \
  study/runs/<run-id>/<attempt-id> \
  study/judgments/<judgment-id>/assertion.json
```

The output is a proposal or abstention, never a human-confirmed label. See
[the semantic judge guide](semantic-judge.md) for the two backend shapes and
safe environment policy.

### 8. Review without fabricating human decisions

Selection and packet generation are deterministic. A human reads the local
packet and authors a decision file. EBO validates/imports that supplied
decision and its lineage; it never generates a human identity or decision.

```sh
node dist/src/cli.js calibration sample \
  study/review-sources.json study/review-criteria.json \
  study/reviews/selection.json
node dist/src/cli.js calibration packet \
  study/reviews/selection.json study/reviews/packet
node dist/src/cli.js calibration inspect \
  study/reviews/packet/packet.json <assertion-id>
node dist/src/cli.js calibration binding \
  study/reviews/selection.json <assertion-id>
node dist/src/cli.js calibration import \
  study/reviews/selection.json study/reviews/history.json \
  study/reviews/decision.json

# For a later decision, bind it to the existing history:
node dist/src/cli.js calibration binding \
  study/reviews/selection.json <assertion-id> study/reviews/history.json
node dist/src/cli.js calibration summarize \
  study/reviews/selection.json study/reviews/history.json \
  study/reviews/summary.json
```

Use `calibration adjudicate` with an adjudication decision when the documented
review workflow requires it. Do not copy the synthetic fixture reviewer into a
real study.

### 9. Aggregate and build the Atlas

`aggregation.json` explicitly lists the current corpus index, observation
sets, assertions, calibration history, grouping, attempt-selection policy,
recurrence threshold, and any comparison gates.

```sh
node dist/src/cli.js comparison check study/comparison-request.json \
  > study/comparison-report.json
node dist/src/cli.js aggregate build \
  study/aggregation.json study/aggregate.json
node dist/src/cli.js atlas build study/atlas.json study/atlas-output
node dist/src/cli.js atlas serve study/atlas.json --port 13011
```

The `report` field for each gate in `aggregation.json` must name the exact file
written above. Inspect its supported, qualified-with-caveats, or unsupported
status before aggregation; redirecting stdout persists the inspectable report
even when an unsupported comparison returns nonzero.

The Atlas consumes existing evidence and review state; it does not run a judge
or edit decisions. Local restricted reports and sanitized shareable summaries
are separate modes. See [the Atlas guide](atlas.md) before using `--share`.

## Failure recovery

| Signal | Preserve and inspect | Recovery |
|---|---|---|
| packet/freeze digest mismatch | packet, referenced bytes, freeze record | restore exact admitted bytes or create and admit a new packet; never rewrite the old freeze |
| stale or invalid queue | experiment, packet freeze, all configuration digests | compile a new queue after correcting inputs; do not edit run identities in place |
| run cannot start | CLI error and unchanged input bundle | correct auth/runtime/configuration, then use a new output destination |
| interrupted or failed attempt | partial manifest, native JSONL, diagnostics, capture report, retained workspace path | keep the partial bundle; retry as a new linked attempt rather than replacing it |
| missing collector receipt | native stream/hooks plus explicit telemetry gap | repair/check the collector for a later attempt; do not claim receipt or discard otherwise valid native evidence |
| workspace packaging/cleanup failure | `retainedWorkspacePath` from the summary | recover from that path before manual cleanup; do not infer an outcome without retained workspace evidence |
| export rejected | source bundle plus export diagnostics | correct the policy/input or remove the detected secret at its source; use a new export destination |
| stale corpus/derived output | source manifests and current index validation errors | rebuild the index and derived outputs into new paths |
| judge failure/abstention | bounded input, raw output/failure record, selected evidence | preserve it; change inputs/configuration only in a new judgment run |
| Atlas rejects inputs | corpus validation, assertion/review lineage, comparison gates, source digests | repair/rebuild the upstream derived artifact; never serve a stale cached report |

## Command reference

`node dist/src/cli.js --help` is the authoritative command reference and must be
checked after every CLI change. The commands used above correspond to these
families: `task-packet`, `matrix`, `queue`, `agent-sdk`, `codex`, `export`,
`corpus`, `observations`, `assertions`, `judge`, `calibration`, `comparison`,
`aggregate`, and `atlas`. Do not document a command that is absent from that
output.
