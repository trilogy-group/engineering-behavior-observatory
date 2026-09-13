# v0.2.8 known limitations

The [v0.2.7 limitations](../0.2.7/KNOWN_LIMITATIONS.md) continue to apply.

- A snapshot cannot supply usage that the runtime did not report. Unavailable
  counters remain unavailable, not zero.
- The snapshot remains native cumulative evidence; it is not added to
  normalized per-turn totals or used to infer missing token categories.
- Abrupt process termination can prevent finalization. A thrown getter or
  failed recorder is reported as a capture gap while cleanup continues.
- No live trial was run for this patch. Existing Cursor SDK dependency audit
  findings are unchanged.
