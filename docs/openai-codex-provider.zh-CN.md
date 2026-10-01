# OpenAI Codex 提供商适配

Kana 的 `openai-codex` adapter 位于 `src/providers/openai-codex`。它使用 Sign in with ChatGPT（SIWC）OAuth 凭据调用公开 Responses API 流，并把 reasoning summary、供应商托管的网页搜索、可见文本和函数调用恢复为 `core` 的有序助手内容。

## 启用与认证

```bash
kana auth login openai-codex
kana auth status openai-codex
kana auth logout openai-codex
```

Kana 只管理一个账户注册。`login` 使用 Authorization Code、PKCE S256、state 和每次新生成的 OIDC nonce，在 `http://127.0.0.1:1455/auth/callback` 接收浏览器回调。没有已保存的 client ID 时，登录发送 `client_id=dynamic_agent_client`、`agent_name_hint=kana` 与持久化 UUID host ID；签发的 client ID 在换码前保存，换码失败后，下次 `login` 复用这条待完成注册。再次登录复用签发的 client ID 及保留的 ID token、邮箱提示。

Access token、ID token、轮换 refresh token、实际获批 scopes、到期时间及绑定信息保存在 `<KANA_HOME>/oauth-tokens.json` 的 `provider:openai-codex` 条目。文件的 `openaiCodex` 字段保存 `hostId`、已验证的 `registration`（`clientId`、`subject`、可选 `email`）及可选的 `pendingClientId`。已验证注册与凭据以 `0600` 权限原子写入。旧 Codex 凭据不会发送到新 API，只有新登录成功后才被替换。`kana install`、重新构建或替换二进制都不会删除凭据。

Kana 使用 OpenAI JWKS 验证 ID token 签名，并校验 issuer、签发 client 对应的 audience、到期时间、nonce 与再次登录账户的 subject。推理需要实际获批的 `chatgpt.tokens.use.direct` scope；只有身份授权的登录仍被保存，但套餐使用标记为关闭。之后用户显式执行 `login` 时，若缺少这项权限，会请求重新同意。换码和刷新均向 `https://auth.openai.com/api/accounts/oauth/token` 发送表单编码请求，并指定 `resource=https://api.openai.com/v1`。刷新省略 `scope`，保留未返回的替换字段，在 host 锁内重新读取凭据，避免多个进程同时轮换 token。终止性刷新错误只清除 token，保留注册信息。

`status` 显示安全的账户信息与套餐使用授权状态。`logout` 使用 OpenAI discovery document 提供的端点尝试撤销 refresh token，然后清除本地 token，保留 client 注册与 host ID；无法确认远程撤销时，会说明本地退出已完成并引导用户前往 ChatGPT 设置。模型名称及能力 metadata 继续由 Kana 静态维护。

切换账户或工作区需手动操作：先运行 `logout`，按需备份注册信息，再从 `oauth-tokens.json` 删除 `openaiCodex.registration`、`openaiCodex.pendingClientId` 和 `tokens["provider:openai-codex"]`。保留 `openaiCodex.hostId`、其他 token 和 MCP client 注册信息。下次 `login` 会创建新注册。是否在 ChatGPT 设置中断开旧应用注册由用户自行决定；logout 撤销的是会话，不会删除该注册。

Provider 传输设置与 Agent 模型选择分开配置：

```toml
[provider.openai-codex]
reasoning_summary = "auto"
timeout_ms = 60000
max_retries = 1

[agent]
web_search = true
image_input = true

[agent.model]
provider = "openai-codex"
name = "gpt-5.6-luna"
reasoning_effort = "medium"
max_output_tokens = 128000
```

可用模型和字段见[配置与安装](configuration.zh-CN.md)。

## 模型 metadata

Kana 静态维护模型目录。上下文上限和推理控制遵循 SIWC/Codex 账户目录，可能与 API key 对应的模型规格不同。`contextWindow` 使用目录中的 `max_context_window`，因此未配置 `context_limit` 时，它也决定 Agent 的默认上下文预算。目录中较小的默认 `context_window` 不作为这里的上限。账户目录接口见 [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

| 模型 | 上下文上限 | 默认推理强度 |
| --- | --- | --- |
| `gpt-6.1-sol` | 872,000 | `low` |
| `gpt-6-astra` | 872,000 | `low` |
| `gpt-6-sol` | 872,000 | `medium` |
| `gpt-6-luna` | 872,000 | `medium` |
| `gpt-5.6-sol` | 872,000 | `low` |
| `gpt-5.6-terra` | 872,000 | `medium` |
| `gpt-5.6-luna` | 872,000 | `medium` |
| `gpt-5.5` | 272,000 | `medium` |

表中所有模型均支持图片输入、并行函数调用和托管网页搜索，输出上限按公开[模型参考文档](https://developers.openai.com/api/docs/models/gpt-6.1-sol)设为 128,000 token。推理强度为 `low`、`medium`、`high`、`xhigh` 和 `max`，但 GPT-5.5 最高为 `xhigh`。Ultra 是客户端编排能力，不作为 wire reasoning effort。目录中的隐藏条目不纳入模型列表。

## 请求转换

`OpenAICodexModel` 向 `https://api.openai.com/v1/responses` 发送流式请求。OAuth access token 作为 Bearer 凭据发送，不需要 ChatGPT account-ID header。token 不写入日志或会话。

请求完整使用一套 classic Responses 约定：

- Kana 本地执行的函数工具组织在顶层 `tools` 数组的 `kana` namespace 中。`web_search = true` 时，供应商托管的 `{ "type": "web_search" }` 工具追加到同一个数组，并由模型按 `tool_choice: "auto"` 决定是否使用；设为 `false` 时只移除托管工具，客户端函数工具仍然可用。
- 系统提示词使用顶层 `instructions`；用户消息、工具结果和助手 output item 继续按原顺序保留在 `input`。
- 用户图片附件会转换为带自包含 data URL 的 classic Responses `input_image` item。同一个实际能力开关会注册 `view_image`，其视觉结果成为与原调用关联的原生多模态 `function_call_output` 内容。上下文压缩会发送用户和工具图片，让摘要把视觉细节保存为文本。`image_input = false` 时会移除该工具、不发送图片字节，并改为追加明确的文本省略提示。
- `store = false`、`stream = true`，并请求 `reasoning.encrypted_content`。
- `parallel_tool_calls` 使用经过模型能力判断后的 Agent 有效设置。静态目录中的所有模型均支持并行调用；用户策略关闭并行，或工具执行 metadata 不允许并发时，ToolRuntime 仍会串行执行。
- reasoning 设置包含 `effort` 与 summary 类型，但省略 `reasoning.context`，由 backend 决定实际的持久化推理模式。可用强度与默认值来自所选模型的 metadata。
- Kana 会通过 Agent 模型配置的 `max_output_tokens` 与剩余 context 计算逐轮 `ModelContext.maxOutputTokens`。SIWC 预览协议不支持 `max_output_tokens`，因此 wire request 仍省略该字段。
- 本地函数调用回放保留 `kana` namespace，包括迁移前保存的调用。Kana 继续使用自己的工具执行与 MCP 集成；适配器不声明此接口不支持的托管 MCP、`tool_search`、图片生成与 Code Interpreter。

Codex 的 reasoning summary 不是原始思维链。Kana 可以流式接收 summary 并产生 thinking 事件，但 TUI 只用这些事件显示临时 thinking 状态，不展示摘要正文。

## SSE 与有序内容

reader 会保留跨网络分片的不完整 SSE 帧，并在一个 body chunk 包含多个帧时逐帧解析。主要事件映射是：

| Codex SSE | Kana event |
| --- | --- |
| reasoning `response.output_item.added` | `thinking_start` |
| `response.reasoning_summary_text.delta` | `thinking_delta` |
| reasoning `response.output_item.done` | `thinking_end` |
| message `response.output_item.added` | `text_start` |
| `response.output_text.delta` / `response.refusal.delta` | `text_delta` |
| message `response.output_item.done` | `text_end` |
| function call added / argument delta / item done | `toolcall_start` / `toolcall_delta` / `toolcall_end` |
| web-search-call added / item done | `hosted_tool_start` / `hosted_tool_end` |
| `response.completed` / `response.incomplete` | 最终 stop reason 与 usage |

输出 item 以 `output_index` 为首选地址，并用 item ID 作为回退；多个函数调用的参数 delta 可以交错到达，仍会回填各自的内容块。`web_search_call.action` 会规范化保留 `search`、`open_page` 或 `find_in_page` 及其查询、URL 和页内模式。完成事件中的最终内容会校正累计 delta；重复完成的 item 不会再次发出。`response.incomplete` 映射为 `length`，存在本地函数调用的完成响应映射为 `toolUse`，只有托管搜索的响应仍映射为 `stop`。

每个完成 item 都以不透明 `providerState` 附加到对应助手内容。后续回合会移除 server item ID，再回传 reasoning encrypted content、message、function call 或 `web_search_call`，其中本地函数调用会补充 `kana` namespace；这样 `store = false` 仍能延续推理和搜索上下文。只有 summary 文本而没有供应商 item 时不会重建 reasoning input。

## 搜索展示与引用

托管搜索不会进入 Kana 的 ToolRuntime、审批流程或工具结果消息。TUI 按供应商顺序为每个 `web_search_call` 单独显示一个动作块：进行中显示 `Searching the web`，完成后根据 action 显示 `Searched the web`、`Opened a web page` 或 `Searched within a web page`，并附上经过控制字符清理和长度限制的查询或页面目标。当前不聚合多个搜索调用；每个可见动作块及其后的助手正文之间保留一行空白，与 transcript 的其他块一致。

最终 message 的 `output_text.text` 按供应商返回内容原样进入 Markdown 渲染；其中已有的行内 Markdown 链接会继续显示链接文字和 URL。`url_citation` annotations 连同完成 message 保留在 `providerState` 中，Kana 不向正文回插 `[1]` 编号，也不额外生成 `Sources` 尾注。协议字段和 action 定义见 [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。

## 失败、重试与用量

首次 HTTP `401` 会触发一次凭据刷新和一次重试。ChatGPT 套餐用量上限错误会停止请求、不重试，并提供 `https://chatgpt.com/settings/usage` 链接；暂时性的用量检查或用户信息故障可在输出开始前重试。错误保留可用的 HTTP 状态、响应形态、错误码、参数与 request ID，包括 stream 开始后的失败。HTTP 失败与已识别的暂时性 Responses 失败共享配置的重试预算；只有在助手输出或托管搜索活动开始前才允许恢复 stream。上下文超限拒绝可以在输出开始前进入 Agent 的一次安全压缩恢复。

其余取消、无活动超时、重试、错误体边界、诊断和用量行为遵循[供应商](providers.zh-CN.md)。适配器记录订阅 token 用量而不估算金额。
