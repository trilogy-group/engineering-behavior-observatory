# OpenHands Agent Server adapter

The OpenHands adapter executes one EBO attempt through a pinned Agent Server
REST/WebSocket boundary. It preserves the source records before projecting any
uniform events. It does not import the OpenHands Python SDK or embed the agent
loop.

## Pinned boundary

The runtime pin is Agent Server `1.46.0`. The matching release OpenAPI digest,
server commit, image, event discriminator list, WebSocket route, and
authentication mode are recorded in the
[contract manifest](../../contracts/openhands-agent-server-v1.46.0.json).

The 1.46.0 upgrade preserves the existing conversation endpoints and consumed
event schemas. The upstream schema changes concern ACP agents and skill requests,
which this adapter does not use. Historical 1.44.1 fixtures and the contract
manifest remain unchanged; retained evaluation keeps their original runtime and
adapter identity.

For a native macOS ARM64 installation, download the release's
`agent-server-1.46.0-macos-arm64` and verify it against `SHA256SUMS` (also pinned
in the contract manifest). Mark the binary executable and launch it with:

```sh
agent-server-1.46.0-macos-arm64 --host 127.0.0.1 --port 18080
curl --fail http://127.0.0.1:18080/server_info
```

The identity response must report `1.46.0`. Server readiness does not establish
a working model route; the opt-in conversation smoke below verifies that separately.

`@openhands/typescript-client` `1.39.0` was checked against that contract. Its
generated types target Agent Server `1.44.0`, and its WebSocket wrapper neither
exposes reconnect lifecycle evidence nor uses the current first-message
authentication path. EBO therefore uses Node's native `fetch` and `WebSocket`
APIs for this boundary and does not add the client as a runtime dependency.

## Capture flow

`captureOpenHandsAgentServerRun` coordinates one caller-supplied run definition:

The run configuration must expose the actual model at `agent.llm.model` or
`agent_settings.llm.model`; EBO rejects a request whose executable model differs
from the run manifest identity.

1. Verify `/server_info` reports exactly `1.46.0`.
2. Create one conversation with the supplied agent configuration and the
   workspace path visible to the server. Authenticated REST requests use the
   pinned server's `X-Session-API-Key` header.
3. Open `/sockets/events/{conversation_id}` with `resend_mode=all`, authenticate
   in the first frame when required, and submit the message through REST.
4. Poll the conversation until `finished`, `error`, or `stuck`.
5. Read every final event page in timestamp order, reconcile by native event ID,
   then clean up the conversation.
6. Package native JSONL, exposed hook events, the workspace outcome, and the EBO
   verifier result before finalizing the run bundle. If workspace packaging
   fails, preserve and report the disposable workspace path for recovery.

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

The native run bundle is finalized and capture-qualified before uniform-event
projection. A projection error is returned separately and does not replace the
recorded terminal state or make the retained native/workspace evidence
inaccessible. Unqualified capture is not normalized.

## Validation

The normal test suite uses pinned streamed/final fixtures for reconnect,
deduplication, errors, condensation, hooks, unknown variants, and partial REST
failure. The live smoke is opt-in because it requires a running pinned server
and a permitted model route:

```sh
export EBO_LIVE_OPENHANDS_WORKSPACE_ROOT=/path-visible-to-host-and-server
# Set SESSION_API_KEY and EBO_OPENHANDS_SESSION_API_KEY to the same local
# smoke-only value in the invoking environment.
mkdir -p "$EBO_LIVE_OPENHANDS_WORKSPACE_ROOT"
docker run --rm --name ebo-openhands-smoke -p 127.0.0.1:8010:8000 \
  -v "$EBO_LIVE_OPENHANDS_WORKSPACE_ROOT:$EBO_LIVE_OPENHANDS_WORKSPACE_ROOT" \
  -e SESSION_API_KEY \
  ghcr.io/openhands/agent-server:1.46.0-python --host 0.0.0.0

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

For an OpenAI-compatible endpoint, use its LiteLLM `openai/` model prefix and
set `LLM_BASE_URL`. For example, the Z.ai coding-plan smoke used
`LLM_MODEL=openai/glm-5.3-flash` and
`LLM_BASE_URL=https://api.z.ai/api/coding/paas/v4`, with `LLM_API_KEY` supplied
from the operator's `ZAI_API_KEY` environment variable.

Set `EBO_LIVE_OPENHANDS_KEEP_ARTIFACTS=1` to retain the smoke directory and print
its location, including on failure. These native artifacts remain restricted.
On the tested macOS installation, the default tmux pool failed during tool
initialization. `EBO_LIVE_OPENHANDS_TERMINAL_TYPE=subprocess` selects OpenHands'
supported subprocess terminal for this smoke. With that setting, the 1.46.0
server completed the Z.ai run, verified the workspace, and produced normalized
events with the declared EventLog completeness gap.
