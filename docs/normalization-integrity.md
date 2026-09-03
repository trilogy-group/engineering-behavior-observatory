# Normalization integrity and comparison gates

Normalization is accepted only when every projected event remains bound to one
capture-qualified run and attempt. The native record stays authoritative; the
normalized dataset retains only its source reference, native type, and digest.

## Dataset validation and coverage

`describeNormalizedDataset` combines a qualified capture, its normalization
result, the adapter capability profile, and the pinned adapter version into an
`ebo.normalized-dataset/v1` record. It rejects input that is not explicitly
`qualified` or `qualified-with-gaps`. `validateNormalizedDataset` then checks:

- the dataset, event, and capability-profile schemas;
- stable run, attempt, adapter, harness, and native-type identity;
- resolver-provided run/attempt ownership and each native record digest;
- source and content references, event relations, and acyclic parentage;
- nondecreasing order within each native order domain;
- that every native record is mapped or explicitly retained as unmapped; and
- that emitted families and evidence do not contradict adapter capabilities.

The resolver must return `{ runId, attemptId, digest }` for native record
references. A boolean resolver remains supported by the lower-level uniform
event validator, but it is insufficient for dataset integrity validation.
`createCapturedNativeEvidenceResolver` supplies the stronger metadata for an
in-memory qualified capture and can delegate other content references to an
adapter-specific resolver. Derived JSON Pointer locators are resolved against
the source record; the helper never treats a containing record as proof that an
arbitrary child locator exists.

Successful validation returns an `ebo.adapter-coverage-report/v1` report. It
counts mapped and unmapped native records by adapter version and native type.
For each uniform family it reports both the declared capability status and the
observed event count. Consequently, an unsupported family with zero events is
not confused with an available family that happened to have zero observations.
Unknown source records remain present in the native-type table and in the
dataset's `unmapped` list.

DeepSeek JSON-RPC methods and OpenHands REST/WebSocket record kinds remain
native types in these reports. They do not create event families or imply a
shared control protocol.

## Comparison eligibility

The comparison gate consumes one explicit `ebo.comparison-request/v1` artifact:

```sh
node dist/src/cli.js comparison check <request.json>
```

The request names both candidates, their task and fixture digests, model and
harness configuration identities, material capture/budget/tool-policy digests,
capability profiles, required capabilities, and any declared model or harness
difference. The command prints an `ebo.comparison-report/v1` JSON object and
returns nonzero when its status is `unsupported`.

Statuses are:

- `supported`: conditions match and required capabilities are available;
- `qualified-with-caveats`: a model/harness difference was declared or a
  required capability is partial; and
- `unsupported`: task, fixture, material configuration, or undeclared
  model/harness conditions differ, or a required capability is unsupported.

Declaring a model or harness difference makes that difference inspectable; it
does not claim identical conditions or establish that the harness caused an
observed behavioral difference.

The schema is
[`schemas/normalization-integrity.v1.json`](../schemas/normalization-integrity.v1.json).
Exact-match and incompatible-fixture examples live under
[`test/fixtures/comparison`](../test/fixtures/comparison).
