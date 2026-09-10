# CLI reference

Install `ebo` with [the quickstart](../guides/quickstart.md). `ebo --help`
prints the current top-level syntax. For a source checkout without `npm link`,
use `npm run ebo -- <arguments>`.

For one-offs without a global install, use
`npm exec --package=engineering-behavior-observatory -- ebo --help`.
Avoid `npx ebo`, which targets a different package.

`<angle-bracket>` values are required placeholders; `[square-bracket]` items
are optional. Do not paste these templates unchanged. `packet.json` and freeze
locators are relative to the declared bundle root; other filesystem arguments
are operator paths. Record destinations must be outside immutable evidence.

## Validate artifacts

```sh
ebo validate <artifact.json>...
ebo task-packet <validate|admit|freeze|status> <bundle-root> <packet.json> [freeze-record.json]
```

`validate` checks registered artifact schemas. The source-specific readers,
capture qualification, and export readback perform additional evidence checks.

## Prepare inputs

Validate/admit/freeze a caller-authored packet, then compile a deterministic queue. These commands do not generate tasks or run models.

```sh
ebo matrix compile <experiment.json> <bundle-root> <queue.json> [--freeze-locator <task-id>=<path>]
ebo queue inspect <queue.json>
ebo queue validate <queue.json> [experiment.json] [--bundle-root <bundle-root>]
```

## Capture one attempt

Execute one selected frozen entry. Use the matching harness configuration and authentication. OpenHands and DeepSeek expose library APIs, not CLI run commands.

```sh
ebo agent-sdk run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
ebo codex run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
ebo cursor run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
ebo pi run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
```

## Inspect and share evidence

Index retained manifests, query exact metadata, or create and transport a policy-checked derivative. Export and packing do not publish.

```sh
ebo export create <run-bundle-root> <policy.json> <export-root>
ebo corpus build <corpus-root> <index.jsonl>
ebo corpus query <index.jsonl> [--kind|--run|--attempt|--task|--model|--harness|--assessment-mode|--terminal|--failure-class|--verifier-status|--capture|--export-status|--sharing-class <value>]
ebo corpus validate <corpus-root> <index.jsonl>
ebo corpus pack <export-root> <policy.json> <archive.tar.gz>
ebo corpus unpack <archive.tar.gz> <destination-root>
```

## Derive facts and evaluate

Observations qualify and normalize retained evidence before extracting structural facts. Judging requires an explicit request and may call a live provider; assertions remain proposals until reviewed.

```sh
ebo observations create <run-bundle-root> <output.json>
ebo observations corpus <corpus-root> <index.jsonl> <output-root> [corpus query flags]
ebo assertions validate <run-bundle-root> <assertion.json> [review.json]
ebo judge run <run-bundle-root> <observations.json> <request.json> <output-root>
```

## Record human review

Select evidence and build static review packets. Import human-authored decisions; these commands do not manufacture reviewer identities or judgments.

```sh
ebo calibration sample <sources.json> <criteria.json> <selection.json>
ebo calibration packet <selection.json> <output-root>
ebo calibration inspect <packet.json> <assertion-id> [event-id]
ebo calibration binding <selection.json> <assertion-id> [history.json]
ebo calibration <import|adjudicate> <selection.json> <history.json> <decision.json>
ebo calibration summarize <selection.json> <history.json> <summary.json>
```

## Compare and present

Check comparison eligibility, aggregate declared populations, and build or serve a local Atlas. These commands consume existing judgments rather than invoking a judge.

```sh
ebo comparison check <request.json>
ebo aggregate build <request.json> <output.json>
ebo atlas build <request.json> <output-root> [--share] [--filter <name=value>]
ebo atlas serve <request.json> [--port <port>]
```

## Operational behavior

- A queue-run command executes one entry and creates a new attempt. It does not
  schedule the whole queue or silently retry.
- A successful exit can mean a valid **captured failure or stop**. Read the run
  summary, manifest, and capture report before interpreting the result.
- `queue inspect` prints summary information. Read `queue.json` for run IDs.
- Corpus filters use exact matches. Indexes are rebuildable; native manifests
  and records remain authoritative.
- There is no standalone `normalize` command: observations invoke the
  qualified retained-source path.
- `comparison check` prints a report to stdout; redirect it to a file when an
  aggregation request needs it. Unsupported comparisons return nonzero.
- New export, unpack, judgment, and report destinations must not already exist.
- Atlas defaults to a loopback-only service. Ordinary reports remain restricted;
  `--share` requires policy-validated source exports and excludes unsupported
  semantic/review fields.

For preparation and recovery, use the [operator guide](../guides/operator-guide.md).
For field definitions, use the [reference index](README.md).
