# v0.2.9 limitations

- Excluded entries are not reconstructible from the workspace artifact. Review
  the capture report before interpreting the work product as complete.
- Both names of a hard-linked file are omitted rather than reading potentially
  external shared content. Native workspaces remain available locally.
- Starting-fixture Git ignore rules remain an explicit projection policy.
- The Cursor CLI process staying alive after completed capture is a separate,
  unresolved shutdown issue. This patch does not change process teardown.
- Existing [v0.2.8 limitations](../0.2.8/KNOWN_LIMITATIONS.md) still apply.
