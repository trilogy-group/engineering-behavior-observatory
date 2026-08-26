# Task-packet and experiment contracts

EBO accepts externally authored task packets and experiment configurations as
versioned JSON documents. The schemas are the contract; this repository does
not contain an evaluation corpus or a fixed operating matrix.

## Task packets

`schemas/task-packet.v1.schema.json` divides a packet into two surfaces:

- `agentInput` is the only surface a workspace materializer may use. It holds
  the public prompt and fixture source/materializer instructions. Its required
  exclusions make reference solutions, verifier internals, and review records
  unavailable to the agent workspace.
- `restricted` contains only digest-addressed references to those three
  protected components. It deliberately cannot embed their contents.

The packet records repository provenance, a controlled perturbation, admission
review status, sharing classification, and SHA-256 digests for every frozen
component. A future admission tool owns resolving and freezing those references;
the schema only makes their required evidence explicit.

## Experiments

`schemas/experiment.v1.schema.json` treats task, model, and harness sets;
trial count; ordering seed; budgets; tool policy; and capture profile as data.
The fixtures include a generic 18-cell matrix and a differently shaped matrix
to show that no study dimensions are built into the contract.

Unknown schema versions and sharing classifications are invalid. Consumers must
validate a document before materializing a workspace or scheduling a run.
