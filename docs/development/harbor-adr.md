# Harbor execution boundary

Harbor 0.23.0 owns task schema 1.4, content hashing, instruction composition,
Docker setup, multi-step policy, verification, locks and cleanup. EBO owns study
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

The Docker conformance gate is explicit, not a silent prerequisite skip:
It also runs in the `Harbor conformance` pull-request workflow on Linux.

```sh
node scripts/build-harbor-runtime.mjs .ebo/harbor-runtime --fixtures
EBO_HARBOR_PYTHON="$PWD/.harbor-venv/bin/python" \
EBO_HARBOR_RUNTIME=.ebo/harbor-runtime/worker.tgz \
node --test dist/test/harbor-docker.test.js
```

It uses the pinned Pi SDK and a local deterministic HTTP provider, with no paid
model calls. Cases exercise observational capture, separate verification,
threshold stopping, missing rewards and setup failure. The normal suite also
tests the real Pi worker on the host as a unit boundary. Host-only evidence does
not substitute for the Docker gate. Live-provider success is a separate operator
qualification; this migration does not assert that all providers were called.

Native step bundles remain usable before behavioral assessment. Harbor rewards
are retained as source outcomes; structural extractors and judges do not inherit
them as invented semantic-quality labels.
