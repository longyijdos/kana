# Agent 与工具执行协议

本文描述 Kana 从模型流到工具执行的通用运行时协议。它面向希望阅读、测试或扩展 `src/core`、`src/agent` 和 `src/tools` 的贡献者；产品级配置和审批规则见[配置与安装](configuration.md)。

## 三种历史消息

Agent 历史只使用三种 `Message`：

| 角色 | 主要字段 | 用途 |
| --- | --- | --- |
| `user` | `content: string`，可选 `source` | 用户输入；`source: "scheduled"` 表示由进程内定时器投递的内部输入。 |
| `assistant` | 有序 `content`、可选 `stopReason` 与 `usage` | 保存模型输出和它提出的工具调用。 |
| `tool` | `toolCallId`、`toolName`、`content`、`result`、`isError` | 将某一个工具调用的结果关联回模型。 |

助手消息的 `content` 是有序数组，而不是按类别分组。元素为 `text`、`thinking` 或 `tool_call`；每个流事件的 `contentIndex` 都指向这个数组。这使“思考 → 文本 → 工具调用”之类的交错输出能够原样回传供应商并按顺序渲染。

工具结果有两层：`content` 是给模型的文本，`result` 保留原始结构化值给 Agent、TUI 和持久化使用。工具直接返回普通值时，运行时会将字符串原样或将其他值 JSON 序列化为 `content`，同时把原值作为 `result`。

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
  流式读取助手消息，并把每个快照写入当前 context
  将可保留的助手消息加入新消息列表
  若模型错误或已中止，发出 turn_end 后结束
  仅当 stopReason = toolUse 时取出 tool_call 内容
  按出现顺序执行这些工具，并将结果加入 context 与新消息列表
  发出 turn_end
  若没有工具调用或执行要求中止，结束
发出 agent_end，返回本次新增消息
```

Kana 产品默认 `max_turns = -1`，但独立使用 `Agent`/`runAgentLoop` 时未提供配置的默认值是 8；公共 API 同样只接受 `-1` 或正整数。若最后一个允许的回合仍然执行了工具调用，运行以 `turn_limit` 结束，而不是误报为正常 `stop`。`runAgentLoop` 只负责模型回合状态机，并把工具调用交给独立 `ToolRuntime`。Runtime 按助手内容顺序划分执行组：只有相邻且显式声明 `parallel` 的调用会同组并行，`exclusive`、未声明、未知或元数据无效的工具都是屏障，不会被只读工作跨越。

只有助手消息以 `toolUse` 正常结束时，工具才会执行。长度截断的消息即使带有工具调用也不会执行。发生 provider error 且助手没有任何内容时，该空助手消息不会写入历史；中止的消息会移除其中未执行的工具调用，但若仍有文本或 thinking 内容则保留该部分。

## 上下文压缩

配置了 `ContextManager` 时，每次模型请求前先从完整 Agent 历史创建一个独立的 model projection；原始 `messages` 不会因压缩而删除。估算达到 prompt budget 的 80% 时触发压缩，规则从旧到新扫描，只允许在无 tool call 的完整 assistant turn 后，或一组 assistant tool calls 的所有 results 都已出现后切分。它选择第一个能让“最大摘要占位 + 近期原始消息”进入 10% 目标的边界，从而让一次压缩覆盖尽可能多的旧上下文；没有任何安全边界且尚未超过 prompt budget 时延后压缩，不能安全恢复时则报错。

实际摘要由注入的 `CompactPolicy` 生成。Kana 的产品策略直接使用主 Agent 的同一个 `Model` 做一次无工具 `generate()`，而不是启动另一个 Agent loop。输入是上一次摘要和本次新覆盖的消息；assistant thinking、assistant usage 和 tool 的结构化 `result` 不进入摘要请求，tool 的模型可见 `content`、名称及错误状态仍保留。摘要必须以 `stop` 完成且不超过摘要预算，失败会恢复上一个 checkpoint。

每条新工具结果的模型可见 `content` 统一限制为 `min(16000, max(256, floor(promptBudget × 25%)))` 个估算 token；超限时保留约 70% 头部和 30% 尾部并插入截断标记。宿主/TUI 使用的结构化 `result` 不受该限制。

provider 可把明确的 context-window 拒绝映射为 `ContextWindowExceededError`。仅当失败发生在任何助手输出之前，循环才强制执行同一套安全切分并重试当前模型请求一次；已经产生部分输出、第二次仍失败或没有安全边界时不会继续重试。压缩产生 `context_compaction_start` 和 `context_compacted` Agent events，生成摘要的 usage 随 checkpoint 提交。

空闲时执行 `/compact` 会立即以 `manual` 原因强制运行同一套压缩规则，不向消息历史插入伪造 prompt，也不调用主 Agent 的回复循环。摘要生成并持久化成功后，Agent 才 adopt 新 checkpoint；因此 JSONL 写入失败不会留下仅存在于内存的压缩状态。

## `Agent` 的生命周期

`Agent.stream(input)` 异步启动循环。配置 `AgentJournal` 时，它先持久化 run 边界和用户输入，再把输入加入内部历史并允许模型 I/O；没有 journal 的通用嵌入方式保持原有内存行为。它在任意时刻只允许一个活动运行；并发调用会得到错误流。`prompt(input)` 是等待 `stream(input).result()` 的便捷方法。

journal 的顺序是协议约束：完整 assistant 消息必须先持久化，随后才能执行其中引用的工具；每个工具结果完成后单独持久化；context checkpoint 在 adopt 前持久化；最后写入 run 终态。`onRunCommitted` 在 journal 已闭合后执行聚合后处理，不再承担 Kana 的 session 消息落盘。只有 journal 与后处理都成功，监听器和 stream 才会收到最终 `agent_end`。任一失败都会拒绝 stream，而不会先发布成功终态；整个阶段都属于 active run，因此 `isRunning` 保持 `true`，新运行被拒绝，`waitForIdle()` 继续等待。

运行期间，`Agent.state` 暴露：模型、系统提示词、工具、历史、`isRunning`、当前流式助手消息、尚未结束的工具调用 ID，以及最终错误。`abort()` 中止该运行的 `AbortController`；`reset()` 仅能在空闲时清空历史和运行状态。普通事件监听器属于 observer：每个监听器收到独立事件副本，监听器异常会记录为 `agent.listener_failed` 并与 Agent 执行隔离；能够控制工具执行的逻辑应使用 `beforeToolExecution`。

## 工具调用的前置与错误语义

每个调用按以下顺序处理：

1. 按名称查找工具；找不到时生成错误工具结果。
2. 深拷贝原始参数；TypeBox schema 先执行 `Value.Convert`，序列化后缺少 TypeBox 元数据的普通 JSON Schema 则补充兼容的基础类型转换，再使用编译缓存的 schema 校验。
3. 调用可选的 `beforeToolExecution` 钩子。Kana TUI 在此显示审批界面；即使执行组可并行，审批钩子也始终串行进入。
4. 检查中止信号，发出 `tool_execution_start`，为本次调用创建独立的 `AbortSignal`，再执行工具；可选 `execution.deadlineMs` 从这里开始计时。
5. 工具可调用 `context.update(partialResult)`；ToolRuntime 通过内部串行队列按调用顺序逐个发出更新，并在结束前等待监听器完成。
6. 规范化返回值，先提交 `ToolResultMessage`，再发出 `tool_execution_end`。因此外部观察者不会先看到一个尚未进入 journal 的成功结果。

参数校验失败和工具抛出的异常不会使循环本身抛出：它们成为 `isError: true` 的工具结果，模型能在下一回合看到失败原因。审批钩子返回 `cancel` 时默认中止整个运行，并为之后尚未执行的同消息工具补充“已取消”错误结果。中止发生在执行前也遵循同样的补全规则。

运行中止或工具 deadline 到期时，ToolRuntime 会中止调用级 signal，并等待固定且有限的取消宽限期。工具在宽限期内退出时，结果分别记录为 `canceled` 或 `timed_out`；无论工具随后返回还是抛错，都不会覆盖这个中止结果。若工具忽略 signal，runtime 会停止接收其 update，将持久化结果标记为 `status: "unknown"`，并终止当前 Agent run。该结果明确要求不得自动重试，因为脱离 runtime 的调用仍可能产生副作用；其迟到的完成只产生不含参数和结果的结构化诊断日志。deadline 与宽限期都使用正整数毫秒，未声明 deadline 的工具不受调用级时限限制。

并行组的工具事件仍通过同一串行事件队列发布。每个结果在实际完成时进入串行 commit 队列，先单独写入 journal，再发出对应的 `tool_execution_end`；下一轮模型按这一完成顺序接收工具结果，并用 `toolCallId` 与原始调用关联。组内任一调用要求中止 run 时，其余活动调用也会收到中止 signal；后续尚未开始的执行组只写入 canceled 结果。`list`、`glob`、`grep`、`read` 声明为 `parallel`；写入、Shell、记忆、调度以及未声明的第三方/MCP 工具默认 `exclusive`。

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

Manager 并行启动服务器，并按配置顺序聚合初始工具列表。include/exclude 按远端原名筛选；可选服务器失败只禁用该服务器，必需服务器失败会终止整体启动。远端普通 JSON Schema 会在工具注册前由 TypeBox 编译器预编译，单个服务器的所有工具以原子方式适配，不留下静默的部分工具集。模型看到的名字是由 server ID 和远端工具名组成的可读别名，例如 `github_create_issue`；名称符合当前 provider 的字符集要求且不超过 64 字符，内部调用仍使用原始 MCP 工具名。Manager 显式拒绝远端重名、清洗或截断后的重名以及本地工具冲突，不静默覆盖或按加载顺序追加后缀。

MCP 结果不会原样写入会话。适配器对内容项、文本、结构化 JSON 和元数据分别限长；text 与嵌入文本资源转换成模型文本，resource link 只描述 URI/MIME 而不自动读取，image、audio 和 blob 丢弃 base64 后只记录 MIME 与估算字节数，未知内容类型只记录类型名。`structuredContent` 在限制内保留结构，超限时只保留截断预览。远端进度通过 `context.update` 发出；MCP `isError` 作为工具执行错误返回，JSON-RPC error 则保存 code/message 等协议错误信息。

## 内置工具

| 工具 | 参数 | 行为与结果 |
| --- | --- | --- |
| `list` | 可选 `path`（默认 `.`）、`includeHidden`（默认 `true`）、`limit`（1–2000，默认 200） | 列出目录的一层子项，返回稳定排序的名称、路径、类型、大小、总数和 `truncated`。 |
| `glob` | `pattern`，可选 `cwd`（默认 `.`）、`type`、`maxDepth`、`includeHidden`（默认 `false`）、`limit`（1–2000，默认 200） | 用相对 glob pattern 查找路径，返回稳定排序的匹配项、总数和 `truncated`。pattern 不能是绝对路径，也不能包含 `..` 路径段。 |
| `grep` | `pattern`，可选 `path`（默认 `.`）、`include`、`literal`、`caseSensitive`、`includeHidden`、`limit`（1–2000，默认 100） | 用 JavaScript 正则或字面量搜索文本内容，返回匹配行、行列位置、搜索文件数和 `truncated`。目录搜索时 `include` 必须是相对 glob pattern。 |
| `read` | `path`，可选 `offset`（从 1 开始）、`limit`（1–2000，默认 200） | 读取 UTF-8 文本，返回行区间、总行数和 `truncated`。 |
| `write` | `path`、完整 `content`、可选 `overwrite` | 递归创建父目录，并默认以排他创建方式写入新文件；`overwrite: true` 会替换既有文件。返回 UTF-8 字节数。 |
| `edit` | `path`、非空 `oldText`、`newText`、可选 `replaceAll` | 对既有 UTF-8 文件做精确替换。默认要求恰好一次匹配；返回替换数、写入字节数及前后文本。 |
| `bash` | `command`，可选 `cwd`、`timeoutMs`（1–120000，默认 30000） | 用用户 shell 的 login command 模式执行，返回退出码、stdout、stderr、超时和截断状态。 |
| `remember` | `content`，可选 `scope`、`title`、`reason` | 向每日记忆记录持久信息，返回宿主生成的记忆条目。仅在记忆启用时注册。 |
| `schedule_wake` | `afterMinutes`（1–1440）、`message`，可选 `key` | 在当前 Kana 进程中安排一次后续 Agent 输入。相同 session 和 key 的新事件会替换旧事件；Kana 退出后事件丢失。 |

`bash` 的 stdin 始终断开；它把 `sudo` 定义为 `sudo -n`，避免密码提示占用 TUI。stdout/stderr 在运行期间约每 100ms 发送部分更新，最终每个流最多保留 20,000 个 JavaScript 字符。每次命令在独立进程组中运行；取消或超时会终止整组，避免后台子进程残留或继续占用输出流。顶层 shell 已退出时，工具会在短暂排空输出后返回，因此后台任务不会阻塞工具结果。超时的退出码记为 `null`，并将结果标为错误。

`list`、`glob`、`grep`、`read`、`write`、`edit` 和 `bash` 都会解析相对路径相对于工具的 `root`（Kana 中为启动时的工作目录），也接受绝对路径。它们不是工作区沙箱：相对路径可越出 root，符号链接可解析到外部，`bash.cwd`、`glob.cwd` 和 `grep.path` 也可在外部。请将审批理解为交互确认，而不是文件系统隔离。

`schedule_wake` 不写入磁盘，也不恢复未触发的事件。到期时若 Agent 正在运行，TUI 将事件排队，等当前运行结束后再开始新的回合；新建、分叉或恢复其他会话会取消旧会话尚未触发的事件。它不需要工具审批。

## 自定义工具的约束

- 在 TypeScript 中优先使用 TypeBox 1.x schema，以保留静态参数类型。运行时也接受 TypeBox schema 经 JSON 序列化后的普通 JSON Schema；这类 schema 会补充兼容的基础类型转换，再由 TypeBox 编译器校验。
- 返回可序列化的结构化 `result`，并提供简短、对模型有用的 `content`。
- 对可长时间运行的工具检查 `context.signal`，并用 `context.update` 提供进度。
- 让失败抛出有操作意义的 `Error`；循环会将其安全转换为模型可见的工具结果。
- 若工具会改变用户状态，需在产品装配层决定审批策略，并为 TUI 提供可理解的显示格式。
