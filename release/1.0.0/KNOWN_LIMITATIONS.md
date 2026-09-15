# EBO 1.0.0 support boundary

- Smol execution requires the separately installed Python SDK 1.15.0,
  Harbor 0.22.0, a qualified VM runtime, and the documented isolated libkrun
  patch where required. npm installation does not install host virtualization.
- Provider access, credentials, model availability, and subscription limits
  remain external prerequisites. Deterministic acceptance is not live-provider
  conformance for every adapter or model.
- Behavioral judgments depend on the configured rubric and retained evidence.
  Sampling and truncation must be disclosed. Confidence is evaluator-reported;
  a model judgment is not a human endorsement or statistical harness ranking.
- Batch judging requires explicit per-job requests and new output paths. It
  does not generate rubrics, automatically sample evidence, retry failed calls,
  or resume completed jobs implicitly.
- Atlas citation validation can be slow on large native trajectories. Native
  records remain authoritative; derived reports do not replace capture bundles.
- Local Atlas exports can contain restricted evidence. Sharing still requires
  the separate export policy and sanitization workflow.
