# Capture a Harbor task

Harbor is the task format for new isolated studies. Its `Trial` owns the
environment, effective instructions, step setup, verification and cleanup.
EBO adds admission, frozen experiment conditions and native harness capture.
Existing task-packet/v1 studies and their commands remain readable and unchanged.

## Install the control runtime

Use the source checkout until this feature is released. EBO still runs on Node
24.19.0. Install the separate control runtime with Python 3.14:

```sh
python3 -m venv .harbor-venv
.harbor-venv/bin/pip install 'smolmachines[harbor]==1.15.0' harbor==0.22.0
.harbor-venv/bin/pip check
export EBO_HARBOR_PYTHON="$PWD/.harbor-venv/bin/python"
export SMOLVM_LIB_DIR="/absolute/path/to/isolated-patched-libraries"
ebo harbor doctor
```

The current runtime profile targets Apple Silicon macOS with the isolated
libkrun disk-capacity patch. The environment manifest pins that library's
SHA-256. Do not replace system libraries. Smol 1.16 and Harbor 0.23 are deferred.
Docker is used only to build images, not to execute tasks or graders.
`local-fs-test` supports preparation tests only; old Docker queues remain
readable but must be explicitly recompiled as new Smol conditions to run.

## Prepare, review and freeze

An ordinary Harbor task has `task.toml`, `instruction.md` and `environment/`.
Use task schema **1.4**. Declare `environment.workdir`, such as
`/workspace`; the agent changes that directory inside the local VM, not a
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

## Build and pin the guest runtime

The host Python extension launches an EBO **TypeScript worker inside Harbor's
environment**. SDK tools and subprocesses therefore see its actual filesystem.
Python carries control messages only; it does not capture or normalize sessions.

Verified multi-step tasks require a separate verifier environment for every
step. Harbor 0.22.0 leaves shared-verifier tests in the agent environment until
the next verification phase, where a later candidate step could read them.
EBO rejects that configuration during admission rather than changing the task.
Single-step shared verification retains its weaker, candidate-modified trust
boundary; it is not independent grading.

```sh
npm run build
node scripts/build-harbor-runtime.mjs study/config/runtime \
  --base <public-runtime-base@sha256:platform-digest> \
  --image <registry/ebo-runtime:tag>
```

The builder installs Linux dependencies in Node 24.19.0/bookworm and produces
`worker.tgz` and a local execution image with the pack at `/opt/ebo`. It records
the build recipe, original startup settings and archive digest in `image-build.json`.
Publishing is a separate, explicit `docker push <registry/ebo-runtime:tag>`
operation. Use the resulting **linux/arm64 manifest digest**, not an index digest
or a daemon-local tag, in the environment bindings. Keep the pack outside the task.
The reusable runtime image must have compatible Linux
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
the **guest**, where the runtime lives at `/opt/ebo` and selected
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
DeepSeek or OpenHands executables. Install those in the reusable runtime image or
through frozen local setup. For OpenHands, an image entrypoint can start the
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

Save a `config/environments.json` manifest. Keys under `tasks` are the frozen
task-source IDs; grader keys are step names, or `single` for a single-step task.
Each image binding records `image`, `baseImageDigest` and `recipeDigest` from
the reusable runtime build. Task code does not need to enter a registry.
Use `localSetup` to prepare a private local parent from that image.

```json
{
  "schemaVersion": "ebo.smol-environments/v1",
  "platform": "linux/arm64",
  "runtimeArchiveDigest": "<worker.tgz SHA-256>",
  "libkrunSha256": "<isolated libkrun.dylib SHA-256>",
  "tasks": {
    "<task-source-id>": {
      "agent": {
        "image": "<registry/ebo-runtime@sha256:platform-digest>",
        "baseImageDigest": "<base image SHA-256>",
        "recipeDigest": "<build recipe SHA-256>",
        "localSetup": "setup.sh"
      },
      "graders": {}
    }
  }
}
```

### Private local task preparation

Put a repository snapshot and a setup script in the task's `environment/`
before admission and freezing. For example, with files under `environment/repo/`,
`environment/setup.sh` can contain:

```sh
set -eu
cp -R repo/. /workspace/
cd /workspace
npm ci --ignore-scripts
```

Choose dependency-install flags appropriate to the repository. Pin dependencies
and include required setup inputs in the frozen context. A snapshot avoids
needing repository credentials in the VM; if fetching public sources instead,
pin their revisions explicitly.

`localSetup` is relative to the role's frozen environment context. The owner
uploads that context locally and runs the script with `sh -eu`, with the
uploaded context as its working directory. It creates the declared task workdir
first. Setup runs once per parent, before any attempt branches; failure prevents
that parent from becoming ready. The temporary context is removed after success.
The setup exit code, output and script digest are retained as local evidence.
No Dockerfile instructions are interpreted or translated into shell commands.
When switching from a task-built image, explicitly move its installation/copy
steps into this script and review the new frozen task.

Separate grader bindings may use their own `localSetup`, relative to Harbor's
resolved grader build context. The agent receives only `environment/`, never
the task root, hidden solutions, or separate grader tests. Harbor's per-step
setup still runs in each attempt at its normal stage.

The public image contains runtime software only. Repository files, prepared
parents, branch disks and trajectories stay on this computer. Registry privacy
is relevant only if you choose a private runtime base; authenticated private
image pulls are not yet qualified with the pinned Smol SDK. Never put credentials
in frozen contexts, setup scripts or parent state. Harness credentials and
attempt configuration enter after branching through the worker profile.
Setup commands have the declared public egress, so their network activity must
also respect the repository's sharing policy.

Reference the environment manifest by digest in the execution policy:

```json
{
  "execution": {
    "environmentProfile": "smol",
    "contextPolicy": "fresh",
    "environmentRef": {"locator": "config/environments.json", "digest": {"algorithm": "sha256", "value": "<environment manifest digest>"}},
    "workerRef": {"locator": "config/runtime.json", "digest": {"algorithm": "sha256", "value": "<profile digest>"}}
  }
}
```

```sh
ebo harbor compile study experiment.json queue.json
# Terminal A: keep this foreground owner alive until all attempts finish.
ebo harbor environment serve study queue.json
# Terminal B: use the run IDs printed by compile (trialCount: 2 for two entries).
ebo harbor run study queue.json <first-run-id> runs
ebo harbor run study queue.json <second-run-id> runs
# Then Ctrl-C in terminal A to drain borrowers and delete the owned parents.
```

The queue selects the harness. One entry creates one attempt, with no replacement
attempts or EBO retry loop. Each step gets a fresh native conversation and shares
the Harbor workspace. The overall wall-clock budget does not reset between steps.
Resume and imported trajectories fail preflight rather than silently changing
the experiment.

The owner prepares one clean live parent per environment fingerprint. Attempts
branch from it through the official Smol provider, and receive credentials only
after branching. No agent warm-up or provider call runs in a parent. Image binding
creates a derived execution task and retains both content digests; the admitted
snapshot stays unchanged. Separate graders borrow distinct clean parents.

Receipts live under `study/runtime/smol/<queue-digest>/`. A stale ready file is
not sufficient: borrowers check the owner lock, queue, runtime and live parent.
Shutdown stops admission of branches and allows 60 seconds for active trials to
drain. A failed transfer or deletion records `cleanup-pending` and owned VM IDs;
recover those resources before removing the receipt or preparing again. The
SDK may stop local machines when their owning process exits, so withholding
deletion does not guarantee that a warm child remains recoverable. The runner
never turns a missing parent or a branch-chain limit into a cold attempt.
Drain and restart preparation if the runtime exhausts its branch chain.

This patched runtime currently accepts public egress only. No-network image
import is unqualified, and an explicit localhost allowlist caused a virtio-net
SIGILL during conformance. Such policies fail before creation rather than being
broadened. Host-expanded task environment variables, GPU/TPU, task MCP services,
Compose, Cloud and other platforms are also rejected. Worker credential keys
remain the supported injection path. The full image-backed trial gate must pass
before treating this integration as operationally qualified.

## Inspect and evaluate

The returned `bundlePath` contains:

- `harbor/trials/<attempt>/`: official lock, configuration, result, logs and
  verifier artifacts.
- `harbor/preparation.json`, `task-transformation.json`, `smol-events.jsonl`:
  parent bindings, original/derived task identity, branch timings and cleanup state.
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

Interrupted attempts retain available files and explicit gaps. If the VM
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
