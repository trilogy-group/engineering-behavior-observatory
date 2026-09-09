# EBO 0.1.0 release acceptance

This is the first reusable-software release. It packages the EBO
runtime, schemas, pinned harness contracts, operator documentation, and Atlas
support. It does not contain a study campaign, candidate/baseline results,
restricted run evidence, credentials, workspaces, or embedded harnesses.

From a clean checkout with Node 24.19.0:

```sh
npm ci
npm run acceptance
```

The command builds and type-checks TypeScript, runs every contract/unit/
integration/security test, checks local Markdown links and pinned fixture
digests, then performs two independent `npm pack` operations. The byte-identical
package, `SHA256SUMS`, and machine-readable current result are written under
`.ebo/releases/0.1.0/`. No Git tag, GitHub release, registry publish, or remote
upload occurs.

The Agent SDK release test begins with one frozen queue entry and proceeds
through capture qualification, approved portable export, native-linked
normalization and structural observations, both configurable judge backends,
synthetic review ingestion, aggregation, and the current evidence-linked Atlas.
The complete suite applies the same retained-evidence path to OpenHands,
DeepSeek, and Codex fixtures.

Fixture hashes and declared non-deterministic fields are recorded in
[reproducibility.json](reproducibility.json). Fixture-versus-live support and
external prerequisites are explicit in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Release assets

The GitHub `v0.1.0` release provides the npm-format package, `SHA256SUMS`, and
`acceptance-result.json`. The result identifies the exact tested source commit.
Verify the downloaded package before using it:

```sh
shasum -a 256 -c SHA256SUMS
```

Use a source checkout at the tag to reproduce acceptance; the runtime package
excludes tests and private orchestration files. See the
[operator guide](../../docs/operator-guide.md) for packet-to-Atlas commands and
the [extension guide](../../docs/extension-contracts.md) for contract tests.
