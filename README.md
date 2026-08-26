# Engineering Behavior Observatory

Engineering Behavior Observatory (EBO) captures the native evidence produced by
software-engineering agents, connects it to workspace and verifier outcomes, and
later supports evidence-grounded behavioral comparison across harnesses.

The first useful product is capture and observation: retained sessions, events,
hooks, telemetry references, workspace changes, verifier results, and explicit
capture-quality reports. Cross-harness normalization, behavioral evaluation,
and the local Behavior Atlas build on capture-qualified bundles afterward.

## Status

Implementation has not started. OpenSymphony repository integration is present,
and the implementation backlog is maintained separately in:

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

TASK-001 will establish the minimal ESM TypeScript/Node package and its verified
build, type-check, test, and command workflows. Until that task lands, there are
no product setup or execution commands to document.

Start with [AGENTS.md](AGENTS.md) and the assigned Linear issue. `WORKFLOW.md`
contains OpenSymphony orchestration configuration and should not be treated as
the EBO product specification.

## Design sources

The canonical research and design corpus is maintained in:

`/Users/magos/dev/trilogy/benchmarking/Anthropic-evals/docs`

The internal implementation plan is intentionally separate from partner-facing
artifacts. Repository decisions should preserve that separation and the
capture-before-evaluation sequence.
