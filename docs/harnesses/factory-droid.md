# Factory Droid

EBO captures Factory Droid through the official TypeScript SDK and an owned
`droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc` child.
The SDK controls the session. EBO records native frames before SDK validation,
then derives uniform events and behavioral observations from the retained stream.

## Install and authenticate

EBO pins **`@factory/droid-sdk` 0.9.1** and **Droid CLI 0.238.0** separately.
The SDK is an EBO dependency. Install the CLI in a dedicated runtime directory:

```sh
npm install --prefix "$PWD/factory-runtime" --save-exact @factory/cli@0.238.0
"$PWD/factory-runtime/node_modules/.bin/droid" --version
```

The output must be `0.238.0`. Use the executable's absolute path in the frozen
harness configuration. EBO probes the version before capture, records the
executable digest, and disables the standalone updater in the child environment.
The npm distribution also disables its updater. Run install scripts so the npm
launcher resolves to the platform binary rather than a JavaScript shim.

Supply `FACTORY_API_KEY` through your runtime's secret mechanism. A model record
can name a different `credentialEnv`; EBO forwards its value as `FACTORY_API_KEY`.
EBO records the credential variable name and supplies its value to the child
environment. Native evidence is restricted; portable export sanitizes it.
Use a Factory-managed model ID with a supported reasoning effort. The provider
label records provenance; it does not select an arbitrary provider endpoint.
BYOK settings and additional provider credentials need separate qualification.

## Freeze the condition

Each record below belongs in a separate JSON file, referenced by digest from the
experiment. See [packet preparation](../guides/operator-guide.md) and
[Harbor tasks](../guides/harbor-tasks.md) for admission and queue compilation.
The files under `examples/factory/` are configuration templates.

```json
{"schemaVersion":"ebo.factory-config/v1","kind":"model","provider":"factory","model":"<Factory model ID>","reasoningEffort":"low","credentialEnv":"FACTORY_API_KEY"}
```

```json
{"schemaVersion":"ebo.factory-config/v1","kind":"harness","adapter":"factory-droid","executable":"<absolute Droid binary path>","version":"0.238.0","sdkVersion":"0.9.1","contractDigest":"<adapter contract digest>"}
```

Obtain the contract digest from the installed EBO package:

```sh
node --input-type=module -e 'import {FACTORY_CONTRACT_DIGEST} from "engineering-behavior-observatory"; console.log(FACTORY_CONTRACT_DIGEST)'
```

From a built source checkout, import `./dist/src/index.js` instead.

```json
{"schemaVersion":"ebo.factory-config/v1","kind":"native-limits","shutdownGraceMs":2000}
```

```json
{"schemaVersion":"ebo.factory-config/v1","kind":"native-tool-policy","autonomyLevel":"off","permissionDecision":"proceed_once"}
```

```json
{"schemaVersion":"ebo.factory-config/v1","kind":"capture-profile","workspaceOutcome":{"excludeDirectoryNames":["node_modules"]}}
```

`autonomyLevel` accepts `off`, `low`, `medium`, or `high`. The unattended client
answers permission requests using `proceed_once` or `cancel`; requests and
responses remain native evidence. Questions to the user receive a cancellation.
EBO selects the SDK's `auto` interaction mode and preserves Factory's default
system prompt. Mission mode is a separate, unsupported condition.

EBO rejects unknown configuration fields and checks the effective model,
reasoning effort, autonomy level, and interaction mode before submitting the
prompt. Repository instructions, hooks, skills, and project settings remain part
of the task workspace. Freeze them with the task and inspect changes in the
workspace outcome. Personal settings and hooks are isolated in an attempt-owned
home that is removed after capture. SDK execution needs an OS/VM boundary when
candidate tools require containment.

## Execute and inspect

```sh
ebo factory run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
ebo observations create <run-bundle-root> <observations.json>
```

The runner executes one frozen entry. Repeated attempts receive different
identities and paths; existing attempts are never replaced. Library callers can
use `captureFactoryDroidRun`, or `captureFactoryDroid` for the native capture
boundary. Both accept an abort signal. SIGINT/SIGTERM in the CLI requests native
interruption, drains evidence within bounded shutdown windows, then terminates
the owned child if needed.

Retained files include:

| File | Evidence |
| --- | --- |
| `session.jsonl` | Raw inbound frames, exact outbound frames, native runtime composition, process outcome, malformed frame diagnostics |
| `telemetry/factory.json` | SDK/CLI/protocol/adapter pins, executable digest, effective settings, environment key names, bounded stderr, explicit OTLP receipt state |
| `workspace.patch` | Independent workspace outcome |
| `capture/` | Capture qualification, missing evidence and lifecycle records |
| `manifest.json` | Attempt identity, terminal classification and digested evidence descriptors |

Completion requires `agent_turn_completed` for the initialized session and the
outbound `droid.add_user_message.params.messageId`, corroborated by the SDK
result. Foreign traffic remains retained without ending or populating the owned
SDK session. EOF, process exit, idle state and enqueue acknowledgements do not
establish completion. Native rejection, cancellation, provider failure and
persistence failure reasons remain inspectable independently of task quality.

Readback checks runtime composition, manifest pins, ordered owned initialization
and prompt identities, and terminal ownership before normalization. Unknown
notifications remain resolvable unmapped records. Failed or interrupted attempts
retain their partial stream and workspace; capture corruption is reported as a
gap and may prevent behavioral analysis.

## Evidence coverage and accounting

- Messages: the outbound prompt and completed assistant messages. Partial text
  is projected when its message has no completed native record.
- Tools: native `tool_call` and `tool_result` identities bind calls and results.
  Repeated copies do not increase counts. Hook execution stays native evidence.
- Context: explicit settings, compaction, retry and session usage snapshots.
- Permissions: native client requests and responses; exposed resolution events.
- Delegation: exposed child IDs and tool relationships. Complete child histories
  and local persistence files are not fetched.
- Usage: the owned terminal's turn usage is the attempt total, inclusive of child
  work. Cumulative session snapshots and child contributions remain available
  natively; they are not added again. Factory credits retain their own unit.
- Validation: explicit verifier evidence only. Tool names and shell commands do
  not establish validation success.

Model-request internals are unsupported through this semantic boundary. Native
OTLP is not collected in this integration; receipt is `not-checked`. EBO supplies
no customer collector endpoint, requests content logging off, and requests
aggregate telemetry granularity. Organization-managed policy and Factory's own
metrics are separate controls. A normally completed bundle can therefore be
`qualified-with-gaps` for telemetry and child history.

Portable export and evaluator-visible evidence remove thinking deltas, thinking
blocks, provider signatures and encrypted reasoning fields. Exports omit raw
Factory frame copies and sanitize their parsed payloads. A final readback scan
rejects private content. Restricted source bundles retain native evidence.

## Harbor

Use harness ID `factory-droid` with the same five digest-pinned configuration
records. `createFactoryHarborExecutor` and the worker's explicit dispatch execute
the shared capture core in Harbor's task filesystem. Each step creates a fresh
native session; cross-step resume is unsupported. Harbor owns task setup and
verification after capture has drained.

Build the Linux runtime with the pinned Factory CLI included:

```sh
node scripts/build-harbor-runtime.mjs .ebo/harbor-runtime --factory
```

Use `/opt/ebo/factory-cli/node_modules/.bin/droid` in the guest harness record.
Declare `FACTORY_API_KEY` (or the selected credential variable) in the worker
runtime's `environmentKeys`. The builder archives the CLI's npm lockfile and
platform binary with the SDK worker. Follow the [runtime image and Smol binding
instructions](../guides/harbor-tasks.md#build-and-pin-the-guest-runtime); the
archive, guest image and model configuration are distinct frozen inputs.

## Verification status

Deterministic tests use the actual SDK 0.9.1 against a fixture subprocess. They
cover raw recording, settings, tools, permissions, unknown notifications,
foreign/absent/duplicate terminals, failure, interruption, retained analysis,
sanitization, packet execution and Harbor worker dispatch. They make no model
calls and do not establish live CLI/provider or Smol VM compatibility.

A live smoke is opt-in. Supply the pinned CLI, authorized credentials and model
through the variables documented in `test/factory-droid.test.ts`, then run its
live test. Inspect a real tool action, workspace change, owned terminal,
qualification and sanitized readback. Repeat inside the pinned Harbor guest
before treating a provider/image combination as live-qualified.

Upstream contracts: [TypeScript SDK](https://docs.factory.com/sdk/typescript),
[Droid Exec](https://docs.factory.com/droid-exec/overview),
[settings](https://docs.factory.com/droid-cli/settings),
[telemetry privacy](https://docs.factory.com/enterprise/telemetry/privacy).
