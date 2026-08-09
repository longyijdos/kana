# DeepSeek 提供商适配

Kana 的产品配置当前使用 DeepSeek；实现位于 `src/providers/deepseek`。模型元数据负责选择共享 wire protocol：V4 Flash 使用 Responses API，V4 Pro 则在 DeepSeek 官方提供 Responses 支持之前继续使用 Chat Completions。两条路径都会把流式输出恢复为相同的有序助手内容。

## 模型与元数据

`DeepSeekModel` 继承 `BaseModel`。`stream(context)` 同步返回 `AssistantEventStream`，真实网络请求在后台异步写入该流；`generate()` 因而只是收集同一条流，不会走另一套非流式路径。

当前内置元数据：

| 模型 | 协议 | 上下文窗口 | 最大输出 | 并行工具调用 | 托管网页搜索 | 图片输入 | 输入 / 输出 / 缓存读取价格（CNY/百万 token） |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `deepseek-v4-flash` | Responses | 1,000,000 | 384,000 | 支持 | 支持 | 不支持 | 1 / 2 / 0.02 |
| `deepseek-v4-pro` | Chat Completions | 1,000,000 | 384,000 | 支持 | 暂不支持 | 不支持 | 3 / 6 / 0.025 |

缓存写入价格当前为 0。构造未知模型会报错；请求 `maxTokens` 超过模型硬输出限制也会在发请求前报错。通用 `ModelMetadata.protocol` 选择协议 codec，`supportsHostedWebSearch` 则把模型能力与用户的 `web_search` 配置分开记录。TUI 使用元数据计算上下文使用率和 CNY 累计成本。DeepSeek metadata 允许 `agent.parallel_tool_calls`，但用户关闭该配置时 ToolRuntime 仍会强制串行执行。

## 协议选择与请求转换

默认 base URL 为 `https://api.deepseek.com`。认证、取消、超时、重试、错误归一化和生命周期日志由两条路径共享，endpoint 与请求 codec 则由元数据选择。

当前两个 DeepSeek 模型均为纯文本模型。持久化的用户消息如果包含图片，两套请求 codec 都会将其替换为明确的附件省略提示，并且绝不发送 base64 数据。`model.deepseek.image_input` 为未来 metadata 支持预留，不能覆盖模型声明的不支持能力。

### V4 Flash Responses

V4 Flash 向 `POST /responses` 发送语义化 input item：

```json
{
  "model": "…",
  "instructions": "…",
  "input": ["…"],
  "stream": true
}
```

系统提示词映射为 `instructions`。用户与助手消息、推理、函数调用及函数结果映射为 Responses input item。已完成的 DeepSeek output item 会作为不透明 `providerState` 保存并原样 replay；Responses API 是无状态的，这样服务端才能还原此前的托管搜索结果。没有 provider state 的旧 Chat Completions 历史则根据可见 reasoning、文本、函数调用和工具结果重建。来自其他供应商的托管调用不会 replay。

已提供的可选配置按下表映射：

| Kana / `DeepSeekModelConfig` | 请求字段 |
| --- | --- |
| `temperature` | `temperature` |
| `ModelContext.maxOutputTokens ?? maxTokens` | `max_output_tokens` |
| `topP` | `top_p` |
| `thinking = false` | `reasoning.effort = "none"` |
| `reasoningEffort` | `reasoning.effort` |
| `responseFormat` | `text.format` |
| `userId` | `user` |

逐轮输出上限优先于配置的 `maxTokens`。客户端函数使用扁平的 Responses 工具定义。当模型元数据支持且 `model.deepseek.web_search = true` 时，同一个 `tools` 数组会追加 `{ "type": "web_search" }`；设为 `false` 只会移除该托管工具。默认 `tool_choice` 为 `auto`，Chat Completions 风格的具名选择会转换为扁平 Responses 结构，`strictTools` 会给函数工具加上 `strict: true`。

### V4 Pro Chat Completions

V4 Pro 继续向 `POST /chat/completions` 发送请求：

```json
{
  "model": "…",
  "messages": ["…"],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

系统提示词成为第一个 `system` 消息。用户消息直接映射；工具结果变为带 `tool_call_id` 的 `tool` 消息。助手有序内容会转换为一个 assistant 消息：text 拼接为 `content`，thinking 拼接为 `reasoning_content`，调用变为 `tool_calls`。原始流式参数 `rawArgs` 存在时优先 replay。该路径继续使用 Chat Completions 字段名发送 `max_tokens`、`thinking.type`、`reasoning_effort`、`response_format` 和 `user_id`；`thinking` 显式为 false 时会省略 `reasoning_effort`。供应商级 `web_search` 配置仍会保留，但在 V4 Pro 获得 Responses 与托管搜索支持之前不会产生效果。

## 认证、取消、超时与重试

模型优先使用构造配置里的 `apiKey`，否则读取 `DEEPSEEK_API_KEY`。Kana 产品层通常先从 `config.toml` 指定的环境变量读 key 并传入配置；直接使用 `DeepSeekModel` 时则适用该回退。请求带有 `Authorization: Bearer <key>`、`content-type: application/json` 和 `accept: text/event-stream`，并可合并自定义 headers。

`createRequestSignal` 将 Agent 的取消信号和可选 `timeoutMs` 合并。`timeoutMs` 是无活动超时：等待响应头时受其限制，收到响应头或任意响应字节后重新计时。因此持续输出的长 reasoning 流可以超过该时长，但连接停止传输达到该时长时仍会中止。结束时会清理定时器和事件监听器。HTTP 408、429 和所有 5xx 响应可重试；其他 HTTP 错误不重试。非 HTTP 异常也会被视为可重试，除非已中止。退避为 1s、2s、4s、8s（之后保持 8s），最多执行 `maxRetries` 次重试。

任何抛出错误最终都会产生 provider `error` 事件：DOM `AbortError` 或上层 signal 已中止映射为 `aborted`，其余映射为 `error`。事件带有截至失败时已累积的助手消息快照，因此 Agent 能保留可用的部分文本。

HTTP 400、413 或 422 只有在错误 code/message 明确匹配 context length/window 或 input/prompt token 超限时，才转换为通用 `ContextWindowExceededError`；普通参数错误保持原始 `DeepSeekHttpError`。Agent 仅在还没有任何助手输出时捕获该类型，执行一次安全上下文压缩并重试当前请求一次。provider 失败日志仍只记录错误类型、状态码和状态文本，不记录最多检查 4096 字符的响应消息。

## SSE 解析与内容顺序

V4 Flash 使用与 OpenAI Codex 相同的共享 `src/providers/responses` 语义 SSE 处理器。它按 `output_index` 和 item ID 关联输出，保持 reasoning/message/function/search 顺序，把 `web_search_call` 映射为 `hosted_tool`，并且只在 `response.completed`、`response.incomplete` 或 `response.failed` 后结束。DeepSeek 的 `ws_call_id` replay 标记会在展示前从语义化搜索 query 和 URL fragment 中移除，而 `providerState` 中的原始 output item 保持不变。完成 item 会保留 `providerState.provider = "deepseek"`；`response.incomplete` 映射为 `length`，包含客户端函数调用的响应映射为 `toolUse`，只有托管搜索时仍映射为 `stop`。Responses usage 会映射 input、output、total、cached 和 reasoning token。

V4 Pro 的 Chat Completions 读取器以空行切分 SSE frame，并保留不完整尾帧以应对网络分片。每个 frame 收集所有 `data:` 行；`[DONE]` 立即结束读取。JSON payload 交给 `applyDeepSeekChunk`。

```text
reasoning_content delta
  → thinking_start（首次）→ thinking_delta*
content delta
  → 结束所有未结束 thinking
  → text_start（首次）→ text_delta*
tool_calls delta
  → 结束所有未结束 thinking/text
  → 新 index 首次出现时，结束此前所有 tool call
  → toolcall_start（首次）→ toolcall_delta*
finish_reason = tool_calls
  → 解析并结束最后仍未结束的 tool call
```

工具 delta 由 provider 的 `index` 对应当前消息中的第 N 个工具块。DeepSeek 不提供每个工具调用的完成标记；其 index 按序流出，因此首次收到更高 index 时，会推断并结束所有此前的调用。流结束时再结束最后尚未完成的调用。ID、函数名和参数都可跨多个 chunk 拼接；无参数时最终参数为 `{}`，非 JSON 参数保留为原始字符串。可见文本或工具调用开始时会关闭前一个不同类型的开放内容块，保证 `content` 数组和事件顺序一致。

Chat Completions 结束原因映射为：`stop → stop`、`length → length`、`tool_calls → toolUse`。`content_filter` 与 `insufficient_system_resource` 被视为错误。流中携带的 usage 转为通用字段，包括 prompt cache hit/miss 和 reasoning token。

## 用量和成本

`ModelUsage` 记录 prompt、completion 和 total token，可选记录 cache hit/miss 及 reasoning token。成本计算以 CNY/百万 token 为单位：有 cache miss 时将它计为普通输入，有 cache hit 时按 cache-read 价格计费；只提供其中一项时从 `promptTokens` 推导另一项。累计用量逐字段相加，context 使用率为最近助手 usage 的 `promptTokens / effective context limit`，钳制在 0–100%；未配置 `agent.context_limit` 时，该分母才是 metadata context window。摘要请求的 usage 计入主运行累计用量和成本，但不会替换最近正常模型请求的 context 百分比。

## 扩展注意点

- 保持 provider 输出为 `AssistantMessageEvent`，并为每次事件发送深拷贝快照。
- 不要把 provider 的 thinking/text/tool 调用顺序扁平化；Agent 历史和 TUI 依赖有序 content。
- 共享 Responses 代码只负责语义 SSE item 的组装。请求字段、endpoint 选择、认证、重试策略和 replay 规则仍由各 provider adapter 负责。
- 新增可重试条件时必须区分取消，取消不应被重试。
- 新模型要同时更新 metadata、产品配置允许值和成本显示测试。
