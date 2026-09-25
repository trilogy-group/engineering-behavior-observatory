# EBO 1.1.1

## Changes

- Update the pinned Claude Agent SDK from 0.3.258 to 0.3.282.

## Verification

`npm run acceptance` runs on the pinned Node 24.19.0, including the deterministic
suite, fixture digests, documentation links, package scan, and two byte-identical
package builds. Results are written under `.ebo/releases/1.1.1/`.

## Reproducibility

[`reproducibility.json`](reproducibility.json) pins the runtime versions,
commands, determinism exclusions, and fixture digests for this release.
