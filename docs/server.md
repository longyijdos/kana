# Experimental HTTP server

`kana serve` exposes the shared conversation runtime through Bun’s native HTTP server. It is a single-user, single-workspace frontend with one active session, not a multi-tenant service. It requires no additional package dependencies and provides no UI.

## Launch and lifetime

```bash
export KANA_SERVER_TOKEN="$(openssl rand -hex 32)"
bun src/main.ts serve                 # source checkout
kana serve --port 8318               # compiled binary
```

The default port is 8318; `--port` accepts integers from 1 through 65535. The listener is fixed to `127.0.0.1`. Every route, including SSE, requires `Authorization: Bearer <token>`. Missing or blank `KANA_SERVER_TOKEN` fails startup before product resources are created. Kana loads its usual environment and configuration; `--set` and `--clean` are supported.

This frontend serves HTTP only. HTTPS, certificates, renewal, public ingress, and process supervision belong to deployment. Never expose it through an unencrypted public proxy: the token grants access to the Agent’s real tools and local files. It is authorization, not an operating-system sandbox. No CORS headers are supplied. Native clients and a future same-origin frontend can send Authorization headers; browser `EventSource` cannot, so use streaming `fetch`. Tokens are not accepted in URLs or logged.

Startup creates a fresh session and initializes selected MCP servers before accepting requests. Non-ready MCP diagnostics are printed to stderr. Normal sessions persist using the same workspace-scoped storage as the TUI. Restart does not automatically resume an old session or interrupted execution. Wakes, queued input, Goals, Jobs, and pending approvals are not restored on restart. Client disconnect never cancels Agent execution or pending approval. `SIGINT` and `SIGTERM` stop ingress and close event streams, then settle the runtime and host in their usual order.

Clean mode retains temporary session creation and core execution but removes durable resources and optional project capabilities. Fork, resume, and saved-session deletion return 400 in clean mode. This API does not register `delegate_user_task`, parse TUI slash commands, or provide model/Skill/MCP management endpoints.

## HTTP contract

JSON success responses are `{schema_version: 1, data: ...}`. Errors are `{schema_version: 1, error: {code, message}}`. JSON responses and SSE encode BigInt values as decimal strings without changing execution-local results. Other values follow standard JSON serialization; cyclic values are unsupported. Request bodies must be JSON objects; the native server limits bodies to 1 MiB. Unknown routes return 404; authentication failures return 401; invalid input returns 400; session mismatch or a busy transition returns 409; shutdown returns 503. Unexpected failures return a generic 500 and a safe structured diagnostic.

| Method and path | Request | Result |
| --- | --- | --- |
| GET /v1/state | — | Complete current state snapshot |
| GET /v1/events | — | SSE, beginning with a snapshot |
| GET /v1/sessions | — | `current_session_id` and saved-session metadata; excludes active session |
| POST /v1/sessions | No body | Create and activate a session; 201 with `session_id` |
| POST /v1/sessions/fork | `{session_id, prompt?}` | Fork and activate; 201 with `session_id` |
| POST /v1/sessions/:id/resume | No body | Restore and activate; `session_id` |
| DELETE /v1/sessions/:id | No body | Delete saved, non-active session; `{deleted: true}` |
| POST /v1/messages | `{session_id, message, delivery?}` | Admission; 202 with `message_id` and `delivery` |
| POST /v1/abort | `{session_id}` | Request cancellation; 202 with `{stopping: true}` |
| GET /v1/approvals | — | Pending approvals |
| POST /v1/approvals/:id | `{session_id, decision}` | Resolve approval; `{resolved: true}` |

The current `session_id` is required for messages, abort, fork, and approval decisions so a stale client cannot accidentally act on a newly selected session. Creation, fork, resume, and deletion require an idle runtime. Saved sessions are scoped to the startup workspace. The active session cannot be deleted.

Message `delivery` defaults to `auto`: idle input starts a run; active, steerable input enters the steering lane; other active input enters the next-turn queue. `queue` always enters that queue. Response delivery is `submitted`, `steering`, or `queued`, acknowledging admission rather than completion. Steering can later become queued under existing runtime semantics. Aborting follows existing cancellation policy and does not independently clear queued messages. Observe runtime events and state to see what executes next.

## Approvals

The same configured policy and persisted command trust as the TUI decide whether a tool needs approval. Each pending entry contains `id`, `session_id`, requester `agent`, `tool_call: {id, name, arguments}`, and `allow_always`. Main and delegated Agents use the same hook.

Decisions are `allow` (once), `reject` (abort the run), `always` (persist exact shell-command trust), or `never` (temporarily stop asking for this session). Only shell commands support `always`. Permanent trust and temporary never mode also release matching pending approvals. Temporary mode resets on session change. Cancellation and shutdown reject pending requests. Already settled approval IDs return 404. With no connected client, untrusted tools remain waiting until a decision, cancellation, or shutdown.

## State and event protocol

A snapshot contains `session` (ID, messages, timeline, or null), `running` (runtime exclusion state), `run` (latest process-local ID, source, status, optional outcome/error, or null), `assistant` (in-progress message or null), `tools` (current run’s outer execution states), `context`, `input_queue`, `todo`, `goal`, and `approvals`. Messages use Core’s provider-neutral shapes; opaque assistant-content `providerState` and context checkpoints are not exposed. Run status is `running`, `completed`, or `failed`. Completed does not necessarily mean successful: inspect outcomes such as `stop`, `aborted`, or `error`.

`context` is `{estimated_tokens: number | null, context_limit: number}`. It uses the same context estimate as the TUI and the configured effective limit, falling back to the model's context window. An unavailable estimate is `null`. The estimate describes active prompt context, including compaction, rather than cumulative API token consumption or the entire retained transcript. `context.updated` carries the same shape after input consumption, completed model/tool turns, compaction, run completion or failure, and session changes. It is not emitted for each streaming text delta; reconnect snapshots restore the runtime's current estimate.

`session.messages` is the authoritative message-body collection. In `session.timeline`, message entries contain `message_id` instead of an embedded `message`; resolve it against `session.messages[].id`. Entry `id`, `parentId`, `timestamp`, and timeline order are preserved. Non-message entries remain unchanged. This retains interleaved history without duplicating message text, images, or structured results.

`session.timeline` is queried from the host’s latest committed history for every state or SSE snapshot, including reconnects. Uncommitted assistant streaming content remains in `assistant`, not timeline. Clean mode has no committed timeline. No separate timeline SSE event is emitted.

Each SSE frame has an `event` name matching its JSON `type` and a `data` object:

```text
event: run.started
data: {"schema_version":1,"type":"run.started","session_id":"...","run_id":"...","data":{"source":"user","input":{...}}}
```

The first frame always replaces client state with a fresh snapshot. Subsequent events follow without a subscription gap. Heartbeat comments arrive every 15 seconds. Slow consumers whose pending stream buffer reaches 1 MiB are disconnected instead of blocking the Agent. Reconnect to resynchronize: there is no event replay or `Last-Event-ID` support. A new process/session resets transient projection. On `session.changed`, fetch state again to replace history.

| Event | Data |
| --- | --- |
| snapshot | Complete state snapshot |
| run.started | `source` and admitted `input` |
| run.completed | `outcome` and optional `goal` |
| run.failed | `error: {name, message}` |
| session.changed | `action`, `session_id` |
| input.queue_changed | Runtime queue snapshot |
| input.committed | Steered user `message` |
| todo.changed / goal.changed | Todo change / Goal change and state |
| assistant.started / assistant.completed | `message` |
| assistant.delta | `message_id`, `kind`, `content_index`, `delta` |
| assistant.content | `message_id`, `content_index`, replacement `content` block |
| model_turn.started / model_turn.completed | `turn`; completion also includes `usage` |
| tool.started | Tool identity, `status`, `arguments` |
| tool.updated | Tool identity, `partial_result` |
| tool.completed | Tool identity, `status`, `result`, `is_error` |
| tool.paused / tool.resumed | Tool identity, approval `reason` |
| context.updated | `estimated_tokens` (number or null), `context_limit` |
| context.compaction_started / context.compacted | Reason, token counts, context limit; completion also includes usage |
| approval.required / approval.resolved | Pending approval / `{id, decision}` |

Tool identity is `tool_call_id` and `name`. Code Mode projects only outer lifecycle and output, omitting nested execution events. Tool completion does not guarantee journal commit: wait for `run.completed` and handle `run.failed` separately. Ignore unknown event types and added fields. Deltas may update text, thinking, or raw tool arguments; content-block events and completed messages are authoritative replacements.
