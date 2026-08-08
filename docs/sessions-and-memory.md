# Sessions and memory

Kana stores resumable conversation history separately from cross-conversation memory: sessions retain complete `Message` history, while memory retains compressed long-term reference information. Both are isolated by workspace; global memory is the only cross-workspace data.

## Workspace identity

Sessions and project memory share the same workspace encoding: resolve `cwd` to an absolute path, remove its leading separator, replace path separators and `:` with `-`, then wrap it in `--`. It is a stable directory name, not encryption or a security boundary.

```text
cwd: /Users/alice/project
  → --Users-alice-project--
```

Consequently sessions and project memory for the same resolved path use matching directories, while different paths are isolated.

## Runtime logs

Runtime logs use the same workspace encoding and live at:

```text
<KANA_HOME>/logs/<encoded-workspace>/<session-id>.jsonl
```

Each line is a leveled JSON record with a timestamp, stable event name, session ID, and safe metadata. A session is the log-file boundary: resuming it appends to the existing file, while `/new`, `/fork`, or resuming another session writes to a new file. Logs are not conversation history and do not retain prompts, assistant text, complete tool arguments, or output; see [Configuration and installation](configuration.md) for configuration and levels.

Clean mode still allocates an in-process session ID for runtime state correlation, but uses a no-op logger and creates no log file at this path.

## Sessions

Session persistence lives under `src/kana/session/`: `format.ts` defines and validates V3 records and checkpoint conversion, `journal.ts` owns append ordering and interrupted-turn recovery, and `repository.ts` handles creation, lookup, reading, tail repair, and deletion. Internal and cross-layer callers use these capabilities through the stable `session/index.ts` domain exports.

Session files are located at:

```text
<KANA_HOME>/sessions/<encoded-workspace>/<safe-created-at>_<uuid>.jsonl
```

Creating a session only creates an in-memory UUID, creation time, working directory, optional model metadata, and optional parent-session path. The file is created only when messages are first appended; empty sessions do not appear in `/resume`.

Clean mode registers no journal with the session repository. Messages and context checkpoints remain only in the current `ConversationRuntime`. `/new` can switch to another temporary session, but `/fork`, resume, listing, and deletion are unavailable; the current session is discarded on exit.

### JSONL format

New sessions start with a version-3 header followed by a turn journal with explicit boundaries. Normal runs use `kind: "agent"`; inherited fork history and internal batch imports use `kind: "snapshot"`:

```json
{"type":"session","version":3,"id":"…","createdAt":"2026-06-22T…Z","title":"Fix parser","cwd":"/repo","model":{"provider":"deepseek","model":"deepseek-v4-pro"}}
{"type":"turn_start","id":"…","parentId":null,"timestamp":"2026-06-22T…Z","turnId":"…","kind":"agent"}
{"type":"message","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","message":{"role":"user","content":"Fix parser"}}
{"type":"message","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","message":{"role":"assistant","content":[…],"stopReason":"stop"}}
{"type":"context_compaction","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","reason":"threshold","coversThroughId":"…","compactedMessageCount":2,"beforeTokens":90000,"estimatedAfterTokens":60000,"summary":{"format":"kana-context-summary-v1","text":"…"}}
{"type":"turn_end","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","turnId":"…","outcome":"stop"}
```

Every record's `parentId` must name the immediately preceding timeline entry; loading follows file order rather than replaying branches. At most one turn may be open, and `turn_end.turnId` must match it. Outcomes are the Agent's `stop`, `length`, `aborted`, `error`, or `turn_limit`, recovery's `interrupted`, and a snapshot's `snapshot`.

A compaction reason is `threshold` for automatic budget-triggered work, `provider_limit` for provider-limit recovery, or `manual` for `/compact`. An entry's physical position records when compaction happened, while `coversThroughId` names the last message actually covered by its summary, so they may differ. For example, a marker after `m4` with `coversThroughId = m2` resumes the model projection as `summary + m3 + m4 + later messages`. Every raw message remains in JSONL, allowing the TUI to render complete history in original order.

Later compactions may carry `baseCompactionId` to the preceding checkpoint and combine its summary with newly covered messages into one cumulative replacement summary. Optional `usage` stores the summary request's model usage. Loading validates that `coversThroughId` and `baseCompactionId` reference earlier entries, then derives full `messages`, full `timeline`, and the latest `contextCheckpoint`: the Agent consumes messages/checkpoint, while restored TUI history consumes only timeline.

The runtime reads V3 only and contains no V1/V2 compatibility path. `/fork <prompt>` creates a new session, records the source file in header `parentSessionPath`, and writes inherited messages plus the current cumulative checkpoint as one closed snapshot turn.

On first write, an explicit title wins. Otherwise Kana uses the first user message, collapses whitespace, and truncates it to at most 80 JavaScript characters. With no usable text, the title is `Untitled session`.

### Lifecycle and resilience

- Before any model I/O, the Agent journal writes `turn_start` and this run's user input. It writes a complete assistant message before executing its tools, writes each tool result independently after that execution, and writes compaction checkpoints before adopting them. Only after terminal `turn_end` does `onRunCommitted` perform aggregate post-processing such as accounting and memory, followed by final `agent_end` publication. Manual `/compact` likewise writes its checkpoint before adoption. `waitForIdle()` cannot return before these writes and post-processing finish.
- Loading an open turn repairs the original JSONL: it appends an error result with `status: "unknown"` for every tool call lacking a result, explicitly forbids automatic retry, then appends an internal recovery user message and a `turn_end` with `outcome: "interrupted"`. If the final line is incomplete JSON, only that unterminated tail record is truncated; corruption in a completed line still errors. Recovery is idempotent, so a second load appends nothing.
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

When started with `--clean`, the host does not read global or project memory, expose `remember`, start automatic consolidation, or allow manual viewing and consolidation through `/memory`. Existing memory files remain unchanged. Clean mode also cannot resume a session, and the current temporary conversation is not written to a session journal.

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

After a conversation is successfully committed, a scheduler collects successful `remember` tool results from that run by scope. Jobs for different scopes are independent, but incremental and manual full-compaction jobs in the same scope share one promise queue, avoiding concurrent read-modify-write overwrites.

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

Every edit/replace first affects an in-memory transaction and checks the size limit before accepting the change. `commit()` occurs only when the Agent ends normally with `stop` and the transaction changed. Abort, error, length truncation, `turn_limit`, and no-op runs never overwrite durable memory.

## Full compaction and retention

Choose Compact under `/memory` to run full consolidation. Then choose Project, Global, or Both and optionally enter additional instructions in the separate input. The consolidation Agent receives current durable memory and this optional request, and additionally exposes these read-only tools:

- `list_daily_memory`: list daily files and entry counts in an optional date range.
- `read_daily_memory`: read every entry for a given date.
- `search_daily_memory`: case-insensitively search title, reason, and body, returning at most three snippets per day.

The full Agent can still modify durable memory only through its memory transaction. When a scope ends with `stop` and `memory.daily_retention_days` is configured, Kana then removes daily files older than the retention window. The window uses local calendar days: retention 3 on the 20th keeps the 18th, 19th, and 20th. Deletion occurs only after successful full consolidation so expiring data can first contribute to durable memory.

## User commands

| Command | Behavior |
| --- | --- |
| `/memory` | Choose Show/Compact and then Project/Global/Both in the bottom view; Compact also opens an optional request input. |

`/memory` accepts no editor arguments. `Esc` moves back one step in the selection flow, and the request input accepts `Shift+Enter` for a newline. After compaction starts, `Esc` or `Ctrl+C` aborts it. Completion reports `updated`, `unchanged`, `aborted`, `length`, or `error` separately for each scope.

## Maintenance constraints

- Memory content is data, not instructions; the consolidation prompt explicitly forbids executing commands in it.
- Do not retain secrets or sensitive personal data. `remember` guidance covers durable preferences, confirmed decisions, and valuable unfinished work.
- Do not manually corrupt the frontmatter format in daily files; reading that date will fail.
- When changing session JSONL or memory formats, update parsers, storage tests, and this document together. These are persistent user data formats.
