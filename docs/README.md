# Kana developer documentation

Project overview: [English README](../README.md) · [Chinese README](../README.zh-CN.md)

This directory describes the current implementation, not future design proposals. Documents are separated by code boundary; update the corresponding article when changing its protocol or persistence format.

Recommended reading order:

1. [Architecture overview](architecture.md): module layering, startup, and the two primary data flows.
2. [Configuration and installation](configuration.md): CLI, local files, configuration fields, and approval modes.
3. [Agent and tool execution protocol](agent-and-tools.md): messages, streams, turn loop, and built-in tools.
4. [Sessions and memory](sessions-and-memory.md): JSONL sessions, daily memory, and consolidation transactions.
5. [Skills and the system prompt](skills-and-prompt.md): discovery, activation, and context composition.
6. [DeepSeek provider adapter](deepseek-provider.md): request conversion, SSE, retries, and usage.
7. [OpenAI Codex provider adapter](openai-codex-provider.md): OAuth, classic Responses, SSE, and provider state.
8. [Headless execution and the JSONL protocol](headless.md): `kana exec`, approvals, output, and exit semantics.
9. [Local Terminal-Bench evaluation](terminal-bench.md): Harbor adapter, run parameters, proxying, and results.
10. [TUI interaction and rendering](tui.md): terminal I/O, controllers, input, and differential repainting.
11. [Release process](releasing.md): version policy, Changelog, tags, and Release automation.

Chinese versions:

- [架构总览](architecture.zh-CN.md)
- [配置与安装](configuration.zh-CN.md)
- [Agent 与工具执行协议](agent-and-tools.zh-CN.md)
- [会话与记忆](sessions-and-memory.zh-CN.md)
- [Skills 与系统提示词](skills-and-prompt.zh-CN.md)
- [DeepSeek 提供商适配](deepseek-provider.zh-CN.md)
- [OpenAI Codex 提供商适配](openai-codex-provider.zh-CN.md)
- [无头执行与 JSONL 协议](headless.zh-CN.md)
- [Terminal-Bench 本地评测](terminal-bench.zh-CN.md)
- [TUI 交互与渲染](tui.zh-CN.md)
- [发版流程](releasing.zh-CN.md)
