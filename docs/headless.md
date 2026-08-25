# Headless execution and the JSONL protocol

`kana exec` runs an Agent task without starting the TUI, for scripts, CI, and evaluations. By default it runs one complete Agent run, which may contain several model calls, tool executions, and context compactions. With `--goal`, the prompt becomes a bounded process-local Goal and Kana continues through sequential Agent runs until the model marks it completed or blocked, it is cancelled, or it reaches `goal.max_rounds`.

## Commands

```bash
# Run a new session; arguments are joined into one prompt
kana exec fix the failing tests

# A prompt can also come from stdin
printf 'summarize this repository' | kana exec
kana exec < prompt.txt

# Resume an existing session for one more turn
kana exec resume <session-id> continue the task

# Continue a bounded Goal across sequential Agent runs
kana exec --goal finish and verify this change
kana exec resume <session-id> --goal finish the remaining work

# Write the stable JSONL event stream
kana exec --json analyze this project
kana exec resume <session-id> --json continue the analysis

# Explicitly allow every tool without interactive approval
kana exec --allow-all-tools complete this change

# Run in clean mode without saving a session
kana exec --clean inspect this project

# Gracefully cancel the Agent run after 30 minutes
kana exec --timeout 30m complete this change
kana exec resume <session-id> --timeout 30m continue the task
```

New and resumed executions are both assembled through `KanaConversationHost` and `ConversationRuntime`, so they share the TUI's model, reasoning configuration, system prompt, Skills, workspace tools, and product policies. Normal mode continues to use MCP, the V5 session journal, accounting, logging, and memory scheduling.

After the conversation runtime closes, headless shutdown aborts and awaits any unfinished automatic memory consolidation before closing MCP. A `remember` entry has already been persisted to daily staging at that point; cancellation leaves that entry intact and does not commit a partial durable-memory transaction.

`--clean` creates a temporary session that is discarded when this process exits. It still loads `config.toml`, `<KANA_HOME>/.env`, provider/model settings, OAuth, and approval rules, but it does not read global or project `AGENTS.md`, memory, Skills, or MCP configuration; connect to MCP servers; or create a session journal, session log, or accounting record. Combining `exec resume` with `--clean` fails during startup with exit status `1`; JSON mode emits the corresponding startup `error` event. Clean mode is not a sandbox or privacy boundary, and built-in tools and providers can still have external side effects.

The only deliberately omitted built-in tool is `schedule_wake`. It relies on a timer in the current process, while a headless process exits after the current run or Goal and could not honor a future wake. All other built-in tools retain the same concurrency, deadline, and result semantics. Normal mode loads MCP before execution starts: an optional-server failure produces a warning, while a required-server failure aborts startup. Clean mode skips that step entirely. Headless mode does not open a browser for MCP OAuth, so authorize servers that need interaction from the TUI first.

`--timeout <duration>` accepts a positive whole number followed by `ms`, `s`, `m`, or `h`. It is disabled by default. The deadline starts when the ordinary Agent run is submitted or the Goal is started, after prompt resolution, host/session setup, and MCP startup. In Goal mode it remains active across every admitted Agent run. Normal runtime, memory, MCP, and host cleanup remains outside the deadline. When it elapses, Kana gracefully cancels the active Goal, Agent, and tools, waits for the normal run and cleanup boundaries, and preserves work already written to the workspace and session journal. It is therefore a soft deadline: a non-cooperative external operation or cleanup can make the process return after the requested duration.

The timeout controls different work from the other limits:

| Control | Scope |
| --- | --- |
| `kana exec --timeout` | Wall-clock time for the complete headless run, including every Goal round |
| `agent.max_turns` | Number of model/tool turns in one Agent run |
| `goal.max_rounds` | Number of complete sequential Agent runs admitted for one Goal |
| Provider request timeout | One provider request or inactivity window |
| An external process/job timeout | Hard process lifetime; may interrupt Kana before graceful cleanup finishes |

## Output and exit status

The default human-readable mode writes session, tool, compaction, and unsuccessful Goal status to stderr and writes only the final assistant message's visible text to stdout. In Goal mode, intermediate assistant messages are not written to stdout. Scripts can therefore capture the final answer directly while a terminal still shows progress. Control characters are removed from model text before terminal output; `--json` preserves the text as JSON data.

Exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | A normal Agent run ended with `stop`, or a Goal ended as `completed` |
| `1` | Startup/run failed; a normal outcome was not `stop`; or a Goal ended as `blocked`, `cancelled`, or `round_limit` |
| `124` | `--timeout` elapsed; the active Goal and Agent were cancelled first |
| `130` | `SIGINT` was received; the active Goal and Agent are cancelled first |

Headless mode has no approval UI. By default it executes tools trusted by `approval.mode` and `approvals.json`. If a tool still needs interactive approval, the run ends as `aborted` without executing that tool. `--allow-all-tools` unconditionally authorizes the agent to execute every available tool: file tools retain the current user's real filesystem permissions, and `bash` still runs real system commands. The option does not isolate files or processes and should be used only in a controlled environment.

## The `--json` protocol

With `--json`, stdout contains exactly one JSON object per line. Every event has `schema_version: 2`; consumers should dispatch on `type` and ignore unfamiliar additional fields. The headless frontend projects this protocol from internal events instead of serializing `AgentEvent` directly, so internal refactoring does not silently become a public protocol change.

| `type` | Primary fields | Meaning |
| --- | --- | --- |
| `session.started` | `session_id` | A session was created or loaded |
| `warning` | `phase`, `message`, `server_id?` | Non-fatal startup warning |
| `run.started` | — | The public headless run started |
| `model_turn.started` | `turn` | A model turn started |
| `assistant.delta` | `delta` | Visible assistant-text delta |
| `assistant.completed` | `text`, `usage?` | One complete assistant message |
| `tool.started` | `tool_call_id`, `name`, `arguments` | Tool execution started |
| `tool.updated` | `tool_call_id`, `name`, `partial_result` | Tool progress update |
| `tool.completed` | `tool_call_id`, `name`, `result`, `is_error` | A tool call reached its physical terminal outcome |
| `model_turn.completed` | `turn`, `stop_reason?`, `usage?` | A model turn ended |
| `context.compaction_started` | token estimate and limit | Context compaction started |
| `context.compacted` | compaction statistics and `usage?` | The compaction checkpoint was committed |
| `run.completed` | `outcome`, `usage?`, `termination?`, `goal?` | The headless run, ordered message commits, and post-processing completed |
| `run.failed` | `error`, `termination?`, `goal?` | Infrastructure or persistence failed during the run |
| `error` | `phase`, `error` | Startup failed before an Agent run began |

Schema v2 changes `tool.completed` from a commit acknowledgement to an execution-lifecycle event. It follows physical completion, cancellation, or an explicit unknown outcome and does not imply that the tool result entered the journal. A later journal or post-processing failure therefore emits `run.failed` even if one or more `tool.completed` events are already visible; consumers that require a durable complete run must wait for `run.completed`.

Goal mode still emits exactly one public `run.started` and one terminal `run.completed` or `run.failed`. Model, assistant, tool, and compaction events from every internal Agent run appear between those boundaries; `model_turn.*.turn` is local to its Agent run and may restart at `1`. A Goal terminal event includes `goal` with `status`, `admitted_rounds`, `max_rounds`, and optional `detail` when that state is available. `run.completed.outcome` remains the final internal Agent outcome, while Goal-mode process success is determined by `goal.status`: only `completed` exits with status `0`.

When the headless frontend initiated cancellation, a terminal run event includes `termination`. A timeout is `{ "reason": "timeout", "timeout_ms": 1800000 }`; `SIGINT` is `{ "reason": "sigint" }`. A successfully cancelled timeout normally ends with `run.completed`, `outcome: "aborted"`, and exit status `124`. If the run fails while cancellation is in progress, `run.failed` remains a failure and the process exits with status `1`, even though `termination` records the concurrent cancellation source.

`usage` contains `input_tokens`, `output_tokens`, and `total_tokens`, with optional `cache_read_input_tokens`, `cache_miss_input_tokens`, and `reasoning_tokens`. `run.completed.usage` is the sum of model turns and context compactions in the complete headless run, including every Goal round. Tool `arguments`, `partial_result`, and `result` are explicitly requested machine output and may contain data processed by tools; do not upload or place JSONL in public logs without review.
