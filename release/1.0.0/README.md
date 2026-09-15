# EBO 1.0.0

This major release introduces the Harbor task workflow and Smol execution
alongside the retained legacy packet interfaces. See the
[Harbor migration guide](../../docs/guides/harbor-tasks.md) for prerequisites,
admission, execution, and conversion. Existing frozen studies remain unchanged.

Behavioral evaluation defaults to evidence-grounded LLM judgments. Human
calibration is optional and recorded separately. Atlas distributions count
judge-assessed attempt-dimensions, including unreviewed assessments; conflicting
reruns and abstentions retain explicit exclusions. Older confirmed-only reports
remain readable with their original population labels.

`ebo judge batch` runs study-configured jobs sequentially, preserves existing
outputs, and stops on failure or interruption. The
[evaluation runbook](../../docs/guides/behavioral-evaluation.md) covers evidence
selection, model-only aggregation, and Atlas export.

Large native trajectories support up to 131,072 relations per normalized event.
Provider-qualified Pi model identifiers are preserved.

## Verification

Run `npm ci` and `npm run acceptance` from a clean checkout on Node 24.19.0.
The acceptance command verifies the pinned fixture digests, builds and tests
the source, checks documentation and package contents, and compares two npm
tarballs for byte-identical output. Results and the staging tarball are written
to `.ebo/releases/1.0.0/` and bound to the checked source commit.

Live provider calls are opt-in and separate from deterministic release checks.
See [known limitations](KNOWN_LIMITATIONS.md).
