# 自定义 OpenAI-compatible 提供商

Kana 提供一个静态的 `custom` 供应商槽位，用于用户自己管理的 OpenAI-compatible 模型。该槽位使用内置 Chat Completions 适配器；它不是运行时插件系统，也不会动态发现任意 provider ID。保持产品层供应商集合封闭，可以避免 Agent、session、memory 和前端装配都承担动态供应商逻辑，同时仍可接入本地服务或托管的兼容 endpoint。

## 安装与选择

`kana install` 会创建 `<KANA_HOME>/providers/custom.example.toml` 作为生成的配置参考。将它复制为 `custom.toml` 后再修改；运行时不会读取 example 文件。

最小供应商定义为：

```toml
# ~/.kana/providers/custom.toml
base_url = "http://127.0.0.1:8080/v1"

[[models]]
name = "local-model"
context_window = 32768
max_output_tokens = 4096
```

然后在主配置中选择其中一个模型名：

```toml
# ~/.kana/config.toml
[provider]
active = "custom"

[model.custom]
name = "local-model"
```

`/model` 会在内置供应商之外显示 Custom。它从这一个文件读取模型列表，只持久化 `provider.active`、`model.custom.name` 和可选的推理强度，并通过与内置供应商相同的候选 Agent 校验完成热切换。文件缺失或无效时会显示明确错误；Kana 不会静默回退到其他供应商或模型。

## 供应商字段

| 键 | 必需 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `base_url` | 是 | — | Endpoint 前缀；Kana 会追加 `/chat/completions`，通常以 `/v1` 结尾。 |
| `api_key_env` | 否 | 未设置 | 保存 Bearer token 的环境变量名；省略时不发送 Authorization header。 |
| `timeout_ms` | 否 | `60000` | 等待响应头或相邻响应数据的无活动超时。 |
| `max_retries` | 否 | `1` | HTTP 408、429、5xx 和可重试传输失败的重试次数。 |
| `[[models]]` | 是 | — | 一个或多个模型 metadata 表，模型名必须唯一。 |

需要鉴权时，把 secret 放入进程环境或 `<KANA_HOME>/.env`，不要写入 TOML：

```toml
api_key_env = "LOCAL_MODEL_API_KEY"
```

## 模型字段

| 键 | 必需 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `name` | 是 | — | 请求中发送、并可从 `/model` 选择的准确模型 ID。 |
| `context_window` | 是 | — | Agent 预算使用的正整数上下文窗口。 |
| `max_output_tokens` | 是 | — | 单次请求的正整数输出上限；不能超过 `context_window`。 |
| `supports_parallel_tool_calls` | 否 | `false` | Kana 是否可以声明并实际并发执行安全工具调用。 |
| `supports_image_input` | 否 | `false` | 是否可以把用户图片作为 Chat Completions image data URL 发送。 |
| `reasoning_efforts` | 否 | 未设置 | `reasoning_effort` 支持的非空请求值列表。 |
| `default_reasoning_effort` | 配置 `reasoning_efforts` 时 | — | 默认值；必须出现在 `reasoning_efforts` 中。 |

推理控制属于能力 metadata，不是对所有供应商的统一假设。模型没有可选择的控制时，应同时省略两个 reasoning 字段；`/model` 会跳过这一步，请求也不会发送 `reasoning_effort`。配置后，Kana 会把选择值作为 Chat Completions 顶层 `reasoning_effort` 发送。关闭档位使用 `none`，而不是 `off`；TUI 会把 `none` 显示为 `Off`。

例如：

```toml
[[models]]
name = "reasoning-model"
context_window = 32768
max_output_tokens = 8192
supports_parallel_tool_calls = true
supports_image_input = false
reasoning_efforts = ["none", "low", "high"]
default_reasoning_effort = "none"
```

`agent.context_limit` 是与供应商无关的上限。Agent 实际使用该配置值与所选模型 `context_window` 中较小的一个，因此从大窗口内置模型切换到较小的 Custom 模型时，不需要额外的供应商专用 Agent 配置。

## 协议与安全边界

适配器发送流式 `POST <base_url>/chat/completions` 请求，并设置 `stream_options.include_usage = true`；它会转换 system/user/assistant/tool 历史和本地函数定义，并解析流式文本、工具调用、结束原因与 usage。为避免 Bearer 凭据被转发到其他 origin，适配器拒绝 redirect。Custom 槽位不支持托管网页搜索和供应商专用 replay state。

`base_url` 必须使用 HTTPS；只有 loopback、私网或 link-local host 可以使用 HTTP。URL 中的凭据、query 和 fragment 都会被拒绝。配置还会拒绝未知字段、非法环境变量名、重复模型名、无效 token 上限、重复 reasoning 值、`off`，以及不在声明列表中的 reasoning 默认值。

当前槽位只支持 OpenAI-compatible Chat Completions。Custom Responses、Anthropic Messages、任意 JavaScript/TypeScript adapter、动态 provider ID 和由 TOML 定义 wire protocol 仍不在范围内。
