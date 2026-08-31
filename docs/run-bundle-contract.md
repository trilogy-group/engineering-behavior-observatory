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

For TypeScript Agent SDK runs, `openClaudeAgentSdkHookCapture` creates the
no-clobber `hooks.jsonl` sink. Each source-specific record retains the complete
typed callback input, callback time, empty neutral callback output, abort-signal
state, and only the session, prompt, tool-use, agent, transcript, and working
directory identities the callback exposed. Because the native payload can
contain prompts, tool inputs, and local paths, the resulting artifact is
restricted evidence; later export policy must not treat the source file as a
sanitized derivative.

`hooks.jsonl` is authoritative for callback occurrence. Optional detailed-beta
hook spans are a separate timing capability and are not required to infer or
confirm an occurrence. If a hook append fails, the executor returns the neutral
empty hook output, keeps the agent operation running, and retains a bounded
capture warning in the attempt evidence.

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

`qualifyRunBundle` performs the post-capture structural check without adding a
new artifact dialect. Its report evaluates attempt identity, session evidence,
pinned hook capability versus observed callbacks, telemetry receipt and
optional timing, workspace outcome, verifier result, terminal classification,
and sharing classification independently. The overall result is `qualified`,
`qualified-with-gaps`, or `unqualified`, with stable reason codes and the named
evidence ID. Optional detailed-beta timing and a missing collector receipt are
timing gaps; missing or malformed semantic/outcome evidence, an unusable patch,
or contradictory capture-report facts are unqualified. The report contains no
behavioral or semantic-quality judgment.

An explicit `unsupported` capture-report capability remains qualified and is
reported as `unsupported`, not rewritten as missing evidence. Qualification
caps every retained artifact read at 64 MiB; larger evidence is rejected with
`ARTIFACT_TOO_LARGE` before whole-file parsing. Parsed session records and raw
telemetry payloads are not retained in the qualification report.

Session qualification requires the descriptor, manifest, and every observed
native session identity to agree. Hook JSONL must contain at least one pinned
callback in `hook`, `hook_event_name`, or a source-specific `type`; unrelated
nonempty JSON does not count as hook evidence. A telemetry artifact without a
collector receipt is a `TELEMETRY_RECEIPT_MISSING` gap, including the supported
usage-only path.

Qualification reuses manifest schema checks, descriptor digest/path readback,
verifier-to-workspace terminal binding, and export-manifest validation. When a
workspace patch is present, callers supply the admitted starting fixture so the
patch can be checked with `git apply --check`; omission leaves an explicit
`WORKSPACE_PATCH_NOT_CHECKED` gap.

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

The executor receives both the retained workspace artifact reference and a
separate live-workspace fingerprint; the executor options require the retained
workspace reference to carry that same fingerprint. The v1 live-workspace fingerprint hashes
the root and sorted descendant relative paths, entry kinds, permission mode
bits, reproducible modification times, and file bytes; hard-linked files,
symbolic links, and unsupported entry kinds are rejected. POSIX snapshots use
the metadata-preserving system copy path with nanosecond modification times;
the Windows fallback uses Node's reproducible millisecond precision. The
fingerprint must
match the live workspace before and after its private snapshot is created. The
executor then evaluates that detached snapshot, while the artifact digest
remains the digest of the retained workspace evidence. The complete executor
result records the snapshot fingerprint alongside the workspace reference, and
manifest workspace descriptors may carry it for later terminal binding checks.

Verifier execution uses a small subprocess boundary. The executor resolves the
digest-pinned restricted verifier from its task-bundle root, stages it in a
private trusted subdirectory separate from the snapshot, and invokes the pinned
Node runtime with the staged verifier path followed by the snapshot workspace
path. Launcher options cannot replace the staged entry point, and the child
environment contains only fixed coordinator variables; `PATH` points to a
dedicated empty trusted-stage directory, while Node preload, POSIX dynamic-loader,
shell-startup, and interpreter module-path injection are unavailable. Verifier
tools must be invoked by absolute pinned paths. Normal completion is reported
over a parent-owned extra stdio channel rather than a marker file or inherited
environment variable, so ordinary workspace descendants cannot recreate it. The
restricted implementation and any
reference solution remain outside that workspace. `.mjs`/`.cjs` locators retain
their module semantics; ambiguous `.js` or extensionless artifacts default to
CommonJS unless the caller supplies `moduleFormat: "module"`, and explicit
formats cannot contradict an unambiguous suffix. The verifier writes one JSON
object to stdout:

```json
{
  "assertions": [
    { "id": "unit-tests", "status": "passed" },
    { "id": "lint", "status": "failed" }
  ]
}
```

Each assertion object contains exactly `id` and `status`; undeclared fields,
non-string statuses, duplicate IDs, and IDs longer than 256 characters are
verifier errors rather than silently normalized away.

The executor records the selected verifier's locator, digest, and module format, the assertion
list, `durationMs`, observed `exitCode` when the process exits normally, and a
`status` of `passed`, `failed`, or `error`. A run manifest may declare the
task-bound verifier reference under `run.verifier`; manifest validation then
requires each retained unsanitized verifier result to identify that same
reference. A valid assertion failure is a task failure; timeout, crash, invalid
UTF-8/JSON, duplicate or invalid assertion, and an exit/assertion contradiction
are verifier errors. A failed assertion therefore requires a nonzero verifier
exit; a zero exit paired with a failure is not a task result. `not-run` remains
available for a caller that records a verifier which was never started, and its
assertions must all be `not-run`. Stdout
and stderr are drained without an unbounded buffer and persisted to private
files while the process runs, so a partial attempt retains output even when
execution ends abnormally. A timeout terminates the verifier process group (or
process tree on Windows). Each retained stream is represented by an
execution-specific diagnostic reference with a `stream` (`stdout` or `stderr`),
bundle-relative `locator`, SHA-256 `digest`, retained `sizeBytes`, and a
`truncated` flag. Sanitized verifier results may retain diagnostics only when
each one carries a source diagnostic origin and points to a separately
classified `diagnostic` evidence sidecar. The sidecar's path, digest, and size
must match exactly, and it must be included in the export. The result remains
valid even when diagnostics are truncated.
The `durationMs` and `diagnostics` fields are optional for older v1 records;
new executor results include both. An `error` result requires a nonempty
explanation and may omit `workspace` when the verifier failed before a
workspace was available; it must not invent a workspace binding. Coordinator
failures such as timeout, launch, parse, or
cleanup errors are recorded in the result's `error` field; the native stderr
diagnostic remains byte-for-byte separate. `error` is not valid on passed or
failed results. Sanitized verifier derivatives preserve `durationMs` and
`error`; sensitive error text may use `errorRedacted: true` with the literal
`[redacted]`, but cannot be replaced by an unmarked claim. The process-group boundary cannot
contain a verifier that deliberately creates a new POSIX session; callers that
run untrusted verifiers need an OS sandbox or equivalent isolation boundary.

The result serializer validates `verifier-result/v1` before writing it. The
diagnostic references are read back and digest-checked before the result is
saved, so a result cannot point at missing or changed diagnostic bytes. Result
paths use no-clobber persistence: an existing result, manifest, or other
retained evidence file is never replaced by a later verifier write, and a
crash between the no-clobber link and temporary-name cleanup is recovered on
the next verified read. Manifest
validation also cross-checks each retained verifier's `bundleId` and workspace
artifact ID/digest against the containing bundle's retained evidence. The
`manifest.json` path and its descendants are reserved for the containing
manifest and cannot be used for verifier results or diagnostic directories.
The CLI applies duplicate-key detection to standalone verifier JSON before
parsing, just as manifest-nested verifier artifacts and subprocess output are
checked before interpretation. Manifest validation also requires a retained
passed verifier for a completed run and a retained failed verifier for a
task-failed run, and checks each verifier's status against that terminal
outcome before the bundle is accepted.

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
