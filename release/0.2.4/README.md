# v0.2.4: Stream large workspace snapshots

Workspace snapshot capture no longer buffers the compressed archive in child
process stdout. Archives stream to disk, pass extraction and tree-digest checks,
and publish atomically. Qualification verifies snapshot integrity in chunks.

The compressed snapshot limit increases from 128 MiB to 1 GiB. Output above
that limit fails explicitly and retains partial evidence. The 64 MiB patch
limit, capture exclusions, archive format, and portable-export policy are
unchanged. No runtime pins or dependencies change.

## Verification

Regression tests cover a 129 MiB incompressible snapshot, streamed-write failure
cleanup, no-clobber publication, and bounded integrity checks. A retained real
workspace that failed on v0.2.3 was captured separately as a 605,143,040-byte
snapshot, with its extracted tree digest verified. Original evidence was not
rewritten.

Run `npm ci` and `npm run acceptance` on Node 24.19.0 for the full suite,
documentation and package checks, and two byte-identical package builds.
See [known limitations](KNOWN_LIMITATIONS.md) and the
[reproducibility manifest](reproducibility.json).
