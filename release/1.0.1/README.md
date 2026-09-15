# EBO 1.0.1

Documentation and release-metadata update. Runtime code, schemas, contracts,
and ontology are unchanged from v1.0.0.

- The README and Harbor guide identify Harbor commands as available in EBO
  1.x through npm, with separate host virtualization prerequisites.
- The overview diagram shows human review as an optional evaluation branch.
- Package contents include both the v0.2.10 and v1.x release records.

The v1.0.0 tag was created on the Harbor branch before that branch was merged
into develop and main. The merge retained the same runtime implementation and
reconciled package versions and historical release records. Existing tags and
published artifacts are preserved. This patch is released from the reconciled
main history.

The prior implementation suite passed with 653 tests and 12 opt-in skips.
No implementation tests or release gate were rerun for this documentation-only
patch. See the [v1.0.0 support boundary](../1.0.0/KNOWN_LIMITATIONS.md).
