# DeepSeek 提供商适配

Kana 的产品配置当前使用 DeepSeek；实现位于 `src/providers/deepseek`。该适配层把 `core` 的通用消息和工具协议转换为 DeepSeek 的流式 `/chat/completions` 请求，并将 SSE 增量恢复为有序助手内容。

## 模型与元数据

`DeepSeekModel` 继承 `BaseModel`。`stream(context)` 同步返回 `AssistantEventStream`，真实网络请求在后台异步写入该流；`generate()` 因而只是收集同一条流，不会走另一套非流式路径。

当前内置元数据：

| 模型 | 上下文窗口 | 最大输出 | 输入 / 输出 / 缓存读取价格（CNY/百万 token） |
| --- | ---: | ---: | --- |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | 1 / 2 / 0.02 |
| `deepseek-v4-pro` | 1,000,000 | 384,000 | 3 / 6 / 0.025 |

缓存写入价格当前为 0。构造未知模型会报错；请求 `maxTokens` 超过模型硬输出限制也会在发请求前报错。TUI 使用元数据计算上下文使用率和 CNY 累计成本。

## 请求转换

默认 base URL 为 `https://api.deepseek.com`，请求路径固定为 `/chat/completions`。请求始终设置：

```json
{
  "model": "…",
  "messages": ["…"],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

系统提示词在通用 `ModelContext` 外保存，发送时会作为消息数组的首个 `system` 消息。用户消息直接映射；工具结果变为带 `tool_call_id` 的 `tool` 消息。助手有序内容会转换为一个 DeepSeek assistant 消息：所有 text 拼接为 `content`，所有 thinking 拼接为 `reasoning_content`，工具调用变为 `tool_calls`。原始流式参数 `rawArgs` 存在时优先回传它，避免重新序列化改变调用内容。

配置中已提供的可选字段会被转为 DeepSeek 名称：

| Kana / `DeepSeekModelConfig` | 请求字段 |
| --- | --- |
| `temperature` | `temperature` |
| `maxTokens` | `max_tokens` |
| `topP` | `top_p` |
| `thinking` | `thinking.type`，值为 `enabled`/`disabled` |
| `reasoningEffort` | `reasoning_effort` |
| `responseFormat` | `response_format` |
| `userId` | `user_id` |

当 `thinking` 显式为 `false` 时，不发送 `reasoning_effort`，因为 DeepSeek 拒绝这一组合。若上下文有工具，则每个 TypeBox schema 作为 function `parameters` 透传，默认 `tool_choice` 为 `auto`；`strictTools` 会给每个 function 加上 `strict: true`。上下文没有工具时，只有显式配置的 `toolChoice` 才会被发送。

## 认证、取消、超时与重试

模型优先使用构造配置里的 `apiKey`，否则读取 `DEEPSEEK_API_KEY`。Kana 产品层通常先从 `config.toml` 指定的环境变量读 key 并传入配置；直接使用 `DeepSeekModel` 时则适用该回退。请求带有 `Authorization: Bearer <key>`、`content-type: application/json` 和 `accept: text/event-stream`，并可合并自定义 headers。

`createRequestSignal` 将 Agent 的取消信号和可选 `timeoutMs` 合并。超时会中止请求，结束时清理定时器和事件监听器。HTTP 408、429 和所有 5xx 响应可重试；其他 HTTP 错误不重试。非 HTTP 异常也会被视为可重试，除非已中止。退避为 1s、2s、4s、8s（之后保持 8s），最多执行 `maxRetries` 次重试。

任何抛出错误最终都会产生 provider `error` 事件：DOM `AbortError` 或上层 signal 已中止映射为 `aborted`，其余映射为 `error`。事件带有截至失败时已累积的助手消息快照，因此 Agent 能保留可用的部分文本。

## SSE 解析与内容顺序

响应读取器以空行切分 SSE frame，并保留不完整尾帧以应对网络分片。每个 frame 收集所有 `data:` 行；`[DONE]` 立即结束读取。JSON payload 交给 `applyDeepSeekChunk`。

```text
reasoning_content delta
  → thinking_start（首次）→ thinking_delta*
content delta
  → 结束所有未结束 thinking
  → text_start（首次）→ text_delta*
tool_calls delta
  → 结束所有未结束 thinking/text
  → toolcall_start（首次）→ toolcall_delta*
finish_reason = tool_calls
  → 解析 rawArgs → toolcall_end
```

工具 delta 由 provider 的 `index` 对应当前消息中的第 N 个工具块。ID、函数名和参数都可跨多个 chunk 拼接；无参数时最终参数为 `{}`，非 JSON 参数保留为原始字符串。可见文本或工具调用开始时会关闭前一个不同类型的开放内容块，保证 `content` 数组和事件顺序一致。

结束原因映射为：`stop → stop`、`length → length`、`tool_calls → toolUse`。`content_filter` 与 `insufficient_system_resource` 被视为错误。流中携带的 usage 转为通用字段，包括 prompt cache hit/miss 和 reasoning token。

## 用量和成本

`ModelUsage` 记录 prompt、completion 和 total token，可选记录 cache hit/miss 及 reasoning token。成本计算以 CNY/百万 token 为单位：有 cache miss 时将它计为普通输入，有 cache hit 时按 cache-read 价格计费；只提供其中一项时从 `promptTokens` 推导另一项。累计用量逐字段相加，context 使用率为最近助手 usage 的 `promptTokens / contextWindow`，钳制在 0–100%。

## 扩展注意点

- 保持 provider 输出为 `AssistantMessageEvent`，并为每次事件发送深拷贝快照。
- 不要把 provider 的 thinking/text/tool 调用顺序扁平化；Agent 历史和 TUI 依赖有序 content。
- 新增可重试条件时必须区分取消，取消不应被重试。
- 新模型要同时更新 metadata、产品配置允许值和成本显示测试。
