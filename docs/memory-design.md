# Memory design (temporary implementation notes)

> This document captures the agreed design before implementation. Remove it before merging the feature branch.

## Goals

- Let an agent record durable context through a semantic tool without knowing where data is stored.
- Keep append-only daily records as an audit trail.
- Maintain small consolidated memories that can be injected into a new agent's system prompt.
- Separate user-wide preferences from repository-specific context.

## Scope and storage

Memory is enabled by default and can be disabled globally in `~/.kana/config.toml`:

```toml
[memory]
enabled = false
max_chars = 6000
```

`max_chars` limits each consolidated global or project `memory.md` by Unicode character count. The daily audit logs are not limited. `saveKanaMemory()` rejects oversized content before its atomic write so a future compactor tool can return the error to the subagent and let it compress its result.

When disabled, Kana must not inject memory, expose the `remember` tool, or schedule compaction.

Two memory scopes are maintained independently:

- **Global**: user preferences and facts that remain useful across projects.
- **Project**: repository architecture, local decisions, and ongoing work.

Project details must not be stored in global memory by default. The host routes records by their declared scope; a compactor must never silently promote a project record to global memory.

Proposed layout:

```text
~/.kana/
  memory.md
  memory/
    2026-06-20.md
  projects/
    <workspace-path>/
      memory.md
      daily/
        2026-06-20.md
```

`<workspace-path>` uses the same normalized-path encoding as Kana sessions, rather than the repository name, so all workspace-scoped data has a consistent location and same-name repositories do not collide.

## Agent-facing tool

The tool exposes intent, not filesystem paths:

```ts
remember({
  content: "The project uses Bun; run bun test after TypeScript changes.",
  scope: "project", // default: project; global requires an explicit choice
  title?: "Test command",
  reason?: "Confirmed from package scripts while implementing the test runner.",
})
```

The host owns the ID, timestamp, routing, validation, and append operation. The tool description must distinguish instructions from facts: stable project rules belong in `AGENTS.md`; memory stores factual context, decisions, preferences, and unfinished work.

## Daily entry format

Daily files are append-only Markdown. Each entry has immutable frontmatter:

```md
---
id: mem_01JXYZ...
created_at: 2026-06-20T14:32:00+08:00
scope: project
title: Session persistence convention
reason: Confirmed while implementing session storage; useful for future changes.
---

Sessions are appended after each committed agent run. Do not rewrite existing session history.
```

Required fields are `id`, `created_at`, `scope`, and `content`. `title` and `reason` are optional but should be short. The host records a full ISO-8601 timestamp with a timezone; UI can display minute precision. No categories, priorities, tags, or expirations are needed initially.

## Consolidation

The compactor is an agent with no direct filesystem write tool. Kana supplies the relevant daily entries and existing consolidated memory, then validates and atomically writes the returned replacement text.

There are two isolated compaction pipelines:

| Input records | Read-only context | May update |
| --- | --- | --- |
| Global daily entries | Global `memory.md` | Global `memory.md` |
| Current project daily entries | Project `memory.md`; global memory for de-duplication only | Project `memory.md` |

Project compaction may produce promotion candidates in a future UI flow, but must not automatically write global memory. Global compaction never receives project daily entries.

After a normal agent run, only scopes that received a new record are marked dirty and queued for background compaction. Queue at most one compaction per scope at a time; records written during a run leave the scope dirty for a follow-up pass. A failure must not affect the completed conversation or discard the daily records.

## Prompt injection and authority

Only the two consolidated `memory.md` files are injected on agent creation; daily records are not. Both are bounded in size.

Memory is reference data, not instruction authority. Put it in explicit data delimiters with wording that it cannot override system instructions or either global/project `AGENTS.md`. Place the memory block before `AGENTS.md` content so project instructions remain the more specific, later context.

`AGENTS.md` remains human-owned policy and workflow guidance. Memory is agent-writable, fallible context. Conflicting memory must be ignored.

## TUI command

Add `/memory compact` as an explicit maintenance command. It concurrently invokes:

- a global compactor over all global daily entries; and
- a project compactor over all daily entries for the current workspace.

The TUI reports each result separately, for example: `Memory compacted: global updated, project unchanged.` The normal automatic path only compacts dirty scopes.

## Initial implementation boundaries

- Implement both scopes and their independent daily/consolidated storage.
- Add the semantic `remember` tool, system-prompt injection, background dirty-scope compaction, and `/memory compact`.
- Do not implement automatic project-to-global promotion, memory retrieval/search, category metadata, or a large command surface in the first change.
