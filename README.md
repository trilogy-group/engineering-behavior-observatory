# Engineering Behavior Observatory

Engineering Behavior Observatory (EBO) captures the native evidence produced by
software-engineering agents, connects it to final workspace outcomes, and
later supports evidence-grounded behavioral comparison across harnesses.

The first useful product is capture and observation: retained sessions, events,
hooks, telemetry references, workspace changes, optional verified-task results, and explicit
capture-quality reports. Cross-harness normalization, behavioral evaluation,
and the local Behavior Atlas build on capture-qualified bundles afterward.

The first post-capture contract is now available: versioned
[uniform events and explicit adapter interfaces](docs/uniform-events.md) project
capture-qualified native evidence without replacing source records or transport
semantics.

The [OpenHands Agent Server adapter](docs/openhands-agent-server.md) implements
the pinned `1.44.1` REST/WebSocket boundary with native-first reconciliation,
explicit completeness gaps, and verified run-bundle packaging.

The [DeepSeek Harness adapter](docs/deepseek-harness.md) uses the official
out-of-process TypeScript client, retains native session evidence and explicit
receipt-to-idle completion boundaries, and normalizes only qualified records.

## Status

M2 native Agent SDK capture is available through the public
`captureClaudeAgentSdkRun` library entry point. It executes one caller-supplied
attempt and retains its native stream, hooks, telemetry receipt, workspace,
assessment mode, capability profile, and structural qualification. Verified
tasks additionally retain their verifier result. Queue-wide
study execution remains an operational caller concern. The implementation
backlog is maintained separately in:

`/Users/magos/dev/trilogy/benchmarking/Anthropic-evals/plans`

The published Linear project is the execution view of that task package. Study
operations—task curation, model selection, trial counts, human review, and
partner delivery—are deliberately outside this software repository.

The bounded specification for connecting one frozen queue entry to this capture
path is [docs/agent-sdk-operational-runner.md](docs/agent-sdk-operational-runner.md);
`ebo agent-sdk run` implements it as the single-entry operator command, and
`ebo export create` wraps the existing portable-export library boundary.

## Integration shape

```text
EBO TypeScript coordinator
├── Claude Agent SDK adapter
│   └── direct TypeScript SDK integration
├── DeepSeek Harness adapter
│   └── official TypeScript client over JSON-RPC stdio
├── OpenHands adapter
│   └── pinned Agent Server REST/WebSocket API
└── uniform event projection
    └── only after native capture qualification
```

Native evidence remains authoritative. EBO does not replace harness histories,
reconstruct a telemetry backend, or force distinct control protocols into a
universal broker.

## Planned delivery

1. **Capture and observe:** repository and evidence contracts, task/run
   orchestration, direct Claude Agent SDK capture, safe export, and corpus access.
2. **Evaluate and compare:** uniform events, explicit harness adapters,
   structural and reviewed semantic evaluation, and a local evidence-linked
   Atlas.

## Development

EBO uses Node.js 24.19.0; `.nvmrc` pins the release. Install dependencies and
run the checks:

```sh
nvm use
npm ci
npm run build
npm run typecheck
npm test
node dist/src/cli.js --help
node dist/src/cli.js validate tests/fixtures/task-packet.valid.v1.json \
  test/fixtures/run-bundles/complete/manifest.json
node dist/src/cli.js task-packet validate <bundle-root> <packet.json>
node dist/src/cli.js task-packet admit <bundle-root> <packet.json>
node dist/src/cli.js task-packet freeze <bundle-root> <packet.json>
node dist/src/cli.js task-packet status <bundle-root> <packet.json>
node dist/src/cli.js matrix compile <experiment.json> <bundle-root> <queue.json> [--freeze-locator <task-id>=<path>]
node dist/src/cli.js queue inspect <queue.json>
node dist/src/cli.js queue validate <queue.json> [experiment.json] [--bundle-root <bundle-root>]
node dist/src/cli.js agent-sdk run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
node dist/src/cli.js export create <run-bundle-root> <policy.json> <export-root>
node dist/src/cli.js corpus build <corpus-root> <index.jsonl>
node dist/src/cli.js corpus query <index.jsonl> [--task <id>] [--model <id>] [--harness <id>] [--assessment-mode <observational|verified>]
node dist/src/cli.js corpus validate <corpus-root> <index.jsonl>
node dist/src/cli.js corpus pack <approved-export-root> <policy.json> <archive.tar.gz>
node dist/src/cli.js corpus unpack <archive.tar.gz> <destination-root>
# Optional approved OAuth smoke; provide OAuth auth, never API-key overrides.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
EBO_LIVE_AGENT_SDK_SMOKE=1 node --test --test-name-pattern='approved live Agent SDK smoke' dist/test/capture-qualification.test.js
# Optional approved OAuth proof of the operational runner; same auth rules.
EBO_LIVE_AGENT_SDK_RUNNER=1 node --test --test-name-pattern='approved live Agent SDK operational runner' dist/test/agent-sdk-runner.test.js
```

`captureClaudeAgentSdkRun` is intentionally a library API rather than another
configuration dialect: callers provide an already-resolved run definition,
workspace coordinator, Agent SDK configuration, and any mode-appropriate verifier. It does not
schedule or retry attempts.

`ebo agent-sdk run` executes exactly one persisted queue entry: it
digest-verifies the frozen task packet and the five `ebo.agent-sdk-config/v1`
records (model, harness, native-limits, native-tool-policy, and the queue's
capture profile) before launching the SDK, materializes one disposable
workspace, preserves an immutable starting baseline, and prints a small JSON
summary identifying the bundle, assessment mode, terminal state,
classification, and capture qualification. A task failure, budget stop, or
captured infrastructure failure is a successfully recorded observation; the
command returns nonzero only when inputs cannot be qualified, the attempt
cannot start, or the retained output fails validation. It never iterates the
queue, retries, or replaces an existing attempt destination. `ebo export
create` calls `createPortableRunBundleExport` with its policy-bound readback
and never modifies the restricted source bundle.

Observational packets are the primary path for open-ended enterprise work.
They contain no reference solution or verifier. Their `completed` terminal
means the agent loop ended normally and a final workspace was retained; it is
not a claim that the stakeholder's request was satisfied. Verified packets are
an optional benchmark-style mode and preserve verifier-backed pass/task-fail
semantics.

`ebo validate` checks the supported task-packet, experiment, and run-bundle
artifact versions. On failure it identifies the artifact, schema version, and
failing JSON field. Harness-specific normalizers, evaluation, and Atlas
behavior are introduced by their separately scoped tasks.

Task-packet commands validate externally authored packets, enforce their
recorded admission decision, persist a digest-based freeze record, and report
component changes. They do not generate tasks or perform human review.

Safe M2 evidence export is a library boundary:
`createPortableRunBundleExport` writes a separate partner/public derivative,
and `readPortableRunBundleExport` performs the required schema, integrity,
policy, and secret-scan readback. It does not publish or package a corpus.

The corpus index is a deterministic, atomically rebuilt JSONL read model over
run and export manifests. It records run-cell/trial and attempt identities
separately, projects assessment mode, terminal, optional verifier, capture, and export facts, and retains
validation issues instead of silently omitting missing evidence. Native
manifests remain authoritative; delete and rebuild the index at any time.
Queries use exact-match flags shown by `ebo --help` and do not index prompt or
tool bodies.

Portable archives accept only `ready` or `exported` partner/public trees that
pass the export pipeline's policy-bound readback and final secret scan.
Packing follows the export manifest allowlist, so an unlisted sibling file is
not included. Unpacking applies bounded TAR parsing, requires an exact
manifest/member match, verifies every digest, and refuses an existing
destination. No database, service, or archive package is involved.

The matrix compiler expands any valid experiment into a local, persisted run
queue. Sequential, seeded-shuffle, and balanced/interleaved policies retain
the seed and every frozen task, model, harness, configuration, and trial
identity; they do not start execution or add distributed scheduling.

Start with [AGENTS.md](AGENTS.md) and the assigned Linear issue. `WORKFLOW.md`
contains OpenSymphony orchestration configuration and should not be treated as
the EBO product specification.

The versioned task-packet and experiment contract surfaces are documented in
[docs/contracts.md](docs/contracts.md).

Run and attempt lifecycle plus the narrow process-protocol boundary are
documented in [docs/run-lifecycle.md](docs/run-lifecycle.md).
