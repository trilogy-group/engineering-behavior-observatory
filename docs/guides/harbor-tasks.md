# Capture a Harbor task

Harbor is the task format for new containerized studies. Its `Trial` owns the
environment, effective instructions, step setup, verification and cleanup.
EBO adds admission, frozen experiment conditions and native harness capture.
Existing task-packet/v1 studies and their commands remain readable and unchanged.

## Install the control runtime

Use the source checkout until this feature is released. EBO still runs on Node
24.19.0. Install the separate, pinned Harbor control runtime with Python 3.12+:

```sh
python3 -m venv .harbor-venv
.harbor-venv/bin/pip install harbor==0.23.0
export EBO_HARBOR_PYTHON="$PWD/.harbor-venv/bin/python"
ebo harbor doctor
```

Start Docker. There is no host-execution fallback. `local-fs-test` supports
preparation tests only; `ebo harbor run` rejects it.

## Prepare, review and freeze

An ordinary Harbor task has `task.toml`, `instruction.md` and `environment/`.
Use task schema **1.4**. A Dockerfile must set a working directory such as
`/workspace`; the agent changes that directory inside the container, not a
lookalike host copy. Multi-step tasks use `[[steps]]` and
`steps/<name>/instruction.md`. Harbor composes shared and per-step instructions.

```sh
ebo harbor inspect path/to/task
ebo harbor prepare study path/to/task --mode observational
```

Preparation returns a content-derived task-source ID and writes a proposal to
`study/governance/admissions/harbor/<id>.proposed.json`. Review the task,
Docker build context, effective instructions, provenance and sharing policy.
Create `study/governance/reviews/harbor/<id>.json` using the proposal's
`preAdmissionDigest` (also available through `preAdmissionDigestOf`):

```json
{
  "schemaVersion": "ebo.harbor-review/v1",
  "taskSourceId": "<id>",
  "preAdmissionDigest": {"algorithm": "sha256", "value": "<proposal digest>"},
  "decision": "admitted",
  "reviewedAt": "<ISO timestamp>",
  "reviewedBy": "<reviewer>"
}
```

```sh
ebo harbor admit study <id>
ebo harbor freeze study <id>
ebo harbor status study <id>
```

Preparing or compiling a queue does not grant review approval. Changed content
needs a new identity, review and freeze. An observational task has no verifier
requirement. For verified tasks, Harbor owns `tests/`, reward parsing and
`verifier.environment_mode`. Use `separate` with declared `artifacts` when the
verifier needs an independent container. Missing rewards remain missing; a
recorded reward of zero is not treated as missing.

## Pin the container worker

The host Python extension launches an EBO **TypeScript worker inside Harbor's
environment**. SDK tools and subprocesses therefore see its actual filesystem.
Python carries control messages only; it does not capture or normalize sessions.

Verified multi-step tasks require a separate verifier environment for every
step. Harbor 0.23.0 leaves shared-verifier tests in the agent environment until
the next verification phase, where a later candidate step could read them.
EBO rejects that configuration during admission rather than changing the task.
Single-step shared verification retains its weaker, candidate-modified trust
boundary; it is not independent grading.

```sh
npm run build
node scripts/build-harbor-runtime.mjs study/config/runtime
```

The builder installs Linux dependencies in Node 24.19.0/bookworm and produces
`worker.tgz`. Keep it outside the task. The task image must have compatible Linux
architecture, glibc and the system tools needed by its harness. A macOS runtime
or Alpine/musl image is not interchangeable with this archive.

Save a runtime profile in the study and reference it by its SHA-256 digest:

```json
{
  "schemaVersion": "ebo.harbor-worker-runtime/v1",
  "archive": {"locator": "config/runtime/worker.tgz", "digest": {"algorithm": "sha256", "value": "<archive digest>"}},
  "node": "node",
  "entrypoint": "dist/src/harbor/worker.js",
  "environmentKeys": ["ZAI_API_KEY"]
}
```

Only explicitly listed credential/route variables enter the worker. Values are
not written to the runtime profile. `resources` may list additional digest-pinned
configuration files needed by a harness. Paths in those configurations refer to
the **container**, where the runtime lives at `/tmp/ebo-worker` and selected
configuration files at `/tmp/ebo-worker/config/<locator>`.

| Harness | Container prerequisite | Native execution |
| --- | --- | --- |
| Claude Agent SDK | SDK archive and authorized route | Direct SDK query, hooks and session capture |
| Pi | SDK archive and selected provider key | Fresh Pi session, native tools and persistence |
| Cursor | SDK archive, `CURSOR_API_KEY`, required local system tools | Direct SDK, HTTP/1.1 and native recovery |
| Codex | Pinned Linux app-server executable declared in harness config | Owned stdio child; no host daemon |
| DeepSeek Harness | Named Linux runtime/plugin composition and its installed runtime | Official TypeScript JSON-RPC client |
| OpenHands | Pinned Agent Server started inside the task container | Loopback REST/WebSocket, same working directory |

The generic archive includes EBO's npm dependencies, not external Codex,
DeepSeek or OpenHands executables. Install those in the task's runtime image or
a pinned operator runtime. For OpenHands, an image entrypoint can start the
server before executing Harbor's command; do not point it at a host server.
Native configuration and version checks still apply. Runtime availability is
separate from capture support; deterministic coverage is not provider entitlement.

## Compile and run

Use `ebo.experiment/v2`. Its `taskSet` entry is
`{"kind":"harbor-task","taskSourceId":"<id>"}`. Model, harness,
native-limit, tool-policy and capture-profile references retain their existing
source-specific formats for Claude, Codex, Cursor and Pi. OpenHands and DeepSeek
use their native harness configuration, a model reference containing
`{"model":"<native model>","provider":"<provider>"}`, and a tool-policy reference
`{"source":"harness"}`. Their native tools and policies belong to the pinned
conversation request or runtime composition, not a second EBO tool schema.

For OpenHands, the limits record accepts `timeoutMs`, `pollIntervalMs`,
`maxReconnects`, `reconnectDelayMs`, `maxResponseBytes` and `maxCaptureBytes`.
For DeepSeek it accepts `requestTimeoutMs`, `activityTimeoutMs`,
`shutdownTimeoutMs`, `disposeEofGraceMs` and `disposeGraceMs`. Values are positive
integers; `{}` uses the native defaults. Their capture profile accepts
`workspaceOutcome` with the existing exclusion and gitignore settings.
Unsupported fields are rejected. Native telemetry gaps remain explicit, including
Claude collector receipts that have not been independently checked.

Add the container execution policy:

```json
{
  "execution": {
    "environmentProfile": "docker",
    "contextPolicy": "fresh",
    "workerRef": {"locator": "config/runtime.json", "digest": {"algorithm": "sha256", "value": "<profile digest>"}}
  }
}
```

```sh
ebo harbor compile study experiment.json queue.json
ebo harbor run study queue.json <run-id> runs
```

The queue selects the harness. One entry creates one attempt, with no replacement
attempts or EBO retry loop. Each step gets a fresh native conversation and shares
the Harbor workspace. The overall wall-clock budget does not reset between steps.
Resume and imported trajectories fail preflight rather than silently changing
the experiment.

## Inspect and evaluate

The returned `bundlePath` contains:

- `harbor/trials/<attempt>/`: official lock, configuration, result, logs and
  verifier artifacts.
- `steps/<n>/bundle/`: ordinary EBO native run bundles, including each step's
  pre-verifier workspace patch and capture report.
- `steps/<n>/worker-finished.json`: native terminal and qualification summary.
- `ebo/manifest.json`: links among task, condition, trial, steps and Harbor result.

Each step bundle includes a restricted `harbor-result.json` diagnostic so its
provenance remains reachable through corpus inspection and portable export.
Step-specific fixture identities prevent comparisons from pooling different
steps as repetitions. Use these ordinary step bundles with the existing
[evidence/export](evidence-and-sharing.md) and [Behavior Atlas](atlas.md) commands.
The Harbor trial summary is not itself a native run bundle or a quality score.

Native step bundles capture execution in observational mode, including when
Harbor verifies the task afterward. The attached Harbor result retains the
frozen task's assessment mode and original rewards. Corpus indexing reads that
bound result as `assessmentMode` and keeps the child's mode as
`captureAssessmentMode`, for both retained bundles and portable exports. EBO
does not translate Harbor rewards into an invented pass/fail verifier result.

Interrupted attempts retain available files and explicit gaps. If Docker itself
becomes unreachable, environment cleanup and evidence download can fail; inspect
the retained control logs and trial directory before retrying with a new ID.

## Convert an existing task packet

```sh
ebo harbor convert-legacy study packets/task.json --image node:24.19.0-bookworm-slim
```

The converter uses EBO's existing admitted-archive materializer. It copies only
agent-visible files, preserves the prompt and writes a new, unadmitted task plus
an external `.conversion.json` report. It never modifies the packet or freeze.
Review the image and setup assumptions. Verified packets require manual verifier
and optional solution adaptation; conversion does not invent rewards or approval.

Windows, GPU/TPU environments, MCP services and multi-service Compose tasks are
classified as unsupported by this initial profile. The official Harbor validator
remains responsible for task-format validity.
