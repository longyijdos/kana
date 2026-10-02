# Tools and execution

The core `ToolSpec` is the provider-facing name, description, and input JSON Schema. The executable `Tool` adds `execute`, optional result schema, and execution metadata. `ToolRuntime` receives model-visible tools and an optional separate callable set for scripts, turning calls into normalized, observable results without letting ordinary tool failures escape the Agent loop.

## Tool and result contracts

```ts
type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  outputSchema?: TSchema;
  execution?: {
    concurrency?: "parallel" | "exclusive";
    deadlineMs?: number;
  };
  execute(args, context): ToolResult | unknown | Promise<ToolResult | unknown>;
};

type ToolContext = {
  toolCallId: string;
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};
```

Omitted concurrency defaults to `exclusive`. `ToolRuntime` always supplies an invocation-level abort signal; a direct embedder calling `execute` may omit it. Long-running implementations should observe the signal and use `update` for useful bounded progress.

Each tool implementation owns its optional `outputSchema`, describing the successful canonical `result` after JSON transport. Dates become ISO strings. This metadata does not appear in ordinary provider tool declarations and is not used for runtime result validation. Codemode renders it in `run_code`'s description; an absent schema becomes `unknown`.

A normalized result has distinct audiences:

- `content` is bounded text returned to the model.
- `images` carries provider-neutral visual observations.
- `result` is the canonical structured host value used by live Agent and frontend consumers.
- `artifact` identifies complete text saved outside the message.
- `isError` tells the model that the operation failed.

A plain string return becomes `content`; another ordinary value is JSON-serialized for content and retained as the live structured result. Malformed explicit result fields become a safe tool failure before message commit.

## Invocation pipeline

`ToolRuntime.invoke(toolCall, { signal?, onAbortRun? })` executes one call through the same validation, approval, cancellation, deadline, normalization, and event pipeline as model-proposed calls. It returns `{ toolCall, result, isError, abortRun? }`, where `result` is the complete normalized `ToolResult`. It does not apply result policies, limit content, create artifacts, or commit messages. `ToolRuntime.execute()` owns batch scheduling and history preparation; callers of `invoke()` own scheduling and must handle `abortRun` or supply `onAbortRun` for immediate notification.

Only the tool named `run_code` receives `CodemodeToolContext`, which extends the ordinary context with `invokeTool(name, args, { signal? })`. Ordinary tools have no such field in either their context type or runtime object. Nested invocation returns the full normalized `ToolResult` through `invoke()` without preparing history. Each codemode invocation owns a queue that follows the runtime's parallel-call switch and concurrency limit, with exclusive calls acting as barriers. Nested approvals share the runtime's serial hook queue. A nested `abortRun` interrupts codemode; cancellation of a child signal alone does not. Inner calls publish the usual execution events with the outer call's `parentToolCallId` but do not become separate historical tool messages. `invoke()` accepts this optional event field; ordinary calls omit it. The TUI skips these inner events when rendering tool blocks and status, while approvals retain their normal behavior.

Every proposed call follows one contained pipeline:

1. Resolve the tool by name; a missing tool becomes an error result.
2. Deep-clone arguments, apply compatible primitive conversion, and validate them with a cached TypeBox compiler.
3. Invoke `beforeToolExecution`. Hooks enter serially and may continue, cancel, or return a normal result without executing the tool.
4. For calls that continue, check run cancellation, emit `tool_execution_start`, create the invocation signal, and start its effective deadline.
5. Serialize `context.update()` notifications and wait for each listener before terminal publication.
6. Normalize the result and emit `tool_execution_end`.
7. Apply result policies, then commit sibling results through model-ordered slots before the next model request.

Kana-owned object schemas use `additionalProperties: false`, so an undeclared argument fails with its property name instead of being ignored. Serialized TypeBox schemas that have lost library metadata still receive compatible primitive conversion before the same compiler validates them. Third-party and MCP schemas keep their own declared additional-property behavior. `mcp_call` validates its gateway envelope in this pipeline and validates nested remote arguments inside the gateway before remote invocation.

Validation errors, approval denial, cancellation, deadline expiry, and tool exceptions become `isError: true` results. They do not throw the turn loop. Approval cancellation aborts the run by default and gives later calls from the same assistant message canceled results without invoking them.

A hook's `return` supplies a normal `ToolResult` and skips `execute` and its deadline; `cancel` supplies a canceled error result, even with `abortRun: false`. Both paths still publish `tool_execution_end`, apply result policies, and commit a tool result.

`tool_execution_end` describes completion, cancellation, a hook-supplied result, or an explicit unknown outcome. It does not promise that the result reached the journal. A successful Agent run is the durability boundary; see [Sessions and memory](sessions-and-memory.md) for commit and recovery order.

## Concurrency, cancellation, and deadlines

Parallel execution requires both Agent policy and model metadata to enable parallel tool calls. Otherwise the provider receives `parallelToolCalls: false` and every call runs serially. When enabled, only adjacent calls whose tools declare `parallel` form a concurrent group. An `exclusive`, undeclared, missing, or invalid tool remains a barrier.

Each parallel group uses a bounded rolling pool. Calls are claimed and enter serial approval in model order, while at most `maxParallelToolCalls` invocation bodies run at once. Start, update, and end events remain correlated by `toolCallId` and follow physical timing, so a later fast call may visibly finish first. Independent result slots wait for model order before journal commit and the next request, keeping replay deterministic.

The effective deadline comes from `tool.execution.deadlineMs`, then the Agent default. The reusable runtime and Kana's `agent.tool_deadline_ms` both default to 300000 ms; `shell` declares its own 301000 ms deadline so its five-minute command ceiling terminates through shell's own timeout handling. A call-specific argument such as `shell.timeoutMs` may impose a narrower operation limit inside that outer boundary.

Approval precedes an ordinary tool's deadline. For `run_code`, waiting for an inner `beforeToolExecution` hook, including its serial approval queue, pauses the outer deadline and elapsed display. Overlapping approval waits share one pause; the outer deadline resumes its remaining budget after the last wait finishes. Already executing inner tools retain their own deadlines. The runtime publishes `tool_execution_pause` and `tool_execution_resume` for the outer call with `reason: "approval"`; these events do not create history messages.

Run abort, a tool deadline, or an internal scheduler failure immediately stops pool replenishment and aborts active sibling signals. Calls not yet started receive canceled results. Started calls receive a finite cancellation grace period. Settlement within it becomes `canceled` or `timed_out`; a later return cannot replace that outcome.

If a call ignores cancellation past the grace period, ToolRuntime stops accepting updates, fixes its result as `status: "unknown"`, and ends the Agent run. The result forbids automatic retry because the detached operation may still have side effects. Late settlement produces only safe lifecycle diagnostics without arguments or output.

## Tool-result policies and artifacts

After normalization, ToolRuntime applies each `ToolResultPolicy` in order to success, failure, denial, cancellation, timeout, and unknown outcomes. A policy receives a cloned read-only call, current model-visible content and error state, structured-result byte size when measurable, and the active content limit. Arbitrary structured host data itself does not cross this advisory boundary.

A policy may replace model-visible content, append source-attributed internal context, disable durable structured-result retention, or attach one validated artifact reference. It cannot change tool identity, arguments, canonical live result, or error state. Invalid policy output or an exception produces safe diagnostics and preserves the preceding pipeline state. Accepted output is copied into a plain detached snapshot so getters, proxies, sparse arrays, or later mutation cannot escape containment.

All sibling results from one assistant message commit in model order before any `tool_result_policy` context. Each Agent owns its policy instances and mutable policy state. Accepted human input and Agent reset clear that state.

The reusable repeated-call policy keys calls by tool name plus deeply canonicalized JSON arguments. Object-key order is ignored and array order is retained. Denied and failed calls count; configured exclusions are transparent. A different included call or accepted human input resets the sequence. Exact configured thresholds append advisory context but never block execution.

Kana caps every new model-visible tool result at:

```text
min(8000, max(256, floor(promptBudget × 25%))) estimated tokens
```

The final byte guard uses three UTF-8 bytes per estimated token. With `tool_result_artifacts` enabled, oversized non-`read` text is saved completely before a bounded roughly 70% head / 30% tail preview is built. The retrieval notice, exact omitted-byte count, and locator fit inside the same guard. Top-level `read` is bounded without recursively creating another artifact and explains that pagination cannot split one very long line.

The live result remains available to `tool_execution_end`. ToolRuntime saves a cloneable, JSON-serializable result completely in durable messages when its serialized UTF-8 size is at most 128 KiB (131072 bytes). Oversized or non-serializable results are omitted as a whole; a custom policy may also explicitly disable retention. This persistence limit is independent of model-context budgets, content limits, and artifact creation; it does not truncate the live result. The model receives content and images, not this stored result. Restored TUI history and subagent inspection prefer `result`, then `artifact`, then `content`. When result is retained, live and restored views use the same result; when result was omitted, an artifact provides the stored-output summary. Artifact storage paths, permissions, audit, fork, and cleanup belong to [Sessions and memory](sessions-and-memory.md).

## Codemode sandbox

`createCodemodeSandbox({ tools, timeoutMs? })` wraps the independent `@earendil-works/pi-codemode` package. Each execution runs JavaScript in a fresh QuickJS WASM instance inside a Worker. The default deadline is 300000 ms, including time spent in supplied tools, and the VM heap limit is 256 MiB. Callers can pass an abort signal to `execute()` and must close the sandbox when its owner is disposed. Cancellation and timeout interrupt the VM and abort pending host-tool signals.

Scripts retain the package's interfaces: `tools`, `ALL_TOOLS`, `text`, `image`, `console`, `exit`, `store`, `load`, top-level `await`, and `return`. Host filesystem, networking, process, and module APIs are unavailable. Registered host functions exchange JSON values with the script; callers own their validation, approval, and history handling.

The factory returns the package's sandbox without changing its result format. Successful execution returns `ok`, `value`, `output`, `calls`, and `storeWrites`; failed execution returns `ok: false`, `error`, `output`, and `calls`. Store changes are reported to the caller rather than persisted automatically. This host API does not register a model-facing tool.

`createCodemodeTool({ tools, mode? })` creates an exclusive tool named `run_code` with `{ code: string }` input. Its description uses Pi's TypeScript renderer: `mixed` (the factory default) lists result types, while `only` includes tool descriptions and input and result types. External MCP definitions remain available through `mcp_describe_tool`'s structured result. Its script tools use `context.invokeTool()` and resolve to the complete canonical `result`; failed calls reject inside the script. The outer tool does not request Kana approval, while nested calls follow their own rules. `run_code` declares its own 900000 ms (15-minute) invocation deadline, excluding inner approval waits; the runtime controls the whole script through its signal. The sandbox's separate timer is disabled for this tool. The script cannot call `tools.run_code()`.

The tool's `content` contains explicit text output followed by its JSON-encoded return value or script error. Nested tool images are automatically forwarded to the outer `images`, and explicit `image()` output becomes visual observations with decoded dimensions. Its structured `result` retains the package's `CodemodeResult`, including call names, statuses, durations, and successful store writes. Store writes are not automatically reused by later executions. Live frontends receive nested execution events; history and resumed transcripts retain only the outer result, subject to the ordinary result-retention limit.

`AgentConfig.codemode` defaults to `off`. `mixed` advertises ordinary tools plus `run_code`; `only` advertises `run_code` alone. Agent retains both model-visible `tools` and internal `callableTools`, refreshing them together at each prompt assembly. Ordinary `execute()` resolves only advertised tools; internal `invoke()` resolves `callableTools`. Kana automatically supplies `run_code` according to `agent.codemode`, while `agent.tools` and child role cards still restrict script capabilities. Children inherit the parent's mode; memory consolidation keeps its existing tool surface. Provider-native capabilities such as hosted web search retain their own settings.

Source execution loads the local Worker and WASM. Bun executable builds list the Worker as an additional entrypoint and embed WASM through its static file import; sandbox execution does not require external package files beside the binary. Builds explicitly use the project root (`--root .`) so the embedded Worker path matches the runtime source path.

## Built-in tools

| Tool | Main parameters | Behavior |
| --- | --- | --- |
| `list` | Optional `path`, `includeHidden`, `limit` | Lists one directory level with stable sorting and truncation metadata. |
| `glob` | `pattern`; optional `cwd`, type/depth/hidden/limit filters | Finds paths using a relative glob pattern; absolute patterns and `..` segments are rejected. |
| `grep` | `pattern`; optional path/include/literal/case/hidden/context/limit fields | Searches UTF-8 text with a JavaScript regular expression or literal and returns matching locations. |
| `read` | `path`; optional 1-based `offset` and `limit` | Reads a UTF-8 line range and reports total lines and truncation. |
| `view_image` | `path` | Normalizes a local image and returns metadata plus a visual observation; registered only when effective image input is enabled. |
| `write` | `path`, complete `content`, optional `overwrite` | Creates parent directories and exclusively creates a file by default; explicit overwrite replaces one. |
| `edit` | `path`, non-empty `edits` array of `oldText`/`newText` pairs | Atomically applies exact, non-overlapping UTF-8 replacements. |
| `shell` | `command`; optional `cwd`, `timeoutMs` | Executes through the user's shell with detached stdin and a managed process group. |
| `job_start` | `command`; optional `cwd`, `timeoutMs` | Starts a session-owned background shell command and immediately returns its Job ID and launch status. |
| `job_list` | None | Lists active and up to 32 recent terminal Jobs for the current session and acknowledges listed terminal completions. |
| `job_output` | `jobId`, optional `waitMs` | Consumes all currently unread retained output from the Agent cursor and reports dropped bytes. |
| `job_kill` | `jobId`, optional `reason` | Stops an owned Job and waits for its process group to settle. |
| `spawn_subagent` | `profile`, `task` | Starts a predefined session-owned child and immediately returns its Agent ID. |
| `wait_subagent` | `agentId`, optional `timeoutMs` | Reads or briefly waits for an owned child's state and final output. |
| `cancel_subagent` | `agentId`, optional `reason` | Cancels an owned child and waits for settlement. |
| `todo_write` | Complete todo-item array | Atomically replaces or explicitly clears the session todo state. |
| `delegate_user_task` | Concrete `task` text | Invites the user to work in parallel; acceptance creates a process-local task ID. |
| `remember` | `content`; optional scope/title/reason | Appends a durable-memory staging entry when memory is enabled. |
| `schedule_wake` | `afterMinutes`, `message`, optional `key` | Creates a process-local future input for the active session. |
| `update_goal` | `status`, optional `detail` | Ends the authorized active Goal as completed or blocked. |

`list`, `glob`, `grep`, `read`, `view_image`, `mcp_list_tools`, `mcp_describe_tool`, and the three subagent control tools declare `parallel`. Writes, Shell, memory, scheduling, Goal updates, and undeclared third-party/MCP tools are `exclusive`.

## File and shell boundaries

File tools and `shell` resolve relative paths against their configured root, which Kana sets to the startup working directory. They also accept absolute paths. A leading `~` or `~/` in a path argument expands to the user's home directory, so `~/notes.md` never becomes a literal `~` directory inside the root; a `~` that appears after the first segment stays literal, and `glob.pattern` and `grep.include` are relative glob patterns rather than paths. This is path normalization, not a workspace sandbox: relative paths may leave the root, symlinks may resolve outside it, and `shell.cwd`, `glob.cwd`, and `grep.path` may name external locations.

`grep.context` is a nonnegative integer, defaults to 0, and has no upper bound. Each match independently includes the requested number of preceding and following lines, clipped at file boundaries; overlapping context is repeated. Match lines retain `path:line:column:text`, and context lines use `path-line-text`. `limit` counts only matching lines, and the common result-size budget still applies.

`edit` matches every `edits[].oldText` exactly once against the same original file content. Missing or ambiguous text and overlapping ranges reject the entire call without writing; otherwise all replacements are committed in one write.

`view_image` shares the user-attachment decoder and size limits. Supported encoded JPEG, PNG, and WebP remain provider-ready; other decoded formats become static PNG, and animated input uses its decoded first frame.

`shell` accepts executable names or paths whose basename is `sh`, `bash`, or `zsh`. It uses `$SHELL` when supported, otherwise falling back to `bash`. These shells support the injected function syntax that shadows `sudo` with `sudo -n` so password prompts cannot take TUI input. Stdin is disconnected. Foreground calls default to a 30000 ms command timeout, accept at most 300000 ms, and publish bounded trailing stdout/stderr snapshots roughly every 100 ms. Complete final streams still enter the common result policy.

Each command runs in its own process group. Foreground execution waits for the group rather than only the top-level shell, so raw `command &` does not escape normal cancellation or timeout. Explicit daemonization into another process session may leave that boundary. A non-zero exit code is a completed command result, not a tool infrastructure error; timeout records a `null` exit code and `isError: true`.

## Background Jobs

`job_start` launches the same Shell execution under `BackgroundJobManager`, returns a session-owned Job ID immediately, and has no default command timeout. Use it when work must outlive one tool call; raw shell background syntax does not provide the same ownership and cleanup.

The generic manager is independent of Kana Agent construction. An owner binds Jobs to one session instance, enforces its concurrent-Job limit, and stops all owned process groups during disposal. Each Job retains at most the latest 1 MiB of combined stdout/stderr in memory. Metadata stores only a whitespace-normalized command label bounded to 512 UTF-8 bytes; the original command stays in the tool call.

`job_output` has one consuming Agent cursor and returns all currently unread retained output in one call. `droppedBytes` reports output evicted before consumption. The TUI uses a separate non-consuming tail of at most 20 KiB. At most 32 terminal Jobs remain per owner; older entries are pruned. Jobs and retained buffers are never persisted or resumed.

Kana projects active or unreported Job identity, bounded label, cwd, state, and exit code into runtime context—never output. Completion steering, queued-run delivery, acknowledgement, and session-change ordering belong to [Conversation runtime](conversation-runtime.md).

Subagent control tools expose only predefined role cards and return stable child IDs. Their capability intersection, asynchronous lifecycle, persistence, and TUI behavior belong to [Subagents](subagents.md).

## Kana-owned state tools

`todo_write` trims every item, rejects blank or duplicate content and unknown fields, allows at most one `in_progress` item, and never partially mutates state after validation failure. The complete accepted list belongs to the current session; only an explicit empty array clears it. The latest state is reprojected after compaction, resume, and fork, while the tool result remains a compact fixed acknowledgement. Its journal representation belongs to [Sessions and memory](sessions-and-memory.md).

`remember` appends a structured entry to project or global daily memory. It does not edit durable `memory.md` directly; consolidation and retention belong to [Sessions and memory](sessions-and-memory.md).

`schedule_wake` validates a delay of 1–1440 minutes and a bounded non-empty message, then schedules through the host's in-process wake boundary. It and `update_goal` are available only when product composition supplies their required runtime capability. Delivery and Goal admission belong to [Conversation runtime](conversation-runtime.md).

Kana never asks for approval for `spawn_subagent`, `wait_subagent`, `cancel_subagent`, `todo_write`, `remember`, `schedule_wake`, `update_goal`, `mcp_list_tools`, or `mcp_describe_tool`. `delegate_user_task` always asks whether the user accepts the task, even in `never` mode; declining returns a normal result and leaves the work with the Agent. Other calls, including `mcp_call`, follow the configured `always`, `unless_trusted`, or `never` policy. Read-only built-ins and narrowly recognized read-only or exact allowlisted Shell commands may pass automatically in `unless_trusted`; third-party and MCP tools do not gain trust implicitly. `job_start` does not use the Shell allowlist and requires approval unless the policy is `never`. Approval is interactive authorization, not filesystem or process isolation.

## MCP and custom tools

All tools use the ordinary `Tool` contract. Kana creates MCP gateways as built-ins when the current registry is available and `agent.tools` selects them. MCP exposes `mcp_list_tools` (parallel name and description listing), `mcp_describe_tool` (parallel single-tool schema lookup), and `mcp_call` (exclusive, ordinary approval). The schema lookup returns the server, tool name, and input schema in both content and result; result additionally includes optional output schema, while content omits it. Remote input schemas are enforced inside the call gateway. Invocation results receive the same normalization and content limits. MCP catalogs, SDK transports, and result adaptation are documented in [MCP](mcp.md).

For a custom tool:

- Prefer TypeBox 1.x so TypeScript retains argument types.
- Declare `additionalProperties: false` when unknown object fields should fail.
- Return concise model-useful `content` and serializable structured `result`; use `images` only for valid `UserImage` observations.
- Observe `context.signal` and publish bounded progress with `context.update`.
- Throw actionable `Error` values; ToolRuntime converts them to model-visible failures.
- Decide product approval and frontend presentation for any operation that changes user state.
