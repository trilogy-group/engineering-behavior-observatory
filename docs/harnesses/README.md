# Choose a harness

Choose the environment whose behavior you want to study. A shared model behind
different tools or context policies is a different experimental condition.

| Harness | Execute through | Distinctive evidence | Important limit |
| :--- | :--- | :--- | :--- |
| [Claude Agent SDK](claude-agent-sdk.md) | `ebo agent-sdk run` | SDK stream and passive lifecycle hooks; optional OTLP | Tracing is beta; configured export is not receipt |
| [Codex](codex-harness.md) | `ebo codex run` | Owned app-server thread/turn/item protocol and history | Requires the pinned runtime; no desktop-daemon attachment |
| [Cursor](cursor-sdk.md) | `ebo cursor run` | Stream, callbacks, official JSONL store, terminal and billing readback | Local SDK OTLP unavailable; Enterprise export is a separate, unqualified integration |
| [Pi](pi-sdk.md) | `ebo pi run` | Native session tree, extension observer, retries/compaction | No verified native OTLP receipt; local SDK is not an OS sandbox |
| [OpenHands](openhands-agent-server.md) | `captureOpenHandsAgentServerRun` library API | REST final events reconciled with WebSocket receipts | Full internal EventLog completeness cannot be proven through this boundary |
| [DeepSeek Harness](deepseek-harness.md) | Source-specific library API | Durable events, lifecycle, runtime/plugin composition | Prompt response is enqueue acknowledgement; documented status/events determine completion |

All six have retained-evidence paths for normalization and behavioral analysis.
That does not mean their capabilities are identical or every provider route is
live-qualified. Consult the [release support record](../../release/0.2.1/KNOWN_LIMITATIONS.md)
and each guide before selecting a route.

## Before a live run

1. Install the selected runtime and confirm its required version.
2. Establish an authenticated model route without putting secrets in artifacts.
3. Review tool permissions and workspace isolation. A disposable directory is
   not a security sandbox.
4. Freeze the source-specific settings alongside task inputs.
5. Inspect capability and missing-evidence reports after capture.

Native histories, streamed deltas, billing snapshots, and telemetry can overlap.
Each adapter declares which source owns a count; EBO does not sum every received
record as a new action or token increment.
