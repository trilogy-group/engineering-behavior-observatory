# Quickstart

**Goal:** install the `ebo` command, inspect a report, and know what is needed
to capture a real engineering task.

## Install from npm

Requires Node **24.19.0** and npm:

```sh
npm install -g engineering-behavior-observatory
ebo --help
```

For a one-off invocation:

```sh
npm exec --package=engineering-behavior-observatory -- ebo --help
```

The package name is `engineering-behavior-observatory` and the executable is
`ebo`. Avoid `npx ebo`, which targets another package. These installations
include the runtime and documentation. The synthetic demo below requires a
source checkout because its generator and test fixtures are not packaged.

## Install from source

Use Git, npm, and Node **24.19.0** (the repository's `.nvmrc` pin). If you use
nvm:

```sh
git clone https://github.com/trilogy-group/engineering-behavior-observatory.git
cd engineering-behavior-observatory
nvm install
nvm use
npm ci
npm run build
npm link
ebo --help
```

Repository access is required. `npm link` exposes the package's existing
`bin.ebo` entry; it does not create a different CLI. It links the current
checkout globally for the active Node installation. Keep the checkout and
rebuild after updates. If `ebo` is not found, check that `npm prefix -g`'s
`bin` directory is on PATH and that you selected the same Node installation.

To avoid a global link, use `npm run ebo -- --help` from the repository.
Replace `ebo` with `npm run ebo --` in later examples.

## Install from a release archive

Download the package and `SHA256SUMS` from a
[GitHub release](https://github.com/trilogy-group/engineering-behavior-observatory/releases).
For v0.2.1, from the download directory:

```sh
shasum -a 256 -c SHA256SUMS
npm install --global ./engineering-behavior-observatory-0.2.1.tgz
ebo --help
```

Use the release's pinned Node version. On systems without `shasum`, use
`sha256sum -c SHA256SUMS`. Installing the archive uses the exact bytes checked
against the release checksum.

A release archive includes compiled runtime code, schemas, and documentation.
The synthetic demo generator and test fixtures below require a source checkout.

## First look: no credentials or model calls

From the built source checkout:

```sh
node dist/test/atlas-fixture.js .ebo/first-look
ebo corpus validate .ebo/first-look/corpus .ebo/first-look/index.jsonl
ebo corpus query .ebo/first-look/index.jsonl
ebo atlas build .ebo/first-look/atlas.json .ebo/first-report
```

Open `.ebo/first-report/index.html` in your browser (on macOS,
`open .ebo/first-report/index.html`). No server is needed for the static report.

The data and reviewer decisions are **synthetic**, not model findings. Explore
a proposed assertion, its citation, its native record, and a missing-evidence
case. The fixture includes an unsupported comparison so you can see how it is
excluded. Repeating the demo requires new destination paths.

For interactive filtering:

```sh
ebo atlas serve .ebo/first-look/atlas.json
```

Open the printed loopback URL. Stop with Ctrl-C. See
[Atlas and Grafana](atlas.md) for dashboard setup.

## Capture a real task

A run consumes a frozen packet and queue. Prepare these inputs once per
experiment; task authorship remains outside the current CLI:

| Input | What you supply | Instructions |
| :--- | :--- | :--- |
| Task packet | Prompt, sanitized repository archive, provenance, allowed files, sharing class | [Packet contract](../reference/contracts.md#task-packets) |
| Admission record | Your human review, bound to the pre-admission packet digest | [Admission and freeze](../reference/contracts.md#admission-and-freeze) |
| Harness configuration | Model, runtime, limits, tool policy, capture profile; no credential values | [Harness guides](../harnesses/README.md) |
| Experiment | References and digests, condition IDs, trial count, ordering, wall-clock limit | [Experiment contract](../reference/contracts.md#experiments) |
| Authentication | An approved route for the chosen harness, supplied outside artifacts | Your harness guide |

Choose `assessmentMode: "observational"` for open-ended work such as a
refactor or UI redesign. There is no reference answer and no verifier to invent.
Review the source archive for credentials before admission. Run only code and
tools you trust, or provide real OS/container isolation.

Follow [operator steps 1–2](operator-guide.md#1-validate-admit-and-freeze-a-packet)
to validate, admit, freeze, and compile. Read an entry's `runId` from
`study/queue.json`; `queue inspect` prints a summary, not an entry list.

Once those inputs exist, this executes one Claude Agent SDK attempt:

```sh
ebo agent-sdk run study/bundle study/queue.json <run-id> study/runs
```

Use `ebo codex run`, `ebo cursor run`, or `ebo pi run` with the
corresponding source-specific queue. OpenHands and DeepSeek currently use
library capture APIs, not CLI run commands. Authentication and permitted tools
are harness-specific; do not reuse another harness's configuration.

## Inspect the result

The run prints a JSON summary with `bundlePath`, terminal/classification, and
capture qualification. Substitute that returned path below:

```sh
ebo validate <bundle-root>/manifest.json
ebo observations create <bundle-root> study/observations.json
ebo corpus build study/runs study/index.jsonl
ebo corpus query study/index.jsonl --assessment-mode observational
```

Schema validation alone is not capture qualification. Read the capture report
and missing-evidence reasons; observations revalidate the native source.
A stopped or failed attempt can be useful evidence. `completed` means the
agent loop ended, not that the stakeholder approved its work.

Continue with [evidence and sharing](evidence-and-sharing.md), or use
[the evaluation workflow](../evaluation/README.md) to construct judgments and
comparisons. Real Atlas reports need an explicit aggregation/Atlas request;
the synthetic demo's assertions and human decisions are not a template for
labeling your real runs.
