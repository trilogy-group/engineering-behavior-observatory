# Engineering Behavior Observatory

Engineering Behavior Observatory (EBO) captures the native evidence produced by
software-engineering agents, connects it to workspace and verifier outcomes, and
later supports evidence-grounded behavioral comparison across harnesses.

The first useful product is capture and observation: retained sessions, events,
hooks, telemetry references, workspace changes, verifier results, and explicit
capture-quality reports. Cross-harness normalization, behavioral evaluation,
and the local Behavior Atlas build on capture-qualified bundles afterward.

## Status

M2 native Agent SDK capture is available through the public
`captureClaudeAgentSdkRun` library entry point. It executes one caller-supplied
attempt and retains its native stream, hooks, telemetry receipt, workspace,
verifier result, capability profile, and structural qualification. Queue-wide
study execution remains an operational caller concern. The implementation
backlog is maintained separately in:

`/Users/magos/dev/trilogy/benchmarking/Anthropic-evals/plans`

The published Linear project is the execution view of that task package. Study
operations—task curation, model selection, trial counts, human review, and
partner delivery—are deliberately outside this software repository.

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
# Optional approved OAuth smoke; provide OAuth auth, never API-key overrides.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
EBO_LIVE_AGENT_SDK_SMOKE=1 node --test --test-name-pattern='approved live Agent SDK smoke' dist/test/capture-qualification.test.js
```

`captureClaudeAgentSdkRun` is intentionally a library API rather than another
configuration dialect: callers provide an already-resolved run definition,
workspace coordinator, Agent SDK configuration, and verifier. It does not
schedule or retry attempts.

`ebo validate` checks the supported task-packet, experiment, and run-bundle
artifact versions. On failure it identifies the artifact, schema version, and
failing JSON field. Adapter, evaluation, and Atlas behavior are introduced by
their separately scoped tasks.

Task-packet commands validate externally authored packets, enforce their
recorded admission decision, persist a digest-based freeze record, and report
component changes. They do not generate tasks or perform human review.

Safe M2 evidence export is a library boundary:
`createPortableRunBundleExport` writes a separate partner/public derivative,
and `readPortableRunBundleExport` performs the required schema, integrity,
policy, and secret-scan readback. It does not publish or package a corpus.

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
