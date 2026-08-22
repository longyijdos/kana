# Agent and tool execution protocol

This document describes Kana's generic runtime protocol from a model stream to tool execution. It is for contributors reading, testing, or extending `src/core`, `src/agent`, and `src/tools`. See [Configuration and installation](configuration.md) for product-level configuration and approval rules.

## Three history message types

Agent history uses only three `Message` types:

| Role | Main fields | Purpose |
| --- | --- | --- |
| `user` | `id`, required `provenance`, `content: string` | Direct, scheduled, recovery, runtime-context, context-summary, or compaction-policy input. |
| `assistant` | `id`, `provenance: { kind: "model_output" }`, ordered `content`, optional `stopReason` and `usage` | Model output and the tool calls it proposes. |
| `tool` | `id`, `provenance: { kind: "tool_result" }`, `toolCallId`, `toolName`, `content`, `result`, `isError` | Associates one tool result back to the model. |

Every logical message receives one branded `MessageId` when it enters Kana or is produced internally. Cloning, steering, movement between inbox lanes, Agent events, journal persistence/replay, forks, and model history preserve that ID. It is distinct from a journal entry ID, run/turn ID, provider tool-call ID, and session ID. Required discriminated `provenance` records the content producer or internal purpose; presentation uses it instead of assuming every `user`-role message was typed by a person. `runtime_context` provenance includes a stable `source` such as `environment`, allowing independent providers to compare and project their own state without inspecting another provider's content. Duplicate logical IDs are rejected in Agent history, the inbox, and session journals.

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
  → turn_input* (when the current run has pending input)
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
  Resolve the prompt assembly for this model step
  Commit and append changed runtime-context snapshots or one-time inactive markers
  Stream the assistant message and write each snapshot into current context
  Add a retainable assistant message to the new-message list
  Stop after emitting turn_end if the model failed or was aborted
  Extract tool_call content only when stopReason = toolUse
  Run those tools in appearance order; add results to context and new messages
  Emit turn_end
  Stop if execution requested abort
  If another turn is available, commit queued turn input, add it to context, and emit turn_input for each message
  Stop if there were neither tool calls nor turn input
Emit agent_end and return messages added by this run
```

Kana's product default is `max_turns = -1`, but standalone `Agent`/`runAgentLoop` use 8 when no configuration is supplied; the public APIs likewise accept only `-1` or a positive integer. If the last allowed turn still executes tool calls, the run ends with `turn_limit` instead of being misreported as a normal `stop`. Turn input is consumed only after a complete model/tool turn and after confirming that another turn can start; abort or the turn limit leaves it for the Agent owner to defer. `runAgentLoop` owns only the model-turn state machine and delegates tool calls to an independent `ToolRuntime`. Prompt assembly resolves context and capability-owned tool sections before every model step. The resulting tools are both advertised in that request and passed to its ToolRuntime; only a later model step may observe a refreshed set. Parallel policy resolves once at the start of each run: `AgentConfig.parallelToolCalls` (Kana's `agent.parallel_tool_calls`) must be enabled and model metadata `supportsParallelToolCalls` must be true. Otherwise the provider receives a false `ModelContext.parallelToolCalls` and the runtime executes calls one at a time. `AgentConfig.maxParallelToolCalls` (Kana's `agent.max_parallel_tool_calls`) is always a positive integer and defaults to 4, but affects scheduling only when that parallel policy is effective. When parallelism is allowed, the runtime partitions calls in assistant-content order: only adjacent calls explicitly marked `parallel` share a concurrent group. An `exclusive`, undeclared, unknown, or invalidly configured tool is a barrier that read work cannot cross.

Tools run only when an assistant message ends normally with `toolUse`. A length-truncated message never executes its tool calls. A provider error with no assistant content does not persist an empty assistant message; an aborted message loses its unexecuted tool calls but retains any remaining text or thinking content.

## Context compaction

When a `ContextManager` is configured, every model request first receives a separate model projection of the full Agent history; compaction never deletes the original `messages`. That projection contains only the latest currently active runtime-context snapshot for each source, so replaced values and inactive markers remain durable without reaching the model. Runtime-context messages are excluded from summary-policy input because they are authoritative state rather than conversation. If a checkpoint covers a current active snapshot, it is reprojected immediately after the summary. The prompt budget is the context limit minus the safety reserve, with no fixed reservation for configured maximum output. Reaching 80% of that budget triggers compaction. Rules scan oldest to newest and may cut only after a complete assistant turn without tool calls, or after every result for one assistant tool-call group has appeared. The first boundary whose “maximum summary placeholder + reprojected runtime context + recent raw messages” fits the 10% target is selected, allowing one compaction to cover as much old context as possible. With no safe boundary, compaction is deferred while still within the prompt budget and fails when recovery cannot proceed safely.

Prompt estimates distinguish replayable context from per-response billing usage. After a response without provider-hosted tools, the manager keeps the provider's `input_tokens` as an exact anchor for that request and adds local estimates only for messages committed afterward. A response containing a hosted tool never replaces that anchor: hosted search pages and similar transient provider material can be included in billed input without being present in Kana's replayable history. Until another clean response calibrates the estimate, Kana counts only persisted assistant content, hosted-call metadata, client tool calls/results, and later user messages. A new, resumed, switched-model, or freshly compacted context without an anchor is estimated locally from its model projection. Text uses a conservative UTF-8 byte estimate, protocol envelopes add fixed overhead, tool schemas/actions are estimated from JSON, and images use patch counts instead of stored base64 size.

The manager writes the smaller of the configured output maximum and the prompt budget's remaining space after estimated input to the current `ModelContext.maxOutputTokens`. The Agent only forwards this generic ceiling; each provider decides whether and how to represent it in its request protocol. Kana's summary policy likewise uses the summary budget as that summary request's output ceiling.

An injected `CompactPolicy` produces the actual summary. Kana's product policy calls the main Agent's same `Model` once with tool-free `generate()`; it does not start another Agent loop. Input contains the previous summary and newly covered messages. Assistant thinking, assistant usage, and a tool's structured `result` are omitted, while model-visible tool `content`, name, and error state remain. The summary must finish with `stop` and fit its summary budget; failure restores the preceding checkpoint.

Every new tool result's model-visible `content` is uniformly capped at `min(16000, max(256, floor(promptBudget × 25%)))` estimated tokens. Oversized content keeps approximately a 70% head and 30% tail around a truncation marker. The structured `result` used by the host and TUI remains intact.

A provider may map a definite context-window rejection to `ContextWindowExceededError`. Only a failure before any assistant output forces the same safe-cutoff compaction and retries that model request once. Partial output, a second failure, or the absence of a safe boundary never causes another retry. Compaction emits `context_compaction_start` and `context_compacted` Agent events, and summary-generation usage is committed with its checkpoint.

Running `/compact` while idle immediately forces the same policy with reason `manual`. It adds no synthetic prompt to message history and does not enter the main Agent response loop. The Agent adopts the new checkpoint only after summary generation and persistence succeed, so a JSONL write failure cannot leave an in-memory-only compaction state.

## `Agent` lifecycle

`Agent.stream(input)` starts the loop asynchronously. `AgentConfig.promptAssembly` is mutually exclusive with the legacy `system`/`tools` inputs; those legacy inputs are converted to a single immutable assembly for compatibility. When an `AgentJournal` is configured, it persists the run boundary and user input before adding that input to internal history or allowing model I/O; changed runtime-context snapshots and inactive markers follow the same write-before-model rule. Generic embedders without a journal retain in-memory behavior. It permits only one active run; concurrent attempts receive an error stream. `prompt(input)` is the convenience form that awaits `stream(input).result()`.

The Agent owns one in-memory inbox with `next-step` and `next-turn` lanes. Active-run `steer(userMessage)` inserts the original identified message into `next-step`; the next available turn boundary journals and claims it by MessageId before `turn_input`, then returns `consumed`. Once that journal commit begins, the item is reserved against cancellation or inbox clearing until its identity-checked claim completes, so shutdown cannot make durable input disagree with the claimed message. Abort or the turn limit moves any unclaimed steering input to the tail of `next-turn` without replacing its ID and returns `deferred`. Tab follow-ups and due scheduled messages enter `next-turn` directly. `ConversationRuntime` orchestrates when that lane may start another run and publishes read-only frontend snapshots, but does not mint another queue identity.

Journal ordering is a protocol constraint: a complete assistant message is durable before any tool it names may execute; serial tool results are persisted after completion, while parallel-group results are persisted in model call order as their slots become available; a context checkpoint is persisted before adoption; and the run outcome closes the journal last. `onRunCommitted` performs aggregate post-processing after that close and no longer persists Kana session messages. Listeners and the stream receive final `agent_end` only after both journaling and post-processing succeed. Either failure rejects the stream without first publishing a successful terminal event. All these phases remain part of the active run, so `isRunning` stays `true`, new runs are rejected, and `waitForIdle()` continues waiting.

While running, `Agent.state` exposes its model, system prompt, tools, history, inbox snapshot, `isRunning`, streaming assistant message, pending tool-call IDs, and final error. `abort()` cancels the run's `AbortController`; `reset()` clears history, inbox, and run state only while idle. Ordinary event listeners are observers: each receives an independent event copy, and listener failures are logged as `agent.listener_failed` and isolated from Agent execution. Logic that controls tool execution belongs in `beforeToolExecution`.

## Tool preconditions and error semantics

Every tool call is processed in this order:

1. Find the tool by name; missing tools produce an error tool result.
2. Deep-clone raw arguments. TypeBox schemas run through `Value.Convert`; plain JSON Schemas that lost TypeBox metadata during serialization receive compatible primitive coercion before validation with the cached compiled schema.
3. Invoke the optional `beforeToolExecution` hook. Kana's TUI shows its approval UI here; approval hooks always enter serially even for a concurrent execution group.
4. Check the abort signal, emit `tool_execution_start`, create an independent `AbortSignal` for this invocation, and execute the tool. The invocation's effective deadline starts here.
5. A tool may call `context.update(partialResult)`; ToolRuntime uses an internal serial queue to emit updates one at a time in call order and waits for listeners before finishing.
6. Normalize the return value, emit `tool_execution_end` for the physical terminal outcome, then hand that outcome to the execution-group coordinator for ordered result commit. This event does not imply that the result is durable; successful run completion provides that guarantee.

Argument-validation failures and exceptions thrown by tools do not throw the loop itself: they become `isError: true` results that the model can see on the next turn. When an approval hook returns `cancel`, it aborts the full run by default and adds cancelled error results for later, unexecuted calls from the same message. Abort before execution follows the same completion behavior.

### Tool-result policies

The generic Agent layer accepts one optional `ToolResultPolicy`. ToolRuntime invokes its `finalize()` exactly once after every outcome has become a normalized `ToolResult`, including success, missing tools, argument failures, approval denial, cancellation, timeout, and exceptions. The policy receives a deep-cloned, read-only view of the model-authored call plus the normalized model-visible `content` and error state. The arbitrary structured host `result` does not cross this advisory boundary and therefore does not need to be cloneable. A policy may preserve or replace the model-visible result text and append source-attributed internal user-role context after the result; it cannot rewrite the tool name, arguments, structured host result, or error state. Policy exceptions and invalid returns emit safe diagnostics and fall back to the original result. Validated policy output is copied into a plain internal snapshot before leaving containment, so getters, proxies, sparse arrays, or later mutation cannot escape into result commit.

Result ordering remains provider-safe: every sibling tool result from one assistant message is committed first in model order, followed by policy context with `provenance.kind: "tool_result_policy"`, before the next model request. Each Agent owns its policy instance and state. The built-in repeated-call policy keys a call by tool name plus deeply canonicalized JSON arguments, so object-key order is irrelevant and array order remains significant. It counts denied and failed outcomes, treats configured exclusions as transparent, resets on a different included call or accepted human input, and emits advisory—not blocking—messages only at configured exact thresholds. `AgentConfig.repeatedToolCalls` enables this reusable policy; Kana maps its product TOML settings into that generic configuration.

When the run is aborted or a tool deadline expires, ToolRuntime aborts the invocation signal and waits for a fixed, finite cancellation grace period. In a parallel group, that decision immediately stops pool replenishment and aborts active siblings before waiting for the triggering invocation to drain; queued calls never start and receive canceled results. A tool that exits within the grace period receives a `canceled` or `timed_out` result; its eventual return or exception cannot replace the interruption result. If a tool ignores the signal, the runtime stops accepting its updates, persists a result with `status: "unknown"`, and aborts the current Agent run. That result explicitly forbids automatic retry because the detached invocation may still produce side effects; late settlement produces only structured diagnostics without arguments or results. Deadlines and the grace period use positive integer milliseconds. A tool's `execution.deadlineMs` takes precedence; otherwise the Agent default applies. The framework defaults to 300000 ms, while the Kana product defaults to 660000 ms and exposes `agent.tool_deadline_ms` as an override.

An adjacent parallel group runs through a bounded rolling pool. Calls are claimed and enter serial approval in model order, while at most `maxParallelToolCalls` invocation bodies are in flight. Each start, partial update, and terminal event remains correlated by `toolCallId`; `tool_execution_end` follows physical completion, so a later fast call can finish visibly before an earlier slow call. Durable commits independently wait on model-ordered result slots, making both session history and the next model request deterministic. The assistant tool-call message is already durable before execution, so a process exit in the gap between a live terminal event and result commit recovers that call as `unknown` rather than retrying it. Run abort or an internal scheduler failure stops replenishment and aborts active siblings; started calls are drained to a terminal or explicit unknown outcome, while calls never started receive canceled results. Pool start/end and abnormal drain diagnostics contain aggregate counts only. `list`, `glob`, `grep`, and `read` declare `parallel`; writes, shell, memory, scheduling, and undeclared third-party or MCP tools default to `exclusive`.

The tool interface is:

```ts
type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  execution?: {
    concurrency?: "parallel" | "exclusive";
    deadlineMs?: number;
  };
  execute(args, context): ToolResult | unknown | Promise<ToolResult | unknown>;
};

type ToolContext = {
  toolCallId: string;
  // ToolRuntime always supplies an invocation signal; direct callers may omit it.
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};
```

## MCP tool management and adaptation

At TUI startup, Kana reads server definitions from `mcp.json` and selected IDs from `mcp-enabled.json`, but starts the stdio manager only after the current session is visible. Only IDs present in both files receive registrations. Kana then injects discovered remote tools as `additionalTools` into a rebuilt main Agent. The `kana resume` session picker does not start MCP early; later Agent recreation for `/new`, `/fork`, `/resume`, and Skill refresh reuses the current active tool set. `/mcp` can explicitly replace that set and rebuild the idle Agent while preserving its messages. Memory-consolidation Agents bypass this factory and therefore never receive MCP tools. The manager retains an exposed-alias-to-server/original-name source map that product composition resolves only for approval presentation. `McpManager` still requires only `connect/listTools/callTool/close`, while the adapter requires only an `McpToolCaller`, so the stable stdio client and future stateless, Streamable HTTP, or SSE clients continue to share the management, progress, and tool boundaries.

The product-facing `KanaMcpRuntime` owns manager replacement and serializes lifecycle operations. A reload closes the old manager before reading the latest files and creating a new one; stale tools and approval provenance are cleared even when the replacement fails. The TUI invokes start after session selection, reload after an edited `/mcp` draft is applied, and close during shutdown. Reload failure rebuilds the Agent without stale MCP tools and restores input, keeping the low-level manager deliberately one-shot.

The manager starts servers concurrently and aggregates the initial tool list in configuration order. Each completed-server progress event carries its outcome and post-filter tool count. Include/exclude filters match original remote names; optional failures disable only that server, while a required failure aborts startup. A remote plain JSON Schema is precompiled with the TypeBox compiler before registration, and every server's tools are adapted atomically rather than leaving a silently partial set. The model sees a readable alias made from the server ID and remote tool name, such as `github_create_issue`. The alias follows the current provider's character requirements and stays within 64 characters; internal calls continue to use the original MCP tool name. The manager explicitly rejects remote duplicates, post-sanitization or truncation collisions, and local-tool conflicts instead of silently overwriting them or appending load-order suffixes.

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
| `bash` | `command`, optional `cwd`, optional `timeoutMs` (1–600000; default 30000) | Runs through the user's shell in login-command mode and returns exit code, stdout, stderr, timeout, and truncation state. |
| `remember` | `content`, optional `scope`, `title`, `reason` | Records durable information in daily memory and returns the host-created memory entry. Registered only when memory is enabled. |
| `schedule_wake` | `afterMinutes` (1–1440), `message`, optional `key` | Schedules one later Agent input in the current Kana process. A new event with the same session and key replaces the old one; events are lost when Kana exits. |

`bash` always disconnects stdin and defines `sudo` as `sudo -n`, preventing password prompts from taking over TUI input. It emits partial stdout/stderr roughly every 100ms while running and retains at most 20,000 JavaScript characters per stream in the final result. Each command runs in a separate process group; cancellation and timeout terminate the whole group so background children cannot remain running or keep output streams open. Once the top-level shell exits, the tool briefly drains output and returns, so background work does not block the tool result. A non-zero exit code describes the command outcome and does not set the tool result's `isError` flag. A timeout records a `null` exit code and marks the result as an error.

`list`, `glob`, `grep`, `read`, `write`, `edit`, and `bash` resolve relative paths against the tool `root` (Kana's startup directory) and accept absolute paths. They are not workspace sandboxes: relative paths may escape the root, symlinks may resolve outside it, and `bash.cwd`, `glob.cwd`, and `grep.path` may also be outside. Treat approval as interactive confirmation, not filesystem isolation.

`schedule_wake` does not write to disk or restore undelivered events. The in-process scheduler supports due-time-ordered listing and cancellation by the future input's `MessageId`. That same ID enters the Agent's `next-turn` lane and later committed history when the timer becomes due; no separate wake/queue correlation ID is created. `/schedule` labels Agent-created events as `agent` and events added by the user in the panel as `you`, but never displays the Agent's replacement key. If the Agent is running when an event becomes due, the inbox keeps it behind earlier next-turn input and starts new runs in enqueue order after the current `agent_end`. The scheduled-message manager pauses only pending-run startup, not timers, then resumes delivery when it closes. Creating, forking, or resuming another session clears the prior session's future wakes and pending inbox; shutdown does the same. It does not require tool approval.

## Constraints for custom tools

- Prefer TypeBox 1.x schemas in TypeScript so tool arguments retain static types. The runtime also accepts plain JSON Schema produced by serializing a TypeBox schema; it applies compatible primitive coercion before validating with the TypeBox compiler.
- Return a serializable structured `result` with concise, model-useful `content`.
- Check `context.signal` in long-running work and use `context.update` for progress.
- Throw actionable `Error` values for failures; the loop safely converts them into model-visible results.
- For a tool that can change user state, decide approval policy in product composition and provide understandable TUI formatting.
