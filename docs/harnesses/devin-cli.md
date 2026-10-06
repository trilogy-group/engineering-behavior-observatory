# Devin CLI harness

EBO can execute one selected frozen queue entry through an owned `devin acp`
child: the Devin CLI's Agent Client Protocol (ACP) server over newline-delimited
JSON-RPC on stdio. The ACP frames are the semantic evidence, OTLP is separately
retained timing/resource evidence, and uniform events are a digest-checked
projection after capture. Inference and the Devin agent loop run in Cognition's
cloud; the CLI executes tool calls locally in the attempt workspace.

The supported runtime is `devin 3000.11.3`. EBO rejects a different executable
version (`devin --version`), starts a new child for each attempt, and never
reuses an interactive or desktop session.

Each child receives a temporary isolated `HOME` and `XDG_{CONFIG,DATA,CACHE,STATE}_HOME`
so the user's `~/.config/devin`, `~/.local/share/devin/cli/sessions.db`, and
login state are neither read nor modified. The child environment is an allowlist
of basic process/locale keys plus one credential variable (`credentialEnv`,
default `WINDSURF_API_KEY`) copied by name. Retained evidence records the key
names, never their values. The temporary home is removed after capture.

## Protocol ownership and terminal semantics

The adapter issues `initialize` (ACP protocol version 1), `session/new` with the
workspace as `cwd`, `session/set_mode` and `session/set_config_option` when the
agent's defaults differ from the frozen policy, and exactly one `session/prompt`.
Every frame in both directions is appended to `session.jsonl` as
`ebo.protocol-observation/v1` records before any normalization: raw inbound
frames, typed requests/responses/notifications, EBO's outbound requests, EBO's
answers to agent requests, a `completion` record, and a `process` record.

Only the `session/prompt` response matching the owned request id ends the
native attempt:

| Native `stopReason` | Attempt outcome |
| :--- | :--- |
| `end_turn` | completed |
| `cancelled` after EBO sent `session/cancel` | interrupted |
| any other value, or a JSON-RPC error | failed, with a `terminal-stop-reason` gap |

Process exit without that response is a `capture-error` gap; the partial
`session.jsonl`, stderr (`diagnostic/stderr` notifications inside it), and
process termination stay in the bundle. A malformed
stdout line ends the protocol (the raw line is retained in the process
diagnostics) rather than being guessed around.

Abort (SIGINT/SIGTERM on `ebo devin run`, or the coordinator budget) sends
`session/cancel`, waits the shutdown grace for the native `cancelled` response,
then closes stdin and escalates to SIGTERM/SIGKILL. The retained
`_cognition.ai/agent_stopped` notification carries `cause: "cancelled"`.

### Agent requests

Devin asks the client for `session/request_permission` before commands that the
selected mode does not pre-approve. EBO is an unattended client: it answers with
the frozen `permissionDecision` (`allow-once` or `reject-once`), selecting the
matching option kind the agent offered. Requests for other sessions are answered
`cancelled` with a `foreign-permission-request` gap; a missing option kind is
`cancelled` with `permission-option-missing`; other client methods
(`fs/*`, `terminal/*`) are declined with a JSON-RPC error and an
`unsupported-client-request` gap. Both the request and the answer are evidence.

## Queue configuration

```json
{ "schemaVersion": "ebo.devin-config/v1", "kind": "model", "provider": "cognition", "model": "swe-2-high", "credentialEnv": "WINDSURF_API_KEY" }
{ "schemaVersion": "ebo.devin-config/v1", "kind": "harness", "adapter": "devin-cli", "executable": "/opt/devin/bin/devin", "version": "3000.11.3", "contractDigest": "sha256:0b318ea3c233f2b74a98213ac9a2c7441c71d74d16bf5d4b421e55bc5b13139b" }
{ "schemaVersion": "ebo.devin-config/v1", "kind": "native-limits", "shutdownGraceMs": 2000 }
{ "schemaVersion": "ebo.devin-config/v1", "kind": "native-tool-policy", "mode": "accept-edits", "permissionDecision": "allow-once" }
{ "schemaVersion": "ebo.devin-config/v1", "kind": "capture-profile", "telemetrySignals": ["logs", "metrics"], "workspaceOutcome": { "excludeDirectoryNames": ["node_modules"] } }
```

- `model` is the native ACP `model` config option value (`swe-2-high`,
  `swe-1-7-lightning-medium`, …). EBO sets it with `session/set_config_option`
  and records a `model-mismatch` gap when the agent reports a different value.
- `mode` is the native session mode (`accept-edits`, `smart`, `bypass`, `plan`,
  `ask`); a `mode-mismatch` gap is recorded when the applied mode differs.
- `arguments` on the harness record are placed after `acp`
  (for example `["--agent-type", "review"]`).
- `telemetrySignals` is off by default. When set, EBO opens a loopback OTLP/HTTP
  receiver and writes an isolated `config.json` `otel` block pointing at it.

Run one entry:

```sh
ebo devin run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
```

## Retained evidence

| Artifact | Content |
| :--- | :--- |
| `session.jsonl` | Every ACP frame in receive/send order; restricted (`agent_thought_chunk` carries hidden reasoning) |
| `telemetry/devin.json` | Runtime (`agentInfo`, capabilities), effective configuration (applied model/mode, environment key names), OTLP receipt per signal and decoded records, `usage_update` snapshots, final `usage`, `agent_stopped` statistics |
| `workspace/…` | Workspace outcome packaged from the attempt directory |

Native `session/update` kinds observed with 3000.11.3: `session_info_update`,
`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
`usage_update`, `available_commands_update`, `config_option_update`,
`current_mode_update`. Cognition extensions: `_cognition.ai/thinking_complete`,
`_cognition.ai/turn_stats`, `_cognition.ai/agent_stopped`,
`_cognition.ai/mcp/serversChanged`. Tool calls carry `rawInput.command`,
streamed output content, and `_meta.terminal_exit.exit_code`. The live CLI
reports `terminal_exit` on an `in_progress` update and then sends the terminal
`completed`/`failed` update without it, so normalization carries the last
observed exit for the same `toolCallId` onto the terminal tool event.

ACP frames have no native timestamps. Every uniform event uses EBO receipt time
labeled `nativeTimeSource: capture-receipt`; OTLP log records keep their own
timestamps in telemetry evidence.

### OTLP

The CLI exports `application/x-protobuf` OTLP logs (`session_start`,
`user_prompt`, `api_request` with per-request token counts, `tool_decision`,
`tool_result`, `assistant_response`, `session_end`) and `devin.token.usage`
delta metrics. Every accepted body is retained as received (`body`, base64,
with a `bodyDigest`) inside the receiver bounds (4 MiB per request, 16 MiB per
attempt); EBO additionally decodes protobuf bodies with a small
standard-library decoder into their OTLP/JSON `payload` projection, and
undecodable bodies keep their original bytes alongside a `parseError`. Raw
bodies are restricted evidence: portable export removes `body` (encoded bytes
cannot be sanitized) and keeps `bodyDigest`, `sizeBytes` and the sanitized
projection, in which secret-named OTLP attributes (`api_key`, `token`, ...)
are redacted by their semantic `key` and the final export scan rejects any
such attribute left unredacted. Receipt is `received` only when every requested signal arrived.
OTLP never replaces ACP evidence, and the receiver is not a telemetry backend.

## Normalization

`DEVIN_CLI_CAPABILITIES` declares the projection. Mapped: `agent_message_chunk`
and `user_message_chunk` (`message`, one event per chunk), `tool_call`
(`tool`/before) and the terminal `completed`/`failed` `tool_call_update`
(`tool`/after, parent = the start event), `plan` (`context`),
`session/request_permission` (`permission`), `usage_update` and the owned
`agent_stopped` statistics (`runtime`, `resourceSemantics: cumulative-final`
for the native cumulative token metrics), and the owned `session/prompt`
response (`outcome`, with `stopReason` and the native `usage` labeled
`usageSemantics: final-request`, because Devin reports the final request of
the turn there rather than a turn total). In-progress tool
updates, thought chunks, config/mode/command updates, `turn_stats`, and all
frames for other sessions stay unmapped native evidence. Content is referenced
by record locator, never copied. Portable export removes `agent_thought_chunk`
content.

### Retained readback

`createRetainedBehaviorEvidence` reopens completed and partial Devin bundles
for observations, semantic judging, aggregation and Atlas.
`qualifyRetainedDevinCapture` re-establishes the owned identities before
normalization: one ordered `initialize`, `session/new` and `session/prompt`
request/response pair from `ebo-devin-client`, the `session/new` result
matching the manifest `run.native.sessionId`, every envelope identity and
`session/update` bound to that session, and, for completed bundles, exactly one
matching `end_turn` prompt response and completion record. The ACP handshake
reports a placeholder `agentInfo.version`, so the runtime version is verified
through `telemetry/devin.json` and the manifest runtime pins instead.

## Surfaces measured but not wired

- **Hooks**: `.devin/hooks.v1.json` in the workspace fires `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`,
  `SessionEnd` during ACP sessions; `tool_use_id` equals the ACP `toolCallId`.
  Hooks would be supplemental, not primary, evidence.
- **`devin -p --export`**: print mode writes an ATIF-v1.7 trajectory file. It is
  a different execution surface (noninteractive, needs
  `--permission-mode dangerous` for tool use) and is not equivalent to the ACP
  capture.
- **Local SQLite** (`sessions.db`: `sessions`, `message_nodes`,
  `tool_call_state`): implementation-specific durable state without ordered
  protocol frames; isolated away per attempt rather than read.
- **Devin Cloud API (`/v3/organizations/{org}/sessions/...`)**: session
  metadata, chat `messages`, `insights`, and `attachments` for cloud sessions.
  No verified endpoint returns tool calls or an ordered trajectory, and CLI/ACP
  sessions authenticate with a different credential than the Cloud API.

## Approved live smoke

The live smoke never runs by default. It needs an already authenticated
`WINDSURF_API_KEY` in the environment, the pinned CLI on `PATH` (or
`EBO_LIVE_DEVIN_EXECUTABLE`), and an explicit opt-in:

```sh
EBO_LIVE_DEVIN_CAPTURE_SMOKE=1 \
  node --test --test-name-pattern='approved existing-auth' dist/test/devin.test.js
```

It creates one synthetic file through a real `devin acp` turn, requires the
native `end_turn` response, an isolated user configuration, no capture gaps,
and asserts that the credential value never appears in retained evidence.

## Known limits

- The CLI executes tools locally with the user's permissions; the attempt
  workspace is not a sandbox, and `bypass` mode disables Devin's own prompts.
- Completion requires network access to Cognition; a dropped connection surfaces
  as a non-`end_turn` stop or a process exit, both retained as gaps.
- Subagent work appears only inside usage statistics; no child session
  identities are exposed over ACP, so child histories are never claimed.
