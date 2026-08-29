# 终端渲染

Kana 直接在终端主屏幕渲染界面。本文说明终端控制、组件布局、差量重绘、可见宽度处理、Markdown、图表和工具展示；应用命令、焦点切换与事件投影见 [TUI 交互](tui.zh-CN.md)。

## 渲染栈

```text
ProcessTerminal
  raw input、resize event、capability、stdout
    → Tui
      component render(width, availableHeight?)
      cursor 提取与行规范化
      差量 ANSI 重绘
        → AppLayout
          transcript
          一个获得焦点的 bottom component
```

`ProcessTerminal` 负责操作系统终端边界，`Tui` 负责渲染调度、frame 状态、cursor 放置和输出。组件只返回声明式文本行，不直接向 stdout 写内容。

## 组件与布局

最小 `Component` 契约是 `render(width, availableHeight?): string[]`，并可选择实现 input 与 invalidate hook。组件可以根据高度提示调整策略，但协议本身不裁剪输出。

`AppLayout` 只保留一个 bottom 区域，其余空间交给 transcript。终端高度不少于 30 行时 bottom 总预算为 15 行，24–29 行时为 12 行，18–23 行时为 9 行，7–17 行时为 7 行；更矮的终端把全部行交给 bottom。预留区域的第一行是分隔线。较短的 bottom 输出会补空行，避免在 editor、prompt、picker 和 viewer 之间切换时移动 transcript 边界。

Transcript 会有意渲染完整历史，让终端自然滚动保留内容。紧凑 block 自己限制高度，长详情在 bottom viewer 中打开，不让主历史无限扩张。

## 终端生命周期

`ProcessTerminal.start()` 要求 stdin 和 stdout 都是 TTY。它启用 raw mode、bracketed paste、终端支持时的增强键盘上报和隐藏 cursor，然后注册输入与 resize。增强上报让终端能够区分 `Shift+Enter` 与 `Enter` 等输入。

关闭时会恢复原始 raw 状态、暂停 stdin、显示 cursor、弹出增强键盘上报、关闭 bracketed paste，并在打印退出信息前清除 Kana 的可见 frame 与 scrollback。应用清理必须在终端恢复前完成；第二次中断强制退出时，也会先恢复终端状态再交回默认 signal 行为。

Kana 从不进入 `?1049` alternate screen。正因为使用主屏幕，已完成的 transcript 内容才能保留在终端 scrollback 中。

## 渲染调度与重绘

应用和 controller 只调用 `Tui.requestRender()`。普通请求会合并到约 16 ms 的 frame；每一帧中，runtime 会：

1. 按当前尺寸渲染 root component。
2. 提取 editor 内部 cursor marker。
3. 按 ANSI-aware 可见宽度规范化文本行。
4. 逻辑内容不变时只更新硬件 cursor。
5. 否则重绘可见范围内最小的首尾变化区间，通过自然滚动追加内容，并用 `CSI 2K` 清除仍可见的过期尾行。

首帧、尺寸变化、变化内容已经进入 scrollback、删除使新尾部高于可寻址 viewport，或无法安全推断 cursor 状态时，必须完整清屏并 replay。`/clear` 使用相同规则：被删除行仍可寻址时局部 patch，影响 scrollback 后回退到 replay。

Renderer 会缓存规范化文本行和 viewport 状态，并在终端支持时用 synchronized output 包住一次 repaint。获得焦点的组件得到可见硬件 cursor；没有焦点时，cursor 隐藏在布局尾部。

## 文本宽度与终端安全

渲染 helper 在测量前去除 ANSI 与终端控制序列，再使用 `string-width` 和 `Intl.Segmenter` 按 grapheme 换行与截断。CJK、emoji、组合字符和 ANSI 颜色因此会占用正确的终端列，也不会拆开用户感知字符。

不可信工具与供应商文本会在显示前清理。宽度敏感代码必须使用可见 cell，而不是 JavaScript 字符串长度；ANSI style 也必须在行边界闭合，避免重绘把样式泄漏到后续行。

## Markdown

助手消息与 memory viewer 共用轻量 Markdown renderer，支持标题、列表、引用、代码围栏、部分 inline 样式、表格、链接与图片文本，以及有限 HTML 规范化。成对标签和 void 标签会被移除，`vector<int>` 这类未配对的编程文本保持原样。

配置允许且终端确认支持时，安全的 `http:`、`https:` 与 `mailto:` 链接使用 OSC 8；每个换行后的 row 会单独关闭并重新打开链接。关闭或无法确认支持、以及不安全目标都会使用可读的 `label (url)` fallback；未完成的流式链接保持 Markdown 原文。

表格接受可选外侧管道、空单元格、转义管道和对齐。列宽按可见 cell 计算，窄终端会降级为纵向键值记录。流式过程中只有完整行参与列宽计算，正在增长的尾行单独预览，并在消息完成后合入最终表格。

Shiki 语法高亮在后台预加载；highlighter 就绪前，代码围栏使用普通文本。

## LaTeX 与 Mermaid

`tui.render_latex = true` 时，inline 与 display delimiter 会把一组刻意受限的符号、上下标、分数、根式、operator、matrix、cases 和 display limit 渲染成 Unicode cell 布局。不支持、格式错误、已禁用或尚未闭合的表达式会保留完整源码；code span 与 fence 从不解释数学 delimiter。

`tui.render_mermaid = true` 时，`mermaid` fence 可以在流式过程中渲染为带主题的 Unicode 图。支持子集包括 flowchart、state diagram、class diagram、ER diagram 与 sequence diagram。不支持的语法、致命解析错误、renderer 失败或超出可用 Markdown 宽度的输出会回退源码 fence。流式 partial parse 可以暂时显示；完成后仍有未表示源码时，会恢复 fence 并追加有界 warning。

## 工具 block 与详情

内置工具使用由 schema 所有者定义的 renderer，未知、Custom 与 MCP 工具使用通用表示。紧凑历史有明确上限：

| 内容 | 紧凑预算 |
| --- | --- |
| 身份 | 一行标题 |
| 内置工具 target | 一行压平并水平截断的文本 |
| Bash | 最后 8 个源码行 |
| Write | 最多 7 个预览行，包括字节数结果 |
| Edit | 最多 3 个删除行和 3 个新增行，包括省略标记 |
| 未知、Custom 或 MCP | pretty JSON 的前 8 行 |

只有参数 schema 由 Kana 拥有的内置工具会把字段提升为 target 行。省略内容会显示明确行数，过宽的预览行只截断、不换行。这些边界只影响展示；canonical 参数、结果和审批详情始终完整。

详情 inspector 可以打开每个工具调用，不依赖紧凑 block 是否可展开。它使用完整 renderer、对长行软换行、包含实际 execution metadata，并支持在不改变 transcript 历史的情况下切换调用。紧凑与详情形式都会清理控制序列。

## 修改检查项

- 组件变化统一通过 `requestRender()`；直接写 stdout 会破坏 frame 与 cursor 状态。
- 每个新组件都要定义 bottom 高度行为和有焦点时的 cursor 位置。
- 换行、截断、表格、cursor 列和图表都使用可见宽度与 grapheme。
- 外部输出的 partial 与 final 形态都要先清理再渲染。
- 修改终端机制时覆盖 repaint、收缩、scrollback、resize、cursor、ANSI、CJK、emoji 和 IME 场景。
- 配置字段留在[配置与安装](configuration.zh-CN.md)，用户交互留在 [TUI 交互](tui.zh-CN.md)。
