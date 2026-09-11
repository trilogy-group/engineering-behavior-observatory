# v0.2.5 known limitations

The [v0.2.4 limitations](../0.2.4/KNOWN_LIMITATIONS.md) continue to apply.

- Symlink support applies to workspace outcome capture, not task-archive
  admission or permission to read outside the workspace.
- On macOS, use the documented native `pax` command when inspecting snapshots
  containing genuine AppleDouble files. Default `tar` extraction can consume them.
- Capture-only recovery can use retained evidence and workspace files without
  rerunning a model, but cannot reconstruct missing files or prove an earlier
  workspace state without a fingerprint captured at that time.
- Workspace snapshots remain restricted evidence, not sanitized partner exports.
