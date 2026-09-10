# EBO documentation

Start with the question you need to answer. Operational guides explain what to
do; reference pages describe the exact contracts. All shell examples assume
the `ebo` command is installed as described in the quickstart.

## Start here

1. [Quickstart](guides/quickstart.md): install EBO and open a synthetic
   report without credentials; then prepare for a real capture.
2. [Choose a harness](harnesses/README.md): compare execution boundaries,
   evidence coverage, and prerequisites.
3. [Operator guide](guides/operator-guide.md): prepare, freeze, execute,
   inspect, export, and evaluate a task.

## Operate and inspect

- [Evidence and sharing](guides/evidence-and-sharing.md): which files to read,
  how to interpret a partial run, and how to create a portable archive.
- [Telemetry](guides/telemetry.md): native events versus OTLP, collector receipt,
  Grafana, and resource-accounting caveats.
- [Behavior Atlas](guides/atlas.md): cohort filters, cited evidence, Grafana
  provisioning, and static reports.

## Harness guides

[Claude Agent SDK](harnesses/claude-agent-sdk.md) ·
[Codex](harnesses/codex-harness.md) · [Cursor](harnesses/cursor-sdk.md) ·
[Pi](harnesses/pi-sdk.md) · [OpenHands](harnesses/openhands-agent-server.md) ·
[DeepSeek Harness](harnesses/deepseek-harness.md)

These guides own runtime pins, configuration, native evidence, and known gaps.

## Evaluate behavior

The [evaluation reading path](evaluation/README.md) explains how the parts fit:

- [Uniform events](evaluation/uniform-events.md) and
  [normalization integrity](evaluation/normalization-integrity.md)
- [Structural observations](evaluation/structural-observations.md)
- [Behavior assertions](evaluation/behavior-assertions.md) and
  [semantic judging](evaluation/semantic-judge.md)
- [Human calibration](evaluation/human-calibration.md)
- [Comparison and aggregation](evaluation/aggregation.md)

## Build and look things up

- [Reference index](reference/README.md): grouped CLI syntax, packet/experiment
  contracts, run bundles, lifecycle, and Agent SDK configuration.
- [Contributor guide](development/README.md): checks, documentation ownership,
  and release preparation.
- [Extension contracts](development/extension-contracts.md): adapter, extractor,
  rubric, verifier, and export-policy development.
- [Documentation sync findings](development/documentation-sync.md): why generated
  change provenance is kept separate from public documentation.
- [Release records](../release/README.md): versioned verification and limitations.

For agents: read the repository's `AGENTS.md`, then the relevant guide and
contract. CLI syntax is in [one grouped reference](reference/cli.md), not
scattered through release history.
