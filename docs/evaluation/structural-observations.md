# Outcome ingestion and structural observations

Retained native loading accepts the implemented source versions: OpenHands
1.44.1/1.46.0, DeepSeek SDK 0.1.1-rc.2, and Codex 0.150.1/0.153.4. Unsupported versions
fail explicitly rather than receiving a different adapter's provenance.
Completed Codex bundles require exactly one matching owned native terminal to
report completion; duplicate owned terminals reject. Qualified failed/partial
evidence remains separate.
Native envelopes and physical JSONL sequences are checked before dispatch;
Codex notifications from a foreign or client-only source cannot become events.
Codex start ownership requires unique ordered client-request/server-response
pairs with the same JSON-RPC ID; turn requests must name the owned thread and
completion must follow acceptance. OpenHands
capture requires exactly one server-info record, and its version and
conversation records must agree with the manifest; completed
runs require one owned final conversation with `execution_status: finished`.
DeepSeek requires the root prompt receipt and native parent/child links for
related sessions, and runtime reap must follow root idle. A coarse related-session list alone cannot authorize foreign
records, and the retained composition must match the pinned client version.
Verifier task failures also require normal native completion; infrastructure
failures and interruptions can retain qualified partial evidence instead.

`ebo observations` derives versioned, deterministic facts from a
capture-qualified retained Claude Agent SDK, Codex, OpenHands, DeepSeek, Pi, or Cursor run bundle. It runs qualification,
normalization, native-reference integrity validation, and the registered
extractors in that order. Source bundles are read-only; the command rejects an
output path inside the source bundle or corpus.

```sh
ebo observations create <run-bundle-root> <output.json>
ebo observations corpus <corpus-root> <index.jsonl> <output-root> \
  [--run <id>] [--attempt <id>] [--task <id>] [--model <id>] [--harness <id>] \
  [--assessment-mode <observational|verified>]
```

The corpus command first validates the supplied deterministic index, selects
run manifests with the same exact-match filters as `ebo corpus query`, and
writes one bounded `sha256-<run-attempt-tuple>.json` file per selection. It fails rather than skipping
an invalid or unsupported selected bundle. `createRetainedBehaviorEvidence`
dispatches verified native session records to each source-specific normalizer and
resolver. `createRetainedStructuralObservationSet` is the corresponding public
library call; the older Agent SDK-specific calls remain available. The same
loader supplies judge input, assertion validation, calibration, and aggregation.
Unsupported source fields remain unavailable; native schemas and identities
are preserved. Supplemental bundle metadata is retained separately as
`outcomeCapture`, so it cannot replace source-native session records.
OpenHands datasets retain their captured runtime version (`1.44.1` or `1.46.0`).
DeepSeek reapplies its native composition, capability, initialization, prompt,
and completed receipt-to-idle/runtime-reap gate before normalization; qualified
partial captures remain qualified-with-gaps. Physical JSONL locators stay
unchanged, and normalization qualification cannot exceed either the structural
bundle gate or the source-specific gate.

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
