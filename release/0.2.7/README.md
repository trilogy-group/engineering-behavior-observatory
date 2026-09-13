# v0.2.7: Cursor native recovery

Cursor capture configures HTTP/1.1 before agent creation and enables the SDK's
native transport/stall retries. The configuration evidence records both settings.
EBO does not launch replacement attempts or add its own retry loop. Terminal
errors and partial evidence remain available when native recovery fails.

New queue policies must explicitly set `enableAgentRetries: true`. Earlier
frozen policies are rejected at launch rather than silently overridden; prior
experiments and retained captures remain unchanged.

Regression tests cover configuration ordering, effective evidence, policy
validation, and terminal-error retention with exactly one agent creation.

See the [Cursor guide](../../docs/harnesses/cursor-sdk.md),
[known limitations](KNOWN_LIMITATIONS.md), and
[reproducibility manifest](reproducibility.json).
