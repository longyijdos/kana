# Release process

Kana uses `package.json` as the single source of truth for the runtime version, `CHANGELOG.md` as the single source of truth for user-facing release notes, and a `v<version>` Git tag to identify the commit that was published. A release must keep all three aligned.

## Version policy

Before `1.0.0`, Kana uses these conventions:

- `0.MINOR.0`: a user-visible feature or a change to CLI, configuration, protocols, persistence, or other public behavior. A breaking change before `1.0.0` also increments MINOR.
- `0.MINOR.PATCH`: a backward-compatible bug or performance fix, with no new feature or breaking change.
- `0.MINOR.PATCH-alpha.N`, `-beta.N`, or `-rc.N`: a build that needs public validation but is not ready to be a stable release.
- After `1.0.0`, standard Semantic Versioning applies: breaking changes increment MAJOR, backward-compatible features increment MINOR, and backward-compatible fixes increment PATCH.

Commits continue to use Conventional Commits. `feat:` normally requires a MINOR release and `fix:` normally requires PATCH; use `feat!:`, `fix!:`, or a `BREAKING CHANGE:` footer to mark incompatibility explicitly. Internal changes containing only `refactor:`, `test:`, `docs:`, or `chore:` normally do not require their own release.

`conventional-changelog` generates release notes from commit history; it does not choose the version. Select the version manually from the user-visible impact.

## Prepare a stable release

Prepare the release commit on the latest `main`. Start with a clean worktree and current tags:

```bash
git switch main
git pull --ff-only
git fetch --tags
```

Then follow these steps in order:

1. Choose the version from user-visible changes since the previous tag.
2. Update `version` in `package.json`.
3. Update the welcome panel `Highlights`. Keep exactly three entries covering the release's most important user-visible changes.
4. Run `bun run changelog`. It reads Conventional Commits after the latest SemVer tag and prepends the new version section to `CHANGELOG.md`.
5. Review the new section: combine duplicate or implementation-level entries and add breaking changes, upgrade instructions, and important security notes. Preserve all older release sections.
6. If the release changes documented behavior, update the corresponding Chinese and English documentation together.
7. Run `bun run check` and review the final diff.

Do not use `bun run changelog --release-count 0` during a normal release. It rebuilds and overwrites the complete history. The repository's historical release notes have been curated and should be preserved.

## Commit, tag, and push

Put the version, Changelog, Highlights, and release-specific documentation in one release commit:

```bash
git add package.json CHANGELOG.md src/tui/components/chat-blocks/welcome-block.ts docs
git commit -m "chore: release v0.3.0"
git tag -a v0.3.0 -m "Release v0.3.0"
git push --atomic origin main v0.3.0
```

Adjust the staged files to match the actual diff. Use annotated tags for every stable release; the tag must point at the release commit, and a published tag must never be moved or reused.

## Release automation

The repository pins the Bun toolchain in `package.json` and in both the CI and Release workflows. When upgrading Bun, update all three locations to the same version so local tooling, validation, and compiled release runtimes stay aligned.

After a `v*` tag is pushed, the Release workflow:

1. Verifies that the tag, `package.json` version, and `CHANGELOG.md` section agree.
2. Runs formatting, type, dead-code, and test checks.
3. Builds macOS/Linux binaries and SHA-256 files for arm64 and x64.
4. Extracts the matching Changelog section as the GitHub Release body.
5. Creates the Release, or updates its body and replaces its assets when rerun.

To regenerate assets for an existing tag, manually run the Release workflow in GitHub Actions and select that tag. This does not change the version or move the tag, so use it only to recover a failed publication or rebuild assets from the same source.
