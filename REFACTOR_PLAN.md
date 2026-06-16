# Code Health Refactor Plan

Branch: `refactor/code-health`

## Goals

- Reduce duplicated helper logic.
- Split large files along existing module boundaries.
- Keep behavior unchanged unless a separate bug is found and explicitly handled.
- Preserve current public exports and user-visible behavior.
- Add or update tests when refactors touch behavior-sensitive paths.

## Ground Rules

- Prefer small commits with `refactor:` or `test:` prefixes.
- Run focused tests after each step, then `bun run typecheck`.
- Avoid broad rewrites of core streaming or agent loop behavior without event-sequence tests first.
- Keep imports consistent with `AGENTS.md`: relative imports inside the same top-level `src` directory, `@/` only across top-level directories.
- Do not update the welcome panel `Highlights` for internal-only refactors.

## Step 1: Shared Low-Risk Helpers

Status: completed

Targets:

- Extract duplicated tool-result normalization from `src/agent/loop.ts` and `src/tui/app/app.ts`.
- Extract duplicated XML escaping from `src/kana/skills.ts` and `src/kana/prompt.ts`.
- Extract duplicated unknown-error formatting from `src/kana/skills.ts` and `src/kana/skill-install.ts`.

Validation:

- `bun run typecheck`
- Focused tests covering agent loop, TUI shell display, skills, prompt, and skill install where applicable.

## Step 2: Split `src/kana/skills.ts`

Status: pending

Proposed shape:

- `src/kana/skills/types.ts`
- `src/kana/skills/loader.ts`
- `src/kana/skills/frontmatter.ts`
- `src/kana/skills/config.ts`
- `src/kana/skills/prompt.ts`
- `src/kana/skills/index.ts`

Validation:

- `bun test tests/kana-skills.test.ts tests/tui-skill-manager.test.ts`
- `bun run typecheck`

## Step 3: Continue TUI App Decomposition

Status: pending

Targets:

- Move local shell execution from `src/tui/app/app.ts` into a controller.
- Consider moving slash command dispatch into a focused command handler if it reduces `KanaTuiApp` responsibilities.
- Keep `KanaTuiApp` responsible for wiring, session state, and high-level lifecycle.

Validation:

- `bun test tests/tui-tool-approval.test.ts tests/tui-transcript.test.ts tests/tui-prompt-editor.test.ts tests/cli.test.ts`
- `bun run typecheck`

## Step 4: Add Agent/Provider Event Sequence Tests

Status: pending

Targets:

- Cover assistant message start/update/end ordering.
- Cover tool call start/delta/end and tool execution events.
- Cover abort and canceled tool result behavior.

Validation:

- `bun test tests/agent-loop.test.ts tests/agent.test.ts tests/deepseek-request.test.ts`
- `bun run typecheck`

## Step 5: Carefully Refactor Core Streaming Paths

Status: pending

Targets:

- Only after Step 4 tests are in place.
- Reduce repeated event emission code in `src/agent/loop.ts`.
- Reduce repeated snapshot event creation in `src/providers/deepseek/stream.ts`.

Validation:

- Full `bun run check`

## Step 6: Markdown Renderer Cleanup

Status: pending

Targets:

- Split inline parsing, wrapping, and styling from `src/tui/components/chat-blocks/markdown-block.ts`.
- Keep rendering snapshots stable.

Validation:

- `bun test tests/tui-markdown-block.test.ts tests/tui-text-block.test.ts tests/tui-width.test.ts`
- `bun run typecheck`
