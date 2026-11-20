# 自定义 OpenAI-compatible 提供商

Kana 可以接入多个由用户管理的 OpenAI-compatible endpoint。每个 Custom 供应商独立配置 endpoint、凭据、请求选项和模型列表。模型使用内置的 Chat Completions 或 Responses 适配器，不加载运行时插件。

## 安装与选择

`kana install` 会生成 `<KANA_HOME>/providers/custom.example.toml`。为每个 endpoint 将示例复制到同目录下单独的 `<name>.toml`，例如 `local.toml` 或 `openrouter.toml`。名称须以 ASCII 小写字母或数字开头，仅可包含小写字母、数字、下划线和连字符，最长 64 个字符。例如，`custom.toml` 的 ID 为 `custom:custom`，在 `/model` 中显示为 `Custom · custom`。运行时不会读取示例文件。

最小供应商定义为：

```toml
# ~/.kana/providers/local.toml
base_url = "http://127.0.0.1:8080/v1"

[[models]]
name = "local-model"
context_window = 32768
max_output_tokens = 4096
```

然后在主配置中选择其中一个模型名：

```toml
# ~/.kana/config.toml
[agent.model]
provider = "custom:local"
name = "local-model"
```

在 `/model` 中选择 `Custom · local`，再选择模型。不同供应商可以使用同一个模型名，选择时不会混淆。Kana 在启动时加载供应商定义，`/model`、对话 Agent、subagent 和记忆压缩共用这份快照。切换已加载的 endpoint 不需要重启；添加、删除或编辑供应商文件仍需重启。一份配置无效只会让该供应商不可用。选择缺失或无效的配置时，Kana 会报错，不会静默回退。

该命令会校验候选 Agent，并在 `[agent.model]` 中持久化主 Agent 的 `provider`、`name` 和可选推理强度。已有的 `max_output_tokens` 和 `context_limit` 保持不变。`[memory.agent.model]` 只覆盖自身填写的字段；subagent 角色卡可以用 `model: custom:local/local-model` 选择命名供应商的模型。

## 供应商字段

| 键 | 必需 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `base_url` | 是 | — | Endpoint 前缀；Kana 会按模型协议追加 `/chat/completions` 或 `/responses`，通常以 `/v1` 结尾。 |
| `api_key_env` | 否 | 未设置 | 保存 Bearer token 的环境变量名；省略时不发送 Authorization header。 |
| `[headers]` | 否 | 空 | 每个请求都会附带的额外 HTTP header。`Accept` 与 `Content-Type` 为保留字段；设置 `api_key_env` 时 `Authorization` 也为保留字段。 |
| `timeout_ms` | 否 | `60000` | 等待响应头或相邻响应数据的无活动超时。 |
| `max_retries` | 否 | `1` | HTTP 408、429、5xx 和可重试传输失败的重试次数。 |
| `[[models]]` | 是 | — | 一个或多个模型 metadata 表，模型名必须唯一。 |

需要鉴权时，把 secret 放入进程环境或 `<KANA_HOME>/.env`，不要写入 TOML：

```toml
api_key_env = "LOCAL_MODEL_API_KEY"
```

使用 [Kana Agent 可复用 workflow](kana-agent-workflow.zh-CN.md) 时，如果不希望 endpoint 出现在公开仓库中，可以在 provider 文件中省略 `base_url`，改用可选的 `KANA_MODEL_BASE_URL` secret 传入。workflow 会把该值写入 provider 的 `base_url`。

## 模型字段

| 键 | 必需 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `name` | 是 | — | 请求中发送、并可从 `/model` 选择的准确模型 ID。 |
| `protocol` | 否 | `chat-completions` | Wire protocol：`chat-completions` 或 `responses`。 |
| `context_window` | 是 | — | Agent 预算使用的正整数上下文窗口。 |
| `max_output_tokens` | 是 | — | 单次请求的正整数输出上限；不能超过 `context_window`。 |
| `supports_parallel_tool_calls` | 否 | `false` | Kana 是否可以声明并实际并发执行安全工具调用。 |
| `supports_hosted_web_search` | 否 | `false` | 仅限 Responses。Kana 是否可以添加供应商托管的 `web_search` 工具。 |
| `supports_image_input` | 否 | `false` | 是否可以把用户和工具图片作为 image data URL 发送。设为 true 时 Kana 也会注册 `view_image`。 |
| `assistant_replay_fields` | 否 | 未设置 | 仅限 Chat Completions。需要为同一 endpoint 和模型保留并回放的流式 assistant delta 字段非空列表。 |
| `reasoning_efforts` | 否 | 未设置 | 支持的推理强度请求值非空列表。 |
| `default_reasoning_effort` | 配置 `reasoning_efforts` 时 | — | 默认值；必须出现在 `reasoning_efforts` 中。 |
| `[models.params]` | 否 | 未设置 | 额外的请求体顶层字段，例如采样或缓存控制。由 Kana 管理的字段会被拒绝。 |

推理控制属于能力 metadata，不是对所有供应商的统一假设。模型没有可选择的控制时，应同时省略两个 reasoning 字段；`/model` 会跳过这一步，请求也不会发送 `reasoning_effort`。配置后，Kana 会把选择值作为 Chat Completions 顶层 `reasoning_effort` 发送，或作为 Responses 的 `reasoning.effort` 并附带 `auto` summary 发送。关闭档位使用 `none`，而不是 `off`；TUI 会把 `none` 显示为 `Off`。

部分兼容 endpoint 要求在后续 assistant 历史中回传流式响应的额外字段。`assistant_replay_fields` 显式列出这些 `choice.delta` 顶层字段。Kana 会聚合其流式 JSON 值、作为不透明 provider state 保存，并且仅在来源仍是同一 Custom endpoint 和模型且配置仍启用对应字段时回放。除非 endpoint 明确要求，否则应省略此设置。`role`、`content` 和 `tool_calls` 由 Kana 管理，不能列入其中。

例如：

```toml
[[models]]
name = "reasoning-model"
context_window = 32768
max_output_tokens = 8192
supports_parallel_tool_calls = true
supports_image_input = false
assistant_replay_fields = ["reasoning", "reasoning_details"]
reasoning_efforts = ["none", "low", "high"]
default_reasoning_effort = "none"
```

`[models.params]` 用于传递 Kana 未建模的 endpoint 专属选项，例如 `temperature`、prompt cache key 或网关路由字段。值按原样发送，不会针对 endpoint 校验。所选协议中由 Kana 管理的字段不能设置：Chat Completions 为 `model`、`messages`、`stream`、`stream_options`、`max_tokens`、`max_completion_tokens`、`reasoning_effort`、`tools`、`tool_choice` 和 `parallel_tool_calls`；Responses 为 `model`、`instructions`、`input`、`stream`、`store`、`include`、`previous_response_id`、`max_output_tokens`、`reasoning`、`tools`、`tool_choice` 和 `parallel_tool_calls`。输出上限与推理请使用专门的模型字段。

```toml
[headers]
"X-Gateway-Route" = "primary"

[[models]]
name = "cached-model"
context_window = 128000
max_output_tokens = 8192

[models.params]
temperature = 0.2
prompt_cache_key = "kana"
```

Header 值以明文保存在 TOML 中，因此 Bearer 凭据仍应通过 `api_key_env` 提供。

`agent.model.context_limit` 是与供应商无关的偏好。Agent 实际使用该配置值与所选模型 `context_window` 中较小的一个，因此从大窗口内置模型切换到较小的 Custom 模型时，不需要额外的供应商专用 Agent 配置；`memory.agent.model` 对自己覆盖的字段应用相同规则，未覆盖时继承 `agent.model.context_limit`。

## 协议与安全边界

Chat Completions 模型使用[供应商](providers.zh-CN.md)中记录的共享 OpenAI-compatible 路径，包括流式文本、reasoning delta、已配置的 assistant replay 字段、本地工具调用、用量、图片观察、取消、无活动超时、重试和安全诊断。该协议不支持托管网页搜索。

Responses 模型使用相同的传输、鉴权和诊断，并接入共享的语义 Responses processor，因此 reasoning、文本、函数调用和托管 `web_search_call` item 会以普通 Kana 内容流式呈现。请求设置 `store: false`，函数工具以 `strict: false` 发送。已完成的 output item 回放时去掉 item ID，且仅回放给同一 Custom endpoint 和模型；其余历史退化为可见文本和本地函数调用。配置推理控制时，Kana 还会请求 `reasoning.encrypted_content`，使 reasoning 可以无状态回放，因此推理模型应配置推理控制。只有模型设置了 `supports_hosted_web_search` 且 Agent 的 `web_search` 策略允许时，Kana 才会添加 `web_search`。

两个适配器都拒绝 redirect，避免把 Bearer 凭据转发到另一个 origin。

`base_url` 接受 HTTP 和 HTTPS，但凭据经过不可信网络时必须使用 HTTPS。URL、query string 与 fragment 中的凭据会被拒绝，未知字段和无效模型元数据也会被拒绝。

该槽位只支持 OpenAI-compatible Chat Completions 和 Responses。Anthropic Messages、任意 JavaScript 或 TypeScript adapter、动态 provider ID 和由 TOML 定义的 wire protocol 均不在范围内。
