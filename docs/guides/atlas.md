# Behavior Atlas

The Atlas combines native Grafana dashboards, a local evidence workbench and a
standalone HTML research report. It consumes the [aggregation request](../evaluation/aggregation.md)
and revalidates corpus, structural observations, assertion citations, human
review lineage and comparison gates. It never runs a judge or edits reviews.

## Rebuild and explore

Use Node 24.19.0 and `npm ci && npm run build`. Put this request beside the
aggregation request. Paths are relative to their containing request.

```json
{
  "schemaVersion": "ebo.atlas-request/v1",
  "aggregationRequest": "aggregation.json",
  "title": "Behavior study",
  "operatorNarrative": "Optional operator-authored research notes.",
  "atlasUrl": "http://127.0.0.1:13011",
  "grafanaUrl": "http://127.0.0.1:13010",
  "reviewPackets": ["review-packet/index.html"]
}
```

```sh
ebo atlas build atlas.json atlas-output
ebo atlas serve atlas.json
```

Open `http://127.0.0.1:13011`. Model, harness, task, trial, capture, outcome,
review, category, assessment and text filters select a reproducible cohort.
Apply with the button or Enter; controls and evidence disclosures use native
keyboard behavior. Expand a case for rationale, alternative explanation,
normalized events, cited native records and human decision lineage.

Filters select attempts through matching cases. Aggregation keeps **every
judgment on those attempts**, including conflicting assessments. Filtering for
constructive cases cannot erase an adverse rerun from the aggregate. Matching
case and aggregate attempt populations are named separately. Rates expose both
counts and exclusion reasons; structural means retain their units and are not
percentages. Observational completion is not task success.

The server binds only to `127.0.0.1`, accepts read-only named routes and known
filter keys, rejects foreign hosts/origins and never maps URLs to arbitrary
files. It reloads explicitly configured sources for each query. Stale or
incompatible input fails rather than returning an old aggregate. `--port <port>`
changes the listener; set `atlasUrl` to the same port before rebuilding dashboards.
This is a local research workbench, not a hosted multi-user service.

## Grafana

Install official **Grafana OSS 13.2.0** for your operating system, then start a
fresh profile using the generated provisioning:

```sh
sh scripts/atlas-grafana.sh /path/to/grafana-13.2.0 atlas-output
```

The script installs **Infinity 4.0.0** from Grafana's official registry in this
output's private plugin directory. Grafana binds `127.0.0.1:13010` with local
anonymous Viewer access. Its data, logs, plugins and provisioning stay under
this output; no existing dashboard, Docker container or volume changes.
Rebuild into a new output to preserve previous outputs and local changes.

Open `/d/ebo-atlas-overview` or `/d/ebo-atlas-behavior` on that Grafana instance.
Native tables, cohort variables and data links query EBO-derived JSON and open
the evidence workbench at a selected case. There is no custom plugin code or
study-specific TestData snapshot. Grafana's time picker affects Tempo only; it
does not filter the retained EBO cohort.

For existing captured traces, point `grafanaUrl` and `tempoDatasourceUid` to a
profile containing the relevant Tempo data source. Optional `traces` entries
name `runId`, `attemptId`, a 32-character hexadecimal `traceId`, `originalStart`
and optional `replayStart` (ISO timestamps). These are operator-configured
references. Atlas labels both timestamps and neither replays nor invents trace
data. Without a configured backend and reference it shows trace viewing as
unavailable. A fresh profile needs its own Tempo data source before trace links
can resolve.

## Reports and sharing

“Open cohort report” freezes the selected filters, exact aggregates, evidence
cases, operator narrative, method, limitations and source/cohort digests in
standalone HTML. Save it and use “Print / save PDF.” The JSON link retains
supporting data. No server or frontend build is needed to open the saved report.

```sh
ebo atlas build atlas.json selected-report \
  --filter model=model-a --filter review=confirmed
```

Output must be a new directory outside immutable sources. The offline report
declares its frozen population and never recalculates semantic populations in
browser JavaScript. Cited records use the existing export sanitizer to omit
secrets, hidden fields and local paths; original evidence remains authoritative.
Assertion/source digests identify the original. Existing human packet links are
local file URLs; browsers may block them from HTTP, so open them from the saved
local report.

This does not require paid Grafana reporting: Grafana's scheduled reports and
dashboard PDF exports are Enterprise features. EBO uses standalone HTML and
browser printing. See [Grafana's official sharing documentation](https://grafana.com/docs/grafana/latest/visualizations/dashboards/share-dashboards-panels/).

Ordinary reports are **restricted-local-only**, even when cited displays are
sanitized. A shareable summary requires existing portable exports covering every
selected source manifest. Add `sharing` to the request using the exact policy
used to create those exports:

```json
{
  "sharing": {
    "policy": { "sharingClass": "partner", "maxArtifactBytes": 16777216, "maxStringBytes": 8192 },
    "approvedExports": ["approved/run-a", "approved/run-b"],
    "fields": ["cohort", "aggregate-metrics", "source-digests"]
  }
}
```

`ebo atlas build atlas.json shareable-summary --share` reuses portable export
readback, policy/digest validation, sanitization and final secret scanning.
Source correlations are rewritten. Unsupported fields fail closed. Semantic
assertions/distributions, human prose, native records, raw prompts, trace/review
links and operator narrative lack portable field classifications and are
excluded. Local review access never grants sharing approval. Nothing uploads,
emails or publishes the report.

Shared summaries accept model, harness, task, trial, capture and outcome
filters. Review, category, assessment and free-text evidence filters are
rejected: even without case details, their selected-cohort counts would disclose
semantic or human-review findings that have no export approval.

## Synthetic verification

```sh
node dist/test/atlas-fixture.js .ebo/atlas-fixture
ebo atlas build .ebo/atlas-fixture/atlas.json .ebo/atlas-report
ebo atlas serve .ebo/atlas-fixture/atlas.json
node --test dist/test/atlas.test.js
```

The generator injects synthetic capture streams and fixture review decisions;
it never calls a model or labels real research. It covers opposite assessments,
confirmed/disputed/rejected/proposed/abstained/unavailable states, a retry,
missing observations, an unsupported comparison and hostile text.
