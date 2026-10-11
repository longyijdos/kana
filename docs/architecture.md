# Kana Architecture Overview

Kana is a Bun-based terminal agent. Model calls, tool execution, product composition, and local persistence run in one process, exposed through an interactive TUI, headless execution, or an experimental HTTP server. This overview maps stable module boundaries and data flow; detailed contracts live in the linked subsystem documents.

## System layers

```text
L7  main.ts
L6  cli
L5  tui, headless, server            frontends
L4  kana                             product composition
L3  agent, mcp
L2  tools
L1  oauth, jobs, providers           reusable infrastructure
L0  core, utils, logging, version.ts leaves with no top-level dependencies
```

`core` contains provider-neutral messages, model metadata, streams, usage, and tool specifications. `agent` owns the conversation loop and context projection; executable tools add validation and execution around Core specifications. `providers` translates Core model requests to external wire protocols. `oauth` is generic, while `mcp` adds remote-tool protocol behavior.

`kana` is the product layer. It resolves configuration and local paths, composes Agents, owns sessions and memory, activates Skills and MCP, and exposes frontend-neutral conversation operations. `tui`, `headless`, and `server` consume that layer; none owns model protocols or persistence formats.

## Enforced dependencies

Each top-level source module belongs to one layer in the diagram above and may import only modules on a strictly lower layer; modules on the same layer do not import each other. Adding a module means choosing its layer. `utils` holds dependency-free pure functions used by at least two top-level modules; a helper used by one module stays inside that module.

`bun run check:architecture` enforces this layering and detects runtime and type-only cycles. Imports within one top-level `src` directory are relative. Cross-directory imports use the target barrel, such as `@/core`, rather than deep aliases.

Inside `src/kana`, domain directories remain distinct: `config`, `conversation`, `session`, `memory`, `skills`, `mcp`, `tools`, `auth`, and `update`. Shared `KANA_HOME` path construction stays at this product layer because several domains consume it.

## Composition roots

`src/main.ts` delegates to `runCli`. Commands either perform a bounded operation—installation, reset, authentication, Skills management, update—or launch one of the three conversation frontends. Configuration and command semantics are documented in [Configuration and installation](configuration.md), [Headless execution](headless.md), [Experimental HTTP server](server.md), and [Release process](releasing.md).

`KanaConversationHost` is the frontend-shared product boundary. It creates or restores hosted sessions, composes model and tool capabilities, binds persistence and logging, and exposes transitions used by `ConversationRuntime`. `createKanaAgent` assembles one selected model, stable prompt sources, effective runtime policy, built-in tools, and the current MCP registry capability.

The TUI composes controllers over `ConversationRuntime`; headless mode projects the same runtime into text or versioned JSONL, and server mode provides authenticated HTTP operations and SSE. Frontend behavior may differ, but Agent execution, input ordering, Goals, session transitions, and cleanup remain shared. See [Conversation runtime](conversation-runtime.md), [TUI interaction](tui.md), [Terminal rendering](terminal-rendering.md), and [Headless execution](headless.md).

## Startup and shutdown

Normal and clean launches pass an explicit mode through the frontend, host, and every rebuilt Agent. Normal mode may load project instructions, memory, Skills, persistence, accounting, and MCP. Clean mode keeps runtime configuration, environment, authentication, approval, and core tools, but removes durable session resources and optional project capabilities. The complete user-visible contract belongs to [Configuration and installation](configuration.md).

Interactive startup makes the chosen session visible before connecting selected MCP servers, then rebuilds the Agent with `mcp_list_tools`, `mcp_get_tool`, and `mcp_call`; remote schemas remain in the internal catalog. Headless startup performs the corresponding host initialization without TUI projection. Both reject clean-mode resume and use the same host invariants.

Shutdown flows from frontend to shared runtime, hosted session resources, background product work, and the MCP runtime before the terminal or process completes. Each owner makes its close operation idempotent and prevents queued work from reviving a closed resource. Detailed ordering belongs to [Conversation runtime](conversation-runtime.md), [MCP](mcp.md), and the frontend documents.

## Conversation data flow

```text
user or scheduled input
  → ConversationRuntime
  → Agent
  → prompt and context projection
  → selected Model adapter
  → ordered assistant events
  → optional ToolRuntime calls
  → committed messages and runtime events
     ├→ session persistence in normal mode
     ├→ TUI transcript and status
     ├→ headless text or JSONL
     └→ server HTTP state or SSE
```

Core messages and model events are frontend- and provider-neutral. The Agent commits complete messages, coordinates steering and queued input, and delegates tool execution without knowing the frontend. Providers retain their wire-specific replay state behind Core content. Tool results re-enter the same history before the next model step.

The detailed owners are [Agent runtime](agent-runtime.md), [Providers](providers.md), and [Tools and execution](tools.md). Checkpoint persistence and recovery belong to [Sessions and memory](sessions-and-memory.md).

## State and trust boundaries

Normal local state is rooted at `KANA_HOME`, defaulting to `~/.kana`. Configuration owns file names, fields, defaults, and validation. Sessions and memory own durable formats and recovery. OAuth owns generic token-session invariants; Kana supplies the local credential store. MCP configuration can launch local processes or contact remote servers, so server definitions are a code, data, and credential trust boundary.

Tool approval is visible authorization, not an operating-system sandbox. File and shell tools can act outside the startup workspace when given paths that resolve there. Provider endpoints, MCP endpoints, OAuth servers, environment variables, and local plaintext credential files must be treated according to their owning security guidance.

See [Configuration and installation](configuration.md), [Sessions and memory](sessions-and-memory.md), [OAuth](oauth.md), [MCP](mcp.md), and [Tools and execution](tools.md).

## Documentation routing

| Change area | Detailed owner |
| --- | --- |
| Conversation composition, input delivery, Goals, session transitions | [Conversation runtime](conversation-runtime.md) |
| Messages, prompt context, Agent loop, compaction | [Agent runtime](agent-runtime.md) |
| Tool execution, approval hook, Jobs, artifacts | [Tools and execution](tools.md) |
| Provider lifecycle and shared protocol codecs | [Providers](providers.md) |
| Adapter-specific requests and replay | [DeepSeek](deepseek-provider.md), [OpenAI Codex](openai-codex-provider.md), or [Custom](custom-provider.md) |
| Provider token lifecycle, PKCE, shared callback and persistence | [OAuth](oauth.md) |
| MCP transports, client, manager, and reload | [MCP](mcp.md) |
| Session JSONL, recovery, accounting, memory | [Sessions and memory](sessions-and-memory.md) |
| Configuration schema, defaults, local files, clean mode | [Configuration and installation](configuration.md) |
| Skills and system-prompt composition | [Skills and the system prompt](skills-and-prompt.md) |
| TUI commands, focus, controllers, event projection | [TUI interaction](tui.md) |
| Layout, repaint, width, Markdown, tool presentation | [Terminal rendering](terminal-rendering.md) |
| HTTP API, SSE, remote approval, long-lived process lifecycle | [Experimental HTTP server](server.md) |
| Kana Agent GitHub integration | [Kana Agent reusable workflow](kana-agent-workflow.md) |
| Release automation, distribution, self-update | [Release process](releasing.md) |

Cross-boundary changes should update each affected owner, but repeat only the summary needed to connect those boundaries. The documentation index contains the complete code-to-document lookup map.
