# DeepSeek 提供商适配

Kana 内置的 DeepSeek 适配器位于 `src/providers/deepseek`。所有 V4 模型都只使用 Responses API，并把流式输出恢复为相同的有序助手内容。

## 模型与元数据

`DeepSeekModel` 继承 `BaseModel`。`stream(context)` 同步返回 `AssistantEventStream`，真实网络请求在后台异步写入该流；`generate()` 因而只是收集同一条流，不会走另一套非流式路径。

当前内置元数据：

| 模型 | 协议 | 上下文窗口 | 最大输出 | 并行工具调用 | 托管网页搜索 | 图片输入 |
| --- | --- | ---: | ---: | --- | --- | --- |
| `deepseek-v4-flash` | Responses | 1,000,000 | 384,000 | 支持 | 支持 | 不支持 |
| `deepseek-v4-flash-vision-exp` | Responses | 1,000,000 | 384,000 | 支持 | 支持 | 支持 |
| `deepseek-v4-pro` | Responses | 1,000,000 | 384,000 | 支持 | 支持 | 不支持 |

构造未知模型会报错；直接请求的 `maxOutputTokens` 超过模型硬输出限制也会在发请求前报错。通用 `ModelMetadata.protocol` 选择协议 codec，`supportsHostedWebSearch` 则把模型能力与各 Agent 的 `web_search` 策略分开记录。TUI 使用元数据计算上下文使用率。DeepSeek metadata 允许并行工具调用，但对应 Agent 关闭时 ToolRuntime 仍会强制串行执行。Kana 有意不内置 provider 价格，实际费用以 DeepSeek 账单为准。

所有 V4 模型都通过通用 reasoning metadata 暴露 `none`、`low`、`high` 和 `max`，metadata 默认值为 `high`。Agent 模型的 `reasoning_effort = "none"` 会关闭推理；此前独立的 `thinking` 开关不再属于配置或请求约定。

## 请求转换

默认 base URL 为 `https://api.deepseek.com`，当前所有模型都向 `/responses` 发送请求。

图片输入由所选模型的 metadata 和当前 Agent 的 `image_input` 策略共同决定。`deepseek-v4-flash-vision-exp` 会把会话中持久化的用户图片作为带自包含 base64 data URL 的 classic Responses `input_image` item 发送，并注册 `view_image`；视觉工具结果会成为与原调用关联的原生多模态 `function_call_output` 内容。纯文本的 V4 Flash 和 V4 Pro 会把已持久化图片替换为明确的省略提示，绝不发送 base64 数据，也不注册 `view_image`。模型 metadata 优先级更高，`image_input = false` 即使在视觉模型上也会同时禁用图片发送和该工具。

### V4 Responses

所有 V4 模型都向 `POST /responses` 发送语义化 input item：

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
| `ModelContext.maxOutputTokens ?? maxOutputTokens` | `max_output_tokens` |
| `topP` | `top_p` |
| `reasoningEffort` | `reasoning.effort` |
| `responseFormat` | `text.format` |
| `userId` | `user` |

逐轮输出上限优先于配置的 `maxOutputTokens`。客户端函数使用扁平的 Responses 工具定义。当模型 metadata 支持且 Agent 的 `web_search = true` 时，同一个 `tools` 数组会追加 `{ "type": "web_search" }`；设为 `false` 只会移除该托管工具。默认 `tool_choice` 为 `auto`，Chat Completions 风格的具名选择会转换为扁平 Responses 结构，`strictTools` 会给函数工具加上 `strict: true`。

图片输入同时受模型 metadata 和配置约束：只有 `deepseek-v4-flash-vision-exp` 声明支持图片，且配置不能为 `false`。纯文本模型因此绝不会发送会话中保存的 base64 图片字节，也不会声明 `view_image`，而是保留明确的省略提示或元数据；压缩仍会继续，因此切换 provider 后，带图片的历史不会阻止后续 checkpoint。

## 认证与共享请求行为

模型优先使用直接配置中的 `apiKey`，否则读取 `DEEPSEEK_API_KEY`；Kana 产品层通常会根据 `config.toml` 中的环境变量名解析密钥。请求使用 Bearer 认证，也可以带已配置的自定义 header。

取消、无活动超时、有界错误体、HTTP 重试计时、生命周期诊断和上下文窗口规范化遵循[供应商](providers.zh-CN.md)中的共享契约。DeepSeek 还会识别自身的上下文超限错误码和消息，之后才允许 Agent 执行一次安全的压缩恢复。

## SSE 解析与内容顺序

所有 V4 模型都使用[供应商](providers.zh-CN.md)所述的共享语义化 Responses processor。DeepSeek 会从展示的搜索 query 和 URL fragment 中移除 `ws_call_id` replay 标记，同时在 `providerState` 保留原始 item；完成状态带有 `provider = "deepseek"` 标记。

## 用量

DeepSeek 把 input、output、total、cached 和 reasoning token 映射到通用 `ModelUsage` 字段。上下文占用与进程累计用量遵循共享 runtime 规则。
## 扩展注意点

- 保持 provider 输出为 `AssistantMessageEvent`，并为每次事件发送深拷贝快照。
- 不要把 provider 的 thinking/text/tool 调用顺序扁平化；Agent 历史和 TUI 依赖有序 content。
- 共享 Responses 代码只负责语义 SSE item 的组装。请求字段、endpoint 选择、认证、重试策略和 replay 规则仍由各 provider adapter 负责。
- 新增可重试条件时必须区分取消，取消不应被重试。
- 新模型要同时更新 metadata、产品配置允许值和用量显示测试。
