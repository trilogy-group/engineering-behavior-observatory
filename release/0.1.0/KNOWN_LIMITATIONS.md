# EBO 0.1.0 known limitations

## Verification status

| Boundary | Deterministic acceptance | Live audit on 2026-09-09 |
|---|---|---|
| Claude Agent SDK `0.3.258` | Direct SDK capture, frozen-entry runner, hooks, OTLP receipt, export, normalization, evaluation, review, aggregation, and Atlas pass with controlled fixtures. | Operational smoke completed in 13 seconds using explicitly supplied existing OAuth: 6 native messages, 6 hooks, all three OTLP signals, qualified observational capture, workspace retention, portable export, and corpus validation. An earlier authentication failure did not recur. |
| OpenHands Agent Server `1.46.0` | Conversation endpoints and consumed event schemas match 1.44.1; contract tests cover current execution and historical retained evidence. The in-process EventLog completeness gap remains explicit. | Native macOS ARM64 binary and identity verified. Z.ai coding-plan `openai/glm-5.3-flash` completed a 40-second file-edit smoke with verified workspace, retained native evidence, and normalization. Capture is qualified-with-gaps. The default local tmux pool failed before model execution; the successful run used the supported subprocess terminal. |
| DeepSeek Harness client/protocol/runtime `0.1.1-rc.2` | Official-client controlled-runtime tests pass for protocol-only stdout, redacted stderr, receipt-to-idle completion, unsupported capabilities, partial interruption, clean shutdown, and configuration-only composition swaps. | A custom official-plugin SDK profile ran Z.ai `glm-5.3-flash` in 12 seconds: correct file output, 206 captured records, 196 native events, qualified capture, 202 validated projected events, and clean teardown. All 35 persisted sequenced session events matched captured events. Native telemetry was explicitly disabled. The runtime reports server version `0.0.1`; package versions and artifact digests identify the installation. |
| Codex app-server `0.153.4` | Owned-child contract, lifecycle/history, OTLP, failure, export, and retained-evaluation fixtures pass; legacy `0.150.1` readback remains covered. | `gpt-5.6-sol` completed a file-write capture in 17 seconds: 59 protocol records, correct workspace output, complete history and validated normalization with no capture gaps. OTLP logs and traces arrived; metrics did not. `thread/start` took 1.44 seconds; an earlier 30-second startup timeout did not recur, and its cause remains unknown. |

Configurable judging is deterministic-fixture verified for both backends.
The live Codex judge completed a no-evidence smoke in 9.5 seconds, returning a
structured abstention, null assessment/confidence, and zero citations.
Live evidence-backed citation judgments and the Claude judge backend were not
revalidated in this audit. These smokes are wiring evidence, not calibration.

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
- The release distributes reusable software and synthetic contract fixtures.
  Restricted study trajectories and credentials are excluded from release assets.
  The package remains private; npm registry publication is not part of this release.
