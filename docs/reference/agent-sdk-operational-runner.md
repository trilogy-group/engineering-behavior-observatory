# Agent SDK queue configuration

This reference describes the implemented `ebo agent-sdk run` input contract.
For authentication and native evidence, start with
[the harness guide](../harnesses/claude-agent-sdk.md). For packet preparation,
see [the operator workflow](../guides/operator-guide.md).

## Command

```sh
ebo agent-sdk run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
```

The runner validates a persisted queue entry, rechecks its frozen packet and
configuration digests, materializes a disposable workspace, and calls the
capture API once. It retains a starting baseline until outcome capture finishes,
then reopens the manifest before returning a summary.

The summary contains `runId`, `attemptId`, `bundlePath`,
`assessmentMode`, `terminal`, `classification`, and
`captureQualification`, plus native session/trace IDs when available.
A captured failure or stop is a valid observation, not necessarily a nonzero
CLI exit. Preflight or final validation failures return nonzero.

## Five configuration records

Each JSON block below is a **separate file**, referenced and SHA-256 pinned by
the experiment/queue. Bounds and model values are examples, not research
defaults. Authentication stays in the process environment.

```json
{ "schemaVersion": "ebo.agent-sdk-config/v1", "kind": "model", "model": "sonnet" }
```

```json
{ "schemaVersion": "ebo.agent-sdk-config/v1", "kind": "harness", "adapter": "claude-agent-sdk" }
```

```json
{
  "schemaVersion": "ebo.agent-sdk-config/v1",
  "kind": "native-limits",
  "maxTurns": 8,
  "maxBudgetUsd": 1
}
```

```json
{
  "schemaVersion": "ebo.agent-sdk-config/v1",
  "kind": "native-tool-policy",
  "tools": ["Read", "Edit", "Bash"],
  "allowedTools": ["Read", "Edit", "Bash"],
  "disallowedTools": [],
  "permissionMode": "dontAsk"
}
```

```json
{
  "schemaVersion": "ebo.agent-sdk-config/v1",
  "kind": "capture-profile",
  "telemetry": {
    "endpoint": "http://127.0.0.1:4318",
    "protocol": "http/json",
    "exportIntervalMs": 1000,
    "logUserPrompts": false,
    "logToolDetails": false,
    "logToolContent": false,
    "logRawApiBodies": false
  },
  "workspaceOutcome": {
    "excludeDirectoryNames": ["node_modules", "coverage"],
    "respectGitignore": true,
    "omitEmptyDirectories": true
  }
}
```

Rules:

- The queue entry's model, harness, native-limits, native-tool-policy, and queue-level capture-profile references must resolve to the corresponding `kind`.
- Duplicate JSON keys, unknown fields, unsafe numbers, wrong kinds, digest mismatches, malformed UTF-8, and malformed JSON are rejected before SDK launch.
- The model record's `model` must equal the queue entry's model ID, matching the existing capture invariant.
- The harness adapter must be `claude-agent-sdk`.
- `maxTurns` and `maxBudgetUsd` are optional positive limits. The queue's coordinator `maxWallClockMs` remains the outer wall-clock limit.
- Tool lists are arrays of unique nonempty strings. Preserve Agent SDK names; do not invent a common tool ontology.
- `bypassPermissions` is accepted only when `allowDangerouslySkipPermissions` is explicitly true, matching the existing executor safeguard.
- Telemetry content flags default to false. Credentials and environment overrides are never read from these JSON files; authentication stays in the process environment.
- A configured telemetry endpoint without a receipt checker remains explicit `not-checked` or missing receipt evidence. Do not claim collector receipt from a successful HTTP configuration alone.

## Retention and recovery

The output bundle is written under `<output-root>/<run-id>/<attempt-id>`.
Each invocation has a fresh attempt identity. The command does not iterate,
resume, or silently retry; ordinary CLI reruns do not claim linked retry lineage.

Only the admitted `agentInput` prompt and materialized fixture enter execution.
Observational packets have no verifier. Verified packets run their admitted
verifier on the retained workspace snapshot and keep its result separate from
capture qualification.

The capture layer retains complete or partial native evidence after execution
starts. If workspace packaging fails, the summary may expose
`retainedWorkspacePath` for local recovery. Do not delete that directory until
the outcome has been recovered. Cleanup failure after successful packaging
also leaves the path visible; it does not erase the retained bundle.

## Library use

`runAgentSdkQueueEntry` accepts the same paths and selected run ID, plus
an optional abort signal and in-process test/receipt callbacks.
`captureClaudeAgentSdkRun` accepts an already-resolved attempt and explicit
workspace composition. Neither is a general task generator or study scheduler.

See [lifecycle](run-lifecycle.md) and
[run-bundle contracts](run-bundle-contract.md) for ownership, interruption,
qualification, and artifact invariants.
