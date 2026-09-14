# Harbor execution boundary

Harbor 0.22.0 owns task schema 1.4, content hashing, instruction composition,
task setup, multi-step policy, verification, locks and cleanup. Smol Python SDK
1.15.0 supplies the microVM provider, using an isolated patched libkrun on Apple
Silicon. EBO owns study
governance and source-native trajectory capture. The boundary is an official
Harbor `BaseAgent` extension launched by `Trial.create`, not a copy of its loop.

The TypeScript worker runs inside the task environment. A host SDK pointed at a
downloaded workspace would bypass task setup, tools and isolation. A host-to-host
workspace copy is therefore not an execution mode. Each worker call invokes the
existing native capture core and drains it before Harbor verifies the result.

The implementation takes the useful Pi prototype admission and capture wrappers,
replaces its invalid environment calls and duplicated scheduler, and uses the
existing archive materializer for legacy conversion. It preserves the current
Cursor recovery/usage behavior and workspace projection fixes. The old packet
formats and captures are not rewritten.

The runtime archive is operator-controlled and digest-pinned. It keeps npm/Linux
packaging separate from task content and does not introduce a new SDK shim or
universal protocol. Native OpenHands/DeepSeek/Codex runtime installation remains
an explicit prerequisite, as it is outside Harbor tasks. Secrets enter through
selected environment keys; hidden verifier and solution files are never copied
by the worker.

## Verification

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run acceptance
node dist/src/cli.js harbor --help
git diff --check
```

The PR workflow checks the pinned Python model/provider contracts and native
worker tests. It does not claim VM qualification on a hosted Linux runner.
The live gate needs an approved registry-accessible arm64 execution image:

```sh
EBO_HARBOR_PYTHON="$PWD/.harbor-venv/bin/python" \
SMOLVM_LIB_DIR="/path/to/isolated-patched-libraries" \
EBO_HARBOR_RUNTIME=.ebo/smol-runtime/worker.tgz \
EBO_SMOL_IMAGE="<registry/execution-image@sha256:platform-digest>" \
EBO_SMOL_LIBKRUN_SHA256="<library digest>" \
node --test dist/test/harbor-smol-live.test.js
```

It uses the pinned Pi SDK and a local deterministic HTTP provider, with no paid
model calls. Cases exercise observational capture, separate verification,
threshold stopping, missing rewards and setup failure. The normal suite also
tests the real Pi worker on the host as a unit boundary. Host-only evidence does
not substitute for the Smol gate. Live-provider success is a separate operator
qualification; this migration does not assert that all providers were called.

## Shared preparation and failure boundaries

The foreground queue owner keeps live parents alive across independent Python
attempt processes. OS locks cover the owner and active borrowers; receipts are
evidence, not a substitute for those locks. The provider wrapper enforces exact
parent bindings and delegates branching, transfers and deletion to Smol. There
is no distributed lease service, custom scheduler or checkpoint distribution.

The image and runtime manifest is part of the experiment digest. Volatile parent
names are not. Harbor's parsed models produce an image-bound execution copy;
instructions, setup, verifier order and rewards remain Harbor-owned. The original
task digest and derived digest are both retained.

The disk-capacity patch passes the direct and separate-process Smol branching
gate. Public-egress image-backed execution still needs its full live gate.
No-network image import and allowlist/virtio-net are not qualified; the latter
crashed with SIGILL during a localhost-registry probe. Reject these policies
instead of substituting public egress. Harbor 0.23 and Smol 1.16 are deferred.

Native step bundles remain usable before behavioral assessment. Harbor rewards
are retained as source outcomes; structural extractors and judges do not inherit
them as invented semantic-quality labels.
