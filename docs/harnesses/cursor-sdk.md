# Cursor TypeScript SDK harness

EBO can execute one selected frozen queue entry through the first-party
`@cursor/sdk` local-agent API. The integration pins SDK `1.0.31`, creates an
attempt-owned `JsonlLocalAgentStore`, and retains stream messages, detailed
callbacks, terminal `wait()` evidence, conversation history, billing readback,
the official native store, and the final workspace before normalization.

The SDK package version does not freeze Cursor's service, selected model, or
separately deployed local runtime. The selected model must be an exact result
from `Cursor.models.list()` at launch. SDK `1.0.31` does not expose a separate
local-runtime version or SDK-local per-run OTLP configuration/receipt surface,
so EBO records those capabilities as `not-exposed` and `unsupported` instead of
inventing identities or spans.

Cursor also offers a distinct [Enterprise OpenTelemetry Export](https://prod.cursor.com/docs/enterprise/opentelemetry-export)
configured by a team admin. It runs server-side and pushes OTLP/HTTP protobuf
metrics and logs to one public HTTPS collector; the [wire reference](https://prod.cursor.com/docs/enterprise/opentelemetry-export/wire)
includes `sdk_ts` as an entrypoint. This adapter does not configure or receive that
team export. Its metrics are aggregate deltas without conversation/request IDs,
and although logs have dedupe IDs plus optional conversation/request/usage-event
IDs, the public docs do not establish an exact join from those fields to this
SDK's agent/run IDs. It provides no traces, prompt content, or historical
backfill. EBO therefore records Enterprise export as `not-checked`, separately
from the SDK-local `unsupported` result; future ingestion would require an
approved admin destination and observed identity correlation evidence.

## Safety policy

Local tool execution is not an OS or container sandbox. EBO requires all of
the following digest-pinned settings for every Cursor queue entry:

- an explicit `sandbox.enabled` boolean; `true` can reject writes that require
  interactive approval in a headless run, while `false` executes with the
  invoking user's OS permissions and is not containment;
- an explicit built-in tool allowlist and optional deny list;
- `settingSources: []`, so candidate project files and unrelated user, team,
  MDM, or plugin settings are not silently loaded;
- `autoReview: false`, so instrumentation does not add a behavior-changing
  classifier; and
- `enableAgentRetries: true`, enabling Cursor's native transport/stall recovery
  within the owned run. EBO does not add a retry loop or replacement attempt.

Before agent creation, EBO calls
`Cursor.configure({ local: { useHttp1ForAgent: true } })` to select HTTP/1.1
for local backend streams. This mitigates the observed `NGHTTP2_INTERNAL_ERROR`;
it is not a proven root-cause fix. Both settings use the
[public SDK API](https://cursor.com/docs/sdk/typescript).
The native `configuration` record retains `transport.useHttp1ForAgent` and
`toolPolicy.enableAgentRetries`. Terminal errors and partial evidence remain
retained if native recovery fails; the attempt deadline still applies.

Existing frozen policies with retries disabled are rejected at launch, not
silently overridden. Prepare new configuration records and a new queue for
future runs; preserve earlier frozen experiments and captures unchanged.

SDK `1.0.31` treats an ancestor Git checkout as the local project root. EBO
therefore rejects a materialized workspace nested under another `.git` path
before starting the SDK. Use the default system temporary parent or pass a
`--workspace-root` outside the invoking checkout; this prevents accidental
ancestor-project routing but is not OS containment.

No MCP servers, custom callback tools, subagents, cloud repositories, remote PR
automation, or environment values are loaded from configuration. Supply
`CURSOR_API_KEY` only in the process environment through the approved secret
path; it is passed directly to the SDK and never written to an artifact. The
SDK owns its child processes and does not expose a per-agent environment
allowlist in this pin. During the deliberately single-entry SDK run, EBO keeps
only platform/network variables and `CURSOR_API_KEY` in the process environment,
records the allowed key names (never values), and restores the original
environment after agent disposal. Concurrent in-process Cursor captures are
rejected while that boundary is active.

## Configuration records

The queue points to five digest-pinned `ebo.cursor-sdk-config/v1` records. The
minimal examples under [`examples/cursor-sdk`](../../examples/cursor-sdk/README.md) are
caller inputs, not defaults. Replace the model placeholder with one exact
catalog ID before computing digests and compiling a queue. The experiment's
model-set key remains a path-safe condition ID; it need not duplicate a
provider ID containing dots.

```json
{ "schemaVersion": "ebo.cursor-sdk-config/v1", "kind": "model", "provider": "cursor", "model": { "id": "<exact-catalog-model-id>" } }
```

```json
{ "schemaVersion": "ebo.cursor-sdk-config/v1", "kind": "harness", "adapter": "cursor-sdk", "sdkVersion": "1.0.31" }
```

```json
{ "schemaVersion": "ebo.cursor-sdk-config/v1", "kind": "native-limits", "shutdownGraceMs": 2000, "maxNativeRecordBytes": 16777216 }
```

```json
{ "schemaVersion": "ebo.cursor-sdk-config/v1", "kind": "native-tool-policy", "tools": ["read", "edit", "grep", "glob", "ls"], "disallowedTools": ["shell", "task", "mcp", "webSearch", "webFetch"], "sandbox": { "enabled": false }, "settingSources": [], "autoReview": false, "enableAgentRetries": true }
```

```json
{ "schemaVersion": "ebo.cursor-sdk-config/v1", "kind": "capture-profile", "nativeOtlp": "unsupported", "workspaceOutcome": { "excludeDirectoryNames": ["node_modules"] } }
```

Use the existing packet admission, freeze, matrix compilation, and queue
validation commands from the [operator guide](../guides/operator-guide.md). Then run one
persisted entry:

```sh
# After injecting CURSOR_API_KEY through the approved secret environment:
ebo cursor run \
  <bundle-root> <queue.json> <run-id> <output-root> \
  --workspace-root <workspace-parent>
```

The output destination is never replaced. Interrupting the command cancels the
owned run within the configured shutdown grace. Provider, stream, history,
recorder, store, workspace, and cleanup failures retain a partial attempt and
cannot produce qualified-complete capture.

## Evidence and overlap policy

| Channel | Retained role | Normalized role |
|---|---|---|
| `run.stream()` | lifecycle, messages, tools, per-turn usage | authoritative message/tool/usage projection |
| `onDelta` / `onStep` | lower-level deltas, nested updates, step snapshots | retained as overlap evidence; not counted again |
| `run.wait()` | owned terminal status, duration, cumulative usage | authoritative outcome; cumulative usage is not re-added |
| `run.usage` | cumulative finalization snapshot, including failed/interrupted runs | retained separately; not added to per-turn totals |
| `run.conversation()` | durable conversation readback before disposal | retained as history; not counted again |
| `agent.getUsage()` | eventually consistent billing scope/read time | separate billing evidence; absence does not invalidate semantic capture |
| `JsonlLocalAgentStore` | agents, runs, run events, checkpoints | authoritative native persistence; not counted again |

Every callback value is JSON-snapshotted at receipt and writes are serialized.
Finalization reads `run.usage` without waiting for a successful terminal result
or making another provider request. The `usage-snapshot` record identifies its
source, cumulative semantics, and availability. An unavailable value is not
zero. A getter or recorder failure is recorded as a capture gap without
replacing the original terminal error or skipping cleanup. Abrupt process
termination cannot guarantee a final snapshot.
Unknown tool payloads remain in restricted native evidence. Portable export
recursively removes thinking/reasoning content and checkpoint blob bytes, then
redacts secrets, local identifiers, paths, and source correlations. Restricted
source artifacts are unchanged.

## Capability matrix

| Capability | Status | Basis |
|---|---|---|
| messages | available | SDK stream user/assistant records |
| tools | available | SDK stream `tool_call` identity/status/args/result |
| context | partial | detailed summaries/nested updates retained, not reconstructed |
| delegation | partial | task tool retained without invented subagent lifecycle |
| artifacts | unsupported | tool names retain intent only; verified workspace outcome remains separate and authoritative |
| usage | available | per-turn stream increments; cumulative/billing channels remain separate |
| terminal outcome | available | exact owned `run.wait()` result |
| parentage/native time | partial | exposed identities and adapter receipt order only |
| SDK-local OTLP configuration/receipt | unsupported | no public SDK `1.0.31` per-run API |
| Enterprise team OTLP export | not checked | server-side metrics/logs exist, but no destination or exact SDK run correlation was verified |
| OS containment | unsupported | SDK sandbox policy is not an OS/container boundary |

Run the deterministic contract proof with:

```sh
npm run build
node --test dist/test/cursor-sdk.test.js
```

That fixture covers frozen queue execution through workspace retention,
qualification, export/readback, observations, existing judge evidence,
comparison/aggregation, and Atlas drilldown. It is not proof of live provider
authentication. A live smoke must use an exact currently available catalog
model and one bounded synthetic local workspace edit through the same command.
