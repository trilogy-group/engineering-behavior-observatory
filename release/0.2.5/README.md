# v0.2.5: Preserve framework files in workspace capture

Workspace capture now preserves contained relative symbolic links, including
framework link chains and links to empty directories. Absolute, escaping,
dangling, and cyclic links remain rejected. Copies retain the original link
text, and patches that cannot reproduce the tree fall back to a snapshot.

On macOS, snapshot verification uses native `pax` to preserve genuine AppleDouble
files that macOS `tar` otherwise consumes as metadata. Snapshots remain tar.gz
archives. No runtime dependencies, pins, or serialized artifact formats change.

## Verification

Regression tests cover link preservation, invalid targets, empty target
directories, AppleDouble bytes, and long paths. A completed model attempt's
retained workspace was recovered as a 695,459,840-byte snapshot with a verified
extracted tree digest, without another model call or rewriting original evidence.
The recovery qualified with an explicit missing-telemetry-receipt gap; it records
the later capture time rather than claiming an exact end-of-turn snapshot.

Run `npm ci` and `npm run acceptance` on Node 24.19.0 for tests, documentation
and package checks, and two byte-identical package builds. See
[known limitations](KNOWN_LIMITATIONS.md), the
[reproducibility manifest](reproducibility.json), and the
[workspace inspection guide](../../docs/guides/evidence-and-sharing.md).
