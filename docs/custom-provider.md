# Custom OpenAI-compatible provider

Kana can use multiple user-managed OpenAI-compatible endpoints. Each Custom provider has its own endpoint, credentials, request settings, and model list. Models use the built-in Chat Completions or Responses adapter; Custom providers do not load runtime plugins.

## Install and select

`kana install` generates `<KANA_HOME>/providers/custom.example.toml`. Copy it to a separate `<name>.toml` in the same directory for each endpoint, such as `local.toml` or `openrouter.toml`. Names start with a lowercase ASCII letter or digit and use up to 64 lowercase letters, digits, underscores, or hyphens. For example, `custom.toml` has the ID `custom:custom` and appears as `Custom · custom` in `/model`. Kana never reads the example at runtime.

The minimum provider definition is:

```toml
# ~/.kana/providers/local.toml
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
provider = "custom:local"
name = "local-model"
```

In `/model`, choose `Custom · local` and then a model. Model names can repeat across providers without ambiguity. Kana loads provider definitions at startup and shares the snapshot across `/model`, conversation Agents, subagents, and memory consolidation. You can switch between loaded endpoints without restarting; adding, removing, or editing a provider file requires a restart. An invalid file only makes that provider unavailable. Kana reports an error if you select a missing or invalid definition and never silently falls back.

The command validates the candidate Agent and persists the main Agent's `provider`, `name`, and optional reasoning effort under `[agent.model]`. Its `max_output_tokens` and `context_limit` remain unchanged. `[memory.agent.model]` overrides only the fields it sets; a subagent profile can select a named model with `model: custom:local/local-model`.

## Provider fields

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `base_url` | Yes | — | Endpoint prefix. Kana appends `/chat/completions` or `/responses` according to the model protocol; it commonly ends in `/v1`. |
| `api_key_env` | No | Unset | Environment-variable name containing a Bearer token. Omission sends no Authorization header. |
| `[headers]` | No | Empty | Extra HTTP headers sent with every request. `Accept` and `Content-Type` are reserved, and `Authorization` is reserved when `api_key_env` is set. |
| `timeout_ms` | No | `60000` | Inactivity timeout while waiting for headers or consecutive response bytes. |
| `max_retries` | No | `1` | Retry count for HTTP 408, 429, 5xx, and retryable transport failures. |
| `[[models]]` | Yes | — | One or more model metadata tables with unique names. |

For authenticated endpoints, store the secret in the process environment or `<KANA_HOME>/.env`, not in TOML:

```toml
api_key_env = "LOCAL_MODEL_API_KEY"
```

To keep the endpoint out of a public repository when using the [Kana Agent reusable workflow](kana-agent-workflow.md), omit `base_url` from the provider file and pass it as the optional `KANA_MODEL_BASE_URL` secret. The workflow then writes that value as the provider's `base_url`.

## Model fields

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `name` | Yes | — | Exact model ID sent in requests and selected from `/model`. |
| `protocol` | No | `chat-completions` | Wire protocol: `chat-completions` or `responses`. |
| `context_window` | Yes | — | Positive context-window size used for Agent budgeting. |
| `max_output_tokens` | Yes | — | Positive per-request output ceiling; cannot exceed `context_window`. |
| `supports_parallel_tool_calls` | No | `false` | Whether Kana may advertise and execute safe tool calls in parallel. |
| `supports_hosted_web_search` | No | `false` | Responses only. Whether Kana may add the provider-hosted `web_search` tool. |
| `supports_image_input` | No | `false` | Whether user and tool images may be sent as image data URLs. When true, Kana also registers `view_image`. |
| `assistant_replay_fields` | No | Unset | Chat Completions only. Non-empty list of streamed assistant delta fields to preserve and replay for the same endpoint and model. |
| `reasoning_efforts` | No | Unset | Non-empty list of supported reasoning-effort request values. |
| `default_reasoning_effort` | With `reasoning_efforts` | — | Default value; it must appear in `reasoning_efforts`. |
| `[models.params]` | No | Unset | Extra top-level request-body fields, such as sampling or cache controls. Fields Kana manages are rejected. |

Reasoning controls are capability metadata rather than a universal provider assumption. Omit both reasoning fields when the model has no selectable control; `/model` then skips that step and requests omit `reasoning_effort`. When configured, Kana sends the selected value as the top-level Chat Completions `reasoning_effort`, or as Responses `reasoning.effort` with an `auto` summary. Use `none`, not `off`, for a disabled level; the TUI presents `none` as `Off`.

Some compatible endpoints require extra fields from a streamed assistant response to be echoed in later assistant history. `assistant_replay_fields` explicitly names those top-level `choice.delta` fields. Kana accumulates their streamed JSON values, stores them as opaque provider state, and replays only fields that came from the same Custom endpoint and model and remain enabled in its configuration. Omit the setting unless the endpoint documents this requirement. `role`, `content`, and `tool_calls` are managed by Kana and cannot be listed.

For example:

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

`[models.params]` passes endpoint-specific options that Kana does not model, such as `temperature`, prompt-cache keys, or gateway routing fields. Values are sent as written and are not validated against the endpoint. Fields Kana manages for the selected protocol cannot be set: for Chat Completions these are `model`, `messages`, `stream`, `stream_options`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`, `tools`, `tool_choice`, and `parallel_tool_calls`; for Responses they are `model`, `instructions`, `input`, `stream`, `store`, `include`, `previous_response_id`, `max_output_tokens`, `reasoning`, `tools`, `tool_choice`, and `parallel_tool_calls`. Use the dedicated model fields for output limits and reasoning.

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

Header values are stored in plain TOML, so keep Bearer credentials in `api_key_env`.

`agent.model.context_limit` is a provider-independent preference. The effective Agent limit is the smaller of that configured value and the selected model's `context_window`, so switching from a large built-in model to a smaller Custom model remains valid without provider-specific Agent configuration. `memory.agent.model` follows the same rule for each field it overrides and otherwise inherits `agent.model.context_limit`.

## Protocol and security boundaries

Chat Completions models use the shared OpenAI-compatible path documented in [Providers](providers.md), including streaming text, reasoning deltas, configured assistant replay fields, local tool calls, usage, image observations, cancellation, inactivity, retries, and safe diagnostics. Hosted web search is unavailable on this protocol.

Responses models use the same transport, authentication, and diagnostics with the shared semantic Responses processor, so reasoning, text, function calls, and hosted `web_search_call` items stream as ordinary Kana content. Requests set `store: false` and send function tools with `strict: false`. Completed output items are replayed without item IDs and only for the same Custom endpoint and model; other history falls back to visible text and local function calls. When reasoning controls are configured, Kana also requests `reasoning.encrypted_content` so reasoning can be replayed statelessly, so configure them for reasoning models. Kana adds `web_search` only when the model sets `supports_hosted_web_search` and the Agent's `web_search` policy allows it.

Both adapters reject redirects so a Bearer credential cannot be forwarded to another origin.

`base_url` accepts HTTP and HTTPS, but HTTPS is required to protect credentials across an untrusted network. Credentials in URLs, query strings, and fragments are rejected, as are unknown fields and invalid model metadata.

The slot supports only OpenAI-compatible Chat Completions and Responses. Anthropic Messages, arbitrary JavaScript or TypeScript adapters, dynamic provider IDs, and TOML-defined wire protocols remain out of scope.
