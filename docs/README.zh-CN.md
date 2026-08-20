# Kana 开发文档

项目概览：[English README](../README.md) · [中文 README](../README.zh-CN.md)

本目录记录当前实现，而不是未来设计提案。文档按代码边界拆分；修改相应协议或持久化格式时，应同步更新对应文章。

建议的阅读顺序：

1. [架构总览](architecture.zh-CN.md)：模块分层、启动与两条主数据流。
2. [配置与安装](configuration.zh-CN.md)：CLI、本地文件、配置字段和审批模式。
3. [Agent 与工具执行协议](agent-and-tools.zh-CN.md)：消息、流、回合循环和内置工具。
4. [会话与记忆](sessions-and-memory.zh-CN.md)：JSONL 会话、每日记忆与合并事务。
5. [Skills 与系统提示词](skills-and-prompt.zh-CN.md)：发现、启用和上下文装配。
6. [DeepSeek 提供商适配](deepseek-provider.zh-CN.md)：请求转换、SSE、重试和用量。
7. [OpenAI Codex 提供商适配](openai-codex-provider.zh-CN.md)：OAuth、classic Responses、SSE 和 provider state。
8. [自定义 OpenAI-compatible 提供商](custom-provider.zh-CN.md)：静态 Custom 配置、模型 metadata 与安全边界。
9. [无头执行与 JSONL 协议](headless.zh-CN.md)：`kana exec`、审批、输出与退出语义。
10. [Terminal-Bench 本地评测](terminal-bench.zh-CN.md)：Harbor adapter、运行参数、代理与结果。
11. [TUI 交互与渲染](tui.zh-CN.md)：终端 I/O、控制器、输入与差量重绘。
12. [发版流程](releasing.zh-CN.md)：版本策略、Changelog、tag 与 Release 自动化。

对应英文版本：

- [Architecture overview](architecture.md)
- [Configuration and installation](configuration.md)
- [Agent and tool execution protocol](agent-and-tools.md)
- [Sessions and memory](sessions-and-memory.md)
- [Skills and the system prompt](skills-and-prompt.md)
- [DeepSeek provider adapter](deepseek-provider.md)
- [OpenAI Codex provider adapter](openai-codex-provider.md)
- [Custom OpenAI-compatible provider](custom-provider.md)
- [Headless execution and the JSONL protocol](headless.md)
- [Local Terminal-Bench evaluation](terminal-bench.md)
- [TUI interaction and rendering](tui.md)
- [Release process](releasing.md)
