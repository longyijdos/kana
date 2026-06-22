# Kana 开发文档

本目录记录当前实现，而不是未来设计提案。文档按代码边界拆分；修改相应协议或持久化格式时，应同步更新对应文章。

建议的阅读顺序：

1. [架构总览](architecture.md)：模块分层、启动与两条主数据流。
2. [配置与安装](configuration.md)：CLI、本地文件、配置字段和审批模式。
3. [Agent 与工具执行协议](agent-and-tools.md)：消息、流、回合循环和内置工具。
4. [会话与记忆](sessions-and-memory.md)：JSONL 会话、每日记忆与合并事务。
5. [Skills 与系统提示词](skills-and-prompt.md)：发现、启用和上下文装配。
6. [DeepSeek 提供商适配](deepseek-provider.md)：请求转换、SSE、重试和用量。
7. [TUI 交互与渲染](tui.md)：终端 I/O、控制器、输入与差量重绘。

对应英文版本：

- [Architecture overview](architecture.en.md)
- [Configuration and installation](configuration.en.md)
- [Agent and tool execution protocol](agent-and-tools.en.md)
- [Sessions and memory](sessions-and-memory.en.md)
- [Skills and the system prompt](skills-and-prompt.en.md)
- [DeepSeek provider adapter](deepseek-provider.en.md)
- [TUI interaction and rendering](tui.en.md)
