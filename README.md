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

The versioned [behavior assertion contract](docs/behavior-assertions.md) binds
one declared behavior dimension to the exact normalized dataset, event, and
reachable native source. Human review remains a separate record.

The [semantic judge runner](docs/semantic-judge.md) packages caller-selected,
bounded evidence for one dimension and retains proposed assertions,
abstentions, and failed judgments through an explicitly selected isolated
Claude Agent SDK or native Codex backend, independently of the evaluated harness.

The [OpenHands Agent Server adapter](docs/openhands-agent-server.md) implements
the pinned `1.44.1` REST/WebSocket boundary with native-first reconciliation,
explicit completeness gaps, and verified run-bundle packaging.

The [DeepSeek Harness adapter](docs/deepseek-harness.md) uses the official
out-of-process TypeScript client, retains native session evidence and explicit
receipt-to-idle completion boundaries, and normalizes only qualified records.

The optional [Codex app-server adapter](docs/codex-harness.md) owns one pinned
`0.153.4` stdio child per attempt, retains native thread/turn/item evidence and
independently verified OTLP receipts, and runs one frozen observational queue
entry through `ebo codex run`.

## Status

M2 native Agent SDK capture is available through the public
`captureClaudeAgentSdkRun` library entry point. It executes one caller-supplied
attempt and retains its native stream, hooks, telemetry receipt, workspace,
assessment mode, capability profile, and structural qualification. Verified
tasks additionally retain their verifier result. Queue-wide
study execution remains an operational caller concern. The implementation
backlog is maintained in a separate planning package. The published Linear
project is the execution view of that task package. Study
operations—task curation, model selection, trial counts, human review, and
partner delivery—are deliberately outside this software repository.

The bounded specification for connecting one frozen queue entry to this capture
path is [docs/agent-sdk-operational-runner.md](docs/agent-sdk-operational-runner.md);
`ebo agent-sdk run` implements it as the single-entry operator command, and
`ebo export create` wraps the existing portable-export library boundary.

Start with the [local operator guide](docs/operator-guide.md) for the complete
packet-to-Atlas workflow, artifact locations, and failure recovery. Use the
[extension contracts guide](docs/extension-contracts.md) when adding a harness
adapter, process/API boundary, structural extractor, rubric, verifier, or
export policy.

## Integration shape

```text
EBO TypeScript coordinator
├── Claude Agent SDK adapter
│   └── direct TypeScript SDK integration
├── DeepSeek Harness adapter
│   └── official TypeScript client over JSON-RPC stdio
├── OpenHands adapter
│   └── pinned Agent Server REST/WebSocket API
├── Codex adapter
│   └── pinned app-server JSONL protocol over owned stdio
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
npm run acceptance
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
node dist/src/cli.js codex run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
node dist/src/cli.js export create <run-bundle-root> <policy.json> <export-root>
node dist/src/cli.js corpus build <corpus-root> <index.jsonl>
node dist/src/cli.js corpus query <index.jsonl> [--task <id>] [--model <id>] [--harness <id>] [--assessment-mode <observational|verified>]
node dist/src/cli.js corpus validate <corpus-root> <index.jsonl>
node dist/src/cli.js corpus pack <approved-export-root> <policy.json> <archive.tar.gz>
node dist/src/cli.js corpus unpack <archive.tar.gz> <destination-root>
node dist/src/cli.js comparison check <request.json>
node dist/src/cli.js aggregate build <request.json> <output.json>
node dist/src/cli.js calibration sample <sources.json> <criteria.json> <selection.json>
node dist/src/cli.js calibration packet <selection.json> <output-root>
node dist/src/cli.js calibration inspect <packet.json> <assertion-id> [event-id]
node dist/src/cli.js calibration binding <selection.json> <assertion-id> [history.json]
node dist/src/cli.js calibration import <selection.json> <history.json> <decision.json>
node dist/src/cli.js calibration adjudicate <selection.json> <history.json> <decision.json>
node dist/src/cli.js calibration summarize <selection.json> <history.json> <summary.json>
node dist/src/cli.js assertions validate <run-bundle-root> <assertion.json> [review.json]
node dist/src/cli.js judge run <run-bundle-root> <observations.json> <request.json> <output-root>
node dist/src/cli.js observations create <run-bundle-root> <output.json>
node dist/src/cli.js observations corpus <corpus-root> <index.jsonl> <output-root> [corpus query flags]
# Optional approved OAuth smoke; provide OAuth auth, never API-key overrides.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
EBO_LIVE_AGENT_SDK_SMOKE=1 node --test --test-name-pattern='approved live Agent SDK smoke' dist/test/capture-qualification.test.js
# Optional approved OAuth proof of the operational runner; same auth rules.
EBO_LIVE_AGENT_SDK_RUNNER=1 node --test --test-name-pattern='approved live Agent SDK operational runner' dist/test/agent-sdk-runner.test.js
```

`npm run acceptance` is the release gate. It runs the complete deterministic
suite, verifies local documentation links and pinned fixture digests, and packs
the npm artifact twice to prove byte-identical output. It writes the package,
checksum, and current result under `.ebo/releases/0.1.0/`; nothing is published
or tagged. See [the release audit](release/0.1.0/README.md) and
[known limitations](release/0.1.0/KNOWN_LIMITATIONS.md).

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

If outcome packaging fails after execution starts, the runner preserves the
source workspace for recovery and includes `retainedWorkspacePath` in its local
summary. The summary also reports this path if cleanup fails after successful
packaging. Capture remains unqualified until valid outcome evidence is available.
Workspace diffs use an indexed Git tree without creating a commit, avoiding
background Git maintenance during temporary-repository cleanup.

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

Normalized datasets retain digest-bound native references rather than copied
source records. Their validator produces adapter/version coverage that keeps
unmapped native types and unsupported capabilities explicit. `ebo comparison
check` evaluates one inspectable comparison request and returns `supported`,
`qualified-with-caveats`, or `unsupported`; declared harness differences remain
caveats and never become causal claims. The v2 comparison contract adds exact
measure, manifest, request, and policy bindings for aggregation while the v1
CLI path remains readable. See
[docs/normalization-integrity.md](docs/normalization-integrity.md).

The [comparison and aggregation read model](docs/aggregation.md) scans the
current corpus and derived evaluation artifacts directly, keeps run, attempt,
operation, assertion, and reviewed-assertion populations separate, and emits
explicit denominators, exclusions, caveats, and descriptive claim status. It
does not infer causality, statistical significance, or a composite ranking.

The [local human calibration workflow](docs/human-calibration.md) selects
digest-bound review samples, renders escaped static packets with only the cited
restricted records and relative links back to native evidence, appends human review and
adjudication decisions, and reports agreement with explicit populations and
denominators. It does not host review, assign people, confirm assertions on an
agent's behalf, or produce comparison aggregates.

The [Behavior Atlas](docs/atlas.md) adds reproducible cohort queries, native
Grafana dashboards, evidence/review drilldown and standalone HTML/print reports.
`ebo atlas build <request.json> <new-output-root>` freezes a report;
`ebo atlas serve <request.json>` opens the local query surface. Restricted
inspection and policy-validated shareable summaries remain separate.

Versioned [structural observations](docs/structural-observations.md) ingest
terminal, capture, workspace, and mode-appropriate verifier outcomes, then
compute exact native-evidence facts. Logical tool operations use native IDs,
resource snapshots are not added repeatedly, unrelated order domains stay
separate, and missing capability is unavailable rather than zero. The CLI reads
qualified retained Claude Agent SDK, Codex, OpenHands, or DeepSeek bundles or an exact corpus selection and always
writes derived records outside immutable source evidence.

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

Source contributors should start with the repository `AGENTS.md` and the
assigned Linear issue. `WORKFLOW.md`
contains OpenSymphony orchestration configuration and should not be treated as
the EBO product specification.

The versioned task-packet and experiment contract surfaces are documented in
[docs/contracts.md](docs/contracts.md).

Run and attempt lifecycle plus the narrow process-protocol boundary are
documented in [docs/run-lifecycle.md](docs/run-lifecycle.md).
