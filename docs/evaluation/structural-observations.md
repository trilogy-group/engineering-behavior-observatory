# Outcome ingestion and structural observations

Retained native loading accepts the implemented source versions: OpenHands
1.44.1/1.46.0, DeepSeek SDK 0.1.7-rc.2, and Codex 0.150.1/0.153.4/0.157.0. Unsupported versions
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
- a cumulative-final record is used directly; otherwise the latest cumulative
  snapshot in one known native-order domain is used, and per-request
  increments derived from the same updates are not added to it; increments are
  summed only when every record declares increment semantics;
- native token categories stay separate, native total tokens are never rebuilt
  from components, and cost does not imply subscription utilization;
- compaction counts include only native records that explicitly identify a
  compaction boundary.

An observed zero is emitted only with available family coverage. Partial or
unsupported capability, ambiguous identity, unknown order, overlapping usage,
or missing timing remains `unavailable` with a reason. Observational runs have
no verifier assertion records and make no task-pass claim. Verified runs retain
each assertion outcome with its native verifier citation.

## Occurrences

Extractor `1.1.0` adds `occurrences` beside the attempt-level counts. Each
occurrence is one instance of a pattern and lists only its own events and native
records, so a judge or reviewer can open exactly that instance:

| Type | One occurrence | Rule |
| :--- | :--- | :--- |
| `failure-response` | within one resolved session, agent and order domain: consecutive explicit failures of one tool, then the next call of that tool that starts after the last failure | exact |
| `validation-run` | one call whose command runs a test, typecheck, lint or build, classified per command segment; `result`, `reportedExitCode`, `outputRedirected` | heuristic |
| `source-change` | an explicit mutation record, or an edit/write tool call or shell command that writes a source path and has a native success result (`detectedBy`); failed or unfinished attempts are not changes | heuristic except explicit mutations |
| `repeated-operation` | a call with the same tool and input digest as an earlier one | exact |
| `compaction` | adjacent compaction records with no tool event or model/user message between them and no repeated record kind; a partial boundary stays on its own | heuristic |
| `delegation` | the records of one delegated task, joined by task or agent ID | exact |

IDs are `<attemptId>/occ/<type>/<firstEventId>`. A failure is an explicit native
failure flag or non-zero exit code; failure text inside a successful call's
output does not count, and validation runs report it as `reportedExitCode`.
`occurrenceCoverage` reports each type as available with its count, or
unavailable with a reason: delegation when the adapter does not expose it, and
command-based types when native tool content is not available. An unavailable
type is never an observed zero.
