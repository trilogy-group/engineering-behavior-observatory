# EBO 0.2.0 known limitations

## Evidence for this release

The combined offline suite covers all six adapters and the existing export,
evaluation, calibration, comparison, and Atlas paths. The release acceptance
result records the tested commit; a completed smoke is wiring evidence, not
model-quality calibration.

| New Boundary | Live Evidence Retained During PR Qualification | Limits |
|---|---|---|
| Pi SDK `0.85.1` | Z.ai `glm-5.3-flash` completed an isolated file-edit smoke with qualified native session, tool events, workspace evidence, sanitized export/readback, and observations. | One owned session per attempt; no verified native OTLP receipt surface or OS sandbox. |
| Cursor SDK `1.0.31` | `gpt-5.4-nano` completed an isolated file-edit smoke with all four official store files, qualified native evidence, workspace patch, sanitized export/readback, and observations. | Local SDK execution only; explicit tool policy is not OS containment. Opaque checkpoints are excluded from portable exports. |

The four earlier harnesses retain their
[0.1.0 live-verification record](../0.1.0/KNOWN_LIMITATIONS.md); those live checks
were not repeated solely for this release. See the adapter guides for detailed
version-specific evidence capabilities.

## Cursor telemetry

The local SDK exposes no per-run OTLP configuration or receipt API. Cursor's
separate Enterprise team-admin exporter supports server-side OTLP/HTTP protobuf
metrics and logs. It has not been configured or correlation-qualified here.
It supplies no traces, prompt content, or historical backfill. Aggregate metrics
lack conversation identifiers; matching exported logs to EBO attempts still needs
verification. SDK-native capture remains useful independently of that channel.

## Dependency audit

The release dependency tree reports three npm audit entries: two moderate and
one high, through `@cursor/sdk` → `@connectrpc/connect-node` → `undici@5.29.0`.
These include upstream HTTP and WebSocket advisories; exploitability in the
specific SDK transport paths has not been established. npm offers no compatible
fix for this pinned SDK tree. No unverified major-version override was applied.
Review this dependency risk before deployment and qualify an upstream SDK fix
when available. A passing release test suite is not a clean security audit.

The local-only Atlas, evidence-sharing requirements, provider-dependent timing,
and other [existing product boundaries](../0.1.0/KNOWN_LIMITATIONS.md) still apply.
