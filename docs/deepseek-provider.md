# DeepSeek provider adapter

Kana's product configuration currently uses DeepSeek; its adapter lives in `src/providers/deepseek`. Model metadata selects a shared wire protocol: V4 Flash uses the Responses API, while V4 Pro remains on Chat Completions until DeepSeek officially exposes Responses support for it. Both paths reconstruct streaming output into the same ordered assistant content.

## Model and metadata

`DeepSeekModel` extends `BaseModel`. `stream(context)` synchronously returns an `AssistantEventStream`, while the network request writes to it asynchronously; `generate()` therefore collects the same stream rather than taking a separate non-streaming path.

Current built-in metadata:

| Model | Protocol | Context window | Max output | Parallel tool calls | Hosted web search | Image input | Input / output / cache-read price (CNY per million tokens) |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `deepseek-v4-flash` | Responses | 1,000,000 | 384,000 | Supported | Supported | Not supported | 1 / 2 / 0.02 |
| `deepseek-v4-pro` | Chat Completions | 1,000,000 | 384,000 | Supported | Not yet supported | Not supported | 3 / 6 / 0.025 |

Cache-write price is currently zero. Constructing an unknown model errors, and a request whose `maxTokens` exceeds the model hard output limit errors before network I/O. Common `ModelMetadata.protocol` selects the protocol codec, while `supportsHostedWebSearch` records capability separately from the user's `web_search` setting. The TUI uses metadata for context percentage and accumulated CNY cost. DeepSeek metadata permits `agent.parallel_tool_calls`, but ToolRuntime still forces serial execution when the user disables that setting.

## Protocol selection and request conversion

The default base URL is `https://api.deepseek.com`. Authentication, cancellation, timeout, retries, error normalization, and lifecycle logging are shared, while metadata chooses the endpoint and request codec.

Both current DeepSeek models are text-only. If a persisted user message contains images, both request codecs replace them with an explicit attachment-omitted marker and never transmit their base64 data. `model.deepseek.image_input` is reserved for future metadata support and cannot override a model that declares no image capability.

### V4 Flash Responses

V4 Flash sends `POST /responses` with semantic input items:

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
| `thinking = false` | `reasoning.effort = "none"` |
| `reasoningEffort` | `reasoning.effort` |
| `responseFormat` | `text.format` |
| `userId` | `user` |

A per-turn output ceiling takes precedence over configured `maxTokens`. Client functions use flattened Responses tool definitions. When `model.deepseek.web_search = true` and metadata supports it, `{ "type": "web_search" }` is appended to the same `tools` array; `false` removes only the hosted tool. Default `tool_choice` is `auto`, named Chat Completions choices are converted to the flattened Responses shape, and `strictTools` adds `strict: true` to function tools.

### V4 Pro Chat Completions

V4 Pro continues to send `POST /chat/completions`:

```json
{
  "model": "…",
  "messages": ["…"],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

The system prompt becomes the first `system` message. User messages map directly; tool results become `tool` messages with `tool_call_id`. Ordered assistant content becomes one assistant message: text joins into `content`, thinking joins into `reasoning_content`, and calls become `tool_calls`. Streamed `rawArgs` are replayed preferentially. This path sends `max_tokens`, `thinking.type`, `reasoning_effort`, `response_format`, and `user_id` under their Chat Completions names. When `thinking` is explicitly false, `reasoning_effort` is omitted. The provider-level `web_search` setting remains configured but has no effect until V4 Pro gains Responses and hosted-search support.

## Authentication, cancellation, timeout, and retries

The model prefers `apiKey` from its config, otherwise reads `DEEPSEEK_API_KEY`. Kana's product layer normally reads the environment variable selected in `config.toml` and passes it in configuration; direct `DeepSeekModel` use gets this fallback. Requests carry `Authorization: Bearer <key>`, `content-type: application/json`, and `accept: text/event-stream`, plus optional custom headers.

`createRequestSignal` combines the Agent cancellation signal with optional `timeoutMs`. `timeoutMs` is an inactivity timeout: it limits the wait for response headers and restarts when headers or any response bytes arrive. A long reasoning stream can therefore exceed the configured duration while data continues, but the request is still aborted when the connection stops transferring data for that duration. Completion cleans up the timer and listener. HTTP 408, 429, and all 5xx responses are retryable; other HTTP failures are not. Non-HTTP errors are also retryable unless aborted. Backoff is 1s, 2s, 4s, 8s, then remains 8s, up to `maxRetries` retries.

Any thrown error becomes a provider `error` event: a DOM `AbortError` or an aborted upper signal maps to `aborted`; everything else maps to `error`. The event includes the assistant message snapshot accumulated through failure, letting the Agent retain usable partial text.

An HTTP 400, 413, or 422 is converted to generic `ContextWindowExceededError` only when its error code/message clearly matches a context-length/window or input/prompt-token limit. Ordinary parameter failures remain their original `DeepSeekHttpError`. The Agent catches this type only before any assistant output, performs one safe context compaction, and retries the current request once. Provider failure logs still retain only error type, status, and status text; they never record the response message inspected up to 4096 characters.

## SSE parsing and content order

V4 Flash uses the shared `src/providers/responses` semantic SSE processor also used by OpenAI Codex. It correlates output items by `output_index` and item ID, preserves reasoning/message/function/search order, maps `web_search_call` to `hosted_tool`, and finishes only after `response.completed`, `response.incomplete`, or `response.failed`. DeepSeek's `ws_call_id` replay marker is removed from semantic search queries and URL fragments before presentation, while the raw output item remains unchanged in `providerState`. Completed items retain `providerState.provider = "deepseek"`; `response.incomplete` maps to `length`, a response containing client function calls maps to `toolUse`, and hosted searches alone still map to `stop`. Responses usage maps input, output, total, cached, and reasoning tokens.

V4 Pro's Chat Completions reader splits SSE frames on blank lines and retains incomplete trailing frames across network chunks. Each frame collects all `data:` lines; `[DONE]` immediately ends reading. JSON payloads go to `applyDeepSeekChunk`.

```text
reasoning_content delta
  → thinking_start (first) → thinking_delta*
content delta
  → end all open thinking
  → text_start (first) → text_delta*
tool_calls delta
  → end all open thinking/text
  → on the first higher index, end all preceding tool calls
  → toolcall_start (first) → toolcall_delta*
finish_reason = tool_calls
  → parse and end the final unfinished tool call
```

Tool deltas use the provider `index` to address the Nth tool block in the current message. DeepSeek does not provide a per-call completion marker; its indexes arrive in order, so the first higher index ends every preceding call. Stream completion then ends only the final unfinished call. IDs, function names, and arguments may concatenate across chunks; missing arguments become `{}`, while non-JSON arguments remain raw strings. Starting visible text or a tool call closes an open block of a different kind, keeping event order and the `content` array consistent.

Chat Completions finish reasons map as `stop → stop`, `length → length`, and `tool_calls → toolUse`. `content_filter` and `insufficient_system_resource` are errors. Usage in stream chunks maps to generic fields including prompt cache hit/miss and reasoning tokens.

## Usage and cost

`ModelUsage` records prompt, completion, and total tokens, with optional cache hit/miss and reasoning tokens. Cost uses CNY per million tokens: cache misses bill as normal input and cache hits bill at the cache-read price; when only one cache field exists, the other portion is inferred from `promptTokens`. Accumulated usage adds each field, while context percentage is the latest assistant usage's `promptTokens / effective context limit`, clamped to 0–100%; only an unset `agent.context_limit` uses the metadata context window. Summary-request usage contributes to main-run accumulated usage and cost without replacing the latest normal model request's context percentage.

## Extension notes

- Keep provider output in `AssistantMessageEvent` and emit deep-cloned snapshots for every event.
- Do not flatten provider ordering of thinking, text, and calls; Agent history and the TUI rely on ordered content.
- Shared Responses code owns semantic SSE item assembly only. Provider adapters still own request fields, endpoint selection, authentication, retry policy, and replay rules.
- New retry conditions must distinguish cancellation, which must never retry.
- Adding a model requires updating metadata, product-config allowed values, and cost-display tests.
