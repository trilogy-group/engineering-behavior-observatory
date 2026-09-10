# Pi TypeScript SDK harness

EBO integrates `@earendil-works/pi-coding-agent` `0.85.1` directly through its public TypeScript SDK. `ebo pi run` executes one caller-selected frozen queue entry; it does not add RPC, ACP, a Pi fork, or another scheduler.

## Operator command

```sh
node dist/src/cli.js pi run \
  <bundle-root> <queue.json> <run-id> <output-root> \
  [--workspace-root <path>]
```

The queue uses the existing model, harness, native-limits, native-tool-policy, and capture-profile references. Each referenced record declares `schemaVersion: "ebo.pi-config/v1"`. The checked-in synthetic shapes are under `test/fixtures/pi/configs/`; their provider URL is intentionally non-routable.

The model record owns the queue model-condition ID, effective provider/model, API dialect, base URL, credential environment-variable name, thinking level, optional provider-specific thinking-level map, advertised input types, context/output limits, and the pricing inputs Pi requires. Pi's opt-in `xhigh` and `max` levels require an explicit non-null mapping in this digest-bound record so the SDK cannot silently clamp them. Credentials remain process environment only; the runtime uses an empty attempt-local credential store so the user's Pi home cannot override the selected route. The retained composition also records Pi's effective non-secret prompt-cache retention (`long` or `short`) so ambient `PI_CACHE_RETENTION` differences remain explicit. The harness record pins Pi and may explicitly reference digest-bound extensions, skills, prompt templates, context files, and a system prompt. Admitted extension modules must be self-contained; import, dynamic-import, re-export, and CommonJS dependency syntax is rejected so the entrypoint digest covers the complete executable extension. Candidate workspace resources and the user's Pi home are not auto-discovered. The capture profile can set `passiveObserver: false` for a controlled observer-disabled condition; it defaults to enabled.

The tool-policy record selects Pi's public built-in tools and a child-process environment allowlist. The provider credential variable is rejected if it appears in that allowlist. This is configuration containment, not an OS sandbox: Pi still runs in the local trusted environment and its file tools can access paths allowed by the host account.

## Native evidence

One attempt owns one native Pi session. EBO retains three separately addressable restricted artifacts:

| Artifact | Authority | Contents |
|---|---|---|
| `pi-session.jsonl` | authoritative history | Pi session header and append-only entries with original IDs, parent links, messages, usage, compaction, model and thinking changes |
| `pi-events.jsonl` | transient lifecycle | subscription events such as agent/turn/message/tool/retry/compaction lifecycle plus adapter cleanup/error records |
| `pi-observer.jsonl` | passive metadata | ordered public extension hooks for context, provider request/response stages, tool calls/results, compaction and session lifecycle |

Callback values are snapshotted at receipt and writes are serialized and drained before finalization. Provider payload content is off by default; when explicitly enabled it stays restricted. Header values are never recorded. The observer returns no context, prompt, provider-payload, tool-call, or tool-result modifications.

Pi history owns final messages and usage. Streamed message updates retain only their incremental event fields; cumulative `message` and `partial` snapshots are omitted to avoid quadratic evidence growth, while final content remains authoritative in native history. Streamed message deltas and passive tool hooks remain reachable but are explicitly unmapped where projecting them would double-count history or tool operations. Adapter receipt time is labeled in attributes and is never promoted to a native timestamp. Errors from selected extension hooks are retained as observer diagnostics and prevent the capture from qualifying.

On timeout or cancellation EBO calls the public `session.abort()` API, waits for idle, copies the original persisted native session tree, emits shutdown, disposes the session, drains recorders, and then packages the workspace. The SDK branch-export helper is only a fallback when native persistence is unavailable. Creation, provider, export, recorder, and cleanup failures retain a partial attempt; recorder loss cannot qualify as success. The single configured retry bound applies to Pi's agent-level loop while provider-library retries remain disabled, preventing multiplicative requests.

## Capability and gap matrix

| Surface | Status | Evidence/gap |
|---|---|---|
| messages and native session tree | available | persisted Pi JSONL plus subscription start/end records |
| model requests | available | passive `before_provider_request`; payload content opt-in restricted |
| tool operations | available | subscription start/update/end keyed by native tool-call ID |
| context and compaction | available | context/compaction hooks plus native history |
| retries | available | public session retry lifecycle events |
| provider usage | available | native assistant-message usage; treated as per-message increments |
| permissions | unsupported | no distinct selected public-SDK permission-decision record |
| delegation/child histories | unsupported | one owned Pi session per attempt; no branching/resume UI |
| native OTLP receipt | unsupported | no verified native Pi `0.85.1` OTLP receipt surface |
| isolation | limited | local SDK execution is not an OS sandbox |

## Validation

The deterministic fixture exercises the real queue, workspace, bundle, qualification, export/readback, observation, comparison, judge-package, calibration, aggregation, and Atlas paths with an SDK-shaped session seam:

```sh
npm run build
node --test dist/test/pi.test.js
```

The approved live smoke performs one synthetic file edit through Z.ai's OpenAI-compatible Chat Completions route. It is opt-in and never prints the key:

```sh
EBO_LIVE_PI_SDK_SMOKE=1 node --test \
  --test-name-pattern='approved live Pi SDK smoke' dist/test/pi.test.js
```

Set `ZAI_API_KEY` in the environment. The smoke selects `glm-5.3-flash` and `https://api.z.ai/api/coding/paas/v4` only in its generated test input; neither is a product default.

<!-- BEGIN OPENSYMPHONY MANAGED MEMORY SYNC -->

## Current model

- COE-598 contributed: PR #45: feat(pi): add operational SDK harness (merge `6c73097`)

## Important invariants

- Preserve the behavior described in the recent captured changes unless current code and tests show it has changed.
- Use capsule source refs to inspect the original PR or Linear issue when context is ambiguous.

## Operational flow

- No generated diagram requested for this sync.

## Known gotchas

- No area-specific gotchas were inferred from the selected memory.

## Recent changes

- COE-598: Integrate Pi TypeScript SDK with operational capture and behavioral evidence

## Source refs

- COE-598

<!-- END OPENSYMPHONY MANAGED MEMORY SYNC -->
