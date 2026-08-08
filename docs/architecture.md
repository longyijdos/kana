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
                                                              ├─ core     消息、模型、工具描述、流和用量的共享协议
                                                              └─ providers
                                                                  ├─ deepseek      DeepSeek 请求、SSE 解析和流式适配
                                                                  └─ openai-codex  Codex Responses、OAuth 凭据和流式适配
```

`core` 是最内层的协议包：不依赖产品配置或前端。Provider-facing 的 `ToolSpec` 属于该层；`tools` 中可执行的 `Tool` 在此基础上增加执行函数。`logging` 是同时提供日志协议、空实现和会话级 JSONL 实现的基础设施模块。`agent` 依赖 `core`、`tools` 以及 `logging` 中的协议和空实现，但不知道日志路径或产品配置，因此可在没有终端界面的情况下运行；具体 session logger 由 Kana 产品层装配。`oauth` 是不感知 MCP、供应商或前端的通用 Authorization Code + PKCE 和 token 生命周期模块；`mcp` 在其上增加 protected-resource discovery 与 Bearer challenge 语义，但仍不依赖 Kana 产品装配或 Agent loop。`kana` 是将这些通用部件变成 Kana 产品的装配层；它从当前工作目录和 `~/.kana`（或 `KANA_HOME`）读取状态。`tui` 与 `headless` 共享该装配层，且都不直接实现模型协议或持久化格式。

这种分层也说明了新增代码应放在哪里：新增供应商放 `providers`，可复用的执行能力放 `tools`，循环控制放 `agent`，Kana 的默认策略和本地状态放 `kana`，交互呈现放 `tui`。

Kana 产品层内部按领域提供稳定 barrel：`auth/` 管理产品凭据与 token 存储，`mcp/` 管理外部工具配置和生命周期，`conversation/` 管理前端共享的会话运行时与 wake scheduler，`session/` 管理持久化，`memory/` 和 `skills/` 管理长期状态，`tools/` 管理 Kana 专属工具，`update/` 隔离自更新。领域内部使用相对导入，跨顶层调用方仍统一经过 `@/kana`。

`tests/` 按主要源码领域组织为 `agent/`、`core/`、`kana/`、`mcp/`、`oauth/`、`providers/`、`tools/` 和 `tui/` 等目录；Kana 与 Provider 测试继续按其内部领域细分。跨模块集成测试放在主要行为所有者的目录，非测试输入继续集中在 `tests/fixtures/`。Bun 会递归发现这些 `*.test.ts` 文件。

## 启动路径

`src/main.ts` 调用 `runCli`。CLI 支持以下主要路径：

- `kana [--clean] [prompt...]`：启动 TUI；有参数时启动后立即发送该提示词。
- `kana resume [sessionId]`：按 ID 恢复会话，或打开会话选择器。
- `kana exec [--clean] [prompt...]` / `kana exec resume <sessionId> [prompt...]`：不启动 TUI，执行一次完整 Agent turn 后退出；可用 `--json` 输出版本化 JSONL 事件。
- `kana install`：幂等补齐缺失的本地状态并刷新生成的配置参考，不物化默认 `config.toml`，也不安装 Skills 仓库。
- `kana update [--check]`：检查最新正式 Release；省略 `--check` 时验证候选二进制并原子替换当前 direct-distribution 独立二进制。
- `kana reset [--yes]`：经确认删除 `config.toml`，刷新配置参考并重置 MCP、审批和 Skill 启用状态，同时保留凭据、用户数据、日志、指令和实际 Skills。
- `kana auth login|status|logout openai-codex`：管理 Codex 浏览器 OAuth 与本地凭据。
- `kana skills install|reinstall [--yes]`：安全安装/更新默认 Skills Git 仓库，或经确认删除后重新 clone。
- `kana skills sync|resync <target> [--yes]`：把已安装的 Kana Skills 复制到其它 agent 的 Skills 目录；sync 跳过同名项，resync 经确认替换同名项，但不清理其它或过期 Skill。

启动入口把 `normal | clean` 模式显式传给前端与 `KanaConversationHost`，Host 再把它传给每次创建或重建的 Agent。TUI 和 Headless 会拒绝 clean 与 resume 的组合，Host 继续保留相同不变量。Clean 模式不通过替换 `KANA_HOME` 或清空进程环境模拟隔离，因此仍读取 `.env`、运行配置、认证和审批；但它在 Host 边界为 session journal、session logger 和 accounting 关闭持久化，并在 Agent 装配边界关闭 AGENTS、memory、Skills 和 MCP。

自更新由 `kana/update/self-update.ts` 隔离在产品层，不进入 TUI 或 Agent 生命周期。它通过 GitHub Release API 取得版本、平台资产及 SHA-256 digest，把下载写入当前可执行文件的同目录临时路径，校验大小与 digest，并让候选程序执行 `--version` 和幂等初始化。替换前会再次比较目标文件的 device、inode、mtime 和大小，避免覆盖下载期间由其它安装进程写入的新版本；最终 rename 是 POSIX 同文件系统的原子目录项替换。源码运行默认标记为 `source` 并拒绝更新，所有可直接安装的编译入口在构建期注入 `direct` 标记，防止把 Bun runtime 误判为更新目标。任一外部 I/O、候选执行或替换步骤失败时都会使用固定阶段错误码并清理临时文件。

启动 TUI 时，`startTui` 先创建 `KanaConversationHost`。Host 加载运行配置和审批白名单，并向前端提供统一的 Agent 工厂和 session 操作；普通模式还持有 session journal、日志、accounting、记忆、wake scheduler 与 `KanaMcpRuntime`，Clean 模式则注册带普通 ID、no-op logger 且没有 journal 的进程内 session。`KanaTuiApp` 用这些依赖创建产品层 `ConversationRuntime`；该 runtime 持有当前 Agent 和 session，负责提交互斥、Agent 重建、session new/fork/resume，以及 Tab 输入和到期 wake 共用 FIFO 的顺序投递；Agent 自身持有仅属于当前 run 的 steering queue。当前会话确定并完成首次 TUI 渲染后，App 才请求 Host 加载外部工具；此时 MCP runtime 读取定义与启用状态文件、连接选中的 server、发现工具，再由 `ConversationRuntime` 重建主 Agent。`kana resume` 的会话选择器因此不会启动 MCP，选中会话后才会加载。TUI 只协调可见用户流程，不实现对话生命周期或 Kana 产品装配，也不知道 JSONL、TOML 或 MCP transport 等存储与协议细节。

`startHeadless` 使用同一个 Host 和 runtime，先加载 MCP，再提交一条用户消息并等待完整 Agent loop 结束。它把 runtime 事件投影成独立版本的 JSONL 公共协议，或把进度写到 stderr、最终助手文本写到 stdout。无头前端不提供交互审批；未被配置或白名单信任的工具会关闭失败。调用方传入 `--allow-all-tools` 时会无条件授权所有可用工具，但不会隔离文件或进程。`SIGINT` 会取消活动 Agent，进程以 `130` 退出。

Clean 模式下，Host 在 MCP runtime 读取配置前返回空工具快照；TUI 不安装外部工具加载器，Headless 则继续经过同一 Host 边界但不会解析或连接 MCP。这个双重边界保证后续 new、模型切换和 Agent 重建不会重新引入外部工具；Host 另行拒绝 Clean 模式的 fork。

## 一次对话如何执行

```text
用户输入
  → KanaTuiApp.submitPrompt
  → ConversationRuntime.submit
  → Agent.stream
  → runAgentLoop
  → Model.stream (selected provider SSE)
  → AssistantMessageEvent
  → AgentEvent
  ├─ AgentEventRenderer 更新 transcript、工具块和状态栏
  └─ 普通模式的 Agent journal 按完成顺序增量写入会话

若模型请求工具：
  Agent 验证参数 → beforeToolExecution（TUI 审批）
  → Tool.execute → ToolResultMessage → 下一轮模型调用
```

`core/messages.ts` 中的 `Message` 是历史记录的唯一格式：用户消息、含有有序内容块的助手消息，以及工具结果消息。助手内容块可以是 `text`、`thinking` 或 `tool_call`；顺序被保留，以便既能正确回传给供应商，也能在 TUI 中按模型输出顺序展示。内容还可携带供应商拥有的 JSON 可序列化 `providerState`，供 Codex 等需要不透明 replay state 的 adapter 使用；`core` 和 session 存储不解释该值。

供应商首先产生 `AssistantMessageEvent`。事件包含增量 `delta` 和完整 `snapshot`：前者适合增量呈现，后者让消费者不必重复实现消息拼接。`agent` 将其转换为更高一层的 `AgentEvent`，并额外发出回合、回合输入、工具开始/更新/结束和整个运行结束事件。`AgentEventStream` 与模型流都同时支持 `for await` 消费事件和 `result()` 获取最终值。

`Agent` 是有状态的单次运行控制器。它拒绝并发运行；普通模式下 Kana 注入的 `AgentJournal` 会在模型 I/O 前写入 turn 边界和深拷贝的用户输入。循环将每条完整 assistant 消息、工具结果、steering input 和压缩 checkpoint 先写 journal 再加入对应内存状态，其中带工具调用的 assistant 消息必须早于工具执行落盘。活动 run 的 steering input 在完整 model/tool turn 的 `turn_end` 后消费，发出 `turn_input` 并触发下一次模型调用；若无法开始下一 turn，则在生命周期结束时返回 deferred，由 `ConversationRuntime` 放入新 run FIFO。产品层的 `onRunCommitted` 只执行 accounting 和记忆调度等聚合后处理；全部成功后才向监听器和 stream 发布最终 `agent_end` 并转为空闲。Clean 模式不注入 journal，消息与 checkpoint 只更新 Agent 内存状态，Host 的 run/compaction commit 回调也跳过 accounting 和记忆调度。整个过程仍拒绝新运行，`waitForIdle()` 也会继续等待。`state` 和公共事件会深拷贝可变数据，普通监听器异常不会修改内部历史或终止运行。

可选的 `ContextManager` 位于 Agent 与 Model 之间。Agent 为每个 run fork 一份 checkpoint 状态；每次模型调用前，manager 用完整消息历史创建“累计摘要 + 近期原始消息”的 model projection，并根据估算输入和剩余 context 计算通用的逐轮输出上限，终止时再把 checkpoint 和摘要 usage 随 run 一起提交。`/compact` 复用同一个 manager 和摘要策略，但使用独立 commit，在产品 commit 回调成功后才 adopt checkpoint；普通模式的回调包含持久化，Clean 模式的回调只保留进程内状态。Kana 产品层以模型 metadata 或 `agent.context_limit` 装配预算，并注入一个直接调用同一 Model、但没有工具和 Agent loop 的摘要策略。provider 负责决定如何映射 `ModelContext.maxOutputTokens`；session 存储保留原始消息和压缩时间线，因此恢复时 Agent、TUI 和 ContextManager 分别消费 messages、timeline 和最后 checkpoint。

`runAgentLoop` 默认最多执行 8 回合，Kana 的默认配置将其设为 `-1`，表示不设上限；最后一个允许回合仍产生工具调用时以 `turn_limit` 结束。每一回合先流式取得助手消息；只有停止原因为 `toolUse` 时才把调用交给 `ToolRuntime`。该 runtime 负责工具查找、TypeBox 1.x 参数校验、串行审批、调用级中止与 deadline、显式并发调度、结果规范化及提交；经 JSON 序列化后缺少 TypeBox 元数据的普通 schema 也可使用同一编译器校验。每个 run 的并行能力统一解析为用户 `parallelToolCalls` 设置与模型 metadata `supportsParallelToolCalls` 的交集，并同时写入 provider `ModelContext` 与 ToolRuntime，避免请求能力和实际调度分歧。工具自身的 `execution.deadlineMs` 优先，否则使用 Agent 默认值；框架默认 300000 毫秒，Kana 通过 `agent.tool_deadline_ms` 将产品默认值设为 660000 毫秒。只有并行能力启用时，连续的 `parallel` 工具才组成并行组；关闭时所有调用逐个执行，默认 `exclusive` 的工具仍形成屏障。工具 update 通过串行事件队列保持顺序，实际完成的结果通过另一条串行 commit 队列逐条写 journal，再发布 `tool_execution_end`，并以同一完成顺序进入下一次模型请求。拒绝、取消、未知工具、校验失败和工具异常都会转换成工具结果。运行中止或 deadline 会中止工具的独立 signal；工具若在有限宽限期内仍未退出，其可见结果固定为 `unknown`，迟到 update 被忽略，当前 run 终止且模型不会自动重试。

## 模型与供应商适配

`core/model.ts` 定义 `Model`：供应商实现只需提供元数据和 `stream(context)`，`generate()` 由基类通过收集流实现。`providers/index.ts` 是集中式工厂；产品配置支持 `deepseek` 与 `openai-codex`，`MockModel` 用于测试。

`DeepSeekModel` 将通用消息、系统提示词和工具 JSON Schema 转换为 DeepSeek 的 OpenAI 兼容请求格式，向 `/chat/completions` 发送 SSE 请求。流解析器会：

1. 缓冲被网络分片切开的 SSE 帧；
2. 将 reasoning、可见文本和工具参数增量写入同一有序助手消息；
3. 按 DeepSeek tool call index 推断单个调用结束：更高 index 首次出现时解析并结束此前调用，流结束时再结束最后一个，同时保留原始参数字符串；
4. 映射结束原因和 token 用量。

请求可由 Agent 中止，也受 `timeoutMs` 无活动超时限制；收到响应头或响应数据会重新计时。HTTP 408、429 和 5xx 会按指数退避重试，最多重试 `maxRetries` 次。模型元数据还提供上下文窗口、最大输出和 CNY 计价；TUI 用它计算上下文占用和本次进程累计成本。

`OpenAICodexModel` 使用 Kana 通用 OAuth 状态机提供的 ChatGPT token 与 account ID，向 Codex Responses Lite endpoint 发送 `store = false` 的 SSE 请求。adapter 把 reasoning summary、message 和 function call output item 映射到相同的有序内容协议，并把 encrypted reasoning 与完成 item 作为不透明 `providerState` 持久化，供后续回合 replay。首个 `401` 会 refresh 并重试一次；subscription 用量只记录 token，不套用 Platform API 价格。详见 [OpenAI Codex 提供商适配](openai-codex-provider.md)。

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

`createKanaAgent` 是运行时组合点。它以当前目录为工作区，加载可见 Skills，构建系统提示词，注册 `list`、`glob`、`grep`、`read`、`write`、`edit`、`bash`，并从 `kana/tools` 注册产品专属的可选 `remember` 与 `schedule_wake`，最后在校验名称唯一后追加产品层传入的 `additionalTools`。通用 `tools` 层不依赖 Kana 的持久化或会话生命周期。

系统提示词由以下部分组成，后面的项目级指令优先级更高：

1. 长期记忆的 global/project 引用，以及 `remember` 使用规则；
2. 内置默认助手指令；
3. `~/.kana/AGENTS.md` 的全局指令（若存在）；
4. `<cwd>/AGENTS.md` 的项目指令（若存在且不是同一文件）；
5. 当前目录、平台、日期和时区；
6. 已启用 Skills 的名称、描述和 `SKILL.md` 路径。

Clean 模式只保留第 2、5 项，并且不会扫描 Skills 路径、读取 memory 或创建自动记忆合并 scheduler。Host 仍把当前运行配置传给 Agent，因此 provider/model、上下文上限、输出上限和工具 deadline 与普通模式一致；`schedule_wake` 也仍按前端能力启用。Clean 模式中的 Agent 配置变更会经过同一 schema 校验，但只替换 Host 的进程内配置，不调用共享 `KanaConfigStore`。

`loadKanaConfig` 从可选 `config.toml` 读取配置，并按字段与内置默认值合并；类型或枚举不合法会直接报错，而不是静默忽略。install 不物化默认 `config.toml`，只补齐缺失的可变状态；`config.example.toml` 是运行时不读取的 Kana 生成参考，install 和 reset 会比较并刷新过期内容。`KanaConfigStore` 为 TUI 等调用方提供通用 typed mutation：它比较更新前后的有效配置，只 patch 变化的规范 TOML leaf，验证回读结果后用同目录临时文件原子替换，因此无关配置、未知表和注释不需要经过全量重序列化。

## 本地状态

所有 Kana 状态都位于 `KANA_HOME`，未设置时为 `~/.kana`：

下表描述普通模式的持久化。Clean 会话不会写入其中的 session、运行时日志、accounting 或 memory 项；Project/Global `/usage` 仍可读取既有 accounting 汇总。

| 数据 | 位置与格式 | 写入时机 |
| --- | --- | --- |
| 配置 | `config.toml` | 用户编辑或普通模式的 `/model` 修改；`kana reset` 删除 |
| 配置参考 | `config.example.toml` | `kana install` 或 `kana reset` 创建/刷新；运行时不读取 |
| MCP server 定义 | `mcp.json` | `kana install`、`kana reset` 或用户编辑 |
| MCP 启用状态 | `mcp-enabled.json` | `kana install`、`kana reset` 或启用状态变更 |
| OAuth token | `oauth-tokens.json` | 浏览器授权、refresh、退出登录或凭据失效 |
| 审批白名单 | `approvals.json` | `kana install`、`kana reset`，或用户选择某条 bash 命令“始终允许” |
| 会话 | `sessions/<workspace>/*.jsonl` | Agent turn 中按消息完成顺序增量追加 |
| 运行时日志 | `logs/<workspace>/<session-id>.jsonl` | TUI、Agent、provider、工具和记忆任务的安全生命周期事件 |
| 长期记忆 | `memory/global|projects/<workspace>/memory.md` | 记忆压缩成功后原子替换 |
| 每日记忆 | 对应目录的 `daily/YYYY-MM-DD.md` | `remember` 成功时追加 |
| 全局 Skills 配置 | `skills/skills.toml` | `kana install`、`kana reset`，或 TUI 修改全局 Skill 开关 |
| 默认 Skills 仓库 | `skills/kana-skills/` | `kana skills install` 或 `kana skills reinstall` |

工作区目录名由解析后的绝对路径稳定编码，供会话和项目记忆共同使用。V3 会话的格式、Journal 状态机和文件仓储分别位于 `kana/session/format.ts`、`journal.ts` 与 `repository.ts`，调用方统一经过该目录的 barrel。会话文件是 JSONL：首行是版本化的 session header，之后是由 `turn_start`/`turn_end` 包围的 message 与 context-compaction journal。原始消息不删除；压缩条目指明覆盖的消息和累计 base checkpoint。创建会话本身不落盘；首次开始 turn 时才写 header，并用首条用户消息生成标题。进程中断后，加载器会闭合打开的 turn，并把缺失工具结果记录为未知且禁止自动重试。运行时不读取 V1/V2。

运行时日志也使用相同的工作区编码，并以 Kana session ID 为文件边界；恢复会话会追加原日志，新建、分叉或恢复到另一会话会切换文件。session log manager 会返回永久绑定到指定会话的 logger；每个 Agent 和后台任务启动时捕获该具体 logger，因此后续生命周期记录仍归属发起它的会话。记录为分级 JSONL，默认 `info`，可通过 `logging.level` 调整或设为 `off`。logger 从 Kana 产品装配层显式传入 Agent 和 provider，`core` 不依赖日志或文件系统。日志只记录安全的生命周期元数据，不记录 prompt、模型文本、完整工具输入/输出、请求头或 API key；文件写入失败被忽略，且从不经由终端输出，因此不会污染 TUI。

记忆分 global 和 project 两个 scope。`remember` 先向当天的暂存文件追加结构化条目；对话提交后，调度器按 scope 启动增量压缩 Agent。增量压缩和手动全量压缩共享每个 scope 的队列，串行执行该 scope 的全部读—改—写任务。压缩 Agent 使用相同的模型，但只有记忆读写工具；它在助手以正常 `stop` 结束时才提交内存中的修改。通过 `/memory` 交互流程选择 Compact 可发起全量压缩，并在成功后按 `daily_retention_days` 清理过期每日记忆。

Skills 从项目 `.kana/skills`、项目 `.agents/skills` 和全局 `~/.kana/skills` 递归发现。每项以 `SKILL.md` 的 `name`/`description` frontmatter 注册；同名时先发现的项保留并产生诊断。项目 Skills 始终启用，全局 Skills 由 `skills.toml` 的列表控制。

## 工具、审批与安全边界

工具优先使用 TypeBox 1.x schema；调用前先执行参数转换和编译校验，校验后的参数才交给工具。TypeBox schema 经 JSON 序列化后会丢失运行时元数据，Kana 会为这种普通 JSON Schema 补充兼容的基础类型转换，再使用同一 TypeBox 编译器校验。工具结果分为给模型的文本 `content` 和给 Agent/TUI 的结构化 `result`，避免展示层解析供应商文本。

工具的 `execution.concurrency` 可声明为 `parallel` 或 `exclusive`，缺省时安全地使用 `exclusive`。内置 `list`、`glob`、`grep`、`read` 是只读并声明为 `parallel`；写入、Shell、记忆和第三方/MCP 工具不会隐式获得并发权限。

- `list` 列出目录的一层子项，`glob` 用相对 pattern 查找路径，`grep` 搜索文本内容；三者用于受控只读探索。
- `read` 读取文本文件，支持按行分页。
- `write` 默认只创建不存在的新文件，显式 `overwrite` 时可替换既有文件。
- `edit` 对既有文件做精确字符串替换；多次匹配必须显式 `replaceAll`。
- `bash` 使用用户 shell 运行，默认超时 30 秒、最大 120 秒，输出每个流最多保留 20,000 字符，并以节流更新事件显示实时输出。每个命令使用独立进程组；取消和超时会终止整个进程组，顶层 shell 退出后会短暂排空输出再返回，避免后台子进程卡住工具调用。它将 `sudo` 改写为非交互模式，避免抢占 TUI 输入。
- `remember` 将非敏感的长期信息追加到每日记忆；它不会请求审批。

审批模式为 `always`、`unless_trusted`、`never`。在默认模式下，`list`、`glob`、`grep` 和 `read` 自动通过；白名单中的单个只读 bash 可执行名和精确 bash 命令自动通过；其他工具会显示 TUI 选择框。用户可只把某一条 bash 命令加入精确白名单。只读命令判断刻意拒绝 shell 组合符、路径形式的可执行文件和换行，以免把看似只读的组合命令误判为安全。

这里的“工作区工具”不是沙箱：文件路径、`bash.cwd`、`glob.cwd` 和 `grep.path` 可以是绝对路径，或通过相对路径离开工作区。文件读取会解析符号链接，写入会检查已有父目录的真实路径；这些机制用于获得规范化显示路径和处理链接，而非限制访问范围。审批是用户可见的授权层，不是操作系统级隔离。

## TUI 架构

`ConversationRuntime` 是产品级对话生命周期边界：持有当前 Agent 和 session，拒绝并发提交，统一 new/fork/resume 与配置或工具变化后的 Agent 替换，并在前台允许后按顺序 drain 当前 session 的 pending submission FIFO。Tab 输入、到期 wake 和 deferred steering 共用这条新 run 队列，Enter steering 则先进入 Agent 的 run-local queue。Runtime 为每个 pending item 保留稳定 ID、来源、安全显示文本；scheduled item 还保留到期时间，并与进程内 scheduler 的未来 wake 列表一起发布为只读快照。它提供当前 session 的用户定时创建与按 ID 取消边界，取消会同步检查未来 timer 和已到期 pending 项，因此执行顺序、管理状态与 TUI 展示不会分叉。它发布与前端无关的 run、Agent event、input-queue 和 session-change 事件；监听器异常会被隔离并写入诊断日志。`KanaTuiApp` 只持有累计用量/成本和交互控制器，订阅 runtime 事件后交给 `AgentEventRenderer` 映射为助手消息块、工具块和状态栏阶段。`QueuedInputController` 只持有 run-local 的可视 `next turn` 项，并将 runtime 快照投影为 `next run`、到期 `scheduled` 和未来 wake 摘要；`ScheduledMessageManagerController` 持有 `/schedule` 的静态管理快照和多步添加/删除流程；`ExternalToolsLifecycleController` 持有首次加载、MCP 重载、进度块与输入恢复状态；`SlashCommandController` 统一命令路由和参数校验；`SessionLifecycleController` 协调 new/fork/resume 后的 transcript、焦点和状态重置。它们只通过窄回调请求跨域动作，不反向修改 App 的内部状态。

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

`Tui` 以组件的 `render(width, availableHeight?): string[]` 作为最小渲染协议。`AppLayout` 根据终端高度选择 15、12、9 或 7 行底部预算；终端不足 7 行时使用全部可用高度，其余高度传给 main。Layout 固定绘制底部区域首行作为 main/bottom 分隔线，将剩余预算传给底部组件，并为较短输出补空行，从而稳定两者的边界。Editor 会优先使用状态栏下方本来由 Layout 补齐的空间显示 pending 队列和一行未来 wake 摘要；空间不足时优先保留 pending、截断明细，slash palette 打开时隐藏两者。Transcript 刻意忽略 main 的剩余高度提示，继续为终端 scrollback 渲染完整历史，并在有输出的子 Block 之间统一插入一行空白；Block 仅管理内容内部留白。`Tui` 缓存上次输出，尺寸不变时只重绘变化的行；改变已滚出视口的内容、缩小内容或终端尺寸改变时改用全量重绘。编辑器在逻辑行中插入内部光标标记，`Tui` 在写入终端前取走该标记；存在焦点组件时才将硬件光标移动到对应的可见宽度位置，没有焦点时则隐藏光标并留在布局末尾。渲染层以 grapheme 和 `string-width` 处理 CJK、emoji、ANSI 颜色和换行。

TUI 的主要控制器分别处理工具审批、会话选择/删除、全局 Skills 开关、MCP server 开关和 OAuth 操作、定时消息管理、provider/model 选择、`!` 本地 Shell、记忆压缩和长工具输出查看。Session、Skill、MCP、Schedule、slash 选项、审批和内容查看视图都会作为唯一底部组件替换编辑器。`/model` 从 Kana 产品层取得可用 Provider、模型、推理档位和当前选择，不直接读取 Provider 实现目录；它会保留消息和 context checkpoint，在配置写入前构造候选 Agent，成功后才替换当前 Agent，失败时旧 Agent 与配置保持可用。Skill 与 MCP controller 都会把 checkbox 修改保留在本地草稿中，直到 `Esc` 时一次性持久化有变化的选择；Skill 变更只重建一次 Agent 提示词，MCP 选择或已启用 server 的认证状态变化只请求一次 runtime reload。MCP 组件接收 server ID、transport、OAuth 安全状态，以及 stdio command/参数或 HTTP URL，但不会接收环境变量、HTTP headers 或 token；授权 URL 只临时放在 transcript block 中，完成后原位替换。Schedule 视图只读取当前 session 的进程内快照，不持久化、显示或按 Agent replacement key 删除任务；其活动期间到期消息继续进入 pending FIFO，但关闭前不会启动新 run。MCP 视图打开、认证操作或 reload 进行中时，到期的 schedule wake 也会继续排队。审批在其他底部视图活动时到达，会保持等待并发送已配置的通知，而不是抢占当前视图。`Ctrl+C`/`Esc` 优先中止当前 Agent、本地 Shell 或记忆任务；空闲时 `Ctrl+C` 退出。`Ctrl+O` 打开最近一项可展开的工具输出。

## 扩展时的检查点

- 新供应商应先实现 `Model` 的流协议，保证事件快照不与内部可变消息共享，并在 `providers` 工厂注册。
- 新工具应定义 TypeBox 参数、结构化结果和清晰的错误语义；若有流式进度，调用 `context.update`。
- 新增可改变工作区的工具时，应同时审视审批策略、TUI 的工具展示和会话持久化结果。
- 新增用户可见命令或面板时，应由 App 或独立 controller 协调状态，组件本身保持渲染/输入职责。
- 改动消息、事件或 session JSONL 格式前，必须同时检查 DeepSeek 请求转换、历史渲染、持久化解析和相关测试；这些格式是跨层契约。

后续文档可在此基础上分别展开配置与安装、Agent/工具协议、会话与记忆格式、Skills，以及 TUI 渲染实现。
