# Kana Architecture Overview

Kana is a general-purpose terminal agent running on Bun. It keeps model calls, tool execution, and local persistence in one process, and presents the streaming workflow through a custom TUI. This document describes the implemented runtime boundaries and module relationships so contributors can trace a request from the entry point to its concrete responsibilities.

## Layers and dependency direction

```text
src/main.ts
  └─ cli                 Command parsing; starts, resumes, and installs Kana
      └─ tui             Terminal interaction, rendering, and user approval
          └─ kana        Product composition: config, prompts, sessions, memory, Skills
              ├─ logging  Session-scoped JSONL diagnostics
              ├─ mcp      MCP JSON-RPC connections, protocol clients, and transports
              ├─ agent   Model/tool loop and event protocol translation
              ├─ tools   File, shell, and remember tools
              ├─ core    Shared message, model, stream, and usage contracts
              └─ providers
                  └─ deepseek  DeepSeek requests, SSE parsing, and streaming adapter
```

`core` is the innermost protocol package: it has no dependency on product configuration or the TUI. `agent` depends only on `core` and `tools`, so it can run without a terminal UI. `mcp` is likewise independent from Kana product composition and the Agent loop; it provides reusable MCP wire, connection, and transport capabilities. `kana` is the composition layer that turns these generic pieces into the Kana product; it reads state from the current workspace and `~/.kana` (or `KANA_HOME`). `tui` consumes those higher-level capabilities but does not implement model protocols or persistence formats directly.

This layering also indicates where new code belongs: new providers go in `providers`, reusable execution capabilities in `tools`, loop control in `agent`, Kana defaults and local state in `kana`, and interaction presentation in `tui`.

## Startup path

`src/main.ts` calls `runCli`. The CLI has three paths:

- `kana [prompt...]`: starts the TUI; if arguments are supplied, sends the prompt after startup.
- `kana resume [sessionId]`: restores a session by ID or opens the session picker.
- `kana install [--force] [--skills]`: creates the default config, approval file, and Skills config; `--skills` additionally clones or updates the default Skills repository.
- `kana skills sync <target>`: copies installed Kana Skills into another agent's Skills directory; the built-in target is currently `codex`, and a custom directory can also be supplied.

When the TUI starts, `startTui` loads runtime configuration and the approval allowlist, then constructs `KanaTuiApp` with an idle `KanaMcpRuntime`. Only after the current session is known and the first TUI view is displayed does the app invoke its injected external-tool loader; the runtime then reads MCP definition and activation files, connects selected servers, discovers their tools, and lets the app rebuild the main Agent. The `kana resume` picker therefore does not start MCP; loading begins after a session is selected. Session I/O, Skill and MCP activation, memory compaction, external-tool start/reload, and the Agent factory are all injected as callbacks. The app therefore coordinates user flows without knowing JSONL, TOML, MCP transports, or other storage and protocol details.

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

`runAgentLoop` defaults to at most eight turns, while Kana's default config sets it to `-1`, meaning no turn limit. Each turn first streams an assistant message; tool calls run sequentially only when the stop reason is `toolUse`. Every call goes through TypeBox 1.x validation and the optional `beforeToolExecution` hook; plain schemas that lost TypeBox metadata during JSON serialization can be validated by the same compiler. Rejection, cancellation, missing tools, validation errors, and tool exceptions become tool results sent back to the model; rejection or cancellation terminates the run.

## Model and provider adapters

`core/model.ts` defines `Model`: a provider only needs to provide metadata and `stream(context)`; the base class implements `generate()` by collecting a stream. `providers/index.ts` is the centralized factory. The product config currently permits only DeepSeek, while `MockModel` exists for tests.

`DeepSeekModel` converts the generic messages, system prompt, and tool JSON Schemas into DeepSeek's OpenAI-compatible request format and sends an SSE request to `/chat/completions`. The stream parser:

1. Buffers SSE frames split by network chunks.
2. Writes reasoning, visible text, and tool-argument deltas into one ordered assistant message.
3. Infers individual DeepSeek tool-call completion from ordered indexes: a first higher index parses and ends preceding calls, while stream completion ends the final call; raw argument strings are retained.
4. Maps finish reasons and token usage.

A request can be cancelled by the Agent and is also subject to the `timeoutMs` inactivity timeout, which restarts on response headers or response data. HTTP 408, 429, and 5xx responses use exponential-backoff retries up to `maxRetries`. Model metadata also supplies the context window, output maximum, and CNY pricing; the TUI uses it to calculate context occupancy and process-lifetime accumulated cost.

## MCP protocol foundation

`src/mcp` implements MCP with the following dependency direction, keeping remote-tool logic out of the Agent loop and provider adapters:

```text
McpManager (multi-server lifecycle, filtering, conflicts, diagnostics)
  ├→ McpToolAdapter → Tool
  └→ McpManagedClient
      → McpClient (2025-11-25 lifecycle, capabilities, tools/list, tools/call)
        → McpConnection (request IDs, out-of-order responses, timeouts, cancellation, progress, ping)
          → McpTransport (bidirectional JSON-RPC message boundary)
            → StdioTransport (subprocess, line-delimited UTF-8 framing, stderr, shutdown order)
```

`McpConnection` does not initialize sessions or know about version-specific features such as tools. A future stateless protocol client can therefore reuse it without inheriting the `2025-11-25` handshake. `StdioTransport` only delivers messages and never negotiates versions or capabilities. Streamable HTTP and legacy SSE will implement the same transport boundary independently instead of reusing stdio process state.

The current foundation client strictly follows the published `2025-11-25` lifecycle: `initialize` is the first request, and the client sends `notifications/initialized` after negotiating that same version. It paginates `tools/list` and invokes `tools/call` only when the server declares the tools capability. Every request has a fixed maximum timeout. Normal requests send `notifications/cancelled` after timing out or when aborted through an `AbortSignal`, while `initialize`, which the specification forbids clients from cancelling, does not. Progress tokens are unique among active requests and increasing updates are delivered through caller callbacks.

The stdio transport launches an argument array directly without a shell. stdout accepts only one JSON-RPC message per line and enforces a byte limit. Protocol pollution, invalid UTF-8 or JSON, non-zero exits, and incomplete messages close the connection and reject pending requests. stderr remains separate from the protocol and is forwarded through a protected diagnostic callback. Graceful shutdown closes stdin, waits for the process, sends SIGTERM, and sends SIGKILL after a second timeout.

`McpToolAdapter` depends only on the structural `McpToolCaller` interface, not on the stable client or stdio. At discovery time it precompiles the remote `inputSchema`, generates a readable model alias of at most 64 characters from the server ID and remote tool name, and maps MCP progress to `ToolContext.update`. Result adaptation bounds content items, text, structured data, and metadata. Text and embedded text resources may enter model context; resource links become descriptions; images, audio, and blobs retain only MIME and estimated byte counts, never persisted base64. JSON-RPC errors and MCP `isError` results retain distinct structured error semantics.

`McpManager` depends only on the structural `McpManagedClient` interface and does not create a concrete protocol client or transport. It starts servers concurrently but aggregates tools stably in registration order; include/exclude filters match original remote names. A connection, discovery, or schema-adaptation failure from an optional server records diagnostics and closes only that server, while a required-server failure closes every connection and aborts startup. Each server's tools are adapted atomically. Duplicate remote names fail that server; post-sanitization or truncation alias collisions and conflicts with reserved local tools fail the entire aggregation instead of being silently overwritten or assigned order-dependent suffixes. Shutdown is idempotent and closes clients in reverse registration order.

The manager freezes its discovered tool list and does not process `notifications/tools/list_changed`. The `kana` layer parses server definitions from `mcp.json`, reads selected IDs from the separate `mcp-enabled.json`, and creates registrations only for their intersection. This activation boundary is independent of protocol and transport. The factory creates stdio registrations from `type`-discriminated server config; an omitted `type` defaults to stdio. It constructs one `StdioTransport` and stable `McpClient` per selected server, inherits only a small baseline environment before merging the server's explicit `env`, and forwards stderr, client errors, and manager errors to the current session logger. Product composition first creates a temporary main Agent with no external tools. After the session is visible it starts the manager and rebuilds the Agent with the discovered tools. The app rejects submissions during loading, so the temporary Agent cannot begin a run; memory-consolidation Agents never receive these external tools. During shutdown, the app first cancels and awaits the active Agent, then product composition closes the manager.

`KanaMcpRuntime` owns the replaceable manager at the product boundary; `McpManager` itself remains deliberately one-shot. The runtime serializes `start`, `reload`, and `close`, and labels low-level progress with the enclosing runtime operation. Reload closes the current manager before rereading definitions and activation state, then creates a fresh manager. This avoids overlapping server processes and keeps transport/protocol lifecycle outside the TUI. A parse or startup failure never leaves tools or source mappings from the closed manager active, while a later `/mcp` reload may recover from corrected files. Once shutdown is requested, queued lifecycle work cannot start another manager.

## Kana product composition

`createKanaAgent` is the runtime composition point. It uses the current directory as the workspace, loads visible Skills, builds the system prompt, registers `list`, `glob`, `grep`, `read`, `write`, `edit`, `bash`, and optional built-ins, then appends product-supplied `additionalTools` after validating unique names.

The system prompt consists of the following sections; the later project-level instructions take precedence:

1. Global/project long-term memory references and `remember` guidance.
2. Built-in default assistant instructions.
3. Global instructions from `~/.kana/AGENTS.md`, if present.
4. Project instructions from `<cwd>/AGENTS.md`, if present and distinct from the global file.
5. The current directory, platform, date, and time zone.
6. Names, descriptions, and `SKILL.md` paths for enabled Skills.

`loadKanaConfig` reads `config.toml` and merges every field with defaults. Invalid types or enum values raise an error instead of being silently ignored. Default configuration, approval data, and Skill activation data are created in user-only-readable/writable files.

## Local state

Kana state is located under `KANA_HOME`, or `~/.kana` when it is unset:

| Data | Location and format | Written when |
| --- | --- | --- |
| Configuration | `config.toml` | `kana install` or direct user edits |
| MCP server definitions | `mcp.json` | `kana install` or direct user edits |
| MCP activation state | `mcp-enabled.json` | `kana install` or activation changes |
| Approval allowlist | `approvals.json` | The user selects “always allow” for a bash command |
| Sessions | `sessions/<workspace>/*.jsonl` | Appended after each successfully committed Agent run |
| Runtime logs | `logs/<workspace>/<session-id>.jsonl` | Safe lifecycle events from the TUI, Agent, provider, tools, and memory tasks |
| Durable memory | `memory/global|projects/<workspace>/memory.md` | Atomically replaced after successful memory consolidation |
| Daily memory | `daily/YYYY-MM-DD.md` in the corresponding directory | Appended after `remember` succeeds |
| Global Skills config | `skills/skills.toml` | The TUI changes global Skill activation |

Workspace directory names are encoded from resolved absolute paths and shared by sessions and project memory. A session file is JSONL: the first line is a versioned session header, followed by message entries with parent IDs. Creating a session does not write a file; the header is written with the first batch of appended messages, and the first user prompt supplies its title.

Runtime logs use the same workspace encoding and the Kana session ID as their file boundary. Resuming a session appends to its existing log, while creating, forking, or switching to another session changes files. A session log manager returns a logger permanently bound to a selected session; each Agent and background task captures that concrete logger when it starts, so later lifecycle records remain attached to their originating session. Records are leveled JSONL, defaulting to `info`; `logging.level` adjusts the threshold or disables file logging with `off`. The TUI composition layer explicitly passes a logger to the Agent and provider, while `core` remains independent of logging and filesystem APIs. Logs contain only safe lifecycle metadata, never prompts, model text, complete tool input/output, request headers, or API keys; write failures are ignored and output never passes through the terminal, so logging cannot pollute the TUI.

Memory has global and project scopes. `remember` first appends a structured record to that day's staging file; after conversation commit, a scheduler starts one incremental consolidation Agent per scope. Incremental and manual full consolidation share one queue per scope, serializing all read-modify-write jobs for that scope. The consolidation Agent uses the same model but only memory tools, and commits its in-memory changes only when the assistant ends normally with `stop`. Choosing Compact in the `/memory` flow starts full consolidation and can prune expired daily memory after success according to `daily_retention_days`.

Skills are discovered recursively from project `.kana/skills`, project `.agents/skills`, and global `~/.kana/skills`. Each `SKILL.md` registers its `name` and `description` frontmatter; the first discovered name wins and a collision emits a diagnostic. Project Skills are always enabled; global Skills are controlled by the list in `skills.toml`.

## Tools, approval, and safety boundaries

Tools preferentially use TypeBox 1.x schemas. Calls first convert and compile-validate arguments; only validated values reach a tool. TypeBox metadata is lost during JSON serialization, so Kana adds compatible primitive coercion for those plain JSON Schemas before validating them with the same TypeBox compiler. Tool results separate provider-facing text in `content` from the structured `result` used by the Agent and TUI, so the presentation layer does not parse provider text.

- `list` lists one directory level, `glob` finds paths with a relative pattern, and `grep` searches text content; all three provide controlled read-only exploration.
- `read` reads text files with line pagination.
- `write` creates only files that do not already exist by default, and can replace existing files with explicit `overwrite`.
- `edit` performs exact string replacement in an existing file; multiple matches require explicit `replaceAll`.
- `bash` uses the user's shell, defaults to a 30-second timeout with a 120-second maximum, retains at most 20,000 characters per output stream, and emits throttled progress updates. Each command has a separate process group; cancellation and timeout terminate the whole group, and the tool briefly drains output after the top-level shell exits before returning so background children cannot stall a tool call. It overrides `sudo` with non-interactive mode to prevent it from competing for TUI input.
- `remember` appends non-sensitive durable information to daily memory and never requires approval.

Approval modes are `always`, `unless_trusted`, and `never`. In the default mode, `list`, `glob`, `grep`, and `read` pass automatically; allowlisted simple read-only bash executable names and exact bash commands pass automatically; other tools show a TUI choice prompt. A user can add only the individual bash command to the exact allowlist. The read-only command check intentionally rejects shell composition characters, path-form executables, and newlines so a seemingly read-only compound command is not treated as safe.

“Workspace tools” are not a sandbox: file paths, `bash.cwd`, `glob.cwd`, and `grep.path` can be absolute or leave the workspace via relative paths. File reads resolve symlinks, and writes inspect the real path of the nearest existing parent; these mechanisms provide normalized display paths and symlink handling, not access confinement. Approval is a visible user-authorization layer, not OS-level isolation.

## TUI architecture

`KanaTuiApp` owns interaction-level state: the current Agent, session ID, running flag, accumulated usage/cost, and controllers. It does not render model events to ANSI itself; `AgentEventRenderer` maps `AgentEvent` values to assistant message blocks, tool blocks, and status phases.

```text
ProcessTerminal (raw mode, input, resize, notifications)
  → Tui (focus, 16ms batching, differential redraw, hardware cursor)
    → AppLayout
      ├─ Main (currently Transcript; terminal scrollback)
      └─ Bottom (exactly one; tiered height)
         ├─ Editor (input and status line)
         ├─ ToolApproval
         ├─ Session / Skills / MCP view
         └─ ContentViewer
```

`Tui` uses a component's `render(width, availableHeight?): string[]` as its minimal rendering protocol. `AppLayout` converts terminal height into a 15-, 12-, 9-, or 7-row bottom budget; terminals shorter than 7 rows use all available rows. It passes the remainder to main. The layout renders the first bottom row as the main/bottom divider, passes the remaining budget to the bottom component, and pads shorter output to stabilize the boundary. Transcript deliberately ignores the remaining-height hint and renders complete history for terminal scrollback. It inserts one blank row between child blocks that render output, while blocks own only their internal spacing. `Tui` caches the previous output and redraws only changed lines while terminal dimensions are stable; it falls back to full rendering if changed content has scrolled out of view, content shrinks, or terminal dimensions change. The editor places an internal cursor marker in logical lines, which `Tui` removes before terminal output. It moves the hardware cursor to the matching visible-width column only when a component is focused; without focus it keeps the cursor hidden at the layout tail. The rendering layer uses graphemes and `string-width` for CJK, emoji, ANSI color, and line wrapping.

The main controllers handle tool approval, session selection/deletion, global Skill activation, MCP server activation, local `!` shell commands, memory compaction, and long tool-output viewing. Session, Skill, MCP, approval, and content views replace the editor as the single bottom component. The MCP controller keeps checkbox edits local until `Esc`, persists a changed selection once, and asks the app to reload; the component receives server ID, transport, command, and arguments so it can display the full command line, but never receives environment values. Scheduled wakes remain queued while this view is open or reload is active. An approval that arrives while another bottom view is active remains pending and sends its configured notification instead of preempting the current view. `Ctrl+C`/`Esc` first cancel the active Agent, local shell, or memory task; `Ctrl+C` exits when idle. `Ctrl+O` opens the most recent expandable tool output.

## Extension checkpoints

- A new provider should implement the `Model` streaming protocol, ensure event snapshots do not share mutable internal messages, and register in the `providers` factory.
- A new tool should define TypeBox parameters, structured results, and clear error semantics; call `context.update` when it has streaming progress.
- When adding a tool that can modify the workspace, review the approval policy, TUI tool presentation, and session-persistence result together.
- A new user-visible command or panel should be coordinated by the app or a dedicated controller, while components retain rendering/input responsibility.
- Before changing message, event, or session JSONL formats, inspect the DeepSeek request conversion, history rendering, persistence parser, and relevant tests. These are cross-layer contracts.

Subsequent documents can build on this overview with focused coverage of configuration and installation, the Agent/tool protocol, session and memory formats, Skills, and TUI rendering internals.
