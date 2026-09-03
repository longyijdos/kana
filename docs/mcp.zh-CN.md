# Model Context Protocol

Kana 把 MCP 实现为相互独立的 JSON-RPC、client lifecycle、transport、authorization、tool adaptation、multi-server 与产品 runtime 边界。远端工具通过普通 `Tool` 合同进入 Agent；Agent loop 和 provider adapter 都不了解 MCP。

## 分层

```text
KanaMcpRuntime（可 reload 的产品边界）
  → McpManager（多 server 启动、过滤、冲突与诊断）
      ├→ McpToolAdapter → Tool
      └→ McpManagedClient
          ├→ McpClient（稳定 2025-11-25 lifecycle 与 tool method）
          │   → McpConnection（JSON-RPC 关联、timeout、取消与 progress）
          │       → StdioTransport | StreamableHttpTransport
          └→ 可选 McpOAuthHttpAuthorizer
              → protected-resource discovery → OAuthSession
```

`McpConnection` 和 transport 与版本无关；`McpClient` 持有稳定协议 lifecycle。`McpManager` 依赖结构化 managed-client interface，而不是具体 client，因此可以引入另一协议版本而无需改变工具聚合。

## JSON-RPC connection

协议 parser 接受 JSON-RPC 2.0 request、notification 和 response，ID 可以是 string 或 integer。Request 与 notification 要求 object 参数；response 必须且只能包含 object result 或结构化 error。格式错误或有歧义的消息属于协议失败。

`McpConnection` 分配 request ID、关联乱序 response，并拒绝未知或重复 ID；只有属于本地已取消 request 的有界 ID 集合例外。每个 request 有配置或默认 timeout。Abort 或 timeout 会移除关联状态、拒绝调用方，并通常发送 `notifications/cancelled`；initialize 等协议禁止取消的操作可显式标记为 non-cancellable。

带 progress callback 的 request 会在 `_meta` 获得唯一 progress token。`notifications/progress` 必须为活动 token 提供 finite 且严格递增的值。Callback failure 会报告，但不会破坏 request。Connection 会响应 server `ping` request，其它 server request 返回 method-not-found。

协议、transport 或解析失败会拒绝全部 pending request 并关闭 transport。显式 close 幂等，并且会先拒绝 pending work，再等待 transport cleanup。

## 稳定 Client 生命周期

`McpClient` 实现协议版本 `2025-11-25`。`initialize` 是第一条 request，使用独立 startup timeout；只有 server 返回同一受支持版本后，client 才发送 `notifications/initialized`。Client startup 接受 abort signal；取消 initialize 会关闭 connection 与 transport，但不会发送协议禁止用于 initialization 的取消 notification。Client 会快照 server identity 与 capability。

Tool method 要求 server 声明 tools capability。`tools/list` 跟随分页、拒绝重复 cursor，并有有限 page 上限。`tools/call` 支持取消与 progress，并校验返回 content envelope。Server notification 会暴露给集成层，但 Kana 刻意固定 startup tool list，只记录 `notifications/tools/list_changed`，不修改活动 Agent。

Streamable HTTP 报告活动 session 过期时，client 会按该 session generation 合并恢复，并重新 initialize，但不会 replay 触发操作。恢复成功后的错误会告诉 Agent 可以显式再次调用；若替换 session 在恢复期间再次过期，client 会关闭，等待中的操作失败。工具可能已经产生副作用，因此禁止自动 replay。

## Stdio transport

`StdioTransport` 通过 Bun 直接启动参数数组，不经过 shell，并把 server 放入独立 process group。Stdout 使用 newline-delimited UTF-8 JSON-RPC，默认 message 上限 4 MiB。非法 UTF-8/JSON、超限或不完整消息、协议污染与意外进程退出都会使 transport 失败。

Stderr 与协议 framing 分离，进入受保护诊断 callback。Send 即使有一次失败也保持串行。优雅 close 会等待排队写入、关闭 stdin、等待 shutdown timeout，再向进程组发送 SIGTERM；第二段 timeout 后发送 SIGKILL。Monitor 与 close callback 只报告一次。

Kana 的 stdio 装配只继承少量基础环境。显式 `env` 值支持从 Kana 进程环境解析 `${NAME}` 与 `${NAME:-fallback}`；缺少必需值会使该 server 失败。Server stderr 有界后写入当前 session logger。

## Streamable HTTP transport

`StreamableHttpTransport` 实现 `2025-11-25` 单 endpoint transport。它拒绝 endpoint 凭据、fragment，以及对 transport 自有 header 的配置覆盖。每条 JSON-RPC message 用独立 POST，接受 JSON 或 SSE；`202` 只对 notification 合法。Initialize 会读取可选 `Mcp-Session-Id`，后续操作携带该 ID 与协商协议版本。

共享 SSE decoder 处理跨 chunk CR/LF framing、严格 UTF-8、event byte 上限、event ID 与 retry value。Response stream 在收到 request response 前结束但已有 event ID 时，会通过 `Last-Event-ID` GET 恢复，而不是 replay POST。Initialize 后还会尝试独立 GET server stream；普通 EOF 或网络读取失败会在 server 指定或默认延迟后，用最后完成 event ID 重连。

非法 UTF-8、SSE、JSON、不支持 content type、超限 event、错误 response ID 和其它协议失败都是 fatal。带 session ID 的 request 收到 HTTP `404` 时，会把该 session 标为过期并交给 client 层恢复。可识别 OAuth `401/403` challenge 只影响当前 request，authorization 可以恢复而不破坏 transport state。

取消会先发送协议 notification，再中止匹配 HTTP operation。Shutdown 停止重连、中止剩余 stream、在有界时间内等待活动 operation，并在存在 session 时发送有界 DELETE。Legacy `2024-11-05` HTTP+SSE transport 不会被自动检测或混入这套状态机。

## HTTP authorization

`McpOAuthHttpAuthorizer` 为一个 protected resource 包装 fetch 边界。它规范化 HTTPS resource，从 Bearer challenge 或 well-known URL 发现 protected-resource metadata，验证返回 resource，要求 authorization-server issuer，并拒绝不支持 Authorization-header Bearer token 的 metadata。

Authorizer 使用通用 [OAuth](oauth.zh-CN.md) 完成 authorization-server discovery、PKCE、callback、token exchange、refresh 与注入式 token storage。它为准确 resource 持有一个 session，并把凭据限制在 origin 和 path 都仍属于该 endpoint 的 request。

Preparation 先尝试持久或 refresh 后的凭据，需要时在 MCP initialize 前完成交互 authorization。若 metadata 只能通过 challenge 获得，会在 initialize timeout 开始前用幂等 HEAD probe 获取。Request challenge 最多通过持久 token、refresh 或交互 authorization 恢复一次；第二次 challenge 返回调用方。

显式配置 scopes 优先。如果 challenge 请求集合之外的 scope，automatic privilege expansion 会被拒绝并记录诊断。Retry 使用 request 副本，不复用已消费 body。Close 期间 DELETE 只能使用内存里最后保留的 token；transport 删除 session 前会冻结新 authorization 与 refresh。

Kana 用 `mcp:<server-id>` 保存凭据，提供浏览器打开和 owner-only token 持久化，并让 OAuth metadata/token request 与 MCP transport 使用同一 proxy 策略。

## 远端工具适配

Discovery 时，`McpToolAdapter` 预编译远端 JSON Schema，并创建普通 Kana `Tool`。Provider 可见 alias 是 server ID 与远端名称的确定性清理组合，最长 64 字符；原始 remote name 与 server identity 继续用于调用、诊断、审批展示和结果 metadata。

Adapter 把 invocation abort 与 request timeout 传给 `tools/call`，将递增 MCP progress 映射为有界 `ToolContext.update()`。JSON-RPC response error 会成为结构化工具错误，不会逃出 Agent loop。

结果规范化会独立限制 item 数、自然文本、结构化 JSON、模型可见 content 与 metadata。Text 与嵌入 text resource 可以进入模型 content，resource link 变成说明。Image、audio 与 blob payload 只保留安全 type、MIME 和估算 byte metadata；远端 binary 不会作为视觉观察复制进 session。MCP `isError` 与 JSON-RPC error 语义在结构化结果中保持不同。

之后仍可应用通用 Agent tool-result policy，收紧 model-context 上限或创建 text artifact；见[工具与执行](tools.zh-CN.md)。

## Multi-server manager

`McpManager` 快照 registration，并发启动 server，并按 registration 顺序聚合成功工具。`includeTools` 与 `excludeTools` 匹配原始远端名称。每个 server 原子适配：重复 remote name 或一个已选择 schema 非法都会使该 server 失败，而不会暴露一组不完整、依赖顺序的工具。

可选 server failure 被隔离、记录并关闭；任一必需 server failure 会关闭所有 client 并中止 startup。Server 之间或与保留 Kana tool 的 alias collision 会使完整聚合失败，不会覆盖工具或分配不稳定 suffix。

诊断暴露复制后的 server identity、required 标记、lifecycle status、发现与保留 tool count、capability 与安全 error identity。Progress 报告 completed/total server count 和每个终态 startup/close outcome。Listener failure 被隔离。Startup 接受 abort signal，并把取消与 server failure 诊断分开。Close 幂等；若 startup 仍在进行，会先请求取消并等待其完成清理，再按 registration 逆序释放 client。

## Kana 配置与启用状态

`<KANA_HOME>/mcp.json` 保存已校验 server 定义；`<KANA_HOME>/mcp-enabled.json` 只保存选中 ID。文件不存在时分别视为空定义或空启用状态。只有 ID 同时出现在两者中时，配置 server 才启动。准确字段与示例见[配置与安装](configuration.zh-CN.md)。

省略 server `type` 表示 stdio，HTTP 必须显式声明。产品工厂为所选 server 构造 transport、稳定 client、可选 OAuth authorizer、filter、request timeout、logger callback 与保留 tool-name 集合。Config 与可变集合会在异步 startup 前快照。

HTTP `proxy` 是 Kana/Bun 装配职责。URL 通过 Bun fetch extension 传入；`false` 只在同步调用 fetch 期间把目标 hostname 加入 `NO_PROXY` 与 `no_proxy`，yield 前恢复两项变量；省略时保留默认进程路由。同一 fetch wrapper 注入 MCP 与 OAuth。

## Runtime 与前端集成

`KanaMcpRuntime` 持有可替换的一次性 manager，并串行执行 `start`、`reload` 与 `close`。Reload 先关闭旧 manager，再重新读取配置和启用状态，随后发布新的 detached tool/diagnostic snapshot。Start 与 reload 接受 operation abort signal。取消会清除该操作的 tool snapshot 并关闭其一次性 manager，但不会永久关闭 runtime，因此与失败一样，之后仍可通过 reload 恢复。一旦请求 runtime close，排队 lifecycle work 不能再创建 manager。

主对话最初没有外部工具。交互式 startup 会等所选 session 可见后再加载 MCP 并重建 Agent，因此 resume picker 没有 server side effect。Headless 在提交 run 前启动 MCP。Clean 模式不读取 MCP 配置，也不创建 runtime external tool；memory-consolidation Agent 永远不接收 MCP tool。

TUI 负责 selection draft、OAuth action、lifecycle transcript block、focus 与 retry 交互，不负责协议或 transport state。Headless 不会打开浏览器，需要预先通过 TUI 完成交互 OAuth。共享 conversation shutdown 先结算 Agent，再由产品 Host 关闭 MCP；见[对话运行时](conversation-runtime.zh-CN.md)。

## 安全与扩展约束

- 把 MCP tool 视为不可信外部能力；它们走普通审批，默认 exclusive 执行。
- 不记录 header、token、endpoint URL、session/event/progress ID、request 参数、工具参数或完整结果。
- 保持 transport framing 与版本协商、feature method 分离。
- 新稳定协议版本应使用独立 client lifecycle，不在 runtime 猜测版本。
- 不自动 replay timeout、cancelled、session-expired 或 authorization-challenged tool call。
- 把配置解析和 proxy 行为留在 Kana composition，而不是通用 MCP package。
- 保持 manager 一次性合同；live replacement 通过 `KanaMcpRuntime` 实现。
