# Atlas bundles

An Atlas bundle is the analytical layer behind the interactive viewer: Parquet
tables built from validated EBO artifacts, one report per cohort, and a manifest
that binds every file by size and SHA-256. Native records stay authoritative;
the tables are derived views that point back to them.

```sh
ebo atlas bundle build <request.json> <output-root>
ebo atlas bundle verify <bundle-dir>
```

## Request

```json
{
  "schemaVersion": "ebo.atlas-bundle-request/v1",
  "id": "behavior-study",
  "title": "Behavior study",
  "cohorts": [
    { "id": "primary", "atlasRequest": "primary/atlas.json" },
    { "id": "matched-timeout", "atlasRequest": "matched-timeout/atlas.json" }
  ],
  "condition": { "pattern": "^(?<task>.+)-(?<condition>direct|sandboxed)-\\d+$" },
  "claims": "claims/behavior-study.json",
  "views": "views/",
  "embeddings": { "provider": "local" }
}
```

Each cohort names an existing [Atlas request](../guides/atlas.md). The build
loads every cohort through the same validation as `ebo atlas build`: corpus
index, current structural observation sets, assertions and their citations,
and reviews. A stale or invalid source fails the build. Paths are relative to
the request file. `condition` names study arms with a regular expression over
each run bundle's directory name; without it an arm is `<model> · <harness>`.

With a `condition` pattern, every run bundle must match it. Atlas tables key
attempts by attempt id and assessments by assertion id, so each must be unique
in a bundle: an attempt that appears in several cohorts must have the same run
manifest digest in each, and a reused id fails the build. The
bundle is built in a temporary sibling directory and published by rename only
after its manifest validates; the destination must be new or empty, and a bundle
is never overwritten.

`claims` names a claims file the study authors; claims are never generated.
`views` names a directory of view specs. `embeddings` chooses how cloud units
are embedded:

- `local` (the default): TF-IDF over each unit's words, feature-hashed to the
  requested `dimensions` (default 256). No network call.
- `fireworks`: each unit's `embed_text` (behavior summaries and message text
  capped for embedding, never tool output or file contents), with secrets
  redacted, is sent to Fireworks (`model`, default
  `accounts/fireworks/models/qwen3-embedding-8b`; needs `FIREWORKS_API_KEY`).
  Vectors are cached under `cache` by model, dimensions and text digest.

## Contents

| Path | Content |
| :--- | :--- |
| `manifest.json` | `ebo.atlas-bundle/v1`: identity, builder, request digest, cohorts with source and cohort digests, tables with row counts, and every file with size, SHA-256 and role |
| `reports/<cohort>.json` | the cohort's aggregation report (the certified tallies), with its source and cohort digests |
| `tables/*.parquet` | Atlas tables v1 (zstd) |
| `units.arrow`, `embeddings.f32` | the cloud: one row per embedded unit (Arrow IPC) and its vector (float32, row order) |
| `lanes.json` | swimlanes: lane metadata, cumulative tokens and context per request from normalized usage events |
| `assessments.json`, `audit.json`, `native/<attempt>.json` | assessments with citations linked to units and native lines (SHA-256 of the full line), attempt audits, per-unit native records |
| `claims.json`, `views.json` | validated claims and view specs with their receipts, when the request names them |

Atlas tables v1, all keyed by stable EBO identities (`event_key` is
`<attemptId>/<eventId>`, since event ids are attempt-scoped):

| Table | One row per |
| :--- | :--- |
| `cohorts`, `attempt_cohorts` | cohort; attempt membership |
| `attempts` | attempt: identity, arm, capture qualification, terminal state, adapter, dataset digest, native record and unmapped counts, time span |
| `events` | uniform event with its native reference, order, time, tool fields, the resolved native content as JSON, and a flattened text view for search and embedding |
| `event_relations` | known relation between two events |
| `assessments`, `assessment_cohorts` | judge assertion with its review state; inclusion and dispute per cohort |
| `citations` | assertion citation, with its occurrence and whether it resolves to a bundled event |
| `claims` | atomic factual claim of an assertion, with its cited events and workspace |
| `observations`, `observation_sources` | structural observation; its source events |
| `occurrences` | occurrence with its rule, heuristic flag, events and attributes |
| `edges` | typed provenance edge between the identities above |

Units 1.0.0 are the comparable steps of an attempt: a tool unit is one EBO tool
operation (call, result and hooks), a message unit one completed visible
message, compaction and delegation units are EBO occurrences, and an episode is
a message plus the tool units that follow it. Unit ids are
`<attemptId>/<first event id>`. Their command classification reads command
text and is heuristic.

The viewer lays the cloud out in the browser with Embedding Atlas: a cosine
UMAP per unit family with a fixed seed, density clusters and labels from the
facets most over-represented in each cluster. Cloud statistics are exploratory.

## Claims and view receipts

The build validates every claim: each number recomputes to its stated value
(from a cohort report, a JSON pointer into a report, SQL over the bundle tables,
or audit verdicts), every supporting assessment is in the bundle, every cited
native line still hashes to its recorded SHA-256, and every cited view exists.
`claims.json` records each claim's result and the failures; it never drops a
claim that no longer holds.

Each view spec's `query` is recomputed over the same host tables the viewer
builds; its canonical rows (keys sorted, whole numbers as integers, compact
UTF-8 JSON) and their SHA-256 form the receipt the viewer checks.

Event text and content are never truncated. `ebo atlas bundle verify`
recomputes every listed file's size and digest and reports changed, missing and
unlisted files; it exits non-zero on any.

The tables are written with DuckDB 1.5.4, the release the viewer's DuckDB-WASM
runs, so a query or view receipt computes the same rows in Node and in the
browser.
