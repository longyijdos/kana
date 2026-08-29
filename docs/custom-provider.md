# Custom OpenAI-compatible provider

Kana exposes one static `custom` provider slot for user-managed OpenAI-compatible models. The slot uses the built-in Chat Completions adapter; it is not a runtime plugin system and does not discover arbitrary provider IDs. Keeping the product provider set closed avoids spreading dynamic-provider handling through Agent, session, memory, and frontend composition while still supporting a local server or hosted compatible endpoint.

## Install and select

`kana install` creates `<KANA_HOME>/providers/custom.example.toml` as generated reference material. Copy it to `custom.toml`; Kana never reads the example at runtime.

The minimum provider definition is:

```toml
# ~/.kana/providers/custom.toml
base_url = "http://127.0.0.1:8080/v1"

[[models]]
name = "local-model"
context_window = 32768
max_output_tokens = 4096
```

Select one of those model names in the main configuration:

```toml
# ~/.kana/config.toml
[agent.model]
provider = "custom"
name = "local-model"
```

`/model` exposes Custom alongside the built-in providers. It reads the model list from this one file, persists only the main Agent's `provider`, `name`, and optional reasoning effort under `[agent.model]`, and hot-switches through the same candidate-Agent validation used by built-ins. Its configured `max_output_tokens` and `context_limit` remain unchanged, and `[memory.agent.model]` is independent. A missing or invalid file is shown as an explicit error; Kana never falls back to another provider or model.

## Provider fields

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `base_url` | Yes | — | Endpoint prefix. Kana appends `/chat/completions`; it commonly ends in `/v1`. |
| `api_key_env` | No | Unset | Environment-variable name containing a Bearer token. Omission sends no Authorization header. |
| `timeout_ms` | No | `60000` | Inactivity timeout while waiting for headers or consecutive response bytes. |
| `max_retries` | No | `1` | Retry count for HTTP 408, 429, 5xx, and retryable transport failures. |
| `[[models]]` | Yes | — | One or more model metadata tables with unique names. |

For authenticated endpoints, store the secret in the process environment or `<KANA_HOME>/.env`, not in TOML:

```toml
api_key_env = "LOCAL_MODEL_API_KEY"
```

## Model fields

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `name` | Yes | — | Exact model ID sent in requests and selected from `/model`. |
| `context_window` | Yes | — | Positive context-window size used for Agent budgeting. |
| `max_output_tokens` | Yes | — | Positive per-request output ceiling; cannot exceed `context_window`. |
| `supports_parallel_tool_calls` | No | `false` | Whether Kana may advertise and execute safe tool calls in parallel. |
| `supports_image_input` | No | `false` | Whether user and tool images may be sent as Chat Completions image data URLs. When true, Kana also registers `view_image`. |
| `reasoning_efforts` | No | Unset | Non-empty list of request values supported by `reasoning_effort`. |
| `default_reasoning_effort` | With `reasoning_efforts` | — | Default value; it must appear in `reasoning_efforts`. |

Reasoning controls are capability metadata rather than a universal provider assumption. Omit both reasoning fields when the model has no selectable control; `/model` then skips that step and requests omit `reasoning_effort`. When configured, Kana sends the selected value as the top-level Chat Completions `reasoning_effort`. Use `none`, not `off`, for a disabled level; the TUI presents `none` as `Off`.

For example:

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

`agent.model.context_limit` is a provider-independent preference. The effective Agent limit is the smaller of that configured value and the selected model's `context_window`, so switching from a large built-in model to a smaller Custom model remains valid without provider-specific Agent configuration. The same rule applies independently to `memory.agent.model`.

## Protocol and security boundaries

The slot uses the shared OpenAI-compatible Chat Completions path documented in [Providers](providers.md), including streaming text, reasoning deltas, local tool calls, usage, image observations, cancellation, inactivity, retries, and safe diagnostics. It rejects redirects so a Bearer credential cannot be forwarded to another origin. Hosted web search and provider-specific replay state are unsupported.

`base_url` accepts HTTP and HTTPS, but HTTPS is required to protect credentials across an untrusted network. Credentials in URLs, query strings, and fragments are rejected, as are unknown fields and invalid model metadata.

The current slot supports only OpenAI-compatible Chat Completions. Custom Responses, Anthropic Messages, arbitrary JavaScript or TypeScript adapters, dynamic provider IDs, and TOML-defined wire protocols remain out of scope.
