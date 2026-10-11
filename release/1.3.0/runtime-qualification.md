# EBO 1.3.0 runtime qualification

The [candidate manifest](reproducibility.json) binds runtime pins and source
fixtures. This record describes the October 11, 2026 upgrade checks. Live checks
use synthetic tasks and establish the exercised capture paths; they do not
measure model quality or benchmark performance.

## Migration

Freeze fresh harness configurations for the candidate pins. Preserve existing
experiment inputs, native captures and published release records. EBO reads
supported older Codex, Cursor, DeepSeek, OpenHands and Pi captures with their
captured versions and adapter identities.

Codex 0.162.1 has a new generated contract subset under
[`contracts/codex-app-server-0.162.1`](../../contracts/codex-app-server-0.162.1/manifest.json).
OpenHands 1.54.0 has a new release/OpenAPI contract under
[`contracts/openhands-agent-server-v1.54.0.json`](../../contracts/openhands-agent-server-v1.54.0.json).
The consumed transport fields remain compatible. Pi 1.1.0 supplies an explicit
`agent_settled.aborted` flag; EBO retains it, classifies it as interruption and
rejects contradictory completed evidence.

Install the Harbor environment with:

```sh
python3.14 -m venv .ebo/harbor-venv
.ebo/harbor-venv/bin/python -m pip install 'harbor[smol]==0.24.0' smolmachines==1.26.1
export EBO_HARBOR_PYTHON="$PWD/.ebo/harbor-venv/bin/python"
ebo harbor doctor
```

Harbor 0.24.0 owns the `harbor.environments.smol` provider. Its extra resolves
with Smol 1.26.1; Smol's own `harbor` extra constrains Harbor below 0.23. EBO uses
Harbor's verifier environment resolver and Smol's lazy bundled-libkrun default.
Explicit runtime overrides still require the qualified provenance checks.

Rebuild frozen worker/runtime archives from this source and regenerate the
environment manifest before VM trials. Bind approved registry images to their
digests and record the installed Smol platform library hash. The checked native
macOS arm64 libkrun SHA-256 is
`938b96c8bbafd76d4a7aaafd01a7bc35d3aaadf7f1eff36d842940dd5c82cac0`.
See the [Harbor task guide](../../docs/guides/harbor-tasks.md) for the full
environment and image requirements.

## Checks and evidence boundaries

| Component | Exercised path and result |
| --- | --- |
| Claude 0.3.296 | Installed SDK and bundled CLI metadata, typed hooks, capture/retained/export fixtures and typecheck passed. Live provider check requires an available Claude credential. |
| Codex 0.162.1 | Generated native contracts and existing-auth native capture passed with zero capture gaps. OTLP logs and traces arrived; the short smoke had no metrics receipt. |
| Cursor 1.0.37 | Live `composer-2.5` file edit completed with qualified capture, official store, retained analysis and export/readback. |
| DeepSeek 0.2.0-rc.2 | Native shipped `sdk-minimal` composition with a digest-bound Z.ai `glm-5.3-flash` provider patch completed a file edit. Receipt preceded idle, 27 native observations normalized, and the owned runtime was reaped. |
| Devin 3000.11.3 | Official release manifest matches the existing pin. Deterministic ACP lifecycle, retained and export checks remain in the suite. |
| Factory 0.9.1 / 0.238.0 | Native Droid with a local Chat Completions mock passed BYOK capture and export checks. Managed and Fireworks BYOK provider checks are recorded in the [Factory guide](../../docs/harnesses/factory-droid.md). |
| OpenHands 1.54.0 | Release artifact/OpenAPI digests verified. Authenticated native REST/WebSocket capture using Fireworks `accounts/fireworks/models/glm-5p3-flash` passed workspace verification and export/readback. EventLog completeness remains an explicit capture gap. |
| Pi 1.1.0 | Real SDK mock-provider tool selection, abort handling and retained contradiction checks passed. Live Z.ai `glm-5.3-flash` file edit completed with qualified capture, retained analysis and export/readback. |
| Smol 1.26.1 / Harbor 0.24.0 | Fresh Python dependency resolution, bundled SmolVM version, doctor, direct branching, separate-process borrowers and EBO local preparation passed. All VMs owned by these checks were deleted. |

The new environment pins have not completed an image-backed Harbor Trial with
the rebuilt frozen worker archive and approved guest-reachable registry images.
The direct/borrower/preparation checks establish VM ownership and preparation;
full Trial qualification remains a separate opt-in gate. Factory's recorded
Smol CLI checks exercise its local root filesystem path.

The release acceptance command checks fixture digests, the full deterministic
suite, documentation links, package contents, source binding, secret/path
scanning and byte-identical npm archives. Native/provider checks run separately
so the deterministic release gate remains reproducible.

## Dependency advisory constraints

The lockfile refreshes MCP SDK to 1.32.1, fast-uri to 3.1.8, Hono to 4.13.13,
ip-address to 10.7.4, proxy-addr to 2.0.8 and Sharp to 0.35.5 within upstream
dependency ranges. The audit has 15 affected package entries: six high and nine
moderate, including dependent packages; none are critical. These entries derive
from three upstream constraints:

- DeepSeek's MCP client pins `@modelcontextprotocol/client` 2.0.0. Its HTTP/OAuth
  issuer-binding advisory is fixed in 2.2.0. The exercised `sdk-minimal`
  composition does not load MCP; custom HTTP/OAuth MCP compositions need their
  own qualification and an upstream dependency update. See the
  [MCP SDK advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h).
- DeepSeek's office conversion package pins `fflate` 0.8.2 and calls
  `unzipSync`; the ZIP64 denial-of-service fix is in 0.8.3. Office conversion is
  outside the exercised minimal composition. See the
  [fflate advisory](https://github.com/advisories/GHSA-px8p-9vwx-vf98).
- Factory SDK 0.9.1 depends on UUID 9.x. The advisory concerns buffered
  `v3`/`v5`/`v6` calls; the inspected SDK uses `v4` request IDs. The dependency
  remains reported by npm audit. See the
  [UUID advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq).

These constraints are retained in the audit record. EBO's tested runtime pins
do not override upstream exact dependencies or introduce an unqualified major
dependency substitution.
