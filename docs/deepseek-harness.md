# DeepSeek Harness adapter

EBO drives DeepSeek Harness out of process through the pinned public package
roots `@deepseek-ai/dsh-sdk-client@0.1.1-rc.2` and
`@deepseek-ai/dsh-sdk-protocol@0.1.1-rc.2`. It does not import source modules,
embed the agent loop, or implement JSON-RPC framing, correlation,
subscriptions, or process teardown.

The upstream contracts are the official
[TypeScript client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md),
[wire protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md),
[server plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md),
[session log](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md),
and [session telemetry](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-telemetry.md).

## Runtime composition

`ebo.deepseek-runtime-composition/v1` records the exact Node command and
arguments, process and workspace directories, named profile, ordered Cordis
patches, provider/model route, pinned client/protocol versions, plugin names,
an ordered digest-bearing reference for every Cordis patch and plugin
configuration, the launched runtime artifact, environment policy, and telemetry
selection. Every referenced configuration and runtime digest is rechecked
before the process starts.
Environment values are not recorded. The adapter passes a replacement child
environment to the official client and rejects keys outside the recorded
allowlist; configured secret values are redacted from retained error and stderr
tails.

Two fixtures demonstrate configuration-only swaps:

- `test/fixtures/deepseek/compositions/minimal` disables native telemetry.
- `test/fixtures/deepseek/compositions/telemetry` composes the telemetry plugin
  and records its separate artifact reference.

The adapter code is identical for both compositions. Runtime and plugin choices
remain configuration, not EBO runner branches.

## Native evidence

`HarnessClient` owns the child and JSON-RPC transport. EBO calls only its public
`start`, `initialize`, `prompt`, `subscribeSessionTree`, and `close` methods.
The native JSONL evidence records:

- the selected composition and capability report;
- typed initialize, prompt receipt, notification, error, and shutdown
  observations in observed order;
- every delivered `session.event` envelope verbatim, including its native
  `seq`, `time`, surface metadata, and source-specific fields;
- root and child session identities from each native notification, with the
  declared session tree used during bundle qualification;
- whole-agent `session.status` and available subagent notifications; and
- bounded, redacted diagnostics only when the official client attributes them
  to the child stderr tail.

Stdout remains exclusively owned by the official JSON-RPC transport. EBO does
not attach a console exporter or stdout logger. The controlled-runtime test
parses every emitted evidence line and forces a contaminated runtime to fail
while retaining its stderr diagnostic and partial observations.

## Completion and limitations

`session/prompt` returns only the durable queued message ID. Completion requires
the matching native `agent/inbox/spliced` event followed by the root session
whole-agent `session.status: idle`. Those two observation sequences are retained
as the activity boundary. They do not claim that an assistant message was
caused by the prompt, and `finalResponse` is not treated as a prompt result.

The capability report keeps these current protocol limitations explicit:

- protocol-version negotiation: unsupported;
- prompt cancellation: unsupported;
- per-session close: unsupported;
- true per-prompt result: unsupported; and
- native spans: available, unsupported, or not checked according to the named
  telemetry composition.

The official client owns graceful `shutdown`, stdin EOF, SIGTERM, and SIGKILL
escalation. An interruption, activity timeout, transport exit, or protocol
failure closes through that same ladder. Delivered notifications and stderr
remain valid partial evidence.

## Normalization

Normalization begins only when the capture retains the selected composition,
capabilities, successful initialize and prompt receipts, and at least one
durable session event. A completed capture additionally requires the exact
receipt-to-idle boundary and successful official-client close/reap evidence.
The client does not expose whether its best-effort protocol shutdown request or
a later EOF/signal step ended the process, so EBO does not invent a shutdown
response.

The capture report persists the required semantic-evidence kinds and related
session IDs. Later qualification treats that declaration as authoritative and
rejects caller overrides that would weaken or replace it.

Mapped events retain a `line:N` native reference into the authoritative DeepSeek
JSONL. Session events use their native session-local sequence/time; EBO client
observations use a separate observation-order domain. Large message, tool,
compaction, request, validation, and artifact bodies remain behind content
references. Unknown source events remain explicitly unmapped rather than being
dropped or forced into a convenience family. Optional telemetry stays a
separate timing/resource artifact and never replaces semantic session events.
