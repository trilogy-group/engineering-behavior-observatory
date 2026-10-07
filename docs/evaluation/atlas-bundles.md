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
  "condition": { "pattern": "^(?<task>.+)-(?<condition>direct|sandboxed)-\\d+$" }
}
```

Each cohort names an existing [Atlas request](../guides/atlas.md). The build
loads every cohort through the same validation as `ebo atlas build`: corpus
index, current structural observation sets, assertions and their citations,
and reviews. A stale or invalid source fails the build. Paths are relative to
the request file. `condition` names study arms with a regular expression over
each run bundle's directory name; without it an arm is `<model> · <harness>`.

An attempt that appears in several cohorts must have the same run manifest
digest in each. The output directory must be new or empty; a bundle is never
overwritten.

## Contents

| Path | Content |
| :--- | :--- |
| `manifest.json` | `ebo.atlas-bundle/v1`: identity, builder, request digest, cohorts with source and cohort digests, tables with row counts, and every file with size, SHA-256 and role |
| `reports/<cohort>.json` | the cohort's aggregation report (the certified tallies), with its source and cohort digests |
| `tables/*.parquet` | Atlas tables v1 (zstd) |

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

Event text and content are never truncated. `ebo atlas bundle verify`
recomputes every listed file's size and digest and reports changed, missing and
unlisted files; it exits non-zero on any.

The tables are written with DuckDB 1.5.4, the release the viewer's DuckDB-WASM
runs, so a query or view receipt computes the same rows in Node and in the
browser.
