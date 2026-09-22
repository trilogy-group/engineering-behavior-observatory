# EBO 1.1.0

OpenHands Agent Server lifecycle. Runtime pins, schemas, and contracts are
unchanged from v1.0.2.

## Changes

- **OpenHands server lifecycle (feature).** An OpenHands run configuration may
  now declare `serverLaunch`. EBO starts the pinned Agent Server inside the
  attempt environment, waits until `/server_info` reports the pinned version,
  and stops it on completion or interruption. A host server and task-local setup
  are no longer required for an OpenHands attempt.
- **Environment-bound credential (feature).** `credentialEnv` resolves the
  conversation `agent.llm.api_key` from the environment instead of embedding it
  in a digest-pinned record.
- **Operational requirement.** The attempt environment must define
  `OH_SECRET_KEY` (any value). Without it OpenHands cannot resume sessions that
  carry previously set secrets.
- Documentation of the OpenHands boundary and a runnable check for the
  credential binding.

## Verification

`npm run acceptance` runs from a clean checkout on the pinned Node 24.19.0: the
deterministic suite, fixture digests, documentation links, package scan, and two
byte-identical package builds. Results are written under `.ebo/releases/1.1.0/`.

The OpenHands `serverLaunch` path was exercised against the live pinned Agent
Server inside a Smol environment; the conversation completed and native evidence
was retained. Historical OpenHands bundles remain readable through their
original profiles. See the [v1.0.0 support boundary](../1.0.0/KNOWN_LIMITATIONS.md).

## Reproducibility

[`reproducibility.json`](reproducibility.json) pins the runtime versions,
commands, determinism exclusions, and fixture digests for this release.
