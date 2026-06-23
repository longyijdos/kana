# Kana Architecture Overview

Kana is a terminal coding agent running on Bun. It keeps model calls, tool execution, and local persistence in one process, and presents the streaming workflow through a custom TUI. This document describes the implemented runtime boundaries and module relationships so contributors can trace a request from the entry point to its concrete responsibilities.

## Layers and dependency direction

```text
src/main.ts
  └─ cli                 Command parsing; starts, resumes, and installs Kana
      └─ tui             Terminal interaction, rendering, and user approval
          └─ kana        Product composition: config, prompts, sessions, memory, Skills
              ├─ logging  Session-scoped JSONL diagnostics
              ├─ agent   Model/tool loop and event protocol translation
              ├─ tools   File, shell, and remember tools
              ├─ core    Shared message, model, stream, and usage contracts
              └─ providers
                  └─ deepseek  DeepSeek requests, SSE parsing, and streaming adapter
```

`core` is the innermost protocol package: it has no dependency on product configuration or the TUI. `agent` depends only on `core` and `tools`, so it can run without a terminal UI. `kana` is the composition layer that turns these generic pieces into the Kana product; it reads state from the current workspace and `~/.kana` (or `KANA_HOME`). `tui` consumes those higher-level capabilities but does not implement model protocols or persistence formats directly.

This layering also indicates where new code belongs: new providers go in `providers`, reusable execution capabilities in `tools`, loop control in `agent`, Kana defaults and local state in `kana`, and interaction presentation in `tui`.

## Startup path

`src/main.ts` calls `runCli`. The CLI has three paths:

- `kana [prompt...]`: starts the TUI; if arguments are supplied, sends the prompt after startup.
- `kana resume [sessionId]`: restores a session by ID or opens the session picker.
- `kana install [--force] [--skills]`: creates the default config, approval file, and Skills config; `--skills` additionally clones or updates the default Skills repository.

When the TUI starts, `startTui` loads the config and approval allowlist, creates the current session, and constructs `KanaTuiApp`. It injects session I/O, Skill activation, memory compaction, and the Agent factory into the app as callbacks. The app therefore coordinates user flows without knowing JSONL, TOML, or other storage details.

## How one prompt runs

```text
User input
  → KanaTuiApp.submitPrompt
  → Agent.stream
  → runAgentLoop
  → Model.stream (DeepSeek SSE)
  → AssistantMessageEvent
  → AgentEvent
  ├─ AgentEventRenderer updates the transcript, tool blocks, and status line
  └─ Agent commits completed messages to session storage

If the model requests tools:
  Agent validates arguments → beforeToolExecution (TUI approval)
  → Tool.execute → ToolResultMessage → next model turn
```

`Message` in `core/messages.ts` is the single history format: user messages, assistant messages with ordered content blocks, and tool-result messages. Assistant content can be `text`, `thinking`, or `tool_call`; its order is preserved so it can be both sent back to the provider and displayed in model output order.

Providers first produce `AssistantMessageEvent` values. An event contains both an incremental `delta` and a complete `snapshot`: the former supports incremental rendering, while the latter means consumers do not need to reimplement message assembly. `agent` translates these into the higher-level `AgentEvent` protocol and additionally emits turn, tool-start/update/end, and run-end events. Both `AgentEventStream` and model streams support event consumption with `for await` and final-result retrieval with `result()`.

`Agent` is the stateful controller for one run. It rejects concurrent runs; `stream()` first appends user input to its internal history, then creates an `AbortController`, and commits this run's generated assistant messages and tool results to state only on `agent_end`. The `state` getter deep-clones mutable data, so callers cannot alter its in-flight history.

`runAgentLoop` defaults to at most eight turns, while Kana's default config sets it to `-1`, meaning no turn limit. Each turn first streams an assistant message; tool calls run sequentially only when the stop reason is `toolUse`. Every call goes through TypeBox validation and the optional `beforeToolExecution` hook. Rejection, cancellation, missing tools, validation errors, and tool exceptions become tool results sent back to the model; rejection or cancellation terminates the run.

## Model and provider adapters

`core/model.ts` defines `Model`: a provider only needs to provide metadata and `stream(context)`; the base class implements `generate()` by collecting a stream. `providers/index.ts` is the centralized factory. The product config currently permits only DeepSeek, while `MockModel` exists for tests.

`DeepSeekModel` converts the generic messages, system prompt, and TypeBox tool schemas into DeepSeek's OpenAI-compatible request format and sends an SSE request to `/chat/completions`. The stream parser:

1. Buffers SSE frames split by network chunks.
2. Writes reasoning, visible text, and tool-argument deltas into one ordered assistant message.
3. Infers individual DeepSeek tool-call completion from ordered indexes: a first higher index parses and ends preceding calls, while stream completion ends the final call; raw argument strings are retained.
4. Maps finish reasons and token usage.

A request can be cancelled by the Agent and is also limited by `timeoutMs`. HTTP 408, 429, and 5xx responses use exponential-backoff retries up to `maxRetries`. Model metadata also supplies the context window, output maximum, and CNY pricing; the TUI uses it to calculate context occupancy and process-lifetime accumulated cost.

## Kana product composition

`createKanaAgent` is the runtime composition point. It uses the current directory as the workspace, loads visible Skills, builds the system prompt, and registers `read`, `write`, `edit`, `bash`, and—when memory is enabled—`remember`.

The system prompt consists of the following sections; the later project-level instructions take precedence:

1. Global/project long-term memory references and `remember` guidance.
2. Global instructions from `~/.kana/AGENTS.md`, if present.
3. Project instructions from `<cwd>/AGENTS.md`, if present and distinct from the global file.
4. The current directory, platform, date, and time zone.
5. Names, descriptions, and `SKILL.md` paths for enabled Skills.

`loadKanaConfig` reads `config.toml` and merges every field with defaults. Invalid types or enum values raise an error instead of being silently ignored. Default configuration, approval data, and Skill activation data are created in user-only-readable/writable files.

## Local state

Kana state is located under `KANA_HOME`, or `~/.kana` when it is unset:

| Data | Location and format | Written when |
| --- | --- | --- |
| Configuration | `config.toml` | `kana install` or direct user edits |
| Approval allowlist | `approvals.json` | The user selects “always allow” for a bash command |
| Sessions | `sessions/<workspace>/*.jsonl` | Appended after each successfully committed Agent run |
| Runtime logs | `logs/<workspace>/<session-id>.jsonl` | Safe lifecycle events from the TUI, Agent, provider, tools, and memory tasks |
| Durable memory | `memory/global|projects/<workspace>/memory.md` | Atomically replaced after successful memory consolidation |
| Daily memory | `daily/YYYY-MM-DD.md` in the corresponding directory | Appended after `remember` succeeds |
| Global Skills config | `skills/skills.toml` | The TUI changes global Skill activation |

Workspace directory names are encoded from resolved absolute paths and shared by sessions and project memory. A session file is JSONL: the first line is a versioned session header, followed by message entries with parent IDs. Creating a session does not write a file; the header is written with the first batch of appended messages, and the first user prompt supplies its title.

Runtime logs use the same workspace encoding and the Kana session ID as their file boundary. Resuming a session appends to its existing log, while creating, forking, or switching to another session changes files. A session log manager returns a logger permanently bound to a selected session; each Agent and background task captures that concrete logger when it starts, so later lifecycle records remain attached to their originating session. Records are leveled JSONL, defaulting to `info`; `logging.level` adjusts the threshold or disables file logging with `off`. The TUI composition layer explicitly passes a logger to the Agent and provider, while `core` remains independent of logging and filesystem APIs. Logs contain only safe lifecycle metadata, never prompts, model text, complete tool input/output, request headers, or API keys; write failures are ignored and output never passes through the terminal, so logging cannot pollute the TUI.

Memory has global and project scopes. `remember` first appends a structured record to that day's staging file; after conversation commit, a scheduler starts one incremental consolidation Agent per scope. Incremental and manual full consolidation share one queue per scope, serializing all read-modify-write jobs for that scope. The consolidation Agent uses the same model but only memory tools, and commits its in-memory changes only when the assistant ends normally with `stop`. `/memory compact` starts full consolidation and can prune expired daily memory after success according to `daily_retention_days`.

Skills are discovered recursively from project `.kana/skills`, project `.agents/skills`, and global `~/.kana/skills`. Each `SKILL.md` registers its `name` and `description` frontmatter; the first discovered name wins and a collision emits a diagnostic. Project Skills are always enabled; global Skills are controlled by the list in `skills.toml`.

## Tools, approval, and safety boundaries

Tools use TypeBox schemas. Calls first run `Value.Convert`, then validation; only validated arguments reach a tool. Tool results separate provider-facing text in `content` from the structured `result` used by the Agent and TUI, so the presentation layer does not parse provider text.

- `read` reads text files with line pagination.
- `write` creates only files that do not already exist.
- `edit` performs exact string replacement in an existing file; multiple matches require explicit `replaceAll`.
- `bash` uses the user's shell, defaults to a 30-second timeout with a 120-second maximum, retains at most 20,000 characters per output stream, and emits throttled progress updates. It overrides `sudo` with non-interactive mode to prevent it from competing for TUI input.
- `remember` appends non-sensitive durable information to daily memory and never requires approval.

Approval modes are `always`, `unless_trusted`, and `never`. In the default mode, `read` passes automatically; allowlisted simple read-only bash executable names and exact bash commands pass automatically; other tools show a TUI choice prompt. A user can add only the individual bash command to the exact allowlist. The read-only command check intentionally rejects shell composition characters, path-form executables, and newlines so a seemingly read-only compound command is not treated as safe.

“Workspace tools” are not a sandbox: file paths and bash `cwd` can be absolute or leave the workspace via relative paths. File reads resolve symlinks, and writes inspect the real path of the nearest existing parent; these mechanisms provide normalized display paths and symlink handling, not access confinement. Approval is a visible user-authorization layer, not OS-level isolation.

## TUI architecture

`KanaTuiApp` owns interaction-level state: the current Agent, session ID, running flag, accumulated usage/cost, and controllers. It does not render model events to ANSI itself; `AgentEventRenderer` maps `AgentEvent` values to assistant message blocks, tool blocks, and status phases.

```text
ProcessTerminal (raw mode, input, resize, notifications)
  → Tui (focus, 16ms batching, differential redraw, hardware cursor)
    → AppLayout
      ├─ Transcript / ContentViewer
      ├─ inline ToolApproval prompt
      ├─ Editor
      ├─ Session / Skills overlays
      └─ StatusLine
```

`Tui` uses a component's `render(width): string[]` as its minimal rendering protocol. It caches the previous output and redraws only changed lines while terminal dimensions are stable; it falls back to full rendering if changed content has scrolled out of view, content shrinks, or terminal dimensions change. The editor places an internal cursor marker in logical lines; `Tui` removes it before terminal output and moves the hardware cursor to the matching visible-width column. The rendering layer uses graphemes and `string-width` for CJK, emoji, ANSI color, and line wrapping.

The main controllers handle tool approval, session selection/deletion, global Skill activation, local `!` shell commands, memory compaction, and long tool-output viewing. `Ctrl+C`/`Esc` first cancel the active Agent, local shell, or memory task; `Ctrl+C` exits when idle. `Ctrl+O` opens the most recent expandable tool output.

## Extension checkpoints

- A new provider should implement the `Model` streaming protocol, ensure event snapshots do not share mutable internal messages, and register in the `providers` factory.
- A new tool should define TypeBox parameters, structured results, and clear error semantics; call `context.update` when it has streaming progress.
- When adding a tool that can modify the workspace, review the approval policy, TUI tool presentation, and session-persistence result together.
- A new user-visible command or panel should be coordinated by the app or a dedicated controller, while components retain rendering/input responsibility.
- Before changing message, event, or session JSONL formats, inspect the DeepSeek request conversion, history rendering, persistence parser, and relevant tests. These are cross-layer contracts.

Subsequent documents can build on this overview with focused coverage of configuration and installation, the Agent/tool protocol, session and memory formats, Skills, and TUI rendering internals.
