# v0.2.9: Preserve safe workspace evidence

The shared capture projection excludes Git administrative state, unsafe links,
hard-linked files and unsupported filesystem entries. Each omission is recorded
in the capture report and produces an explicit workspace qualification gap.
Original workspaces remain untouched. Git representation failures fall back to
a verified snapshot; unexpected I/O and integrity errors still fail capture.

The retained Cursor migration workspace was repackaged without another model
run. Its native evidence was copied with digest verification, and the derived
bundle qualified with gaps instead of losing all workspace evidence.

See the [operator guide](../../docs/guides/operator-guide.md),
[known limitations](KNOWN_LIMITATIONS.md), and
[reproducibility manifest](reproducibility.json).
