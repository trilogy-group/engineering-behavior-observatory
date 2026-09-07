# Outcome ingestion and structural observations

`ebo observations` derives versioned, deterministic facts from a
capture-qualified retained Agent SDK run bundle. It runs qualification,
normalization, native-reference integrity validation, and the registered
extractors in that order. Source bundles are read-only; the command rejects an
output path inside the source bundle or corpus.

```sh
node dist/src/cli.js observations create <run-bundle-root> <output.json>
node dist/src/cli.js observations corpus <corpus-root> <index.jsonl> <output-root> \
  [--run <id>] [--attempt <id>] [--task <id>] [--model <id>] [--harness <id>] \
  [--assessment-mode <observational|verified>]
```

The corpus command first validates the supplied deterministic index, selects
run manifests with the same exact-match filters as `ebo corpus query`, and
writes one bounded `sha256-<run-attempt-tuple>.json` file per selection. It fails rather than skipping
an invalid or unsupported selected bundle. The retained-bundle loader currently
supports Agent SDK bundles; the extractor library accepts any validated
`ebo.normalized-dataset/v1` produced by another harness adapter.

Each `ebo.structural-observation/v1` states its extractor/version, exact
definition, one-attempt denominator, unit, uniform event IDs, native-record
count, and native citations. `ebo.structural-observation-set/v1` also binds the observations to
the normalized-dataset digest and adapter coverage report.

Definitions are deliberately mechanical:

- logical tool operations are grouped only by explicit source-native operation
  IDs; lifecycle records without one are counted separately;
- repetition counts distinct operations beyond the first that share the same
  explicit tool identity and native-input digest;
- failure-followed-by-operation compares only explicit failures and later
  operation starts in the same native-order domain, split into same-tool and
  alternate-tool counts; it does not claim recovery;
- validation-after-mutation requires explicit mutation records and validation
  records in one native-order domain; tool names are never used to infer either;
- model requests require model-request events and native request identities;
  assistant messages and model reroutes are not requests;
- cumulative resource snapshots select only the latest snapshot in one known
  native-order domain, increments are summed only when every record declares
  increment semantics, and a cumulative-final record is used directly;
- native token categories stay separate, native total tokens are never rebuilt
  from components, and cost does not imply subscription utilization;
- compaction counts include only native records that explicitly identify a
  compaction boundary.

An observed zero is emitted only with available family coverage. Partial or
unsupported capability, ambiguous identity, unknown order, overlapping usage,
or missing timing remains `unavailable` with a reason. Observational runs have
no verifier assertion records and make no task-pass claim. Verified runs retain
each assertion outcome with its native verifier citation.
