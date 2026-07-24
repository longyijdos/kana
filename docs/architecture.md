# Kana 架构总览

Kana 是一个以 Bun 运行的终端通用 Agent。它将模型调用、工具执行和本地状态持久化放在同一进程中，并用自研 TUI 显示流式过程。本文描述当前实现的运行边界和模块关系，帮助新贡献者从入口一路定位到具体职责。

## 分层与依赖方向

```text
src/main.ts
  └─ cli                 命令解析；启动、恢复会话和安装本地文件
      └─ tui             终端交互、渲染和用户审批
          └─ kana        产品装配：配置、提示词、会话、记忆、Skills
              ├─ logging  会话级 JSONL 诊断日志
              ├─ oauth    通用 OAuth 发现、PKCE、callback、token 与 refresh 状态机
              ├─ mcp      MCP JSON-RPC 连接、协议客户端与传输
              ├─ agent   模型—工具循环和事件协议转换
              ├─ tools   文件、Shell 与 remember 工具
              ├─ core    消息、模型、流和用量的共享协议
              └─ providers
                  └─ deepseek  DeepSeek 请求、SSE 解析和流式适配
```

`core` 是最内层的协议包：不依赖产品配置或 TUI。`agent` 仅依赖 `core` 和 `tools`，因此可在没有终端界面的情况下运行。`oauth` 是不感知 MCP、供应商或 TUI 的通用 Authorization Code + PKCE 和 token 生命周期模块；`mcp` 在其上增加 protected-resource discovery 与 Bearer challenge 语义，但仍不依赖 Kana 产品装配或 Agent loop。`kana` 是将这些通用部件变成 Kana 产品的装配层；它从当前工作目录和 `~/.kana`（或 `KANA_HOME`）读取状态。`tui` 依赖这些上层能力，但不直接实现模型协议或持久化格式。

这种分层也说明了新增代码应放在哪里：新增供应商放 `providers`，可复用的执行能力放 `tools`，循环控制放 `agent`，Kana 的默认策略和本地状态放 `kana`，交互呈现放 `tui`。

## 启动路径

`src/main.ts` 调用 `runCli`。CLI 支持三类路径：

- `kana [prompt...]`：启动 TUI；有参数时启动后立即发送该提示词。
- `kana resume [sessionId]`：按 ID 恢复会话，或打开会话选择器。
- `kana install [--force] [--skills]`：创建默认配置、审批文件和 Skills 配置；`--skills` 额外克隆或更新默认 Skills 仓库。
- `kana skills sync <target>`：把已安装的 Kana Skills 复制到其它 agent 的 Skills 目录；当前内置 `codex` 目标，也可传自定义目录。

启动 TUI 时，`startTui` 会加载运行配置和审批白名单，并以空闲的 `KanaMcpRuntime` 构造 `KanaTuiApp`。当前会话确定并完成首次 TUI 渲染后，App 才调用注入的外部工具加载回调；此时 runtime 才读取 MCP 定义与启用状态文件、连接选中的 server、发现工具，再由 App 重建主 Agent。`kana resume` 的会话选择器因此不会启动 MCP，选中会话后才会加载。会话读写、Skills 与 MCP 开关、记忆压缩、外部工具 start/reload 和 Agent 工厂都以回调方式注入 App；因此 App 协调用户流程，但不知道 JSONL、TOML 或 MCP transport 等存储与协议细节。

## 一次对话如何执行

```text
用户输入
  → KanaTuiApp.submitPrompt
  → Agent.stream
  → runAgentLoop
  → Model.stream (DeepSeek SSE)
  → AssistantMessageEvent
  → AgentEvent
  ├─ AgentEventRenderer 更新 transcript、工具块和状态栏
  └─ Agent 将已完成消息提交给会话存储

若模型请求工具：
  Agent 验证参数 → beforeToolExecution（TUI 审批）
  → Tool.execute → ToolResultMessage → 下一轮模型调用
```

`core/messages.ts` 中的 `Message` 是历史记录的唯一格式：用户消息、含有有序内容块的助手消息，以及工具结果消息。助手内容块可以是 `text`、`thinking` 或 `tool_call`；顺序被保留，以便既能正确回传给供应商，也能在 TUI 中按模型输出顺序展示。

供应商首先产生 `AssistantMessageEvent`。事件包含增量 `delta` 和完整 `snapshot`：前者适合增量呈现，后者让消费者不必重复实现消息拼接。`agent` 将其转换为更高一层的 `AgentEvent`，并额外发出回合、工具开始/更新/结束和整个运行结束事件。`AgentEventStream` 与模型流都同时支持 `for await` 消费事件和 `result()` 获取最终值。

`Agent` 是有状态的单次运行控制器。它拒绝并发运行；`stream()` 会先把深拷贝后的用户输入加入内部历史，再创建 `AbortController`。循环产生终态后，Agent 先提交本次助手消息和工具结果到内部状态，再等待产品层的 `onRunCommitted`；持久化成功后才向监听器和 stream 发布最终 `agent_end` 并转为空闲。commit 期间仍拒绝新运行，`waitForIdle()` 也会继续等待。`state` 和公共事件会深拷贝可变数据，普通监听器异常不会修改内部历史或终止运行。

`runAgentLoop` 默认最多执行 8 回合，Kana 的默认配置将其设为 `-1`，表示不设上限；最后一个允许回合仍产生工具调用时以 `turn_limit` 结束。每一回合先流式取得助手消息；只有停止原因为 `toolUse` 时才顺序执行工具调用。每个调用都经过 TypeBox 1.x 校验和可选的 `beforeToolExecution` 钩子；经 JSON 序列化后缺少 TypeBox 元数据的普通 schema 也可使用同一编译器校验。拒绝、取消、未知工具、校验失败和工具异常都会转换成工具结果并回传模型；拒绝或中止会终止本次运行。

## 模型与供应商适配

`core/model.ts` 定义 `Model`：供应商实现只需提供元数据和 `stream(context)`，`generate()` 由基类通过收集流实现。`providers/index.ts` 是集中式工厂；当前产品配置只允许 DeepSeek，`MockModel` 用于测试。

`DeepSeekModel` 将通用消息、系统提示词和工具 JSON Schema 转换为 DeepSeek 的 OpenAI 兼容请求格式，向 `/chat/completions` 发送 SSE 请求。流解析器会：

1. 缓冲被网络分片切开的 SSE 帧；
2. 将 reasoning、可见文本和工具参数增量写入同一有序助手消息；
3. 按 DeepSeek tool call index 推断单个调用结束：更高 index 首次出现时解析并结束此前调用，流结束时再结束最后一个，同时保留原始参数字符串；
4. 映射结束原因和 token 用量。

请求可由 Agent 中止，也受 `timeoutMs` 无活动超时限制；收到响应头或响应数据会重新计时。HTTP 408、429 和 5xx 会按指数退避重试，最多重试 `maxRetries` 次。模型元数据还提供上下文窗口、最大输出和 CNY 计价；TUI 用它计算上下文占用和本次进程累计成本。

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

Manager 会固定使用本次发现的工具列表，不处理 `notifications/tools/list_changed`。`kana` 层解析 `mcp.json` 中的服务器定义，读取独立 `mcp-enabled.json` 中选中的 ID，并且只为两者交集创建 registration；这个启用边界与协议和 transport 无关。工厂根据 `type` 判别配置创建 stdio 或 HTTP registration，省略 `type` 时默认使用 stdio；它为每个选中的服务器构造对应 transport 和稳定版 `McpClient`。stdio 只继承少量基础环境变量，先从 Kana 进程环境解析服务器显式 `env` 中的必需或带默认值占位符，再把结果合并到子进程并将 stderr 转发给当前 session logger；无法解析的必需占位符沿用 manager 的单 server 启动失败隔离。HTTP 使用经过快照的 URL 与 headers。`kana/http-proxy` 在产品装配边界把 Bun 的代理扩展封装成通用 fetch 接口，并同时注入 transport 与 OAuth authorizer，使 MCP 生命周期和 OAuth metadata/token 请求保持相同路由。代理 URL 直接传给 Bun；`false` 则仅在同步调用 fetch 时把目标主机追加到 `NO_PROXY` 与 `no_proxy`，并在返回 Promise 前通过 `finally` 恢复两个进程变量，因此未配置该策略的其他 server 仍观察到原环境。未配置时继续使用默认 fetch 和进程级代理。存在 OAuth 配置时，managed-client wrapper 会在 connect 前准备 authorizer，把授权 fetch 注入 transport，并在关闭前冻结认证生命周期，使最后一次 session DELETE 仍可使用内存中的 access token。两种 transport 的 client error、OAuth lifecycle 和 manager error 都写入当前 logger。产品层先以空的外部工具集创建临时主 Agent；会话显示后启动 manager，再用发现的工具重建 Agent。加载期间 App 禁止提交输入，因而临时 Agent 不会开始运行；memory consolidation Agent 始终不获得这些外部工具。停止时 App 先取消并等待活动 Agent，再由产品装配层关闭 manager。

`KanaMcpRuntime` 在产品边界持有可替换的 manager，`McpManager` 本身仍刻意保持一次性。runtime 串行执行 `start`、`reload` 和 `close`，并为底层进度标记所属的 runtime 操作。reload 会先关闭当前 manager，再重新读取服务器定义与启用状态，最后创建全新的 manager；这样不会重叠启动 server 进程，TUI 也不需要了解 transport 或协议生命周期。配置解析或启动失败后，不会残留已关闭 manager 的工具和来源映射；修正文件后仍可通过后续 `/mcp` reload 恢复。一旦请求关闭，队列中尚未开始的生命周期任务不会再创建 manager。

## Kana 产品装配

`createKanaAgent` 是运行时组合点。它以当前目录为工作区，加载可见 Skills，构建系统提示词，注册 `list`、`glob`、`grep`、`read`、`write`、`edit`、`bash` 与可选内置工具，并在校验名称唯一后追加产品层传入的 `additionalTools`。

系统提示词由以下部分组成，后面的项目级指令优先级更高：

1. 长期记忆的 global/project 引用，以及 `remember` 使用规则；
2. 内置默认助手指令；
3. `~/.kana/AGENTS.md` 的全局指令（若存在）；
4. `<cwd>/AGENTS.md` 的项目指令（若存在且不是同一文件）；
5. 当前目录、平台、日期和时区；
6. 已启用 Skills 的名称、描述和 `SKILL.md` 路径。

`loadKanaConfig` 从 `config.toml` 读取配置，并按字段与默认值合并；类型或枚举不合法会直接报错，而不是静默忽略。默认配置、审批数据和 Skills 开关均以仅用户可读写的文件创建。

## 本地状态

所有 Kana 状态都位于 `KANA_HOME`，未设置时为 `~/.kana`：

| 数据 | 位置与格式 | 写入时机 |
| --- | --- | --- |
| 配置 | `config.toml` | `kana install` 或用户编辑 |
| MCP server 定义 | `mcp.json` | `kana install` 或用户编辑 |
| MCP 启用状态 | `mcp-enabled.json` | `kana install` 或启用状态变更 |
| OAuth token | `oauth-tokens.json` | 浏览器授权、refresh、退出登录或凭据失效 |
| 审批白名单 | `approvals.json` | 用户选择某条 bash 命令“始终允许” |
| 会话 | `sessions/<workspace>/*.jsonl` | 每个 Agent 运行成功提交后追加 |
| 运行时日志 | `logs/<workspace>/<session-id>.jsonl` | TUI、Agent、provider、工具和记忆任务的安全生命周期事件 |
| 长期记忆 | `memory/global|projects/<workspace>/memory.md` | 记忆压缩成功后原子替换 |
| 每日记忆 | 对应目录的 `daily/YYYY-MM-DD.md` | `remember` 成功时追加 |
| 全局 Skills 配置 | `skills/skills.toml` | TUI 修改全局 Skill 开关时 |

工作区目录名由解析后的绝对路径稳定编码，供会话和项目记忆共同使用。会话文件是 JSONL：首行是版本化的 session header，之后每行是带父 ID 的消息条目。创建会话本身不落盘；第一批消息追加时才写 header，并用首条用户消息生成标题。

运行时日志也使用相同的工作区编码，并以 Kana session ID 为文件边界；恢复会话会追加原日志，新建、分叉或恢复到另一会话会切换文件。session log manager 会返回永久绑定到指定会话的 logger；每个 Agent 和后台任务启动时捕获该具体 logger，因此后续生命周期记录仍归属发起它的会话。记录为分级 JSONL，默认 `info`，可通过 `logging.level` 调整或设为 `off`。logger 从 TUI 装配层显式传入 Agent 和 provider，`core` 不依赖日志或文件系统。日志只记录安全的生命周期元数据，不记录 prompt、模型文本、完整工具输入/输出、请求头或 API key；文件写入失败被忽略，且从不经由终端输出，因此不会污染 TUI。

记忆分 global 和 project 两个 scope。`remember` 先向当天的暂存文件追加结构化条目；对话提交后，调度器按 scope 启动增量压缩 Agent。增量压缩和手动全量压缩共享每个 scope 的队列，串行执行该 scope 的全部读—改—写任务。压缩 Agent 使用相同的模型，但只有记忆读写工具；它在助手以正常 `stop` 结束时才提交内存中的修改。通过 `/memory` 交互流程选择 Compact 可发起全量压缩，并在成功后按 `daily_retention_days` 清理过期每日记忆。

Skills 从项目 `.kana/skills`、项目 `.agents/skills` 和全局 `~/.kana/skills` 递归发现。每项以 `SKILL.md` 的 `name`/`description` frontmatter 注册；同名时先发现的项保留并产生诊断。项目 Skills 始终启用，全局 Skills 由 `skills.toml` 的列表控制。

## 工具、审批与安全边界

工具优先使用 TypeBox 1.x schema；调用前先执行参数转换和编译校验，校验后的参数才交给工具。TypeBox schema 经 JSON 序列化后会丢失运行时元数据，Kana 会为这种普通 JSON Schema 补充兼容的基础类型转换，再使用同一 TypeBox 编译器校验。工具结果分为给模型的文本 `content` 和给 Agent/TUI 的结构化 `result`，避免展示层解析供应商文本。

- `list` 列出目录的一层子项，`glob` 用相对 pattern 查找路径，`grep` 搜索文本内容；三者用于受控只读探索。
- `read` 读取文本文件，支持按行分页。
- `write` 默认只创建不存在的新文件，显式 `overwrite` 时可替换既有文件。
- `edit` 对既有文件做精确字符串替换；多次匹配必须显式 `replaceAll`。
- `bash` 使用用户 shell 运行，默认超时 30 秒、最大 120 秒，输出每个流最多保留 20,000 字符，并以节流更新事件显示实时输出。每个命令使用独立进程组；取消和超时会终止整个进程组，顶层 shell 退出后会短暂排空输出再返回，避免后台子进程卡住工具调用。它将 `sudo` 改写为非交互模式，避免抢占 TUI 输入。
- `remember` 将非敏感的长期信息追加到每日记忆；它不会请求审批。

审批模式为 `always`、`unless_trusted`、`never`。在默认模式下，`list`、`glob`、`grep` 和 `read` 自动通过；白名单中的单个只读 bash 可执行名和精确 bash 命令自动通过；其他工具会显示 TUI 选择框。用户可只把某一条 bash 命令加入精确白名单。只读命令判断刻意拒绝 shell 组合符、路径形式的可执行文件和换行，以免把看似只读的组合命令误判为安全。

这里的“工作区工具”不是沙箱：文件路径、`bash.cwd`、`glob.cwd` 和 `grep.path` 可以是绝对路径，或通过相对路径离开工作区。文件读取会解析符号链接，写入会检查已有父目录的真实路径；这些机制用于获得规范化显示路径和处理链接，而非限制访问范围。审批是用户可见的授权层，不是操作系统级隔离。

## TUI 架构

`KanaTuiApp` 持有交互级状态：当前 Agent、会话 ID、运行标志、累计用量/成本，以及各个控制器。它不直接把模型事件渲染成 ANSI；`AgentEventRenderer` 负责把 `AgentEvent` 映射为助手消息块、工具块和状态栏阶段。

```text
ProcessTerminal（raw mode、输入、resize、通知）
  → Tui（焦点、16ms 合帧、差量重绘、硬件光标）
    → AppLayout
      ├─ Main（当前为 Transcript；使用终端 scrollback）
      └─ 底部（严格一个组件；分档高度）
         ├─ Editor（输入区和状态栏）
         ├─ ToolApproval
         ├─ Session / Skills / MCP 视图
         └─ ContentViewer
```

`Tui` 以组件的 `render(width, availableHeight?): string[]` 作为最小渲染协议。`AppLayout` 根据终端高度选择 15、12、9 或 7 行底部预算；终端不足 7 行时使用全部可用高度，其余高度传给 main。Layout 固定绘制底部区域首行作为 main/bottom 分隔线，将剩余预算传给底部组件，并为较短输出补空行，从而稳定两者的边界。Transcript 刻意忽略 main 的剩余高度提示，继续为终端 scrollback 渲染完整历史，并在有输出的子 Block 之间统一插入一行空白；Block 仅管理内容内部留白。`Tui` 缓存上次输出，尺寸不变时只重绘变化的行；改变已滚出视口的内容、缩小内容或终端尺寸改变时改用全量重绘。编辑器在逻辑行中插入内部光标标记，`Tui` 在写入终端前取走该标记；存在焦点组件时才将硬件光标移动到对应的可见宽度位置，没有焦点时则隐藏光标并留在布局末尾。渲染层以 grapheme 和 `string-width` 处理 CJK、emoji、ANSI 颜色和换行。

TUI 的主要控制器分别处理工具审批、会话选择/删除、全局 Skills 开关、MCP server 开关和 OAuth 操作、`!` 本地 Shell、记忆压缩和长工具输出查看。Session、Skill、MCP、审批和内容查看视图都会作为唯一底部组件替换编辑器。Skill 与 MCP controller 都会把 checkbox 修改保留在本地草稿中，直到 `Esc` 时一次性持久化有变化的选择；Skill 变更只重建一次 Agent 提示词，MCP 选择或已启用 server 的认证状态变化只请求一次 runtime reload。MCP 组件接收 server ID、transport、OAuth 安全状态，以及 stdio command/参数或 HTTP URL，但不会接收环境变量、HTTP headers 或 token；授权 URL 只临时放在 transcript block 中，完成后原位替换。MCP 视图打开、认证操作或 reload 进行中时，到期的 schedule wake 会继续排队。审批在其他底部视图活动时到达，会保持等待并发送已配置的通知，而不是抢占当前视图。`Ctrl+C`/`Esc` 优先中止当前 Agent、本地 Shell 或记忆任务；空闲时 `Ctrl+C` 退出。`Ctrl+O` 打开最近一项可展开的工具输出。

## 扩展时的检查点

- 新供应商应先实现 `Model` 的流协议，保证事件快照不与内部可变消息共享，并在 `providers` 工厂注册。
- 新工具应定义 TypeBox 参数、结构化结果和清晰的错误语义；若有流式进度，调用 `context.update`。
- 新增可改变工作区的工具时，应同时审视审批策略、TUI 的工具展示和会话持久化结果。
- 新增用户可见命令或面板时，应由 App 或独立 controller 协调状态，组件本身保持渲染/输入职责。
- 改动消息、事件或 session JSONL 格式前，必须同时检查 DeepSeek 请求转换、历史渲染、持久化解析和相关测试；这些格式是跨层契约。

后续文档可在此基础上分别展开配置与安装、Agent/工具协议、会话与记忆格式、Skills，以及 TUI 渲染实现。
