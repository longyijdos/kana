# Agent and tool execution protocol

This document describes Kana's generic runtime protocol from a model stream to tool execution. It is for contributors reading, testing, or extending `src/core`, `src/agent`, and `src/tools`. See [Configuration and installation](configuration.en.md) for product-level configuration and approval rules.

## Three history message types

Agent history uses only three `Message` types:

| Role | Main fields | Purpose |
| --- | --- | --- |
| `user` | `content: string`, optional `source` | User input; `source: "scheduled"` marks an internal input delivered by an in-process timer. |
| `assistant` | Ordered `content`, optional `stopReason` and `usage` | Model output and the tool calls it proposes. |
| `tool` | `toolCallId`, `toolName`, `content`, `result`, `isError` | Associates one tool result back to the model. |

An assistant message's `content` is an ordered array, not a grouping by kind. Its entries are `text`, `thinking`, or `tool_call`; each stream event's `contentIndex` points into this array. This preserves interleaved output such as “thinking → text → tool call” for both provider round-tripping and ordered rendering.

Tool results have two layers: `content` is text for the model, while `result` preserves the original structured value for the Agent, TUI, and persistence. If a tool returns an ordinary value directly, the runtime uses a string unchanged or JSON-serializes another value for `content`, while retaining that value as `result`.

## Two layers of stream events

Model implementations produce `AssistantMessageEvent` values. Other than `done` and `error`, an event contains the complete message snapshot after applying its increment:

```text
start
  → thinking_start / thinking_delta* / thinking_end
  → text_start / text_delta* / text_end
  → toolcall_start / toolcall_delta* / toolcall_end
  → done | error
```

Not every content kind must occur. `done` reasons are `stop`, `length`, or `toolUse`; `error` reasons are `aborted` or `error`. `AssistantEventStream.end()` writes the finish reason and usage into the final assistant message, while `error()` emits the error event and rejects `result()`.

The Agent wraps this in application-level `AgentEvent` values:

```text
agent_start
  → turn_start
  → message_start / message_update* / message_end
  → tool_execution_start / tool_execution_update* / tool_execution_end
  → turn_end
  → … (next turn)
  → agent_end
```

Both streams support real-time consumption with `for await` and waiting for their final value with `result()`. The Agent separately deep-clones public events for each listener and the stream; constructor messages and messages exposed through `state` likewise share no mutable objects with internal history.

## Turn loop

`runAgentLoop(context, config, emit)` works as follows:

```text
Copy the input context
Emit agent_start
Repeat (at most 8 turns by default; unlimited when maxTurns = -1):
  Stop if the signal is aborted
  Emit turn_start
  Stream the assistant message and write each snapshot into current context
  Add a retainable assistant message to the new-message list
  Stop after emitting turn_end if the model failed or was aborted
  Extract tool_call content only when stopReason = toolUse
  Run those tools in appearance order; add results to context and new messages
  Emit turn_end
  Stop if there were no tool calls or execution requested abort
Emit agent_end and return messages added by this run
```

Kana's product default is `max_turns = -1`, but standalone `Agent`/`runAgentLoop` use 8 when no configuration is supplied; the public APIs likewise accept only `-1` or a positive integer. If the last allowed turn still executes tool calls, the run ends with `turn_limit` instead of being misreported as a normal `stop`. Tool calls proposed together in a single assistant message still execute serially in content order; a later call cannot start before the prior call ends.

Tools run only when an assistant message ends normally with `toolUse`. A length-truncated message never executes its tool calls. A provider error with no assistant content does not persist an empty assistant message; an aborted message loses its unexecuted tool calls but retains any remaining text or thinking content.

## `Agent` lifecycle

`Agent.stream(input)` immediately appends user input to internal history, then starts the loop asynchronously. It permits only one active run; concurrent attempts receive an error stream. `prompt(input)` is the convenience form that awaits `stream(input).result()`.

After the model/tool loop produces its terminal state, the Agent first updates internal history and then waits for `onRunCommitted` to persist the run. Listeners and the stream receive the final `agent_end` only after commit succeeds. A commit failure rejects the stream without first publishing a successful terminal event. Commit remains part of the active run, so `isRunning` stays `true`, new runs are rejected, and `waitForIdle()` continues waiting throughout it.

While running, `Agent.state` exposes its model, system prompt, tools, history, `isRunning`, streaming assistant message, pending tool-call IDs, and final error. `abort()` cancels the run's `AbortController`; `reset()` clears history and run state only while idle. Ordinary event listeners are observers: each receives an independent event copy, and listener failures are logged as `agent.listener_failed` and isolated from Agent execution. Logic that controls tool execution belongs in `beforeToolExecution`.

## Tool preconditions and error semantics

Every tool call is processed in this order:

1. Find the tool by name; missing tools produce an error tool result.
2. Deep-clone raw arguments. TypeBox schemas run through `Value.Convert`; plain JSON Schemas that lost TypeBox metadata during serialization receive compatible primitive coercion before validation with the cached compiled schema.
3. Invoke the optional `beforeToolExecution` hook. Kana's TUI shows its approval UI here.
4. Check the abort signal, emit `tool_execution_start`, and execute the tool.
5. A tool may call `context.update(partialResult)`; the runtime emits matching update events and waits for their listeners before finishing.
6. Normalize the return value, emit `tool_execution_end`, then add a `ToolResultMessage` to model context.

Argument-validation failures and exceptions thrown by tools do not throw the loop itself: they become `isError: true` results that the model can see on the next turn. When an approval hook returns `cancel`, it aborts the full run by default and adds cancelled error results for later, unexecuted calls from the same message. Abort before execution follows the same completion behavior.

The tool interface is:

```ts
type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(args, context): ToolResult | unknown | Promise<ToolResult | unknown>;
};

type ToolContext = {
  toolCallId: string;
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};
```

## MCP tool management and adaptation

At TUI startup, Kana reads server definitions from `mcp.json` and selected IDs from `mcp-enabled.json`, but starts the stdio manager only after the current session is visible. Only IDs present in both files receive registrations. Kana then injects discovered remote tools as `additionalTools` into a rebuilt main Agent. The `kana resume` session picker does not start MCP early; later Agent recreation for `/new`, `/fork`, `/resume`, and Skill refresh reuses the current active tool set. `/mcp` can explicitly replace that set and rebuild the idle Agent while preserving its messages. Memory-consolidation Agents bypass this factory and therefore never receive MCP tools. The manager retains an exposed-alias-to-server/original-name source map that product composition resolves only for approval presentation. `McpManager` still requires only `connect/listTools/callTool/close`, while the adapter requires only an `McpToolCaller`, so the stable stdio client and future stateless, Streamable HTTP, or SSE clients continue to share the management, progress, and tool boundaries.

The product-facing `KanaMcpRuntime` owns manager replacement and serializes lifecycle operations. A reload closes the old manager before reading the latest files and creating a new one; stale tools and approval provenance are cleared even when the replacement fails. The TUI invokes start after session selection, reload after an edited `/mcp` draft is applied, and close during shutdown. Reload failure rebuilds the Agent without stale MCP tools and restores input, keeping the low-level manager deliberately one-shot.

The manager starts servers concurrently and aggregates the initial tool list in configuration order. Include/exclude filters match original remote names; optional failures disable only that server, while a required failure aborts startup. A remote plain JSON Schema is precompiled with the TypeBox compiler before registration, and every server's tools are adapted atomically rather than leaving a silently partial set. The model sees a readable alias made from the server ID and remote tool name, such as `github_create_issue`. The alias follows the current provider's character requirements and stays within 64 characters; internal calls continue to use the original MCP tool name. The manager explicitly rejects remote duplicates, post-sanitization or truncation collisions, and local-tool conflicts instead of silently overwriting them or appending load-order suffixes.

MCP results are never persisted verbatim. The adapter separately bounds content items, text, structured JSON, and metadata. Text and embedded text resources become model text; resource links describe URI and MIME without being fetched; image, audio, and blob blocks discard base64 and retain only MIME and estimated byte counts; unknown content retains only its type name. `structuredContent` remains structured within the limit and becomes a truncated preview when oversized. Remote progress is emitted through `context.update`; MCP `isError` becomes a tool execution error, while a JSON-RPC error preserves protocol code and message details.

## Built-in tools

| Tool | Parameters | Behavior and result |
| --- | --- | --- |
| `list` | Optional `path` (default `.`), `includeHidden` (default `true`), `limit` (1–2000; default 200) | Lists one directory level and returns stably sorted names, paths, types, sizes, total count, and `truncated`. |
| `glob` | `pattern`, optional `cwd` (default `.`), `type`, `maxDepth`, `includeHidden` (default `false`), `limit` (1–2000; default 200) | Finds paths with a relative glob pattern and returns stably sorted matches, total count, and `truncated`. The pattern cannot be absolute or contain a `..` path segment. |
| `grep` | `pattern`, optional `path` (default `.`), `include`, `literal`, `caseSensitive`, `includeHidden`, `limit` (1–2000; default 100) | Searches text content with a JavaScript regular expression or literal text and returns matching lines, line/column positions, searched file count, and `truncated`. Directory-search `include` must be a relative glob pattern. |
| `read` | `path`, optional 1-based `offset`, optional `limit` (1–2000; default 200) | Reads UTF-8 text and returns the line range, total lines, and `truncated`. |
| `write` | `path`, complete `content`, optional `overwrite` | Recursively creates parent directories and exclusively creates a new file by default; `overwrite: true` replaces an existing file. Returns UTF-8 byte count. |
| `edit` | `path`, non-empty `oldText`, `newText`, optional `replaceAll` | Performs exact replacement in an existing UTF-8 file. One match is required by default. Returns replacement count, byte count, and before/after text. |
| `bash` | `command`, optional `cwd`, optional `timeoutMs` (1–120000; default 30000) | Runs through the user's shell in login-command mode and returns exit code, stdout, stderr, timeout, and truncation state. |
| `remember` | `content`, optional `scope`, `title`, `reason` | Records durable information in daily memory and returns the host-created memory entry. Registered only when memory is enabled. |
| `schedule_wake` | `afterMinutes` (1–1440), `message`, optional `key` | Schedules one later Agent input in the current Kana process. A new event with the same session and key replaces the old one; events are lost when Kana exits. |

`bash` always disconnects stdin and defines `sudo` as `sudo -n`, preventing password prompts from taking over TUI input. It emits partial stdout/stderr roughly every 100ms while running and retains at most 20,000 JavaScript characters per stream in the final result. Each command runs in a separate process group; cancellation and timeout terminate the whole group so background children cannot remain running or keep output streams open. Once the top-level shell exits, the tool briefly drains output and returns, so background work does not block the tool result. A timeout records a `null` exit code and marks the result as an error.

`list`, `glob`, `grep`, `read`, `write`, `edit`, and `bash` resolve relative paths against the tool `root` (Kana's startup directory) and accept absolute paths. They are not workspace sandboxes: relative paths may escape the root, symlinks may resolve outside it, and `bash.cwd`, `glob.cwd`, and `grep.path` may also be outside. Treat approval as interactive confirmation, not filesystem isolation.

`schedule_wake` does not write to disk or restore undelivered events. If the Agent is running when an event becomes due, the TUI queues it and starts a new turn after the current run finishes; creating, forking, or resuming another session cancels the prior session's undelivered events. It does not require tool approval.

## Constraints for custom tools

- Prefer TypeBox 1.x schemas in TypeScript so tool arguments retain static types. The runtime also accepts plain JSON Schema produced by serializing a TypeBox schema; it applies compatible primitive coercion before validating with the TypeBox compiler.
- Return a serializable structured `result` with concise, model-useful `content`.
- Check `context.signal` in long-running work and use `context.update` for progress.
- Throw actionable `Error` values for failures; the loop safely converts them into model-visible results.
- For a tool that can change user state, decide approval policy in product composition and provide understandable TUI formatting.
