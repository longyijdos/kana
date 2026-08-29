# Tools and execution

The core `ToolSpec` is the provider-facing name, description, and JSON Schema. The executable `Tool` extends it with an `execute` function and optional execution metadata. `ToolRuntime` receives exactly the tool objects advertised for one model step and turns every proposed call into a normalized, observable result without letting ordinary tool failures escape the Agent loop.

## Tool and result contracts

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
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};
```

Omitted concurrency defaults to `exclusive`. `ToolRuntime` always supplies an invocation-level abort signal; a direct embedder calling `execute` may omit it. Long-running implementations should observe the signal and use `update` for useful bounded progress.

A normalized result has distinct audiences:

- `content` is bounded text returned to the model.
- `images` carries provider-neutral visual observations.
- `result` is the canonical structured host value used by live Agent and frontend consumers.
- `artifact` identifies complete text saved outside the message.
- `isError` tells the model that the operation failed.

A plain string return becomes `content`; another ordinary value is JSON-serialized for content and retained as the live structured result. Malformed explicit result fields become a safe tool failure before message commit.

## Invocation pipeline

Every proposed call follows one contained pipeline:

1. Resolve the tool by name; a missing tool becomes an error result.
2. Deep-clone arguments, apply compatible primitive conversion, and validate them with a cached TypeBox compiler.
3. Invoke `beforeToolExecution`. Approval hooks always enter serially and may allow or cancel the call.
4. Check run cancellation, emit `tool_execution_start`, create the invocation signal, and start its effective deadline.
5. Serialize `context.update()` notifications and wait for each listener before terminal publication.
6. Normalize the physical outcome and emit `tool_execution_end`.
7. Apply result policies, then commit sibling results through model-ordered slots before the next model request.

Kana-owned object schemas use `additionalProperties: false`, so an undeclared argument fails with its property name instead of being ignored. Serialized TypeBox schemas that have lost library metadata still receive compatible primitive conversion before the same compiler validates them. Third-party and MCP schemas keep their own declared additional-property behavior.

Validation errors, approval denial, cancellation, deadline expiry, and tool exceptions become `isError: true` results. They do not throw the turn loop. Approval cancellation aborts the run by default and gives later calls from the same assistant message canceled results without invoking them.

`tool_execution_end` describes physical completion, cancellation, or an explicit unknown outcome. It does not promise that the result reached the journal. A successful Agent run is the durability boundary; see [Sessions and memory](sessions-and-memory.md) for commit and recovery order.

## Concurrency, cancellation, and deadlines

Parallel execution requires both Agent policy and model metadata to enable parallel tool calls. Otherwise the provider receives `parallelToolCalls: false` and every call runs serially. When enabled, only adjacent calls whose tools declare `parallel` form a concurrent group. An `exclusive`, undeclared, missing, or invalid tool remains a barrier.

Each parallel group uses a bounded rolling pool. Calls are claimed and enter serial approval in model order, while at most `maxParallelToolCalls` invocation bodies run at once. Start, update, and end events remain correlated by `toolCallId` and follow physical timing, so a later fast call may visibly finish first. Independent result slots wait for model order before journal commit and the next request, keeping replay deterministic.

The effective deadline comes from `tool.execution.deadlineMs`, then the Agent default. The reusable runtime defaults to 300000 ms; Kana defaults to 660000 ms through `agent.tool_deadline_ms`. A call-specific argument such as `bash.timeoutMs` may impose a narrower operation limit inside that outer boundary.

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

The live structured result remains available to `tool_execution_end`. Oversized, non-serializable, or artifact-backed structured data is omitted from durable messages independently of the model-facing text. Artifact storage paths, permissions, audit, fork, and cleanup belong to [Sessions and memory](sessions-and-memory.md).

## Built-in tools

| Tool | Main parameters | Behavior |
| --- | --- | --- |
| `list` | Optional `path`, `includeHidden`, `limit` | Lists one directory level with stable sorting and truncation metadata. |
| `glob` | `pattern`; optional `cwd`, type/depth/hidden/limit filters | Finds paths using a relative glob pattern; absolute patterns and `..` segments are rejected. |
| `grep` | `pattern`; optional path/include/literal/case/hidden/limit fields | Searches UTF-8 text with a JavaScript regular expression or literal and returns matching locations. |
| `read` | `path`; optional 1-based `offset` and `limit` | Reads a UTF-8 line range and reports total lines and truncation. |
| `view_image` | `path` | Normalizes a local image and returns metadata plus a visual observation; registered only when effective image input is enabled. |
| `write` | `path`, complete `content`, optional `overwrite` | Creates parent directories and exclusively creates a file by default; explicit overwrite replaces one. |
| `edit` | `path`, non-empty `oldText`, `newText`, optional `replaceAll` | Performs exact UTF-8 replacement; one match is required by default. |
| `bash` | `command`; optional `cwd`, `timeoutMs`, `background` | Executes through the user's shell with detached stdin and a managed process group. |
| `job_list` | None | Lists active and up to 32 recent terminal Jobs for the current session and acknowledges listed terminal completions. |
| `job_output` | `jobId`, optional `waitMs` | Consumes all currently unread retained output from the Agent cursor and reports dropped bytes. |
| `job_kill` | `jobId`, optional `reason` | Stops an owned Job and waits for its process group to settle. |
| `todo_write` | Complete todo-item array | Atomically replaces or explicitly clears the session todo state. |
| `remember` | `content`; optional scope/title/reason | Appends a durable-memory staging entry when memory is enabled. |
| `schedule_wake` | `afterMinutes`, `message`, optional `key` | Creates a process-local future input for the active session. |
| `update_goal` | `status`, optional `detail` | Ends the authorized active Goal as completed or blocked. |

`list`, `glob`, `grep`, `read`, and `view_image` declare `parallel`. Writes, Shell, memory, scheduling, Goal updates, and undeclared third-party/MCP tools are `exclusive`.

## File and shell boundaries

File tools and `bash` resolve relative paths against their configured root, which Kana sets to the startup working directory. They also accept absolute paths. This is path normalization, not a workspace sandbox: relative paths may leave the root, symlinks may resolve outside it, and `bash.cwd`, `glob.cwd`, and `grep.path` may name external locations.

`view_image` shares the user-attachment decoder and size limits. Supported encoded JPEG, PNG, and WebP remain provider-ready; other decoded formats become static PNG, and animated input uses its decoded first frame.

`bash` disconnects stdin and shadows `sudo` with `sudo -n` so password prompts cannot take TUI input. Foreground calls default to a 30000 ms command timeout and publish bounded trailing stdout/stderr snapshots roughly every 100 ms. Complete final streams still enter the common result policy.

Each command runs in its own process group. Foreground execution waits for the group rather than only the top-level shell, so raw `command &` does not escape normal cancellation or timeout. Explicit daemonization into another process session may leave that boundary. A non-zero exit code is a completed command result, not a tool infrastructure error; timeout records a `null` exit code and `isError: true`.

## Background Jobs

`background: true` launches the same Bash execution under `BackgroundJobManager`, returns a session-owned Job ID immediately, and has no default command timeout. Use it when work must outlive one tool call; raw shell background syntax does not provide the same ownership and cleanup.

The generic manager is independent of Kana Agent construction. An owner binds Jobs to one session instance, enforces its concurrent-Job limit, and stops all owned process groups during disposal. Each Job retains at most the latest 1 MiB of combined stdout/stderr in memory. Metadata stores only a whitespace-normalized command label bounded to 512 UTF-8 bytes; the original command stays in the tool call.

`job_output` has one consuming Agent cursor and returns all currently unread retained output in one call. `droppedBytes` reports output evicted before consumption. The TUI uses a separate non-consuming tail of at most 20 KiB. At most 32 terminal Jobs remain per owner; older entries are pruned. Jobs and retained buffers are never persisted or resumed.

Kana projects active or unreported Job identity, bounded label, cwd, state, and exit code into runtime context—never output. Completion steering, queued-run delivery, acknowledgement, and session-change ordering belong to [Conversation runtime](conversation-runtime.md).

## Kana-owned state tools

`todo_write` trims every item, rejects blank or duplicate content and unknown fields, allows at most one `in_progress` item, and never partially mutates state after validation failure. The complete accepted list belongs to the current session; only an explicit empty array clears it. The latest state is reprojected after compaction, resume, and fork, while the tool result remains a compact fixed acknowledgement. Its journal representation belongs to [Sessions and memory](sessions-and-memory.md).

`remember` appends a structured entry to project or global daily memory. It does not edit durable `memory.md` directly; consolidation and retention belong to [Sessions and memory](sessions-and-memory.md).

`schedule_wake` validates a delay of 1–1440 minutes and a bounded non-empty message, then schedules through the host's in-process wake boundary. It and `update_goal` are available only when product composition supplies their required runtime capability. Delivery and Goal admission belong to [Conversation runtime](conversation-runtime.md).

Kana never asks for approval for `todo_write`, `remember`, `schedule_wake`, or `update_goal`. Other calls follow the configured `always`, `unless_trusted`, or `never` policy. Read-only built-ins and narrowly recognized read-only or exact allowlisted Bash commands may pass automatically in `unless_trusted`; third-party and MCP tools do not gain trust implicitly. Approval is interactive authorization, not filesystem or process isolation.

## External and custom tools

MCP and other external tools enter the Agent through the same `Tool` contract. They keep their declared schema behavior, default to exclusive execution, pass through ordinary approval, and receive the same result normalization and content limits. MCP-specific discovery, aliases, transports, and result adaptation are documented in [MCP](mcp.md).

For a custom tool:

- Prefer TypeBox 1.x so TypeScript retains argument types.
- Declare `additionalProperties: false` when unknown object fields should fail.
- Return concise model-useful `content` and serializable structured `result`; use `images` only for valid `UserImage` observations.
- Observe `context.signal` and publish bounded progress with `context.update`.
- Throw actionable `Error` values; ToolRuntime converts them to model-visible failures.
- Decide product approval and frontend presentation for any operation that changes user state.
