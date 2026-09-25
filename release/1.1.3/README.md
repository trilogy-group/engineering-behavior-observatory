# EBO 1.1.3

The Harbor execution profile uses Smol Python SDK 1.18.2 with its bundled
libkrun and retains Harbor 0.22.0. The bundled library contains the upstream
disk-capacity fix. EBO records and checks its SHA-256 against each new frozen
environment manifest. The isolated `SMOLVM_LIB_DIR` override is rejected.
Smol's generated machine names use a bounded derived session ID so verifier
branches stay within the guest hostname limit; full attempt IDs remain in EBO evidence.
Separate grader children receive verifier files at `/tests` after branching.

Smol's credential substitution is available in its VM runtime, but the pinned
Python SDK does not expose credential bindings through `MachineConfig`. EBO's
worker `environmentKeys` still pass selected values into the guest attempt
process. The [Harbor guide](../../docs/guides/harbor-tasks.md) describes that
trust boundary; provider-specific routes remain operator configuration.

## Verification

The upgrade gate covers a direct branch, two separate Harbor borrowers from
one unchanged parent, local preparation, and the no-model live Harbor Trial
fixture. The release acceptance gate checks the source, package, and docs.

[`reproducibility.json`](reproducibility.json) records the pinned runtimes and
fixture digests.
