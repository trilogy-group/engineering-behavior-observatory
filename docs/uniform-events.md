# Uniform events and adapter contract

EBO normalizes only capture-qualified native evidence. The native session,
hook, protocol, telemetry, workspace, verifier, and manifest records remain the
authority; an `ebo.uniform-event/v1` record is a bounded projection with an
audit link back to those bytes.

## Event projection

[`schemas/uniform-events/v1.json`](../schemas/uniform-events/v1.json) defines the
event and `ebo.adapter-capability-profile/v1` schemas. Every event carries its
event, run, and attempt identities; source harness and native type; native
evidence reference; native order and time; actor; family; phase; scope;
relations; bounded attributes; and content references.

The initial families are `message`, `model-request`, `tool`, `context`,
`permission`, `delegation`, `artifact`, `validation`, `runtime`, and `outcome`.
They are observation categories, not a shared transport or lifecycle protocol.
The four phases (`before`, `during`, `after`, and `instant`) locate an
observation around its native operation. They do not claim common completion
semantics across harnesses.

Native order, native time, parentage, and content are explicit evidence values:

- `known` carries a native value, an empty list for known-empty content, or
  content references.
- `unknown` records that the run did not establish the value and gives a reason.
- `unsupported` records that the source capability cannot provide it and gives
  a reason.

Adapters must not substitute a local clock, array position, empty content, or a
false parent for missing native evidence. Attributes accept at most 32 shallow
scalar fields, strings are bounded, and nested or large content is represented
only through a native evidence reference.

A known native order includes its source-local `domain`. Sequence values from
independent session, hook, protocol, or telemetry streams are never compared or
combined unless retained native evidence establishes that ordering.

## Native references

A native reference contains the retained `artifactId` and a source-owned
`recordLocator`, such as a JSONL line, JSON pointer, or workspace path. EBO does
not interpret the locator as a universal protocol address. The
`NativeEvidenceResolver` verifies that each source and content reference
resolves in the retained bundle before normalized events are accepted.

DeepSeek JSON-RPC method names remain native types and record locators.
OpenHands REST resources, operations, and WebSocket events remain native types
and record locators. None of them become uniform event families. The same rule
applies to Agent SDK message and hook names.

## Adapter boundary

`NativeCaptureAdapter<Request, NativeRecord>` owns a typed, source-specific
request and returns one `QualifiedNativeCapture`: the run and attempt identity,
qualification status, and the native records qualified under that identity. It
does not impose shared methods, tool names, limits, or completion states.
`UniformEventNormalizationAdapter<NativeRecord>` consumes that same envelope
and produces uniform events plus an explicit list of unmapped native references.

`assertAdapterContract` checks that:

1. capture, normalizer, and capability-profile identities agree;
2. every event and content reference resolves;
3. every captured native record is either mapped or retained as unmapped; and
4. a normalizer does not invent source references.

`AdapterRegistry` receives a fixed list and rejects duplicate harnesses. This is
explicit registration, not dynamic discovery or a plugin lifecycle. Adding an
adapter supplies its own native types and capability profile; it does not add
convenience fields to the event schema.

The golden examples in
[`test/fixtures/uniform-events/all-families.v1.json`](../test/fixtures/uniform-events/all-families.v1.json)
cover all initial families using the retained Agent SDK, verifier, telemetry,
workspace, and terminal evidence shapes. They deliberately preserve unknown
time, parentage, and content where the qualified fixtures do not establish
those facts.

## Agent SDK mapping

`normalizeClaudeAgentSdkRunBundle` applies the concrete Agent SDK adapter to a
retained bundle. It runs structural capture qualification first, verifies every
artifact digest, normalizes the qualified native records, and resolves every
emitted source/content reference. An unqualified bundle is rejected before
normalization.

| Native evidence | Uniform families |
| --- | --- |
| SDK assistant/user/result and structural system records | `message`, `tool`, `context`, `delegation`, `permission`, `runtime`, `outcome` |
| Agent SDK callback records | `message`, `model-request`, `tool`, `context`, `permission`, `delegation`, `artifact`, `runtime` |
| Agent SDK telemetry summary | `runtime` |
| Workspace manifest descriptor and verifier artifact | `artifact`, `validation` |
| Run-manifest terminal record | `outcome` |

Session and callback sequence numbers keep separate
`session:<artifact-id>` and `hooks:<artifact-id>` order domains. An originating
SDK message timestamp is retained when present and valid RFC 3339;
the adapter never promotes the stream capture clock or hook callback clock to a
native occurrence time. Tool call/result and hook relations are added only when
one unique emitted call is supported by the same `tool_use_id`; the same rule
applies to stable subagent/task and workspace artifact identities.

Workspace metadata is sourced from its exact run-manifest evidence-descriptor
pointer; the qualified workspace bytes remain a content reference. Raw prompts,
messages, tool inputs/results, compact summaries, and verifier
assertions stay in their native artifacts. Events contain bounded structural
attributes and pointers to those bytes. Unknown message/hook records and
qualification metadata remain reachable through the returned `unmapped`
report.

The returned per-run capability profile records whether detailed-beta hook
spans were configured. This never changes semantic hook events because
`hooks.jsonl` is the occurrence authority. That separation follows the Agent
SDK's documented [callback correlation](https://code.claude.com/docs/en/agent-sdk/hooks)
and [beta tracing](https://code.claude.com/docs/en/agent-sdk/observability)
boundaries.
