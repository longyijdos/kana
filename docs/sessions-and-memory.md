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

Session persistence lives under `src/kana/session/`: `format.ts` defines and validates V5 records and checkpoint conversion, `journal.ts` owns append ordering and interrupted-turn recovery, and `repository.ts` handles creation, lookup, reading, tail repair, and deletion. Internal and cross-layer callers use these capabilities through the stable `session/index.ts` domain exports.

Session files are located at:

```text
<KANA_HOME>/sessions/<encoded-workspace>/<safe-created-at>_<uuid>.jsonl
```

Creating a session only creates an in-memory UUID, creation time, working directory, optional model metadata, and optional parent-session path. The file is created only when messages are first appended; empty sessions do not appear in `/resume`.

Clean mode registers no journal with the session repository. Messages and context checkpoints remain only in the current `ConversationRuntime`. `/new` can switch to another temporary session, but `/fork`, resume, listing, and deletion are unavailable; the current session is discarded on exit.

### JSONL format

New sessions start with a version-5 header followed by a turn journal with explicit boundaries. Normal runs use `kind: "agent"`; inherited fork history and internal batch imports use `kind: "snapshot"`:

```json
{"type":"session","version":5,"id":"…","createdAt":"2026-06-22T…Z","title":"Fix parser","cwd":"/repo","model":{"provider":"deepseek","model":"deepseek-v4-pro"}}
{"type":"turn_start","id":"…","parentId":null,"timestamp":"2026-06-22T…Z","turnId":"…","kind":"agent"}
{"type":"message","id":"entry-u1","parentId":"…","timestamp":"2026-06-22T…Z","message":{"id":"message-u1","role":"user","provenance":{"kind":"user_input"},"content":"Fix parser"}}
{"type":"message","id":"entry-c1","parentId":"entry-u1","timestamp":"2026-06-22T…Z","message":{"id":"message-c1","role":"user","provenance":{"kind":"runtime_context","source":"environment"},"content":"<runtime_context source=\"environment\">…</runtime_context>"}}
{"type":"message","id":"entry-a1","parentId":"entry-c1","timestamp":"2026-06-22T…Z","message":{"id":"message-a1","role":"assistant","provenance":{"kind":"model_output"},"content":[…],"stopReason":"stop"}}
{"type":"todo_state","id":"…","parentId":"entry-a1","timestamp":"2026-06-22T…Z","toolCallId":"call-todo-1","items":[{"content":"Fix parser","status":"in_progress"}]}
{"type":"context_compaction","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","reason":"threshold","coversThroughId":"…","compactedMessageCount":2,"beforeTokens":90000,"estimatedAfterTokens":60000,"summary":{"format":"kana-context-summary-v1","text":"…"}}
{"type":"turn_end","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","turnId":"…","outcome":"stop"}
```

User and tool-result messages may include `images`, with each entry storing `mimeType`, raw base64 `data`, `width`, and `height`. These bytes are inline rather than external file references, so both user attachments and agent-initiated visual observations remain self-contained after the source file or clipboard changes. The tool's structured `result` contains only metadata and does not duplicate the image bytes. The tradeoff is larger JSONL files—base64 adds overhead on top of the normalized image—so the sessions directory may grow noticeably in image-heavy conversations. Context token estimation uses 32-pixel image patches instead of base64 length. Loading rejects malformed image arrays, unsupported MIME types, non-string data, and non-positive or fractional dimensions on either role.

Dynamic prompt state uses an internal user-role message with `provenance.kind: "runtime_context"` and a non-empty `source`. Every source renderer must return an explicit non-empty active or inactive state. An initially inactive source writes nothing; after activation, the Agent journals each changed state. These transitions remain append-only in JSONL and in model input until compaction. Stable system instructions make only the last transition for each source authoritative, and a source-defined `status="inactive"` body invalidates its earlier states. The `environment` source is recomputed from the process; the `todo` source is a read-only projection of the authoritative `todo_state`. Restored TUI history hides all runtime-context messages because they are not human input.

A `todo_state` entry stores one complete accepted list and, for a tool-driven update, the owning `toolCallId`. The journal writes it synchronously after `todo_write` validation and before the compact tool result, so a crash cannot leave an acknowledged update without durable state. Loading scans these entries to reconstruct the latest list; empty `items` explicitly clears it, while an all-`completed` list and a new human turn leave it intact. If interruption occurs after the state entry but before the result, recovery synthesizes the deterministic successful acknowledgement rather than marking that call unknown. Clean mode keeps the same state transitions in memory without writing JSONL.

Tool-result policies may append another internal user-role message with `provenance.kind: "tool_result_policy"` and a non-empty policy `source`. It is journaled after the complete sibling tool-result group and replayed before the next model request. Session resume preserves it for model continuity, while restored TUI history and automatic session-title selection hide it because it is not human input.

An oversized text tool result may instead retain a bounded `content` preview plus `artifact: { kind: "text", locator, byteLength }`, with no structured `result`. The complete UTF-8 text then lives at:

```text
<KANA_HOME>/artifacts/<encoded-workspace>/<session-id>/<uuid>-<safe-stem>.txt
```

Artifact roots, workspace directories, and session directories use owner-only `0700`; files use unpredictable names, exclusive no-follow creation, and `0600`. Suggested names are reduced to a traversal-safe stem. The absolute locator is intentionally consumable by the existing `read` and `grep` tools, while artifact metadata lets resume and lifecycle code validate ownership and byte length without parsing the model-facing notice. Restored TUI history also uses that metadata for a compact stored-output summary and exposes the locator only in the tool detail inspector. Artifact text can contain the same sensitive tool output that would otherwise have entered the session, so this directory is private user data rather than a general file manager. Clean mode uses a lazy process-scoped temporary directory and removes it during orderly shutdown instead of creating this durable path.

Compaction follows the selected model's effective image-input capability. When the model supports images and `image_input` is enabled, Kana sends user attachments and tool visual observations with ordered index, MIME, and dimension metadata so the summary can preserve relevant visual information as text; base64 does not appear inside the textual transcript JSON. When image input is unsupported or disabled, compaction sends only that metadata with `contentOmitted: true` and continues without image bytes. This makes switching to a text-only model such as DeepSeek safe, but image-only details that were not already described in text may be absent from the resulting summary. The original self-contained images remain in the session JSONL.

Every record's `parentId` must name the immediately preceding timeline entry; loading follows file order rather than replaying branches. A message record's outer `id` identifies and orders the journal entry, while `message.id` identifies the logical message across Agent events, inbox movement, persistence, replay, and forks. These are separate identity domains. Every message has required discriminated `provenance`, and a session rejects duplicate logical message IDs. At most one turn may be open, and `turn_end.turnId` must match it. Outcomes are the Agent's `stop`, `length`, `aborted`, `error`, or `turn_limit`, recovery's `interrupted`, and a snapshot's `snapshot`.

A compaction reason is `threshold` for automatic budget-triggered work, `provider_limit` for provider-limit recovery, or `manual` for `/compact`. An entry's physical position records when compaction happened, while `coversThroughId` names the last message actually covered by its summary, so they may differ. For example, a marker after `m4` with `coversThroughId = m2` resumes the model projection as `summary + m3 + m4 + later messages`. Runtime-context messages are omitted from summary generation. The last state for each source at the checkpoint boundary is reprojected after the summary only when active, and every transition after the boundary remains in original order. Covered superseded and inactive transitions leave model input with the other covered raw messages. Every raw message remains in JSONL, allowing the TUI to render the complete user-visible history in original order.

Later compactions may carry `baseCompactionId` to the preceding checkpoint and combine its summary with newly covered messages into one cumulative replacement summary. Optional `usage` stores the summary request's model usage. Loading validates that `coversThroughId` and `baseCompactionId` reference earlier entries, then derives full `messages`, full `timeline`, and the latest `contextCheckpoint`: the Agent consumes messages/checkpoint, while restored TUI history consumes only timeline. Assistant messages keep their provider usage in JSONL, so the Agent can rebuild its context-estimate anchor from the latest clean response on resume; the anchor is ignored when it predates the current checkpoint or the response contained hosted tools.

The runtime reads V5 only and contains no pre-V5 compatibility path. `/fork <prompt>` creates a new session, records the source file in header `parentSessionPath`, and writes inherited messages, the current cumulative checkpoint, and a by-value copy of the latest todo state as one closed snapshot turn. Inherited messages preserve their logical `message.id` values; only the fork's journal entry IDs are new.

On first write, an explicit title wins. Otherwise Kana uses the first user-role message that is neither recovery, runtime context, nor tool-result-policy context, then collapses whitespace and truncates it to at most 80 JavaScript characters. With no usable text, the title is `Untitled session`.

### Lifecycle and resilience

- Before any model I/O, the Agent journal writes `turn_start`, this run's user input, and any changed runtime-context state transition. It writes a complete assistant message before executing its tools; an accepted `todo_write` then writes `todo_state` before its compact tool result. Other tool results are likewise written independently after execution, followed by any source-tagged tool-result-policy context before the next model request. Compaction checkpoints are written before adoption. Only after terminal `turn_end` does `onRunCommitted` perform aggregate post-processing such as accounting and memory, followed by final `agent_end` publication. Manual `/compact` likewise writes its checkpoint before adoption. `waitForIdle()` cannot return before these writes and post-processing finish.
- Loading an open turn repairs the original JSONL: it appends an error result with `status: "unknown"` for every tool call lacking a result, explicitly forbids automatic retry, then appends an internal recovery user message and a `turn_end` with `outcome: "interrupted"`. If the final line is incomplete JSON, only that unterminated tail record is truncated; corruption in a completed line still errors. Recovery is idempotent, so a second load appends nothing.
- Resume reconstructs committed journal messages, the latest context checkpoint, and the latest todo state. The Agent inbox and future scheduled wakes remain process-local: switching, forking, or resuming a session and exiting Kana discard them rather than restoring them.
- Resume audits every retained artifact against that session's managed directory, regular-file type, and recorded byte length. Missing or invalid references produce safe diagnostics but do not make the journal unreadable or alter its bounded preview.
- Fork copies every retained artifact into the target session's private directory before the snapshot is registered, then rewrites locators in inherited tool messages and the cumulative checkpoint summary. Source and fork therefore remain independently deletable. A copy or rewrite failure aborts the fork and rolls back the target directory best-effort.
- Resuming looks up sessions in the current working directory; the picker likewise shows only other sessions from that workspace.
- `listKanaSessions()` without a cwd scans all workspace directories and sorts by descending `createdAt`.
- Listing skips malformed JSONL files so one bad record does not hide other history; explicitly loading that session still errors.
- Deletion locates the file by session ID and removes it; after a successful journal deletion, Kana best-effort removes the matching artifact directory. An unknown ID returns `false`.
- Normal-mode startup performs conservative orphan cleanup with a 24-hour grace period. It removes aged artifact directories that have no matching session journal and aged files whose JSON-encoded locator is absent from an existing journal. Recent files, referenced files, symlinks, malformed paths, and cleanup failures are left alone or reported rather than risking broad deletion.

Session files are appended with mode `0600`. They contain complete user, assistant, and tool messages, including inline results or bounded artifact metadata; do not treat either the session or artifact directory as a non-sensitive log location.

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

Automatic consolidation is process-owned background work. During TUI or headless shutdown, the host stops new automatic scheduling, aborts running or queued consolidation Agents from every scheduler it created (including schedulers replaced by model reconfiguration), and awaits their settlement before closing external resources. The `remember` entry already stored in daily staging remains intact, while an aborted in-memory transaction does not modify durable `memory.md`.

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
