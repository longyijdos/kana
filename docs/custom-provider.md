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

The adapter sends streaming `POST <base_url>/chat/completions` requests with `stream_options.include_usage = true`, maps system/user/assistant/tool history and local function definitions, and parses streamed text, tool calls, finish reasons, and usage. Chat Completions tool-role messages cannot carry images, so when image capability is declared the adapter keeps the text tool results contiguous and appends one synthetic multimodal user observation for their images. Streamed `delta.reasoning_content` is mapped to Kana thinking events so reasoning remains represented in Core. TUI activity is provider-independent: its `working` timer starts at `turn_start` and does not depend on this optional field. The adapter rejects redirects so a Bearer credential cannot be forwarded to another origin. Hosted web search and provider-specific replay state are not supported by the Custom slot.

`base_url` accepts HTTP and HTTPS endpoints. Prefer HTTPS whenever credentials cross an untrusted network because HTTP sends the Bearer credential without transport encryption. Credentials in the URL, query strings, and fragments are rejected. The configuration also rejects unknown fields, invalid environment-variable names, duplicate model names, invalid token limits, duplicate reasoning values, `off`, and a reasoning default outside the advertised list.

The adapter uses the same provider HTTP and lifecycle primitives as the built-in adapters. Agent cancellation remains distinct from inactivity timeout, and either stops retry admission and pending retry delay. Retained HTTP error bodies are bounded to 16 KiB. Diagnostics use the common provider/model/protocol/phase/outcome envelope plus fixed Kana `errorCode`, safe `errorType`, attempt, and HTTP status where relevant; they never include the configured endpoint, credentials, headers, prompts, error messages, response bodies, or streamed content.

The current slot supports only OpenAI-compatible Chat Completions. Custom Responses, Anthropic Messages, arbitrary JavaScript/TypeScript adapters, dynamic provider IDs, and TOML-defined wire protocols remain out of scope.
