# DeepSeek provider adapter

Kana's product configuration currently uses DeepSeek; its adapter lives in `src/providers/deepseek`. The adapter converts `core`'s generic messages and tool protocol into streaming DeepSeek `/chat/completions` requests, then reconstructs SSE deltas into ordered assistant content.

## Model and metadata

`DeepSeekModel` extends `BaseModel`. `stream(context)` synchronously returns an `AssistantEventStream`, while the network request writes to it asynchronously; `generate()` therefore collects the same stream rather than taking a separate non-streaming path.

Current built-in metadata:

| Model | Context window | Max output | Input / output / cache-read price (CNY per million tokens) |
| --- | ---: | ---: | --- |
| `deepseek-v4-flash` | 1,000,000 | 384,000 | 1 / 2 / 0.02 |
| `deepseek-v4-pro` | 1,000,000 | 384,000 | 3 / 6 / 0.025 |

Cache-write price is currently zero. Constructing an unknown model errors, and a request whose `maxTokens` exceeds the model hard output limit errors before network I/O. The TUI uses metadata for context percentage and accumulated CNY cost.

## Request conversion

The default base URL is `https://api.deepseek.com`, with fixed request path `/chat/completions`. Requests always include:

```json
{
  "model": "…",
  "messages": ["…"],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

The system prompt is held outside the generic `ModelContext` message history and is sent as the first `system` message. User messages map directly; tool results become `tool` messages with `tool_call_id`. Ordered assistant content becomes one DeepSeek assistant message: all text joins into `content`, all thinking joins into `reasoning_content`, and calls become `tool_calls`. When streamed `rawArgs` exist, they are sent back preferentially so reserialization cannot change call content.

Provided optional configuration maps to DeepSeek fields:

| Kana / `DeepSeekModelConfig` | Request field |
| --- | --- |
| `temperature` | `temperature` |
| `maxTokens` | `max_tokens` |
| `topP` | `top_p` |
| `thinking` | `thinking.type`, `enabled`/`disabled` |
| `reasoningEffort` | `reasoning_effort` |
| `responseFormat` | `response_format` |
| `userId` | `user_id` |

When `thinking` is explicitly `false`, `reasoning_effort` is omitted because DeepSeek rejects the combination. When context has tools, each TypeBox schema passes through as function `parameters` and default `tool_choice` is `auto`; `strictTools` adds `strict: true` to every function. Without context tools, `toolChoice` is sent only when explicitly configured.

## Authentication, cancellation, timeout, and retries

The model prefers `apiKey` from its config, otherwise reads `DEEPSEEK_API_KEY`. Kana's product layer normally reads the environment variable selected in `config.toml` and passes it in configuration; direct `DeepSeekModel` use gets this fallback. Requests carry `Authorization: Bearer <key>`, `content-type: application/json`, and `accept: text/event-stream`, plus optional custom headers.

`createRequestSignal` combines the Agent cancellation signal with optional `timeoutMs`. Timeout aborts the request, and completion cleans up the timer and listener. HTTP 408, 429, and all 5xx responses are retryable; other HTTP failures are not. Non-HTTP errors are also retryable unless aborted. Backoff is 1s, 2s, 4s, 8s, then remains 8s, up to `maxRetries` retries.

Any thrown error becomes a provider `error` event: a DOM `AbortError` or an aborted upper signal maps to `aborted`; everything else maps to `error`. The event includes the assistant message snapshot accumulated through failure, letting the Agent retain usable partial text.

## SSE parsing and content order

The response reader splits SSE frames on blank lines and retains incomplete trailing frames across network chunks. Each frame collects all `data:` lines; `[DONE]` immediately ends reading. JSON payloads go to `applyDeepSeekChunk`.

```text
reasoning_content delta
  → thinking_start (first) → thinking_delta*
content delta
  → end all open thinking
  → text_start (first) → text_delta*
tool_calls delta
  → end all open thinking/text
  → toolcall_start (first) → toolcall_delta*
finish_reason = tool_calls
  → parse rawArgs → toolcall_end
```

Tool deltas use the provider `index` to address the Nth tool block in the current message. IDs, function names, and arguments may concatenate across chunks; missing arguments become `{}`, while non-JSON arguments remain raw strings. Starting visible text or a tool call closes an open block of a different kind, keeping event order and the `content` array consistent.

Finish reasons map as `stop → stop`, `length → length`, and `tool_calls → toolUse`. `content_filter` and `insufficient_system_resource` are errors. Usage in stream chunks maps to generic fields including prompt cache hit/miss and reasoning tokens.

## Usage and cost

`ModelUsage` records prompt, completion, and total tokens, with optional cache hit/miss and reasoning tokens. Cost uses CNY per million tokens: cache misses bill as normal input and cache hits bill at the cache-read price; when only one cache field exists, the other portion is inferred from `promptTokens`. Accumulated usage adds each field, while context percentage is the latest assistant usage's `promptTokens / contextWindow`, clamped to 0–100%.

## Extension notes

- Keep provider output in `AssistantMessageEvent` and emit deep-cloned snapshots for every event.
- Do not flatten provider ordering of thinking, text, and calls; Agent history and the TUI rely on ordered content.
- New retry conditions must distinguish cancellation, which must never retry.
- Adding a model requires updating metadata, product-config allowed values, and cost-display tests.
