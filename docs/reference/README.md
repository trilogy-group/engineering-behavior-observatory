# Reference

Use guides to learn a workflow; use these pages when implementing or checking
an exact contract.

| Reference | Answers |
| :--- | :--- |
| [CLI](cli.md) | Commands grouped by preparation, capture, evidence, evaluation, and reports |
| [Task packets and experiments](contracts.md) | Archive rules, admission, freeze, configuration digests, run matrices |
| [Run bundles](run-bundle-contract.md) | Evidence descriptors, terminal states, qualification, workspace and export contracts |
| [Run lifecycle](run-lifecycle.md) | Attempt ownership, interruption, retries, process boundary |
| [Agent SDK configuration](agent-sdk-operational-runner.md) | Five source-specific queue records and runner behavior |
| [Uniform events](../evaluation/uniform-events.md) | Families, native references, coverage, explicit unknown/unsupported values |
| [Extension contracts](../development/extension-contracts.md) | How new adapters and evaluators fit existing interfaces |

Machine-readable contracts are shipped under `schemas/`, `contracts/`, and
`ontology/`. Paths in versioned records are interpreted by their contract,
not automatically relative to your current shell directory. CLI filesystem
arguments are operator paths; packet locators remain bundle-relative.
