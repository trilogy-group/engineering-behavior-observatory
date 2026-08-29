# Run-bundle contract

Run bundles retain the evidence needed to inspect one attempt without copying
native harness payloads into a common event model. This contract is versioned
as [`schemas/run-bundles/v1.json`](../schemas/run-bundles/v1.json).

## Bundle layout

```text
run-bundle/
  manifest.json
  session.jsonl
  hooks.jsonl
  telemetry/
  workspace.patch
  verifier.json
  capture-report.json
  export/manifest.json
```

`manifest.json` is the run-manifest schema root. Its evidence descriptors are
the portable index: each gives an artifact ID, source, authority, media type,
SHA-256 digest, byte size, sharing class, bundle-relative path, and—when the
source provides one—native type and identity. Native content stays in the
referenced file. Artifact IDs are unique within a bundle, and every bundle
retains exactly one capture-report descriptor.

All paths are bundle-relative. The schema rejects absolute and parent-traversal
paths; the shared artifact utilities will also resolve symlinks and verify
digests before use. Each retained path appears exactly once under a
case-folded portable identity. A sanitized
partner or public artifact therefore has its own retained path, and source bytes
cannot masquerade as another evidence class.

## Evidence authority

| Authority | Source of record | It can answer |
| --- | --- | --- |
| `semantic` | Native session and hook artifacts | What the agent and harness exchanged or observed |
| `timing-resource` | Native telemetry | Timing, tokens, cost, and resource observations |
| `outcome` | Workspace and verifier artifacts | What changed and whether the task passed |
| `capture` | Capture report | Which evidence is available, missing, or unsupported |
| `export` | Export manifest | Which approved artifacts were prepared for sharing |

The contract does not describe a uniform event ontology or attach semantic
quality labels. Source-specific records remain authoritative until a later,
capture-qualified normalization step.

Evidence kind and authority are fixed pairs: sessions and hooks are semantic;
telemetry is timing-resource; workspace and verifier records are outcome; the
capture report is capture; and the export manifest is export.

## Attempt and terminal semantics

A run identifies the declared task/model/harness condition. An attempt is one
execution of that run; retries get a new attempt ID and must point at `retryOf`.
`retryOf` cannot name the attempt itself. No attempt replaces prior evidence.
When a run declares a native session ID, it retains at least one session
reference naming that same native session, with at least one parsed native
record.
The same rule applies to a declared native trace ID and retained telemetry
evidence. Runtime components are unique by source, name, and version.

`runtime` is a non-empty list of source-specific components, each with source,
name, and version. One component's source or name and version represents the
declared harness. An Agent SDK run can record SDK and CLI components; an Agent
Server run can record only its server component. No integration invents an
absent SDK or CLI identity.

`terminal` separates these conditions:

| Terminal state | Failure class | Stop reason |
| --- | --- | --- |
| `completed` | `none` | `none` |
| `failed` | `infrastructure` or `task` | `none` |
| `stopped` | `none` | `budget` or `policy` |
| `interrupted` | `infrastructure` | `none` |

Capture incompleteness is not a task or infrastructure failure class. It is a
capture-report qualification with an explicit missing-evidence reason.

## Qualification

`capture-report/v1` records `semantic`, `timingResource`, and `outcome`
capabilities separately. A `qualified` report requires available semantic and
outcome evidence and checked timing-resource evidence. Missing optional beta spans are recorded as
`optional-beta-unavailable` affecting `timing-resource`; they never assert that
semantic evidence is missing. Every unavailable capability has an explicit
missing-evidence entry; optional-beta-unavailable affects timing-resource only.
An available capability requires an indexed artifact with that authority. The
embedded capture report must also name the containing bundle. An `incomplete`
report remains a valid retained partial bundle but is not capture-qualified.
Missing-evidence effects cannot contradict a capability reported as available.
`unsupported` and `not-checked` reasons each match their corresponding
capability status.

An artifact may retain `sharingClass: unknown` when capture cannot classify it.
Exports fail closed: unknown artifacts and unknown export classes are never
ready or exported.

Verifier results cannot contradict their assertions: passed results have no
failed assertion, while failed results retain at least one failed assertion.
Assertion IDs are unique, and a retained verifier result names the containing
bundle. Completed runs retain passed verifier results; task-failed runs retain
at least one failed verifier result and may retain independent passed results.
Both outcomes require retained verifier and workspace evidence; workspace
evidence alone cannot establish task pass or task failure. A passed verifier
result contains only passed assertions and, when retained, an exit code of zero.
Every passed or failed verifier also names the retained workspace artifact and
digest it evaluated.

## Sharing boundary

A partner export that lists restricted native artifacts is `blocked`. A `ready`
or `exported` package resolves every artifact ID and requires every descriptor
to have the export's exact sharing class. A public package therefore cannot
bypass lookup or classification, and both partner and public packages need
separately sanitized artifacts. Each such descriptor records `sanitizedFrom`
with the retained source artifact ID and digest, and has a distinct bundle path;
changing a native artifact's sharing class is not sanitization. The export pipeline performs the actual
sanitization and readback; the v1 contract fixture makes the unsafe direct
reference visibly blocked. A ready or exported manifest also names its
containing bundle before its artifact list is approved. Ready and exported
manifests contain at least one non-export evidence artifact; blocked and
unrequested records may be empty but still name their containing bundle.

The contract is intentionally only a declaration. Schema loading, safe path
resolution, atomic persistence, and byte-level digest verification are shared
artifact primitives delivered separately; no runner, adapter, exporter, or
evaluation behavior is defined here.

## Fixtures

The four small fixtures under `test/fixtures/run-bundles/` establish the
contract boundary:

- `complete`: all five evidence authorities are referenced.
- `task-failed`: a verifier-backed task failure is distinct from infrastructure
  failure.
- `interrupted`: retained semantic evidence plus an incomplete capture report;
  no outcome evidence is invented.
- `telemetry-incomplete`: semantic and outcome evidence remain available while
  optional beta telemetry is explicitly absent.

The checked-in Node contract test runs the schema, cross-descriptor uniqueness,
sharing-path and export boundaries, capture-report correlation, capability
evidence, artifact references/digests, retry identity, and representative
rejected records. The later shared artifact validator reuses these fixtures; it
owns filesystem hardening and persistence rather than a second contract.
The build script clears compiled output first, and its regression test proves a
stale compiled test cannot survive into test discovery.
