# Kana 架构总览

Kana 是一个以 Bun 运行的终端编程 Agent。它将模型调用、工具执行和本地状态持久化放在同一进程中，并用自研 TUI 显示流式过程。本文描述当前实现的运行边界和模块关系，帮助新贡献者从入口一路定位到具体职责。

## 分层与依赖方向

```text
src/main.ts
  └─ cli                 命令解析；启动、恢复会话和安装本地文件
      └─ tui             终端交互、渲染和用户审批
          └─ kana        产品装配：配置、提示词、会话、记忆、Skills
              ├─ agent   模型—工具循环和事件协议转换
              ├─ tools   文件、Shell 与 remember 工具
              ├─ core    消息、模型、流和用量的共享协议
              └─ providers
                  └─ deepseek  DeepSeek 请求、SSE 解析和流式适配
```

`core` 是最内层的协议包：不依赖产品配置或 TUI。`agent` 仅依赖 `core` 和 `tools`，因此可在没有终端界面的情况下运行。`kana` 是将这些通用部件变成 Kana 产品的装配层；它从当前工作目录和 `~/.kana`（或 `KANA_HOME`）读取状态。`tui` 依赖这些上层能力，但不直接实现模型协议或持久化格式。

这种分层也说明了新增代码应放在哪里：新增供应商放 `providers`，可复用的执行能力放 `tools`，循环控制放 `agent`，Kana 的默认策略和本地状态放 `kana`，交互呈现放 `tui`。

## 启动路径

`src/main.ts` 调用 `runCli`。CLI 支持三类路径：

- `kana [prompt...]`：启动 TUI；有参数时启动后立即发送该提示词。
- `kana resume [sessionId]`：按 ID 恢复会话，或打开会话选择器。
- `kana install [--force] [--skills]`：创建默认配置、审批文件和 Skills 配置；`--skills` 额外克隆或更新默认 Skills 仓库。

启动 TUI 时，`startTui` 会加载配置和审批白名单，创建当前会话，并构造 `KanaTuiApp`。它把会话读写、Skills 开关、记忆压缩和 Agent 工厂以回调方式注入 App；因此 App 协调用户流程，但不知道 JSONL、TOML 等存储细节。

## 一次对话如何执行

```text
用户输入
  → KanaTuiApp.submitPrompt
  → Agent.stream
  → runAgentLoop
  → Model.stream (DeepSeek SSE)
  → AssistantMessageEvent
  → AgentEvent
  ├─ AgentEventRenderer 更新 transcript、工具块和状态栏
  └─ Agent 将已完成消息提交给会话存储

若模型请求工具：
  Agent 验证参数 → beforeToolExecution（TUI 审批）
  → Tool.execute → ToolResultMessage → 下一轮模型调用
```

`core/messages.ts` 中的 `Message` 是历史记录的唯一格式：用户消息、含有有序内容块的助手消息，以及工具结果消息。助手内容块可以是 `text`、`thinking` 或 `tool_call`；顺序被保留，以便既能正确回传给供应商，也能在 TUI 中按模型输出顺序展示。

供应商首先产生 `AssistantMessageEvent`。事件包含增量 `delta` 和完整 `snapshot`：前者适合增量呈现，后者让消费者不必重复实现消息拼接。`agent` 将其转换为更高一层的 `AgentEvent`，并额外发出回合、工具开始/更新/结束和整个运行结束事件。`AgentEventStream` 与模型流都同时支持 `for await` 消费事件和 `result()` 获取最终值。

`Agent` 是有状态的单次运行控制器。它拒绝并发运行；`stream()` 会先把用户输入加入内部历史，再创建 `AbortController`，并在 `agent_end` 时才把本次生成的助手消息和工具结果提交到状态。`state` 的返回值会深拷贝可变数据，调用方不能修改运行中的内部历史。

`runAgentLoop` 默认最多执行 8 回合，Kana 的默认配置将其设为 `-1`，表示不设上限。每一回合先流式取得助手消息；只有停止原因为 `toolUse` 时才顺序执行工具调用。每个调用都经过 TypeBox 校验和可选的 `beforeToolExecution` 钩子。拒绝、取消、未知工具、校验失败和工具异常都会转换成工具结果并回传模型；拒绝或中止会终止本次运行。

## 模型与供应商适配

`core/model.ts` 定义 `Model`：供应商实现只需提供元数据和 `stream(context)`，`generate()` 由基类通过收集流实现。`providers/index.ts` 是集中式工厂；当前产品配置只允许 DeepSeek，`MockModel` 用于测试。

`DeepSeekModel` 将通用消息、系统提示词和 TypeBox 工具 schema 转换为 DeepSeek 的 OpenAI 兼容请求格式，向 `/chat/completions` 发送 SSE 请求。流解析器会：

1. 缓冲被网络分片切开的 SSE 帧；
2. 将 reasoning、可见文本和工具参数增量写入同一有序助手消息；
3. 在工具调用完成时解析 JSON 参数，同时保留原始参数字符串；
4. 映射结束原因和 token 用量。

请求可由 Agent 中止，也受 `timeoutMs` 限制。HTTP 408、429 和 5xx 会按指数退避重试，最多重试 `maxRetries` 次。模型元数据还提供上下文窗口、最大输出和 CNY 计价；TUI 用它计算上下文占用和本次进程累计成本。

## Kana 产品装配

`createKanaAgent` 是运行时组合点。它以当前目录为工作区，加载可见 Skills，构建系统提示词，并注册 `read`、`write`、`edit`、`bash` 与（启用记忆时）`remember` 工具。

系统提示词由以下部分组成，后面的项目级指令优先级更高：

1. 长期记忆的 global/project 引用，以及 `remember` 使用规则；
2. `~/.kana/AGENTS.md` 的全局指令（若存在）；
3. `<cwd>/AGENTS.md` 的项目指令（若存在且不是同一文件）；
4. 当前目录、平台、日期和时区；
5. 已启用 Skills 的名称、描述和 `SKILL.md` 路径。

`loadKanaConfig` 从 `config.toml` 读取配置，并按字段与默认值合并；类型或枚举不合法会直接报错，而不是静默忽略。默认配置、审批数据和 Skills 开关均以仅用户可读写的文件创建。

## 本地状态

所有 Kana 状态都位于 `KANA_HOME`，未设置时为 `~/.kana`：

| 数据 | 位置与格式 | 写入时机 |
| --- | --- | --- |
| 配置 | `config.toml` | `kana install` 或用户编辑 |
| 审批白名单 | `approvals.json` | 用户选择某条 bash 命令“始终允许” |
| 会话 | `sessions/<workspace>/*.jsonl` | 每个 Agent 运行成功提交后追加 |
| 长期记忆 | `memory/global|projects/<workspace>/memory.md` | 记忆压缩成功后原子替换 |
| 每日记忆 | 对应目录的 `daily/YYYY-MM-DD.md` | `remember` 成功时追加 |
| 全局 Skills 配置 | `skills/skills.toml` | TUI 修改全局 Skill 开关时 |

工作区目录名由解析后的绝对路径稳定编码，供会话和项目记忆共同使用。会话文件是 JSONL：首行是版本化的 session header，之后每行是带父 ID 的消息条目。创建会话本身不落盘；第一批消息追加时才写 header，并用首条用户消息生成标题。

记忆分 global 和 project 两个 scope。`remember` 先向当天的暂存文件追加结构化条目；对话提交后，调度器按 scope 串行启动一次增量压缩 Agent。压缩 Agent 使用相同的模型，但只有记忆读写工具；它在助手以正常 `stop` 结束时才提交内存中的修改。`/memory compact` 发起全量压缩，可在成功后按 `daily_retention_days` 清理过期每日记忆。

Skills 从项目 `.kana/skills`、项目 `.agents/skills` 和全局 `~/.kana/skills` 递归发现。每项以 `SKILL.md` 的 `name`/`description` frontmatter 注册；同名时先发现的项保留并产生诊断。项目 Skills 始终启用，全局 Skills 由 `skills.toml` 的列表控制。

## 工具、审批与安全边界

工具使用 TypeBox schema；调用前先执行 `Value.Convert` 再校验，校验后的参数才交给工具。工具结果分为给模型的文本 `content` 和给 Agent/TUI 的结构化 `result`，避免展示层解析供应商文本。

- `read` 读取文本文件，支持按行分页。
- `write` 仅创建不存在的新文件。
- `edit` 对既有文件做精确字符串替换；多次匹配必须显式 `replaceAll`。
- `bash` 使用用户 shell 运行，默认超时 30 秒、最大 120 秒，输出每个流最多保留 20,000 字符，并以节流更新事件显示实时输出。它将 `sudo` 改写为非交互模式，避免抢占 TUI 输入。
- `remember` 将非敏感的长期信息追加到每日记忆；它不会请求审批。

审批模式为 `always`、`unless_trusted`、`never`。在默认模式下，`read` 自动通过；白名单中的单个只读 bash 可执行名和精确 bash 命令自动通过；其他工具会显示 TUI 选择框。用户可只把某一条 bash 命令加入精确白名单。只读命令判断刻意拒绝 shell 组合符、路径形式的可执行文件和换行，以免把看似只读的组合命令误判为安全。

这里的“工作区工具”不是沙箱：文件路径和 bash `cwd` 可以是绝对路径，或通过相对路径离开工作区。文件读取会解析符号链接，写入会检查已有父目录的真实路径；这些机制用于获得规范化显示路径和处理链接，而非限制访问范围。审批是用户可见的授权层，不是操作系统级隔离。

## TUI 架构

`KanaTuiApp` 持有交互级状态：当前 Agent、会话 ID、运行标志、累计用量/成本，以及各个控制器。它不直接把模型事件渲染成 ANSI；`AgentEventRenderer` 负责把 `AgentEvent` 映射为助手消息块、工具块和状态栏阶段。

```text
ProcessTerminal（raw mode、输入、resize、通知）
  → Tui（焦点、16ms 合帧、差量重绘、硬件光标）
    → AppLayout
      ├─ Transcript / ContentViewer
      ├─ ToolApproval 内联提示
      ├─ Editor
      ├─ Session / Skills 覆盖层
      └─ StatusLine
```

`Tui` 以组件的 `render(width): string[]` 作为最小渲染协议。它缓存上次输出，尺寸不变时只重绘变化的行；改变已滚出视口的内容、缩小内容或终端尺寸改变时改用全量重绘。编辑器在逻辑行中插入内部光标标记，`Tui` 在写入终端前取走该标记并将硬件光标移动到对应的可见宽度位置。渲染层以 grapheme 和 `string-width` 处理 CJK、emoji、ANSI 颜色和换行。

TUI 的主要控制器分别处理工具审批、会话选择/删除、全局 Skills 开关、`!` 本地 Shell、记忆压缩和长工具输出查看。`Ctrl+C`/`Esc` 优先中止当前 Agent、本地 Shell 或记忆任务；空闲时 `Ctrl+C` 退出。`Ctrl+O` 打开最近一项可展开的工具输出。

## 扩展时的检查点

- 新供应商应先实现 `Model` 的流协议，保证事件快照不与内部可变消息共享，并在 `providers` 工厂注册。
- 新工具应定义 TypeBox 参数、结构化结果和清晰的错误语义；若有流式进度，调用 `context.update`。
- 新增可改变工作区的工具时，应同时审视审批策略、TUI 的工具展示和会话持久化结果。
- 新增用户可见命令或面板时，应由 App 或独立 controller 协调状态，组件本身保持渲染/输入职责。
- 改动消息、事件或 session JSONL 格式前，必须同时检查 DeepSeek 请求转换、历史渲染、持久化解析和相关测试；这些格式是跨层契约。

后续文档可在此基础上分别展开配置与安装、Agent/工具协议、会话与记忆格式、Skills，以及 TUI 渲染实现。
