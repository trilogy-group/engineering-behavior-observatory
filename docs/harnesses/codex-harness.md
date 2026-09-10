# Codex app-server harness

EBO can execute one selected frozen queue entry through an owned
`codex app-server --listen stdio://` child. The adapter is optional; the Claude
Agent SDK remains EBO's primary Anthropic capture path. Codex native protocol
records remain authoritative, OTLP is separately retained timing/resource
evidence, and uniform events are a digest-checked projection after capture.

The baseline is `codex-cli 0.153.4`. EBO rejects a different executable
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

[`contracts/codex-app-server-0.153.4/manifest.json`](../../contracts/codex-app-server-0.153.4/manifest.json)
pins the generated root digests and the small schema/type subset used by the
adapter and its fixtures. Regenerate the source contracts with the pinned CLI:

```sh
codex app-server generate-ts --experimental --out /tmp/codex-types
codex app-server generate-json-schema --experimental --out /tmp/codex-schema
```

The adapter uses the stable initialize/thread/turn lifecycle, plus generated
leaf contracts for initialized, `thread/read`, `turn/interrupt`, and token usage.
Unknown notifications are retained unchanged and listed as unmapped.

The 0.153.4 refresh preserves the unchanged RPC, approval, sandbox, interruption
and usage contracts. Initialization moved into the generated `v1` schema
directory. The retained subset also includes thread/turn start parameters.
New captures explicitly select legacy history; paginated or summary-only
readback is retained with a gap instead of being claimed as complete history.
The pinned runtime treats `writableRoots` as additional to the effective `cwd`
and removes a redundant cwd entry. EBO verifies that cwd matches the requested
workspace, rejects additional roots, and requires the requested network and
temporary-directory restrictions. Initial thread effort and sandbox overrides
match the explicit turn policy.

Existing 0.150.1 bundles remain readable through their original normalization
profile and dataset identity. The legacy contract snapshot stays checked in;
a captured synthetic 0.150.1 bundle and its pre-upgrade normalized dataset test
exact readback. New captures use the 0.153.4 profile. Frozen run configurations
for the older executable are not rewritten: new execution requires fresh
configuration references carrying the new runtime version and contract digest.

## Queue configuration

The queue keeps condition IDs path-safe; the digest-pinned model record carries
the actual provider model and effort. A minimal observational configuration is:

```json
{ "schemaVersion": "ebo.codex-config/v1", "kind": "model", "provider": "openai", "model": "gpt-5.6-sol", "effort": "high" }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "harness", "adapter": "codex-app-server", "executable": "/opt/homebrew/bin/codex", "version": "0.153.4", "contractDigest": "sha256:e5f798fd1343c539f01fedea0e8a84a43c080fcca4615c80eb04a5edab4f7d0a" }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "native-limits", "shutdownGraceMs": 2000 }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "native-tool-policy", "approvalPolicy": "never", "sandbox": "workspace-write" }
{ "schemaVersion": "ebo.codex-config/v1", "kind": "capture-profile", "telemetrySignals": ["logs", "traces", "metrics"], "workspaceOutcome": { "excludeDirectoryNames": ["node_modules"] } }
```

Each record is referenced by the existing experiment/queue contract. After task
admission, freeze, and matrix compilation, execute exactly one entry:

```sh
ebo codex run \
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
is considered full readback only when the thread reports `historyMode: legacy`
and the owned turn reports `itemsView: full` with an items array. A request
acknowledgement, final-looking message, idle state, or process exit is not
completion.

An approved synthetic smoke uses an already authenticated route:

```sh
EBO_LIVE_CODEX_CAPTURE_SMOKE=1 EBO_LIVE_CODEX_CAPTURE_MODEL='<existing-route>' \
  node --test --test-name-pattern='approved existing-auth' dist/test/codex.test.js
```

The 0.153.4 validation created the exact synthetic file, retained full legacy
history, and reported no capture gaps. Logs and traces arrived; metrics did not
arrive within the bounded run and remained `missing`, not a fabricated receipt.

On interruption EBO sends `turn/interrupt`, records its acknowledgement, waits
briefly for matching terminal evidence, then tears down the owned child. There
is no invented shutdown RPC. Requests, responses, server requests,
notifications, unknown variants, completion evidence, stderr diagnostics, and
process state append to `session.jsonl` with one receive/write sequence.
Malformed frames, early exit, auth failure, and bounded teardown remain valid
partial evidence. Workspace outcome capture runs independently and leaves the
source workspace available when post-start packaging fails.

The `ebo codex run` command turns scoped `SIGINT` and `SIGTERM` handlers into
the run's abort signal, allowing interruption, history readback, process
teardown, and partial-bundle finalization to complete before the CLI exits.
Library callers receive the same two-second default shutdown grace at both the
lifecycle and app-server boundaries unless they provide an explicit value.

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

Restricted native session evidence retains Codex reasoning records unchanged.
Partner and public derivatives remove `item/reasoning/textDelta` content,
reasoning-item summary/content fields, and matching duplicated raw frames;
portable readback fails closed if any of those content forms remain.

## Uniform mapping

| Native evidence | Uniform family | Rule |
|---|---|---|
| completed user/agent message item | `message` | completed item only |
| completed command/MCP/dynamic/web-search item | `tool` | completed item only; starts and deltas stay native |
| completed file-change item | `artifact` | content references the native item |
| completed exposed collaboration item | `delegation` | no inferred child history |
| turn plan or compaction notification | `context` | only when emitted |
| token usage, reroute, or completed hook | `runtime` | native values only |
| approval, permission, user-input, or elicitation request | `permission` | request and decision remain separate native records; other server requests stay unmapped |
| matching `turn/completed` | `outcome` | terminal status is native |

Model requests are deliberately unsupported: EBO does not infer an inference
request from a turn, reroute, or model switch. Item starts, deltas, history
readback, raw frames, and unknown methods remain unmapped rather than becoming
duplicate tool/message counts. `describeAndValidateCodexDataset` runs the
native-reference, digest, content-reference, capability, and coverage checks.

Portable export uses the existing fail-closed sanitizer and readback. Native
source bundles stay restricted; authentication/account material, local paths,
environment values, and hidden reasoning are not approved portable fields.

Protocol details follow the official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
Exporter fields follow the official [advanced telemetry guidance](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
