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

## Default Priorities

- Prioritize correctness, regressions, security risks, and missing tests ahead of style-only feedback.
- Treat behavior changes as incomplete unless the PR includes concrete verification or evidence.
- Call out risky data migrations, auth changes, concurrency hazards, and production operability regressions explicitly.

## Customize For This Repository

- List the most security-sensitive paths or subsystems.
- List required validation commands reviewers should expect to see.
- Describe any architecture invariants that must not be broken.
- Add framework- or language-specific review heuristics that matter here.

## Evidence Expectations

- Behavior changes should include test or reproduction output.
- UI changes should include screenshots or recordings.
- Performance-sensitive changes should include benchmark data or timing notes.
