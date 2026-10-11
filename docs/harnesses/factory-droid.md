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

Select a managed route or a BYOK route in the frozen model record. Managed
routes use `FACTORY_API_KEY`; BYOK defaults to `FIREWORKS_API_KEY`. Either can
name a different `credentialEnv`. EBO copies only that credential into the
isolated child: managed credentials become `FACTORY_API_KEY`, and BYOK
credentials become `EBO_FACTORY_BYOK_API_KEY`. BYOK does not require a Factory
credential. Personal login state and custom models are not imported.

EBO records environment variable names and secret-free model selection. Native
evidence is restricted; portable export sanitizes it. Inject credentials through
your runtime's secret mechanism. Keep credential values out of model records,
URLs, task files and provider arguments.

## Freeze the condition

Each record below belongs in a separate JSON file, referenced by digest from the
experiment. See [packet preparation](../guides/operator-guide.md) and
[Harbor tasks](../guides/harbor-tasks.md) for admission and queue compilation.
The files under `examples/factory/` are configuration templates.

```json
{"schemaVersion":"ebo.factory-config/v1","kind":"model","provider":"factory","model":"<Factory model ID>","reasoningEffort":"low","credentialEnv":"FACTORY_API_KEY"}
```

For Fireworks BYOK, freeze this model record instead:

```json
{
  "schemaVersion": "ebo.factory-config/v1",
  "kind": "model",
  "provider": "fireworks",
  "model": "accounts/fireworks/models/glm-5p3-flash",
  "reasoningEffort": "low",
  "credentialEnv": "FIREWORKS_API_KEY",
  "route": {
    "kind": "byok",
    "provider": "generic-chat-completion-api",
    "baseUrl": "https://api.fireworks.ai/inference/v1",
    "maxOutputTokens": 4096
  }
}
```

The `model` field names the upstream API model. EBO generates the native
selector `custom:ebo-byok` and one custom-model definition inside the temporary
home, using an environment reference for its API key. EBO passes this file through
Droid's `--settings` override, so repository custom-model definitions cannot
replace the frozen route. Retained readback requires that override provenance
for BYOK captures. `route.kind` can also be
`factory-managed`; omitting `route` selects that default. Managed GLM uses
`model: "glm-5.3-flash"`. The `provider` label records provenance; the explicit
route controls dispatch. The same harness supports both arms.

BYOK currently supports the Chat Completions dialect with
`provider: "generic-chat-completion-api"`. The route requires an absolute
HTTP(S) `baseUrl` without credentials, query or fragment, and a positive
`maxOutputTokens`. Optional `extraArgs` accepts `temperature` (0–2), `top_p`
(0–1, exclusive of zero), `reasoning_effort` (`none`, `low`, `medium`, `high`,
`max`), and `thinking: {"type":"enabled"}` or `{"type":"disabled"}`. Unknown
fields and dispatch overrides are rejected. Freeze provider reasoning arguments
separately from the SDK's `reasoningEffort`; their effect needs provider validation.

For matched comparisons, hold the SDK/CLI, task, prompts, tools, autonomy and
budgets constant. Record both model IDs, route and effective settings. Compare
Factory consumption and Fireworks charges separately. Matching model names does
not establish identical serving configurations. Qualify tool calls, reasoning,
compaction and any auxiliary routing for the selected provider before a study.
Factory's published plan allowances are a commercial policy separate from EBO's
credential-free Factory BYOK launch path; consult [current pricing](https://factory.com/pricing).

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
Declined permissions end the attempt as interrupted, retaining the native
`permission_rejected` reason.
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
Workspace snapshots and bundle finalization wait for the native capture producer
to stop before recording final state or hashing its stream, including when a
coordinator shutdown deadline expires.

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
and prompt identities, and terminal ownership before normalization. BYOK readback
also checks the upstream ID, native custom selector, route, and effective model
against the recorded runtime composition and native initialization. Unknown
notifications remain resolvable unmapped records. Failed or interrupted attempts
retain their partial stream and workspace; capture corruption is reported as a
gap and may prevent behavioral analysis.

Retained bundles also supply Atlas message/tool units and
[human review packets](../evaluation/human-calibration.md). Atlas includes the
outbound prompt and completed assistant messages. Human packets preserve exact
native citations within their restricted local evidence boundary.

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
Declare `FACTORY_API_KEY` for managed models or `FIREWORKS_API_KEY` for BYOK
(or the selected credential variable) in the worker
runtime's `environmentKeys`. The builder archives the CLI's npm lockfile and
platform binary with the SDK worker. Follow the [runtime image and Smol binding
instructions](../guides/harbor-tasks.md#build-and-pin-the-guest-runtime); the
archive, guest image and model configuration are distinct frozen inputs.

## Verification and live qualification

Deterministic tests use the actual SDK 0.9.1 against a fixture subprocess. They
cover managed/BYOK configuration, credential isolation, raw recording, settings,
tools, permissions, unknown notifications, foreign/absent/duplicate terminals,
failure, interruption, retained route tampering, sanitization, packet execution
and Harbor worker dispatch. They make no provider calls.

An optional native check uses the pinned Droid binary against a local mock
Chat Completions server through EBO. It exercises a native file tool, retained
readback and export without a Factory credential:

```sh
npm run build
EBO_NATIVE_FACTORY_EXECUTABLE="$PWD/factory-runtime/node_modules/.bin/droid" \
  node --test --test-name-pattern='pinned native Factory BYOK' dist/test/factory-droid.test.js
```

For a live Fireworks smoke, inject `FIREWORKS_API_KEY` through your secret
mechanism. BYOK uses the same native Droid child, SDK recording, retained
analysis and export path. This check requires provider access and credit;
Factory login, a paid Factory plan and `FACTORY_API_KEY` are unnecessary for
the pinned BYOK runtime:

```sh
EBO_LIVE_FACTORY_CAPTURE_SMOKE=1 EBO_LIVE_FACTORY_ROUTE=byok \
EBO_LIVE_FACTORY_EXECUTABLE="$PWD/factory-runtime/node_modules/.bin/droid" \
EBO_LIVE_FACTORY_MODEL=accounts/fireworks/models/glm-5p3-flash \
EBO_LIVE_FACTORY_EFFORT=low \
  node --test --test-name-pattern='live Factory CLI' dist/test/factory-droid.test.js
```

For a Factory-hosted inference check, use `EBO_LIVE_FACTORY_ROUTE=managed`,
`EBO_LIVE_FACTORY_MODEL=glm-5.3-flash`, and inject `FACTORY_API_KEY`.
The live smoke retains its evidence path and checks a real tool action, workspace
change, owned terminal, retained analysis and sanitized export. The Fireworks
GLM-5.3-Flash smoke passed with Droid 0.238.0 and SDK 0.9.1 without Factory
credentials. A Factory-hosted versus BYOK benchmark is a separate study.

The separate VM check requires the [qualified Smol host and guest runtime](../guides/harbor-tasks.md#build-and-pin-the-guest-runtime).
Build with `--factory`, then bind the runtime archive, `image-build.json`, a
registry-accessible Linux ARM64 execution-image digest, and the bundled libkrun
digest. Set `EBO_HARBOR_PYTHON`, `EBO_HARBOR_RUNTIME`, `EBO_SMOL_IMAGE`, and
`EBO_SMOL_LIBKRUN_SHA256`. With the selected model and credential supplied:

```sh
EBO_LIVE_FACTORY_SMOL=1 EBO_LIVE_FACTORY_ROUTE=byok \
EBO_LIVE_FACTORY_MODEL=accounts/fireworks/models/glm-5p3-flash \
  node --test dist/test/factory-smol-live.test.js
```

This creates one synthetic verified task and checks native capture, retained
analysis, sanitized export and VM-owner cleanup. Qualify each selected live
provider/image combination before a study. The deterministic release gate
excludes live inference tests.

Upstream contracts: [TypeScript SDK](https://docs.factory.com/sdk/typescript),
[Droid Exec](https://docs.factory.com/droid-exec/overview),
[BYOK](https://docs.factory.com/model-independence/byok),
[settings](https://docs.factory.com/droid-cli/settings),
[telemetry privacy](https://docs.factory.com/enterprise/telemetry/privacy).
