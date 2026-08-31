---
name: custom-codereview-guide
description: |
  Repository-specific code review guidance for this project.
  Update this file so automated PR review focuses on the right risks.
triggers:
  - /codereview
---

# Custom Code Review Guide

Automated PR review reads this guidance: the OpenHands PR Review plugin loads it via the `/codereview` trigger, and Codex code review reaches it through the `## Review guidelines` section in `AGENTS.md`. Keep the `triggers` frontmatter: it scopes this content to review conversations so implementation agents do not carry it in context. Replace this starter content with repository-specific expectations.

**This is a durable, shared document.** Never add PR-specific or ticket-specific content here — no "already resolved, do not re-flag" lists, no per-PR evidence dumps. Respond to review feedback in the PR's review threads instead. Only add guidance that applies to all future reviews.

## EBO Review Priorities

- Preserve native session, hook, telemetry, workspace, verifier, and capture-report evidence. Missing or unsupported evidence must stay explicit; do not synthesize events, false values, or zero-valued evidence.
- Treat bundle-relative paths, digests, sharing class, retry lineage, terminal state, and capture qualification as integrity boundaries. Review partial and interrupted bundles as closely as successful ones.
- Export must fail closed on unknown classification. Partner and public artifacts need distinct sanitized provenance; a changed sharing label is never sufficient.
- Keep source-specific harness evidence authoritative. Do not replace it with a universal protocol, normalized event copy, or inferred semantic label.
- Treat task archives before validation, candidate workspaces, SDK messages, subprocess output, and external responses as untrusted. EBO configuration, admitted digest-pinned verifier code, and in-process adapter callbacks are trusted.
- Do not require JavaScript defenses against hostile same-user filesystem races or untrusted verifier containment; the latter requires an OS or container sandbox.

## Expected Checks

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm test`
- `node dist/src/cli.js --help`
- `git diff --check`

## Scope Guardrails

- Prefer Node standard-library facilities and `node:test`; do not add a capture shim, telemetry backend, graph database, distributed scheduler, dynamic plugin host, or hosted Atlas without an issue-backed need.
- Review evidence loss, export leakage, partial-attempt overwrite, protocol-channel corruption, and untested failure paths before style.
- P0/P1 findings block. P2 findings block only for acceptance-criteria failure, evidence loss or corruption, secret leakage, or a stated trust-boundary violation.
