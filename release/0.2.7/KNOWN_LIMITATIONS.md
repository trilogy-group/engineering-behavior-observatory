# v0.2.7 known limitations

The [v0.2.6 limitations](../0.2.6/KNOWN_LIMITATIONS.md) continue to apply.

- HTTP/1.1 mitigates the observed HTTP/2 failure; it is not a proven root-cause fix.
- Native recovery can still fail or reach the attempt deadline.
- Deterministic tests verify configuration and evidence handling, not live
  provider recovery. No new full trial was run for this patch.
