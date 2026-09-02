# OpenHands Agent Server adapter

The OpenHands adapter executes one EBO attempt through a pinned Agent Server
REST/WebSocket boundary. It preserves the source records before projecting any
uniform events. It does not import the OpenHands Python SDK or embed the agent
loop.

## Pinned boundary

The runtime pin is Agent Server `1.44.1`. The matching release OpenAPI digest,
server commit, image, event discriminator list, WebSocket route, and
authentication mode are recorded in the
[contract manifest](../contracts/openhands-agent-server-v1.44.1.json).

`@openhands/typescript-client` `1.39.0` was checked against that contract. Its
generated types target Agent Server `1.44.0`, and its WebSocket wrapper neither
exposes reconnect lifecycle evidence nor uses the current first-message
authentication path. EBO therefore uses Node's native `fetch` and `WebSocket`
APIs for this boundary and does not add the client as a runtime dependency.

## Capture flow

`captureOpenHandsAgentServerRun` coordinates one caller-supplied run definition:

1. Verify `/server_info` reports exactly `1.44.1`.
2. Create one conversation with the supplied agent configuration and the
   workspace path visible to the server. Authenticated REST requests use the
   pinned server's `X-Session-API-Key` header.
3. Open `/sockets/events/{conversation_id}` with `resend_mode=all`, authenticate
   in the first frame when required, and submit the message through REST.
4. Poll the conversation until `finished`, `error`, or `stuck`.
5. Read every final event page in timestamp order, reconcile by native event ID,
   then clean up the conversation.
6. Package native JSONL, exposed hook events, the workspace outcome, and the EBO
   verifier result before finalizing the run bundle.

Container callers can set `serverWorkspacePath` when the Agent Server sees a
different mount path from the local EBO coordinator.

## Reconciliation and completeness

Unexpected socket closure reconnects with `resend_mode=since` from the last
native event timestamp. Inclusive replay can deliver duplicates. EBO retains
every receipt as native evidence, selects the final REST copy as the canonical
normalization source, and emits one uniform event per native event ID.

The result reports streamed-only and final-only IDs. A failed final REST read
keeps the streamed records and marks reconciliation partial. Unknown `kind`
values remain in native JSONL and are listed as unmapped; they never crash the
capture.

REST responses and WebSocket frames are bounded before parsing, event capture
has a fixed upper limit, and repeated pagination cursors fail into partial
evidence. A coordinator abort closes the socket, stops polling, attempts final
REST recovery and cleanup with a short independent bound, and retains the
records already received.

Matching REST and WebSocket IDs proves agreement between those two public API
views only. The boundary does not expose enough evidence to prove delivery of
the complete in-process `EventLog`, so every otherwise usable capture records
`EVENT_LOG_COMPLETENESS_UNPROVEN` as a qualification gap.

## Uniform projection

The adapter maps only fields present in the pinned event contract:

| Native record | Uniform family | Preserved distinctions |
|---|---|---|
| `MessageEvent`, `SystemPromptEvent` | `message` | actor comes from native `source`, not LLM role |
| `ActionEvent` | `tool` / before | tool and call identities |
| `ObservationEvent` | `tool` / after | `action_id` causal relation |
| `AgentErrorEvent` | `tool` / after | `agent-tool` error scope |
| `ConversationErrorEvent` | `runtime` | conversation error scope |
| `ServerErrorEvent` | `runtime` | server error scope |
| condensation records | `context` | exposed forgotten-event IDs stay native attributes |
| `HookExecutionEvent` | `runtime` | hook type, result, and exposed action/message association |
| state, pause, and interrupt records | `runtime` | source status facts |
| final conversation record | `outcome` | terminal status and workspace identity |

Workspace and verifier evidence are packaged through the existing EBO outcome
contracts. Agent Server product telemetry is not treated as complete native
OpenTelemetry evidence.

## Validation

The normal test suite uses pinned streamed/final fixtures for reconnect,
deduplication, errors, condensation, hooks, unknown variants, and partial REST
failure. The live smoke is opt-in because it requires a running pinned server
and a permitted model route:

```sh
export EBO_LIVE_OPENHANDS_WORKSPACE_ROOT=/path-visible-to-host-and-server
export EBO_OPENHANDS_SESSION_API_KEY=local-smoke-key
mkdir -p "$EBO_LIVE_OPENHANDS_WORKSPACE_ROOT"
docker run --rm --name ebo-openhands-smoke -p 127.0.0.1:8010:8000 \
  -v "$EBO_LIVE_OPENHANDS_WORKSPACE_ROOT:$EBO_LIVE_OPENHANDS_WORKSPACE_ROOT" \
  -e SESSION_API_KEY="$EBO_OPENHANDS_SESSION_API_KEY" \
  ghcr.io/openhands/agent-server:1.44.1-python --host 0.0.0.0

npm run build
EBO_LIVE_OPENHANDS_SMOKE=1 \
EBO_OPENHANDS_SERVER_URL=http://127.0.0.1:8010 \
node --test --test-name-pattern='approved live Agent Server smoke' \
  dist/test/openhands.test.js
```

The smoke asks the agent to modify one file, verifies the retained workspace,
and requires native stream/final records, hook evidence, a verifier result, a
run bundle, normalized events, and the explicit EventLog completeness gap.
`LLM_MODEL` and `LLM_API_KEY` must name an approved route before the test runs.
