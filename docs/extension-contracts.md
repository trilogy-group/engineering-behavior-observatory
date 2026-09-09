# Extension contracts

EBO extensions are ordinary, explicit TypeScript registrations backed by
contract tests. There is no dynamic package discovery, plugin registry, or
universal harness protocol. Add a loader only if separately installed
third-party extensions become a demonstrated requirement.

Start with `npm ci && npm run build`. Every command below runs a checked-in
contract fixture with Node's test runner. The snippets are minimal shapes;
copy the nearby production adapter/test that matches the source boundary and
replace only source-owned fields.

## Harness capture and normalization adapter

Implement a `HarnessAdapter<Request, NativeRecord>` with separate capture and
normalization members, then register it explicitly:

```ts
import {
  AdapterRegistry,
  assertAdapterContract,
  type HarnessAdapter,
} from "../src/index.js";

type NativeRecord = { kind: string };

const adapter: HarnessAdapter<Request, NativeRecord> = {
  capture: {
    id: "example-adapter",
    harness: "example-harness",
    capture: async (request) => captureNativeRecords(request),
  },
  normalization: {
    id: "example-adapter",
    harness: "example-harness",
    capabilityProfile,
    normalize: async (capture) => projectQualifiedCapture(capture),
  },
};

await assertAdapterContract(adapter, request, nativeEvidenceResolver);
const adapters = new AdapterRegistry([adapter]);
```

Evidence obligations:

- persist native records before projection and give every mapped event a
  resolvable `artifactId` plus `recordLocator`;
- normalize only qualified or qualified-with-gaps capture;
- declare every native type and available/partial/unsupported capability;
- keep unknown, unsupported, and missing values explicit;
- retain every native record as mapped or explicitly unmapped; and
- preserve source run/attempt identity, ordering domains, timestamps,
  parentage, content references, and terminal semantics without inference.

Runnable contract fixture:

```sh
node --test --test-name-pattern='minimal capture and normalization adapter contract' \
  dist/test/uniform-events.test.js
```

Current source-specific examples are the Agent SDK normalizer,
`createOpenHandsHarnessAdapter`, `createDeepSeekHarnessAdapter`, and
`createCodexHarnessAdapter`. A new adapter must not weaken their native-first
rules to fit a common convenience model.

## Source-specific process or API boundary

Use `runProtocolProcess` only for a source whose owned child actually speaks
newline-delimited JSON on stdout:

```ts
import { runProtocolProcess } from "../src/index.js";

const result = await runProtocolProcess({
  command: runtime,
  args: ["serve"],
  source: "example-harness",
  evidencePath: "evidence/protocol.jsonl",
  stderrPath: "evidence/stderr.log",
  onFrame: async (frame, recorder) => {
    await recorder.recordNotification({
      source: "example-harness",
      method: nativeMethod(frame),
      payload: frame,
    });
  },
});
```

This reusable layer owns bounded frame parsing, append-only JSONL recording,
stderr capture, interruption, teardown, and partial evidence. The adapter still
owns source method schemas, request/response correlation, session identities,
capabilities, and completion evidence. A clean process exit is not a source
completion event.

DeepSeek integrations must use the official
`@deepseek-ai/dsh-sdk-client` and `@deepseek-ai/dsh-sdk-protocol` packages. The
official client owns JSON-RPC framing, transport, and teardown; EBO records its
typed calls/notifications rather than recreating the protocol client with
`runProtocolProcess`. OpenHands uses its pinned REST/WebSocket contract, and
Codex uses its pinned app-server contract; neither is forced into a generic
JSONL method schema.

Evidence obligations:

- append source frames/observations in observed order before deriving state;
- bound stdout frames and diagnostics before parsing/retention;
- distinguish malformed output, recorder failure, interruption, shutdown, and
  natural exit; and
- retain a readable partial record when the source terminates unexpectedly.

Runnable contract fixture:

```sh
node --test --test-name-pattern='records JSONL frames' \
  dist/test/process-protocol.test.js
```

## Structural extractor

Structural extractors are deterministic entries in
`STRUCTURAL_EXTRACTOR_REGISTRY`, not runtime-loaded classes:

```ts
const registration = {
  id: "example-explicit-tool-failure-count",
  requiredCapabilities: ["family:tool"],
  definition: "Distinct native tool operations with an explicit failure.",
} as const;
```

Add the registration and its extraction function in
`src/structural-observations.ts`, bump `STRUCTURAL_EXTRACTOR_VERSION`, update
both extractor-version constraints in
`schemas/structural-observations.v1.json`, then add one small golden fixture
case. Schema/readback changes must continue accepting already retained
extractor versions. Every registry or extraction-behavior change requires this
coordinated version update so new observations validate and retained provenance
stays unambiguous. Do not use a semantic heuristic for a structural fact.

Evidence obligations:

- state the denominator, unit, and exact native condition being counted;
- cite every contributing native record and normalized source event;
- deduplicate only on a source-owned stable identity;
- emit `unavailable` with a reason when required capability/order/identity is
  absent; and
- never turn missing evidence into zero or combine cumulative usage snapshots.

Runnable contract fixtures:

```sh
node --test --test-name-pattern='golden structural facts|available zero' \
  dist/test/structural-observations.test.js
```

## Rubric and semantic judge backend

A rubric is caller-owned data inside a versioned
`SemanticJudgeRequest`; it is not executable plugin code:

```ts
import type { SemanticJudgeRequest } from "../src/index.js";

const rubric: SemanticJudgeRequest["rubric"] = {
  id: "example-verification-rubric",
  version: "1.0.0",
  instructions: "Assess only whether cited evidence shows validation.",
};
```

The caller also selects the evaluator. Omit `backend` (or use
`claude-agent-sdk`) with provider `anthropic`, or use `codex-app-server` with
provider `openai`. Model, effort, limits, and optional executable remain
configuration; no automatic fallback occurs. Extend backend code only when an
issue explicitly requires another trusted execution boundary.

Evidence obligations:

- select bounded event and structural-observation IDs explicitly;
- treat packaged trajectory text as untrusted data;
- require citations for assessed claims plus rationale and an alternative
  explanation;
- allow abstention when evidence is insufficient; and
- retain evaluator configuration identity without exposing secrets or
  silently changing model/effort.

Runnable contract fixtures:

```sh
node --test --test-name-pattern='request schema admits exactly|packages bounded blinded' \
  dist/test/semantic-judge.test.js
node --test dist/test/codex-judge.test.js
```

## Verified-task verifier

A verifier is an admitted, digest-pinned CommonJS or ESM file, not an arbitrary
command. It reads the private workspace snapshot path from `process.argv[2]`
and writes one JSON object to stdout. Compile this TypeScript example to
CommonJS or ESM before digesting and admitting it. Admit compiled ESM with an
`.mjs` locator; the operational runners treat every other locator as CommonJS:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.argv[2];
const passed = readFileSync(join(workspace, "result.txt"), "utf8") === "done\n";
if (!passed) process.exitCode = 1;
process.stdout.write(JSON.stringify({
  assertions: [{ id: "expected-result", status: passed ? "passed" : "failed" }],
}));
```

Evidence obligations:

- use only the admitted digest-pinned verifier and evaluated workspace
  snapshot;
- emit bounded assertion IDs with `passed` or `failed` status;
- write diagnostics to stderr, not additional stdout records;
- preserve timeout/crash/malformed output as verifier error evidence; and
- never run a verifier for an observational packet or treat not-run as passed.

Runnable contract fixtures:

```sh
node --test --test-name-pattern='executes a verifier outside|preserves ESM' \
  dist/test/verifiers.test.js
```

## Export policy

An export policy is explicit caller data passed to the existing fail-closed
export implementation:

```ts
import {
  createPortableRunBundleExport,
  type PortableExportPolicy,
} from "../src/index.js";

const policy: PortableExportPolicy = {
  sharingClass: "partner",
  maxArtifactBytes: 16 * 1024 * 1024,
  maxStringBytes: 8192,
  sensitiveValues: [callerKnownConfidentialValue],
};

await createPortableRunBundleExport({
  sourceRoot: restrictedRunBundle,
  destinationRoot: newExportRoot,
  policy,
});
```

Keep caller-known `sensitiveValues` with restricted study inputs and never
commit real values. See [the operator guide](operator-guide.md#5-export-an-approved-derivative)
for handling details.

Extend the existing sanitizer/readback only when a new artifact kind has an
explicit sharing classification. Do not add a permissive fallback.

Evidence obligations:

- leave the restricted source bundle unchanged;
- allow only known artifact kinds and classifications;
- remove hidden reasoning, secrets, environment values, and local identifiers;
- rewrite correlation IDs and verify every output digest; and
- rerun policy-bound readback and secret scanning before use or packing.

Runnable contract fixtures:

```sh
node --test --test-name-pattern='exports a sanitized|fails closed on unknown' \
  dist/test/exports.test.js
```

## Contract checklist

For every extension:

1. Pin the source runtime/API/schema version and record configuration digests.
2. Name native evidence, completion semantics, known gaps, and unsupported
   capabilities before mapping anything.
3. Preserve partial/failed attempts and immutable native evidence.
4. Add one focused `node:test` contract fixture beside the closest existing
   test; use synthetic or permissively licensed data only.
5. Run the targeted fixture, `npm run build`, `npm run typecheck`, `npm test`,
   and `git diff --check`.
6. Update [the operator guide](operator-guide.md) only if the public command or
   operational recovery path changed.

These are implementation workflows. Task authorship, model selection, study
execution, human corpus review, trial counts, and partner delivery remain
caller-owned operations outside the extension contract.
