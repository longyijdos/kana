# TUI 交互与渲染

Kana 使用自研主屏 TUI，而非 alternate screen。`ProcessTerminal` 负责原始终端 I/O，`Tui` 负责组件、焦点和 ANSI 重绘，`KanaConversationHost` 提供共享的 Kana 产品装配，`ConversationRuntime` 负责 Agent、会话和 wake 生命周期，`KanaTuiApp` 则把其事件与产品控制器连接到界面。

## 运行结构

```text
ProcessTerminal
  raw stdin、resize、终端通知、stdout
    → Tui
      输入监听器 → 当前焦点组件
      render(width, availableHeight?) → 差量 ANSI 重绘
        → AppLayout
          main（当前为 transcript）
          严格一个底部组件（高度档位）
            包含状态栏的 editor
            或 tool approval
            或 session / skills / MCP / schedule / slash command 提示
            或 content viewer
```

`Component` 的最小接口是 `render(width, availableHeight?): string[]`，可选 `handleInput` 和 `invalidate`。该协议不会裁剪输出，但组件可根据高度选择渲染策略。`AppLayout` 为唯一底部组件保留分档区域：终端高度不小于 30 行时使用 15 行，24–29 行使用 12 行，18–23 行使用 9 行，7–17 行使用 7 行；终端不足 7 行时将全部可用高度分给 bottom。剩余高度传给 main。底部区域首行由 layout 统一绘制 main/bottom 分隔线，其余高度传给底部组件；所有底部组件的内容都直接跟在分隔线后。组件输出不足时由 layout 补空行，因此切换底部组件不会带动 main 内容。列表视图会缩小项目窗口并保持选中项可见，编辑器会缩小输入和命令窗口；选择提示用上/下键切换选项，较长的详情可用左/右键或 `PageUp`/`PageDown` 翻页。普通 bottom 标题统一使用 `bottomTitle`，当前选项使用 `user`；工具审批和危险确认分别用 `toolActive` 与 `error` 覆盖标题颜色。`KanaTuiApp` 目前将 transcript 作为 main 传入；Transcript 仍刻意渲染完整历史，交由终端 scrollback 保留。组件本身主要处理呈现和局部键盘输入。

## 终端生命周期与渲染

`ProcessTerminal.start()` 要求 stdin/stdout 是 TTY，开启 raw mode、bracketed paste、增强键盘上报和隐藏光标，注册输入与 resize。增强键盘上报用于让支持的终端区分 `Shift+Enter` 与 `Enter`。当前会话显示后，外部工具加载器取消 editor 焦点，并在 transcript 末尾追加 `Starting MCP servers...`。随后每个选中的服务器完成时都会追加一条不可变的 `[已完成/总数]` 结果行，其中包含结果和过滤后的工具数；可选服务器的错误色 warning 位于最终启动摘要之前。未选择服务器时也走同一路径，只是不产生中间结果行，并以 `0/0` 摘要结束。之后 `ConversationRuntime` 才用发现的工具重建 Agent 并恢复 editor。OAuth server 需要浏览器授权时，会另外追加临时授权 URL 块，成功或失败后在原位置替换为最终状态，避免凭据 URL 永久保留。初次加载时必需服务器失败会显示错误而不是完成摘要，并保持禁用输入。`kana resume` 的会话选择器位于加载边界之前，因此仅浏览或退出列表不会启动 MCP。应用有变化的 `/mcp` 草稿沿用相同的追加式 transcript 结构，但使用 reload 开始行和摘要；内部 close 阶段不会写入，reload 失败时则用无过期 MCP 工具的状态重建 Agent 并恢复 editor，用户可以继续重试。`KanaTuiApp.stop()` 是幂等异步边界：在 transcript 末尾追加关闭状态并取消底部组件焦点，关闭并等待 `ConversationRuntime`，再由产品层取消并等待自动记忆合并，然后关闭 MCP manager；manager 的中立进度事件更新同一个关闭 transcript 块，bottom 不会被替换。完成清理后才停止终端、恢复先前 raw 状态、暂停 stdin、显示光标、弹出增强键盘上报、关闭 bracketed paste、清屏和 scrollback，并打印累计 token 和可恢复会话命令（若有）。空闲退出和 `SIGHUP`、`SIGINT`、`SIGTERM` 都走这条路径；优雅关闭期间的第二次 raw-mode `Ctrl+C` 会先恢复终端再向当前进程发送默认 `SIGINT`。首个进程信号同样会移除 Kana 的监听器，使第二个信号按系统默认行为强制终止。

使用 `kana --clean` 时，App 不安装外部工具加载器，也不创建 MCP 管理 controller，因此首次显示、new、模型切换和后续 Agent 重建都不会读取或连接 MCP。欢迎面板说明当前会话不会保存，transcript 会显示一次 Clean 模式说明，状态栏持续显示 `Clean`；退出时不会打印恢复命令。

App 和 controller 代码只调用声明式的 `Tui.requestRender()`，终端更新策略完全由 runtime 决定。普通请求会合并到约 16ms 的定时器。每次渲染都会：

1. 调用根组件的 `render(width, height)`；
2. 取出编辑器插入的内部光标标记；
3. 根据 ANSI 以及 Unicode 可见宽度规范化行；
4. 逻辑内容未变化时只更新硬件光标；
5. 其余情况只重绘可见的最小首尾变化范围，追加内容时使用终端自然滚屏，内容收缩时用 `CSI 2K` 清除可见的尾部残留行；
6. 首帧、宽高变化、改动位于终端 scrollback、删除后新尾部高于可寻址视口，或无法安全推断光标/视口状态时，回退到全量清屏重绘；
7. 在同步输出模式下，仅为当前焦点组件移动并显示硬件光标；没有焦点时将光标留在布局末尾并保持隐藏。

它维护已渲染行和可视 viewport 的缓存，避免反复计算未变 transcript 的 CJK 宽度。TUI 使用主屏，不进入 `?1049` alternate screen；这让 transcript 留在用户的终端 scrollback 中。

`/clear` 仍只是清空 transcript/editor 状态后调用 `requestRender()`。如果被移除的内容仍全部可见，renderer 会局部更新保留的布局并清除残留行，不发送 `3J`；如果 transcript 行已经进入 scrollback，受影响的逻辑范围无法寻址，常规全量重绘 fallback 会清除并重新播放剩余 frame。

渲染辅助会去除 ANSI/控制序列计算宽度，使用 `string-width` 和 `Intl.Segmenter` 按 grapheme 换行和截断。因而 CJK、emoji、组合字符和颜色不会错误占用列数。工具输出在显示前会移除不安全的终端控制序列。

## App 与 Agent 事件

`ConversationRuntime` 维护当前 Agent、session ID、提交互斥，以及 Agent 自有 inbox 的编排；它把该 inbox 与当前 session 尚未到期的 wake 一并发布为新 run 排序和展示的唯一事实来源，不再维护第二条 pending queue。`KanaTuiApp` 维护累计模型用量和界面运行状态。提交 prompt 时，App 把输入交给 runtime，并订阅它发布的 run 与 Agent 事件；用户消息、到期 wake 和流式 Agent 输出因此走同一个前端事件入口，再由 `AgentEventRenderer` 完成可视映射。Transcript 在每两个有输出的 Block 之间统一插入一个普通空行，Block 只管理自身内部留白；一条助手消息内部有多个有序可见内容块时，`AssistantMessageBlock` 也在相邻块之间使用同样的一行空白。用户键入的消息使用 ASCII 边框、浅灰正文和蓝色 `> ` 前缀；显式换行和软换行的后续行与正文对齐。`schedule_wake` 到期事件显示为 `Scheduled wake: …`，而不是用户键入的 prompt；任何运行中的 Agent、本地 Shell、记忆压缩、已打开的 MCP 管理界面或 MCP reload 都会让它留在 `next-turn`，状态结束后 runtime 再按 FIFO 顺序启动 pending run。该工具的成功结果是紧凑工具块，显示等待时长和提醒文本：

| Agent 事件 | TUI 行为 |
| --- | --- |
| `turn_start` | 立即创建一个临时的 `Working (Ns)` 块，并把状态阶段设为 `working`。这段与供应商无关的活动覆盖可见正文、工具或 hosted 动作开始前的时间。 |
| `message_start` / `message_update` / `message_end` | 创建、更新、完成有序助手内容块；Markdown 文本与 provider-hosted 动作保留供应商顺序。Core thinking 事件会让既有 `working` 活动继续计时；正文、工具或 hosted tool 开始时，transcript 活动和状态栏会一起切换到对应阶段。Provider 流式生成一个或多个本地工具调用及其参数时，TUI 只显示一个共享的 `Preparing tools` 计时，而不是为每个调用提前创建工具块；助手消息结束时冻结该计时。 |
| `tool_execution_start` | 移除共享的准备活动，创建对应的单工具块，并从零开始显示 running 耗时；并行调用仍按 `toolCallId` 独立维护，并随各自的 start 事件依次出现。 |
| `tool_execution_update` | 更新 bash 等工具的部分输出。 |
| `tool_execution_end` | 写入结构化结果并标记成功、失败或取消。用户中止的调用显示为已取消，而不是工具失败。 |
| `turn_input` | 在当前 run 的回合边界提交并渲染 Enter 排队的用户消息。 |
| `agent_end` | 按终态更新状态阶段并清除活动工具；run 被中止时移除尚未解析为单工具块的聚合准备活动，`turn_limit` 显示为独立的 `Turn limit` 错误阶段。 |

内置工具使用语义化 renderer，而不是通用结构化 JSON。具体来说，`view_image` 会显示 `Viewing`/`Viewed`、解析后的路径，以及 `PNG · 1440×832 · 19 KB` 这类紧凑的格式、尺寸和编码后大小元数据；它不会打印持久化的 base64 图片，也不会回退到通用 renderer。实时事件和恢复后的 session 历史使用同一路径。

Responses provider 的 `web_search_call`（当前来自 OpenAI Codex 与 DeepSeek V4 Flash）属于 provider-hosted 动作，不创建本地工具审批或 ToolRuntime 执行。TUI 为每个调用单独显示 `Searching the web`、`Searched the web`、`Opened a web page` 或 `Searched within a web page`；当前不聚合多个调用。搜索期间状态栏阶段为 `searching`。进行中的搜索显示耗时和 `Esc to abort`；中止时 Agent 会发布并持久化语义化的 canceled 状态，TUI 则冻结计时并显示 `Web search stopped`。最终回答中的供应商 Markdown 链接按正文原样渲染，TUI 不回插引用编号或追加 `Sources` 区块。

助手正文的协议状态与可视进度彼此分离：provider 和 Agent 仍会立即处理完整事件与消息，`StreamingTextPresenter` 只维护 Markdown 块当前可见的 `text` 前缀。稀疏文本 delta 会立即出现；当一次网络读取带来一批 SSE 事件时，积压内容约每 16ms 推进一次，并按 backlog 在每帧 1–12 个 grapheme 之间有界加速，消息完成后只额外提升一级用于收尾。工具调用开始、`toolUse` 消息完成、审批显示和实际执行前会先追平已经收到的正文，保证后续工具状态不会越过仍在展开的文本，同时不延迟 Agent 或 ToolRuntime。新消息或运行 reset 也会先 flush 剩余正文，因此持久化的 session 和 Agent 状态始终使用完整消息，而不是动画中的中间快照。配置 `tui.smooth_text_streaming = false` 会完全绕过该节奏控制，直接显示 provider 的最新流式快照；working 活动、Core thinking 事件、工具调用、工具结果、错误和状态阶段始终不参与文本节奏控制。

编辑器内部包含状态栏，它显示模型及可选推理强度（例如 `gpt-5.6-luna · max`；`none` 档位显示为 `off`）、Clean 模式标记、形如 `Context ~N% used` 的下一轮近似上下文、运行阶段、活动工具和 cwd。该百分比用可重放上下文除以 effective context limit，而不是直接展示上一轮 response 的原始 `input_tokens`；因此 system instructions 和工具 schema 会让新 session 带有非零基线。普通 provider usage 用于校准估算；包含托管搜索的响应则保留之前的干净锚点，只增加持久化输出与调用元数据，不计入临时搜索网页。数值在每个完整 model/tool `turn_end` 后、上下文压缩后以及 Agent run 结束时刷新。provider-hosted 网页搜索使用 `searching` 阶段，但不会出现在本地 `Tool …` 活动名称中。多个本地工具并行时，活动项压缩为第一个名称加剩余数量，例如 `Tool read +2`；任一调用失败后错误阶段会保留到该组全部结束，同时已完成的调用不会清除仍在运行的名称。上下文摘要生成期间阶段为 `compacting`，完成后立即用 checkpoint 估算更新百分比。运行中存在排队输入时，编辑器使用状态栏下方原本会被 Layout 补空的行显示 `Queued inputs`，并用 `next turn`、`next run` 或 `scheduled` 标出投递时机；`scheduled` 明细只表示已经到期并正在等待的新 run。尚未到期的 wake 不展开消息内容，只显示 `Scheduled · N · next HH:mm` 摘要。多行内容折叠为一行，空间不足时优先保留 pending 队列并截断明细。打开 slash 命令面板时会同时隐藏状态栏和两类队列预览；其他底部组件替换编辑器时，输入区、状态栏和预览一起隐藏。每条完成助手消息和摘要请求都会把 provider 原始 usage 原样累计到进程总用量。Kana 不估算金额，实际费用以 provider 账单为准；`/usage` 将回合上限终止与正常完成、输出截断、中止和失败分开统计。

恢复会话时，TUI 历史只消费 session 中已提交的 timeline，而 Agent 单独接收完整的已提交 messages 和最后一个 context checkpoint。进程内 inbox 输入和未来 wake 会在 session 切换或退出时清空，不会恢复。恢复的历史 `turn_start` 不渲染；实时 `turn_start` 只创建临时 working 活动。`turn_end` 不增加 transcript block，但会把完整回合的 context 估算传给状态栏。恢复过程中追加的内部 user message 显示为 muted 的安全恢复提示，不伪装成用户输入。timeline 中的 `context_compaction` 在其实际发生位置渲染为 muted 的 `Context compacted · 812k → ~430k tokens`；当前运行中的同类 marker 由 `context_compacted` event 立即追加。执行 `/compact` 时，transcript 先显示临时 muted 的 `Compacting context…`，成功后用完成 marker 替换，失败时则移除临时消息并显示错误；普通模式同时将 marker 持久化，Clean 模式只保留进程内 checkpoint。TUI 不保留从 messages 直接渲染历史的第二条兼容路径。

## 输入与快捷方式

全局输入先于焦点组件处理：

| 输入 | 行为 |
| --- | --- |
| `Ctrl+C` | 正在运行时中止本地 Shell、记忆压缩或 Agent；空闲且编辑器聚焦时，有文字/图片草稿则先清空，草稿为空才开始优雅退出；加载外部工具时直接退出；关闭等待期间再次按下会强制退出。 |
| `Esc` | 先关闭内容查看器；运行时中止当前工作。 |
| `Ctrl+O` | 打开/关闭最近一项可展开的工具输出。 |
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

空闲时 `Enter` 正常提交；Agent 运行中按 `Enter` 会把消息放入 `next-step`，在当前完整 model/tool turn 的 `turn_end` 之后投递，并在同一个 run 中开始下一次模型调用。若中止或 turn limit 使下一 turn 无法开始，Agent 会把同一条带 ID 消息移到 `next-turn` 尾部。Agent 运行中按 `Tab` 会直接加入 `next-turn`，等当前 `agent_end` 后作为新的 run 发送；空闲时普通输入的 `Tab` 不提交消息，slash 面板中的 `Tab` 仍用于补全。队列与到期 wake 按入队顺序共享 FIFO 投递通道。在支持增强键盘上报的终端中，`Shift+Enter` 插入显式换行。以 `/` 开头时显示命令面板；面板最多显示 10 条命令，随选中项滚动，且在首尾停止；未知 slash 输入和没有 shell 命令的单独 `!` 作为普通模型消息发送。

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
| `/image <path>` | 将本地图片路径附加到编辑器，但不立即提交。 |
| `/approval` | 临时更改当前 session 的工具审批模式；选择 `Never ask` 需要二次确认。 |
| `/model` | 依次选择供应商、模型以及模型支持时的推理强度，保存配置并热切换当前 Agent。 |
| `/memory` | 在底部选择操作和 scope；具体语义见[会话与记忆](sessions-and-memory.zh-CN.md)。 |
| `/compact` | 不发送用户消息，直接压缩当前对话上下文。 |
| `/usage` | 在底部选择统计范围，再打开对应的 API 用量。 |
| `/quit` | 无参数时退出；带参数时作为普通 prompt。 |

`/usage` 会让 token 标签、数值和比例条保持稳定列位。Runs 区域和按模型明细会显示 token 总数，并根据当前可见数据动态计算数字列宽，因此更大的次数、token 总数或更长的模型名不会推动相邻数值错位。各类 outcome 仍保持紧凑的单行摘要，底部视图较窄时可能被截断。

Clean 模式中 `/skills`、`/mcp`、`/memory`、`/fork`、`/resume` 和 `/delete` 保留为可发现命令，但执行时会显示明确的不可用错误。`/usage` 仍显示 Session、Project 和 Global 三个选项；选择 Session 会显示不可用错误，另外两个范围仍可读取历史汇总。`/new`、`/schedule`、`/image`、`/approval`、`/compact`、`/model` 和本地 Shell 可在临时会话内使用，其中 `/schedule` 的消息仍只存在于当前进程，`/model` 不写回配置文件。

## 控制器与焦点

独立 controller 保持 `KanaTuiApp` 不必承载每个交互状态机：

- `ExternalToolsLifecycleController` 统一处理会话可见后的首次外部工具加载和后续 MCP reload，持有追加式生命周期输出、输入禁用与恢复状态；工具集合变化时只通过回调请求 App 重建 Agent。
- `QueuedInputController` 只在本地保留当前 run 的 `next turn` 乐观预览；权威的 `next-step`、`next-turn`、到期 `scheduled` 和未来 wake 状态都投影自 `ConversationRuntime` 快照。输入被接受或 deferred 后，controller 按原有 `MessageId` 对齐该预览，即使正文完全相同也不会混淆。
- `ScheduledMessageManagerController` 用 `/schedule` 打开当前 session 的定时消息快照。未到期项按时间排列，已到期但尚未发送的项放在底部；只显示 `agent` 或 `you` 来源，不显示 Agent 的替换 key。列表不会随时钟或后台状态自动变化；`R`、添加或删除会重新读取快照。`A` 提供 5/15/30 分钟、1 小时和 `3m`、`90m`、`2h` 形式的自定义相对时间；`D` 确认后按未来输入的稳定 `MessageId` 同时检查 scheduler 与已到期 `next-turn` 项。面板活动期间新的 pending run 不会启动，`Esc` 关闭后恢复 FIFO 投递。
- `SlashCommandController` 统一完成 slash command 路由和参数校验；需要多步输入的命令再交给 `SlashCommandOptionsController`，App 不维护命令分发表。
- `ToolApprovalController` 调用 Agent 的 `beforeToolExecution` 钩子，并在每次调用前读取当前有效审批模式。`/approval` 设置的临时覆盖只作用于当前选中的 session；new、fork、resume 或进程退出会恢复 `config.toml`，且不会写入 session journal 或审批文件。编辑器可见时，审批选择框会替换它；如果另一个底部视图正在显示，审批会保持等待并仍触发配置的审批通知，关闭该视图后再显示审批。MCP 工具通过产品层别名解析器显示 server ID、远端工具原名和格式化完整参数，长参数沿用详情分页；它们不提供持久信任选项。用户拒绝会让该运行中止，选择 always 仅把 bash 命令加入精确白名单。
- `SessionLifecycleController` 统一协调 new、fork、resume 后的 transcript、焦点、context 状态和外部工具激活；其内部的 `SessionOverlayController` 用恢复列表或删除确认替换编辑器。
- `SkillManagerController` 用 global Skill 列表替换编辑器。`Enter` 只修改本地草稿，`Esc` 才应用；有变化的草稿只持久化一次，并用原消息历史重建一次 Agent，未变化则直接关闭。持久化失败时视图保持打开。
- `McpServerManagerController` 用已配置 MCP server 的 checkbox 替换 editor。`Enter` 只修改本地草稿；选中 OAuth HTTP server 时，`A` 打开认证子菜单，可授权、重新授权或退出登录，进行中的浏览器授权可用 `Esc` 中止。授权 URL、成功、失败或取消状态写入 transcript；退出登录会禁用该 server。返回列表后，主 `Esc` 才应用草稿；选择或已启用 server 的凭据发生变化时只触发一次完整 runtime reload。持久化失败时视图保持打开。组件显示 server ID、transport、OAuth 状态，以及 stdio 的完整命令行（`command` 加 `args`）或 HTTP URL，但不会接收环境变量、HTTP headers 或 token。
- `SlashCommandOptionsController` 用可取消的多步提示收集 slash command 选项。`/usage` 可选择 session、project 或 global；`/memory` 依次选择操作和 scope，Compact 再使用独立 `TextPrompt` 接收可选 request；`/approval` 可选择 Always ask、Ask unless trusted 或 Never ask，最后一项使用与删除会话相同的默认否定二次确认；`/model` 先选择 provider 与 model，再显示该模型 metadata 声明的 reasoning efforts。没有 reasoning metadata 的模型会跳过最后一步，`none` 显示为 `Off`。选项不通过 editor 参数传入，嵌套步骤中的 `Esc` 返回上一步。
- `/model` 只在空闲时完成切换。Kana 保留当前消息和 context checkpoint，先用新配置构造候选 Agent 和记忆压缩 scheduler；普通模式再原子保存实际变化的配置字段，Clean 模式只更新当前 Host 的已校验配置。全部成功后才替换当前 Agent，并同步状态栏中的模型和推理强度。构造或持久化失败会保留旧 Agent 和旧配置并在 transcript 显示错误。普通模式的选择会成为后续新建、分叉、恢复会话和压缩任务的活动配置；Clean 模式的选择只覆盖当前进程中的后续 new 和压缩工作，且不产生逐次 accounting 记录。
- `/compact` 不接受参数；它只在空闲时强制压缩当前对话上下文，不发送用户消息。
- `ContentViewerController` 用可滚动的只读内容替换底部组件，包括帮助、用量、记忆和工具输出；transcript 仍保持渲染。关闭时优先恢复正在等待的审批，否则恢复编辑器。
- `LocalShellController` 复用 bash Tool 显示逻辑，但不会触发审批。
- `MemoryCompactController` 运行可中止的全量记忆合并并在 transcript 中写摘要。

运行期间，除 `/quit` 外的 slash 命令被忽略，防止重入。打开底部视图时会切换焦点；关闭后优先恢复正在等待的审批，否则回到编辑器。审批到达时不会抢占当前底部视图。

## 通知与 Markdown

通知后端由配置选择。`auto` 依次探测 Kitty、iTerm、Ghostty 和 VTE，最后使用 bell；显式 `off` 不写任何通知。通知文本会移除控制字符、折叠空白，OSC 777 字段额外替换分号。正常 Agent 完成和需要审批可分别配置通知。

助手消息和内存查看器使用轻量 Markdown 渲染：标题、列表、引用、代码围栏、部分 inline 样式、表格、链接/图片文本和有限 HTML 规范化。配置允许且终端确认支持时，`http:`、`https:` 和 `mailto:` Markdown 链接通过 OSC 8 绑定到可见 label；每条软换行都会独立关闭并重新打开链接。关闭 `tui.hyperlinks`、终端能力未知或目标 scheme/内容不安全时不发送 OSC 8，并以 `label (url)` 保留可读目标；尚未闭合的流式链接按 Markdown 原文显示。表格按整块解析，支持可选外侧管道、空单元格、转义管道和列对齐；列宽按终端可见宽度分配并在窄屏下降级为纵向键值记录。流式表格只用已完成行确定列宽，正在增长的尾行先用整行宽度在表格下方预览，并在消息结束时纳入表格定稿。成对 HTML 标签和 void 标签会被移除，`vector<int>` 这类未配对的编程语法会按原文保留。Shiki 语法高亮在后台预加载；未加载时代码以普通文本显示。工具块对 list/glob/grep/read 显示摘要，对 write/edit 显示高亮 diff，对 bash 直接显示 stdout/stderr 文本，不添加退出码或字段标签。bash 返回非 0 退出码时仍按已完成命令渲染；真正的执行错误和超时才使用 failed 样式。用户取消使用独立的弱化 stopped 状态，不显示为工具执行失败；write 审批和工具块会区分新建与覆盖；长输出可在查看器中滚动，查看器会将多行标题折叠并截断为一行。

默认开启 `tui.render_latex = true`：`$...$` 与 `\(...\)` 渲染行内公式，独立成块的 `$$...$$` 与 `\[...\]` 渲染 display 公式。这个刻意受限的渲染器会把常见符号、黑板粗体字母、上下标、分数、根式、命名运算符、矩阵、cases 和 display 运算符上下限转换为 Unicode 与字符单元布局。不支持或格式错误的表达式会完整保留源码分隔符；流式表达式在分隔符闭合前始终按字面量显示。行内代码和代码围栏不会解释数学分隔符。display 输出在渲染后按终端可见单元宽度测量和换行，宽度不足不会把有效公式重新切换为源码。设置 `tui.render_latex = false` 可让所有已识别的数学公式保留原始 LaTeX。

默认开启 `tui.render_mermaid = true`：语言为 `mermaid` 的代码围栏会持续渲染为使用 Kana 主题的 Unicode 图，源码仍在流式生成时也会尝试更新。终端渲染器支持 `graph`/`flowchart`、`stateDiagram`/`stateDiagram-v2`、`classDiagram`、`erDiagram` 和 `sequenceDiagram`；这是 Mermaid.js 的实用子集，并不等同于浏览器中的完整语法。`:::highlight` 这类 Mermaid 样式类附加语法可以被接受，但不会改变终端颜色；边框、正文、连线和连线标签仍映射到 Kana 的语义主题。不支持或严重格式错误的图、渲染器失败以及宽于 Markdown 可用宽度的图会保留为普通代码块，不追加 warning。流式阶段可以继续显示尽力解析出的部分图；消息完成后若仍有源码无法表达，Kana 会恢复代码块，显示第一条 warning，并汇总其余 warning 的数量。设置 `tui.render_mermaid = false` 可让所有 Mermaid 代码围栏保留为源码。

## 修改渲染时的约束

- 不要直接向 stdout 写组件内容；经 `Tui.requestRender` 让差量渲染维护缓存和光标。
- 新底部视图必须明确打开/关闭时的焦点恢复。
- 新工具展示应净化控制序列，并处理部分结果与最终结果。
- 宽度逻辑必须以可见宽度和 grapheme 为单位，不能直接使用 `string.length`。
- 改变主屏重绘或终端序列时，更新 `tui-render`、cursor 和 width 测试，避免破坏 scrollback 或 IME 光标。
