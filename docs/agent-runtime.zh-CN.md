# Agent 运行时协议

Agent 是可复用、有状态的模型/工具控制器。它同一时间只持有一个 run，不了解 Kana session、TUI 组件、headless 输出、配置文件或本地持久路径。Kana 通过注入的模型、prompt assembly、工具、journal 回调与完成 hook 提供这些产品能力。

## 消息与身份

Agent 历史只使用三种 `Message` role：

| Role | 主要字段 | 用途 |
| --- | --- | --- |
| `user` | `id`、必填 `provenance`、`content`、可选 `images` | 人类、scheduled、recovery、summary、policy、Goal 或 runtime-context 输入。 |
| `assistant` | `id`、model-output provenance、有序 `content`、可选 `stopReason` 与 `usage` | 模型输出、本地工具调用和 provider-hosted action。 |
| `tool` | `id`、tool-result provenance、调用/名称身份、`content`、可选 images/artifact/result/error | 把一个规范化的本地或外部工具结果关联回原调用。 |

每条逻辑消息进入 Kana 或在内部生成时都会获得一个带品牌类型的 `MessageId`。克隆、inbox 移动、Agent event、journal 持久化与重放、fork 和模型历史都保留该 ID。它不同于 journal entry、run、turn、provider tool-call、Job 与 session 身份。Agent 历史和 inbox 都拒绝重复的逻辑消息 ID。

必填的可辨识 `provenance` 表明内容生产者或内部用途。消费者依据它判断语义，而不是把所有 `user` role 都视为人类输入。Runtime-context provenance 还会命名持有投影状态的稳定 source。

Assistant `content` 是一条有序数组；条目可以是 `thinking`、`text`、`tool_call` 或 provider-hosted `hosted_tool`，其顺序会用于 provider replay 与展示。Provider adapter 可以附加不透明、可 JSON 序列化的 `providerState`，但 core 与 Agent 不解释它。

## Stream 协议

Model 产生 `AssistantMessageEvent`。除终态外，每个增量事件都同时带 delta 与应用该增量后的完整 assistant-message snapshot：

```text
start
  → thinking_start / thinking_delta* / thinking_end
  → text_start / text_delta* / text_end
  → toolcall_start / toolcall_delta* / toolcall_end
  → hosted_tool_start / hosted_tool_update* / hosted_tool_end
  → done | error
```

并非每种内容都会出现。`done` 使用 `stop`、`length` 或 `toolUse`；`error` 使用 `aborted` 或 `error`。最终 stream result 包含带 stop reason 与 usage 的完整 assistant message。

Agent 把它翻译成更高层协议：

```text
agent_start
  → turn_start
  → message_start / message_update* / message_end
  → tool_execution_start / tool_execution_update* / tool_execution_end
  → turn_end
  → turn_input*（活动 run 接受排队输入时）
  → ...
  → agent_end
```

两种 stream 都支持 `for await` 与独立的 `result()` promise。Agent listener 和 stream consumer 获得彼此独立的事件副本；构造消息与 `Agent.state` 同样不共享内部可变历史。Listener 异常记录为 `agent.listener_failed`，不会终止 run。

## Prompt assembly 与 runtime context

`PromptAssembly` 分离稳定 system prefix、动态 context 和按 capability 持有的工具。构造后它保持不可变，但会在每次 model step 前解析所有 context 与 tool renderer。解析出的工具集合同时提供给该请求和对应的工具执行边界，因此只有后续 model step 能看到 capability 变化。

每个 runtime-context renderer 必须返回带稳定 source、明确且非空的 `active` 或 `inactive` 状态。初始就是 inactive 的 source 不产生消息；激活后，每次变化都会成为内部 user message，并与普通 run 输入一样遵循“先写入、后调用模型”；未变化状态不会重复。

Runtime-context 消息是权威状态，不是对话。稳定 system 指令只让每个 source 的最后一次转换生效。未压缩的 model projection 保留全部转换，因此无需重写更早的 provider-message prefix。Kana 当前为 environment、todo、Goal 与后台 Job 使用独立 source；Agent 协议不依赖这些产品 renderer。

`AgentConfig.promptAssembly` 不能与旧的 `system` 和 `tools` 输入组合。尚未采用动态 source 的嵌入方会把旧形式转换成单个不可变 assembly。

## Turn loop

`runAgentLoop` 持有 model-turn 状态机：

```text
复制输入 context 并发出 agent_start
在 maxTurns 范围内重复：
  拒绝已中止 signal
  发出 turn_start
  解析 prompt context 与工具
  提交有变化的 runtime-context 消息
  流式组装一条 assistant message
  模型失败或中止时发出 turn_end
  stopReason 为 toolUse 时执行本轮公开的调用
  提交结果与 policy context
  发出 turn_end
  提交并 claim 可用的 next-step 输入
  没有工具调用或已接受 turn input 需要下一轮时结束
发出 agent_end
```

独立 `Agent` 与 `runAgentLoop` 默认最多八个 turn。Kana 配置 `max_turns = -1` 表示不限；只接受 `-1` 或正整数。最后一个允许 turn 仍执行了工具时，run 以 `turn_limit` 结束。以 `length` 结束的消息不会执行工具；没有 assistant 内容的 provider 失败不会增加空消息；中止的部分 assistant 消息会保留安全的文本或 thinking，但移除未执行调用。

工具校验、审批、并发、deadline、事件时机、结果策略与内置行为归[工具与执行](tools.zh-CN.md)所有。Loop 会等待该边界，并且只用按模型顺序提交的结果开始下一 model step。

## Agent 生命周期与 inbox

`Agent.stream(input)` 异步启动工作；`prompt(input)` 等待同一 stream 的结果。同一时间只允许一个 run；并发尝试会得到错误 stream，`reset()` 只能在空闲时调用，`abort()` 则取消当前 run 的 `AbortController`。

Agent 持有一个内存 inbox，其中有两条 lane：

- `next-step` 保存可在活动 run 下一完整 turn 边界加入的 steering。
- `next-turn` 保存留给后续 run 的 FIFO 输入。

`steer(message)` 把原始带 ID 消息放入 `next-step`。仍能开始下一 turn 时，Agent 启动 journal commit，把该项保留到不可取消或清空的状态，按身份 claim，发出 `turn_input` 并返回 `consumed`。若 abort 或 turn limit 阻止下一 turn，未 claim 的 steering 会以同一 `MessageId` 移到 `next-turn` 尾部，并返回 `deferred`。

Agent 不会自行从 `next-turn` 启动新 run。Kana 的[对话运行时](conversation-runtime.zh-CN.md)观察并 drain 该 lane，添加 scheduled/Goal/Job delivery metadata，并发布前端队列快照，不会创建第二条队列。

`Agent.state` 暴露模型、已装配 system prompt 与工具、历史、inbox、当前运行状态、流式 assistant message、pending tool-call ID、context checkpoint 和最终错误的分离快照。`waitForIdle()` 覆盖 journal closure 与注入的后处理，不只等待 provider 和工具执行。

## 上下文预算与压缩

`ContextManager` 在每次模型请求前从完整 Agent 历史创建独立 model projection。压缩不会删除 Agent 的原始 `messages`；它只把 projection 中较旧部分替换为一份累计摘要与保留的近期消息。

Prompt budget 等于 effective context limit 减去有界安全预留，不会完整预留已配置的最大输出。每次请求时，manager 把配置/模型上限与剩余 prompt 空间中的较小值写入 `ModelContext.maxOutputTokens`；provider 决定该通用上限是否以及如何进入 wire 请求。

自动压缩在 prompt budget 的 80% 处启动。候选切分点只能位于安全消息边界：无调用的完整 assistant turn 之后，或一组 assistant tool call 的全部结果之后。Manager 从旧到新扫描，选择第一个能让“最大摘要占位 + 边界 active runtime state + 近期原始消息”进入 10% 目标的边界。没有安全边界但 prompt 尚能容纳时延后；无法安全恢复时失败。

Runtime-context 消息永不进入摘要策略输入。在 checkpoint 边界，每个 source 的最后状态只有仍 active 时才紧接摘要重新投影；边界后的全部转换保持原顺序。Tool-result policy context 仍是普通的可摘要对话上下文，除非其 provenance 合同另有定义。

注入的 `CompactPolicy` 生成实际摘要。Kana 用主 Agent 当前 Model 执行一次无工具 `generate()`，而不是启动另一个 Agent loop。输入包含上一份累计摘要与本次新覆盖消息；assistant thinking、assistant usage 和结构化 host result 被省略，模型可见的工具内容、错误与符合条件的视觉观察保留。响应必须以 `stop` 完成并进入摘要预算，否则继续使用此前 checkpoint。

图片观察遵循当前有效的模型与 Agent 图片策略。支持图片的请求会收到结构化图片和元数据，让摘要把视觉事实保留为文本；图片输入不受支持或被关闭时只接收 omission metadata，不带 base64，但压缩仍可完成。

Prompt 估算区分可重放 context 与 response 计费输入。不包含 provider-hosted tool 的响应可成为精确 `input_tokens` 锚点，后续持久消息只增加本地估算。Hosted-tool 响应不会替换锚点，因为临时 provider 内容可能计费却不在可重放历史中。恢复后的 Agent 会从当前 checkpoint 之后最新的已持久化干净 assistant 响应重建锚点；没有有效锚点时，对完整 projection 做本地估算，文本使用保守 UTF-8 估算，并加入协议/schema 开销和图片 patch 数量。

明确的 provider context-window 拒绝只可在任何 assistant 输出开始前触发一次强制压缩与重试；部分输出、第二次拒绝或没有安全切分点都会终止。手动 `/compact` 强制使用同一策略，不添加合成输入。两种情况下都只有注入的 commit hook 成功后才 adopt checkpoint。Checkpoint 记录与恢复规则归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

## 提交边界

可选 `AgentJournal` 把内存转换变成 write-before-use 合同：run 输入与有变化的 runtime context 在模型 I/O 前提交；完整 assistant 调用消息在工具执行前提交；工具结果按模型顺序进入历史；compaction checkpoint 在 adopt 前提交。精确 session record 顺序和中断修复归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

Journal 写入 run 终态后，`onRunCommitted` 执行 accounting 与自动记忆调度等产品聚合工作。只有 journal 与后处理都成功，listener 与 stream 才收到最终 `agent_end`。失败会拒绝 stream，不会提前发布成功；完整边界结算前 `isRunning` 一直为 true。

通用嵌入方可以省略 journal 与 commit hook；相同状态机随后完全保留在内存中。

## 扩展约束

- 复制或移动消息时保留 `MessageId` 与必填 provenance。
- 发出完整不可变快照，不暴露可变内部 message 或 event。
- 每个 model step 只解析一次动态 prompt state 与工具，并用同一工具集执行。
- Runtime context 只用于带明确 active/inactive 语义的权威变化状态。
- Compaction 切分点必须位于完整 assistant/tool-result 单元之后，避免 replay 出现孤立 call 或 result。
- 产品调度、持久路径和前端投影应留在可复用 Agent 层之外。
