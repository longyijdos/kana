# TUI 交互与渲染

Kana 使用自研主屏 TUI，而非 alternate screen。`ProcessTerminal` 负责原始终端 I/O，`Tui` 负责组件、焦点和 ANSI 重绘，`KanaTuiApp` 负责把 Agent、会话和产品控制器连接到界面。

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
            或 session / skills / MCP / slash command 提示
            或 content viewer
```

`Component` 的最小接口是 `render(width, availableHeight?): string[]`，可选 `handleInput` 和 `invalidate`。该协议不会裁剪输出，但组件可根据高度选择渲染策略。`AppLayout` 为唯一底部组件保留分档区域：终端高度不小于 30 行时使用 15 行，24–29 行使用 12 行，18–23 行使用 9 行，7–17 行使用 7 行；终端不足 7 行时将全部可用高度分给 bottom。剩余高度传给 main。底部区域首行由 layout 统一绘制 main/bottom 分隔线，其余高度传给底部组件；所有底部组件的内容都直接跟在分隔线后。组件输出不足时由 layout 补空行，因此切换底部组件不会带动 main 内容。列表视图会缩小项目窗口并保持选中项可见，编辑器会缩小输入和命令窗口，较长的选择提示详情可用 `PageUp`/`PageDown` 翻页。普通 bottom 标题统一使用 `bottomTitle`，当前选项使用 `user`；工具审批和危险确认分别用 `toolActive` 与 `error` 覆盖标题颜色。`KanaTuiApp` 目前将 transcript 作为 main 传入；Transcript 仍刻意渲染完整历史，交由终端 scrollback 保留。组件本身主要处理呈现和局部键盘输入。

## 终端生命周期与渲染

`ProcessTerminal.start()` 要求 stdin/stdout 是 TTY，开启 raw mode、bracketed paste、增强键盘上报和隐藏光标，注册输入与 resize。增强键盘上报用于让支持的终端区分 `Shift+Enter` 与 `Enter`。当前会话显示后，外部工具加载器在 transcript 末尾追加状态块并取消 editor 焦点；状态块随 MCP manager 进度更新，完成后保留为 server/tool 数量摘要，再用发现的工具重建 Agent 并恢复 editor。OAuth server 需要浏览器授权时，会另外追加临时授权 URL 块，成功或失败后在原位置替换为最终状态，避免凭据 URL 永久保留。可选服务器失败会在摘要后留下错误色警告；初次加载时必需服务器失败则显示错误、保持禁用输入。`kana resume` 的会话选择器位于加载边界之前，因此仅浏览或退出列表不会启动 MCP。应用有变化的 `/mcp` 草稿也会在 transcript 中显示同样的进度；但 reload 失败时会用无过期 MCP 工具的状态重建 Agent 并恢复 editor，用户可以继续重试。`KanaTuiApp.stop()` 是幂等异步边界：在 transcript 末尾追加关闭状态并取消底部组件焦点，中止并等待活动 Agent，再由产品层关闭 MCP manager；manager 的中立进度事件更新同一个 transcript 块，bottom 不会被替换。完成清理后才停止终端、恢复先前 raw 状态、暂停 stdin、显示光标、弹出增强键盘上报、关闭 bracketed paste、清屏和 scrollback，并打印累计 token、API 成本和可恢复会话命令（若有）。空闲退出和 `SIGHUP`、`SIGINT`、`SIGTERM` 都走这条路径；优雅关闭期间的第二次 raw-mode `Ctrl+C` 会先恢复终端再向当前进程发送默认 `SIGINT`。首个进程信号同样会移除 Kana 的监听器，使第二个信号按系统默认行为强制终止。

`Tui` 将普通 `requestRender()` 合并到约 16ms 的定时器。每次渲染都会：

1. 调用根组件的 `render(width, height)`；
2. 取出编辑器插入的内部光标标记；
3. 根据 ANSI 以及 Unicode 可见宽度规范化行；
4. 在尺寸未变、内容只增加或改动可见时只重绘变化行；
5. 在宽高变化、行数减少、改动已滚出视口或请求强制刷新时全量清屏重绘；
6. 在同步输出模式下，仅为当前焦点组件移动并显示硬件光标；没有焦点时将光标留在布局末尾并保持隐藏。

它维护已渲染行和可视 viewport 的缓存，避免反复计算未变 transcript 的 CJK 宽度。TUI 使用主屏，不进入 `?1049` alternate screen；这让 transcript 留在用户的终端 scrollback 中。

渲染辅助会去除 ANSI/控制序列计算宽度，使用 `string-width` 和 `Intl.Segmenter` 按 grapheme 换行和截断。因而 CJK、emoji、组合字符和颜色不会错误占用列数。工具输出在显示前会移除不安全的终端控制序列。

## App 与 Agent 事件

`KanaTuiApp` 维护当前 Agent、session ID、运行标志、累计模型用量和成本。提交 prompt 时，它把用户文本加入 transcript，消费 `AgentEventStream`，然后由 `AgentEventRenderer` 完成可视映射。Transcript 在每两个有输出的 Block 之间统一插入一个普通空行，Block 只管理自身内部留白。用户键入的消息使用 ASCII 边框、浅灰正文和蓝色 `> ` 前缀；显式换行和软换行的后续行与正文对齐。`schedule_wake` 到期事件显示为 `Scheduled wake: …`，而不是用户键入的 prompt；任何运行中的 Agent、本地 Shell、记忆压缩、已打开的 MCP 管理界面或 MCP reload 都会使它排队，状态结束后再投递。该工具的成功结果是紧凑工具块，显示等待时长和提醒文本：

| Agent 事件 | TUI 行为 |
| --- | --- |
| `message_start` / `message_update` / `message_end` | 创建、更新、完成助手 Markdown 块；thinking 在流式 thinking 事件期间显示当前耗时。工具调用解析期间显示 preparing 耗时，并在该调用结束时冻结。 |
| `tool_execution_start` | 创建或标记工具块为运行中，并从零开始显示 running 耗时。 |
| `tool_execution_update` | 更新 bash 等工具的部分输出。 |
| `tool_execution_end` | 写入结构化结果并标记成功/失败。 |
| `agent_end` | 更新状态阶段，清除活动工具。 |

编辑器内部包含状态栏，它显示 provider/model、最近助手消息的 context 使用率、运行阶段、活动工具和 cwd。打开 slash 命令面板时会隐藏状态栏；其他底部组件替换编辑器时，输入区和状态栏会一起隐藏。每条完成助手消息的 usage 会累加到进程总用量和按模型元数据计算的 CNY 成本。

## 输入与快捷方式

全局输入先于焦点组件处理：

| 输入 | 行为 |
| --- | --- |
| `Ctrl+C` | 正在运行时中止本地 Shell、记忆压缩或 Agent；空闲或加载外部工具时开始优雅退出；关闭等待期间再次按下会强制退出。 |
| `Esc` | 先关闭内容查看器；运行时中止当前工作。 |
| `Ctrl+O` | 打开/关闭最近一项可展开的工具输出。 |
| `!<command>` | 不经过 Agent 或工具审批，直接运行本地 bash，并显示同样的工具块。 |

编辑器使用与用户消息块相同的 ASCII 边框、浅灰正文和蓝色 `> ` 前缀，不设置输入区域背景色；框体直接跟在 Layout 分隔线后，底部不额外留空行。输入为空时，它会从 `/help` 的 slash 命令和稳定的全局快捷键中随机选择一项作为 placeholder；启动和每次按普通 `Enter` 后都会选择一个不同于当前条目的提示，其他重绘不会改变它。命令面板、placeholder、`/help` 和 usage 错误共同读取同一份命令语法与描述。编辑器支持多行输入、最多 5 个可见行、历史记录（最多 100 条）、方向键导航、Home/End/Delete、bracketed paste 和 slash 补全。`Enter` 提交当前输入；在支持增强键盘上报的终端中，`Shift+Enter` 插入显式换行。编辑、移动和删除按 grapheme 边界进行。上/下先在软换行/显式换行中移动，到边界才进入历史。以 `/` 开头时显示命令面板；面板最多显示 10 条命令，随选中项滚动，且在首尾停止；未知 slash 输入和没有 shell 命令的单独 `!` 作为普通模型消息发送。

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
| `/memory` | 在底部选择操作和 scope；具体语义见[会话与记忆](sessions-and-memory.md)。 |
| `/usage` | 在底部选择统计范围，再打开对应的 API 用量。 |
| `/quit` | 无参数时退出；带参数时作为普通 prompt。 |

## 控制器与焦点

独立 controller 保持 `KanaTuiApp` 不必承载每个交互状态机：

- `ToolApprovalController` 调用 Agent 的 `beforeToolExecution` 钩子。编辑器可见时，审批选择框会替换它；如果另一个底部视图正在显示，审批会保持等待并仍触发配置的审批通知，关闭该视图后再显示审批。MCP 工具通过产品层别名解析器显示 server ID、远端工具原名和格式化完整参数，长参数沿用详情分页；它们不提供持久信任选项。用户拒绝会让该运行中止，选择 always 仅把 bash 命令加入精确白名单。
- `SessionOverlayController` 用恢复列表或删除确认替换编辑器。新 session、恢复和删除都会更新 transcript 和焦点。
- `SkillManagerController` 用 global Skill 列表替换编辑器。`Enter` 只修改本地草稿，`Esc` 才应用；有变化的草稿只持久化一次，并用原消息历史重建一次 Agent，未变化则直接关闭。持久化失败时视图保持打开。
- `McpServerManagerController` 用已配置 MCP server 的 checkbox 替换 editor。`Enter` 只修改本地草稿；选中 OAuth HTTP server 时，`A` 打开认证子菜单，可授权、重新授权或退出登录，进行中的浏览器授权可用 `Esc` 中止。授权 URL、成功、失败或取消状态写入 transcript；退出登录会禁用该 server。返回列表后，主 `Esc` 才应用草稿；选择或已启用 server 的凭据发生变化时只触发一次完整 runtime reload。持久化失败时视图保持打开。组件显示 server ID、transport、OAuth 状态，以及 stdio 的完整命令行（`command` 加 `args`）或 HTTP URL，但不会接收环境变量、HTTP headers 或 token。
- `SlashCommandOptionsController` 用可取消的多步提示收集 slash command 选项。`/usage` 可选择 session、project 或 global；`/memory` 依次选择操作和 scope，Compact 再使用独立 `TextPrompt` 接收可选 request。选项不通过 editor 参数传入，嵌套步骤中的 `Esc` 返回上一步。
- `ContentViewerController` 用可滚动的只读内容替换底部组件，包括帮助、用量、记忆和工具输出；transcript 仍保持渲染。关闭时优先恢复正在等待的审批，否则恢复编辑器。
- `LocalShellController` 复用 bash Tool 显示逻辑，但不会触发审批。
- `MemoryCompactController` 运行可中止的全量记忆合并并在 transcript 中写摘要。

运行期间，除 `/quit` 外的 slash 命令被忽略，防止重入。打开底部视图时会切换焦点；关闭后优先恢复正在等待的审批，否则回到编辑器。审批到达时不会抢占当前底部视图。

## 通知与 Markdown

通知后端由配置选择。`auto` 依次探测 Kitty、iTerm 和 VTE，最后使用 bell；显式 `off` 不写任何通知。通知文本会移除控制字符、折叠空白，OSC 777 字段额外替换分号。正常 Agent 完成和需要审批可分别配置通知。

助手消息和内存查看器使用轻量 Markdown 渲染：标题、列表、引用、代码围栏、部分 inline 样式、表格、链接/图片文本和有限 HTML 规范化。表格按整块解析，支持可选外侧管道、空单元格、转义管道和列对齐；列宽按终端可见宽度分配并在窄屏下降级为纵向键值记录。流式表格只用已完成行确定列宽，正在增长的尾行先用整行宽度在表格下方预览，并在消息结束时纳入表格定稿。成对 HTML 标签和 void 标签会被移除，`vector<int>` 这类未配对的编程语法会按原文保留。Shiki 语法高亮在后台预加载；未加载时代码以普通文本显示。工具块对 list/glob/grep/read 显示摘要，对 write/edit 显示高亮 diff，对 bash 直接显示 stdout/stderr 文本，不添加退出码或字段标签；write 审批和工具块会区分新建与覆盖；长输出可在查看器中滚动，查看器会将多行标题折叠并截断为一行。

## 修改渲染时的约束

- 不要直接向 stdout 写组件内容；经 `Tui.requestRender` 让差量渲染维护缓存和光标。
- 新底部视图必须明确打开/关闭时的焦点恢复。
- 新工具展示应净化控制序列，并处理部分结果与最终结果。
- 宽度逻辑必须以可见宽度和 grapheme 为单位，不能直接使用 `string.length`。
- 改变主屏重绘或终端序列时，更新 `tui-render`、cursor 和 width 测试，避免破坏 scrollback 或 IME 光标。
