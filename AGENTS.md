# AGENTS.md

This file provides persistent context for AI agents working on this repository.

## Project Overview

<!-- Describe your project here. What does it do? What problem does it solve? -->

## Technology Stack

<!-- List your technologies: languages, frameworks, databases, etc. -->

- Language: <!-- e.g., Python 3.11, TypeScript 5.0 -->
- Framework: <!-- e.g., FastAPI, React, Next.js -->
- Database: <!-- e.g., PostgreSQL, SQLite -->
- Testing: <!-- e.g., pytest, vitest -->

## Coding Standards

### General

- Keep functions small and focused
- Write self-documenting code with clear names
- Add comments only for "why", not "what"
- Follow existing patterns in the codebase

### Formatting

<!-- Add your formatting commands -->

- Format command: `<!-- e.g., make format, npm run format -->`
- Lint command: `<!-- e.g., make lint, npm run lint -->`
- Type check: `<!-- e.g., make typecheck, npm run typecheck -->`

### Testing

<!-- Add your testing requirements -->

- Test command: `<!-- e.g., make test, npm test -->`
- Coverage requirement: <!-- e.g., 80%, 100% for critical paths -->
- Test location: `<!-- e.g., tests/, __tests__/ -->`

## Project Structure

```
<!-- Customize this structure for your project -->
.
├── src/                    # Source code
├── tests/                  # Test files
├── docs/                   # Documentation
├── configs/                # Configuration files
├── scripts/                # Utility scripts
├── AGENTS.md               # This file
├── WORKFLOW.md             # OpenSymphony configuration
└── README.md               # Project readme
```

## Key Directories

<!-- Document important directories -->

- `src/` - <!-- Main source code -->
- `tests/` - <!-- Test files -->
- `docs/` - <!-- Documentation -->

## Dependencies

### Runtime

<!-- List key runtime dependencies -->

### Development

<!-- List key dev dependencies -->

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `EXAMPLE_VAR` | <!-- Description --> | Yes/No |

## Local Development Setup

<!-- Steps to set up local development -->

```bash
# Example setup steps
# 1. Install dependencies
# 2. Configure environment
# 3. Run tests
```

## PR Requirements

Before submitting a PR:

1. All tests pass
2. Code is formatted
3. Lint checks pass
4. New code has tests
5. Documentation updated if needed

## Review guidelines

Automated PR reviews (OpenHands PR Review plugin or Codex code review — see
`Active review provider` in `WORKFLOW.md`) apply this section, together with
the full guide in `.agents/skills/custom-codereview-guide.md` when present.
Keep both current.

- Flag correctness bugs, regressions, security risks, and missing tests first;
  skip style-only feedback that formatters and linters already enforce.
- Treat behavior changes without test or reproduction evidence as incomplete.
- <!-- Add repository-specific review rules here: security-sensitive paths,
  architecture invariants, required validation commands. -->

## Architecture Decisions

<!-- Document key architecture decisions -->

### Decision 1

- **Context**: <!-- Why this decision was needed -->
- **Decision**: <!-- What was decided -->
- **Consequences**: <!-- Impact and trade-offs -->

## Known Issues / Gotchas

<!-- Document any quirks or known issues -->

## References

<!-- Links to relevant external documentation -->

- [Framework Docs](https://example.com)
- [API Reference](https://example.com/api)