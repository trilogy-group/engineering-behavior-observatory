# Codex app-server harness

EBO can execute one selected frozen queue entry through an owned
`codex app-server --listen stdio://` child. The adapter is optional; the Claude
Agent SDK remains EBO's primary Anthropic capture path. Codex native protocol
records remain authoritative, OTLP is separately retained timing/resource
evidence, and uniform events are a digest-checked projection after capture.

The baseline is `codex-cli 0.150.1`. EBO rejects a different executable
version, starts a new child for each attempt, and never connects to the desktop
daemon or changes `~/.codex/config.toml`.

Each child receives a temporary isolated `CODEX_HOME`, a controlled instruction
file, and no copied user configuration. When the standard local login file is
available, EBO references it with a temporary symlink so the supported login is
reused without reading, copying, or retaining credential bytes. The temporary
home and native Codex history are removed after `thread/read`; EBO retains only
the captured protocol evidence.
The child environment is an allowlist of basic process/locale keys with `HOME`
and `CODEX_HOME` redirected to that temporary directory; caller secrets and
Node preload settings are not inherited. Retained evidence records the key
names, never their values.

## Generated contract

[`contracts/codex-app-server-0.150.1/manifest.json`](../contracts/codex-app-server-0.150.1/manifest.json)
pins the generated root digests and the small schema/type subset used by the
adapter and its fixtures. Regenerate the source contracts with the pinned CLI:

```sh
codex app-server generate-ts --experimental --out /tmp/codex-types
codex app-server generate-json-schema --experimental --out /tmp/codex-schema
```

The adapter uses the stable initialize/thread/turn lifecycle, plus generated
leaf contracts for initialized, `thread/read`, `turn/interrupt`, and token usage.
Unknown notifications are retained unchanged and listed as unmapped.

## Queue configuration

The queue keeps condition IDs path-safe; the digest-pinned model record carries
the actual provider model and effort. A minimal observational configuration is:

```json
{ "schemaVersion": "ebo.codex-config/v1", "kind": "model", "provider": "openai", "model": "gpt-5.6-sol", "effort": "high" }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "harness", "adapter": "codex-app-server", "executable": "/opt/homebrew/bin/codex", "version": "0.150.1", "contractDigest": "sha256:844b52d4a5a8cda58794e28b3b119c3a3d20a588b7db83209c298bec62704092" }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "native-limits", "shutdownGraceMs": 2000 }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "native-tool-policy", "approvalPolicy": "never", "sandbox": "workspace-write" }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "capture-profile", "telemetrySignals": ["logs", "traces", "metrics"], "workspaceOutcome": { "excludeDirectoryNames": ["node_modules"] } }
```

Each record is referenced by the existing experiment/queue contract. After task
admission, freeze, and matrix compilation, execute exactly one entry:

```sh
node dist/src/cli.js codex run \
  <bundle-root> <queue.json> <run-id> <output-root> \
  --workspace-root <disposable-workspace-parent>
```

`runCodexQueueEntry` is the equivalent library API. It does not iterate, retry,
resume, or overwrite an existing attempt destination.

## Lifecycle and evidence

The client sends `initialize`, `initialized`, `thread/start`, and `turn/start`.
Only `turn/completed` for the returned thread and turn ends the native attempt.
After completion or interruption, `thread/read` with `includeTurns: true`
retains persisted history separately from streamed item records. A request
acknowledgement, final-looking message, idle state, or process exit is not
completion.

On interruption EBO sends `turn/interrupt`, records its acknowledgement, waits
briefly for matching terminal evidence, then tears down the owned child. There
is no invented shutdown RPC. Requests, responses, server requests,
notifications, unknown variants, completion evidence, stderr diagnostics, and
process state append to `session.jsonl` with one receive/write sequence.
Malformed frames, early exit, auth failure, and bounded teardown remain valid
partial evidence. Workspace outcome capture runs independently and leaves the
source workspace available when post-start packaging fails.

Unattended runs never fabricate human input or broaden permissions. Command and
file approvals receive `decline`; MCP elicitation receives `decline`; dynamic
tool calls fail without content; other unsupported server requests receive a
recorded JSON-RPC error. Effective model/provider/effort, sandbox, approval
policy, workspace, runtime identity, instruction sources, and material config
remain in restricted evidence.

## Native telemetry and usage

When requested, EBO starts a bounded loopback OTLP/HTTP JSON receiver and passes
the documented `otel.exporter`, `otel.trace_exporter`, and
`otel.metrics_exporter` overrides to the owned child. `otel.log_user_prompt` is
always false. Each signal is classified independently as `received`, `missing`,
or `disabled`; configured export is never treated as receipt. Exported batches
are retained without synthetic spans or time-based joins.
The receiver accepts at most 256 records, 4 MiB per request, and 16 MiB total;
rejected requests remain explicit receiver diagnostics.

`thread/tokenUsage/updated` retains cumulative `total` and per-turn `last`
values separately, including `totalTokens`, `inputTokens`,
`cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, and
`reasoningOutputTokens` when emitted. EBO does not sum cumulative updates or
turn cache/reasoning subsets into additional cost. Account quota and billing
remain unavailable unless supplied by separate evidence.

## Uniform mapping

| Native evidence | Uniform family | Rule |
|---|---|---|
| completed user/agent message item | `message` | completed item only |
| completed command/MCP/dynamic/web-search item | `tool` | completed item only; starts and deltas stay native |
| completed file-change item | `artifact` | content references the native item |
| completed exposed collaboration item | `delegation` | no inferred child history |
| turn plan or compaction notification | `context` | only when emitted |
| token usage, reroute, or completed hook | `runtime` | native values only |
| server-initiated request | `permission` | request and decision remain separate native records |
| matching `turn/completed` | `outcome` | terminal status is native |

Model requests are deliberately unsupported: EBO does not infer an inference
request from a turn, reroute, or model switch. Item starts, deltas, history
readback, raw frames, and unknown methods remain unmapped rather than becoming
duplicate tool/message counts. `describeAndValidateCodexDataset` runs the COE-580
native-reference, digest, content-reference, capability, and coverage checks.

Portable export uses the existing fail-closed sanitizer and readback. Native
source bundles stay restricted; authentication/account material, local paths,
environment values, and hidden reasoning are not approved portable fields.

Protocol details follow the official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
Exporter fields follow the official [advanced telemetry guidance](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
