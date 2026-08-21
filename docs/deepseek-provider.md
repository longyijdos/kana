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

Constructing an unknown model errors, and a request whose `maxTokens` exceeds the model hard output limit errors before network I/O. Common `ModelMetadata.protocol` selects the protocol codec, while `supportsHostedWebSearch` records capability separately from the user's `web_search` setting. The TUI uses metadata for context percentage. DeepSeek metadata permits `agent.parallel_tool_calls`, but ToolRuntime still forces serial execution when the user disables that setting. Kana intentionally does not embed provider pricing; actual charges come from DeepSeek billing.

Both models expose `none`, `low`, `high`, and `max` through common reasoning metadata. `model.deepseek.reasoning_effort = "none"` disables reasoning; the previous separate `thinking` switch is no longer part of the configuration or request contract.

## Request conversion

The default base URL is `https://api.deepseek.com`, and all current models send requests to `/responses`.

Image input follows the selected model's metadata and the `model.deepseek.image_input` setting. `deepseek-v4-flash-vision-exp` accepts persisted user images as classic Responses `input_image` items with self-contained base64 data URLs. The text-only V4 Flash and V4 Pro models replace persisted user images with an explicit attachment-omitted marker and never transmit their base64 data; model metadata takes precedence, so enabling `image_input` cannot add image delivery to a model that declares no image capability, and `model.deepseek.image_input = false` disables delivery even on the vision model.

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
| `ModelContext.maxOutputTokens ?? maxTokens` | `max_output_tokens` |
| `topP` | `top_p` |
| `reasoningEffort` | `reasoning.effort` |
| `responseFormat` | `text.format` |
| `userId` | `user` |

A per-turn output ceiling takes precedence over configured `maxTokens`. Client functions use flattened Responses tool definitions. When `model.deepseek.web_search = true` and metadata supports it, `{ "type": "web_search" }` is appended to the same `tools` array; `false` removes only the hosted tool. Default `tool_choice` is `auto`, named Chat Completions choices are converted to the flattened Responses shape, and `strictTools` adds `strict: true` to function tools.

Image input is gated by both model metadata and configuration: only `deepseek-v4-flash-vision-exp` declares image capability, and the setting must not be `false`. Text-only models therefore never send stored base64 image bytes. They retain an explicit omission marker or metadata instead, and compaction continues so image-bearing history does not prevent later checkpoints after a provider switch.

## Authentication, cancellation, timeout, and retries

The model prefers `apiKey` from its config, otherwise reads `DEEPSEEK_API_KEY`. Kana's product layer normally reads the environment variable selected in `config.toml` and passes it in configuration; direct `DeepSeekModel` use gets this fallback. Requests carry `Authorization: Bearer <key>`, `content-type: application/json`, and `accept: text/event-stream`, plus optional custom headers.

`createRequestSignal` combines the Agent cancellation signal with optional `timeoutMs`. `timeoutMs` is an inactivity timeout: it limits the wait for response headers and restarts when headers or any response bytes arrive. A long reasoning stream can therefore exceed the configured duration while data continues, but the request is still aborted when the connection stops transferring data for that duration. Completion cleans up the timer and listener. HTTP 408, 429, and all 5xx responses are retryable; other HTTP failures are not. Non-HTTP errors are also retryable unless aborted. Backoff is 1s, 2s, 4s, 8s, then remains 8s, up to `maxRetries` retries.

Any thrown error becomes a provider `error` event: a DOM `AbortError` or an aborted upper signal maps to `aborted`; everything else maps to `error`. The event includes the assistant message snapshot accumulated through failure, letting the Agent retain usable partial text.

An HTTP 400, 413, or 422 is converted to generic `ContextWindowExceededError` only when its error code/message clearly matches a context-length/window or input/prompt-token limit. Ordinary parameter failures remain their original `DeepSeekHttpError`. The Agent catches this type only before any assistant output, performs one safe context compaction, and retries the current request once. Provider failure logs still retain only error type, status, and status text; they never record the response message inspected up to 4096 characters.

## SSE parsing and content order

All V4 models use the shared `src/providers/responses` semantic SSE processor also used by OpenAI Codex. It correlates output items by `output_index` and item ID, preserves reasoning/message/function/search order, maps `web_search_call` to `hosted_tool`, and finishes only after `response.completed`, `response.incomplete`, or `response.failed`. DeepSeek's `ws_call_id` replay marker is removed from semantic search queries and URL fragments before presentation, while the raw output item remains unchanged in `providerState`. Completed items retain `providerState.provider = "deepseek"`; `response.incomplete` maps to `length`, a response containing client function calls maps to `toolUse`, and hosted searches alone still map to `stop`. Responses usage maps input, output, total, cached, and reasoning tokens.

## Usage

`ModelUsage` records prompt, completion, and total tokens, with optional cache hit/miss and reasoning tokens. Accumulated usage adds each field, while context percentage is the latest assistant usage's `promptTokens / effective context limit`, clamped to 0–100%. That effective limit is the smaller of `agent.context_limit` and the model metadata context window, or the metadata window when no cap is configured. Summary-request usage contributes to main-run accumulated usage without replacing the latest normal model request's context percentage.

## Extension notes

- Keep provider output in `AssistantMessageEvent` and emit deep-cloned snapshots for every event.
- Do not flatten provider ordering of thinking, text, and calls; Agent history and the TUI rely on ordered content.
- Shared Responses code owns semantic SSE item assembly only. Provider adapters still own request fields, endpoint selection, authentication, retry policy, and replay rules.
- New retry conditions must distinguish cancellation, which must never retry.
- Adding a model requires updating metadata, product-config allowed values, and usage-display tests.
