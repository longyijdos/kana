# Conversation runtime

Kana places one product-level runtime between its frontends and the reusable Agent. The TUI and headless runner submit work and consume the same frontend-neutral events; neither frontend owns session persistence, queued-run ordering, or Agent construction.

## Composition boundaries

```text
TUI / Headless
  → ConversationRuntime
      ├→ ConversationInputCoordinator
      │   ├→ Agent-owned inbox
      │   ├→ WakeScheduler
      │   ├→ KanaGoalController
      │   └→ session BackgroundJobClient
      └→ Agent
  → KanaConversationHost
      ├→ HostedSessionRegistry
      ├→ Agent product factory
      ├→ configuration and approvals
      ├→ memory consolidation
      └→ MCP runtime
```

`KanaConversationHost` is the product composition boundary. It loads runtime configuration and approval state, initializes the selected session, owns the shared wake scheduler and MCP runtime, and creates every main Agent with the current model, prompt, built-in tools, external tools, logger, journal, artifact store, background-job client, todo state, and memory callbacks. It returns frontend-neutral operations and data; it does not render TUI components or project headless output.

`HostedSessionRegistry` owns the live resources associated with each session instance. A hosted record binds the session's in-memory mirror, optional journal, logger, artifact store, background-job client, and pending fork snapshot. `ConversationRuntime` selects and executes against those resources through host callbacks rather than opening storage or background processes itself.

`ConversationRuntime` owns the current Agent and session snapshot. `ConversationInputCoordinator` is the narrower scheduling boundary beneath it: it observes the Agent inbox, wakes, Goals, and background-job completions, publishes a detached queue snapshot, and asks the runtime to execute each admitted new run. It does not keep another message queue.

## Run lifecycle and events

A runtime run has one source: `user`, `scheduled`, `goal`, `job`, or `compaction`. The runtime rejects a new run, session transition, or Agent reconfiguration while another run or transition is active. It publishes cloned events so listeners cannot mutate internal state:

```text
run_start
  → agent_event*
  → run_end | run_error
```

`agent_event` carries the reusable Agent protocol unchanged except for defensive cloning. The runtime separately publishes `session_changed`, `input_queue_changed`, `todo_state_changed`, and `goal_state_changed`. Listener failures are isolated and logged as `conversation.listener_failed`; they cannot change execution or cleanup.

For an ordinary run, the runtime marks the source active, subscribes to Agent events, calls `Agent.stream()`, waits for both stream iteration and `result()`, then requires a terminal `agent_end`. A persistence or post-processing failure therefore becomes `run_error` rather than a successful runtime outcome. The active source remains set until the complete Agent boundary settles, keeping submission exclusion authoritative.

Manual compaction uses the same exclusion and event path but calls `Agent.compact()` without creating a user message or entering the response loop. The Agent owns compaction policy and checkpoint adoption; the runtime only exposes it as a conversation operation.

## One inbox and one drain gate

The Agent owns both in-process inbox lanes:

- `next-step` contains input eligible for the next turn of the active Agent run.
- `next-turn` is the FIFO source for later Agent runs.

`ConversationInputCoordinator` observes those lanes; it does not copy their messages or assign another correlation identity. A logical input retains one `MessageId` through scheduling, inbox movement, Agent events, journal commit, replay, and frontend projection.

Enter input offered during an active run first uses `Agent.steer()`. If the Agent commits it at a turn boundary, the result is `steered`. If the run ends before it is claimed, the Agent moves the same item to `next-turn` and the coordinator reports it as `queued`. Tab input enters `next-turn` directly. Input is discarded only when shutdown or a session change makes its original execution context invalid.

The coordinator's drain loop is the only boundary that starts queued runs. It runs only when:

- no run or session transition is active;
- no previous run is still settling;
- the coordinator is not already draining; and
- the frontend's optional `canStartQueuedRun` gate is open.

It claims the first `next-turn` item, derives the run source from its delivery metadata, and waits for the runtime's explicit completed-or-failed result before considering another item. Frontends can close the gate while a modal workflow such as MCP management is active without moving or duplicating queued messages.

## Scheduled input

`WakeScheduler` stores one-shot timers in memory. Each event belongs to a session, has a due time and origin, and may carry a replacement key. Scheduling a new event with the same session/key removes the older timer. Events are ordered by due time and then `MessageId`; they are never written to the session journal before delivery and are not restored after process exit.

The scheduler assigns the future logical input's `MessageId` when the timer is created. At expiry, the same ID enters the Agent's `next-turn` lane with scheduled provenance. Cancellation checks the current session's future timers first and then its due `next-turn` items synchronously, returning `future`, `pending`, or `not_found`; no separate wake or queue ID exists.

Session changes cancel the previous session's timers and clear its inbox. Shutdown disposes the scheduler after inbox, Goal, and observer cleanup.

## Background-job completion

Each hosted session receives a bound `BackgroundJobClient`. Completion delivery contains bounded Job identity and status, never buffered output. When an Agent run can still accept steering, a completion enters `next-step`; otherwise it enters `next-turn`. Adjacent Job completions at the front of `next-turn` are submitted together without crossing earlier human, scheduled, or Goal input.

Observing a terminal Job through an Agent Job tool acknowledges it and cancels any still-pending completion message with the same Job ID. TUI Job management uses a separate non-consuming view and does not acknowledge completion. Ordinary Job output does not wake the Agent. The execution and retention behavior of Jobs belongs to [Tools and execution](tools.md).

## Goals

A Goal is process-local control state, not session history. Starting one validates the objective, snapshots the configured positive `goal_max_rounds`, creates the first ordinary user run, and exposes the active Goal through runtime context. The model can finish it through `update_goal` as `completed` or `blocked`.

After a Goal run settles, the coordinator admits a continuation only when `next-turn` is empty. Previously queued human, scheduled, deferred, and Job input therefore remains ahead of Goal continuation. Each admitted continuation is an identified internal message with its round metadata. Reaching the snapshot limit produces `round_limit` without starting another run.

User abort cancels the active Goal. Agent reconfiguration, session replacement, and shutdown discard it because the authorized execution context changed. A Goal run error or aborted terminal Agent outcome blocks it. Goal controller state and run budget are never restored from a session; the messages already committed by Goal runs remain ordinary auditable history.

## Agent replacement and session transitions

Agent replacement and session replacement are separate operations:

- Reconfiguration keeps the current session, messages, context checkpoint, and Agent inbox. It builds the candidate Agent before replacing the old one and discards active Goal control state.
- New, fork, and resume create or load a candidate session and build its Agent before mutating current runtime state. Construction failure leaves the current Agent and session usable.

During a session transition, the coordinator closes its drain gate and pauses background-job observation. The runtime asks the host to dispose the previous session with the foreground Agent's `waitForIdle()` promise as a settlement barrier. Only after disposal succeeds does it cancel the previous session's wakes and inbox, adopt the new session and Agent, attach the new Job client, publish `session_changed`, and reopen queue observation.

Fork supplies the current messages and context checkpoint to the host; resume receives committed messages, timeline, checkpoint, and todo state. Their durable formats and recovery rules belong to [Sessions and memory](sessions-and-memory.md).

## Launch mode and cleanup

Normal and clean launch modes use the same runtime types. In clean mode the host registers an ordinary in-process session identity with no journal, a no-op logger, and a temporary artifact store. It does not create memory consolidation or activate MCP, and model changes update only validated in-process configuration. The user-visible capability matrix belongs to [Configuration and installation](configuration.md).

`ConversationRuntime.close()` is idempotent. It prevents new work, discards Goal state, stops wake/inbox/Job observation, clears pending input, aborts the Agent, and asks the host to settle the foreground Agent together with the active session's background Jobs. It then disposes the wake scheduler and listeners.

The frontend closes the runtime before closing the host. Host shutdown stops new memory scheduling and waits for every memory scheduler, lets the registry finish background-job and artifact cleanup, and finally closes MCP. A session replacement cleans that session's artifact store immediately after its foreground and Job barrier; shutdown retains artifact cleanup until the broader host barrier so memory work cannot lose resources it still owns.

## Frontend responsibilities

The TUI owns focus, controllers, transcript blocks, status projection, and user interaction. Headless owns prompt resolution, signal/deadline policy, JSONL or human output projection, and exit status. Both consume runtime events and call the same runtime operations; neither should reproduce inbox ordering, Goal admission, session replacement, or cleanup orchestration.
