# EBO 0.1.0 known limitations

## Verification status

| Boundary | Deterministic acceptance | Live audit on 2026-09-09 |
|---|---|---|
| Claude Agent SDK `0.3.258` | Direct SDK capture, frozen-entry runner, hooks, OTLP receipt, export, normalization, evaluation, review, aggregation, and Atlas pass with controlled fixtures. | Attempted with existing OAuth and no API-key override. The OAuth session was expired and could not refresh, so EBO retained an infrastructure-failure bundle. Live success is not claimed. |
| OpenHands Agent Server `1.44.1` | Pinned REST/WebSocket contract and native streamed/final fixtures pass, including workspace/outcome evidence and the explicit EventLog completeness gap. | Not run: no pinned server was listening and the required approved `LLM_MODEL`/`LLM_API_KEY` route was unavailable. |
| DeepSeek Harness client/protocol `0.1.1-rc.2` | Official-client controlled-runtime tests pass for protocol-only stdout, redacted stderr, receipt-to-idle completion, unsupported capabilities, partial interruption, clean shutdown, and configuration-only composition swaps. | No production route is declared by this release. The controlled child is a fixture, not proof of a live provider/model route. |
| Codex app-server `0.153.4` | Owned-child contract, lifecycle/history, OTLP, failure, export, and retained-evaluation fixtures pass; legacy `0.150.1` readback remains covered. | Attempted with the installed pinned CLI and existing authentication. The bounded smoke ended before `thread/start` completed, so live success is not claimed. |

Configurable judging is deterministic-fixture verified for both the Claude Agent
SDK and Codex app-server backends. No live judge result is used as calibration.

## Product boundaries

- OpenHands exposes REST/WebSocket events, conversation state, server-reported
  workspace identity, final workspace capture, and EBO verifier outcome. It does
  not prove completeness of the server's in-process EventLog.
- DeepSeek prompt completion is receipt plus the matching root-session idle
  observation; the official client does not expose a per-prompt result or
  protocol-version negotiation.
- Codex native history completeness depends on full legacy `thread/read` output;
  other history modes remain explicit gaps.
- The Atlas is a local read-only workbench/report. Grafana and Tempo are external
  operator prerequisites; there is no hosted Atlas or trace replay service.
- Runtime timestamps, temporary paths, and provider timing/usage are evidence,
  not reproducibility keys. Stable identities, fixture digests, normalized
  projections, queue order, archives, and the npm package are deterministic.
- This candidate is prepared locally only. It has no tag, remote release,
  registry publication, partner handoff, evaluation campaign, or model claims.
