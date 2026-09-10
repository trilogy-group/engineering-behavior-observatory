# EBO 0.2.0

This release adds Pi and Cursor TypeScript SDK harnesses to the existing Claude
Agent SDK, Codex, OpenHands, and DeepSeek integrations.

- **Pi:** pinned public session and extension APIs, durable session history,
  tool/lifecycle events, passive context observation, and bounded cleanup.
- **Cursor:** pinned local SDK, official JSONL store, stream/callback/history
  capture, usage readback, and bounded cancellation.
- Both run frozen observational queue entries through workspace capture,
  qualification, sanitized export, normalization, and the existing behavioral
  evaluation and Atlas workflows. No ground-truth verifier is required.
- Export retains both adapters' protections for hidden reasoning, credential
  fields, and opaque Cursor checkpoint content.

See the [Pi operator guide](../../docs/pi-sdk.md) and
[Cursor operator guide](../../docs/cursor-sdk.md) for configuration and commands.
The [limitations](KNOWN_LIMITATIONS.md) distinguish live smoke evidence from
contract coverage and document the Cursor dependency audit findings.

## Reproduce acceptance

Use a clean source checkout at `v0.2.0` with Node `24.19.0`:

```sh
npm ci
npm run acceptance
```

Acceptance builds and type-checks the project, runs the complete offline test
suite, validates documentation links and fixture digests, scans package contents,
and verifies that two npm packs are byte-identical. Opt-in live tests require
separate credentials and are not run by this command.

The package, `SHA256SUMS`, and `acceptance-result.json` are written to
`.ebo/releases/0.2.0/`. The result records the exact tested source commit.
Verify a downloaded release package with `shasum -a 256 -c SHA256SUMS`.

[reproducibility.json](reproducibility.json) records runtime pins and fixture
digests. Release assets exclude credentials, private memory, captured study
trajectories, and workspaces. The package remains private; there is no npm
registry publication. Existing `v0.1.0` artifacts and tag remain unchanged.
