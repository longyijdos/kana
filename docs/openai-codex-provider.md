# OpenAI Codex 提供商适配

Kana 的 `openai-codex` adapter 位于 `src/providers/openai-codex`。它使用 ChatGPT Codex OAuth 凭据调用 Codex Responses Lite 流，并把 reasoning summary、可见文本和函数调用恢复为 `core` 的有序助手内容。

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
max_tokens = 32768
timeout_ms = 60000
max_retries = 1
```

可用模型和字段见[配置与安装](configuration.md)。

## 请求转换

`OpenAICodexModel` 向 `https://chatgpt.com/backend-api/codex/responses` 发送流式请求。Bearer token 和 ChatGPT account ID 只存在于请求 header，不写入日志或会话。

请求使用 Responses Lite 约定：

- 工具作为 developer `additional_tools` input item 发送，而不是顶层 `tools`。
- 系统提示词作为 developer message，用户消息、工具结果和助手 output item 按原顺序追加到 `input`。
- `store = false`、`stream = true`，并请求 `reasoning.encrypted_content`。
- reasoning 设置包含 `effort`、summary 类型和 `all_turns` context。
- `max_tokens` 只用于 Kana 的本地上下文输出预留；backend 请求不发送其拒绝的 `max_output_tokens`。

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
| `response.completed` / `response.incomplete` | 最终 stop reason 与 usage |

输出 item 以 `output_index` 为首选地址，并用 item ID 作为回退。完成事件中的最终内容会校正累计 delta；重复完成的 item 不会再次发出。`response.incomplete` 映射为 `length`，存在函数调用的完成响应映射为 `toolUse`，其余为 `stop`。

每个完成 item 都以不透明 `providerState` 附加到对应助手内容。后续回合会移除 server item ID，再原样回传 reasoning encrypted content、message 或 function call；这样 `store = false` 仍能延续推理状态。只有 summary 文本而没有供应商 item 时不会重建 reasoning input。

## 失败、重试与用量

首个 HTTP `401` 会触发一次凭据 refresh，并用新 token 重试请求。HTTP 408、429、5xx 和网络错误按有界指数退避重试；Agent 中止和无活动超时立即停止。明确的 context-window 拒绝会映射为 `ContextWindowExceededError`，供 Agent 在尚未产生输出时执行一次安全压缩恢复。

诊断日志使用稳定的 provider request、authentication refresh、retry 和 failure 事件，只记录供应商、模型、阶段、结果、错误类型或 HTTP 状态。日志不会记录 token、account ID、header、prompt、完整工具参数或响应体。

Responses usage 映射为输入、输出、缓存命中/未命中和 reasoning token。ChatGPT subscription 按 quota 而不是 Kana 的 API 计价结算，因此当前模型 metadata 的 CNY 成本为零。
