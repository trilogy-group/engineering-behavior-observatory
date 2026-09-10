# v0.2.2: Configurable Codex tool network access

Codex workspace-write runs now enable outbound tool network access by default.
Set `networkAccess: false` in the digest-pinned native tool policy to run offline.
Both thread and turn receive the selected policy; native evidence retains the
request and applied policy, and mismatches remain explicit capture gaps.

Filesystem writable roots, temporary-directory restrictions, approval handling,
credential isolation, and read-only judging are unchanged. Invalid types and
settings on incompatible sandbox modes are rejected. No dependencies or runtime
pins changed.

## Reproduction and migration

See the [Codex guide](../../docs/harnesses/codex-harness.md) for the configuration.
Historical bundles are unchanged. An omitted setting previously meant offline;
it now means network enabled. Compile a new queue with an explicit boolean when
reproducing an earlier condition. Network access permits outbound transfer, so
admit appropriate task data before execution.

Run `npm ci` and `npm run acceptance` with Node 24.19.0. The release checks include
policy defaults, explicit on/off behavior, invalid settings, mismatch evidence,
and offline queue-to-runtime propagation, plus the full existing test suite.
A live ChatGPT-authenticated Astra check also fetched example.com successfully
through the workspace-write sandbox; this is infrastructure proof, not a scored
task result.

See [known limitations](KNOWN_LIMITATIONS.md) and the
[reproducibility manifest](reproducibility.json).
