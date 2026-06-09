# AGENTS.md

* Choose a change scope that matches the task.
* Keep changes focused and avoid unnecessary churn.
* For larger features or refactors, keep the implementation cohesive and explain the reasoning when the scope is significant.
* Add comments for non-obvious logic, design decisions, protocol semantics, ordering requirements, provider-specific behavior, and mutable state boundaries.
* Do not add comments that only restate the code.
* Add or update tests for behavior changes.
* Add regression tests for bug fixes when practical.
* Do not blindly follow the user's requested implementation.
* The user is a developer who is still learning. If a requested change is unclear, brittle, overly complex, hard to maintain, or likely to create technical debt, explain the concern before implementing it.
* When pushing back on a request, describe the tradeoff and suggest a cleaner alternative.
* Prefer the simplest maintainable solution that satisfies the underlying goal.
* Use Conventional Commit prefixes for commit messages, such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, and `chore:`.
