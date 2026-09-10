# v0.2.3 known limitations

The [v0.2.2 limitations](../0.2.2/KNOWN_LIMITATIONS.md) continue to apply.

- Error details are retained for future captures. Exceptions discarded by older
  versions cannot be reconstructed from a generic missing-workspace report.
- A later successful workspace capture is recovery evidence, not proof that the
  original capture succeeded or that its transient failure cannot recur.
- The existing OTLP size bounds, missing-signal reporting, and bounded native
  normalization projection are unchanged.
