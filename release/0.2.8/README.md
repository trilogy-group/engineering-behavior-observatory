# v0.2.8: Preserve Cursor usage on failure

Finalization snapshots `run.usage` even when the terminal wait throws or is
interrupted. The retained `usage-snapshot` records cumulative counters and
availability separately from per-turn usage and billing. It does not overwrite
terminal errors, add token totals twice, or make another provider call.

Tests cover success, terminal error, thrown wait, interruption, unavailable
usage, and getter failure with cleanup preserved.

See the [Cursor guide](../../docs/harnesses/cursor-sdk.md),
[known limitations](KNOWN_LIMITATIONS.md), and
[reproducibility manifest](reproducibility.json).
