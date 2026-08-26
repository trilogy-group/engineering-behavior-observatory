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
referenced file.

All paths are bundle-relative. The schema rejects absolute and parent-traversal
paths; the shared artifact utilities will also resolve symlinks and verify
digests before use.

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

## Attempt and terminal semantics

A run identifies the declared task/model/harness condition. An attempt is one
execution of that run; retries get a new attempt ID and may point at `retryOf`.
No attempt replaces prior evidence.

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
outcome evidence and cannot declare either authority missing. Missing optional beta spans are recorded as
`optional-beta-unavailable` affecting `timing-resource`; they never assert that
semantic evidence is missing. An `incomplete` report remains a valid retained
partial bundle but is not capture-qualified.

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
