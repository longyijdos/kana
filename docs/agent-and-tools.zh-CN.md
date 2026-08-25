# Agent 与工具执行协议

本文描述 Kana 从模型流到工具执行的通用运行时协议。它面向希望阅读、测试或扩展 `src/core`、`src/agent` 和 `src/tools` 的贡献者；产品级配置和审批规则见[配置与安装](configuration.zh-CN.md)。

## 三种历史消息

Agent 历史只使用三种 `Message`：

| 角色 | 主要字段 | 用途 |
| --- | --- | --- |
| `user` | `id`、必填 `provenance`、`content: string` | 直接输入、定时输入、恢复、运行时上下文、上下文摘要或压缩策略输入。 |
| `assistant` | `id`、`provenance: { kind: "model_output" }`、有序 `content`、可选 `stopReason` 与 `usage` | 保存模型输出和它提出的工具调用。 |
| `tool` | `id`、`provenance: { kind: "tool_result" }`、`toolCallId`、`toolName`、`content`、可选 `images`、`artifact`、`result`、`isError` | 将某一个文本或视觉工具结果关联回模型。 |

每条逻辑消息在进入 Kana 或由内部产生时只获得一个带品牌类型的 `MessageId`。深拷贝、steering、inbox lane 移动、Agent event、journal 持久化/重放、fork 和模型历史都保留该 ID。它与 journal entry ID、run/turn ID、provider tool-call ID 和 session ID 相互独立。必填的可辨识 `provenance` 记录内容生产者或内部用途；展示层依此判断语义，不会把所有 `user` role 消息都当成人类输入。`runtime_context` provenance 还包含 `environment` 之类的稳定 `source`，让不同 provider 可以比较和投影自己拥有的状态，而不必检查其它 provider 的内容。Agent 历史、inbox 和 session journal 都拒绝重复逻辑 ID。

助手消息的 `content` 是有序数组，而不是按类别分组。元素为 `text`、`thinking` 或 `tool_call`；每个流事件的 `contentIndex` 都指向这个数组。这使“思考 → 文本 → 工具调用”之类的交错输出能够原样回传供应商并按顺序渲染。

工具结果有两个主要层次：`content` 是给模型的文本，`result` 是实时 Agent/TUI 消费者使用的原始结构化值，并且只在安全时持久化。可选的 `artifact: { kind: "text", locator, byteLength }` 是消息外完整文本的有界展示元数据；与 provider 无关的 `images: UserImage[]` 则在文本之外携带原生视觉观察。工具直接返回普通值时，运行时会将字符串原样或将其他值 JSON 序列化为 `content`，同时把原值保留为实时 canonical `result`。

## 两层流事件

模型实现产生 `AssistantMessageEvent`。除 `done`/`error` 外，事件携带已经应用当前增量后的完整消息快照：

```text
start
  → thinking_start / thinking_delta* / thinking_end
  → text_start / text_delta* / text_end
  → toolcall_start / toolcall_delta* / toolcall_end
  → done | error
```

并非每种内容都必须出现。`done` 的原因是 `stop`、`length` 或 `toolUse`；`error` 的原因是 `aborted` 或 `error`。`AssistantEventStream.end()` 会把结束原因和用量写入最终助手消息，`error()` 则先发出错误事件，再拒绝 `result()`。

Agent 将它包装为应用级的 `AgentEvent`：

```text
agent_start
  → turn_start
  → message_start / message_update* / message_end
  → tool_execution_start / tool_execution_update* / tool_execution_end
  → turn_end
  → turn_input*（若当前 run 有待投递输入）
  → …（下一回合）
  → agent_end
```

两个流都可用 `for await` 消费实时事件，并可用 `result()` 等待最终结果。Agent 会为每个监听器和 stream 分别深拷贝公共事件，构造时传入的消息与对外 `state` 中的消息也不会共享内部可变对象。

## 回合循环

`runAgentLoop(context, config, emit)` 的逻辑如下：

```text
复制输入 context
发出 agent_start
重复（默认最多 8 回合；maxTurns = -1 时不限）：
  若 signal 已中止，结束
  发出 turn_start
  为本次模型调用解析 prompt assembly
  提交并追加有变化的明确 runtime-context 状态转换
  流式读取助手消息，并把每个快照写入当前 context
  将可保留的助手消息加入新消息列表
  若模型错误或已中止，发出 turn_end 后结束
  仅当 stopReason = toolUse 时取出 tool_call 内容
  按出现顺序执行这些工具，并将结果加入 context 与新消息列表
  发出 turn_end
  若执行要求中止，结束
  若还可开始下一回合，提交排队的 turn input，加入 context，并逐条发出 turn_input
  若既没有工具调用也没有 turn input，结束
发出 agent_end，返回本次新增消息
```

Kana 产品默认 `max_turns = -1`，但独立使用 `Agent`/`runAgentLoop` 时未提供配置的默认值是 8；公共 API 同样只接受 `-1` 或正整数。若最后一个允许的回合仍然执行了工具调用，运行以 `turn_limit` 结束，而不是误报为正常 `stop`。回合输入只在完整的 model/tool turn 结束并确认还能开始下一回合后消费；中止或 turn limit 会把它留给 Agent owner 降级处理。`runAgentLoop` 只负责模型回合状态机，并把工具调用交给独立 `ToolRuntime`。Prompt assembly 会在每次模型调用前解析 context 和 capability 自己管理的工具 section。解析出的工具会同时声明给该请求并交给对应 ToolRuntime；只有之后的模型步骤才能观察刷新后的集合。并行策略在每个 run 开始时解析一次：`AgentConfig.parallelToolCalls`（Kana 对应 `agent.parallel_tool_calls`）必须启用，且模型 metadata 的 `supportsParallelToolCalls` 必须为真；否则传给 provider 的 `ModelContext.parallelToolCalls` 为假，Runtime 也逐个执行调用。`AgentConfig.maxParallelToolCalls`（Kana 对应 `agent.max_parallel_tool_calls`）始终要求正整数，默认值为 4，但只在并行策略实际生效时参与调度。允许并行时，Runtime 按助手内容顺序划分执行组：只有相邻且显式声明 `parallel` 的调用会同组并行，`exclusive`、未声明、未知或元数据无效的工具都是屏障，不会被只读工作跨越。

只有助手消息以 `toolUse` 正常结束时，工具才会执行。长度截断的消息即使带有工具调用也不会执行。发生 provider error 且助手没有任何内容时，该空助手消息不会写入历史；中止的消息会移除其中未执行的工具调用，但若仍有文本或 thinking 内容则保留该部分。

## 上下文压缩

配置了 `ContextManager` 时，每次模型请求前先从完整 Agent 历史创建一个独立的 model projection；原始 `messages` 不会因压缩而删除。在两个 checkpoint 之间，该 projection 会保留所有 runtime-context 转换。稳定 system 协议只让每个 source 的最后一条消息生效，因此更新和 inactive 状态都能追加，而无需改写前面的模型消息前缀。Runtime-context 消息是权威状态而不是对话，因此不会进入摘要策略输入；在 checkpoint 边界处，只把该边界上每个 source 仍 active 的最后状态紧接摘要重新投影，边界后的全部转换则保持原顺序。prompt budget 是 context limit 扣除安全预留后的容量，不固定预留配置的最大输出。估算达到该预算的 80% 时触发压缩，规则从旧到新扫描，只允许在无 tool call 的完整 assistant turn 后，或一组 assistant tool calls 的所有 results 都已出现后切分。它选择第一个能让“最大摘要占位 + 边界 runtime 状态 + 近期原始消息”进入 10% 目标的边界，从而让一次压缩覆盖尽可能多的旧上下文；没有任何安全边界且尚未超过 prompt budget 时延后压缩，不能安全恢复时则报错。

prompt 估算会区分可重放上下文和单次 response 的计费用量。没有 provider-hosted tool 的响应完成后，manager 把 provider 返回的 `input_tokens` 保存为该请求的精确锚点，此后只为新提交的消息增加本地估算；包含 hosted tool 的响应不会替换锚点，因为托管搜索网页等临时 provider 内容可能计入本轮输入费用，却不存在于 Kana 可重放的历史中。下一次普通响应重新校准以前，Kana 只累计已持久化的 assistant 内容、hosted-call 元数据、客户端工具调用/结果和后续用户消息。新建、切换模型或刚完成压缩且没有锚点时，则对 model projection 做完整本地估算。恢复会话时会在内存中从最新一条已持久化的 assistant 响应重建锚点：该响应在历史中的位置作为 message count，其 provider `input_tokens` 作为锚点，因此只对该响应之后新提交的消息做本地估算。没有 usage 或包含 hosted tool 的响应会被跳过，早于当前压缩 checkpoint 记录的响应也会被拒绝（它们是在不同的 projection 下测量的）；没有有效锚点时仍回退到完整本地估算。文本采用偏保守的 UTF-8 字节估算，协议 envelope 使用固定开销，工具 schema/action 按 JSON 估算，图片按 patch 数量计算而不使用持久化 base64 大小。

manager 会把“配置的最大输出”和“prompt budget 减去估算输入后的剩余空间”中的较小值写入本轮 `ModelContext.maxOutputTokens`。Agent 只转发这个通用上限，具体 provider 决定是否以及如何映射到请求协议；Kana 的摘要策略则把摘要预算作为该次摘要请求的输出上限。

实际摘要由注入的 `CompactPolicy` 生成。Kana 的产品策略直接使用主 Agent 的同一个 `Model` 做一次无工具 `generate()`，而不是启动另一个 Agent loop。输入是上一次摘要和本次新覆盖的消息；assistant thinking、assistant usage 和 tool 的结构化 `result` 不进入摘要请求，tool 的模型可见 `content`、名称、错误状态及视觉观察仍保留。摘要必须以 `stop` 完成且不超过摘要预算，失败会恢复上一个 checkpoint。

每条新工具结果的模型可见 `content` 统一限制为 `min(16000, max(256, floor(promptBudget × 25%)))` 个估算 token，并以每个估算 token 三个 UTF-8 字节作为最终精确字节保护。Kana 默认 artifact 策略会先完整保存超大的非 `read` 内容，再生成约 70% 头部、30% 尾部的预览；取回 notice、精确省略字节数和 locator 都计入同一字节上限。顶层 `read` 结果只给出有界 notice，不会递归落盘；notice 会明确说明 offset/limit 按行分页，无法在单个超长行内翻页。canonical 结构化结果仍会出现在实时 `tool_execution_end` 事件中；过大、不可序列化或已由 artifact 承载的结构化数据即使在 artifact 保存失败时也不会进入持久消息。

provider 可把明确的 context-window 拒绝映射为 `ContextWindowExceededError`。仅当失败发生在任何助手输出之前，循环才强制执行同一套安全切分并重试当前模型请求一次；已经产生部分输出、第二次仍失败或没有安全边界时不会继续重试。压缩产生 `context_compaction_start` 和 `context_compacted` Agent events，生成摘要的 usage 随 checkpoint 提交。

空闲时执行 `/compact` 会立即以 `manual` 原因强制运行同一套压缩规则，不向消息历史插入伪造 prompt，也不调用主 Agent 的回复循环。摘要生成并持久化成功后，Agent 才 adopt 新 checkpoint；因此 JSONL 写入失败不会留下仅存在于内存的压缩状态。

## `Agent` 的生命周期

`Agent.stream(input)` 异步启动循环。`AgentConfig.promptAssembly` 不能与旧的 `system`/`tools` 输入同时使用；为兼容旧调用，这两个输入会转换成单个不可变 assembly。每个已配置的 context renderer 都必须返回明确且非空的 active 或 inactive 状态。初始就是 inactive 的 source 不写消息；激活后，有变化的状态和 run 输入一样遵循“先写入、后调用模型”的规则。没有 journal 的通用嵌入方式保持内存行为。Agent 在任意时刻只允许一个活动运行；并发调用会得到错误流。`prompt(input)` 是等待 `stream(input).result()` 的便捷方法。

Agent 持有一个仅存在于内存的 inbox，其中有 `next-step` 和 `next-turn` 两条 lane。活动 run 的 `steer(userMessage)` 把原始带 ID 消息放入 `next-step`；下一个可用 turn 边界先写 journal，再按 MessageId claim，随后发出 `turn_input` 并返回 `consumed`。journal commit 一旦开始，该项会保持 reservation，不能被取消或 inbox clear 删除，直到按身份校验的 claim 完成，因此 shutdown 不会让 durable input 与实际 claim 的消息错位。中止或 turn limit 会把未 claim 的 steering 移到 `next-turn` 尾部，不更换 ID，并返回 `deferred`。Tab 后续输入和到期定时消息直接进入 `next-turn`。`ConversationRuntime` 只编排该 lane 何时可启动新 run，并发布只读前端快照，不再生成第二套队列身份。

journal 的顺序是协议约束：完整 assistant 消息必须先持久化，随后才能执行其中引用的工具；串行工具结果在完成后持久化，并行组结果则在对应槽位就绪后按模型调用顺序持久化；context checkpoint 在 adopt 前持久化；最后写入 run 终态。`onRunCommitted` 在 journal 已闭合后执行聚合后处理，不再承担 Kana 的 session 消息落盘。只有 journal 与后处理都成功，监听器和 stream 才会收到最终 `agent_end`。任一失败都会拒绝 stream，而不会先发布成功终态；整个阶段都属于 active run，因此 `isRunning` 保持 `true`，新运行被拒绝，`waitForIdle()` 继续等待。

运行期间，`Agent.state` 暴露：模型、系统提示词、工具、历史、inbox 快照、`isRunning`、当前流式助手消息、尚未结束的工具调用 ID，以及最终错误。`abort()` 中止该运行的 `AbortController`；`reset()` 仅能在空闲时清空历史、inbox 和运行状态。普通事件监听器属于 observer：每个监听器收到独立事件副本，监听器异常会记录为 `agent.listener_failed` 并与 Agent 执行隔离；能够控制工具执行的逻辑应使用 `beforeToolExecution`。

## 工具调用的前置与错误语义

每个调用按以下顺序处理：

1. 按名称查找工具；找不到时生成错误工具结果。
2. 深拷贝原始参数；TypeBox schema 先执行 `Value.Convert`，序列化后缺少 TypeBox 元数据的普通 JSON Schema 则补充兼容的基础类型转换，再使用编译缓存的 schema 校验。
3. 调用可选的 `beforeToolExecution` 钩子。Kana TUI 在此显示审批界面；即使执行组可并行，审批钩子也始终串行进入。
4. 检查中止信号，发出 `tool_execution_start`，为本次调用创建独立的 `AbortSignal`，再执行工具；本次调用的有效 deadline 从这里开始计时。
5. 工具可调用 `context.update(partialResult)`；ToolRuntime 通过内部串行队列按调用顺序逐个发出更新，并在结束前等待监听器完成。
6. 规范化返回值，为物理终态发出 `tool_execution_end`，再把该终态交给执行组协调器按序提交结果。这个事件不表示结果已经持久化；成功的 run 终态才提供该保证。

参数校验失败和工具抛出的异常不会使循环本身抛出：它们成为 `isError: true` 的工具结果，模型能在下一回合看到失败原因。审批钩子返回 `cancel` 时默认中止整个运行，并为之后尚未执行的同消息工具补充“已取消”错误结果。中止发生在执行前也遵循同样的补全规则。

Kana 自有的内置工具 schema 声明 `additionalProperties: false`，因此未在工具 schema 中声明的参数会直接校验失败，错误信息会指明该意外参数，而不会被静默忽略。外部工具与 MCP 工具 schema 保持各自声明的 `additionalProperties` 行为。

### 工具结果策略

通用 Agent 层接受一个可选的外部 `ToolResultPolicy`，并可与精确重复检测等产品无关策略组合。每个结果规范化为 `ToolResult` 后，ToolRuntime 会按顺序调用各策略；成功、未知工具、参数错误、审批拒绝、取消、超时和异常都遵循同一路径。策略收到模型原始调用的深拷贝只读视图、当前给模型的 `content`、错误状态、可克隆结构化结果的 JSON 字节数和当前内容字节上限；任意的 host 结构化 `result` 本身不进入这个建议边界。策略可以替换文本、追加带来源的内部上下文、单向关闭 `result` 持久化，或附加一个通过校验的 artifact 引用；不能改写工具身份、参数、实时 canonical 结果或错误状态。策略抛错或返回非法值时只产生安全诊断，并保留此前 pipeline 状态。验证后的输出会在离开 containment 前复制为普通内部快照，因此 getter、Proxy、稀疏数组或后续修改都不能逃逸到结果提交阶段。

结果顺序继续满足 provider 协议：同一 assistant 消息的全部 sibling 工具结果先按模型顺序提交，之后才提交带 `provenance.kind: "tool_result_policy"` 的策略上下文，再开始下一次模型请求。每个 Agent 都拥有独立的策略实例及其状态。内置精确重复策略以“工具名 + 深度规范化 JSON 参数”为 key，因此对象键顺序无关、数组顺序仍有意义。它会统计审批拒绝和失败结果，把配置排除项视为透明调用，在不同的未排除调用或已接受的人类输入处重置，并且只在配置的精确阈值上插入建议而不阻止调用。`AgentConfig.repeatedToolCalls` 启用这项通用策略；Kana 只负责把产品 TOML 配置映射到该通用配置。

运行中止或工具 deadline 到期时，ToolRuntime 会中止调用级 signal，并等待固定且有限的取消宽限期。在并行组中，这个决定会先立即停止 pool 补充并中止活动 sibling，再等待触发调用 drain；排队调用不会启动，而是得到 canceled 结果。工具在宽限期内退出时，结果分别记录为 `canceled` 或 `timed_out`；无论工具随后返回还是抛错，都不会覆盖这个中止结果。若工具忽略 signal，runtime 会停止接收其 update，将持久化结果标记为 `status: "unknown"`，并终止当前 Agent run。该结果明确要求不得自动重试，因为脱离 runtime 的调用仍可能产生副作用；其迟到的完成只产生不含参数和结果的结构化诊断日志。deadline 与宽限期都使用正整数毫秒。工具的 `execution.deadlineMs` 优先；未声明时使用 Agent 默认值。框架默认是 300000 毫秒，Kana 产品默认是 660000 毫秒，并可通过 `agent.tool_deadline_ms` 覆盖。

相邻并行组通过有界滚动池运行。调用按模型顺序领取并进入串行审批，同时在途的调用 body 不超过 `maxParallelToolCalls`。每个 start、partial update 和终态事件仍以 `toolCallId` 关联；`tool_execution_end` 跟随物理完成，因此后面的快速调用可以早于前面的慢调用显示完成。持久化提交则独立等待按模型顺序排列的结果槽位，使 session 历史与下一次模型请求都保持确定顺序。助手工具调用消息在执行前已经持久化，因此进程若在实时终态与结果提交之间退出，恢复时会把该调用记为 `unknown`，而不会自动重试。run abort 或内部调度失败会停止补充并中止活动 sibling；已启动调用被 drain 到明确终态或 unknown，尚未启动的调用得到 canceled 结果。池的开始、结束和异常 drain 诊断只包含聚合计数。`list`、`glob`、`grep`、`read`、`view_image` 声明为 `parallel`；写入、Shell、记忆、调度以及未声明的第三方/MCP 工具默认 `exclusive`。

工具接口为：

```ts
type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  execution?: {
    concurrency?: "parallel" | "exclusive";
    deadlineMs?: number;
  };
  execute(args, context): ToolResult | unknown | Promise<ToolResult | unknown>;
};

type ToolContext = {
  toolCallId: string;
  // ToolRuntime 始终提供调用级 signal；直接调用 Tool.execute 的嵌入方可省略。
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};
```

## MCP 工具管理与适配

TUI 启动时从 `mcp.json` 读取服务器定义，从 `mcp-enabled.json` 读取选中的 ID，但会等当前会话显示后再启动 stdio manager；只有同时存在于两个文件的 ID 才会创建 registration。Kana 随后把发现的远端工具作为 `additionalTools` 注入重建后的主 Agent。`kana resume` 的会话选择器不会提前启动 MCP；`/new`、`/fork`、`/resume` 和 Skills 刷新后续重建 Agent 时会复用当前活动工具集合。`/mcp` 可以显式替换该集合，并在保留消息的同时重建空闲 Agent。记忆压缩 Agent 不经过这条工厂，因此不会获得 MCP 工具。manager 保留暴露别名到 server ID/远端原名的来源映射，产品层只在审批展示时解析它。`McpManager` 只要求 client 实现 `connect/listTools/callTool/close`，工具适配器只要求 `McpToolCaller`；稳定版 stdio client 和后续无状态、Streamable HTTP 或 SSE client 可以继续共用管理、进度和工具边界。

面向产品的 `KanaMcpRuntime` 负责替换 manager，并串行执行生命周期操作。reload 会先关闭旧 manager，再读取最新文件并创建新 manager；即使替换失败，也会清空旧工具及其审批来源。TUI 在会话选定后调用 start，在用户应用有变化的 `/mcp` 草稿后调用 reload，并在退出时调用 close。reload 失败后会用无过期 MCP 工具的状态重建 Agent 并恢复输入，同时让底层 manager 继续保持一次性。

Manager 并行启动服务器，并按配置顺序聚合初始工具列表；每个服务器完成时的进度事件都包含结果和过滤后的工具数。include/exclude 按远端原名筛选；可选服务器失败只禁用该服务器，必需服务器失败会终止整体启动。远端普通 JSON Schema 会在工具注册前由 TypeBox 编译器预编译，单个服务器的所有工具以原子方式适配，不留下静默的部分工具集。模型看到的名字是由 server ID 和远端工具名组成的可读别名，例如 `github_create_issue`；名称符合当前 provider 的字符集要求且不超过 64 字符，内部调用仍使用原始 MCP 工具名。Manager 显式拒绝远端重名、清洗或截断后的重名以及本地工具冲突，不静默覆盖或按加载顺序追加后缀。

MCP 结果不会原样写入会话。适配器对内容项、文本、结构化 JSON 和元数据分别限长；text 与嵌入文本资源转换成模型文本，resource link 只描述 URI/MIME 而不自动读取，image、audio 和 blob 丢弃 base64 后只记录 MIME 与估算字节数，未知内容类型只记录类型名。`structuredContent` 在限制内保留结构，超限时只保留截断预览。远端进度通过 `context.update` 发出；MCP `isError` 作为工具执行错误返回，JSON-RPC error 则保存 code/message 等协议错误信息。

## 内置工具

| 工具 | 参数 | 行为与结果 |
| --- | --- | --- |
| `list` | 可选 `path`（默认 `.`）、`includeHidden`（默认 `true`）、`limit`（1–2000，默认 200） | 列出目录的一层子项，返回稳定排序的名称、路径、类型、大小、总数和 `truncated`。 |
| `glob` | `pattern`，可选 `cwd`（默认 `.`）、`type`、`maxDepth`、`includeHidden`（默认 `false`）、`limit`（1–2000，默认 200） | 用相对 glob pattern 查找路径，返回稳定排序的匹配项、总数和 `truncated`。pattern 不能是绝对路径，也不能包含 `..` 路径段。 |
| `grep` | `pattern`，可选 `path`（默认 `.`）、`include`、`literal`、`caseSensitive`、`includeHidden`、`limit`（1–2000，默认 100） | 用 JavaScript 正则或字面量搜索文本内容，返回匹配行、行列位置、搜索文件数和 `truncated`。目录搜索时 `include` 必须是相对 glob pattern。 |
| `read` | `path`，可选 `offset`（从 1 开始）、`limit`（1–2000，默认 200） | 读取 UTF-8 文本，返回行区间、总行数和 `truncated`。 |
| `view_image` | `path` | 加载并规范化本地图片，返回确定的路径、格式、尺寸与字节元数据，并把图片作为视觉观察交给同一个活动模型。仅当该模型支持图片且 `image_input` 已启用时注册。 |
| `write` | `path`、完整 `content`、可选 `overwrite` | 递归创建父目录，并默认以排他创建方式写入新文件；`overwrite: true` 会替换既有文件。返回 UTF-8 字节数。 |
| `edit` | `path`、非空 `oldText`、`newText`、可选 `replaceAll` | 对既有 UTF-8 文件做精确替换。默认要求恰好一次匹配；返回替换数、写入字节数及前后文本。 |
| `bash` | `command`，可选 `cwd`、`timeoutMs`（1–600000）和 `background`（默认 `false`） | 前台执行默认 30000 ms 超时，并返回完整的最终 stdout/stderr。`background: true` 默认不设超时，并立即返回当前 session 所有的 Job ID。 |
| `job_list` | 无 | 列出当前 session 所有的活动 Job 和最多 32 个近期终态 Job。读取终态条目会确认其完成通知。 |
| `job_output` | `jobId`，可选 `waitMs`（0–30000，默认 0） | 从 Agent 游标一次性消费全部尚未读取的保留输出。它可以等待输出或终态而不停止 Job，并明确报告已丢弃字节数。 |
| `job_kill` | `jobId`，可选 `reason` | 停止属于当前 session 的指定 Job，等待其进程组静止，并返回终态。 |
| `todo_write` | 完整 `items` 数组；每项包含非空 `content` 与 `pending`、`in_progress` 或 `completed` 状态 | 为多步骤工作原子替换当前 session 的 todo 列表。最多一项可为 `in_progress`；空数组显式清空列表。模型可见结果是固定的紧凑确认。 |
| `remember` | `content`，可选 `scope`、`title`、`reason` | 向每日记忆记录持久信息，返回宿主生成的记忆条目。仅在记忆启用时注册。 |
| `schedule_wake` | `afterMinutes`（1–1440）、`message`，可选 `key` | 在当前 Kana 进程中安排一次后续 Agent 输入。相同 session 和 key 的新事件会替换旧事件；Kana 退出后事件丢失。 |

`bash` 的 stdin 始终断开；它把 `sudo` 定义为 `sudo -n`，避免密码提示占用 TUI。前台执行期间 stdout/stderr 约每 100ms 发送部分更新；每个实时快照是每个流最多 20,000 个 JavaScript 字符的有界尾部窗口，长命令展示的是最新输出而不是输出开头。完整的最终输出随后进入统一结果策略，由该策略先按需保存 artifact，再限制模型可见内容和持久化结构化数据。每次命令在独立进程组中运行。前台执行等待整个进程组，而不只是顶层 shell，因此裸 `command &` 不再逃逸：默认或显式超时会终止整组。显式创建另一个进程 session 的 daemon 化仍可能越过 Kana 的进程组边界。非 0 退出码表示命令本身的执行结果，不会将工具结果的 `isError` 标记为 true；超时的退出码记为 `null`，并将结果标为错误。

通用 `BackgroundJobManager` 和 Job 工具不依赖 Kana 的 Agent 构造，其他 host 也可以自行装配。owner 把 Job 绑定到一个 session 实例，执行其并发上限，并在 owner dispose 时移除全部 Job。Job metadata 只保存经过空白规范化、最多 512 UTF-8 字节的 label；原始 Bash command 仍保留在 tool call 中。每个 Job 在内存中只保留最新 1 MiB stdout/stderr。`job_output` 在一次调用中从隐式 Agent 游标消费全部尚未读取的保留输出，因此已完成的 Job 最多只需读取一次；`hasMore` 仅在仍有新输出产生时为 true，`droppedBytes` 表示尚未消费就从环形缓冲区淘汰的数据。过大的模型可见输出由共享的 result policy 限界。TUI 预览使用独立的非消费尾部窗口，最多 20 KiB。manager 为每个 owner 最多保留 32 个终态 Job，并裁剪最旧条目；Job manager 状态和保留的输出 buffer 不会持久化，进程退出后也不会恢复。

Kana 在通用层之上增加 runtime context、完成投递、session 清理和 TUI 管理。Runtime context 只包含活动或尚未报告 Job 的身份、有界命令标签、cwd、状态与退出码，从不包含输出；只有状态变化时，Agent 才新增一条 runtime-context 消息。Agent run 活动时，完成事件进入 `next-step`；空闲时进入 `next-turn`，相邻的待处理完成事件会合并到一个 run 中，但不会跨过其他已排队输入。普通输出不会唤醒 Agent，因此持续运行的开发服务器不会反复 wake。通过 `job_list`、`job_output` 或 `/jobs` 观察终态 Job 会确认它，并取消仍在队列中的完成输入。切换 session 和正常退出会先停止所属进程组，再关闭 MCP 等后续 host 资源；强制的第二次中断可能绕过该清理。

`list`、`glob`、`grep`、`read`、`view_image`、`write`、`edit` 和 `bash` 都会解析相对路径相对于工具的 `root`（Kana 中为启动时的工作目录），也接受绝对路径。它们不是工作区沙箱：相对路径可越出 root，符号链接可解析到外部，`bash.cwd`、`glob.cwd` 和 `grep.path` 也可在外部。`view_image` 与用户附件共用同一解码器和规范化限制；GIF 等动画图片以解码后的首帧表示，并规范化为静态 PNG。请将审批理解为交互确认，而不是文件系统隔离。

`todo_write` 会 trim 每项内容，拒绝 trim 后为空或重复的内容、未知字段，并保证校验失败时不部分修改状态。接受后的状态归当前 session 所有且持久保存；新 human turn 和全部为 `completed` 都不会自动清空。即使发生 context compaction、resume 或 fork，最新完整列表仍会投影到模型的 runtime context，而工具确认文本不随列表长度增长。只有显式传入空数组才清空当前状态；历史接受快照仍关联在原工具调用上。该工具以 exclusive 模式执行且不请求审批。

`schedule_wake` 不写入磁盘，也不恢复未投递事件。进程内 scheduler 提供按到期时间排序的 list，并使用该未来输入本身的 `MessageId` 取消。timer 到期后，同一个 ID 进入 Agent 的 `next-turn` lane，最终进入已提交历史；不会再创建 wake/queue correlation ID。`/schedule` 将 Agent 创建的事件标为 `agent`，将用户在面板中添加的事件标为 `you`，但不显示 Agent 用于替换事件的 key。到期时若 Agent 正在运行，inbox 会把它排在更早的 next-turn 输入之后，等当前 `agent_end` 后按顺序开始新 run。定时管理面板活动时只暂停 pending run 的启动，不暂停 timer；关闭面板后恢复投递。新建、分叉或恢复其他会话会清空旧会话的未来 wake 和 pending inbox，退出也一样。它不需要工具审批。

## 自定义工具的约束

- 在 TypeScript 中优先使用 TypeBox 1.x schema，以保留静态参数类型。运行时也接受 TypeBox schema 经 JSON 序列化后的普通 JSON Schema；这类 schema 会补充兼容的基础类型转换，再由 TypeBox 编译器校验。
- 在对象参数 schema 上声明 `additionalProperties: false`，让未知模型参数直接校验失败，而不是被静默忽略。
- 返回可序列化的结构化 `result`，并提供简短、对模型有用的 `content`。可选 `images` 必须是 `UserImage[]`，可选 `isError` 必须是布尔值；字段格式错误时，本次调用会在任何消息提交前转成安全的工具失败。
- 对可长时间运行的工具检查 `context.signal`，并用 `context.update` 提供进度。
- 让失败抛出有操作意义的 `Error`；循环会将其安全转换为模型可见的工具结果。
- 若工具会改变用户状态，需在产品装配层决定审批策略，并为 TUI 提供可理解的显示格式。
