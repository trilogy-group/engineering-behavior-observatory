# EBO 0.2.1

This release reorganizes the documentation, adds the Apache-2.0 license, and
prepares `engineering-behavior-observatory` for public npm distribution.
The executable remains `ebo`.

## Changes

- README with installation, a synthetic quickstart, and a harness overview.
- Documentation grouped into guides, harnesses, evaluation, reference, and
  development, with an index for each reading path.
- Grouped command reference using `ebo`.
- Generated OpenSymphony topic notes moved to private memory; public guides
  contain authored operational and contract documentation.
- npm metadata, public access configuration, and Apache-2.0 licensing.

No runtime behavior, schemas, provider pins, or dependency versions changed
from 0.2.0.

## Install

```sh
npm install -g engineering-behavior-observatory
ebo --help
```

For a one-off command:

```sh
npm exec --package=engineering-behavior-observatory -- ebo --help
```

Avoid `npx ebo`, which resolves a different package. See the
[quickstart](../../docs/guides/quickstart.md) for Node requirements, source
installation, and checksum-verified release archives.

## Verification

`npm run acceptance` records the tested commit, pinned runtime, fixture
digests, complete offline test result, documentation links, package scan, and
byte-identical repeated packs. Its output directory is
`.ebo/releases/0.2.1/`. The package, checksum, and acceptance result are
release artifacts. A Git tag and an npm publication are separate operations.

Live provider tests are not repeated for documentation and metadata changes.
[Known limitations](KNOWN_LIMITATIONS.md) carries forward the existing
live-evidence boundaries and dependency audit risk.

## Publication

The package name is `engineering-behavior-observatory`; `bin.ebo` points
to the compiled CLI. The package includes runtime code, schemas, contracts,
documentation, examples, ontology, release records, and the Grafana launcher.
Tests, credentials, native study evidence, and private memory are excluded.

The npm publishing account must be checked with `npm whoami` before release.
An `NPM_TOKEN` must be exported to the publishing process and supplied through
an environment-referencing npm configuration, never committed.

Stage an existing package with `npm stage publish <tarball>`, then inspect
and approve it with npm's 2FA flow. npm currently requires a first publication
before staging is available; a new package uses `npm publish <tarball> --access public`.
See [npm staged publishing](https://docs.npmjs.com/staged-publishing/).
