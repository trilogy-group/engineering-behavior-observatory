# EBO 1.3.0 release candidate

This candidate adds Factory Droid as the eighth harness through the official
TypeScript SDK 0.9.1 and Droid CLI 0.238.0. EBO records native frames before SDK
validation, binds owned session/turn terminals, preserves partial attempts, and
supports retained analysis, Atlas, human review and sanitized export.

Factory conditions select managed inference or a frozen BYOK Chat Completions
route. The Fireworks template uses `accounts/fireworks/models/glm-5p3-flash`.
BYOK launches with a provider credential and isolated custom-model settings;
Factory authentication is required for the managed route. CLI and Harbor share
the capture core. See the [Factory guide](../../docs/harnesses/factory-droid.md)
for configuration, evidence boundaries and live qualification.

The candidate pins the following harness and environment runtimes:

| Component | Version |
| --- | --- |
| Claude Agent SDK / bundled Claude Code | 0.3.296 / 2.1.296 |
| Codex app-server | 0.162.1 |
| Cursor SDK | 1.0.37 |
| DeepSeek client, protocol and runtime | 0.2.0-rc.2 |
| Devin CLI | 3000.11.3 |
| Factory SDK / Droid CLI | 0.9.1 / 0.238.0 |
| OpenHands Agent Server | 1.54.0 |
| Pi SDK | 1.1.0 |
| Smol Python SDK / bundled SmolVM | 1.26.1 / 1.26.1 |
| Harbor | 0.24.0 |

Factory and Devin match their upstream releases checked on October 11, 2026.
DeepSeek follows its release-candidate channel. Capture uses these pins;
retained readback preserves the supported older runtime and adapter identities.
See [runtime qualification](runtime-qualification.md) for native checks,
dependency constraints and migration requirements.

The candidate manifest pins the current development fixtures, including Factory
routing and release scanner regression coverage. The source scanner accepts
Bearer headers built entirely from source references while retaining credential
literals for detection. Published 1.2.0 release records remain immutable.

`npm run acceptance` requires a clean checkout and checks fixture digests,
build/typecheck, deterministic tests, documentation links, source binding,
package exclusions, secret/path scanning and two byte-identical npm archives.
The [reproducibility manifest](reproducibility.json) records runtime pins and
fixture coverage. Provider and VM live qualification are separate opt-in checks;
the deterministic gate does not establish live service compatibility.

Publication follows repository release ordering through develop and main.
