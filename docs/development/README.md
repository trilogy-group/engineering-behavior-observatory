# Contribute to EBO

Start with the repository's `AGENTS.md`, then
[the documentation index](../README.md). The TypeScript coordinator owns
evidence capture and evaluation; each harness retains its native protocol and
semantics.

## Set up and check

Use the pinned Node version and build before invoking the checkout's CLI:

```sh
nvm use
npm ci
npm run build
npm link
ebo --help
npm run typecheck
npm test
git diff --check
```

The test suite is deterministic by default. Live provider smokes are opt-in,
consume external capacity, and require approved credentials. Their instructions
belong in the relevant harness guide. Do not treat a skipped live test as proof
of provider access.

Use [extension contracts](extension-contracts.md) when adding an adapter,
structural extractor, rubric, verifier, or export policy. Preserve native
records and qualified partial attempts before adding derived views.

## Documentation ownership

- **README:** motivation, harness overview, installation, quickstart, navigation.
- **Guides:** executable workflows and recovery.
- **Harnesses:** source-specific setup, pins, policies, evidence, and limitations.
- **Evaluation:** methods, semantics, interpretation boundaries.
- **Reference:** exact syntax and artifact contracts.
- **Release records:** version-specific changes, verification, and limitations.

Before adding a page, check whether an existing page already owns the topic.
Link every new page from a relevant index. Update relative links when moving
documents, including links from release records and packaged examples.
Use `ebo` in operator commands; keep Node invocations for tests and scripts
that are not CLI commands. Do not duplicate the complete CLI in the README.

Run a cold-reader check: can a newcomer follow the commands without knowing
which placeholders, working directory, credentials, or prior artifacts they
need? Keep runnable examples separate from syntax templates.

## Memory and documentation sync

OpenSymphony memory remains available for implementation provenance. In this
repository its generated topic notes are private and excluded from the package.
Public docs are authored from current implementation and verified behavior,
not generated issue lists.

`opensymphony memory sync-docs` updates private notes; it no longer writes
the public guide tree. After a feature change, use those notes to find evidence
and deliberately update the relevant authored guide. See
[the sync failure analysis](documentation-sync.md).

## Release gate

From a **clean** checkout, `npm run acceptance` runs the deterministic suite,
checks fixture digests and documentation links, scans the package, and verifies
two byte-identical package builds. It writes under
`.ebo/releases/<package-version>/`; it does not publish or tag.

See [release records](../../release/README.md). A documentation edit after a
tag belongs to a later change; do not move an existing release tag to include it.
