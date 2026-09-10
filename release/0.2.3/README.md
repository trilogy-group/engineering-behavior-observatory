# v0.2.3: Workspace capture error diagnostics

The shared run-bundle assembler now preserves workspace packaging exceptions
in capture reports as `workspace-capture-error` missing-evidence entries.
Previously, a harness could finalize a partial bundle with only a generic
missing-workspace report, losing the exception needed to diagnose the failure.

Capture still rejects failures and preserves the source workspace through the
existing harness retention paths. A successful explicit capture retry clears
the prior diagnostic. No automatic retry, weaker validation, dependency update,
runtime-pin change, or artifact-schema change is introduced.

This release fixes diagnostic loss. It does not claim to eliminate every
workspace packaging failure. Existing immutable bundles are not rewritten.

## Verification

Run `npm ci` and `npm run acceptance` on Node 24.19.0. Regression coverage checks
retention of the original capture error, successful retry clearing, and valid
partial manifests. Acceptance also runs the full suite, checks documentation
and package contents, and compares two independently built package archives.

See [known limitations](KNOWN_LIMITATIONS.md), the
[reproducibility manifest](reproducibility.json), and
[recovery guidance](../../docs/guides/evidence-and-sharing.md).
