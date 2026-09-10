# v0.2.2 known limitations

The [v0.2.1 limitations](../0.2.1/KNOWN_LIMITATIONS.md) continue to apply.

- `networkAccess` configures workspace-write command networking, not the model
  provider connection or the separate Codex web-search tool.
- Read-only mode remains offline for tools. Danger-full-access retains its
  unrestricted native behavior. Supplying `networkAccess` with either mode is
  rejected.
- Platform or organization network restrictions can still prevent a request.
  A configured allowance is not proof that every destination is reachable.
- The default changed from offline to online for workspace-write runs. Pin the
  boolean explicitly in new experiment configurations.
