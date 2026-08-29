# DeepSeek provider adapter

Kana's built-in DeepSeek adapter lives in `src/providers/deepseek`. All V4 models use the Responses API exclusively and reconstruct streaming output into the same ordered assistant content.

## Model and metadata

`DeepSeekModel` extends `BaseModel`. `stream(context)` synchronously returns an `AssistantEventStream`, while the network request writes to it asynchronously; `generate()` therefore collects the same stream rather than taking a separate non-streaming path.

Current built-in metadata:

| Model | Protocol | Context window | Max output | Parallel tool calls | Hosted web search | Image input |
| --- | --- | ---: | ---: | --- | --- | --- |
| `deepseek-v4-flash` | Responses | 1,000,000 | 384,000 | Supported | Supported | Not supported |
| `deepseek-v4-flash-vision-exp` | Responses | 1,000,000 | 384,000 | Supported | Supported | Supported |
| `deepseek-v4-pro` | Responses | 1,000,000 | 384,000 | Supported | Supported | Not supported |

Constructing an unknown model errors, and a direct request whose `maxOutputTokens` exceeds the model hard output limit errors before network I/O. Common `ModelMetadata.protocol` selects the protocol codec, while `supportsHostedWebSearch` records capability separately from each Agent's `web_search` policy. The TUI uses metadata for context percentage. DeepSeek metadata permits parallel tool calls, but ToolRuntime still forces serial execution when that Agent disables them. Kana intentionally does not embed provider pricing; actual charges come from DeepSeek billing.

All V4 models expose `none`, `low`, `high`, and `max` through common reasoning metadata, with `high` as the metadata default. An Agent model's `reasoning_effort = "none"` disables reasoning; the previous separate `thinking` switch is no longer part of the configuration or request contract.

## Request conversion

The default base URL is `https://api.deepseek.com`, and all current models send requests to `/responses`.

Image input follows the selected model's metadata and the current Agent's `image_input` policy. `deepseek-v4-flash-vision-exp` accepts persisted user images as classic Responses `input_image` items with self-contained base64 data URLs and registers `view_image`. Visual tool results become native multimodal `function_call_output` content tied to the originating call. The text-only V4 Flash and V4 Pro models replace persisted images with an explicit omitted marker, never transmit their base64 data, and do not register `view_image`; model metadata takes precedence, and `image_input = false` also disables delivery and the tool on the vision model.

### V4 Responses

All V4 models send `POST /responses` with semantic input items:

```json
{
  "model": "…",
  "instructions": "…",
  "input": ["…"],
  "stream": true
}
```

The system prompt maps to `instructions`. User and assistant messages, reasoning, function calls, and function outputs map to Responses input items. Completed DeepSeek output items are stored as opaque `providerState` and replayed unchanged; this is required because the API is stateless and lets the server reconstruct prior hosted search results. Older Chat Completions history without provider state is reconstructed from visible reasoning, text, function calls, and tool results. Hosted calls from another provider are not replayed.

Provided optional configuration maps as follows:

| Kana / `DeepSeekModelConfig` | Request field |
| --- | --- |
| `temperature` | `temperature` |
| `ModelContext.maxOutputTokens ?? maxOutputTokens` | `max_output_tokens` |
| `topP` | `top_p` |
| `reasoningEffort` | `reasoning.effort` |
| `responseFormat` | `text.format` |
| `userId` | `user` |

A per-turn output ceiling takes precedence over configured `maxOutputTokens`. Client functions use flattened Responses tool definitions. When the Agent's `web_search = true` and metadata supports it, `{ "type": "web_search" }` is appended to the same `tools` array; `false` removes only the hosted tool. Default `tool_choice` is `auto`, named Chat Completions choices are converted to the flattened Responses shape, and `strictTools` adds `strict: true` to function tools.

Image input is gated by both model metadata and configuration: only `deepseek-v4-flash-vision-exp` declares image capability, and the setting must not be `false`. Text-only models therefore never send stored base64 image bytes or advertise `view_image`. They retain an explicit omission marker or metadata instead, and compaction continues so image-bearing history does not prevent later checkpoints after a provider switch.

## Authentication and shared request behavior

The model prefers `apiKey` from its direct configuration; otherwise it reads `DEEPSEEK_API_KEY`. Kana's product layer normally resolves the environment-variable name from `config.toml`. Requests use Bearer authentication and may include configured custom headers.

Cancellation, inactivity timeout, bounded error bodies, HTTP retry timing, lifecycle diagnostics, and context-window normalization follow the shared provider contract in [Providers](providers.md). DeepSeek additionally recognizes its context-limit error codes and messages before allowing the Agent's one safe compaction recovery.

## SSE parsing and content order

All V4 models use the shared semantic Responses processor described in [Providers](providers.md). DeepSeek removes its `ws_call_id` replay marker from presented search queries and URL fragments while preserving the raw item in `providerState`; completed state is tagged with `provider = "deepseek"`.

## Usage

DeepSeek maps input, output, total, cached, and reasoning tokens into the common `ModelUsage` fields. Context occupancy and accumulated process usage follow the shared runtime rules.
## Extension notes

- Keep provider output in `AssistantMessageEvent` and emit deep-cloned snapshots for every event.
- Do not flatten provider ordering of thinking, text, and calls; Agent history and the TUI rely on ordered content.
- Shared Responses code owns semantic SSE item assembly only. Provider adapters still own request fields, endpoint selection, authentication, retry policy, and replay rules.
- New retry conditions must distinguish cancellation, which must never retry.
- Adding a model requires updating metadata, product-config allowed values, and usage-display tests.
