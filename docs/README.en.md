# Kana developer documentation

This directory describes the current implementation, not future design proposals. Documents are separated by code boundary; update the corresponding article when changing its protocol or persistence format.

Recommended reading order:

1. [Architecture overview](architecture.en.md): module layering, startup, and the two primary data flows.
2. [Configuration and installation](configuration.en.md): CLI, local files, configuration fields, and approval modes.
3. [Agent and tool execution protocol](agent-and-tools.en.md): messages, streams, turn loop, and built-in tools.
4. [Sessions and memory](sessions-and-memory.en.md): JSONL sessions, daily memory, and consolidation transactions.
5. [Skills and the system prompt](skills-and-prompt.en.md): discovery, activation, and context composition.
6. [DeepSeek provider adapter](deepseek-provider.en.md): request conversion, SSE, retries, and usage.
7. [TUI interaction and rendering](tui.en.md): terminal I/O, controllers, input, and differential repainting.

Chinese versions:

- [架构总览](architecture.md)
- [配置与安装](configuration.md)
- [Agent 与工具执行协议](agent-and-tools.md)
- [会话与记忆](sessions-and-memory.md)
- [Skills 与系统提示词](skills-and-prompt.md)
- [DeepSeek 提供商适配](deepseek-provider.md)
- [TUI 交互与渲染](tui.md)
