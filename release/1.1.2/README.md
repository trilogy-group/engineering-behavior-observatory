# EBO 1.1.2

## Changes

- Update Codex app-server to 0.157.0, Pi SDK to 0.87.1, and the DeepSeek Harness client and protocol to 0.1.7-rc.2.
- Regenerate the Codex contract subset and adapt DeepSeek launch options to the current public client API.
- Derive SDK version assertions in fixtures from the installed package or EBO runtime pin.

## Verification

`npm run acceptance` runs on Node 24.19.0, including the deterministic suite, fixture digests, documentation links, package scan, and two byte-identical package builds. Results are written under `.ebo/releases/1.1.2/`.

## Reproducibility

[`reproducibility.json`](reproducibility.json) records the runtime versions, commands, determinism exclusions, and fixture digests for this release.
