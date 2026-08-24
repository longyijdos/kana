# 会话与记忆

Kana 将可恢复的对话历史与跨对话记忆分开存储：会话保存完整 `Message` 历史，记忆保存经压缩的长期参考信息。两者均按工作区隔离；全局记忆是唯一跨工作区的数据。

## 工作区标识

会话和 project 记忆共享相同的工作区编码：先将 `cwd` 转为绝对路径，去掉开头的路径分隔符，再把路径分隔符和 `:` 替换为 `-`，最后用 `--` 包裹。它是稳定的目录名，不是加密或安全边界。

```text
cwd: /Users/alice/project
  → --Users-alice-project--
```

因此同一解析后路径的会话和 project 记忆会放到相应的同名目录；不同路径相互隔离。

## 运行时日志

运行时日志使用同一工作区编码，路径为：

```text
<KANA_HOME>/logs/<encoded-workspace>/<session-id>.jsonl
```

每行是一个分级 JSON 记录，包含时间、级别、稳定事件名、session ID 和安全的元数据。session 是日志文件边界：恢复同一 session 会追加原文件，`/new`、`/fork` 或恢复另一 session 会写入新文件。日志不是会话历史，不保存 prompt、助手文本、完整工具参数或输出；其配置和级别见[配置与安装](configuration.zh-CN.md)。

Clean 模式仍在进程内分配 session ID 供 runtime 关联状态，但使用 no-op logger，不创建上述日志文件。

## 会话

会话持久化实现位于 `src/kana/session/`：`format.ts` 定义并校验 V5 记录与 checkpoint 转换，`journal.ts` 维护追加顺序和中断恢复状态机，`repository.ts` 负责创建、查找、读取、尾部修复和删除。内部与跨层调用方都通过 `session/index.ts` 的稳定领域导出使用这些能力。

会话文件位于：

```text
<KANA_HOME>/sessions/<encoded-workspace>/<safe-created-at>_<uuid>.jsonl
```

创建会话只在内存中生成 UUID、创建时间、工作目录、可选模型元数据和可选父会话路径。文件在第一次有消息需要追加时才创建；空会话不会出现在 `/resume` 列表中。

Clean 模式不向 session repository 注册 journal：消息和 context checkpoint 只保留在当前 `ConversationRuntime` 中，`/new` 可切换到新的临时会话，但 `/fork`、恢复、列出和删除 session 均不可用，退出后当前会话即丢弃。

### JSONL 格式

新 session 的第一行是版本为 5 的 header，后续是带明确边界的 turn journal。正常运行使用 `kind: "agent"`；分叉初始历史和内部批量导入使用 `kind: "snapshot"`：

```json
{"type":"session","version":5,"id":"…","createdAt":"2026-06-22T…Z","title":"Fix parser","cwd":"/repo","model":{"provider":"deepseek","model":"deepseek-v4-pro"}}
{"type":"turn_start","id":"…","parentId":null,"timestamp":"2026-06-22T…Z","turnId":"…","kind":"agent"}
{"type":"message","id":"entry-u1","parentId":"…","timestamp":"2026-06-22T…Z","message":{"id":"message-u1","role":"user","provenance":{"kind":"user_input"},"content":"Fix parser"}}
{"type":"message","id":"entry-c1","parentId":"entry-u1","timestamp":"2026-06-22T…Z","message":{"id":"message-c1","role":"user","provenance":{"kind":"runtime_context","source":"environment"},"content":"<runtime_context source=\"environment\">…</runtime_context>"}}
{"type":"message","id":"entry-a1","parentId":"entry-c1","timestamp":"2026-06-22T…Z","message":{"id":"message-a1","role":"assistant","provenance":{"kind":"model_output"},"content":[…],"stopReason":"stop"}}
{"type":"todo_state","id":"…","parentId":"entry-a1","timestamp":"2026-06-22T…Z","toolCallId":"call-todo-1","items":[{"content":"Fix parser","status":"in_progress"}]}
{"type":"context_compaction","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","reason":"threshold","coversThroughId":"…","compactedMessageCount":2,"beforeTokens":90000,"estimatedAfterTokens":60000,"summary":{"format":"kana-context-summary-v1","text":"…"}}
{"type":"turn_end","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","turnId":"…","outcome":"stop"}
```

用户消息和工具结果消息都可以包含 `images`；每一项保存 `mimeType`、原始 base64 `data`、`width` 和 `height`。图片字节以内联方式保存，而不是引用外部文件，因此即使源文件或剪贴板之后变化，用户附件和 Agent 发起的视觉观察仍然自包含。工具的结构化 `result` 只保存元数据，不重复图片字节。代价是 JSONL 会增大——base64 还会在规范化后的图片大小上增加编码开销——图片较多的会话可能明显占用空间。上下文 token 估算使用 32 像素图片 patch，不按 base64 长度计算。加载时会对两种 role 拒绝格式错误的图片数组、不支持的 MIME 类型、非字符串数据，以及非正整数尺寸。

动态 prompt 状态使用内部 user-role 消息，`provenance.kind` 为 `"runtime_context"`，并带有非空 `source`。每个 source renderer 都必须返回明确且非空的 active 或 inactive 状态。初始就是 inactive 的 source 不写消息；激活后，Agent 会把每次有变化的状态写入 journal。这些转换会追加保留在 JSONL 和压缩前的模型输入中。稳定 system 指令只让每个 source 的最后一次转换生效；由 source 定义正文的 `status="inactive"` 会作废其更早状态。`environment` 来源从进程重新计算；`todo` 来源则是权威 `todo_state` 的只读投影。由于这些内部消息不是人类输入，恢复后的 TUI 历史不会展示。

每条 `todo_state` 保存一次完整接受列表；由工具更新时还记录所属 `toolCallId`。Journal 会在 `todo_write` 校验通过后、紧凑工具结果写入前同步保存它，因此崩溃不会留下“已确认但未持久化”的更新。加载器扫描这些记录重建最新列表；空 `items` 显式清空，全部为 `completed` 或出现新的 human turn 都不会自动清空。如果中断发生在状态记录之后、结果之前，恢复会补写确定的成功确认，而不会把该调用降级为 unknown。Clean 模式维持相同的内存状态变化，但不写 JSONL。

工具结果策略可以追加另一类内部 user-role 消息，其 `provenance.kind` 为 `"tool_result_policy"`，并带有非空的策略 `source`。它在完整 sibling 工具结果组之后写入 journal，并在下一次模型请求前重放。恢复 session 时会保留它以维持模型上下文连续性；由于它不是人类输入，恢复后的 TUI 历史和自动 session 标题都会忽略它。

超大的文本工具结果可以只在消息中保留有界 `content` 预览和 `artifact: { kind: "text", locator, byteLength }`，不保存结构化 `result`。完整 UTF-8 文本位于：

```text
<KANA_HOME>/artifacts/<encoded-workspace>/<session-id>/<uuid>-<safe-stem>.txt
```

artifact 根目录、工作区目录与 session 目录均使用仅 owner 可访问的 `0700`，文件使用不可预测名称、exclusive no-follow 创建和 `0600`；建议文件名会缩减成不能穿越目录的安全 stem。绝对 locator 可直接交给现有 `read` 与 `grep` 工具，同时结构化 artifact 元数据让恢复和生命周期代码无需解析模型可见 notice，就能校验归属与字节长度。恢复后的 TUI 历史也会用这些元数据生成紧凑的已存储输出摘要，只在展开式查看器中显示 locator。artifact 文本可能包含原本会进入 session 的同等敏感工具输出，因此该目录属于私有用户数据，并不是通用文件管理器。Clean 模式使用惰性创建的进程级临时目录，正常关闭时删除，不创建上述持久路径。

压缩会遵循当前模型实际生效的图片输入能力。模型支持图片且 `image_input` 已启用时，Kana 会把用户附件和工具视觉观察连同有序序号、MIME 类型和尺寸元数据发送给模型，让摘要将相关视觉信息保存为文本；base64 不会写进文本形式的 transcript JSON。图片输入不受支持或被关闭时，压缩只发送这些元数据和 `contentOmitted: true`，不带图片字节并继续执行。这样切换到 DeepSeek 等纯文本模型后不会因历史图片而中断压缩，但尚未在文本中描述的纯视觉细节可能不会进入摘要。原始自包含图片仍保留在 session JSONL 中。

每条记录的 `parentId` 必须指向紧邻的前一条时间线记录；加载仍按文件顺序进行，不根据 `parentId` 重放分支。message record 外层的 `id` 用于标识 journal entry 并维护时间线顺序，`message.id` 则在 Agent event、inbox 移动、持久化、重放和 fork 之间标识同一条逻辑消息；它们属于不同的身份域。每条消息都必须带可辨识的 `provenance`，同一 session 会拒绝重复的逻辑消息 ID。同一时刻最多有一个打开的 turn，`turn_end.turnId` 必须匹配它。终态可以是 Agent 的 `stop`、`length`、`aborted`、`error`、`turn_limit`，恢复生成的 `interrupted`，或快照的 `snapshot`。

压缩记录的 `reason` 可以是自动阈值触发的 `threshold`、provider 超限恢复的 `provider_limit`，或 `/compact` 触发的 `manual`。记录的物理位置表示压缩何时发生，`coversThroughId` 则指向摘要实际覆盖的最后一条 message，因此两者可以不同。例如 marker 写在 `m4` 后但 `coversThroughId = m2` 时，恢复给模型的 projection 是 `summary + m3 + m4 + 后续消息`。生成摘要时会排除 runtime-context 消息；checkpoint 边界上每个 source 的最后状态只有仍 active 时才会在摘要后重新投影，边界后的全部转换保持原顺序。被覆盖的旧状态和 inactive 转换会与其它被覆盖原始消息一起退出模型输入。所有原始 message 仍留在 JSONL 中，TUI 也能按原顺序显示完整的用户可见历史。

后续压缩会带可选 `baseCompactionId` 指向上一个 checkpoint，并把旧摘要与新覆盖消息合并成一份新的累计摘要。`usage` 可保存该次摘要请求的模型用量。加载时会验证 `coversThroughId` 和 `baseCompactionId` 只引用已出现的记录，然后同时派生完整 `messages`、完整 `timeline` 和最后一个 `contextCheckpoint`：Agent 使用 messages/checkpoint，TUI 历史只消费 timeline。

运行时只读取 V5，不包含旧于 V5 的兼容分支。`/fork <prompt>` 创建新会话，将源 session 文件路径写入 header 的 `parentSessionPath`，并把继承的消息、当前累计 checkpoint 与最新 todo 状态的按值副本写成一个已闭合的 snapshot turn。继承消息保留原来的逻辑 `message.id`，只有 fork 中的 journal entry ID 是新生成的。

首次写入时，标题优先使用显式标题；否则使用第一条既不是 recovery、runtime context，也不是工具结果策略上下文的 user-role 消息，再折叠所有空白并截断为最多 80 个 JavaScript 字符。没有可用文本时使用 `Untitled session`。

### 生命周期与容错

- Agent journal 在任何模型 I/O 前写入 `turn_start`、本轮用户消息和所有有变化的 runtime-context 状态转换；完整 assistant 消息在其工具执行前写入，接受的 `todo_write` 会先写 `todo_state` 再写紧凑工具结果。其他工具结果同样在执行结束后独立写入，全部 sibling 结果写完后、下一次模型请求前再写入带来源的工具结果策略上下文。压缩 checkpoint 也在 adopt 前写入。终态 `turn_end` 写入后才运行 `onRunCommitted` 的 accounting/记忆等聚合后处理，随后发布 `agent_end`。手动 `/compact` 同样先写 checkpoint 再 adopt。`waitForIdle()` 不会早于这些写入和后处理完成。
- 加载发现未闭合 turn 时会直接修复原 JSONL：为每个没有结果的工具调用追加 `status: "unknown"` 的错误结果，明确禁止自动重试，再追加内部 recovery 用户消息和 `outcome: "interrupted"` 的 `turn_end`。若最后一行是未完成的 JSON，则只截断这条未终止尾记录；已完成行中的损坏仍报错。恢复具有幂等性，因此第二次加载不会再次追加。
- 恢复会重建 journal 中已提交的消息、最后一个 context checkpoint 和最新 todo 状态。Agent inbox 和未来 scheduled wake 仍只存在于当前进程：切换、分叉或恢复 session 以及退出 Kana 都会丢弃它们，不会在恢复时还原。
- 恢复会检查每个保留 artifact 是否位于该 session 的受管目录、是否为普通文件，以及大小是否与记录字节数一致。引用缺失或无效时记录安全诊断，但不会让 journal 无法读取，也不会修改其中的有界预览。
- fork 会在注册 snapshot 前把所有保留 artifact 复制到目标 session 的私有目录，再重写继承工具消息与累计 checkpoint 摘要中的 locator。因此源 session 与 fork 可以独立删除。复制或重写失败会中止 fork，并以 best-effort 回滚目标目录。
- 继续会话按当前工作目录查找；会话选择器同样只展示当前工作区的其他会话。
- `listKanaSessions()` 不限定 cwd 时会扫描所有工作区目录，并按 `createdAt` 降序排序。
- 列表读取到损坏 JSONL 时会跳过该文件，避免一条坏记录隐藏其他历史；显式加载该会话仍会报错。
- 删除按 session ID 找到文件并成功移除 journal 后，会以 best-effort 删除对应 artifact 目录；找不到返回 `false`。
- 普通模式启动时执行保守的孤儿清理，并保留 24 小时宽限期：删除没有对应 session journal 的陈旧 artifact 目录，以及其 JSON 编码 locator 不在已有 journal 中的陈旧文件。近期文件、被引用文件、符号链接、异常路径和清理失败不会被冒险删除，只会保留或报告。

会话文件用 `0600` 追加。文件格式中保存完整用户、助手和工具消息，包括内联结果或有界 artifact 元数据；不要把会话目录或 artifact 目录当作无敏感信息的日志位置。

## 记忆模型

记忆有两个 scope：

| Scope | 长期记忆 | 每日暂存 |
| --- | --- | --- |
| `global` | `<KANA_HOME>/memory/global/memory.md` | `<KANA_HOME>/memory/global/daily/YYYY-MM-DD.md` |
| `project` | `<KANA_HOME>/memory/projects/<encoded-workspace>/memory.md` | 同目录下的 `daily/YYYY-MM-DD.md` |

长期 `memory.md` 是会被注入系统提示词的压缩 Markdown；不存在时视为空。`saveKanaMemory` 会去除首尾空白、按 Unicode code point 检查 `memory.max_chars`，写入 UUID 临时文件后原子 `rename`，最终保证文件以一个换行结尾。

以 `--clean` 启动时，宿主不会读取全局或项目记忆，不提供 `remember`，也不会启动自动合并或允许通过 `/memory` 手动查看和合并。已有记忆文件不会被修改；Clean 模式也不允许恢复 session，当前临时会话的消息不会写入 session journal。

`remember` 不直接改写长期记忆。它默认 project scope，将非空内容（可选标题和原因）追加到当天的 Markdown 暂存文件：

```markdown
---
id: "mem_<uuid>"
created_at: "2026-06-22T12:00:00.000Z"
scope: "project"
title: "可选标题"
reason: "可选原因"
---

持久信息正文
```

元数据由宿主生成，字段值使用 JSON 字符串形式引用。日期使用进程本地日期而非 UTC 日期。每日文件的读取器会验证日期、scope、必需元数据和整个文件格式。

## 记忆合并

一次对话成功提交后，调度器从本轮 `remember` 的成功工具结果中按 scope 收集条目。每个 scope 的任务独立，但增量合并和手动全量合并会共享同一 scope 的 promise 队列串行运行，避免并发的读—改—写覆盖。

```text
remember 成功
  → 当天 daily 文件追加
  → Agent 本轮提交
  → scheduler 按 scope 收集条目
  → 增量合并 Agent
      读取当前 memory.md 和本批 daily 条目
      在内存 transaction 中 edit/replace
      正常 stop 且有改动时，原子保存 memory.md
```

合并 Agent 与主 Agent 使用同一模型配置，但没有 bash、文件工具或 `remember`。增量模式仅提供 `read_memory`、`edit_memory`、`replace_memory`，且输入只包含当前长期记忆和本批新条目。它不扫描历史 daily 文件，避免把未提供的上下文推断进记忆。

所有 edit/replace 先作用于内存 transaction；每次写入前检查大小限制。仅当 Agent 以 `stop` 正常结束且 transaction 有改动时才 `commit()`。中止、错误、长度截断、`turn_limit` 和未改动都不会覆盖长期记忆。

自动记忆合并属于进程持有的后台工作。TUI 或 headless 关闭时，host 会停止新的自动调度，取消并等待其创建过的全部 scheduler 中正在运行或排队的合并 Agent（包括模型重配后被替换的 scheduler），然后才关闭外部资源。`remember` 已写入 daily 暂存的条目会完整保留；被中止的内存 transaction 不会修改长期 `memory.md`。

## 全量压缩与保留

在 `/memory` 中选择 Compact 可运行全量合并。随后选择 Project、Global 或 Both，并可在独立输入框中填写额外要求。合并 Agent 会收到当前长期记忆和这段可选请求，并额外开放以下只读工具：

- `list_daily_memory`：按可选日期范围列出每日文件及条目数。
- `read_daily_memory`：读取指定日期的所有条目。
- `search_daily_memory`：不区分大小写检索标题、原因和正文，最多返回每一天三个摘要。

全量 Agent 仍只能通过 memory transaction 修改长期记忆。若该 scope 的合并以 `stop` 结束，且配置了 `memory.daily_retention_days`，Kana 才删除早于保留窗口的每日文件。保留窗口按本地日历日计算，例如 retention 为 3 且今天是 20 日时保留 18、19、20 日。删除只在成功的全量运行之后发生，确保即将过期的数据有机会被压缩进长期记忆。

## 用户可见命令

| 命令 | 行为 |
| --- | --- |
| `/memory` | 在底部依次选择 Show/Compact 和 Project/Global/Both；Compact 还会打开可为空的 request 输入。 |

`/memory` 不接受 editor 参数。选择流程中的 `Esc` 会返回上一步，request 输入支持 `Shift+Enter` 换行；压缩任务启动后可由 `Esc` 或 `Ctrl+C` 中止。完成提示会分别报告每个 scope 的 `updated`、`unchanged`、`aborted`、`length` 或 `error` 结果。

## 维护约束

- 记忆内容被视为数据而非指令；合并提示明确禁止执行其中的命令。
- 不应记录 secrets 或敏感个人数据。`remember` 的系统提示词只建议记录持久偏好、已确认决定和有长期价值的未完成工作。
- 不要手工破坏 daily 文件的 frontmatter 格式；一个损坏文件会在读取该日期时失败。
- 修改 session JSONL 或记忆格式时应同时更新解析器、存储测试和本文；这些文件是用户持久数据。
