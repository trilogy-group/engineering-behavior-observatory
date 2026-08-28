# Engineering Behavior Observatory agent guide

## Mission

Build a small, inspectable system that connects an engineering agent's outcome
to the native trajectory evidence that produced it. Deliver capture and
observation before cross-harness normalization or semantic evaluation.

The implementation plan lives in
`/Users/magos/dev/trilogy/benchmarking/Anthropic-evals/plans`. Linear is its
published execution view. Do not copy the planning package into this repository
or implement beyond the assigned issue.

## Architecture invariants

- TypeScript on a pinned active-LTS Node.js release is the coordinating runtime.
- Integrate Claude Agent SDK directly through its TypeScript API and retain its
  fullest version-supported passive lifecycle-hook surface.
- Run DeepSeek Harness out of process through its official TypeScript client and
  newline-delimited JSON-RPC stdio server. Runtime configuration and plugins own
  mechanistic experiments; EBO records the selected composition and native
  notifications. Do not embed its agent loop or recreate its protocol client.
- Integrate OpenHands through a pinned Agent Server REST/WebSocket boundary.
  Claim only the evidence verified through that API; do not assume complete
  in-process `EventLog` delivery.
- Keep source control protocols separate from EBO's small uniform event
  projection. Each adapter retains its own methods, identities, lifecycle, and
  completion semantics.
- Native sessions, streams, events, and hooks are semantic evidence; native
  OpenTelemetry is timing and resource evidence; workspace state plus verifiers
  are outcome evidence. Preserve native evidence and normalize only after
  capture qualification.
- Represent missing or unsupported evidence explicitly. Never synthesize events
  or turn missing evidence into `false` or zero.
- Preserve failed and interrupted attempts as valid partial bundles. A retry is
  a new linked attempt, never a replacement.

## Scope boundaries

- Task authorship, model selection, concrete trial counts, human corpus review,
  study execution, and partner delivery are operations that consume EBO. Do not
  hard-code them into the product.
- Structural extractors report exact facts only. Semantic claims require cited
  evidence, an alternative explanation, abstention, and human calibration.
- Export fails closed on unknown sharing classification and excludes secrets,
  environment values, local identifiers, and hidden reasoning.
- Do not build a custom telemetry backend, graph database, distributed runner,
  universal JSON-RPC broker, dynamic plugin host, trained classifier, hosted
  Atlas, Python/TypeScript capture shim, or Rust component without a later issue
  backed by measured need.

## Implementation defaults

- Prefer Node standard-library APIs for files, paths, subprocesses, streams,
  hashing, compression, temporary directories, and atomic replacement.
- Use ESM and `node:test`. Add the smallest dependency that an accepted contract
  or official integration requires; avoid speculative abstractions.
- Use versioned JSON/JSONL and content digests for durable interchange. Add a
  database only when demonstrated queries require one.
- Write partial evidence continuously before producing a completed manifest.
- Keep telemetry content capture off by default and never use a console
  telemetry exporter where stdout is a protocol channel.
- Leave one small runnable check for each non-trivial behavior change.

## Working on an issue

1. Read this file, [README.md](README.md), and the assigned Linear issue.
2. Follow its blockers, scope exclusions, deliverables, and acceptance criteria.
3. Recheck current official SDK/server documentation before depending on beta
   telemetry, hook availability, protocol completion, or event completeness.
4. Make the smallest coherent change and preserve existing OpenSymphony files.
5. Run the documented checks after the final edit and include the fresh output
   in the PR description.

The Node release is pinned in `.nvmrc` and `package.json`. The bootstrap checks
are `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, and
`node dist/src/cli.js --help`. Keep this list and `README.md` current as the
project gains only issue-backed commands.

## Review priorities

Review evidence loss, invented normalization, unsafe export, overwritten partial
attempts, protocol-channel corruption, and untested failure paths before style.
Treat behavior changes without a runnable check as incomplete. Keep the durable
review guide in `.agents/skills/custom-codereview-guide.md` aligned with these
priorities.

Use semantic branch prefixes such as `feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, or `test/`.
