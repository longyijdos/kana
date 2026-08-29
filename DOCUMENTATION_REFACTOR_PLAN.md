# Documentation Refactor Plan

Tracking issue: [#98 — consolidate documentation and prevent append-only growth](https://github.com/longyijdos/kana/issues/98)

Status: Phase 1 is ready for maintainer review; Phases 2–5 have not started.

This file coordinates the multi-stage refactor. It is not part of the canonical developer documentation and must not be added to `docs/README.md`. Before the final merge, decide whether to remove it or retain it as a completed maintenance record.

## Objective

Make Kana's documentation a compact description of the current implementation. Each implementation fact should have one canonical owner, while other documents provide only the local summary and cross-reference needed to follow their own subject.

This effort changes documentation and contributor guidance only. It does not add product behavior or refactor production code.

## Working principles

- Organize documentation around stable subsystem and protocol boundaries, not one file per source directory.
- Let each title and opening paragraph establish the subject naturally; add cross-references only where the surrounding explanation needs them.
- Move or delete superseded explanations when responsibility changes; do not preserve implementation history in current-state documentation.
- Keep architecture focused on stable boundaries, dependency direction, composition roots, and high-level data flow.
- Document invariants, lifecycle order, failure semantics, persistence and wire formats, security boundaries, and extension contracts.
- Leave details that are apparent from local code structure out of the documentation.
- Keep English and Chinese documents structurally and semantically aligned in every phase.
- Stop for review after each phase before starting the next one.

## Target document set

The `docs/` directory remains flat. `docs/README.md` and `docs/README.zh-CN.md` group the documents by purpose and provide the canonical ownership map.

| Document | Action | Canonical ownership |
| --- | --- | --- |
| `architecture.md` | Rewrite and reduce | Top-level layers, dependency direction, composition roots, and high-level startup/run/shutdown paths |
| `conversation-runtime.md` | Add | `KanaConversationHost`, hosted session resources, `ConversationRuntime`, input scheduling, Goal/wake/Job delivery, session transitions, and shutdown coordination |
| `agent-runtime.md` | Rename and narrow from `agent-and-tools.md` | Core message/event contracts, Agent loop, inbox, prompt assembly, runtime context, context budgeting, and compaction |
| `tools.md` | Add by extracting from `agent-and-tools.md` | Tool contracts, validation, approval hook boundary, scheduling, deadlines, result policies, artifacts, built-ins, and background Jobs |
| `sessions-and-memory.md` | Retain and consolidate | Session JSONL, journal ordering, recovery, resume/fork, session-owned artifacts, runtime-log binding, and durable memory |
| `configuration.md` | Retain and narrow | Installation, local file layout, configuration schema, defaults, resolution, validation, approval configuration, and user-visible clean-mode contract |
| `skills-and-prompt.md` | Retain and consolidate | Skill discovery and activation, project instructions, and system-prompt composition |
| `providers.md` | Add | Shared Model/provider contracts, metadata, request lifecycle, HTTP/retry primitives, Responses processing, usage, and context-limit normalization |
| `deepseek-provider.md` | Retain and narrow | DeepSeek-specific model metadata, requests, authentication, replay, and error mapping |
| `openai-codex-provider.md` | Retain and narrow | Codex-specific authentication, request/replay behavior, hosted search, citations, and account semantics |
| `custom-provider.md` | Retain and narrow | Custom-provider configuration and OpenAI-compatible behavior and security constraints |
| `oauth.md` | Add | Generic discovery, PKCE, callback, token exchange, refresh coordination, persistence boundary, and security invariants |
| `mcp.md` | Add | MCP protocol, connection/client/transport boundaries, tool adaptation, manager/runtime lifecycle, OAuth integration, reload, and failure isolation |
| `tui.md` | Retain and narrow | TUI application lifecycle, controllers, commands, focus, input routing, and event projection |
| `terminal-rendering.md` | Add | Terminal runtime, layout, differential repaint, cursor and width handling, Markdown, LaTeX, Mermaid, and tool presentation |
| `headless.md` | Retain and narrow | `kana exec`, approval behavior, output projection, JSONL protocol, signals, deadlines, and exit status |
| `releasing.md` | Retain and extend | Release preparation and automation plus distribution and self-update invariants |
| `terminal-bench.md` | Retain | Terminal-Bench setup, adapter behavior, execution, and result interpretation |

Every new or renamed English document has a matching `.zh-CN.md` document.

## Code-to-document routing

This is the default lookup map for future changes. Cross-boundary changes may require more than one owner document.

| Code area | Primary document |
| --- | --- |
| `src/main.ts`, `src/cli`, `src/version.ts` | `architecture.md`, then the command-specific configuration, headless, or release document |
| `src/core` | `agent-runtime.md`, `tools.md`, or `providers.md`, according to the contract being changed |
| `src/agent` | `agent-runtime.md`; tool execution and result-policy files route to `tools.md` |
| `src/tools`, `src/jobs`, `src/kana/tools`, `src/kana/artifacts` | `tools.md` |
| `src/kana/conversation` | `conversation-runtime.md` |
| `src/kana/session`, `src/kana/memory`, session-bound logging/accounting | `sessions-and-memory.md` |
| `src/kana/config`, launch mode, approval configuration | `configuration.md` |
| `src/kana/skills`, prompt composition | `skills-and-prompt.md` |
| `src/providers` | `providers.md` plus one provider-specific document when behavior is adapter-specific |
| `src/oauth`, shared token lifecycle | `oauth.md` |
| `src/mcp`, `src/kana/mcp` | `mcp.md`; configuration fields remain canonical in `configuration.md` |
| `src/tui/app`, TUI process lifecycle | `tui.md` |
| `src/tui/runtime`, `src/tui/render`, presentation components and tool renderers | `terminal-rendering.md` |
| `src/headless` | `headless.md` |
| `src/kana/update`, release scripts and workflows | `releasing.md` |
| Thin helpers such as `src/utils` and `src/logging` | The subsystem document that owns their externally meaningful behavior |

## Documentation granularity

Create a standalone document when a subject has at least two of these properties:

- an independent public, wire, persistence, or runtime contract;
- its own lifecycle, state machine, recovery behavior, or failure semantics;
- multiple consumers that should not own the shared behavior;
- an independent security or trust boundary;
- enough cohesive material to review and maintain separately;
- changes that can usually be understood without reading an unrelated subsystem.

Keep a subject inside its owning document when it is a leaf helper, always changes with its parent boundary, has no independent invariant, or would merely restate local code.

Suggested size signals, not acceptance limits:

- architecture overview: roughly 2,000–3,000 English words;
- subsystem document: roughly 1,500–4,000 English words;
- configuration and wire-format references may be longer when tables remain cohesive;
- review ownership when a document exceeds 5,000 words or one section approaches 1,000 words.

## Layered ownership examples

One feature may have different facts owned by different documents without duplicating the same explanation.

### Context compaction

- Selection, projection, budgeting, and runtime-context semantics: `agent-runtime.md`.
- Checkpoint JSONL, adoption persistence, resume, and fork: `sessions-and-memory.md`.
- `/compact` interaction and event projection: `tui.md` or `headless.md`.
- Marker, status, and context-percentage rendering: `terminal-rendering.md`.

### MCP

- Config fields, defaults, validation, and trust warnings: `configuration.md`.
- Protocol, transports, OAuth integration, manager lifecycle, and reload semantics: `mcp.md`.
- Conversion into ordinary Agent tools: `tools.md`, summarized with a link to `mcp.md`.
- `/mcp` interaction, focus, and transcript projection: `tui.md`.

### Clean mode

- User-visible capability and persistence contract: `configuration.md`.
- Product composition and resource-lifecycle mechanism: `conversation-runtime.md`.
- TUI notice/status and unavailable commands: `tui.md`.
- Headless flags, output, and exit behavior: `headless.md`.

## Execution phases

### Phase 0 — Plan and ownership review

Deliverables:

- Review this target document set and code-to-document routing.
- Resolve disputed owners before moving prose.
- Record any scope adjustments in this plan.

Review checkpoint:

- The maintainer approves the ownership model and first implementation phase.

### Phase 1 — Runtime and durable state

Implementation status: ready for maintainer review. Do not begin Phase 2 until the review checkpoint is approved.

Deliverables:

- Add `conversation-runtime.md` and its Chinese counterpart.
- Rename `agent-and-tools.md` to `agent-runtime.md` and split tool material into `tools.md`, with matching Chinese changes.
- Consolidate Agent/runtime, runtime-context, compaction, journal-ordering, recovery, Goal, wake, and Job descriptions into their canonical owners.
- Tighten `sessions-and-memory.md` around persistence and durable-state ownership.
- Remove the migrated runtime detail from architecture, TUI, and headless documents and replace it with concise cross-references.
- Update both documentation indexes for the documents that now exist.

Review checkpoint:

- Trace one prompt, queued input, compaction, and session transition without encountering competing canonical descriptions.

### Phase 2 — Providers, OAuth, and MCP

Deliverables:

- Add `providers.md`, `oauth.md`, and `mcp.md` with Chinese counterparts.
- Move shared provider lifecycle and protocol behavior out of architecture and provider-specific documents.
- Move MCP protocol, transport, authorization, manager, and runtime behavior out of architecture and configuration.
- Leave configuration schema and validation in `configuration.md`.
- Leave provider-specific wire and authentication differences in their adapter documents.
- Reduce Agent and TUI MCP coverage to their local integration behavior.
- Update both documentation indexes.

Review checkpoint:

- Shared provider, OAuth, and MCP behavior each has one detailed owner, while consumer documents describe only their integration-specific contract.

### Phase 3 — TUI and terminal rendering

Deliverables:

- Add `terminal-rendering.md` and its Chinese counterpart.
- Restrict `tui.md` to application lifecycle, interaction controllers, commands, focus, and event projection.
- Move terminal runtime, layout, repaint, cursor, width, Markdown, LaTeX, Mermaid, and tool-presentation behavior to the rendering document.
- Remove controller and rendering detail from architecture.
- Keep frontend-neutral runtime behavior in `conversation-runtime.md`.
- Update both documentation indexes.

Review checkpoint:

- A controller change and a renderer change lead to different, unambiguous owner documents.

### Phase 4 — Architecture, configuration, and remaining owners

Deliverables:

- Rewrite architecture as the concise system map and entry point.
- Finish trimming configuration, Skills, headless, sessions/memory, and provider documents.
- Move self-update implementation invariants from architecture into `releasing.md`.
- Replace duplicated local-state tables or behavior matrices with one canonical description and links.
- Add final ownership guidance to `docs/README.md` and `docs/README.zh-CN.md`.
- Update `AGENTS.md` to require consolidation/removal of superseded documentation and tests.

Review checkpoint:

- Architecture answers where code belongs and where details are documented without becoming the detailed owner itself.

### Phase 5 — Consistency audit and completion

Deliverables:

- Search all English and Chinese documents for the issue's duplicate topics.
- Classify each repeated occurrence as a local summary, cross-reference, or remaining duplication.
- Remove stale implementation history and obsolete terminology.
- Verify English/Chinese heading structure, links, code names, protocol versions, configuration keys, and examples.
- Verify every target document has a clear subject and uses cross-references only where they help the local explanation.
- Run relevant formatting, repository, and link checks.
- Decide whether this working plan remains in the final change.

Review checkpoint:

- The issue acceptance criteria are satisfied and the documentation still describes the current implementation.

## Per-phase review checklist

- [ ] English and Chinese files were changed together.
- [ ] New links resolve and renamed files have no remaining references.
- [ ] Detailed facts removed from one document exist in exactly one canonical owner.
- [ ] Cross-references contain only the summary needed by the referring document.
- [ ] No future design proposal is presented as current behavior.
- [ ] Code names, paths, formats, versions, defaults, and ordering match the repository.
- [ ] The phase did not introduce production-code, test, or release-highlight changes.
- [ ] The maintainer reviewed the phase before the next phase began.

## Completion criteria

- The documentation index contains an explicit ownership and code-routing model.
- `architecture.md` is substantially shorter and limited to stable architecture.
- Conversation runtime, Agent runtime, tools, providers, OAuth, MCP, and terminal rendering have canonical owners.
- Runtime context, compaction, journal ordering, recovery, clean mode, TUI lifecycle, and configuration behavior are not described in detail in multiple places.
- Stale and superseded text is removed rather than retained as history.
- `AGENTS.md` prevents append-only documentation and test maintenance.
- English and Chinese documents remain aligned.
- The resulting document set describes the implementation at the branch head.
