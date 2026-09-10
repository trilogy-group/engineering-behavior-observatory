# Claude Agent SDK

EBO calls the TypeScript Agent SDK directly. It captures the native message
stream, passive lifecycle hooks, exposed session identities, usage, telemetry
receipt state, and a retained workspace outcome.

## Run one task

After [preparing and freezing a queue](../guides/operator-guide.md):

```sh
ebo agent-sdk run <bundle-root> <queue.json> <run-id> <output-root>
```

The adapter uses `@anthropic-ai/claude-agent-sdk@0.3.258`. It probes the
installed SDK/CLI and records version-specific capabilities rather than
assuming every hook is available. Runtime pins are implementation conditions,
not assurances that a provider model route is accessible.

Supply an approved Agent SDK authentication route through the environment.
The opt-in OAuth proofs use `CLAUDE_CODE_OAUTH_TOKEN` with
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset. Do not put credentials
in packet or queue JSON. EBO does not establish entitlement to a model.

The queue references five records: model, harness, native limits, tool policy,
and capture profile. See the [configuration reference](../reference/agent-sdk-operational-runner.md)
for accepted fields and examples. Tool permission settings can prevent a
headless run from proceeding; review them before committing to a long task.

## Read the capture

| Evidence | What it establishes |
| :--- | :--- |
| Native SDK stream | Messages, tool-related content, result and session identities |
| Passive hooks | Exposed lifecycle callback occurrences, including failures and compaction |
| Telemetry | Received timing/resource signals, with gaps recorded independently |
| Workspace evidence | Retained changes against the frozen starting tree |
| Capture report | Structural validity, source capabilities, and missing evidence |

A hook's occurrence is authoritative in callback evidence; a hook span is
optional timing data. Hooks do not modify the agent's choices. Native reasoning
may be present in restricted source data and is removed from portable exports.

Tracing is beta; metrics/log events are separate capabilities. Content capture
is opt-in. Short export intervals **and** clean shutdown reduce buffering loss,
but collector receipt must still be checked. See [telemetry](../guides/telemetry.md).

## Completion and interruption

The command executes one queue entry, with a fresh attempt identity and output
directory. It does not loop through the queue or silently retry. A valid
captured stop or failure can return a successful CLI exit: inspect the summary
and manifest to interpret the result.

If workspace packaging fails, preserve the summary's
`retainedWorkspacePath` for recovery. Missing outcome evidence cannot be
called qualified completion. See [failure recovery](../guides/operator-guide.md#failure-recovery).

Library operators can call `runAgentSdkQueueEntry` for queue execution or
`captureClaudeAgentSdkRun` for an already-resolved attempt. The latter
requires explicit workspace/lifecycle composition; it is not a task preparer.
