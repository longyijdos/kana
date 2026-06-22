# Sessions and memory

Kana stores resumable conversation history separately from cross-conversation memory: sessions retain complete `Message` history, while memory retains compressed long-term reference information. Both are isolated by workspace; global memory is the only cross-workspace data.

## Workspace identity

Sessions and project memory share the same workspace encoding: resolve `cwd` to an absolute path, remove its leading separator, replace path separators and `:` with `-`, then wrap it in `--`. It is a stable directory name, not encryption or a security boundary.

```text
cwd: /Users/alice/project
  → --Users-alice-project--
```

Consequently sessions and project memory for the same resolved path use matching directories, while different paths are isolated.

## Sessions

Session files are located at:

```text
<KANA_HOME>/sessions/<encoded-workspace>/<safe-created-at>_<uuid>.jsonl
```

Creating a session only creates an in-memory UUID, creation time, working directory, optional model metadata, and optional parent-session path. The file is created only when messages are first appended; empty sessions do not appear in `/resume`.

### JSONL format

The first line is a version-1 session header. Each following line is a message entry:

```json
{"type":"session","version":1,"id":"…","createdAt":"2026-06-22T…Z","title":"Fix parser","cwd":"/repo","model":{"provider":"deepseek","model":"deepseek-v4-pro"}}
{"type":"message","id":"…","parentId":null,"timestamp":"2026-06-22T…Z","message":{"role":"user","content":"Fix parser"}}
{"type":"message","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","message":{"role":"assistant","content":[…],"stopReason":"stop"}}
```

Every append reads the current leaf ID so a new entry's `parentId` points to the preceding message entry. Current loading rebuilds the message array in file order and does not replay branches from `parentId`; the field preserves lineage. `/fork <prompt>` creates a new session and records the source session file path as `parentSessionPath` in its header.

On first write, an explicit title wins. Otherwise Kana uses the first user message, collapses whitespace, and truncates it to at most 80 JavaScript characters. With no usable text, the title is `Untitled session`.

### Lifecycle and resilience

- The Agent's `onRunCommitted` appends only this run's new messages after `agent_end`, so in-progress stream snapshots are never persisted.
- Resuming looks up sessions in the current working directory; the picker likewise shows only other sessions from that workspace.
- `listKanaSessions()` without a cwd scans all workspace directories and sorts by descending `createdAt`.
- Listing skips malformed JSONL files so one bad record does not hide other history; explicitly loading that session still errors.
- Deletion locates the file by session ID and removes it; an unknown ID returns `false`.

Session files are appended with mode `0600`. They contain complete user, assistant, and tool messages, potentially including tool results; do not treat the session directory as a non-sensitive log location.

## Memory model

Memory has two scopes:

| Scope | Durable memory | Daily staging |
| --- | --- | --- |
| `global` | `<KANA_HOME>/memory/global/memory.md` | `<KANA_HOME>/memory/global/daily/YYYY-MM-DD.md` |
| `project` | `<KANA_HOME>/memory/projects/<encoded-workspace>/memory.md` | `daily/YYYY-MM-DD.md` in the same directory |

Durable `memory.md` is compressed Markdown injected into the system prompt; a missing file is empty. `saveKanaMemory` trims surrounding whitespace, checks `memory.max_chars` by Unicode code point, writes a UUID temporary file, then atomically renames it and ensures one trailing newline.

`remember` does not modify durable memory directly. It defaults to project scope and appends non-empty content, plus optional title and reason, to the current day's Markdown staging file:

```markdown
---
id: "mem_<uuid>"
created_at: "2026-06-22T12:00:00.000Z"
scope: "project"
title: "optional title"
reason: "optional reason"
---

Durable information body
```

The host generates metadata and quotes field values as JSON strings. The date is the process-local date, not the UTC date. The daily-file reader validates date, scope, required metadata, and whole-file structure.

## Memory consolidation

After a conversation is successfully committed, a scheduler collects successful `remember` tool results from that run by scope. Jobs for different scopes are independent, but jobs in the same scope run through a promise queue, avoiding concurrent read-modify-write overwrites.

```text
successful remember
  → append today's daily file
  → Agent run commits
  → scheduler groups entries by scope
  → incremental consolidation Agent
      reads current memory.md and this batch of daily entries
      edits/replaces an in-memory transaction
      atomically saves memory.md only after normal stop with changes
```

The consolidation Agent uses the same model configuration as the main Agent but has no bash, file, or `remember` tools. Incremental mode exposes only `read_memory`, `edit_memory`, and `replace_memory`, and its input contains only current durable memory and the new entries from this batch. It does not scan historical daily files, preventing inference from unprovided history.

Every edit/replace first affects an in-memory transaction and checks the size limit before accepting the change. `commit()` occurs only when the final assistant message stopped with `stop` and the transaction changed. Abort, error, length truncation, and no-op runs never overwrite durable memory.

## Full compaction and retention

`/memory compact [user|workspace] [request]` runs full consolidation; omitting the target processes global and project memory. It gives the model current durable memory and an optional user request, and additionally exposes these read-only tools:

- `list_daily_memory`: list daily files and entry counts in an optional date range.
- `read_daily_memory`: read every entry for a given date.
- `search_daily_memory`: case-insensitively search title, reason, and body, returning at most three snippets per day.

The full Agent can still modify durable memory only through its memory transaction. When a scope ends with `stop` and `memory.daily_retention_days` is configured, Kana then removes daily files older than the retention window. The window uses local calendar days: retention 3 on the 20th keeps the 18th, 19th, and 20th. Deletion occurs only after successful full consolidation so expiring data can first contribute to durable memory.

## User commands

| Command | Behavior |
| --- | --- |
| `/memory show` | Open user and workspace durable memory in the viewer. |
| `/memory show user` | Show global memory only. |
| `/memory show workspace` | Show current project memory only. |
| `/memory compact [request]` | Compact both scopes, with an optional request. |
| `/memory compact user [request]` | Compact global memory only. |
| `/memory compact workspace [request]` | Compact current project memory only. |

Compaction can be cancelled with `Esc` or `Ctrl+C`. Completion reports `updated`, `unchanged`, `aborted`, `length`, or `error` separately for each target.

## Maintenance constraints

- Memory content is data, not instructions; the consolidation prompt explicitly forbids executing commands in it.
- Do not retain secrets or sensitive personal data. `remember` guidance covers durable preferences, confirmed decisions, and valuable unfinished work.
- Do not manually corrupt the frontmatter format in daily files; reading that date will fail.
- When changing session JSONL or memory formats, update parsers, storage tests, and this document together. These are persistent user data formats.
