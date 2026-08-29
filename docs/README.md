# Kana developer documentation

Project overview: [English README](../README.md) · [Chinese README](../README.zh-CN.md)

This directory describes the current implementation, not future design proposals. Documents are separated by code boundary; update the corresponding article when changing its protocol or persistence format.

Recommended reading order:

1. [Architecture overview](architecture.md): module layering, startup, and the two primary data flows.
2. [Conversation runtime](conversation-runtime.md): product composition, input delivery, Goals, session transitions, and cleanup.
3. [Agent runtime](agent-runtime.md): messages, streams, prompt context, run loop, inbox, and compaction.
4. [Tools and execution](tools.md): tool contracts, scheduling, deadlines, results, approvals, and built-ins.
5. [Configuration and installation](configuration.md): CLI, local files, configuration fields, and approval modes.
6. [Sessions and memory](sessions-and-memory.md): JSONL sessions, daily memory, and consolidation transactions.
7. [Skills and the system prompt](skills-and-prompt.md): discovery, activation, and context composition.
8. [DeepSeek provider adapter](deepseek-provider.md): request conversion, SSE, retries, and usage.
9. [OpenAI Codex provider adapter](openai-codex-provider.md): OAuth, classic Responses, SSE, and provider state.
10. [Custom OpenAI-compatible provider](custom-provider.md): static Custom configuration, model metadata, and security boundaries.
11. [Headless execution and the JSONL protocol](headless.md): `kana exec`, approvals, output, and exit semantics.
12. [Local Terminal-Bench evaluation](terminal-bench.md): Harbor adapter, run parameters, proxying, and results.
13. [TUI interaction and rendering](tui.md): terminal I/O, controllers, input, and differential repainting.
14. [Release process](releasing.md): version policy, Changelog, tags, and Release automation.

Chinese versions:

- [架构总览](architecture.zh-CN.md)
- [对话运行时](conversation-runtime.zh-CN.md)
- [Agent 运行时](agent-runtime.zh-CN.md)
- [工具与执行](tools.zh-CN.md)
- [配置与安装](configuration.zh-CN.md)
- [会话与记忆](sessions-and-memory.zh-CN.md)
- [Skills 与系统提示词](skills-and-prompt.zh-CN.md)
- [DeepSeek 提供商适配](deepseek-provider.zh-CN.md)
- [OpenAI Codex 提供商适配](openai-codex-provider.zh-CN.md)
- [自定义 OpenAI-compatible 提供商](custom-provider.zh-CN.md)
- [无头执行与 JSONL 协议](headless.zh-CN.md)
- [Terminal-Bench 本地评测](terminal-bench.zh-CN.md)
- [TUI 交互与渲染](tui.zh-CN.md)
- [发版流程](releasing.zh-CN.md)
