# Model and provider protocols

Kana keeps the model contract provider-neutral while allowing each adapter to own its wire format, authentication, retry decisions, and replay rules. Shared provider code supplies narrow HTTP, diagnostics, context-limit, Chat Completions, and Responses primitives; it is not a generic runtime plugin system.

## Model contract and metadata

`Model` exposes immutable `metadata`, `stream(context)`, and `generate(context)`. `BaseModel.generate()` collects the same event stream used by interactive execution, so streaming and non-streaming callers do not create separate behavior paths.

`ModelMetadata` describes the selected model rather than the provider in general:

| Field | Meaning |
| --- | --- |
| `provider`, `model` | Stable product and model identity. |
| `protocol` | Shared `responses`, `chat-completions`, or `null` for an in-process/specialized model. |
| `contextWindow` | Hard model context capacity. |
| `maxOutputTokens` | Hard ceiling for one completion. |
| `supportsParallelToolCalls` | Whether the wire/model combination can request parallel calls. |
| `supportsHostedWebSearch` | Whether the model can use provider-hosted search. |
| `supportsImageInput` | Whether provider requests may include images. |
| `reasoning` | Optional user-selectable efforts and their model-owned default. |

Metadata is capability, not policy. The Agent intersects it with configuration before constructing `ModelContext`: image, web-search, and parallel-tool behavior may be disabled even when the model supports them. Context and output preferences are likewise clamped to metadata limits before requests reach an adapter.

`src/providers/index.ts` is the typed built-in factory for DeepSeek, OpenAI Codex, and the test Mock model. Kana's single Custom slot directly constructs the reusable OpenAI-compatible model from validated product configuration; arbitrary provider IDs and runtime-loaded adapters are not supported.

## Adapter layering

```text
Agent ModelContext
  → provider adapter
      ├→ provider-owned request, auth, retry loop, and replay
      ├→ shared HTTP and lifecycle primitives
      └→ shared wire processor when applicable
          ├→ OpenAI-compatible Chat Completions
          └→ semantic Responses SSE
  → AssistantMessageEvent stream
```

The adapter is always responsible for endpoint selection, request fields, authentication, and deciding which failures are safe to retry. Shared code never silently chooses another provider, endpoint, or protocol.

Provider-specific behavior remains in [DeepSeek](deepseek-provider.md), [OpenAI Codex](openai-codex-provider.md), and [Custom OpenAI-compatible](custom-provider.md).

## Lifecycle diagnostics

Network adapters use one diagnostic vocabulary for request start, HTTP retry, authentication refresh, Responses stream recovery, completion, and failure. Every record includes provider, model, protocol, phase, and outcome. Retry and failure records add only safe fields such as attempt, delay, HTTP status, fixed Kana `errorCode`, safe `errorType`, stream event type, or bounded upstream `providerCode`.

Phases are `validation`, `authentication`, `request_build`, `http_request`, and `response_stream`. Stable error codes distinguish cancellation, inactivity timeout, validation, authentication, request construction, HTTP/network failure, stream failure, transient stream failure, and context-window exhaustion.

Diagnostics never contain API keys, account IDs, request headers, endpoint URLs, prompts, model output, tool arguments, response bodies, or error messages. Logger failures are contained and cannot alter provider control flow.

## Cancellation, inactivity, and HTTP retry primitives

The shared request signal links an optional Agent abort signal with an inactivity timer. The timer covers the wait for response headers and is refreshed by raw response bytes, including heartbeat or partial SSE data. A long active stream may therefore exceed `timeoutMs`; a connection that transfers no data for that period is aborted as `timed_out`.

Upstream cancellation and inactivity timeout remain distinct outcomes. Both stop retry admission, abort pending retry delay, and prevent further requests. Adapters dispose the timer and linked listener when their complete request lifecycle settles.

Shared retry helpers classify HTTP `408`, `429`, and `5xx` as retryable, parse `Retry-After` as seconds or an HTTP date with a 30-second cap, and otherwise use exponential delays of 1, 2, 4, then 8 seconds. The adapter still owns the loop and its `maxRetries` budget. Retained HTTP error bodies are bounded to 16 KiB.

Redirects are rejected by current authenticated adapters so credentials cannot be forwarded to a different origin. Provider-specific configuration decides whether an endpoint may use HTTP; callers should use HTTPS whenever credentials cross an untrusted network.

## Context-window normalization

The Agent can perform one safe compaction recovery only for a definite `ContextWindowExceededError` raised before assistant output begins. Provider helpers therefore normalize an HTTP `400`, `413`, or `422` only when a structured code, bounded message signal, or explicit adapter signal identifies a context/window or prompt/input-token limit. Ordinary invalid parameters retain their original provider error.

Adapters may extend the recognized signal set, but must not turn ambiguous server failures into automatic request replay. A second context rejection, partial output, or absence of a safe compaction boundary remains terminal; the Agent-side recovery contract is documented in [Agent runtime](agent-runtime.md).

## OpenAI-compatible Chat Completions

`src/providers/openai-compatible` converts the stable system prompt, user/assistant/tool history, and local function tools into a streaming Chat Completions request. It sends `stream_options.include_usage`, maps the effective parallel-tool flag when tools exist, and includes `reasoning_effort` only when product/model configuration supplies one.

User images become data-URL `image_url` parts only when model metadata enables image input. Chat Completions tool-role messages cannot carry images, so contiguous tool results remain in place and their images are appended afterward as one synthetic multimodal user observation. A text-only model receives explicit omission text instead of image bytes.

Cross-provider replay sends visible assistant text and local function calls. Provider-owned reasoning and hosted-tool state is not reinterpreted for a generic Chat Completions endpoint.

The SSE reader preserves partial frames across network chunks, ignores heartbeat-only frames, incrementally assembles ordered reasoning text, visible text, and tool calls, and maps `stop`, `length`, and `tool_calls` to core stop reasons. Extra completion choices are ignored because Kana requests one assistant message. Incomplete or contradictory tool-call termination is a protocol failure rather than guessed output.

## Semantic Responses processing

`src/providers/responses` owns semantic assembly for adapters using Responses SSE. It does not build requests or authenticate. The processor correlates output by `output_index` and item ID and maps reasoning, message, function-call, and `web_search_call` items into ordered core content and events.

Completed provider items are retained as opaque `providerState` so the owning adapter can replay stateless conversations. Core, Agent, session storage, and frontends preserve but do not interpret that value. Final completed items may correct accumulated deltas; duplicate completion events do not emit duplicate content.

`response.completed` and equivalent terminal events produce `stop` or `toolUse`; incomplete responses produce `length`. `error` and `response.failed` preserve safe upstream identity and classify only known overload, server, internal, temporary-unavailability, and rate-limit conditions as transient. Each adapter decides whether its remaining retry budget and output-start boundary permit replay.

## Usage

All adapters map provider counters into `ModelUsage`: prompt, completion, and total tokens, with optional cache-hit, cache-miss, and reasoning counts. Kana accumulates the provider values without estimating price. Context occupancy uses the Agent's replayable-context estimate against the effective context limit rather than treating billed provider input as identical to persisted history.

## Adding or changing an adapter

- Keep provider output in ordered core content and emit complete cloned snapshots.
- Keep endpoint, authentication, request conversion, replay, and retry admission inside the adapter.
- Reuse shared codecs only for the wire semantics they actually implement.
- Validate request budgets against model metadata before network I/O.
- Normalize context-limit failures narrowly and never retry cancellation.
- Emit safe lifecycle identities without credential, prompt, response, or endpoint data.
- Update provider metadata, configuration choices, the provider-specific document, and relevant request/stream tests together.
