# 模型与供应商协议

Kana 让模型合同保持 provider-neutral，同时由各 adapter 持有自己的 wire 格式、认证、重试决策与 replay 规则。共享 provider 代码只提供窄的 HTTP、诊断、context-limit、Chat Completions 和 Responses primitive；它不是通用 runtime plugin 系统。

## 模型合同与 metadata

`Model` 暴露不可变 `metadata`、`stream(context)` 和 `generate(context)`。`BaseModel.generate()` 收集交互执行使用的同一条 event stream，因此流式与非流式调用不会形成两套行为路径。

`ModelMetadata` 描述具体所选模型，而不是笼统描述整个 provider：

| 字段 | 含义 |
| --- | --- |
| `provider`、`model` | 稳定的产品与模型身份。 |
| `protocol` | 共享 `responses`、`chat-completions`，进程内或专用模型使用 `null`。 |
| `contextWindow` | 模型 context 硬容量。 |
| `maxOutputTokens` | 单次 completion 的硬上限。 |
| `supportsParallelToolCalls` | 该 wire/模型组合能否请求并行调用。 |
| `supportsHostedWebSearch` | 模型能否使用 provider-hosted search。 |
| `supportsImageInput` | Provider 请求能否包含图片。 |
| `reasoning` | 可选的用户可选 effort 与模型自有默认值。 |

Metadata 表示能力，不是策略。Agent 会先与配置取交集再构造 `ModelContext`：模型即使支持图片、web search 或并行工具，也可能被策略关闭。Context 与输出偏好同样会先按 metadata 上限钳制，再交给 adapter。

`src/providers/index.ts` 是 DeepSeek、OpenAI Codex 与测试 Mock model 的 typed 内置工厂。Kana 的单一 Custom 槽位从已校验产品配置直接构造可复用 OpenAI-compatible model；不支持任意 provider ID 或 runtime 加载 adapter。

## Adapter 分层

```text
Agent ModelContext
  → provider adapter
      ├→ provider 自有 request、auth、retry loop 与 replay
      ├→ 共享 HTTP 和 lifecycle primitive
      └→ 适用时使用共享 wire processor
          ├→ OpenAI-compatible Chat Completions
          └→ semantic Responses SSE
  → AssistantMessageEvent stream
```

Adapter 始终负责 endpoint 选择、request 字段、认证，以及判断哪些失败可以安全重试。共享代码不会静默切换 provider、endpoint 或 protocol。

Provider 专属行为分别见 [DeepSeek](deepseek-provider.zh-CN.md)、[OpenAI Codex](openai-codex-provider.zh-CN.md)与[自定义 OpenAI-compatible](custom-provider.zh-CN.md)。

## 生命周期诊断

网络 adapter 使用统一诊断词汇描述 request start、HTTP retry、authentication refresh、Responses stream recovery、完成与失败。每条记录都有 provider、model、protocol、phase 和 outcome；重试与失败只增加 attempt、delay、HTTP status、Kana 固定 `errorCode`、安全 `errorType`、stream event type 或有界上游 `providerCode` 等安全字段。

Phase 包括 `validation`、`authentication`、`request_build`、`http_request` 与 `response_stream`。稳定 error code 区分取消、无活动 timeout、校验、认证、request 构造、HTTP/network 失败、stream 失败、临时 stream 失败和 context-window 超限。

诊断不会包含 API key、account ID、request header、endpoint URL、prompt、模型输出、工具参数、response body 或错误消息。Logger 失败会被隔离，不能改变 provider 控制流。

## 取消、无活动 timeout 与 HTTP 重试 primitive

共享 request signal 将可选 Agent abort signal 与无活动 timer 连接。Timer 覆盖等待 response header 的阶段，并由原始 response byte 刷新，包括 heartbeat 或不完整 SSE 数据。因此持续活动的长 stream 可以超过 `timeoutMs`；只有连续这么久没有传输数据才以 `timed_out` 中止。

上游取消与无活动 timeout 保持不同 outcome；二者都会停止接纳重试、中止等待中的 retry delay，并阻止后续请求。Adapter 在完整 request 生命周期结算后释放 timer 与连接的 listener。

共享 retry helper 把 HTTP `408`、`429` 和 `5xx` 识别为可重试，支持把 `Retry-After` 解析为秒数或 HTTP 日期并限制在 30 秒，否则使用 1、2、4、8 秒后保持 8 秒的指数延迟。Adapter 仍持有循环及其 `maxRetries` 预算。保留的 HTTP 错误体最多 16 KiB。

当前带认证 adapter 会拒绝 redirect，避免凭据被转发到另一个 origin。Provider 专属配置决定 endpoint 是否允许 HTTP；凭据需要穿过不可信网络时应使用 HTTPS。

## Context-window 规范化

只有在助手输出开始前收到明确 `ContextWindowExceededError`，Agent 才能执行一次安全压缩恢复。因此 provider helper 只会在 HTTP `400`、`413` 或 `422` 同时带有明确 context/window、prompt/input-token 结构化 code、有界消息信号或 adapter 显式信号时做规范化；普通参数错误保留原 provider error。

Adapter 可以扩展识别信号，但不能把模糊 server failure 变成自动 request replay。第二次 context rejection、已有部分输出或没有安全压缩边界时仍为终态；Agent 侧恢复合同见 [Agent 运行时](agent-runtime.zh-CN.md)。

## OpenAI-compatible Chat Completions

`src/providers/openai-compatible` 把稳定 system prompt、user/assistant/tool 历史和本地 function tool 转成流式 Chat Completions request。它发送 `stream_options.include_usage`，有工具时映射最终生效的并行标记，并且只在产品/模型配置提供时写入 `reasoning_effort`。

只有模型 metadata 开启图片输入时，用户图片才变成 data URL `image_url` part。Chat Completions 的 tool-role 消息不能携带图片，因此连续工具结果保持原位，随后用一条合成多模态 user observation 承载其图片。纯文本模型得到明确省略提示，不接收图片字节。

跨 provider replay 只发送可见助手文本和本地 function call；不会为通用 Chat Completions endpoint 重新解释 provider 自有 reasoning 或 hosted-tool 状态。

SSE reader 会保留跨网络 chunk 的不完整 frame，忽略只有 heartbeat 的 frame，增量装配有序 reasoning text、可见文本与工具调用，并把 `stop`、`length`、`tool_calls` 映射为 core stop reason。Kana 只请求一条助手消息，因此额外 choice 会被忽略。工具调用终止不完整或互相矛盾时按协议失败处理，不猜测输出。

## Semantic Responses 处理

`src/providers/responses` 负责使用 Responses SSE 的 adapter 共享语义装配，不负责构造 request 或认证。Processor 按 `output_index` 与 item ID 关联输出，把 reasoning、message、function call 和 `web_search_call` item 转成有序 core content 与 event。

完成的 provider item 作为不透明 `providerState` 保留，让所属 adapter 可以 replay 无状态会话。Core、Agent、session storage 与前端只保存、不解释该值。最终完成 item 可以修正累计 delta；重复 completion event 不会产生重复内容。

`response.completed` 及同类终态产生 `stop` 或 `toolUse`，incomplete response 产生 `length`。`error` 与 `response.failed` 保留安全上游身份，只把已知 overload、server、internal、temporary-unavailability 与 rate-limit 情况分类为临时错误。各 adapter 再根据剩余重试预算和是否已经开始输出决定能否 replay。

## Usage

所有 adapter 都把 provider 计数映射为 `ModelUsage`：prompt、completion 和 total token，以及可选 cache hit、cache miss 和 reasoning 计数。Kana 累加 provider 原始值，不估算价格。Context 占用使用 Agent 的可 replay context 估算除以最终有效 context limit，不把 provider 计费 input 直接视为持久历史。

## 新增或修改 adapter

- 保持 provider 输出为有序 core content，并发送完整克隆 snapshot。
- 把 endpoint、认证、request 转换、replay 与重试接纳留在 adapter 内。
- 只在 wire 语义真正一致时复用共享 codec。
- 网络 I/O 前按模型 metadata 校验 request budget。
- 窄化识别 context-limit failure，且绝不重试取消。
- 发送不含凭据、prompt、response 或 endpoint 数据的安全 lifecycle identity。
- 同步更新 provider metadata、配置选项、provider 专属文档和相应 request/stream 测试。
