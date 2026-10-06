# EBO 1.2.0

## Capture

- **Devin CLI harness** (`ebo devin run`): EBO owns a pinned `devin acp` child
  (Devin CLI 3000.11.3) over stdio and retains every Agent Client Protocol frame
  as native session evidence, with OTLP/HTTP protobuf telemetry received by an
  EBO-owned endpoint. See the [Devin CLI guide](../../docs/harnesses/devin-cli.md).
- **Retained readback** accepts every released harness pin: each version-gated
  adapter keeps a retained-version list that pin bumps append to, and the
  manifest version must match the version the capture's single native
  composition record names (Pi, DeepSeek).

## Normalization (changed in place)

- Per-request token usage events (`resourceSemantics: increment`) for the
  Claude Agent SDK, Codex and DeepSeek Harness, with native request identities.
- Records without an origin timestamp use the callback or receipt clock,
  labeled `nativeTimeSource`; delegation records carry task identity, status and
  content references; Pi history records share identities with stream events.
- Tool events carry `toolName`, `inputDigest`, `isError` and `exitCode` where
  the harness exposes them; `PostToolBatch` callbacks are not tool operations.
- `globalEventKey` is `<runId>/<attemptId>/<eventId>`, percent-encoded.

Normalized datasets differ from 1.1.x for the same bundles. Observation sets and
behavior assertions bound to 1.1.x dataset digests no longer validate:
regenerate observations and re-judge before aggregating or building an Atlas.

## Evaluation

- **Occurrences** (structural extractor 1.1.0): failure responses, validation
  runs, source changes, repeated operations, compactions and delegations, each
  citing only its own events, with unavailable types reported as such. See
  [structural observations](../../docs/evaluation/structural-observations.md).
- **Occurrence ratings** (`ebo occurrences rate`): typed questions per occurrence
  answered by a System One decision model (TypeSafe Jev or the Fireworks
  decisions API), retained as decision records with an explicit acceptance
  policy.
- **Judge preparation** (`ebo judge prepare`): requests show the judge every
  occurrence of the selected types as a ledger row with its ratings, choose full
  records by a recorded policy, and accept citations that name an occurrence.
  See [occurrence ratings](../../docs/evaluation/occurrence-ratings.md).

## Exports

One redaction implementation decides what portable exports, Atlas reports and
evidence packets redact and what the final secret scan rejects. Secret-named
assignments are classified by context: shell values are scanned as shell words
(literal parts redacted, complete environment references kept), and code
expressions keep syntactic references while their literals are redacted. Atlas
`report.json` lists every scan match with a resolvable JSON pointer.

## Verification

`npm run acceptance` checks the source, tests, documentation links and two
byte-identical package builds. Normalization, occurrences, ratings and judge
preparation were also exercised on 48 retained attempts across four harnesses
(native content stays local). [`reproducibility.json`](reproducibility.json)
records the pinned runtimes and fixture digests.
