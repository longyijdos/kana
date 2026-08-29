# Agent runtime protocol

The Agent is a reusable, stateful model/tool controller. It owns one run at a time and knows nothing about Kana sessions, TUI components, headless output, configuration files, or local persistence paths. Kana supplies those product concerns through injected models, prompt assembly, tools, journal callbacks, and completion hooks.

## Messages and identity

Agent history uses three `Message` roles:

| Role | Main fields | Purpose |
| --- | --- | --- |
| `user` | `id`, required `provenance`, `content`, optional `images` | Human, scheduled, recovery, summary, policy, Goal, or runtime-context input. |
| `assistant` | `id`, model-output provenance, ordered `content`, optional `stopReason` and `usage` | Model output, local tool calls, and provider-hosted actions. |
| `tool` | `id`, tool-result provenance, call/name identity, `content`, optional images/artifact/result/error | Associates one normalized local or external tool outcome with its call. |

Every logical message receives one branded `MessageId` when it enters Kana or is produced internally. Cloning, inbox movement, Agent events, journal persistence and replay, forks, and model history preserve that ID. It is distinct from journal entry, run, turn, provider tool-call, Job, and session identities. Agent history and inboxes reject duplicate logical message IDs.

Required discriminated `provenance` identifies the producer or internal purpose. Consumers use it instead of treating every `user` role as human input. Runtime-context provenance additionally names the stable source that owns the projected state.

Assistant `content` is one ordered array. Entries may be `thinking`, `text`, `tool_call`, or provider-hosted `hosted_tool`; ordering is preserved for provider replay and presentation. Provider adapters may attach opaque, JSON-serializable `providerState`, but core and Agent do not interpret it.

## Stream protocols

A Model produces `AssistantMessageEvent` values. Incremental events carry both their delta and the complete assistant-message snapshot after applying it:

```text
start
  → thinking_start / thinking_delta* / thinking_end
  → text_start / text_delta* / text_end
  → toolcall_start / toolcall_delta* / toolcall_end
  → hosted_tool_start / hosted_tool_update* / hosted_tool_end
  → done | error
```

Not every content kind occurs. `done` uses `stop`, `length`, or `toolUse`; `error` uses `aborted` or `error`. The final stream result contains the complete assistant message, including stop reason and usage.

The Agent translates model events into a higher-level protocol:

```text
agent_start
  → turn_start
  → message_start / message_update* / message_end
  → tool_execution_start / tool_execution_update* / tool_execution_end
  → turn_end
  → turn_input* when the active run accepts queued input
  → ...
  → agent_end
```

Both stream types support `for await` and an independent `result()` promise. Agent listeners and stream consumers receive separate event clones; constructor messages and `Agent.state` are likewise detached from mutable internal history. Listener exceptions are logged as `agent.listener_failed` and do not terminate the run.

## Prompt assembly and runtime context

`PromptAssembly` separates the stable system prefix, dynamic context, and capability-owned tools. It is immutable after construction, but resolves every context and tool renderer before each model step. The resolved tool set is advertised to that request and passed to the matching tool execution boundary, so only a later model step can observe changed capabilities.

Each runtime-context renderer must return one explicit, non-empty `active` or `inactive` state with a stable source. An initially inactive source produces no message. After activation, each changed state becomes an internal user message and follows the same write-before-model rule as ordinary run input; unchanged state is not duplicated.

Runtime-context messages are authoritative state rather than conversation. Stable system instructions make only the last transition for each source effective. The uncompacted model projection retains every transition so it never rewrites the earlier provider-message prefix. Kana currently uses separate sources for environment, todo state, Goal state, and background Jobs; the Agent protocol is independent of those product renderers.

`AgentConfig.promptAssembly` cannot be combined with the legacy `system` and `tools` inputs. The legacy form is converted into one immutable assembly for embedders that have not adopted dynamic sources.

## Turn loop

`runAgentLoop` owns the model-turn state machine:

```text
Copy the input context and emit agent_start
Repeat within maxTurns:
  reject an aborted signal
  emit turn_start
  resolve prompt context and tools
  commit changed runtime-context messages
  stream and assemble one assistant message
  emit turn_end on model failure or abort
  if stopReason is toolUse, execute the advertised calls
  commit their results and policy context
  emit turn_end
  commit and claim available next-step input
  stop when no tool call or accepted turn input requires another turn
Emit agent_end
```

Standalone `Agent` and `runAgentLoop` default to eight turns. Kana configures `max_turns = -1`, meaning unlimited; only `-1` or a positive integer is valid. If the final allowed turn still executes tool calls, the run ends with `turn_limit`. A message ending with `length` never executes tool calls, and provider failure without assistant content does not add an empty assistant message. An aborted partial assistant message retains safe text or thinking content but drops unexecuted calls.

Tool validation, approval, concurrency, deadlines, event timing, result policies, and built-in behavior belong to [Tools and execution](tools.md). The loop waits for that boundary and starts the next model step only with model-ordered committed results.

## Agent lifecycle and inbox

`Agent.stream(input)` starts work asynchronously; `prompt(input)` awaits the same stream's result. Only one run may be active. Concurrent attempts return an error stream, and `reset()` is allowed only while idle. `abort()` cancels the run's `AbortController`.

The Agent owns one in-memory inbox with two lanes:

- `next-step` contains steering that may join the active run at its next complete turn boundary.
- `next-turn` contains FIFO input reserved for later runs.

`steer(message)` places the original identified message in `next-step`. When another turn is available, the Agent starts the journal commit, reserves that item against cancellation or inbox clearing, claims it by identity, emits `turn_input`, and returns `consumed`. If abort or the turn limit prevents another turn, unclaimed steering moves to the tail of `next-turn` with the same `MessageId`, and the outcome is `deferred`.

The Agent never starts a new run from `next-turn`. Kana's [conversation runtime](conversation-runtime.md) observes and drains that lane, adds scheduled/Goal/Job delivery metadata, and publishes frontend queue snapshots without creating another queue.

`Agent.state` exposes detached snapshots of the model, assembled system prompt and tools, history, inbox, current run state, streaming assistant message, pending tool-call IDs, context checkpoint, and final error. `waitForIdle()` covers journal closure and injected post-processing, not only provider and tool execution.

## Context budgeting and compaction

`ContextManager` creates a separate model projection from complete Agent history before every model request. Compaction never deletes the Agent's raw `messages`; it replaces only the older portion of the projection with one cumulative summary plus retained recent messages.

The prompt budget is the effective context limit minus a bounded safety reserve. It does not reserve the configured maximum output in full. For each request, the manager sets `ModelContext.maxOutputTokens` to the smaller of the configured/model ceiling and remaining prompt space. Providers decide whether and how that generic ceiling appears on the wire.

```text
safetyReserve = clamp(floor(contextLimit × 5%), 256, 8192)
promptBudget = contextLimit - safetyReserve
effectiveMaxOutputTokens = min(configured-or-metadata max output, promptBudget - estimatedPromptTokens)
```

At least 512 prompt tokens must remain. The effective context limit is the smaller of the configured limit and model metadata window, or the metadata window when configuration omits it.

Automatic compaction begins at 80% of the prompt budget. Candidate cutoffs are limited to safe message boundaries: after a complete assistant turn without calls, or after every result belonging to one assistant tool-call group. The manager scans oldest to newest and selects the first boundary whose maximum summary placeholder, active boundary runtime state, and recent raw messages fit the 10% target. It defers when no safe boundary exists but the prompt still fits, and fails when safe recovery is impossible.

Runtime-context messages never enter summary-policy input. At the checkpoint boundary, only the last state for each source is reprojected after the summary when that state is active; all later transitions retain original order. Tool-result policy context remains ordinary summarized conversation context unless its own provenance contract says otherwise.

An injected `CompactPolicy` produces the summary. Kana calls the main Agent's current Model once with `generate()` and no tools rather than starting another Agent loop. It supplies the previous cumulative summary plus newly covered messages, omitting assistant thinking, assistant usage, and structured host results while retaining model-visible tool content, errors, and eligible visual observations. The response must end with `stop` and fit the summary budget; otherwise the preceding checkpoint remains active.

Image observations follow the effective model and Agent image policy. Supported requests receive structured images and metadata so the summary can preserve visual facts as text. Unsupported or disabled image input receives omission metadata without base64 and can still complete compaction.

Prompt estimates distinguish replayable context from billed response input. A response without provider-hosted tools becomes an exact `input_tokens` anchor; later persisted messages add local estimates. Hosted-tool responses do not replace the anchor because transient provider material may be billed but absent from replayable history. A resumed Agent rebuilds the anchor from the latest persisted clean assistant response after the active checkpoint. Without a valid anchor it estimates the complete projection locally, using conservative UTF-8 text, protocol/schema overhead, and image patch counts.

A definite provider context-window rejection may trigger one forced compaction and retry only before assistant output begins. Partial output, a second rejection, or no safe cutoff is terminal. Manual `/compact` forces the same policy without adding synthetic input. In both cases the checkpoint is adopted only after its injected commit hook succeeds. The checkpoint record and resume rules belong to [Sessions and memory](sessions-and-memory.md).

## Commit boundary

An optional `AgentJournal` turns in-memory transitions into write-before-use contracts. Run input and changed runtime context are committed before model I/O; the complete assistant call message is committed before its tools execute; tool results reach history in model order; and a compaction checkpoint is committed before adoption. The exact session record sequence and interrupted-turn repair belong to [Sessions and memory](sessions-and-memory.md).

After the journal closes the run outcome, `onRunCommitted` performs aggregate product work such as accounting and automatic memory scheduling. Only after both journal and post-processing succeed do listeners and the stream receive final `agent_end`. Failure rejects the stream without first publishing success, and `isRunning` remains true until the complete boundary settles.

Generic embedders may omit the journal and commit hooks; the same state machine then remains entirely in memory.

## Extension constraints

- Preserve `MessageId` and required provenance when copying or moving messages.
- Emit complete immutable snapshots; do not expose mutable internal message or event objects.
- Resolve dynamic prompt state and tools once per model step and use that same tool set for execution.
- Add runtime context only for authoritative changing state with explicit active/inactive semantics.
- Keep compaction cutoffs after complete assistant/tool-result units so replay never creates an orphan call or result.
- Keep product scheduling, persistence paths, and frontend projection outside the reusable Agent layer.
