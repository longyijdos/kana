# Kana 架构总览

Kana 是一个以 Bun 运行的终端通用 Agent。它将模型调用、工具执行和本地状态持久化放在同一进程中，可通过自研 TUI 交互，也可在无头模式下执行一次完整任务。本文描述当前实现的运行边界和模块关系，帮助新贡献者从入口一路定位到具体职责。

## 分层与依赖方向

```text
src/main.ts
  ├─ cli                 命令解析；启动、恢复会话、安装与更新
  ├─ headless            单次执行、JSONL 投影和非交互审批 ─┐
  └─ tui                 终端交互、渲染和用户审批 ─────────┴→ kana
                                                            产品装配：配置、提示词、会话、记忆、Skills
                                                              ├─ logging  日志协议与会话级 JSONL 基础设施
                                                              ├─ oauth    通用 OAuth 发现、PKCE、callback、token 与 refresh 状态机
                                                              ├─ mcp      MCP JSON-RPC 连接、协议客户端与传输
                                                              ├─ agent    模型—工具循环和事件协议转换
                                                              ├─ tools    可复用的文件与 Shell 工具
                                                              ├─ core     消息、模型、工具、事件流和用量的共享协议
                                                              ├─ utils    基于 core 图片协议的图片输入规范化
                                                              └─ providers
                                                                  ├─ responses     共享 Responses 语义 SSE 组装
                                                                  ├─ openai-compatible  共享 Chat Completions 适配
                                                                  ├─ deepseek      DeepSeek Responses 请求与流式适配
                                                                  └─ openai-codex  Codex Responses、OAuth 凭据和流式适配
```

`core` 是最内层的协议包，不依赖其他顶层源码模块。Provider-facing 的 `ToolSpec`、可复用的 `EventStream` 和 `ModelUsage` 协议属于该层；`tools` 中可执行的 `Tool` 在此基础上增加执行函数。`utils` 负责基于 Bun 的图片加载与规范化，并且只依赖 `core` 中的图片协议。`logging` 是同时提供日志协议、空实现和会话级 JSONL 实现的基础设施模块。`agent` 依赖 `core`、`tools` 以及 `logging` 中的协议和空实现，但不知道日志路径或产品配置，因此可在没有终端界面的情况下运行；具体 session logger 由 Kana 产品层装配。`oauth` 是不感知 MCP、供应商或前端的通用 Authorization Code + PKCE 和 token 生命周期模块；`mcp` 在其上增加 protected-resource discovery 与 Bearer challenge 语义，但仍不依赖 Kana 产品装配或 Agent loop。`kana` 是将这些通用部件变成 Kana 产品的装配层；它从当前工作目录和 `~/.kana`（或 `KANA_HOME`）读取状态。`tui` 与 `headless` 共享该装配层，且都不直接实现模型协议或持久化格式。

顶层源码模块之间允许的直接依赖是显式的：

| 来源 | 可以导入 |
| --- | --- |
| `main.ts` | `cli`、`headless`、`kana`、`tui` |
| `cli` | `headless`、`kana`、`oauth`、`tui`、`version.ts` |
| `tui` | `agent`、`core`、`jobs`、`kana`、`logging`、`mcp`、`tools`、`utils`、`version.ts` |
| `headless` | `agent`、`core`、`kana`、`logging`、`mcp` |
| `kana` | `agent`、`core`、`jobs`、`logging`、`mcp`、`oauth`、`providers`、`tools`、`version.ts` |
| `agent` | `core`、`logging`、`tools` |
| `providers` | `core`、`logging` |
| `mcp` | `oauth`、`tools` |
| `tools` | `core`、`jobs`、`utils` |
| `utils` | `core` |
| `jobs` | `logging` |
| `oauth`、`logging`、`core`、`version.ts` | 不依赖其他顶层源码模块 |

`bun run check:architecture` 已包含在 `bun run check` 中，会对运行时依赖和 type-only 依赖执行该表。一个顶层源码模块内部必须使用相对导入；跨顶层模块必须使用目标 barrel，例如 `@/core`，不能使用深层 alias 路径。检查会拒绝表外依赖，并分别检测纯运行时文件环和只有加入类型依赖后才闭合的文件环。

这种分层也说明了新增代码应放在哪里：新增供应商放 `providers`，可复用的执行能力放 `tools`，循环控制放 `agent`，Kana 的默认策略和本地状态放 `kana`，交互呈现放 `tui`。

Kana 产品层内部按领域提供稳定 barrel。`config/` 管理配置契约与默认值、解析与校验、生成参考内容、持久化生命周期以及可变 store；配置默认值只在这里解析一次，再注入消费方，会话 runtime 不维护自己的配置 fallback。共享的 `KANA_HOME` 布局保留在 `kana/path.ts`，因为 session、artifact、accounting、log、memory、Skills、MCP、认证和配置持久化都会使用它。`auth/` 管理产品凭据与 token 存储，`mcp/` 管理外部工具配置和生命周期，`conversation/` 管理前端共享的会话运行时与 wake scheduler，`session/` 管理持久化，`memory/` 和 `skills/` 管理长期状态，`tools/` 管理 Kana 专属工具，`update/` 隔离自更新。领域内部使用相对导入，跨顶层调用方仍统一经过 `@/kana`。

`tests/` 按主要源码领域组织为 `agent/`、`core/`、`kana/`、`mcp/`、`oauth/`、`providers/`、`tools/` 和 `tui/` 等目录；Kana 与 Provider 测试继续按其内部领域细分。跨模块集成测试放在主要行为所有者的目录，非测试输入继续集中在 `tests/fixtures/`。Bun 会递归发现这些 `*.test.ts` 文件。

## 启动路径

`src/main.ts` 调用 `runCli`。CLI 支持以下主要路径：

- `kana [--clean] [prompt...]`：启动 TUI；有参数时启动后立即发送该提示词。
- `kana resume [sessionId]`：按 ID 恢复会话，或打开会话选择器。
- `kana exec [--clean] [--goal] [--timeout <duration>] [prompt...]` / `kana exec resume <sessionId> [prompt...]`：不启动 TUI，执行一次完整 Agent 任务后退出；`--goal` 会允许有界的连续 Agent run，`--json` 则输出版本化 JSONL 事件。
- `kana install`：幂等补齐缺失的本地状态并刷新生成的配置参考，不物化默认 `config.toml`，也不安装 Skills 仓库。
- `kana update [--check]`：检查最新正式 Release；省略 `--check` 时验证候选二进制并原子替换当前 direct-distribution 独立二进制。
- `kana reset [--yes]`：经确认删除 `config.toml`，刷新配置参考并重置 MCP、审批和 Skill 启用状态，同时保留凭据、用户数据、日志、指令和实际 Skills。
- `kana auth login|status|logout openai-codex`：管理 Codex 浏览器 OAuth 与本地凭据。
- `kana skills install|reinstall [--yes]`：安全安装/更新默认 Skills Git 仓库，或经确认删除后重新 clone。
- `kana skills sync|resync <target> [--yes]`：把已安装的 Kana Skills 复制到其它 agent 的 Skills 目录；sync 跳过同名项，resync 经确认替换同名项，但不清理其它或过期 Skill。

启动入口把 `normal | clean` 模式显式传给前端与 `KanaConversationHost`，Host 再把它传给每次创建或重建的 Agent。TUI 和 Headless 会拒绝 clean 与 resume 的组合，Host 继续保留相同不变量。Clean 模式不通过替换 `KANA_HOME` 或清空进程环境模拟隔离，因此仍读取 `.env`、运行配置、认证和审批；但它在 Host 边界为 session journal、session logger 和 accounting 关闭持久化，并在 Agent 装配边界关闭 AGENTS、memory、Skills 和 MCP。

自更新由 `kana/update/self-update.ts` 隔离在产品层，不进入 TUI 或 Agent 生命周期。它通过 GitHub Release API 取得版本、平台资产及 SHA-256 digest，把下载写入当前可执行文件的同目录临时路径，校验大小与 digest，并让候选程序执行 `--version` 和幂等初始化。替换前会再次比较目标文件的 device、inode、mtime 和大小，避免覆盖下载期间由其它安装进程写入的新版本；最终 rename 是 POSIX 同文件系统的原子目录项替换。源码运行默认标记为 `source` 并拒绝更新，所有可直接安装的编译入口在构建期注入 `direct` 标记，防止把 Bun runtime 误判为更新目标。任一外部 I/O、候选执行或替换步骤失败时都会使用固定阶段错误码并清理临时文件。

启动 TUI 时，`startTui` 先创建 `KanaConversationHost`。Host 加载运行配置和审批白名单，并向前端提供统一的 Agent 工厂和 session 操作；普通模式还持有 session journal、日志、accounting、记忆、wake scheduler 与 `KanaMcpRuntime`，Clean 模式则注册带普通 ID、no-op logger 且没有 journal 的进程内 session。`KanaTuiApp` 用这些依赖创建产品层 `ConversationRuntime`；该 runtime 持有当前 Agent 和 session，负责提交互斥、Agent 重建、session new/fork/resume、进程内 Goal 控制，以及从 Agent inbox 编排新 run。Agent 同时持有 run-local `next-step` steering 与 FIFO `next-turn` 输入，后者包含 Tab、到期 wake、deferred steering 和已允许的 Goal continuation；runtime 只发布 inbox 投影，不再维护第二条队列。当前会话确定并完成首次 TUI 渲染后，App 才请求 Host 加载外部工具；此时 MCP runtime 读取定义与启用状态文件、连接选中的 server、发现工具，再由 `ConversationRuntime` 重建主 Agent。`kana resume` 的会话选择器因此不会启动 MCP，选中会话后才会加载。TUI 只协调可见用户流程，不实现对话生命周期或 Kana 产品装配，也不知道 JSONL、TOML 或 MCP transport 等存储与协议细节。

`startHeadless` 使用同一个 Host 和 runtime，先加载 MCP，再提交一条用户消息或启动一个有界 Goal。Goal 执行会等待 runtime 的 Goal 终态转换和最后一次 Agent run 边界；所有内部 run 都投影成一个公共 headless run。前端把 runtime 事件投影成独立版本的 JSONL 公共协议，或把进度写到 stderr、最终助手文本写到 stdout。Schema v2 在工具得到物理终态时报告 `tool.completed`；只有 `run.completed` 保证有序结果提交与 run 后处理成功，之后发生持久化失败则产生 `run.failed`。无头前端不提供交互审批；未被配置或白名单信任的工具会关闭失败。调用方传入 `--allow-all-tools` 时会无条件授权所有可用工具，但不会隔离文件或进程。`--timeout` 会在 MCP 启动后设置覆盖完整 headless run 的软 deadline，并持续覆盖 Goal round；到时优雅取消 runtime，在终态 JSONL 事件记录 `termination`，并以 `124` 退出。前端清理不计入该 deadline。`SIGINT` 使用相同的优雅取消边界，并以 `130` 退出。

Clean 模式下，Host 在 MCP runtime 读取配置前返回空工具快照；TUI 不安装外部工具加载器，Headless 则继续经过同一 Host 边界但不会解析或连接 MCP。这个双重边界保证后续 new、模型切换和 Agent 重建不会重新引入外部工具；Host 另行拒绝 Clean 模式的 fork。

## 一次对话如何执行

```text
用户输入
  → KanaTuiApp.submitPrompt
  → ConversationRuntime.submit
  → Agent.stream
  → runAgentLoop
  → PromptAssembly.assemble（稳定 system + 当前 context/tools）
  → Model.stream (selected provider SSE)
  → AssistantMessageEvent
  → AgentEvent
  ├─ AgentEventRenderer 更新 transcript、工具块和状态栏
  └─ 普通模式的 Agent journal 增量记录已完成消息

若模型请求工具：
  Agent 验证参数 → beforeToolExecution（TUI 审批）
  → Tool.execute → ToolResultMessage → 下一轮模型调用
```

`core/messages.ts` 中的 `Message` 是历史记录的唯一格式：用户消息、含有有序内容块的助手消息，以及工具结果消息。用户消息 provenance 会区分直接输入、定时输入、Goal continuation 与内部 recovery、summary 和 `runtime_context` 快照；runtime 快照还携带稳定的 `source`，标识拥有该变化值的 provider。用户消息和工具结果消息都可以携带 `UserImage`，以 MIME 类型、内联 base64 数据和尺寸组成与供应商无关的自包含历史；各 provider adapter 再决定将其映射到 wire protocol，还是生成明确的不支持提示。助手内容块可以是 `text`、`thinking`、`tool_call` 或供应商托管的 `hosted_tool`；顺序被保留，以便既能正确回传给供应商，也能在 TUI 中按模型输出顺序展示。内容还可携带供应商拥有的 JSON 可序列化 `providerState`，供需要不透明 replay state 的 Responses adapter 使用；`core` 和 session 存储不解释该值。

供应商首先产生 `AssistantMessageEvent`。事件包含增量 `delta` 和完整 `snapshot`：前者适合增量呈现，后者让消费者不必重复实现消息拼接。`agent` 将其转换为更高一层的 `AgentEvent`，并额外发出回合、回合输入、工具开始/更新/结束和整个运行结束事件。`AgentEventStream` 与模型流都同时支持 `for await` 消费事件和 `result()` 获取最终值。

`Agent` 是有状态的单次运行控制器。它拒绝并发运行；普通模式下 Kana 注入的 `AgentJournal` 会在模型 I/O 前写入 turn 边界和深拷贝的用户输入。每次模型调用前，循环都会解析不可变的 `PromptAssembly`；每个动态 source 都必须产生明确且非空的 active 或 inactive 状态。初始就是 inactive 的 source 不写消息；激活后，有变化的状态会成为带来源的 runtime-context 消息，并同样先于模型 I/O 落盘，未变化状态不会重复追加。持久历史和模型输入会保留压缩前的全部转换；稳定 system 指令只让每个 source 的最后一次转换生效，从而既不复活已替换状态，也不破坏前面的模型消息前缀。循环将每条完整 assistant 消息、工具结果、steering input 和压缩 checkpoint 先写 journal 再加入对应内存状态，其中带工具调用的 assistant 消息必须早于工具执行落盘。活动 run 的 steering input 在完整 model/tool turn 的 `turn_end` 后消费，发出 `turn_input` 并触发下一次模型调用；若无法开始下一 turn，则在生命周期结束时返回 deferred，由 `ConversationRuntime` 放入新 run FIFO。产品层的 `onRunCommitted` 只执行 accounting 和记忆调度等聚合后处理；全部成功后才向监听器和 stream 发布最终 `agent_end` 并转为空闲。Clean 模式不注入 journal，消息与 checkpoint 只更新 Agent 内存状态，Host 的 run/compaction commit 回调也跳过 accounting 和记忆调度。整个过程仍拒绝新运行，`waitForIdle()` 也会继续等待。`state` 和公共事件会深拷贝可变数据，普通监听器异常不会修改内部历史或终止运行。

可选的 `ContextManager` 位于 Agent 与 Model 之间。Agent 为每个 run fork 一份 checkpoint 状态；每次模型调用前，manager 用完整消息历史创建“累计摘要 + 近期原始消息”的 model projection，并根据估算输入和剩余 context 计算通用的逐轮输出上限，终止时再把 checkpoint 和摘要 usage 随 run 一起提交。Runtime-context 消息是权威状态而非对话：压缩策略不会接收它们，每个来源最新的已覆盖快照会紧接摘要重新投影。不含 hosted tool 的回合会把 provider `input_tokens` 保存为 prompt 锚点，此后只对新增的可重放消息做本地估算；hosted-tool 响应的 usage 可能含临时搜索上下文，因此不能替换该锚点。assistant 内容与本地工具结果提交后，每个 `turn_end` 都会携带由此得到的下一轮 prompt 估算。`/compact` 复用同一个 manager 和摘要策略，但使用独立 commit，在产品 commit 回调成功后才 adopt checkpoint；普通模式的回调包含持久化，Clean 模式的回调只保留进程内状态。Kana 产品层以模型 metadata 与各 Agent 可选的 `model.context_limit` / `model.max_output_tokens` 偏好装配预算，并把二者都按模型硬上限钳制；摘要策略直接调用同一 Model，不包含工具或另一层 Agent loop。只有模型 metadata 与 Agent 策略都启用图片输入时，该策略才发送结构化图片附件；否则保留省略元数据并继续纯文本压缩，因此切换 provider 后旧图片消息不会阻塞 checkpoint 推进。provider 负责决定如何映射 `ModelContext.maxOutputTokens`；session 存储保留原始消息和压缩时间线，因此恢复时 Agent、TUI 和 ContextManager 分别消费 messages、timeline 和最后 checkpoint。新建的 manager 会在最新一条已持久化的 assistant 响应携带 usage、不含 hosted tool 且晚于当前 checkpoint 时，从该响应重建锚点；因此内容未变的已恢复会话会保留校准后的估算，而不是回退到完整的本地 projection 估算。

`runAgentLoop` 默认最多执行 8 回合，Kana 的默认配置将其设为 `-1`，表示不设上限；最后一个允许回合仍产生工具调用时以 `turn_limit` 结束。每一回合先解析动态 context 和工具，再流式取得助手消息；只有停止原因为 `toolUse` 时才把调用交给 `ToolRuntime`。ToolRuntime 使用的正是该模型步骤声明过的工具对象；下一步骤可以解析出更新后的能力集合。该 runtime 负责工具查找、TypeBox 1.x 参数校验、串行审批、调用级中止与 deadline、显式并发调度、结果规范化及提交；经 JSON 序列化后缺少 TypeBox 元数据的普通 schema 也可使用同一编译器校验。每个 run 的并行能力统一解析为用户 `parallelToolCalls` 设置与模型 metadata `supportsParallelToolCalls` 的交集，并同时写入 provider `ModelContext` 与 ToolRuntime，避免请求能力和实际调度分歧。工具自身的 `execution.deadlineMs` 优先，否则使用 Agent 默认值；框架默认 300000 毫秒，Kana 通过 `agent.tool_deadline_ms` 将产品默认值设为 660000 毫秒。只有并行能力启用时，连续的 `parallel` 工具才组成并行组；关闭时所有调用逐个执行，正整数 `maxParallelToolCalls` 配置不影响调度。启用后，组内使用按模型顺序领取的滚动池，默认最多同时执行四个调用 body，默认 `exclusive` 的工具仍形成屏障。串行事件队列按物理完成顺序发布以 `toolCallId` 关联的 partial 与终态活动；独立的模型顺序结果槽位则串行提交 journal 和下一次请求上下文，因此即使后面的调用先显示完成，持久历史仍保持确定。run abort、工具 deadline 或内部调度失败会立即停止补充；活动调用被中止并 drain，未启动调用得到 canceled 结果。若被中止的工具在有限宽限期内仍未退出，其可见结果固定为 `unknown`，迟到 update 被忽略，当前 run 终止且模型不会自动重试。拒绝、取消、未知工具、校验失败和工具异常都会转换成工具结果。

工具结果策略是通用 `agent` 边界，而不是 Kana 专用的循环逻辑。每个结果规范化后，`ToolRuntime` 都会以不可变的调用克隆、给模型的内容和错误状态执行可选策略；任意的 host 结构化结果留在边界之外。策略只能替换给模型的结果内容，或追加带来源的 `tool_result_policy` user 上下文。返回对象会在 failure containment 内解析成脱离原对象的普通快照；返回非法值或抛出异常时回退为原始结果。同一 assistant 消息的全部 sibling 工具结果先按模型顺序写入 journal，随后才写策略上下文，再开始下一次模型请求。每个 Agent 拥有自己的策略实例；已接受的人类输入或 `reset()` 会清空可变状态。Kana 装配层只负责把产品默认值和 TOML 映射到可复用的精确重复策略。

## 模型与供应商适配

`core/model.ts` 定义 `Model`：供应商实现只需提供元数据和 `stream(context)`，`generate()` 由基类通过收集流实现。通用 `ModelMetadata.protocol` 标识 `responses` 或 `chat-completions` wire protocol；`supportsHostedWebSearch`、`supportsImageInput`、上下文/输出硬上限以及可选 reasoning efforts 和默认档位，则独立声明所选模型能力，不与用户配置混合。每个 Agent 的 `ModelContext` 携带实际 web/image 策略和请求预算。Provider 可以据此选择共享 codec，而无需让 `core` 包含供应商专用路由。`providers/index.ts` 是内置供应商的集中式工厂；产品配置支持 `deepseek`、`openai-codex` 和一个静态 `custom` 槽位，`MockModel` 用于测试并使用 null protocol。

网络型 adapter 只共享 `src/providers` 下的窄 primitive：`lifecycle.ts` 固定请求、重试、认证刷新、流恢复、完成和失败诊断；`http.ts` 负责无活动 signal、可中止延迟、重试计时、可重试 HTTP 状态和有界错误体；`context-window.ts` 负责通用上下文超限信号与 provider 扩展。每条生命周期记录都包含 provider、model、protocol、phase 和 outcome；重试与失败记录还会按需添加 Kana 内部定义的固定 `errorCode`、安全的 `errorType`、attempt 或 HTTP status，安全的上游 code 则单独记为 `providerCode`。这些 helper 不拥有 provider 的重试循环、认证、请求构造或流解释，诊断也绝不包含错误消息、响应体、header、prompt 或流式内容。

`DeepSeekModel` 将所有 V4 模型都发送到 `/responses`。它们会把通用历史转换为语义化 Responses input，把已完成的供应商 item 保存为不透明 `providerState` 以供无状态 replay，在启用时声明托管 `web_search`，并使用共享的 `src/providers/responses` 语义 SSE 处理器。在视觉模型上，视觉工具结果会成为与原调用 ID 关联的原生 `function_call_output` 文本/图片输入块。该处理器按 index 与 item ID 关联输出，把 reasoning、消息、函数调用、托管搜索、终态和 usage 映射为有序 core event。

`src/providers/openai-compatible` 负责可复用的 OpenAI-compatible Chat Completions 路径。它转换通用消息与本地函数工具，仅在模型 metadata 允许图片输入时发送 image data URL，并在跨 provider replay 时省略供应商专用 reasoning 或托管工具状态。由于 Chat Completions 的 tool-role 消息不能携带图片内容，adapter 会保留每组连续 sibling 工具结果，再追加一条合成的多模态 user observation 来承载其中的工具图片。其 SSE reader 会保留被网络分片切开的 frame，逐步组装有序文本和函数调用，映射结束原因与 usage，并遵循 provider 生命周期关于取消、无活动超时、重试、安全日志及上下文超限归一化的约束。该模型可直接导入，但不注册为独立 `ProviderName`；Kana 的静态 `custom` 槽位解析 `<KANA_HOME>/providers/custom.toml` 后直接实例化它，刻意不引入动态 provider catalog 或任意运行时 adapter。

请求可由 Agent 中止，也受 `timeoutMs` 无活动超时限制；收到响应头或响应数据会重新计时。上游取消与无活动超时保留不同 outcome，两者都会停止等待中的重试延迟和后续请求。HTTP 408、429 和 5xx 会按指数退避重试，最多重试 `maxRetries` 次；保留的 HTTP 错误体最多为 16 KiB。模型元数据还提供上下文窗口和最大输出；TUI 用它计算上下文占用，进程累计 token 则来自 provider usage 事件。

`OpenAICodexModel` 使用 Kana 通用 OAuth 状态机提供的 ChatGPT token 与 account ID，向 Codex endpoint 发送 classic `store = false` Responses SSE 请求。instructions、客户端工具与托管工具使用 classic 顶层字段，不发送 Responses Lite header 或 input marker。视觉工具结果使用与原调用 ID 关联的原生 `function_call_output` 文本/图片输入块。adapter 提供 Codex 专用的请求与 replay 规则，同时复用共享的语义 Responses 处理器组装 reasoning summary、provider-hosted `web_search_call`、message 和 function call output item。它把 encrypted reasoning 与完成 item 作为不透明 `providerState` 持久化，供后续回合 replay。托管搜索不会进入本地 ToolRuntime；首个 `401` 会 refresh 并重试一次。HTTP 重试与已识别的 transient Responses 流错误共享同一个 `maxRetries` 预算：overload、server、internal、temporary-unavailability 和 rate-limit 错误只会在助手输出或托管工具活动开始前重试，校验错误与协议错误保持终态。subscription 用量与其他 provider 一样只记录 token，Kana 不估算金额。详见 [OpenAI Codex 提供商适配](openai-codex-provider.zh-CN.md)。

## MCP 协议基础

`src/mcp` 按以下依赖方向实现 MCP，不把远端工具逻辑放进 Agent loop 或供应商适配器：

```text
McpManager（多服务器生命周期、筛选、冲突、诊断）
  ├→ McpToolAdapter → Tool
  └→ McpManagedClient
      ├→ McpClient（2025-11-25 lifecycle、capabilities、tools/list、tools/call）
      │  → McpConnection（请求 ID、乱序响应、超时、取消、进度、ping）
      │    → McpTransport（双向 JSON-RPC 消息边界）
      │      ├→ StdioTransport（子进程、逐行 UTF-8 framing、stderr、关闭顺序）
      │      └→ StreamableHttpTransport（POST、JSON/SSE、session、恢复、GET/DELETE）
      └→ McpOAuthHttpAuthorizer（resource metadata、Bearer challenge、授权恢复）
          → OAuthSession（metadata discovery、PKCE、loopback callback、refresh）
```

`McpConnection` 不执行初始化，也不知道 tools 等版本特性；因此后续无状态协议客户端可以复用它，而不继承 `2025-11-25` 的握手。transport 只负责消息传递，不协商版本或能力；stdio 与 Streamable HTTP 独立实现同一边界，不共享进程或 HTTP session 状态。旧 `2024-11-05` HTTP+SSE transport 被刻意留作后续兼容层，不混入 Streamable HTTP 的单端点 lifecycle。

当前基础客户端严格执行已发布的 `2025-11-25` lifecycle：`initialize` 是首个请求，成功协商同一版本后发送 `notifications/initialized`。它只在服务器声明 tools capability 后分页执行 `tools/list` 和调用 `tools/call`。所有请求具有固定上限的超时；普通请求超时或被 `AbortSignal` 中止时发送 `notifications/cancelled`，但规范禁止取消的 `initialize` 不发送该通知。进度 token 在活跃请求内唯一，递增更新由调用方回调接收。

stdio 使用参数数组直接启动进程，不经过 Shell。stdout 仅接受一行一个 JSON-RPC 消息，并设置最大字节数；协议污染、无效 UTF-8/JSON、非零退出和未完成消息都会关闭连接并拒绝 pending 请求。stderr 与协议分离，通过受保护的诊断回调交给上层。正常关闭依次关闭 stdin、等待进程、发送 SIGTERM，并在再次超时后发送 SIGKILL。

Streamable HTTP 严格实现 `2025-11-25` 单端点 transport，不自动回退旧 HTTP+SSE。每条出站 JSON-RPC 消息使用独立 POST，并同时接受 JSON 与 SSE 响应；共享 SSE decoder 支持跨 chunk 的 CR/LF framing、事件字节上限、`id` 与 `retry`。transport 保存初始化响应提供的可选 session ID，在后续请求附带 session 与协议版本 header，初始化完成后尝试 GET server stream，并在带事件 ID 的 POST stream 中断时通过 `Last-Event-ID` GET 恢复而不重试原请求。后台 GET/SSE 正常结束或在读取期间发生网络断开时，会按服务器 `retry` 或默认延迟重新连接，并携带已经完整接收的最后一个事件 ID；成功重连会记录安全的触发分类、重连次数、是否从事件位置恢复，以及固定格式的错误标识。非法 UTF-8、SSE、JSON 或超限事件仍会关闭连接。携带 session 的请求收到 HTTP 404 时，transport 清除旧 session，client 合并同一 session 的并发过期事件并重新执行不带 session 的初始化；触发过期的原请求永不自动重放，恢复成功后其失败结果会明确提示 Agent 可以再次调用。若替代 session 在恢复握手内再次过期，等待中的调用会收到恢复失败和 client 已关闭的结果。请求取消会先发送协议通知，再中止对应 HTTP 请求；关闭会中止剩余 stream，并对有 session 的服务器发送限时 DELETE。URL credentials 与覆盖 transport 所有 header 的配置会被拒绝。HTTP transport 失败日志包含安全的操作阶段、错误类型和固定格式错误码，但不记录 endpoint URL、headers、session ID、事件 ID 或请求参数。

可识别的 OAuth `401/403` challenge 作为当前请求错误返回，不破坏 transport 或 MCP session；authorizer 可在同一 fetch 边界恢复凭据并重试一次。网络或协议致命错误仍启动后台关闭，关闭 Promise 会立即附加 rejection handler，避免 session DELETE 失败形成 TUI 外泄的未处理堆栈；显式 close caller 仍能观察并记录原错误。通用 `src/oauth` 将 metadata discovery、授权 URL/PKCE、loopback callback、token exchange 和可合并的 refresh 放在独立边界，token persistence 仅通过 `OAuthTokenStore` 接口注入。`McpOAuthHttpAuthorizer` 为每个 protected resource 持有一个 `OAuthSession`，限制 credential 只能发往精确 MCP endpoint，优先使用显式配置 scope，并在 challenge 要求范围外权限时拒绝自动扩权。Kana 产品层实现 `0600` JSON token store、系统浏览器打开和 transcript 状态，因此未来 provider 可以复用 OAuth 模块而不依赖 MCP 配置或 TUI。

`McpToolAdapter` 只依赖结构化的 `McpToolCaller`，不绑定稳定版 client 或 stdio。它在工具发现时预编译远端 `inputSchema`，使用 server ID 和远端工具名生成最长 64 字符的可读模型别名，并把 MCP 进度映射到 `ToolContext.update`。结果适配器限制内容项、文本、结构化数据和元数据大小；text 与嵌入文本资源可进入模型上下文，resource link 只转为描述，image、audio 和 blob 只保留 MIME 与估算字节数，不持久化 base64。JSON-RPC error 与 MCP `isError` 保持不同的结构化错误语义。

`McpManager` 只依赖结构化的 `McpManagedClient`，不创建具体协议 client 或 transport。它并行启动服务器，但按注册顺序稳定聚合工具；include/exclude 使用远端原名筛选。单个可选服务器连接、发现或 schema 适配失败时只记录诊断并关闭该服务器，必需服务器失败则关闭全部连接并终止启动。每个服务器的工具集以原子方式适配；远端重名会使该服务器失败，清洗或截断后的别名冲突以及与本地保留工具冲突会使整个聚合失败，不做隐式覆盖或顺序后缀。关闭操作幂等并按注册逆序清理所有 client。

Manager 会固定使用本次发现的工具列表，不处理 `notifications/tools/list_changed`。`kana` 层解析 `mcp.json` 中的服务器定义，读取独立 `mcp-enabled.json` 中选中的 ID，并且只为两者交集创建 registration；这个启用边界与协议和 transport 无关。工厂根据 `type` 判别配置创建 stdio 或 HTTP registration，省略 `type` 时默认使用 stdio；它为每个选中的服务器构造对应 transport 和稳定版 `McpClient`。stdio 只继承少量基础环境变量，先从 Kana 进程环境解析服务器显式 `env` 中的必需或带默认值占位符，再把结果合并到子进程并将 stderr 转发给当前 session logger；无法解析的必需占位符沿用 manager 的单 server 启动失败隔离。HTTP 使用经过快照的 URL 与 headers。`kana/mcp/http-proxy` 在产品装配边界把 Bun 的代理扩展封装成通用 fetch 接口，并同时注入 transport 与 OAuth authorizer，使 MCP 生命周期和 OAuth metadata/token 请求保持相同路由。代理 URL 直接传给 Bun；`false` 则仅在同步调用 fetch 时把目标主机追加到 `NO_PROXY` 与 `no_proxy`，并在返回 Promise 前通过 `finally` 恢复两个进程变量，因此未配置该策略的其他 server 仍观察到原环境。未配置时继续使用默认 fetch 和进程级代理。存在 OAuth 配置时，managed-client wrapper 会在 connect 前准备 authorizer，把授权 fetch 注入 transport，并在关闭前冻结认证生命周期，使最后一次 session DELETE 仍可使用内存中的 access token。两种 transport 的 client error、OAuth lifecycle 和 manager error 都写入当前 logger。产品层先以空的外部工具集创建临时主 Agent；会话显示后启动 manager，再用发现的工具重建 Agent。加载期间 App 禁止提交输入，因而临时 Agent 不会开始运行；memory consolidation Agent 始终不获得这些外部工具。停止时 App 先取消并等待活动 Agent，再由产品装配层关闭 manager。

`KanaMcpRuntime` 在产品边界持有可替换的 manager，`McpManager` 本身仍刻意保持一次性。runtime 串行执行 `start`、`reload` 和 `close`，并为底层进度标记所属的 runtime 操作。reload 会先关闭当前 manager，再重新读取服务器定义与启用状态，最后创建全新的 manager；这样不会重叠启动 server 进程，TUI 也不需要了解 transport 或协议生命周期。配置解析或启动失败后，不会残留已关闭 manager 的工具和来源映射；修正文件后仍可通过后续 `/mcp` reload 恢复。一旦请求关闭，队列中尚未开始的生命周期任务不会再创建 manager。

## Kana 产品装配

`KanaConversationHost` 是前端共享的 Kana 产品生命周期边界。它集中装配配置、审批、session journal、日志、accounting、记忆压缩、wake scheduler、MCP 与 `createKanaAgent`，并为每次新建、分叉、恢复或配置变化创建绑定到正确 session 的 Agent。Host 只返回前端中立的数据和操作，不渲染 TUI；`ConversationRuntime` 则消费这些操作并管理一次对话的执行状态。这样交互式前端与无头前端可以共享相同的模型、提示词、工具和 launch-mode 持久化策略。

`createKanaAgent` 是运行时组合点。它以当前目录为工作区，加载可见 Skills，构建 `PromptAssembly`，注册 `list`、`glob`、`grep`、`read`、`write`、`edit`、`bash` 和 session 自有的 `todo_write`；当活动模型支持图片且 `image_input` 已启用时有条件注册 `view_image`；只在 runtime 报告 active Goal 时注册 `update_goal`；并从 `kana/tools` 注册产品专属的可选 `remember` 与 `schedule_wake`，最后通过可替换的 external capability section 解析产品层传入的 `additionalTools`。通用 `tools` 层不依赖 Kana 的持久化或会话生命周期。

稳定 system 前缀由以下部分组成，后面的项目级指令优先级更高：

1. 长期记忆的 global/project 引用；
2. 内置默认助手指令；
3. `~/.kana/AGENTS.md` 的全局指令（若存在）；
4. `<cwd>/AGENTS.md` 的项目指令（若存在且不是同一文件）；
5. 已启用 Skills 的名称、描述和 `SKILL.md` 路径。

当前目录、平台、日期和时区会在每次模型调用前解析，并只在发生变化时作为 active `environment` runtime-context 消息追加。Host 自有的 todo 列表和进程内 Goal 在同一边界分别通过独立的 `todo` 与 `goal` source 解析。空 todo 状态和不存在授权 Goal 的情况都必须提供 source 专属 inactive 文本；只有该 source 之前 active 过才会追加 inactive。Active Goal 状态包含目标和终态 guidance，但不含 controller ID 或 run 预算。未压缩的历史转换都会留在模型输入中，由最后一条同 source 转换定义当前状态；压缩只重新投影边界上的 active 状态，并在累计摘要后保留后续转换。长期记忆在该 Agent 生命周期内保持在稳定前缀中；`remember` guidance 由工具 description 承载，不进入系统提示词。Clean 模式只保留第 2 项、runtime-context 协议、动态环境上下文、进程内 todo 和 Goal 上下文，并且不会扫描 Skills 路径、读取 memory 或创建自动记忆合并 scheduler。Host 仍把当前运行配置传给 Agent，因此 provider/model、上下文上限、输出上限、工具 deadline 与 Goal run 上限和普通模式一致；`schedule_wake` 也仍按前端能力启用。Clean 模式中的 Agent 配置变更会经过同一 schema 校验，但只替换 Host 的进程内配置，不调用共享 `KanaConfigStore`。

`loadKanaConfig` 从可选 `config.toml` 读取配置，并按字段与内置默认值合并。Provider 表只负责传输/鉴权；对话和记忆 Agent 各自拥有静态运行策略与模型选择。类型或枚举不合法会直接报错，而不是静默忽略，且破坏性新 schema 不提供旧配置读取器。install 不物化默认 `config.toml`，只补齐缺失的可变状态；`config.example.toml` 与 `providers/custom.example.toml` 是运行时不读取的 Kana 生成参考，install 会刷新过期 example，reset 则刷新主配置 example 并保留 Custom provider 文件。`KanaConfigStore` 为 TUI 等调用方提供通用 typed mutation：它比较更新前后的有效配置，只 patch 变化的规范 TOML leaf，验证回读结果后用同目录临时文件原子替换，因此无关配置、未知表和注释不需要经过全量重序列化。

## 本地状态

所有 Kana 状态都位于 `KANA_HOME`，未设置时为 `~/.kana`：

下表描述普通模式的持久化。Clean 会话不会写入其中的 session、运行时日志、accounting 或 memory 项；Project/Global `/usage` 仍可读取既有 accounting 汇总。

| 数据 | 位置与格式 | 写入时机 |
| --- | --- | --- |
| 配置 | `config.toml` | 用户编辑或普通模式的 `/model` 修改；`kana reset` 删除 |
| 配置参考 | `config.example.toml` | `kana install` 或 `kana reset` 创建/刷新；运行时不读取 |
| Custom 供应商 | `providers/custom.toml` | 用户直接编辑；`kana install` 与 `kana reset` 都会保留 |
| Custom 供应商参考 | `providers/custom.example.toml` | `kana install` 创建/刷新；运行时不读取 |
| MCP server 定义 | `mcp.json` | `kana install`、`kana reset` 或用户编辑 |
| MCP 启用状态 | `mcp-enabled.json` | `kana install`、`kana reset` 或启用状态变更 |
| OAuth token | `oauth-tokens.json` | 浏览器授权、refresh、退出登录或凭据失效 |
| 审批白名单 | `approvals.json` | `kana install`、`kana reset`，或用户选择某条 bash 命令“始终允许” |
| 会话 | `sessions/<workspace>/*.jsonl` | Agent turn 中按协议定义的消息顺序增量追加 |
| 运行时日志 | `logs/<workspace>/<session-id>.jsonl` | TUI、Agent、provider、工具和记忆任务的安全生命周期事件 |
| 用量账本 | `accounting/<workspace>/<session-id>.jsonl` | 主运行、压缩或记忆运行完成后追加 |
| 长期记忆 | `memory/{global,projects/<workspace>}/memory.md` | 记忆压缩成功后原子替换 |
| 每日记忆 | 对应目录的 `daily/YYYY-MM-DD.md` | `remember` 成功时追加 |
| 全局 Skills 配置 | `skills/skills.toml` | `kana install`、`kana reset`，或 TUI 修改全局 Skill 开关 |
| 默认 Skills 仓库 | `skills/kana-skills/` | `kana skills install` 或 `kana skills reinstall` |

Accounting v2 记录 run 身份与 outcome、provider/model 身份、原始 token usage、助手消息数量和记忆运行元数据。它有意不保存 provider 定价或派生金额；实际费用由 provider 的账单系统负责。

工作区目录名由解析后的绝对路径稳定编码，供会话和项目记忆共同使用。V5 会话的格式、Journal 状态机和文件仓储分别位于 `kana/session/format.ts`、`journal.ts` 与 `repository.ts`，调用方统一经过该目录的 barrel。会话文件是 JSONL：首行是版本化的 session header，之后是由 `turn_start`/`turn_end` 包围的 timeline。message 与 context-compaction 记录保存对话状态；带类型的 `todo_state` 记录会原子保存完整的 session todo 列表，并可关联到接受它的工具调用。每条内层消息带有稳定的逻辑 `MessageId` 和必填 provenance；外层 journal entry ID 仍是独立的时间线身份。原始消息（包括有变化和 inactive 的 runtime-context 转换）不会删除；未压缩的 model projection 会保留这些转换，压缩条目则指明覆盖的消息和累计 base checkpoint。创建会话本身不落盘；首次开始 turn 时才写 header，并用第一条不是 recovery、runtime context 或 Goal continuation 的 user-role 消息生成标题。Goal 消息仍是可审计的普通历史，但 controller、授权和 run 预算不会持久化。进程中断后，加载器会闭合打开的 turn，保留已经持久化的 todo 更新，并把其它缺失工具结果记录为未知且禁止自动重试。运行时只读取 V5。

运行时日志也使用相同的工作区编码，并以 Kana session ID 为文件边界；恢复会话会追加原日志，新建、分叉或恢复到另一会话会切换文件。session log manager 会返回永久绑定到指定会话的 logger；每个 Agent 和后台任务启动时捕获该具体 logger，因此后续生命周期记录仍归属发起它的会话。记录为分级 JSONL，默认 `info`，可通过 `logging.level` 调整或设为 `off`。logger 从 Kana 产品装配层显式传入 Agent 和 provider，`core` 不依赖日志或文件系统。日志只记录安全的生命周期元数据，不记录 prompt、模型文本、完整工具输入/输出、请求头或 API key；文件写入失败被忽略，且从不经由终端输出，因此不会污染 TUI。

记忆分 global 和 project 两个 scope。`remember` 先向当天的暂存文件追加结构化条目；对话提交后，调度器按 scope 启动增量压缩 Agent。增量压缩和手动全量压缩共享每个 scope 的队列，串行执行该 scope 的全部读—改—写任务。压缩 Agent 使用独立的 `[memory.agent]` 运行策略和模型选择，并且只有记忆读写工具；它在助手以正常 `stop` 结束时才提交内存中的修改。通过 `/memory` 交互流程选择 Compact 可发起全量压缩，并在成功后按 `daily_retention_days` 清理过期每日记忆。

Skills 从项目 `.kana/skills`、项目 `.agents/skills` 和全局 `~/.kana/skills` 递归发现。每项以 `SKILL.md` 的 `name`/`description` frontmatter 注册；同名时先发现的项保留并产生诊断。项目 Skills 始终启用，全局 Skills 由 `skills.toml` 的列表控制。

## 工具、审批与安全边界

工具优先使用 TypeBox 1.x schema；调用前先执行参数转换和编译校验，校验后的参数才交给工具。TypeBox schema 经 JSON 序列化后会丢失运行时元数据，Kana 会为这种普通 JSON Schema 补充兼容的基础类型转换，再使用同一 TypeBox 编译器校验。工具结果分为给模型的文本 `content`、可选且与 provider 无关的 `images` 视觉观察，以及给 Agent/TUI 的结构化 `result`，避免展示层解析供应商文本。

工具的 `execution.concurrency` 可声明为 `parallel` 或 `exclusive`，缺省时安全地使用 `exclusive`。内置 `list`、`glob`、`grep`、`read`、`view_image` 是只读并声明为 `parallel`；写入、Shell、记忆和第三方/MCP 工具不会隐式获得并发权限。

- `list` 列出目录的一层子项，`glob` 用相对 pattern 查找路径，`grep` 搜索文本内容；三者用于受控只读探索。
- `read` 读取文本文件，支持按行分页。
- `view_image` 通过共享附件解码器加载本地图片，并作为视觉观察交给活动模型；动画格式使用解码后的首帧并规范化为静态 PNG。
- `write` 默认只创建不存在的新文件，显式 `overwrite` 时可替换既有文件。
- `edit` 对既有文件做精确字符串替换；多次匹配必须显式 `replaceAll`。
- `bash` 使用用户 shell 运行，默认超时 30 秒、最大 600 秒；节流的实时更新是每个流最多 20,000 字符的有界尾部快照，但会保留完整最终输出交给统一结果 finalization。每个命令使用独立进程组；取消和超时会终止整个进程组，顶层 shell 退出后会短暂排空输出再返回，避免后台子进程卡住工具调用。它将 `sudo` 改写为非交互模式，避免抢占 TUI 输入。
- `todo_write` 原子替换 session todo 状态，将其重新投影给模型，且不请求审批。
- `update_goal` 将进程内 active Goal 关闭为 `completed` 或 `blocked`，且不请求审批。
- `remember` 将非敏感的长期信息追加到每日记忆；它不会请求审批。

审批模式为 `always`、`unless_trusted`、`never`。在默认模式下，`list`、`glob`、`grep`、`read` 和 `view_image` 自动通过；白名单中的单个只读 bash 可执行名和精确 bash 命令自动通过；其他工具会显示 TUI 选择框。用户可只把某一条 bash 命令加入精确白名单。只读命令判断刻意拒绝 shell 组合符、路径形式的可执行文件和换行，以免把看似只读的组合命令误判为安全。

这里的“工作区工具”不是沙箱：文件路径、`bash.cwd`、`glob.cwd` 和 `grep.path` 可以是绝对路径，或通过相对路径离开工作区。文件读取会解析符号链接，写入会检查已有父目录的真实路径；这些机制用于获得规范化显示路径和处理链接，而非限制访问范围。审批是用户可见的授权层，不是操作系统级隔离。

## TUI 架构

`ConversationRuntime` 是产品级对话生命周期边界：持有当前 Agent 和 session，拒绝并发提交，统一 new/fork/resume 与配置或工具变化后的 Agent 替换，并在前台允许后按顺序 drain Agent 持有的 `next-turn` lane。Tab 输入、到期 wake 和 deferred steering 共用这条 FIFO lane，Enter steering 则先进入 `next-step`。Active `/goal` 只在该 FIFO 为空时允许一条 synthetic continuation，因此 lane 中已有的人类或定时输入保持在它之前。Runtime 把配置的正整数 run 上限快照到 Goal controller，终态只保留在当前进程，中止时取消，session 变化、Agent 替换或关闭时丢弃 active 状态。每条逻辑输入在两条 lane、runtime 与 Agent event、UI 投影、journal commit 和历史之间保留同一个 `MessageId`；runtime 不再创建 queue correlation ID。scheduled 与 Goal item 还保留投递 metadata，并与进程内 scheduler 的未来 wake 列表一起发布为只读快照。Runtime 提供当前 session 的用户定时创建与按 MessageId 取消边界，取消会同步检查未来 timer 和已到期 inbox item，因此执行顺序、管理状态与 TUI 展示不会分叉。它发布与前端无关的 run、Agent event、inbox、session-change 和 Goal-state 事件；监听器异常会被隔离并写入诊断日志。`KanaTuiApp` 只持有累计用量和交互控制器，订阅 runtime 事件后交给 `AgentEventRenderer` 映射为助手消息块、工具块和状态栏阶段。`QueuedInputController` 将 runtime 快照投影为 `next turn`、`next run`、到期 `scheduled`、Goal continuation 和未来 wake 摘要，并按 MessageId 对齐状态切换；`ScheduledMessageManagerController` 持有 `/schedule` 的静态管理快照和多步添加/删除流程；`ExternalToolsLifecycleController` 持有首次加载、MCP 重载、追加式生命周期输出与输入恢复状态；`SlashCommandController` 统一命令路由和参数校验；`SessionLifecycleController` 协调 new/fork/resume 后的 transcript、焦点和状态重置。它们只通过窄回调请求跨域动作，不反向修改 App 的内部状态。

剪贴板图片粘贴、`/image <path>` 和 `view_image` 会汇合到共享图片输入 utility。该边界负责解析运行主机上的路径、解码并限制图片尺寸/字节，最终返回同一种 `UserImage` 表示；只有 macOS 剪贴板 reader 是平台专用实现。

```text
ProcessTerminal（raw mode、输入、resize、通知）
  → Tui（焦点、16ms 合帧、差量重绘、硬件光标）
    → AppLayout
      ├─ Main（当前为 Transcript；使用终端 scrollback）
      └─ 底部（严格一个组件；分档高度）
         ├─ Editor（输入区、状态栏和队列预览）
         ├─ ToolApproval
         ├─ Session / Skills / MCP / Schedule 视图
         └─ ContentViewer
```

`Tui` 以组件的 `render(width, availableHeight?): string[]` 作为最小渲染协议。`AppLayout` 根据终端高度选择 15、12、9 或 7 行底部预算；终端不足 7 行时使用全部可用高度，其余高度传给 main。Layout 固定绘制底部区域首行作为 main/bottom 分隔线，将剩余预算传给底部组件，并为较短输出补空行，从而稳定两者的边界。Editor 会优先使用状态栏下方本来由 Layout 补齐的空间显示 pending 队列和一行未来 wake 摘要；空间不足时优先保留 pending、截断明细，slash palette 打开时隐藏两者。Transcript 刻意忽略 main 的剩余高度提示，继续为终端 scrollback 渲染完整历史，并在有输出的子 Block 之间统一插入一行空白；Block 仅管理内容内部留白。紧凑工具块仍受与视口高度无关的固定形态约束：一行标题、一行压平的 target（仅内置工具）、少量预览行预算并逐行水平截断，因此单个超大工具结果不可能把历史撑成数千个换行行；`Ctrl+O` 打开最近一次工具调用的详情查看器，`[`/`]` 在工具调用之间切换。`Tui` 缓存上次输出并独立决定终端更新策略；App 和 controller 代码只调用 `requestRender()`。终端尺寸稳定时，内容未变化只更新光标，可见改动只重绘最小首尾范围，追加内容依靠终端自然滚屏，收缩则用 `CSI 2K` 清除可见的尾部残留行。改动已进入 scrollback、删除后新尾部高于可寻址视口、终端尺寸变化，或无法安全推断光标/视口状态时，renderer 会回退到全量清屏并重新播放。编辑器在逻辑行中插入内部光标标记，`Tui` 在写入终端前取走该标记；存在焦点组件时才将硬件光标移动到对应的可见宽度位置，没有焦点时则隐藏光标并留在布局末尾。渲染层以 grapheme 和 `string-width` 处理 CJK、emoji、ANSI 颜色和换行。

TUI 的主要控制器分别处理工具审批、会话选择/删除、全局 Skills 开关、MCP server 开关和 OAuth 操作、定时消息管理、provider/model 选择、`!` 本地 Shell、记忆压缩和长工具输出查看。Session、Skill、MCP、Schedule、slash 选项、审批和内容查看视图都会作为唯一底部组件替换编辑器。`/model` 从 Kana 产品层取得可用 Provider、模型、推理档位和当前选择，不直接读取 Provider 实现目录；它会保留消息和 context checkpoint，在配置写入前构造候选 Agent，成功后才替换当前 Agent，失败时旧 Agent 与配置保持可用。Skill 与 MCP controller 都会把 checkbox 修改保留在本地草稿中，直到 `Esc` 时一次性持久化有变化的选择；Skill 变更只重建一次 Agent 提示词，MCP 选择或已启用 server 的认证状态变化只请求一次 runtime reload。MCP 组件接收 server ID、transport、OAuth 安全状态，以及 stdio command/参数或 HTTP URL，但不会接收环境变量、HTTP headers 或 token；授权 URL 只临时放在 transcript block 中，完成后原位替换。Schedule 视图只读取当前 session 的进程内快照，不持久化、显示或按 Agent replacement key 删除任务；其活动期间到期消息继续进入 `next-turn`，但关闭前不会启动新 run。MCP 视图打开、认证操作或 reload 进行中时，到期的 schedule wake 也会继续排队。审批在其他底部视图活动时到达，会保持等待并发送已配置的通知，而不是抢占当前视图。`Ctrl+C` 保持全局语义，负责中止当前 Agent、本地 Shell 或记忆任务；空闲时退出。`Esc` 属于当前聚焦的底部组件，因此 view 和嵌套 prompt 可以先按自身语义关闭或返回上一层，之后才回到编辑器处理。焦点在编辑器时，`Esc` 会中止正在运行的 Agent；空闲时不产生作用。`Ctrl+O` 打开最近一项工具详情，与是否可展开无关：查看器复用 full-fidelity detail section 作为操作上下文，追加非终态状态与通过现有 full renderer 渲染的完整输出，`[`/`]` 在工具调用之间切换时直接替换查看器而不恢复编辑器。

## 扩展时的检查点

- 新供应商应先实现 `Model` 的流协议，保证事件快照不与内部可变消息共享，并在 `providers` 工厂注册。
- 新工具应定义 TypeBox 参数、结构化结果和清晰的错误语义；若有流式进度，调用 `context.update`。
- 新增可改变工作区的工具时，应同时审视审批策略、TUI 的工具展示和会话持久化结果。
- 新增用户可见命令或面板时，应由 App 或独立 controller 协调状态，组件本身保持渲染/输入职责。
- 改动消息、事件或 session JSONL 格式前，必须同时检查 DeepSeek 请求转换、历史渲染、持久化解析和相关测试；这些格式是跨层契约。

后续文档可在此基础上分别展开配置与安装、Agent/工具协议、会话与记忆格式、Skills，以及 TUI 渲染实现。
