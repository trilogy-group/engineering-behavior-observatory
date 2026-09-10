# Run lifecycle and process protocol

`src/lifecycle.ts` owns one declared run cell and one attempt. A run is
identified by task, model, and harness IDs; an attempt gets a fresh ID and
number. `retryAttempt` links a later attempt with `retryOf`, so callers must
choose a distinct record/evidence path. Attempt paths are reserved before any
callback runs; an existing record path is never reopened by a new execution,
and the runner never retries implicitly.

The guarded attempt phases are:

```text
created -> setup -> running -> verifying -> cleaning -> terminal
```

Setup, harness execution, optional verifier execution, cleanup, and evidence flushing
are injected callbacks. Setup and harness drivers can register independent
shutdown handles for in-flight processes. `executeRunAttempt` passes an
`AbortSignal`, enforces the coordinator and harness budgets, and records phase
timestamps in an
`ebo.attempt/v1` record. Each record declares `observational` or `verified`
assessment. An observational attempt skips the verifying phase; normal harness
termination plus retained workspace evidence is execution completion, not task
success. Only a failed verifier on a verified task with retained workspace
evidence is a task failure; a harness-declared task result without verifier
evidence remains an infrastructure failure. A verifier execution error, setup
error, harness error, or cleanup error after an otherwise successful run is
also infrastructure evidence. A verified completed attempt needs both a passed
verifier and a retained workspace artifact; an observational completed attempt
needs the workspace artifact and carries no verifier evidence. Missing capture flush support is
explicit as `capture-incomplete` and does not become a task failure.

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
IDs cannot be silently rewritten by a JavaScript round trip. The stdout line
limit is enforced while bytes are consumed. When a caller supplies a JSONL
writer, the process derives a conservative effective stdout limit from that
writer's per-record envelope capacity so retaining both raw and parsed frame
evidence cannot turn a valid frame into an append failure. In-memory
observations use a bounded tail; the JSONL file remains the complete source
record. Interruption and malformed output therefore leave a readable partial
evidence file and a process result with launch identity, exit/signal state, and
termination reason.
`shutdown()` and `interrupt()` are explicit operations; no process retry is
performed.
