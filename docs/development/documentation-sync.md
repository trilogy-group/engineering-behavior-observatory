# Documentation sync: failure signals and local policy

## What failed

The public docs tree had 58 Markdown files. After removing managed sync blocks
and frontmatter, **39 contained only a title**. They were provenance summaries,
not documentation a reader could use.

Examples included `adapters.md` and `documentation.md`. Their managed
sections listed issue contributions, generic invariants, and statements that
no gotchas or diagrams had been inferred. They provided no operational model,
configuration, example, or recovery instructions.

Area associations also spread across unrelated topics: foundation and SDK
integration issues appeared in many area lists. A high mapping confidence and
a clean public-link lint did not establish topical relevance or usefulness.

## Why it matters

- Alphabetical navigation gave empty pages the same prominence as real guides.
- Repeated contribution lists obscured substantive content.
- `Docs pending: 0` meant the sync ran, not that user-facing behavior was
  documented.
- Incremental syncing encouraged append-only maintenance rather than designing
  an entry point around reader tasks.

## EBO's containment change

The repository memory configuration routes generated topic notes to the
ignored private memory tree and sets their visibility to private. Public
managed blocks and title-only pages are removed. Authored guides are grouped
by purpose and linked from a documentation index.

Memory capture and provenance are preserved. The broad learned area mappings
are not repaired by this change; their output is simply kept out of public
docs. No OpenSymphony engine behavior is changed.

Future captures may learn mappings again. Inspect sync's dry-run target paths
before applying it, and keep public authored guides out of generated targets.
Do not rerun initialization with force merely to regenerate public pages.

## Candidate acceptance checks for a future OpenSymphony fix

These are proposed product checks, not implemented EBO features:

1. A page consisting only of a title and generated boilerplate should remain
   private provenance, not become public documentation.
2. Topic relevance should come from narrow source evidence; shared milestone
   membership alone should not spread every issue across every area.
3. A sync report should distinguish provenance updated, authored documentation
   reviewed, and actual user-facing coverage.
4. Generated output should identify concrete behaviors and limitations, or
   state that human authoring is needed without publishing an empty page.
5. Validation should test whether an intended reader can perform a documented
   action, in addition to checking links and privacy.

Use this case as a reproducible failure example when revisiting sync-docs.
Do not replace the issue lists with invented implementation prose.
