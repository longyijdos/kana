# Kana developer documentation

Project overview: [English README](../README.md) · [Chinese documentation](README.zh-CN.md)

These documents describe the current implementation. They are organized by stable subsystem and protocol boundaries rather than source-directory size. Put a detailed fact in one canonical owner; other documents should keep only the local summary and link needed to connect their subject.

## Start here

1. [Architecture overview](architecture.md): layers, enforced dependencies, composition roots, high-level data flow, and routing.
2. [Configuration and installation](configuration.md): commands, local files, schemas, defaults, validation, and clean mode.
3. [Conversation runtime](conversation-runtime.md): product composition, input delivery, Goals, session transitions, and cleanup.

## Runtime and integrations

- [Agent runtime](agent-runtime.md): messages, streams, prompt context, run loop, inbox, context budgets, and compaction.
- [Tools and execution](tools.md): tool contracts, approval hook, scheduling, deadlines, results, artifacts, built-ins, and Jobs.
- [Providers](providers.md): shared model metadata, HTTP lifecycle, Responses and Chat Completions processing, usage, and context errors.
- [DeepSeek provider](deepseek-provider.md): DeepSeek-specific metadata, requests, replay, and errors.
- [OpenAI Codex provider](openai-codex-provider.md): Codex authentication, classic Responses, replay, hosted search, and account behavior.
- [Custom OpenAI-compatible provider](custom-provider.md): Custom configuration, model metadata, compatible behavior, and security.
- [OAuth](oauth.md): discovery, PKCE, callback, token exchange, refresh coordination, and persistence boundary.
- [MCP](mcp.md): JSON-RPC, transports, client, remote tools, manager lifecycle, authorization, and reload.
- [Skills and the system prompt](skills-and-prompt.md): discovery, activation, project instructions, and prompt composition.

## State, frontends, and operations

- [Sessions and memory](sessions-and-memory.md): session JSONL, recovery, artifacts, accounting, logs, durable memory, and consolidation.
- [TUI interaction](tui.md): application lifecycle, commands, focus, controllers, input, and event projection.
- [Terminal rendering](terminal-rendering.md): terminal lifecycle, layout, repaint, cursor and width, Markdown, diagrams, and tool presentation.
- [Headless execution](headless.md): `kana exec`, approval behavior, output, JSONL protocol, deadlines, signals, and exit status.
- [Kana Agent reusable workflow](kana-agent-workflow.md): caller setup, repository-local model configuration, authorization, publication, and version pinning.
- [Local Terminal-Bench evaluation](terminal-bench.md): Harbor adapter, run parameters, proxying, and result interpretation.
- [Release process](releasing.md): version policy, release preparation, distribution, self-update, and automation.

## Change routing

Use the narrowest owner that contains the changed contract. Cross-boundary behavior may require more than one document.

| Code or behavior | Primary document |
| --- | --- |
| `src/kana/conversation` | [Conversation runtime](conversation-runtime.md) |
| `src/core`, `src/agent` | [Agent runtime](agent-runtime.md), [Tools and execution](tools.md), or [Providers](providers.md), according to the contract |
| `src/tools`, `src/jobs`, `src/kana/tools`, `src/kana/artifacts` | [Tools and execution](tools.md) |
| `src/providers` | [Providers](providers.md), plus the matching adapter document for adapter-specific behavior |
| `src/oauth` | [OAuth](oauth.md) |
| `src/mcp`, `src/kana/mcp` | [MCP](mcp.md); fields and defaults remain in [Configuration](configuration.md) |
| `src/kana/session`, `src/kana/memory`, session-bound logging and accounting | [Sessions and memory](sessions-and-memory.md) |
| `src/kana/config`, launch mode, approval configuration | [Configuration and installation](configuration.md) |
| `src/kana/skills`, prompt composition | [Skills and the system prompt](skills-and-prompt.md) |
| `src/tui/app`, TUI process lifecycle | [TUI interaction](tui.md) |
| `src/tui/runtime`, `src/tui/render`, presentation components and tool renderers | [Terminal rendering](terminal-rendering.md) |
| `src/headless` | [Headless execution](headless.md) |
| `.github/workflows/kana-agent*`, `.github/kana` | [Kana Agent reusable workflow](kana-agent-workflow.md) |
| `src/kana/update`, release scripts and workflows | [Release process](releasing.md) |
| Thin helpers such as `src/utils` and `src/logging` | The subsystem document that owns their externally meaningful behavior |

When behavior moves, consolidate it into the new owner and remove the superseded explanation. Keep English and Chinese documents structurally and semantically aligned, and update both indexes whenever the document set changes.
