# AGENTS.md

* Choose a change scope that matches the task.
* Keep changes focused and avoid unnecessary churn.
* For larger features or refactors, keep the implementation cohesive and explain the reasoning when the scope is significant.
* Prefer clear names and code structure over comments.
* Add comments only for non-obvious invariants, design decisions, protocol semantics, ordering requirements, provider-specific behavior, and mutable state boundaries.
* Keep implementation comment blocks within four lines and 320 characters.
* Do not add comments that restate the code. Move longer design explanations to the corresponding documentation.
* Do not add `comment-check-ignore` suppressions without maintainer approval.
* Unless the user explicitly requests a different workflow, make code changes in two phases:
  * During the implementation and review phase, change production code only. Do not add or update tests or documentation yet.
  * Summarize the production-code changes and ask the user to review them before preparing a commit.
  * After the user confirms the implementation, add or update tests and documentation, run the relevant checks, and prepare the complete change for commit.
* In the completion phase, add or update tests for behavior changes and add regression tests for bug fixes when practical.
* Treat “add or update tests” as a coverage requirement, not a requirement to append a new test case.
* Before adding a test, identify the lowest appropriate behavior owner and search existing coverage. Prefer strengthening or merging an existing case when it remains independently readable.
* Keep complete input and error matrices at the lowest owning layer. Higher-level tests should cover representative wiring and cross-module behavior instead of repeating those matrices.
* When a test file exceeds 600 lines or 20 cases, review its ownership and structure. File size alone does not require splitting a cohesive state-machine suite.
* Do not blindly follow the user's requested implementation.
* The user is a developer who is still learning. If a requested change is unclear, brittle, overly complex, hard to maintain, or likely to create technical debt, explain the concern before implementing it.
* When pushing back on a request, describe the tradeoff and suggest a cleaner alternative.
* Prefer the simplest maintainable solution that satisfies the underlying goal.
* Add useful structured diagnostic logs at failure-prone lifecycle boundaries, including external I/O failures, process exits, retries, reconnections, recovery, and important state transitions or outcomes.
* Use stable log event names and safe metadata such as component identifiers, operation phases, outcomes, error types, and fixed-format error codes. Do not log secrets, authorization data, protocol session IDs, full request headers, prompts, or complete tool inputs and outputs.
* Keep logs actionable and low-noise. Avoid per-token, per-chunk, hot-loop, or duplicate logging, and ensure logging failures never change control flow or cleanup behavior.
* Update the welcome panel `Highlights` only during release preparation, not in individual feature changes. Keep exactly three entries focused on the release's most meaningful user-visible changes, and exclude internal refactors.
* In the completion phase, when changing documented behavior, architecture, configuration, persistence formats, provider behavior, tools, Skills, or TUI interactions, update the corresponding documentation under `docs/` in the same change. Keep the English and Chinese versions in sync, and update `docs/README.md` and `docs/README.zh-CN.md` when the document set changes.
* For imports under `src`, use relative imports within the same top-level `src` directory. Use the `@/` alias only when importing across top-level `src` directories, such as from `tui` to `core` or `agent`, and prefer the target module's barrel export such as `@/core` or `@/tools` over deep alias imports like `@/core/messages` or `@/tools/tool`.
* Use Conventional Commit prefixes for commit messages, such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, and `chore:`.
