# v0.2.6 known limitations

The [v0.2.5 limitations](../0.2.5/KNOWN_LIMITATIONS.md) continue to apply, except
that contained absolute workspace links are now supported.

- Link relocation describes a derived workspace artifact, not byte-identical
  original link text. Source directories are not modified.
- Missing workspace evidence remains unqualified for work-product claims.
  Semantic analysis may proceed only when its own evidence qualifies.
- A verified task whose verifier or workspace binding fails is not reported as
  successful. Genuine harness, setup, persistence, and cleanup errors remain
  distinct from workspace packaging gaps.
- Native telemetry receipt limits and provider evidence gaps are unchanged.
- No models are rerun to recover capture. A later recovered workspace cannot
  prove its exact earlier state without a fingerprint recorded at that time.
