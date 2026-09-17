# Model Context Protocol

Kana 为已启用 MCP server 创建两个依赖运行时能力的内置工具：`mcp_activate` 读取 server 工具目录，`mcp_call` 调用远端工具。官方 TypeScript client SDK 持有协议和 transport。Agent loop 和 provider adapter 都不感知 MCP。

## 分层

```text
createKanaAgent → mcp_activate + mcp_call
                      ↓
KanaMcpRuntime（可 reload 的 registry 能力）
  → McpManager（启动、过滤、目录与诊断）
      ├→ McpToolAdapter（远端 schema 校验与结果适配）
      └→ McpClient → 官方 SDK Client
          ├→ SDK StdioClientTransport | StreamableHTTPClientTransport
          └→ 可选 McpOAuthHttpAuthorizer → OAuthSession
```

`McpClient` 是 `@modelcontextprotocol/client` 的薄适配层。SDK 处理 JSON-RPC 解析与请求关联、版本协商、初始化、工具目录分页、请求超时、取消、进度和 transport framing。Kana 为普通工具管线转换协议错误，并区分调用方取消与超时。

Client 使用 SDK 自动协商现代与旧版协议。协议版本由 SDK 维护，不作为任意配置字符串暴露。Kana 支持 Streamable HTTP 和 stdio，不配置旧版独立端点 HTTP+SSE transport。

## 渐进式工具目录

启动时连接已启用 server，并在内部缓存过滤后的工具定义。模型最初只看到 `mcp_activate` description 中的 server 名称与简介，以及两个入口的 schema。可选 server `description` 覆盖 server 自身提供的简介；两者都缺省时，目录仍包含 server 名称。

```text
mcp_activate({ name: "github" })
  → { server: "github", tools: [{ name, description, inputSchema }, ...] }

mcp_call({
  server: "github",
  tool: "get_issue",
  arguments: { owner: "longyijdos", repo: "kana", issue_number: 138 }
})
  → 规范化的远端结果
```

`mcp_activate` 读取缓存目录，不连接额外 server、不改变用户启用状态、不授予权限，也不修改 provider-facing tools 数组。完整 schema 作为普通工具结果追加到对话历史。因此读取目录期间工具定义保持稳定；provider 缓存仍取决于请求其余部分。

目录通过可选 `offset` 与 `limit` 分页，默认每页 20 个工具，最多 50 个。返回 `nextOffset` 表示还有下一页。普通 Agent content 上限与 artifact 策略仍适用；结果转存 artifact 后，模型需读取文件取得完整 schema。目录可以重复读取，包括 context compaction 之后。不存在会在历史压缩后阻碍重新发现或调用的临时激活标记。

Agent 装配读取当前 MCP registry，仅当 server 目录非空时创建入口。要暴露两种能力，需在 `agent.tools` 中同时选择两个入口名；都不选择时会禁用 Agent 访问，但不改变 server 启用状态或 `/mcp` 管理。MCP runtime 不向 Agent 注入远端工具或入口实例。

只有 ready server 以及 `includeTools`/`excludeTools` 保留的工具可用。`mcp_call` 按 `(server, 远端工具原名)` 定位，并在远端调用前，使用缓存的远端 JSON Schema 校验嵌套 `arguments`。Provider 只校验入口 envelope，具体远端 schema 由 Kana 执行校验，不依赖原生逐工具约束解码。

远端名称不会加入 Agent registry。不同 server 可使用相同工具名，也可与 Kana 内置工具或入口名称相同。无需 alias、provider 名称净化或跨 server 保留名称聚合。同一 server 内的重复名称仍无效，因为它们使分发产生歧义。

## 调用与结果

`mcp_activate` 是 parallel 目录读取，永不请求审批。`mcp_call` 默认 exclusive，遵循普通审批策略。TUI 审批显示 server、远端工具原名与完整嵌套参数，不提供持久 MCP 信任选项。

入口通过 adapter 将调用 abort signal 和进度更新传给 SDK。配置的请求超时与普通 Agent deadline 仍适用。JSON-RPC 错误变成结构化工具错误，远端 `isError` 保持独立结果语义。调用方 abort 保留取消原因。

发现时使用 Kana 工具校验器预编译选中 input schema。不受支持的 schema 会让该 server 原子失败。结果规范化分别限制 item 数、自然文本、结构化 JSON、模型 content 与 metadata。文本及内嵌文本资源可进入模型 content，resource link 转成描述。Image、audio 与 blob 只保留类型、MIME 和估算字节数，不把远端 binary 复制进 session 作为视觉观察。

普通 Agent 结果策略可继续收紧 context 上限或生成文本 artifact，见[工具与执行](tools.zh-CN.md)。

## Transport 与授权

SDK stdio 直接启动 command 与参数数组，不经过 shell；它处理 stdout MCP framing 与子进程清理。Kana 提供受限基础环境和展开后的显式 `env`，SDK 另包含平台相关的安全默认变量。`${NAME}` 与 `${NAME:-fallback}` 从 Kana 进程环境解析；缺少必需变量会使该 server 失败。Server stderr 与协议消息分开，并在写入诊断日志前限制长度。

SDK Streamable HTTP transport 处理 JSON/SSE、session 与协议 header、stream resumption 和重连。Kana 校验 endpoint 配置及 transport-owned header，注入逐 server 的代理与授权 fetch 边界。旧版 HTTP session 关闭时先通过 SDK 尝试删除会话，限时五秒，再关闭本地 transport 资源。Kana 不再实现独立的 session 过期重初始化状态机；session 错误返回 Agent，显式 runtime reload 可重新连接 server。

`McpOAuthHttpAuthorizer` 使用 SDK helper 解析 Bearer challenge 与发现 protected-resource metadata，再校验 resource 绑定、authorization server 可用性和 header Bearer 支持。通用 [OAuth](oauth.zh-CN.md) 处理 authorization-server discovery、PKCE、浏览器回调、token exchange、refresh 与 token-session storage 契约。Kana 保留精确 resource 凭据边界与已注册 client 配置。

Prepare 先尝试存储或刷新的凭据，必要时在 MCP 协商前完成交互授权。仅 challenge 提供 metadata 时，通过幂等 HEAD probe 在协议启动超时前取得它。请求 challenge 最多恢复一次，第二次 challenge 返回调用方。显式配置 scopes 始终是权限边界，不允许自动扩大到边界之外。Close 冻结新授权与 refresh；DELETE 只能使用内存中已保留的最后 token。

凭据存储 key 为 `mcp:<server-id>`。Kana 提供浏览器打开与 owner-only token 持久化，并将 OAuth metadata/token 请求和 MCP 请求应用相同代理策略。代理 URL 和凭据不会进入诊断 metadata。

## Manager 与 runtime 生命周期

`McpManager` 快照 registration，并发启动 server，按 registration 顺序保留成功目录。过滤器匹配远端原名。每个 server 原子适配：重复远端名称或一个选中 schema 无效都会使该 server 失败，不暴露部分工具集。

可选 server 失败会被诊断、关闭与隔离。必需 server 失败会关闭全部 client 并中止启动。Diagnostic 包含复制的 server identity、生命周期状态、capability、发现与保留工具数及错误身份。Progress 报告 completed/total 数与终态结果。Startup 接受 abort signal，取消与 server 失败区分。Close 幂等，等待 startup 退出，并按 registration 逆序释放 client。

每个 manager generation 的目录固定。`notifications/tools/list_changed` 只诊断，不修改当前入口目录。`KanaMcpRuntime` 串行处理 start、reload 与 close。Reload 关闭旧 manager，从 Host 的定义和启用快照重新连接，再发布 ready registry 与 diagnostic。取消或失败会使 registry 不可用，并允许之后 reload；已关闭 runtime 不能复活。

## 配置与前端集成

`<KANA_HOME>/mcp.json` 保存 server 定义，`<KANA_HOME>/mcp-enabled.json` 保存启用 ID。只有同时出现在两者中的 server 才启动。用户的 `/mcp` 操作改变启用状态；模型的 `mcp_activate` 仅读取目录。直接修改文件需要重启。完整配置字段见[配置与安装](configuration.zh-CN.md)。

主对话初始无 MCP 入口。交互启动先显示所选 session，再加载 MCP 并用两个入口重建 Agent。Headless 在提交 run 前初始化 MCP，并要求交互 OAuth 已提前完成。Clean mode 不创建 MCP 工具。Memory-consolidation Agent 永不获得 MCP 工具。

Subagent 角色卡通过列出 `mcp_activate` 与 `mcp_call` 获得 MCP 能力。全局 `agent.tools` 选择仍是这些权限的上限。它们覆盖全部当前已启用、经过过滤的 MCP 能力，不表达逐 server 或逐远端工具权限。不支持旧远端 alias 与 `mcp:*`。见 [Subagent](subagents.zh-CN.md)。

TUI 持有选择、授权操作、生命周期展示、焦点与重试交互。共享对话 shutdown 先结算 Agent，再由 Host 关闭 MCP。见 [TUI](tui.zh-CN.md) 与[对话运行时](conversation-runtime.zh-CN.md)。
