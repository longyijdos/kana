# Contributing to Kana

Thanks for contributing! This guide explains how to set up the repository, validate your
changes, and prepare focused pull requests. It is written for human contributors; coding agents
are pointed at [AGENTS.md](AGENTS.md) instead, which describes agent workflow and implementation
guidance and is not the primary human contribution guide.

## Before you start

- For large features, architectural changes, and your first non-trivial contribution, open or claim
  an issue and discuss the approach first, so maintainers can weigh in before you invest time in an
  implementation.
- Check existing issues and pull requests to avoid duplicating work.

## Prerequisites

- [Git](https://git-scm.com/).
- [Bun](https://bun.sh/), matching the repository's pinned version `1.4.2` (see the
  `packageManager` field in `package.json`; CI uses the same version). Use a version manager or
  Bun's version-specific installer if you need to switch versions.

## Local setup

```bash
git clone https://github.com/longyijdos/kana.git
cd kana
bun install --frozen-lockfile
```

`--frozen-lockfile` installs exactly the locked dependencies. `bun.lock` should only change when
dependencies are intentionally added or updated.

## Validating changes

Run the full check suite before opening a pull request:

```bash
bun run check
```

`bun run check` runs:

- **Biome** lint and format checks (with errors on warnings).
- The project **comment-length guard**, which rejects TypeScript comment blocks longer than four
  lines or 320 characters; license headers and explicit `comment-check-ignore: <reason>`
  suppressions are exempt.
- The **architecture boundary check**, which validates that `src/` modules only import along the
  allowed dependency directions and that imports stay within the defined layer boundaries.
- **TypeScript** type checking via `tsc --noEmit`.
- **Knip** dead-code analysis.
- The **Bun test suite**.

Use `bun run check:write` when you want Biome to auto-fix formatting and lint issues. If you are
intentionally removing unused exports or dependencies, run `bun run knip:fix` separately so its
changes can be reviewed on their own.

## Keeping changes focused

- Match the scope of your change: keep PRs small and focused, and avoid unrelated churn such as
  re-formatting untouched code, drive-by refactors, or dependency bumps.
- Prefer the simplest maintainable solution that satisfies the underlying goal, and prefer clear
  names and structure over comments.
- Add regression tests for bug fixes and tests for behavior changes when practical.

## Documentation

When your change affects documented behavior, architecture, configuration, persistence formats,
provider behavior, tools, Skills, or TUI interactions, update the corresponding documentation
under `docs/` in the same change. Keep the English and Chinese versions in sync when both exist,
and update `docs/README.md` and `docs/README.zh-CN.md` when the document set changes.

## Automated and AI-assisted contributions

AI-assisted contributions are welcome, including changes drafted with a coding agent. Contributors
are responsible for everything they submit: review the complete diff, test the change, understand
it, and be able to explain why the approach is right for this repository.

Unsolicited automatically generated or bulk pull requests are not accepted:

- Do not point bots or agents at the repository to scan it and open pull requests on their own.
- Do not submit several independent pull requests in bulk; discuss a multi-pull-request plan with
  maintainers first.

Pull requests that look like automated spam, mass-generated changes, or work submitted without
meaningful human review may be closed without review, and repeated abuse may result in a block.
Automation that a maintainer explicitly asks for, such as the
[Kana Agent workflow](docs/kana-agent-workflow.md), is unaffected.

## Commits and pull requests

- Use [Conventional Commit](https://www.conventionalcommits.org/) prefixes for commits and PR
  titles, such as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, and `chore:` (an optional
  scope and `!` are allowed).
- Update `CHANGELOG.md` only as part of the release process, not in individual feature changes.
- The welcome panel `Highlights` in the TUI is updated only during release preparation.
