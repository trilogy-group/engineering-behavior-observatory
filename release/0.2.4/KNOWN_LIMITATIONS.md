# v0.2.4 known limitations

The [v0.2.3 limitations](../0.2.3/KNOWN_LIMITATIONS.md) continue to apply.

- Snapshots remain bounded to 1 GiB compressed. Temporary source and extracted
  copies also require free disk space; large cache trees increase capture time.
- Known cache exclusions must be declared before a study. Capture does not
  silently omit additional files to fit a limit.
- Opaque snapshots remain restricted evidence; larger capture support does
  not make them portable sanitized exports.
- Full-parallel testing exposed intermittent interruption/cleanup failures.
  Release acceptance runs tests serially, as in earlier releases.
- npm audit reports three dependency findings (two moderate, one high) through
  the pinned Cursor SDK's connect-node/undici dependency chain. npm reports no
  available automatic fix for this dependency graph. This patch leaves those
  dependencies unchanged; passing acceptance is not a clean security audit.
