# OpenAI Codex 提供商适配

Kana 的 `openai-codex` adapter 位于 `src/providers/openai-codex`。它使用 ChatGPT Codex OAuth 凭据调用 Codex Responses Lite 流，并把 reasoning summary、供应商托管的网页搜索、可见文本和函数调用恢复为 `core` 的有序助手内容。

## 启用与认证

```bash
kana auth login openai-codex
kana auth status openai-codex
kana auth logout openai-codex
```

`login` 使用固定的公开 client ID、Authorization Code 与 PKCE S256，在 `http://localhost:1455/auth/callback` 等待浏览器回调。成功后的 access token、ID token、refresh token、到期时间和绑定信息写入 `<KANA_HOME>/oauth-tokens.json` 的 `provider:openai-codex` 条目。token 文件以 `0600` 写入；`kana install`、重新构建或替换 Kana 二进制都不会删除它。

供应商需要 ChatGPT account ID。Kana 优先从 ID token 读取，缺失时再从 access token 的 JWT claim 读取。到期 token 会通过 refresh token 自动更新；Codex token endpoint 当前 refresh 请求使用 JSON，而首次 authorization-code exchange 保持表单编码。token response 可以省略 `token_type`，Kana 在这个供应商边界将其按 Bearer 处理。

配置通过供应商分表选择：

```toml
[provider]
active = "openai-codex"

[model.openai-codex]
name = "gpt-5.6-luna"
reasoning_effort = "medium"
reasoning_summary = "auto"
web_search = true
max_tokens = 128000
timeout_ms = 60000
max_retries = 1
```

可用模型和字段见[配置与安装](configuration.md)。

## 请求转换

`OpenAICodexModel` 向 `https://chatgpt.com/backend-api/codex/responses` 发送流式请求。Bearer token 和 ChatGPT account ID 只存在于请求 header，不写入日志或会话。

请求使用 Responses Lite 约定：

- Kana 本地执行的函数工具作为 developer `additional_tools` input item 发送，而不是顶层 `tools`。
- `web_search = true` 时，供应商托管的搜索工具单独作为顶层 `tools: [{ "type": "web_search" }]` 声明，并由模型按 `tool_choice: "auto"` 决定是否使用；设为 `false` 时不发送该字段。
- 系统提示词作为 developer message，用户消息、工具结果和助手 output item 按原顺序追加到 `input`。
- `store = false`、`stream = true`，并请求 `reasoning.encrypted_content`。
- `parallel_tool_calls = false`。Responses Lite 不支持顶层并行工具调用，因此模型 metadata 会覆盖 `agent.parallel_tool_calls = true`；Kana 也会串行执行意外出现的多个调用。
- reasoning 设置包含 `effort`、summary 类型和 `all_turns` context。Responses Lite 的 `effort` 仅支持 `low`、`medium`、`high`、`xhigh` 和 `max`；Ultra 属于 Codex 客户端编排模式，Kana 不会将其作为请求强度发送。
- Kana 会通过配置的 `max_tokens` 与剩余 context 计算逐轮 `ModelContext.maxOutputTokens`；backend 不接受该字段，因此请求仍不发送其拒绝的 `max_output_tokens`。

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

每个完成 item 都以不透明 `providerState` 附加到对应助手内容。后续回合会移除 server item ID，再原样回传 reasoning encrypted content、message、function call 或 `web_search_call`；这样 `store = false` 仍能延续推理和搜索上下文。只有 summary 文本而没有供应商 item 时不会重建 reasoning input。

## 搜索展示与引用

托管搜索不会进入 Kana 的 ToolRuntime、审批流程或工具结果消息。TUI 按供应商顺序为每个 `web_search_call` 单独显示一个动作块：进行中显示 `Searching the web`，完成后根据 action 显示 `Searched the web`、`Opened a web page` 或 `Searched within a web page`，并附上经过控制字符清理和长度限制的查询或页面目标。当前不聚合多个搜索调用；每个可见动作块及其后的助手正文之间保留一行空白，与 transcript 的其他块一致。

最终 message 的 `output_text.text` 按供应商返回内容原样进入 Markdown 渲染；其中已有的行内 Markdown 链接会继续显示链接文字和 URL。`url_citation` annotations 连同完成 message 保留在 `providerState` 中，Kana 不向正文回插 `[1]` 编号，也不额外生成 `Sources` 尾注。协议字段和 action 定义见 [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。

## 失败、重试与用量

首个 HTTP `401` 会触发一次凭据 refresh，并用新 token 重试请求。HTTP 408、429、5xx 和网络错误按有界指数退避重试；Agent 中止和无活动超时立即停止。明确的 context-window 拒绝会映射为 `ContextWindowExceededError`，供 Agent 在尚未产生输出时执行一次安全压缩恢复。

诊断日志使用稳定的 provider request、authentication refresh、retry 和 failure 事件，只记录供应商、模型、阶段、结果、错误类型或 HTTP 状态。日志不会记录 token、account ID、header、prompt、完整工具参数或响应体。

Responses usage 映射为输入、输出、缓存命中/未命中和 reasoning token。ChatGPT subscription 按 quota 而不是 Kana 的 API 计价结算，因此当前模型 metadata 的 CNY 成本为零。
