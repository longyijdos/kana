# AGENTS.md

## Scope and workflow

* Choose a change scope that matches the task and keep the result cohesive.
* Default to completing the task in one pass. Do not impose separate implementation, review, test, or documentation phases unless the user requests a checkpoint.
* Do not stop for routine approval. Ask for direction only when a missing choice would materially change the result, broaden the scope, or authorize a consequential action.
* Avoid unnecessary churn. For larger features or refactors, explain the important design tradeoffs and keep related changes together.
* Do not blindly follow a brittle or overly complex request. Explain the maintenance concern and suggest the simplest durable alternative.
* Before an unfamiliar or cross-module change, read `docs/architecture.md` and use `docs/README.md` to find the canonical owner; for a narrow change, read only the relevant owner document and avoid loading unrelated documentation.

## Implementation

* Prefer clear names and code structure over comments.
* Add comments only for non-obvious invariants, design decisions, protocol semantics, ordering requirements, provider-specific behavior, and mutable state boundaries.
* Keep implementation comment blocks within four lines and 320 characters. Do not add comments that restate the code.
* Put longer explanations in documentation only when they describe a stable contract or design boundary that future contributors need.
* Do not add `comment-check-ignore` suppressions without maintainer approval.
* For imports under `src`, use relative imports within the same top-level `src` directory. Use the `@/` alias only across top-level directories and prefer target barrels such as `@/core` or `@/tools` over deep aliases.

## Tests

* Treat tests as evidence for behavior, not as mandatory file churn for every code edit.
* When observable behavior changes, inspect existing coverage first. Add or update tests only where the current suite does not adequately cover the changed contract or regression risk.
* Add a regression test for a bug fix when it is practical, stable, and likely to prevent recurrence.
* Do not change tests solely because implementation structure, comments, formatting, documentation, or generated references changed while behavior remained covered.
* Before adding a case, identify the lowest behavior owner and search existing coverage. Prefer strengthening or consolidating an existing case when it remains independently readable.
* Keep complete input and error matrices at the lowest owning layer. Higher-level tests should cover representative wiring and cross-module behavior instead of repeating those matrices.
* Run checks in proportion to the change. Use the full `bun run check` for broad, risky, or commit-ready changes.

## Documentation

* Documentation describes the current system, not the sequence of commits that produced it.
* Update documentation only when the change would otherwise make a canonical document inaccurate or when it introduces a stable contract readers need. Typical examples are public CLI behavior, configuration and defaults, persistence or wire formats, provider/tool/Skill contracts, TUI interaction, and architecture boundaries.
* A code change does not require a documentation edit merely because it is user-visible or touches a documented module. Do not update docs for internal refactors when the existing abstraction remains accurate.
* Document invariants and the resulting current design, not implementation steps, commit chronology, or every local branch. Rename local code details in docs only when readers actually depend on those names.
* Use the ownership map in `docs/README.md` and `docs/README.zh-CN.md`. Update the narrowest owning document, consolidate overlapping material, and remove superseded explanations instead of appending another version.
* Keep English and Chinese versions structurally and semantically aligned whenever a document changes. Update the documentation indexes only when the document set or ownership routing changes.
* Do not add repeated ownership boilerplate to every document; keep routing guidance in the documentation indexes and write natural introductions in individual documents.

## Diagnostics and safety

* Add structured diagnostic logs at failure-prone lifecycle boundaries such as external I/O failures, process exits, retries, reconnections, recovery, and important state transitions.
* Use stable event names and safe metadata such as component identifiers, phases, outcomes, error types, and fixed-format error codes.
* Never log secrets, authorization data, protocol session IDs, full request headers, prompts, or complete tool inputs and outputs.
* Keep logs actionable and low-noise. Avoid per-token, per-chunk, hot-loop, duplicate, or control-flow-affecting logging.

## Release and commits

* Update the welcome panel `Highlights` only during release preparation. Keep exactly three entries covering the release's most meaningful user-visible changes and exclude internal refactors.
* Use Conventional Commit prefixes such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, and `chore:`.
