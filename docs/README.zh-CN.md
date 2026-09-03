# Kana 开发文档

项目概览：[中文 README](../README.zh-CN.md) · [English documentation](README.md)

这些文档描述当前实现，按稳定子系统与协议边界组织，而不是按源码目录大小切分。详细事实只放在一个 canonical owner 中；其它文档只保留连接本地主题所需的摘要与链接。

## 从这里开始

1. [架构总览](architecture.zh-CN.md)：分层、强制依赖、装配入口、高层数据流与路由。
2. [配置与安装](configuration.zh-CN.md)：命令、本地文件、schema、默认值、校验与 clean mode。
3. [对话运行时](conversation-runtime.zh-CN.md)：产品装配、输入投递、Goal、session 切换与清理。

## 运行时与集成

- [Agent 运行时](agent-runtime.zh-CN.md)：消息、stream、prompt context、run loop、inbox、上下文预算与压缩。
- [工具与执行](tools.zh-CN.md)：工具契约、审批 hook、调度、deadline、结果、artifact、内置工具与 Job。
- [供应商](providers.zh-CN.md)：共享模型 metadata、HTTP 生命周期、Responses 与 Chat Completions 处理、用量和上下文错误。
- [DeepSeek 提供商](deepseek-provider.zh-CN.md)：DeepSeek 专用 metadata、请求、replay 与错误。
- [OpenAI Codex 提供商](openai-codex-provider.zh-CN.md)：Codex 认证、classic Responses、replay、托管搜索与账号行为。
- [自定义 OpenAI-compatible 提供商](custom-provider.zh-CN.md)：Custom 配置、模型 metadata、兼容行为与安全边界。
- [OAuth](oauth.zh-CN.md)：discovery、PKCE、callback、token exchange、refresh 协调与持久化边界。
- [MCP](mcp.zh-CN.md)：JSON-RPC、transport、client、远端工具、manager 生命周期、授权与 reload。
- [Skills 与系统提示词](skills-and-prompt.zh-CN.md)：发现、启用、项目指令与 prompt 装配。

## 状态、前端与运维

- [会话与记忆](sessions-and-memory.zh-CN.md)：session JSONL、恢复、artifact、accounting、日志、长期记忆与合并。
- [TUI 交互](tui.zh-CN.md)：应用生命周期、命令、焦点、controller、输入与事件投影。
- [终端渲染](terminal-rendering.zh-CN.md)：终端生命周期、布局、重绘、cursor 与宽度、Markdown、图表和工具展示。
- [无头执行](headless.zh-CN.md)：`kana exec`、审批行为、输出、JSONL 协议、deadline、signal 与退出状态。
- [Kana Agent 可复用 workflow](kana-agent-workflow.zh-CN.md)：caller 配置、仓库本地模型配置、鉴权、发布与版本固定。
- [Terminal-Bench 本地评测](terminal-bench.zh-CN.md)：Harbor adapter、运行参数、代理和结果解释。
- [发版流程](releasing.zh-CN.md)：版本策略、release 准备、分发、自更新与自动化。

## 修改路由

使用包含变更契约的最窄 owner；跨边界行为可能需要更新多份文档。

| 代码或行为 | 主要文档 |
| --- | --- |
| `src/kana/conversation` | [对话运行时](conversation-runtime.zh-CN.md) |
| `src/core`、`src/agent` | 根据契约选择 [Agent 运行时](agent-runtime.zh-CN.md)、[工具与执行](tools.zh-CN.md)或[供应商](providers.zh-CN.md) |
| `src/tools`、`src/jobs`、`src/kana/tools`、`src/kana/artifacts` | [工具与执行](tools.zh-CN.md) |
| `src/providers` | [供应商](providers.zh-CN.md)，adapter 专用行为再更新对应 adapter 文档 |
| `src/oauth` | [OAuth](oauth.zh-CN.md) |
| `src/mcp`、`src/kana/mcp` | [MCP](mcp.zh-CN.md)；字段与默认值仍属于[配置](configuration.zh-CN.md) |
| `src/kana/session`、`src/kana/memory`、session-bound logging 与 accounting | [会话与记忆](sessions-and-memory.zh-CN.md) |
| `src/kana/config`、launch mode、审批配置 | [配置与安装](configuration.zh-CN.md) |
| `src/kana/skills`、prompt 装配 | [Skills 与系统提示词](skills-and-prompt.zh-CN.md) |
| `src/tui/app`、TUI 进程生命周期 | [TUI 交互](tui.zh-CN.md) |
| `src/tui/runtime`、`src/tui/render`、展示组件与工具 renderer | [终端渲染](terminal-rendering.zh-CN.md) |
| `src/headless` | [无头执行](headless.zh-CN.md) |
| `.github/workflows/kana-agent*`、`.github/kana` | [Kana Agent 可复用 workflow](kana-agent-workflow.zh-CN.md) |
| `src/kana/update`、release script 与 workflow | [发版流程](releasing.zh-CN.md) |
| `src/utils`、`src/logging` 等薄 helper | 拥有其外部可见行为的子系统文档 |

行为迁移时，要把说明合并进新 owner，并删除旧的重复版本。中英文文档应保持结构和语义一致；文档集合变化时同步更新两个索引。
