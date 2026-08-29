# Kana 架构总览

Kana 是基于 Bun 的终端 Agent。模型调用、工具执行、产品装配和本地持久化运行在同一个进程中，通过交互式 TUI 或无头执行暴露。本文只映射稳定的模块边界与数据流；详细契约位于对应的子系统文档。

## 系统分层

```text
src/main.ts → cli
                ├→ tui ───────┐
                └→ headless ──┴→ kana（产品装配）
                                  ├→ agent → core
                                  │    └→ tools → core, jobs, utils
                                  ├→ providers → core
                                  ├→ mcp → oauth, tools
                                  ├→ session / memory / skills / config
                                  └→ logging

core、logging、oauth、jobs、utils
  依赖范围较窄的可复用契约或基础设施
```

`core` 包含与供应商无关的消息、模型 metadata、stream、用量和工具 specification。`agent` 负责对话 loop 与上下文投影；可执行工具在 Core specification 之外增加校验和执行。`providers` 把 Core 模型请求转换为外部 wire protocol。`oauth` 保持通用，`mcp` 则在其上增加远端工具协议行为。

`kana` 是产品层，负责解析配置和本地路径、装配 Agent、管理 session 与 memory、启用 Skills 与 MCP，并向前端提供中立的对话操作。`tui` 和 `headless` 消费这一层，都不持有模型协议或持久化格式。

## 强制依赖方向

顶层源码模块允许的直接依赖如下：

| 来源 | 可导入 |
| --- | --- |
| `main.ts` | `cli`、`headless`、`kana`、`tui` |
| `cli` | `headless`、`kana`、`oauth`、`tui`、`version.ts` |
| `tui` | `agent`、`core`、`jobs`、`kana`、`logging`、`mcp`、`tools`、`utils`、`version.ts` |
| `headless` | `agent`、`core`、`kana`、`logging`、`mcp` |
| `kana` | `agent`、`core`、`jobs`、`logging`、`mcp`、`oauth`、`providers`、`tools`、`version.ts` |
| `agent` | `core`、`logging`、`tools` |
| `providers` | `core`、`logging` |
| `mcp` | `oauth`、`tools` |
| `tools` | `core`、`jobs`、`utils` |
| `utils` | `core` |
| `jobs` | `logging` |
| `oauth`、`logging`、`core`、`version.ts` | 不导入其它顶层源码模块 |

`bun run check:architecture` 会强制执行这张依赖图，并检查 runtime 与 type-only cycle。同一个顶层 `src` 目录内使用相对导入；跨目录导入使用目标 barrel（如 `@/core`），不使用深层 alias。

`src/kana` 内部继续按 `config`、`conversation`、`session`、`memory`、`skills`、`mcp`、`tools`、`auth` 和 `update` 划分 domain。共享 `KANA_HOME` 路径构造保留在产品层，因为多个 domain 都会消费它。

## 装配入口

`src/main.ts` 把控制权交给 `runCli`。命令要么执行安装、reset、认证、Skills 管理、update 等有界操作，要么启动两个对话前端之一。配置与命令语义见[配置与安装](configuration.zh-CN.md)、[无头执行](headless.zh-CN.md)和[发版流程](releasing.zh-CN.md)。

`KanaConversationHost` 是前端共享的产品边界。它创建或恢复 hosted session、装配模型与工具能力、绑定持久化与日志，并暴露 `ConversationRuntime` 使用的切换操作。`createKanaAgent` 为一个 Agent 装配所选模型、稳定 prompt 来源、实际 runtime 策略、内置工具和当前可替换的外部工具快照。

TUI 在 `ConversationRuntime` 上装配 controller；headless 则把同一个 runtime 投影为文本或版本化 JSONL。前端行为可以不同，但 Agent 执行、输入顺序、Goal、session 切换与清理保持共享。详见[对话运行时](conversation-runtime.zh-CN.md)、[TUI 交互](tui.zh-CN.md)、[终端渲染](terminal-rendering.zh-CN.md)与[无头执行](headless.zh-CN.md)。

## 启动与关闭

Normal 和 clean 启动都会把显式模式传过前端、host 和每个重建的 Agent。Normal 模式可以加载项目指令、memory、Skills、持久化、accounting 与 MCP；clean 模式保留 runtime 配置、环境、认证、审批和核心工具，但移除持久 session 资源及可选项目能力。完整用户契约属于[配置与安装](configuration.zh-CN.md)。

交互式启动先显示选中的 session，再连接已启用 MCP server，并用发现的工具重建 Agent。无头启动执行对应的 host 初始化，但不产生 TUI 投影。两者都会拒绝 clean-mode resume，并共享同一组 host invariant。

关闭从前端依次流向共享 runtime、hosted session 资源、后台产品任务和外部工具 manager，最后才完成终端或进程退出。每个 owner 都让 close 幂等，并防止排队工作重新激活已关闭资源。具体顺序属于[对话运行时](conversation-runtime.zh-CN.md)、[MCP](mcp.zh-CN.md)和对应前端文档。

## 对话数据流

```text
用户或 scheduled input
  → ConversationRuntime
  → Agent
  → prompt 与 context 投影
  → 所选 Model adapter
  → 有序 assistant event
  → 可选 ToolRuntime 调用
  → 已提交消息与 runtime event
     ├→ normal 模式的 session 持久化
     ├→ TUI transcript 与状态
     └→ headless 文本或 JSONL
```

Core 消息与模型 event 与前端、供应商无关。Agent 提交完整消息、协调 steering 与排队输入，并在不了解前端的情况下委托工具执行。Provider 把 wire-specific replay 状态封装在 Core content 后方。工具结果重新进入同一段历史，再开始下一次模型步骤。

详细 owner 是 [Agent 运行时](agent-runtime.zh-CN.md)、[供应商](providers.zh-CN.md)和[工具与执行](tools.zh-CN.md)；checkpoint 持久化与恢复属于[会话与记忆](sessions-and-memory.zh-CN.md)。

## 状态与信任边界

Normal 本地状态以 `KANA_HOME` 为根，未设置时默认为 `~/.kana`。配置文档拥有文件名、字段、默认值与校验；session 与 memory 文档拥有持久化格式和恢复；OAuth 拥有通用 token-session invariant，Kana 则提供本地凭据 store。MCP 配置可以启动本地进程或连接远端 server，因此 server 定义同时是代码、数据与凭据的信任边界。

工具审批是可见授权，不是操作系统 sandbox。文件与 Shell 工具在收到能解析到工作区外的路径时可以作用于工作区外。供应商 endpoint、MCP endpoint、OAuth server、环境变量与本地明文凭据文件都必须遵守各 owner 的安全说明。

详见[配置与安装](configuration.zh-CN.md)、[会话与记忆](sessions-and-memory.zh-CN.md)、[OAuth](oauth.zh-CN.md)、[MCP](mcp.zh-CN.md)和[工具与执行](tools.zh-CN.md)。

## 文档路由

| 修改区域 | 详细 owner |
| --- | --- |
| 对话装配、输入投递、Goal、session 切换 | [对话运行时](conversation-runtime.zh-CN.md) |
| 消息、prompt context、Agent loop、压缩 | [Agent 运行时](agent-runtime.zh-CN.md) |
| 工具执行、审批 hook、Job、artifact | [工具与执行](tools.zh-CN.md) |
| 供应商生命周期与共享协议 codec | [供应商](providers.zh-CN.md) |
| Adapter 专用请求与 replay | [DeepSeek](deepseek-provider.zh-CN.md)、[OpenAI Codex](openai-codex-provider.zh-CN.md)或 [Custom](custom-provider.zh-CN.md) |
| 通用 token discovery、PKCE、callback、refresh | [OAuth](oauth.zh-CN.md) |
| MCP transport、client、manager 与 reload | [MCP](mcp.zh-CN.md) |
| Session JSONL、恢复、accounting、memory | [会话与记忆](sessions-and-memory.zh-CN.md) |
| 配置 schema、默认值、本地文件、clean mode | [配置与安装](configuration.zh-CN.md) |
| Skills 与系统 prompt 装配 | [Skills 与系统提示词](skills-and-prompt.zh-CN.md) |
| TUI 命令、焦点、controller、事件投影 | [TUI 交互](tui.zh-CN.md) |
| 布局、重绘、宽度、Markdown、工具展示 | [终端渲染](terminal-rendering.zh-CN.md) |
| Release 自动化、分发与自更新 | [发版流程](releasing.zh-CN.md) |

跨边界修改应更新每个受影响 owner，但只重复连接这些边界所需的摘要。文档索引包含完整的代码到文档查找表。
