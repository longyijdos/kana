# Headless execution and the JSONL protocol

`kana exec` runs one complete Agent turn without starting the TUI, for scripts, CI, and evaluations. A “turn” here is not one model request: it uses the same Agent configuration as the TUI and continues through model calls, tool execution, context compaction, and subsequent model calls until the Agent reaches a terminal outcome, then exits.

## Commands

```bash
# Run a new session; arguments are joined into one prompt
kana exec fix the failing tests

# A prompt can also come from stdin
printf 'summarize this repository' | kana exec

# Resume an existing session for one more turn
kana exec resume <session-id> continue the task

# Write the stable JSONL event stream
kana exec --json analyze this project
kana exec resume <session-id> --json continue the analysis

# Explicitly allow every tool without interactive approval
kana exec --allow-all-tools complete this change

# Run in clean mode without saving a session
kana exec --clean inspect this project
```

New and resumed executions are both assembled through `KanaConversationHost` and `ConversationRuntime`, so they share the TUI's model, reasoning configuration, system prompt, Skills, workspace tools, and product policies. Normal mode continues to use MCP, the V3 session journal, accounting, logging, and memory scheduling.

After the conversation runtime closes, headless shutdown aborts and awaits any unfinished automatic memory consolidation before closing MCP. A `remember` entry has already been persisted to daily staging at that point; cancellation leaves that entry intact and does not commit a partial durable-memory transaction.

`--clean` creates a temporary session that is discarded when this process exits. It still loads `config.toml`, `<KANA_HOME>/.env`, provider/model settings, OAuth, and approval rules, but it does not read global or project `AGENTS.md`, memory, Skills, or MCP configuration; connect to MCP servers; or create a session journal, session log, or accounting record. Combining `exec resume` with `--clean` fails during startup with exit status `1`; JSON mode emits the corresponding startup `error` event. Clean mode is not a sandbox or privacy boundary, and built-in tools and providers can still have external side effects.

The only deliberately omitted built-in tool is `schedule_wake`. It relies on a timer in the current process, while a headless process exits after this turn and could not honor a future wake. All other built-in tools retain the same concurrency, deadline, and result semantics. Normal mode loads MCP before the turn starts: an optional-server failure produces a warning, while a required-server failure aborts startup. Clean mode skips that step entirely. Headless mode does not open a browser for MCP OAuth, so authorize servers that need interaction from the TUI first.

## Output and exit status

The default human-readable mode writes session, tool, and compaction progress to stderr and writes only the final assistant message's visible text to stdout. Scripts can therefore capture the answer directly while a terminal still shows progress. Control characters are removed from model text before terminal output; `--json` preserves the text as JSON data.

Exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | The Agent completed normally with `stop` |
| `1` | Startup/run failed, or the outcome was `aborted`, `error`, `length`, or `turn_limit` |
| `130` | `SIGINT` was received; the active Agent is cancelled first |

Headless mode has no approval UI. By default it executes tools trusted by `approval.mode` and `approvals.json`. If a tool still needs interactive approval, the run ends as `aborted` without executing that tool. `--allow-all-tools` unconditionally authorizes the agent to execute every available tool: file tools retain the current user's real filesystem permissions, and `bash` still runs real system commands. The option does not isolate files or processes and should be used only in a controlled environment.

## The `--json` protocol

With `--json`, stdout contains exactly one JSON object per line. Every event has `schema_version: 1`; consumers should dispatch on `type` and ignore unfamiliar additional fields. The headless frontend projects this protocol from internal events instead of serializing `AgentEvent` directly, so internal refactoring does not silently become a public protocol change.

| `type` | Primary fields | Meaning |
| --- | --- | --- |
| `session.started` | `session_id` | A session was created or loaded |
| `warning` | `phase`, `message`, `server_id?` | Non-fatal startup warning |
| `run.started` | — | The Agent run started |
| `model_turn.started` | `turn` | A model turn started |
| `assistant.delta` | `delta` | Visible assistant-text delta |
| `assistant.completed` | `text`, `usage?` | One complete assistant message |
| `tool.started` | `tool_call_id`, `name`, `arguments` | Tool execution started |
| `tool.updated` | `tool_call_id`, `name`, `partial_result` | Tool progress update |
| `tool.completed` | `tool_call_id`, `name`, `result`, `is_error` | A tool result was committed |
| `model_turn.completed` | `turn`, `stop_reason?`, `usage?` | A model turn ended |
| `context.compaction_started` | token estimate and limit | Context compaction started |
| `context.compacted` | compaction statistics and `usage?` | The compaction checkpoint was committed |
| `run.completed` | `outcome`, `usage?` | The run reached a terminal outcome |
| `run.failed` | `error` | Infrastructure or persistence failed during the run |
| `error` | `phase`, `error` | Startup failed before an Agent run began |

`usage` contains `input_tokens`, `output_tokens`, and `total_tokens`, with optional `cache_read_input_tokens`, `cache_miss_input_tokens`, and `reasoning_tokens`. `run.completed.usage` is the sum of model turns and context compactions in this run. Tool `arguments`, `partial_result`, and `result` are explicitly requested machine output and may contain data processed by tools; do not upload or place JSONL in public logs without review.
