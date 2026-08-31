# TUI 交互

Kana 的 TUI 把共享对话行为映射为命令、焦点、controller、状态与 transcript event。Agent、session、wake、Goal 与输入投递属于[对话运行时](conversation-runtime.zh-CN.md)，终端布局和内容渲染属于[终端渲染](terminal-rendering.zh-CN.md)。

## 运行结构

`KanaTuiApp` 把 `ConversationRuntime` 与 Agent event 投影为 transcript 加一个获得焦点的 bottom component。只有 `BottomAreaController` 可以把 editor 替换为审批、picker、prompt、manager 或 content viewer；各 controller 保留自己的交互状态，并在 editor 之前优先恢复等待中的审批。

组件负责展示和本地键盘处理。终端 runtime 负责通用 `Component` 契约、高度分配、可见宽度规范化、cursor 放置和差量输出；这些机制见[终端渲染](terminal-rendering.zh-CN.md)。
## 应用生命周期

终端 runtime 先于 `KanaTuiApp` 启动；底层 raw mode、capability、repaint 和恢复行为属于[终端渲染](terminal-rendering.zh-CN.md)。随后 App 会先显示当前 session，再加载外部工具。MCP 启动期间会移除 editor 焦点，追加不可变的逐 server 结果与 warning，用发现的工具重建 Agent，最后恢复 editor。`Esc` 或键盘 `Ctrl+C` 会取消 startup 或 reload，在清理完成后追加弱化的取消结果并恢复普通交互，但不会关闭可 reload 的 MCP runtime；以这种方式跳过 startup 后，初始 prompt 仍会运行。浏览器授权使用临时 URL block，并在结束后替换为最终状态。必需 server 初次失败时输入保持禁用；显式 reload 失败则会移除过期工具并恢复输入，让用户可以重试。Manager 与协议语义见 [MCP](mcp.zh-CN.md)。

`KanaTuiApp.stop()` 是幂等边界。它追加关闭状态、移除 bottom 焦点、关闭并等待 `ConversationRuntime`，等待自动记忆合并等产品清理，再关闭 MCP manager；之后才恢复终端，并按需打印累计用量和恢复命令。空闲退出与进程 signal 共用这条路径；优雅关闭中的第二次中断会先恢复终端再强制退出。

使用 `kana --clean` 时，App 不安装外部工具加载器或 MCP controller。Transcript 与状态栏会显示临时模式，不持久化 session，退出时也不打印恢复命令。
## App 与 Agent 事件

`KanaTuiApp` 订阅 `ConversationRuntime`，持有累计模型用量和可见运行状态，并把 Agent 事件映射交给 `AgentEventRenderer`。输入排序与投递由[对话运行时](conversation-runtime.zh-CN.md)定义；本文只负责其可见投影。Transcript 会在任意两个输出块之间插入一行普通空行，每个 block 只管理内部间距；同一助手消息含多个有序可见部分时，`AssistantMessageBlock` 也使用相同间距。人工输入使用 ASCII 边框、浅灰正文和蓝色 `> ` 前缀，续行与正文对齐。到期 wake 显示为 `Scheduled wake: …` 而不是人工输入，成功结果则显示为把延迟和提醒压到一行 target 的紧凑工具块：

| Agent 事件 | TUI 行为 |
| --- | --- |
| `turn_start` | 立即创建一个临时的 `Working (Ns)` 块，并把状态阶段设为 `working`。这段与供应商无关的活动覆盖可见正文、工具或 hosted 动作开始前的时间。 |
| `message_start` / `message_update` / `message_end` | 创建、更新、完成有序助手内容块；Markdown 文本与 provider-hosted 动作保留供应商顺序。Core thinking 事件会让既有 `working` 活动继续计时；正文、工具或 hosted tool 开始时，transcript 活动和状态栏会一起切换到对应阶段。Provider 流式生成一个或多个本地工具调用及其参数时，TUI 只显示一个共享的 `Preparing tools` 计时，而不是为每个调用提前创建工具块；助手消息结束时冻结该计时。 |
| `tool_execution_start` | 移除共享的准备活动，创建对应的单工具块，并从零开始显示 running 耗时；并行调用仍按 `toolCallId` 独立维护，并随各自的 start 事件依次出现。 |
| `tool_execution_update` | 更新 bash 等工具的部分输出。 |
| `tool_execution_end` | 写入结构化结果并标记成功、失败或取消。用户中止的调用显示为已取消，而不是工具失败。 |
| `todo_state_changed` | 把完整接受快照关联到对应的实时 `todo_write` 工具块，并更新 `/todo` 使用的 session 状态。 |
| `turn_input` | 在当前 run 的回合边界提交并渲染 Enter 排队的用户消息。 |
| `agent_end` | 按终态更新状态阶段并清除活动工具；run 被中止时移除尚未解析为单工具块的聚合准备活动，`turn_limit` 显示为独立的 `Turn limit` 错误阶段。 |

内置工具使用语义化 renderer，而不是通用结构化 JSON。具体来说，`view_image` 会显示 `Viewing`/`Viewed`、解析后的路径，以及 `PNG · 1440×832 · 19 KB` 这类紧凑的格式、尺寸和编码后大小元数据；它不会打印持久化的 base64 图片，也不会回退到通用 renderer。`todo_write` 运行时显示 `Updating todos (Ns)`，完成后显示 `Updated todos` 与一行计数/active 项 target；空替换显示 `Cleared todos`，失败和取消使用不同标题。`Ctrl+O` 显示该次调用的完整接受快照，`/todo` 则显示 session 最新列表与状态计数；界面没有常驻 todo 面板。实时事件和恢复后的 session 历史都使用持久快照，不解析紧凑工具确认。当恢复历史只有 artifact 元数据而没有结构化结果时，transcript 只显示 `Output stored · <size>`；工具详情查看器会显示有界 locator 和取回提示，而不会重放模型可见预览。

Responses provider 的 `web_search_call`（当前来自 OpenAI Codex 与 DeepSeek V4 Flash）属于 provider-hosted 动作，不创建本地工具审批或 ToolRuntime 执行。TUI 为每个调用单独显示 `Searching the web`、`Searched the web`、`Opened a web page` 或 `Searched within a web page`；当前不聚合多个调用。搜索期间状态栏阶段为 `searching`。进行中的搜索显示耗时和 `Esc to abort`；中止时 Agent 会发布并持久化语义化的 canceled 状态，TUI 则冻结计时并显示 `Web search stopped`。最终回答中的供应商 Markdown 链接按正文原样渲染，TUI 不回插引用编号或追加 `Sources` 区块。

助手正文的协议状态与可视进度彼此分离：provider 和 Agent 仍会立即处理完整事件与消息，`StreamingTextPresenter` 只维护 Markdown 块当前可见的 `text` 前缀。稀疏文本 delta 会立即出现；当一次网络读取带来一批 SSE 事件时，积压内容约每 16ms 推进一次，并按 backlog 在每帧 1–12 个 grapheme 之间有界加速，消息完成后只额外提升一级用于收尾。工具调用开始、`toolUse` 消息完成、审批显示和实际执行前会先追平已经收到的正文，保证后续工具状态不会越过仍在展开的文本，同时不延迟 Agent 或 ToolRuntime。新消息或运行 reset 也会先 flush 剩余正文，因此持久化的 session 和 Agent 状态始终使用完整消息，而不是动画中的中间快照。配置 `tui.smooth_text_streaming = false` 会完全绕过该节奏控制，直接显示 provider 的最新流式快照；working 活动、Core thinking 事件、工具调用、工具结果、错误和状态阶段始终不参与文本节奏控制。

编辑器内部包含状态栏，它显示模型及可选推理强度（例如 `gpt-5.6-luna · max`；`none` 档位显示为 `off`）、Clean 模式标记、形如 `Context ~N% used` 的下一轮近似上下文、运行阶段、活动工具和 cwd。该百分比用可重放上下文除以 effective context limit，而不是直接展示上一轮 response 的原始 `input_tokens`；因此 system instructions 和工具 schema 会让新 session 带有非零基线。普通 provider usage 用于校准估算；包含托管搜索的响应则保留之前的干净锚点，只增加持久化输出与调用元数据，不计入临时搜索网页。恢复内容未变的会话时会从最新一条已持久化的 assistant 消息重建该干净锚点，因此百分比保持不变，而不是跳到全新的本地估算。数值在每个完整 model/tool `turn_end` 后、上下文压缩后以及 Agent run 结束时刷新。provider-hosted 网页搜索使用 `searching` 阶段，但不会出现在本地 `Tool …` 活动名称中。多个本地工具并行时，活动项压缩为第一个名称加剩余数量，例如 `Tool read +2`；任一调用失败后错误阶段会保留到该组全部结束，同时已完成的调用不会清除仍在运行的名称。上下文摘要生成期间阶段为 `compacting`，完成后立即用 checkpoint 估算更新百分比。运行中存在排队输入时，编辑器使用状态栏下方原本会被 Layout 补空的行显示 `Queued inputs`，并用 `next turn`、`next run` 或 `scheduled` 标出投递时机；`scheduled` 明细只表示已经到期并正在等待的新 run。尚未到期的 wake 不展开消息内容，只显示 `Scheduled · N · next HH:mm` 摘要。多行内容折叠为一行，空间不足时优先保留 pending 队列并截断明细。打开 slash 命令面板时会同时隐藏状态栏和两类队列预览；其他底部组件替换编辑器时，输入区、状态栏和预览一起隐藏。每条完成助手消息和摘要请求都会把 provider 原始 usage 原样累计到进程总用量。Kana 不估算金额，实际费用以 provider 账单为准；`/usage` 将回合上限终止与正常完成、输出截断、中止和失败分开统计。

恢复 session 时，TUI 只渲染已提交的 timeline；Agent 的重建契约见[会话与记忆](sessions-and-memory.zh-CN.md)。历史 `turn_start` 不显示，`todo_state` 只补充匹配工具块而不新增行；实时 `turn_start` 只产生临时工作状态。`turn_end` 不增加 block，只更新状态栏的 context 估算；recovery 输入显示为弱化的安全恢复标记。Timeline 中的 `context_compaction` 会在原位置显示为 `Context compacted · 812k → ~430k tokens`；实时事件追加同样标记。执行 `/compact` 时，临时 `Compacting context…` 会在成功后被替换，失败时先移除再显示错误。TUI 不保留从 messages 直接重建历史的兼容路径。

## 输入与快捷方式

全局控制输入先于焦点组件处理。`Esc` 通常沿正常焦点分发流程传递，外部工具加载期间除外：

| 输入 | 行为 |
| --- | --- |
| `Ctrl+C` | 外部工具加载期间取消 MCP startup 或 reload；其它情况下，正在运行时中止本地 Shell、记忆压缩或 Agent。空闲且编辑器聚焦时，有文字/图片草稿则先清空，草稿为空才开始优雅退出；关闭等待期间再次按下会强制退出。 |
| `Esc` | 外部工具加载期间取消 MCP startup 或 reload；其它情况下，先交给当前聚焦的 modal、view、picker 或嵌套 prompt 处理，工具审批提示会将它视为“拒绝”。焦点回到编辑器后，若 Agent 正在运行则中止本次 run；空闲时不产生作用。 |
| `Ctrl+O` | 打开/关闭最近一项工具调用的详情查看器；`/tools` 从当前会话全部工具调用的可浏览历史中打开同一个查看器。打开期间按 `[` / `]` 切换到上/下一个工具调用。 |
| `!<command>` | 不经过 Agent 或工具审批，直接运行本地 bash，并显示同样的工具块。 |

编辑器使用与用户消息块相同的 ASCII 边框、浅灰正文和蓝色 `> ` 前缀，不设置输入区域背景色；框体直接跟在 Layout 分隔线后。输入为空时，它会从 `/help` 的 slash 命令和已记录的输入快捷键中随机选择一项作为 placeholder；启动和每次按普通 `Enter` 后都会选择一个不同于当前条目的提示，其他重绘不会改变它。命令面板、placeholder、`/help` 和 usage 错误共同读取同一份命令语法与描述。`/help` 的快捷键区涵盖编辑器提交与排队、多行输入、Readline 风格编辑、图片粘贴、中止、工具输出切换和本地 Shell 输入。

编辑器的移动与编辑快捷键如下：

| 输入 | 行为 |
| --- | --- |
| `Left` / `Right`、`Ctrl+B` / `Ctrl+F` | 按一个 grapheme 左右移动。 |
| `Home` / `End`、`Ctrl+A` / `Ctrl+E` | 移动到当前显式逻辑行的行首/行尾。 |
| `Alt+B` / `Alt+F`、`Alt+Left` / `Alt+Right`、`Ctrl+Left` / `Ctrl+Right` | 按一个 Unicode 单词向前/向后移动。 |
| `Up` / `Down` | 先在软换行或显式换行之间移动，到输入边界后再进入历史记录。 |
| `Ctrl+P` / `Ctrl+N` | 选择上一/下一条 slash 建议，或直接浏览输入历史。 |
| `Backspace` / `Delete`、`Ctrl+H` / `Ctrl+D` | 删除前一个/后一个 grapheme。 |
| `Alt+Backspace`、`Ctrl+Backspace` | 删除前一个 Unicode 单词并保存到 kill buffer。 |
| `Ctrl+W` | 按空白分隔删除前一个词并保存到 kill buffer。 |
| `Alt+D`、`Alt+Delete`、`Ctrl+Delete` | 删除后一个 Unicode 单词并保存到 kill buffer。 |
| `Ctrl+U` / `Ctrl+K` | 删除光标到当前逻辑行行首/行尾的内容并保存到 kill buffer。 |
| `Ctrl+Y` | 粘回最近一次 kill 命令删除的内容。 |

在 macOS 上，`Option` 是物理上的 `Alt` 键。终端将 Option 作为 Alt/Meta 上报（传统 `Esc` 前缀或增强键盘协议）时这些快捷键可用；如果终端直接把 Option 组合转换成可打印 Unicode 字符，Kana 会继续把它当作普通文字输入。

编辑器支持多行输入、最多 5 个可见行、历史记录（最多 100 条）、bracketed paste 和 slash 补全。启用 `tui.collapse_long_pastes` 时，达到 1,000 个 grapheme 的 bracketed paste 会在主编辑器和 slash 命令文本提示中显示为弱化的 `[Pasted N chars]` 原子项，提交内容和历史记录仍保留完整原文。按字符、按词、逻辑行边界和 kill 操作都会保持折叠粘贴块的原子性；kill buffer 同时保留折叠元数据，因此 `Ctrl+Y` 会恢复折叠项，而不是展开它的原始文字。关闭配置后恢复完整显示和逐 grapheme 编辑。

空闲时 `Enter` 正常提交。Run 进行中时，`Enter` 尝试把输入交给当前 run，`Tab` 则排到后续 run；准确的 steering、defer 与 FIFO 规则见[对话运行时](conversation-runtime.zh-CN.md)和 [Agent 运行时](agent-runtime.zh-CN.md)。空闲时普通输入的 Tab 不提交，slash 面板中的 Tab 用于补全命令；支持的终端中，`Shift+Enter` 插入换行。以 `/` 开头会打开最多显示 10 项、随选择滚动的命令面板；未知 slash 输入和单独的 `!` 会作为普通模型消息发送。

Background Job completion 与其它 runtime 输入共用 queued-input 投影；投递、合并与确认语义见[对话运行时](conversation-runtime.zh-CN.md)。`/jobs` 展示不消费状态的输出尾部，并控制当前 session 的 Job。查看或停止 Job 都不会确认其终态 completion，因此 Agent 仍可能收到该通知。

`/goal <objective>` 启动进程内 Goal 的第一次 run。TUI 把后续 round 显示为弱化 continuation 标记，不显示逐轮完成通知，并允许用 `Esc` 或 `Ctrl+C` 取消。接纳顺序、终态更新、round 上限、session 切换行为和 runtime-context 投影由[对话运行时](conversation-runtime.zh-CN.md)定义。

一条输入最多可附加 10 张图片。编辑器只显示附件数量、尺寸和编码后大小，不显示图片字节；输入文本为空时，Backspace 会移除最后附加的图片。在 macOS 上，`Ctrl+V` 从系统剪贴板读取图片；剪贴板没有图片时直接报错，不会退回文本粘贴，因为普通终端文本仍使用 `Cmd+V`。`/image <path>` 是跨平台的路径方案，只附加图片而不立即提交。相对路径从 Kana 当前工作目录解析，也支持带引号路径、`~/…` 和 `file://` URL。路径属于 Kana 实际运行的主机，因此 SSH 场景应填写远端路径；WSL 即使不能读取图片剪贴板，也可以使用 `/mnt/c/Users/me/Pictures/image.png` 这类 Windows 挂载路径。图片会在附加前解码并规范化：最长边最多 2048 像素且不会放大，JPEG/PNG/WebP 保持为供应商可接受的对应格式，其他可解码格式转为 PNG，编码后的结果不能超过 10 MB。

| Slash 命令 | 行为 |
| --- | --- |
| `/help` | 在底部只读视图中打开命令和快捷方式。 |
| `/clear` | 清空 transcript 与编辑器，不删除会话。 |
| `/new` | 新建空会话并重建 Agent。 |
| `/fork <prompt>` | 从当前 Agent 历史创建分叉会话后发送 prompt。 |
| `/resume [id]` | 恢复指定会话或打开选择器。 |
| `/delete` | 选择并确认删除会话。 |
| `/skills` | 管理全局 Skills 开关，并重建 Agent 的系统提示词。 |
| `/mcp` | 管理 MCP server 开关，并在选择变化时 reload。 |
| `/schedule` | 查看、添加、刷新或删除当前 session 的进程内定时消息。 |
| `/jobs` | 管理当前 session 拥有的 Job：刷新、查看不消耗游标的输出尾部，以及停止活动 Job。Agent 运行期间同样可用；TUI 查看和停止不会确认终态完成。 |
| `/goal <目标>` | 在有界的连续 Agent run 中持续推进一个目标。 |
| `/todo` | 打开当前 session 的 todo 列表和状态计数。 |
| `/tools` | 浏览当前会话的全部工具调用，并可任意打开其中一个的详情查看器。 |
| `/image <path>` | 将本地图片路径附加到编辑器，但不立即提交。 |
| `/approval` | 临时更改当前 session 的工具审批模式；选择 `Never ask` 需要二次确认。 |
| `/model` | 依次选择供应商、模型以及模型支持时的推理强度，保存配置并热切换当前 Agent。 |
| `/memory` | 在底部选择操作和 scope；具体语义见[会话与记忆](sessions-and-memory.zh-CN.md)。 |
| `/compact` | 不发送用户消息，直接压缩当前对话上下文。 |
| `/usage` | 在底部选择统计范围，再打开对应的 API 用量。 |
| `/quit` | 无参数时退出；带参数时作为普通 prompt。 |

`/usage` 会让 token 标签、数值和比例条保持稳定列位。Runs 区域和按模型明细会显示 token 总数，并根据当前可见数据动态计算数字列宽，因此更大的次数、token 总数或更长的模型名不会推动相邻数值错位。各类 outcome 仍保持紧凑的单行摘要，底部视图较窄时可能被截断。

Clean 模式中 `/skills`、`/mcp`、`/memory`、`/fork`、`/resume` 和 `/delete` 保留为可发现命令，但执行时会显示明确的不可用错误。`/usage` 仍显示 Session、Project 和 Global 三个选项；选择 Session 会显示不可用错误，另外两个范围仍可读取历史汇总。`/new`、`/schedule`、`/jobs`、`/goal`、`/todo`、`/image`、`/approval`、`/compact`、`/model` 和本地 Shell 可在临时会话内使用，其中 `/schedule` 消息、Job 和 `/goal` 控制状态仍只存在于当前进程，`/todo` 读取进程内列表，`/model` 不写回配置文件。

## 控制器与焦点

`KanaTuiApp` 是装配和路由层。它的构造契约按启动、对话、Skill、审批、UI、记忆、用量、模型、外部工具、诊断和生命周期能力分组，因此控制器只接收自己使用的边界。独立 controller 持有各自的交互状态机：

- `BottomAreaController` 是改变底部组件与焦点的唯一边界。视图仅在自己仍持有可见底部时恢复动态 fallback，避免过期的关闭操作覆盖更新的视图。fallback 会优先解析为等待中的审批提示，否则才是编辑器。
- `StatusProjectionController` 持有活动 run 状态、进程用量总计、context 占用和 editor 状态更新。`InteractionErrorReporter` 按运行中或空闲状态投影对应错误，无需各流程重复这些规则。
- `ContextCompactController`、`ImageAttachmentController`、`McpOAuthStatusController`、`ModelSelectionController` 和 `InformationViewerController` 持有各自的异步或多步 UI 状态，App 只负责启动流程或路由事件。

- `ExternalToolsLifecycleController` 统一处理会话可见后的首次外部工具加载和后续 MCP reload，持有活动操作的取消 signal、追加式生命周期输出以及输入禁用与恢复状态；工具集合变化时只通过回调请求 App 重建 Agent。
- `QueuedInputController` 保存当前 run 输入的 optimistic preview，并用既有 `MessageId` 与权威 runtime snapshot 对齐。它只持有显示标签和 preview 状态；queue lane、投递顺序、scheduled metadata 与取消语义见[对话运行时](conversation-runtime.zh-CN.md)。
- `ScheduledMessageManagerController` 展示 `/schedule` 的当前 session 快照，以及多步添加、刷新与删除流程。它持有列表排序、标签、快捷键和焦点恢复；timer 身份、取消、到期投递与 queue gate 见[对话运行时](conversation-runtime.zh-CN.md)。
- `BackgroundJobManagerController` 用 `/jobs` 打开面板，并在 Job 状态变化或按 `R` 时刷新。它会保持选中项稳定、显示不消耗游标的输出尾部、用 `K` 停止活动 Job 但不确认终态，并在面板通过 `Esc` 关闭前阻止 pending run 启动。
- `SlashCommandController` 统一完成 slash command 路由和参数校验；需要多步输入的命令再交给 `SlashCommandOptionsController`，App 不维护命令分发表。
- `ToolApprovalController` 调用 Agent 的 `beforeToolExecution` 钩子，并在每次调用前读取当前有效审批模式。`/approval` 设置的临时覆盖只作用于当前选中的 session；new、fork、resume 或进程退出会恢复 `config.toml`，且不会写入 session journal 或审批文件。编辑器可见时，审批选择框会替换它；如果另一个底部视图正在显示，审批会保持等待并仍触发配置的审批通知，关闭该视图后再显示审批。审批提示复用全保真工具详情，因此 write 内容、edit 的替换前后文本、bash 命令和 MCP/自定义工具参数都会完整保留，并通过详情分页恢复，而不是在渲染前被摘要化。MCP 工具通过产品层别名解析器显示 server ID、远端工具原名和格式化完整参数，长参数沿用详情分页；它们不提供持久信任选项。选择“拒绝”或按 `Esc` 都会让该运行中止，选择 always 仅把 bash 命令加入精确白名单。
- `SessionLifecycleController` 统一协调 new、fork、resume 后的 transcript、焦点、context 状态和外部工具激活；其内部的 `SessionOverlayController` 用恢复列表或删除确认替换编辑器。
- `SkillManagerController` 用 global Skill 列表替换编辑器。`Enter` 只修改本地草稿，`Esc` 才应用；有变化的草稿只持久化一次，并用原消息历史重建一次 Agent，未变化则直接关闭。持久化失败时视图保持打开。
- `McpServerManagerController` 用已配置 MCP server 的 checkbox 替换 editor。`Enter` 只修改本地草稿；选中 OAuth HTTP server 时，`A` 打开认证子菜单，可授权、重新授权或退出登录，进行中的浏览器授权可用 `Esc` 中止。授权 URL、成功、失败或取消状态写入 transcript；退出登录会禁用该 server。返回列表后，主 `Esc` 才应用草稿；选择或已启用 server 的凭据发生变化时只触发一次完整 runtime reload。持久化失败时视图保持打开。组件显示 server ID、transport、OAuth 状态，以及 stdio 的完整命令行（`command` 加 `args`）或 HTTP URL，但不会接收环境变量、HTTP headers 或 token。
- `SlashCommandOptionsController` 用可取消的多步提示收集 slash command 选项。`/usage` 可选择 session、project 或 global；`/memory` 依次选择操作和 scope，Compact 再使用独立 `TextPrompt` 接收可选 request；`/approval` 可选择 Always ask、Ask unless trusted 或 Never ask，最后一项使用与删除会话相同的默认否定二次确认；`/model` 先选择 provider 与 model，再显示该模型 metadata 声明的 reasoning efforts。没有 reasoning metadata 的模型会跳过最后一步，`none` 显示为 `Off`。选项不通过 editor 参数传入，嵌套步骤中的 `Esc` 返回上一步。
- `/model` 只在空闲时完成切换。Kana 保留当前消息和 context checkpoint，先根据新的 `[agent.model]` 选择构造候选对话 Agent；普通模式再只原子保存有变化的 provider、name 和可选推理强度，已有 `max_output_tokens` 与 `context_limit` 保持不变。Clean 模式只更新当前 Host 的已校验进程内配置。全部成功后才替换当前 Agent，并同步状态栏中的模型和推理强度。构造或持久化失败会保留旧 Agent 和旧配置并在 transcript 显示错误。`/model` 永远不会修改独立的 `[memory.agent]` 配置或其 scheduler。普通模式的选择会成为后续新建、分叉和恢复对话会话的配置；Clean 模式只覆盖当前进程中的后续对话 Agent，且不产生逐次 accounting 记录。
- `/compact` 不接受参数；它只在空闲时强制压缩当前对话上下文，不发送用户消息。
- `ContentViewerController` 用可滚动的只读内容替换底部组件，包括帮助、用量、记忆和工具详情；transcript 仍保持渲染。工具查看器打开最近一次工具调用，且任意 ToolCallBlock 都可以打开——输出很短、没有 result、正在运行/已取消、read，以及 custom/unknown 工具一律可查看，不依赖 expandability 或宽度。`[` 和 `]` 在上一个/下一个工具调用之间切换；导航直接在底部原位替换查看器，保持焦点、不触碰编辑器，每个工具都获得一个从顶部开始的新视口。关闭时优先恢复正在等待的审批，否则恢复编辑器。
- `ToolHistoryController` 支撑 `/tools`：把当前 transcript 中的每个 ToolCallBlock 快照成一个小型选择器，最新在前（每个工具一行：标题加 schema 已知的摘要）。成员资格不依赖 expandability、终端宽度、紧凑渲染状态或 resize——列表在打开时固定，选择始终落在同一个稳定 `toolCall.id` 上。`Enter` 直接把底部交给 `Ctrl+O` 快路径使用的同一个工具详情查看器，中间不恢复编辑器；`[` / `]` 导航保持 transcript 时间线顺序，从选中哪个工具开始都成立。`Esc` 关闭选择器回到编辑器。只浏览当前会话，不存在跨会话历史。
- `LocalShellController` 复用 bash Tool 显示逻辑，但不会触发审批。
- `MemoryCompactController` 运行可中止的全量记忆合并并在 transcript 中写摘要。

运行期间，`/quit`、`/help`、`/todo`、`/tools`、`/usage`、`/image`、`/schedule` 和 `/jobs` 仍可使用。`/help`、`/usage` 及只读查看器会保留当前 Agent run phase；`/image` 只把图片附加到编辑器草稿，供后续排队输入使用；`/schedule` 管理 pending 与 scheduled input，不会中断当前 turn；`/tools` 打开时会固定当前工具历史快照；`/jobs` 可在 Agent 运行时查看并停止当前 session 的 Job，但不会确认其完成。`/clear`、`/new`、`/fork`、`/resume`、`/delete`、`/skills`、`/mcp`、`/goal`、`/approval`、`/model`、`/memory` 和 `/compact` 会显示不可用错误，而不是静默忽略。打开底部视图时会切换焦点；关闭后优先恢复正在等待的审批，否则回到编辑器。审批到达时不会抢占当前底部视图。

## 通知

配置的 notification backend 决定输出方式。`auto` 依次探测 Kitty、iTerm、Ghostty 和 VTE，最后回退 bell；显式 `off` 不发送通知。通知文本会移除控制字符并折叠空白，OSC 777 还会替换分号。普通 Agent 完成与需要审批可以分别配置。

Markdown、hyperlink、LaTeX、Mermaid、工具 block、详情渲染、可见宽度规则与重绘约束见[终端渲染](terminal-rendering.zh-CN.md)。
