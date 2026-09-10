# Inspect and share evidence

A run bundle is the retained record of one attempt. Begin with its manifest,
not a filename guessed from another harness.

## Read a run

| Read | Question |
| :--- | :--- |
| CLI summary | Where is the bundle? Did cleanup leave a workspace to recover? |
| `manifest.json` | Which run/attempt, runtime, configuration, terminal and evidence descriptors belong together? |
| Capture report referenced by the manifest | Which evidence qualified? What is missing or unsupported? |
| Native session/store/hooks | What did the agent and harness actually emit? |
| Workspace descriptor and patch/snapshot | What changed from the frozen starting tree? |
| Derived observations | Which mechanical facts are supported, and by which native records? |

Each evidence descriptor gives the retained path, media type, size, digest, and
authority. Names differ by harness. A Pi session tree and a Cursor JSONL store
are not interchangeable with an Agent SDK stream.

```sh
ebo validate <bundle-root>/manifest.json
ebo observations create <bundle-root> study/observations.json
ebo corpus build study/runs study/index.jsonl
ebo corpus validate study/runs study/index.jsonl
ebo corpus query study/index.jsonl --capture qualified
```

`validate` checks supported artifact schemas; it is not a claim that every
referenced byte or capability was verified. Observation creation and corpus
validation perform their documented retained-evidence checks. Review
`qualified-with-gaps` separately, using the gaps relevant to your question.

The corpus index is a rebuildable JSONL view, not the source of truth. It
indexes identities and capture/outcome facts rather than prompt and tool bodies.

## Preserve partial attempts

Do not discard an interrupted run because it lacks a final answer. Its native
events can still explain a stop. Keep terminal state, infrastructure failure,
and capture quality separate. Preserve `retainedWorkspacePath` when outcome
packaging failed; that path is a recovery location, not qualified evidence.

Use a new output destination for derived records and reruns. Do not edit a
native bundle to make a validator accept it.

## Create a portable export

Review the sharing authorization and source material first. Sanitization reduces
disclosure risk; it does not grant permission to distribute someone else's code.

Save a caller-owned policy as `study/export-policy.json`:

```json
{
  "sharingClass": "partner",
  "maxArtifactBytes": 16777216,
  "maxStringBytes": 8192,
  "sensitiveValues": []
}
```

Add known confidential strings to `sensitiveValues` when necessary. Keep
that policy restricted if it contains them. Bounds are examples: choose values
appropriate to the evidence, not a reason to silently truncate it.

```sh
ebo export create <bundle-root> study/export-policy.json study/exports/run-a
ebo corpus pack study/exports/run-a study/export-policy.json study/run-a.tar.gz
```

Export creates a separate derivative, removes hidden reasoning and detected
secrets/local identifiers, rewrites correlations, and validates the output.
Unknown classifications, unsupported content, or failed integrity/secret checks
stop creation. Native source bytes remain unchanged. Inspect the export manifest
for transformations and exclusions: opaque workspace snapshots, for example,
are not made shareable by passing through a text sanitizer.

Packing revalidates the derivative with the same policy, follows the export
manifest allowlist, and records only approved members. It does not publish.

To inspect a received archive:

```sh
ebo corpus unpack study/run-a.tar.gz study/received-run-a
```

The destination must not exist. Unpacking validates archive bounds, membership,
paths, and digests. Do not replace this with manual extraction of an untrusted
archive into your checkout.

## Reports are a separate sharing surface

An ordinary Atlas report is **restricted-local-only**, even if displayed
citations are sanitized. Shareable summaries require approved exports for every
selected source and an explicit Atlas sharing policy. See
[reports and sharing](atlas.md#reports-and-sharing) for supported fields and
exclusions.

For field-level details, see the [run-bundle contract](../reference/run-bundle-contract.md).
