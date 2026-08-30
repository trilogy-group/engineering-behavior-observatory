# Run lifecycle and process protocol

`src/lifecycle.ts` owns one declared run cell and one attempt. A run is
identified by task, model, and harness IDs; an attempt gets a fresh ID and
number. `retryAttempt` links a later attempt with `retryOf`, so callers must
choose a distinct record/evidence path. The runner never retries implicitly.

The guarded attempt phases are:

```text
created -> setup -> running -> verifying -> cleaning -> terminal
```

Setup, harness execution, verifier execution, cleanup, and evidence flushing
are injected callbacks. `executeRunAttempt` passes an `AbortSignal`, enforces
the coordinator and harness budgets, and records phase timestamps in an
`ebo.attempt/v1` record. A verifier failure is a task failure; a verifier
execution error, setup error, harness error, or cleanup error after an
otherwise successful run is infrastructure evidence. Capture flush failures
remain explicit as `capture-incomplete` and do not become task failures.

`src/process-protocol.ts` is a narrow process boundary, not a JSON-RPC
implementation. `ProtocolProcess` parses newline-delimited JSON only to reject
malformed stdout, keeps stdout machine-only, and drains bounded stderr into a
diagnostic result (and optional `stderrPath`). `ProtocolEvidenceRecorder`
retains raw frames plus caller-supplied request, response, notification,
completion, and capability observations. Drivers provide method names,
correlation IDs, native identities, and completion evidence; the runner does
not infer prompt completion or map records into EBO event families.

JSONL records are flushed and fsynced as they arrive. Valid frames retain their
original line text alongside parsed data, so duplicate keys or large numeric
IDs cannot be silently rewritten by a JavaScript round trip. Interruption and
malformed output therefore leave a readable partial evidence file and a
process result with launch identity, exit/signal state, and termination reason.
`shutdown()` and `interrupt()` are explicit operations; no process retry is
performed.
