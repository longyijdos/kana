# Kana developer documentation

Project overview: [Chinese README](../README.md) · [English README](../README.en.md)

This directory describes the current implementation, not future design proposals. Documents are separated by code boundary; update the corresponding article when changing its protocol or persistence format.

Recommended reading order:

1. [Architecture overview](architecture.en.md): module layering, startup, and the two primary data flows.
2. [Configuration and installation](configuration.en.md): CLI, local files, configuration fields, and approval modes.
3. [Agent and tool execution protocol](agent-and-tools.en.md): messages, streams, turn loop, and built-in tools.
4. [Sessions and memory](sessions-and-memory.en.md): JSONL sessions, daily memory, and consolidation transactions.
5. [Skills and the system prompt](skills-and-prompt.en.md): discovery, activation, and context composition.
6. [DeepSeek provider adapter](deepseek-provider.en.md): request conversion, SSE, retries, and usage.
7. [OpenAI Codex provider adapter](openai-codex-provider.en.md): OAuth, Responses Lite, SSE, and provider state.
8. [Headless execution and the JSONL protocol](headless.en.md): `kana exec`, approvals, output, and exit semantics.
9. [Local Terminal-Bench evaluation](terminal-bench.en.md): Harbor adapter, run parameters, proxying, and results.
10. [TUI interaction and rendering](tui.en.md): terminal I/O, controllers, input, and differential repainting.

Chinese versions:

- [架构总览](architecture.md)
- [配置与安装](configuration.md)
- [Agent 与工具执行协议](agent-and-tools.md)
- [会话与记忆](sessions-and-memory.md)
- [Skills 与系统提示词](skills-and-prompt.md)
- [DeepSeek 提供商适配](deepseek-provider.md)
- [OpenAI Codex 提供商适配](openai-codex-provider.md)
- [无头执行与 JSONL 协议](headless.md)
- [Terminal-Bench 本地评测](terminal-bench.md)
- [TUI 交互与渲染](tui.md)
