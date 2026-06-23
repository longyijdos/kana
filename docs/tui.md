# TUI 交互与渲染

Kana 使用自研主屏 TUI，而非 alternate screen。`ProcessTerminal` 负责原始终端 I/O，`Tui` 负责组件、焦点和 ANSI 重绘，`KanaTuiApp` 负责把 Agent、会话和产品控制器连接到界面。

## 运行结构

```text
ProcessTerminal
  raw stdin、resize、终端通知、stdout
    → Tui
      输入监听器 → 当前焦点组件
      render(width) → 差量 ANSI 重绘
        → AppLayout
          transcript / content viewer
          inline tool approval
          editor
          session or skills overlay
          status line
```

`Component` 的最小接口是 `render(width): string[]`，可选 `handleInput` 和 `invalidate`。`Container` 按子组件顺序拼接行。`AppLayout` 固定先后关系：主内容、内联提示、编辑器、覆盖层、状态栏。控制器修改 layout 与焦点，组件本身主要处理呈现和局部键盘输入。

## 终端生命周期与渲染

`ProcessTerminal.start()` 要求 stdin/stdout 是 TTY，开启 raw mode、bracketed paste 和隐藏光标，注册输入与 resize。停止时恢复先前 raw 状态、暂停 stdin、显示光标并关闭 bracketed paste。TUI 结束会清屏和 scrollback，然后打印退出信息；退出信息包括累计 token、API 成本和可恢复会话命令（若有）。

`Tui` 将普通 `requestRender()` 合并到约 16ms 的定时器。每次渲染都会：

1. 调用根组件的 `render(width)`；
2. 取出编辑器插入的内部光标标记；
3. 根据 ANSI 以及 Unicode 可见宽度规范化行；
4. 在尺寸未变、内容只增加或改动可见时只重绘变化行；
5. 在宽高变化、行数减少、改动已滚出视口或请求强制刷新时全量清屏重绘；
6. 在同步输出模式下最后移动并显示硬件光标。

它维护已渲染行和可视 viewport 的缓存，避免反复计算未变 transcript 的 CJK 宽度。TUI 使用主屏，不进入 `?1049` alternate screen；这让 transcript 留在用户的终端 scrollback 中。

渲染辅助会去除 ANSI/控制序列计算宽度，使用 `string-width` 和 `Intl.Segmenter` 按 grapheme 换行和截断。因而 CJK、emoji、组合字符和颜色不会错误占用列数。工具输出在显示前会移除不安全的终端控制序列。

## App 与 Agent 事件

`KanaTuiApp` 维护当前 Agent、session ID、运行标志、累计模型用量和成本。提交 prompt 时，它把用户文本加入 transcript，消费 `AgentEventStream`，然后由 `AgentEventRenderer` 完成可视映射。`schedule_wake` 到期事件显示为 `Scheduled wake: …`，而不是用户键入的 prompt；任何运行中的 Agent、本地 Shell 或记忆压缩都会使它排队，操作完成后再投递。该工具的成功结果是紧凑工具块，显示等待时长和提醒文本：

| Agent 事件 | TUI 行为 |
| --- | --- |
| `message_start` / `message_update` / `message_end` | 创建、更新、完成助手 Markdown 块；thinking 在流式 thinking 事件期间显示当前耗时。工具调用解析期间显示 preparing 耗时，并在该调用结束时冻结。 |
| `tool_execution_start` | 创建或标记工具块为运行中，并从零开始显示 running 耗时。 |
| `tool_execution_update` | 更新 bash 等工具的部分输出。 |
| `tool_execution_end` | 写入结构化结果并标记成功/失败。 |
| `agent_end` | 更新状态阶段，清除活动工具。 |

状态栏显示 provider/model、最近助手消息的 context 使用率、运行阶段、活动工具和 cwd。每条完成助手消息的 usage 会累加到进程总用量和按模型元数据计算的 CNY 成本。

## 输入与快捷方式

全局输入先于焦点组件处理：

| 输入 | 行为 |
| --- | --- |
| `Ctrl+C` | 正在运行时中止本地 Shell、记忆压缩或 Agent；空闲时退出进程。 |
| `Esc` | 先关闭内容查看器；运行时中止当前工作。 |
| `Ctrl+O` | 打开/关闭最近一项可展开的工具输出。 |
| `!<command>` | 不经过 Agent 或工具审批，直接运行本地 bash，并显示同样的工具块。 |

编辑器支持多行输入、最多 5 个可见行、历史记录（最多 100 条）、方向键导航、Home/End/Delete、bracketed paste 和 slash 补全。编辑、移动和删除按 grapheme 边界进行。上/下先在软换行/显式换行中移动，到边界才进入历史。以 `/` 开头时显示命令面板；面板最多显示 10 条命令，随选中项滚动，且在首尾停止；未知 slash 输入作为普通模型消息发送。

| Slash 命令 | 行为 |
| --- | --- |
| `/help` | 输出命令和快捷方式。 |
| `/clear` | 清空 transcript 与编辑器，不删除会话。 |
| `/new` | 新建空会话并重建 Agent。 |
| `/fork <prompt>` | 从当前 Agent 历史创建分叉会话后发送 prompt。 |
| `/resume [id]` | 恢复指定会话或打开选择器。 |
| `/delete` | 选择并确认删除会话。 |
| `/skills` | 管理全局 Skills 开关，并重建 Agent 的系统提示词。 |
| `/memory …` | 查看或压缩记忆；具体语义见[会话与记忆](sessions-and-memory.md)。 |
| `/quit` | 无参数时退出；带参数时作为普通 prompt。 |

## 控制器与焦点

独立 controller 保持 `KanaTuiApp` 不必承载每个交互状态机：

- `ToolApprovalController` 调用 Agent 的 `beforeToolExecution` 钩子。它将选择框作为内联提示；用户拒绝会让该运行中止，选择 always 仅把 bash 命令加入精确白名单。
- `SessionOverlayController` 管理恢复列表和删除确认。新 session、恢复和删除都会更新 transcript/焦点。
- `SkillManagerController` 只修改 global Skill 的列表，保存后中止旧 Agent 并用原消息历史创建新 Agent，从而刷新提示词。
- `ContentViewerController` 用可滚动全屏主内容替换 transcript；关闭时优先恢复仍在等待的审批提示焦点。
- `LocalShellController` 复用 bash Tool 显示逻辑，但不会触发审批。
- `MemoryCompactController` 运行可中止的全量记忆合并并在 transcript 中写摘要。

运行期间，除 `/quit` 外的 slash 命令被忽略，防止重入。打开 overlay 或查看器时会切换焦点；关闭后通常回到 editor。

## 通知与 Markdown

通知后端由配置选择。`auto` 依次探测 Kitty、iTerm 和 VTE，最后使用 bell；显式 `off` 不写任何通知。通知文本会移除控制字符、折叠空白，OSC 777 字段额外替换分号。正常 Agent 完成和需要审批可分别配置通知。

助手消息和内存查看器使用轻量 Markdown 渲染：标题、列表、引用、代码围栏、部分 inline 样式、表格行、链接/图片文本和有限 HTML 规范化。Shiki 语法高亮在后台预加载；未加载时代码以普通文本显示。工具块对 write/edit 显示高亮 diff，对 bash 显示尾部输出；长输出可在查看器中滚动。

## 修改渲染时的约束

- 不要直接向 stdout 写组件内容；经 `Tui.requestRender` 让差量渲染维护缓存和光标。
- 新 overlay 必须明确打开/关闭时的焦点恢复。
- 新工具展示应净化控制序列，并处理部分结果与最终结果。
- 宽度逻辑必须以可见宽度和 grapheme 为单位，不能直接使用 `string.length`。
- 改变主屏重绘或终端序列时，更新 `tui-render`、cursor 和 width 测试，避免破坏 scrollback 或 IME 光标。
