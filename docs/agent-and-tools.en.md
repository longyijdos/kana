# Agent and tool execution protocol

This document describes Kana's generic runtime protocol from a model stream to tool execution. It is for contributors reading, testing, or extending `src/core`, `src/agent`, and `src/tools`. See [Configuration and installation](configuration.en.md) for product-level configuration and approval rules.

## Three history message types

Agent history uses only three `Message` types:

| Role | Main fields | Purpose |
| --- | --- | --- |
| `user` | `content: string` | User input. |
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

Both streams support real-time consumption with `for await` and waiting for their final value with `result()`. Consumers must not mutate event messages; messages sent to Agent listeners and exposed through `state` are deep copies.

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

Kana's product default is `max_turns = -1`, but standalone `Agent`/`runAgentLoop` use 8 when no configuration is supplied. Tool calls proposed together in a single assistant message still execute serially in content order; a later call cannot start before the prior call ends.

Tools run only when an assistant message ends normally with `toolUse`. A length-truncated message never executes its tool calls. A provider error with no assistant content does not persist an empty assistant message; an aborted message loses its unexecuted tool calls but retains any remaining text or thinking content.

## `Agent` lifecycle

`Agent.stream(input)` immediately appends user input to internal history, then starts the loop asynchronously. It permits only one active run; concurrent attempts receive an error stream. `prompt(input)` is the convenience form that awaits `stream(input).result()`.

While running, `Agent.state` exposes its model, system prompt, tools, history, `isRunning`, streaming assistant message, pending tool-call IDs, and final error. `abort()` cancels the run's `AbortController`; `waitForIdle()` waits for the current run; `reset()` clears history and run state. `onRunCommitted` runs only after `agent_end`, which lets the product append session records safely.

## Tool preconditions and error semantics

Every tool call is processed in this order:

1. Find the tool by name; missing tools produce an error tool result.
2. Deep-clone raw arguments, run `TypeBox Value.Convert`, then validate using the cached compiled schema.
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

## Built-in tools

| Tool | Parameters | Behavior and result |
| --- | --- | --- |
| `read` | `path`, optional 1-based `offset`, optional `limit` (1–2000; default 200) | Reads UTF-8 text and returns the line range, total lines, and `truncated`. |
| `write` | `path`, complete `content` | Recursively creates parent directories and exclusively creates a new file; it fails if the target exists. Returns UTF-8 byte count. |
| `edit` | `path`, non-empty `oldText`, `newText`, optional `replaceAll` | Performs exact replacement in an existing UTF-8 file. One match is required by default. Returns replacement count, byte count, and before/after text. |
| `bash` | `command`, optional `cwd`, optional `timeoutMs` (1–120000; default 30000) | Runs through the user's shell in login-command mode and returns exit code, stdout, stderr, timeout, and truncation state. |
| `remember` | `content`, optional `scope`, `title`, `reason` | Records durable information in daily memory and returns the host-created memory entry. Registered only when memory is enabled. |

`bash` always disconnects stdin and defines `sudo` as `sudo -n`, preventing password prompts from taking over TUI input. It emits partial stdout/stderr roughly every 100ms while running and retains at most 20,000 JavaScript characters per stream in the final result. Each command runs in a separate process group; cancellation and timeout terminate the whole group so background children cannot remain running or keep output streams open. Once the top-level shell exits, the tool briefly drains output and returns, so background work does not block the tool result. A timeout records a `null` exit code and marks the result as an error.

`read`, `write`, `edit`, and `bash` resolve relative paths against the tool `root` (Kana's startup directory) and accept absolute paths. They are not workspace sandboxes: relative paths may escape the root, symlinks may resolve outside it, and `bash.cwd` may also be outside. Treat approval as interactive confirmation, not filesystem isolation.

## Constraints for custom tools

- Always use a TypeBox schema; the runtime has no JSON Schema fallback.
- Return a serializable structured `result` with concise, model-useful `content`.
- Check `context.signal` in long-running work and use `context.update` for progress.
- Throw actionable `Error` values for failures; the loop safely converts them into model-visible results.
- For a tool that can change user state, decide approval policy in product composition and provide understandable TUI formatting.
