# Operational Agent SDK runner

**Status:** Implementation specification

**Audience:** The engineer implementing the next EBO change without prior project or Linear context

**Outcome:** One command can execute one frozen run-queue entry through the Claude Agent SDK and retain a qualified run bundle that can be exported and indexed.

## 1. Why this work exists

EBO already has the pieces required to capture an Agent SDK attempt:

- admitted and frozen task packets;
- deterministic run queues;
- isolated workspace materialization;
- Agent SDK stream, hook, usage, and OpenTelemetry capture;
- lifecycle and partial-attempt retention;
- optional digest-pinned verifier execution for verified tasks;
- run-bundle assembly and structural qualification;
- fail-closed portable export and corpus indexing.

The production path composes these pieces for both observational and verified
task packets. Observational packets are the primary open-ended research path
and deliberately have no reference solution or verifier.

This change closes those gaps before cross-harness normalization begins.

## 2. Project orientation

EBO is a private TypeScript/ESM package on Node.js 24.19.0. It uses `node:test`, the Node standard library, AJV, and the pinned `@anthropic-ai/claude-agent-sdk` package. Read `AGENTS.md` and `README.md` before editing.

The relevant existing modules are:

| Module | Existing responsibility |
| --- | --- |
| `src/scheduler.ts` | Read, validate, inspect, and select persisted run-queue entries. |
| `src/task-packets.ts` | Validate admission/freeze state and expose the model-visible prompt plus any verified-task reference. |
| `src/contracts.ts` | Resolve digest-pinned bundle artifacts and configuration bytes. |
| `src/workspaces.ts` | Materialize and clean one frozen task workspace. |
| `src/agent-sdk-run.ts` | Capture one already-resolved Agent SDK attempt. Do not duplicate this logic. |
| `src/verifiers.ts` | Execute a verified task's digest-pinned verifier against a detached final workspace snapshot. |
| `src/exports.ts` | Create and read back a sanitized partner/public derivative. |
| `src/corpus.ts` | Build, query, validate, pack, and unpack corpus artifacts. |
| `src/cli.ts` | Current operator commands. Add the narrow commands specified below. |

The authoritative evidence model is:

```text
Agent SDK stream + hooks     semantic evidence
Agent SDK OpenTelemetry     timing and resource evidence
workspace                   artifact and outcome evidence
verified-task verifier      optional executable outcome evidence
capture report              evidence availability and qualification
```

Native evidence remains authoritative. This task does not normalize events or assign behavioral labels.

## 3. Required operator behavior

Add one single-entry command:

```text
ebo agent-sdk run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
```

Add one thin export command over the existing export API:

```text
ebo export create <run-bundle-root> <policy.json> <export-root>
```

The run command executes exactly one queue entry. It does not iterate the queue, retry, resume, parallelize, or select models. It writes the bundle under `<output-root>/<run-id>/<attempt-id>`; an existing attempt destination is never replaced.

On success, print a small JSON result containing:

- run ID, attempt ID, and bundle path;
- assessment mode;
- terminal state and attempt classification;
- capture qualification status;
- native session ID and trace ID when present.

A task failure, policy/budget stop, or captured infrastructure failure is a successfully recorded observation. Return success when a structurally valid final run manifest was retained, and represent the outcome in the JSON result. Return nonzero only when inputs cannot be qualified, the attempt cannot be started, or the retained output cannot be validated.

The export command must call `createPortableRunBundleExport`, perform its existing readback, print the export status and destination, and never modify the restricted source bundle.

## 4. Minimal Agent SDK configuration contract

Do not add a separate operator configuration file. The run queue already points to five digest-pinned configuration artifacts. Resolve and verify those references through the existing bundle resolver, then validate their JSON before starting the SDK.

Use one versioned discriminated contract, `ebo.agent-sdk-config/v1`, with these five records:

```json
{ "schemaVersion": "ebo.agent-sdk-config/v1", "kind": "model", "model": "sonnet" }
```

```json
{ "schemaVersion": "ebo.agent-sdk-config/v1", "kind": "harness", "adapter": "claude-agent-sdk" }
```

```json
{
  "schemaVersion": "ebo.agent-sdk-config/v1",
  "kind": "native-limits",
  "maxTurns": 8,
  "maxBudgetUsd": 1
}
```

```json
{
  "schemaVersion": "ebo.agent-sdk-config/v1",
  "kind": "native-tool-policy",
  "tools": ["Read", "Edit", "Bash"],
  "allowedTools": ["Read", "Edit", "Bash"],
  "disallowedTools": [],
  "permissionMode": "dontAsk"
}
```

```json
{
  "schemaVersion": "ebo.agent-sdk-config/v1",
  "kind": "capture-profile",
  "telemetry": {
    "endpoint": "http://127.0.0.1:4318",
    "protocol": "http/json",
    "exportIntervalMs": 1000,
    "logUserPrompts": false,
    "logToolDetails": false,
    "logToolContent": false,
    "logRawApiBodies": false
  }
}
```

Rules:

- The queue entry's model, harness, native-limits, native-tool-policy, and queue-level capture-profile references must resolve to the corresponding `kind`.
- Reject duplicate JSON keys, unknown fields, unsafe numbers, wrong kinds, digest mismatches, malformed UTF-8, and malformed JSON before launching the SDK.
- The model record's `model` must equal the queue entry's model ID, matching the existing capture invariant.
- The harness adapter must be `claude-agent-sdk`.
- `maxTurns` and `maxBudgetUsd` are optional positive limits. The queue's coordinator `maxWallClockMs` remains the outer wall-clock limit.
- Tool lists are arrays of unique nonempty strings. Preserve Agent SDK names; do not invent a common tool ontology.
- `bypassPermissions` is accepted only when `allowDangerouslySkipPermissions` is explicitly true, matching the existing executor safeguard.
- Telemetry content flags default to false. Credentials and environment overrides are never read from these JSON files; authentication stays in the process environment.
- A configured telemetry endpoint without a receipt checker remains explicit `not-checked` or missing receipt evidence. Do not claim collector receipt from a successful HTTP configuration alone.

One small schema or one focused validator is sufficient. Do not create a generic configuration framework or per-harness registry.

## 5. Single-run composition

Implement one production function used by the CLI. Its inputs should be ordinary resolved paths/IDs plus the already-supported optional query and telemetry-receipt callbacks for deterministic tests or embedded callers. Those callbacks are not CLI flags or serialized configuration. The function must perform the following sequence:

1. Read and validate the queue with the supplied bundle root.
2. Find exactly one entry by `runId`; reject missing or duplicate matches.
3. Recheck the entry's frozen task packet, freeze record, and all five configuration digests.
4. Resolve the admitted packet. Use only `agentInput.prompt` as the prompt; never expose `restricted` packet content to the model.
5. Materialize one disposable workspace from the frozen packet.
6. Before Agent SDK execution, copy that ready workspace once to a private temporary baseline using the Node filesystem API. This immutable baseline is the `startingWorkspacePath`; the materialized directory remains the SDK working directory.
7. Build `ClaudeAgentSdkConfiguration` from the prompt and the resolved model, native-limit, tool-policy, and capture-profile records.
8. Build the run-bundle definition from the queue entry and frozen packet identities. Attempt number is 1; a later retry is a separate future invocation, not part of this command.
9. Call `captureClaudeAgentSdkRun` once. Its workspace coordinator returns the already-materialized live workspace. Its cleanup delegates to the existing materialization cleanup after the capture function has retained the final workspace outcome.
10. For a verified packet only, supply a verifier callback that calls `executeVerifier` with the packet's digest-pinned restricted verifier, captured workspace descriptor and fingerprint, and a diagnostic root inside the run bundle. For an observational packet, supply no verifier callback and retain no verifier artifact.
11. Keep the baseline until `captureClaudeAgentSdkRun` finishes qualification, then remove it in `finally`. Clean the disposable live workspace through the existing cleanup API. Never delete the retained run bundle.
12. Reopen and validate the final manifest before reporting success.

Preflight failures—invalid queue/configuration, changed freeze evidence, or failed materialization—occur before an Agent SDK attempt starts and must not fabricate a run bundle. Once capture starts, retain the complete or partial attempt evidence produced by the existing lifecycle and assembler.

Use the existing SDK/CLI capability probe. Do not accept runtime versions from operator JSON or read private Claude session files.

## 6. Identity and digest mapping

The runner must preserve existing identities rather than inventing a second scheduling model:

- `run.id`: queue entry `runId`;
- `run.task.id`: queue task condition ID;
- `run.fixture.digest`: the frozen fixture archive digest;
- `run.model.id`: resolved Agent SDK model, which must match the queue model ID;
- `run.harness.id`: queue harness ID, which must identify the Agent SDK condition;
- `attempt.id`: a new UUID safe for existing lifecycle/workspace contracts;
- `attempt.number`: 1;
- `bundleId`: the attempt ID or a deterministic prefix plus that ID;
- assessment mode: the packet's exact observational or verified declaration;
- verifier identity for verified tasks: the packet's exact restricted verifier locator, digest, and inferred module format;
- `configuration.digest`: a canonical digest over the resolved model, harness, and capture-profile references;
- `configuration.budgetDigest`: native-limits reference digest;
- `configuration.toolPolicyDigest`: native-tool-policy reference digest.

The retained Agent SDK/CLI versions, effective settings, capabilities, usage,
session identity, telemetry state, workspace outcome, optional verified-task
result, and qualification remain produced by the existing capture path.

## 7. Failure and cleanup semantics

- Never silently retry an Agent SDK attempt.
- Never replace an existing attempt directory or source bundle.
- Preserve a partial bundle after interruption, Agent SDK transport failure, optional verifier error, or missing telemetry receipt whenever the existing capture path can finalize it.
- Do not convert a verifier execution error into task failure.
- Do not convert missing capture evidence into a model outcome.
- Do not keep a mutable workspace merely to make later export or analysis work; the run bundle is the retained evidence.
- If cleanup fails after a valid workspace outcome is captured, retain the bundle and report the lifecycle's cleanup classification.
- Never print tokens, environment values, prompts, tool bodies, or restricted verifier content in the CLI summary.

## 8. Tests

### Deterministic tests

Use the actual frozen packet, queue, materializer, capture function, bundle validator, exporter, and corpus validator. Exercise the verifier executor only for verified fixtures. Inject the already-supported Agent SDK query seam only to avoid network access.

Cover at least:

1. An observational queue entry modifies its materialized workspace, retains an applicable workspace patch or reproducible snapshot, and produces a qualified or qualified-with-explicit-telemetry-gap bundle without verifier evidence.
2. A verified queue entry preserves the existing verifier-backed pass/fail path.
3. An invalid or wrong-kind configuration fails before query invocation and leaves no fabricated attempt bundle.
4. A verifier assertion failure produces a retained task-failure bundle; a verifier crash produces verifier-error instead.
5. An interrupted SDK run retains a readable partial bundle and does not retry.
6. A second invocation cannot replace an existing attempt destination.
7. `ebo export create` turns the real produced bundle into a policy-validated derivative, and corpus validation accepts the resulting source/export pair.

Do not recreate queue, workspace, verifier, export, or corpus behavior in mocks. The fake query may emit SDK messages and mutate only the supplied SDK working directory; everything around it must be production code.

### Opt-in live proof

Add an opt-in live test beyond the current trivial confidence boundary. It must invoke the new production runner rather than `captureClaudeAgentSdkRun` directly.

The live fixture must be a small frozen task packet whose prompt requires at
least one Agent SDK tool operation. It may use either assessment mode, but an
observational proof must not add a dummy verifier. Bound it with a low turn
limit, wall-clock limit, and dollar budget. Run it only when explicitly enabled
and authenticated through `CLAUDE_CODE_OAUTH_TOKEN`, with `ANTHROPIC_API_KEY`
and `ANTHROPIC_AUTH_TOKEN` unset.

Before cleanup, assert:

- a nonempty native session stream with a result identity;
- at least one retained tool-related SDK message or lifecycle hook;
- a retained final workspace outcome;
- the declared assessment mode and any mode-appropriate verifier evidence;
- a structurally valid final manifest and explicit qualification result;
- portable export creation/readback and corpus validation over this actual run.

If the test owns a local bounded OTLP receiver, also assert correlated receipt. Otherwise accept `qualified-with-gaps` only when the sole relevant gap is explicitly missing/not-checked telemetry receipt. Do not add a production telemetry backend solely for this test.

## 9. Acceptance criteria

- [ ] A fresh operator can execute one frozen queue entry through the Agent SDK with the documented command and no bespoke TypeScript caller.
- [ ] The command resolves and digest-verifies the task packet plus every configuration input before SDK launch.
- [ ] The Agent SDK receives only the admitted prompt and disposable workspace; observational packets contain no reference/verifier artifacts and verified packet artifacts remain outside the model-visible surface.
- [ ] The starting baseline survives until workspace capture and qualification finish, while the SDK mutates only the disposable live workspace.
- [ ] Observational completion is explicitly unscored; verified tasks preserve verifier-backed pass/fail bound to retained workspace evidence.
- [ ] Complete, failed, stopped, interrupted, and verifier-error attempts retain the existing terminal/capture semantics without silent retry.
- [ ] The final CLI summary identifies the bundle and outcome without leaking captured content or credentials.
- [ ] The export command creates and revalidates a separate portable derivative through the existing export implementation.
- [ ] Deterministic coverage exercises the production queue-to-corpus path without mocking the components being integrated.
- [ ] An opt-in OAuth test proves a real tool-using Agent SDK trajectory through the same runner, export, and corpus path without requiring a dummy verifier.
- [ ] The full existing test suite remains green, no runtime dependency is added, and task/run/export records carry only the one explicit assessment-mode discriminator required for these semantics.

## 10. Explicit non-goals

Do not add:

- whole-queue execution, concurrency, automatic retries, resume, or a distributed scheduler;
- cross-harness adapters, uniform event normalization, semantic evaluation, or Atlas work;
- a dynamic adapter/plugin registry or universal runner abstraction;
- a custom telemetry backend or hosted service;
- a second task-packet, queue, run-bundle, verifier, export, or corpus format;
- a database, daemon, API server, UI, or Python shim;
- auth-token loading from configuration files.

The implementation should primarily compose existing modules. If a proposed helper is not necessary to make the two commands or their tests work, omit it.

## 11. Delivery and verification

Base implementation work on `develop`, use a semantic branch name, and target the pull request back to `develop`. Do not edit the separate planning package or depend on Linear access.

After the final edit, run with Node 24.19.0:

```sh
npm ci
npm run build
npm run typecheck
npm test
node dist/src/cli.js --help
git diff --check
```

Also run the deterministic queue-to-corpus integration test. Run the live OAuth proof only when explicitly enabled and credentials are available; report it separately from the always-on suite.
