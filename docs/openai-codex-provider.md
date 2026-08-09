# OpenAI Codex provider adapter

Kana's `openai-codex` adapter lives in `src/providers/openai-codex`. It uses ChatGPT Codex OAuth credentials to call the Codex Responses stream, reconstructing reasoning summaries, provider-hosted web searches, visible text, and function calls as ordered `core` assistant content.

## Activation and authentication

```bash
kana auth login openai-codex
kana auth status openai-codex
kana auth logout openai-codex
```

`login` uses a fixed public client ID, Authorization Code, and PKCE S256, waiting for the browser callback at `http://localhost:1455/auth/callback`. The resulting access token, ID token, refresh token, expiry, and binding metadata are stored under `provider:openai-codex` in `<KANA_HOME>/oauth-tokens.json`. The token file is written with mode `0600`; `kana install`, rebuilding Kana, and replacing its binary do not delete it.

The provider requires a ChatGPT account ID. Kana reads it from the ID token first, then falls back to the access-token JWT claim. Expiring credentials refresh automatically. The current Codex token endpoint receives refresh grants as JSON while the initial authorization-code exchange remains form encoded. A token response may omit `token_type`; Kana accepts that response as Bearer only at this provider boundary.

Provider-specific configuration activates the adapter:

```toml
[provider]
active = "openai-codex"

[model.openai-codex]
name = "gpt-5.6-luna"
reasoning_effort = "medium"
reasoning_summary = "auto"
web_search = true
max_tokens = 128000
timeout_ms = 60000
max_retries = 1
```

See [Configuration and installation](configuration.md) for available models and fields.

## Request conversion

`OpenAICodexModel` sends a streaming request to `https://chatgpt.com/backend-api/codex/responses`. The Bearer token and ChatGPT account ID exist only in request headers and are not written to logs or sessions.

The request follows one complete classic Responses contract:

- Function tools executed by Kana use the top-level `tools` array. With `web_search = true`, the provider-hosted `{ "type": "web_search" }` tool is appended to that same array and `tool_choice: "auto"` lets the model decide whether to use it. Setting the option to `false` removes only the hosted tool; client function tools remain available.
- The system prompt uses top-level `instructions`; user messages, tool results, and assistant output items remain in input order.
- `store = false` and `stream = true`, with `reasoning.encrypted_content` requested.
- `parallel_tool_calls` follows the effective Agent setting after model-capability gating. The current Sol, Terra, and Luna metadata support parallel calls; ToolRuntime still serializes calls when user policy disables parallelism or tool execution metadata does not permit concurrency.
- Reasoning configuration carries effort and summary type but omits `reasoning.context`, leaving the effective persisted-reasoning mode to the backend. Accepted efforts are `low`, `medium`, `high`, `xhigh`, and `max`; Ultra is a Codex client orchestration mode and Kana does not send it as a request effort.
- Kana uses configured `max_tokens` and remaining context to calculate each turn's `ModelContext.maxOutputTokens`. The ChatGPT Codex request contract used here does not expose `max_output_tokens`, so the wire request omits it.
- Kana sends neither the Responses Lite header nor Lite-only input markers. Lite should be reconsidered only after OpenAI stabilizes a hosted-tool-compatible contract; its header and request body must never be enabled independently.

A Codex reasoning summary is not raw chain-of-thought. Kana can stream the summary as thinking events, but the TUI uses those events only for its temporary thinking state and does not render the summary body.

## SSE and ordered content

The reader retains incomplete SSE frames across network chunks and parses every frame when one body chunk contains several. The primary event mapping is:

| Codex SSE | Kana event |
| --- | --- |
| reasoning `response.output_item.added` | `thinking_start` |
| `response.reasoning_summary_text.delta` | `thinking_delta` |
| reasoning `response.output_item.done` | `thinking_end` |
| message `response.output_item.added` | `text_start` |
| `response.output_text.delta` / `response.refusal.delta` | `text_delta` |
| message `response.output_item.done` | `text_end` |
| function-call added / argument delta / item done | `toolcall_start` / `toolcall_delta` / `toolcall_end` |
| web-search-call added / item done | `hosted_tool_start` / `hosted_tool_end` |
| `response.completed` / `response.incomplete` | terminal stop reason and usage |

Output items use `output_index` as their primary address and item ID as a fallback. Argument deltas for multiple function calls may interleave and still update their respective content blocks. A `web_search_call.action` preserves normalized `search`, `open_page`, or `find_in_page` details, including queries, URLs, and page patterns. Final item content corrects accumulated deltas, and duplicate completed items are not emitted twice. `response.incomplete` maps to `length`; a completed response containing local function calls maps to `toolUse`, while a response containing only hosted searches still maps to `stop`.

Every completed item is attached to its assistant content as opaque `providerState`. A later turn removes the server item ID and replays reasoning encrypted content, messages, function calls, or `web_search_call` items unchanged. This preserves reasoning and search continuity with `store = false`. Summary text without a provider item is never reconstructed as reasoning input.

## Search presentation and citations

Hosted searches never enter Kana's ToolRuntime, approval flow, or tool-result messages. The TUI renders one action block per `web_search_call` in provider order: an active call shows `Searching the web`; a completed action becomes `Searched the web`, `Opened a web page`, or `Searched within a web page`, followed by a control-character-safe, bounded query or page target. Calls are not aggregated today. A blank row separates each visible action block and the following assistant text, matching the rest of the transcript.

The final message's `output_text.text` enters Markdown rendering unchanged. Provider-supplied inline Markdown links therefore retain their label and visible URL. `url_citation` annotations remain attached to the completed message in `providerState`; Kana does not insert `[1]` markers back into prior text or append a generated `Sources` footer. See [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search) for the protocol fields and action definitions.

## Failures, retries, and usage

The first HTTP `401` triggers one credential refresh and retries with the new token. HTTP 408, 429, 5xx, and network failures use bounded exponential-backoff retries; Agent cancellation and inactivity timeout stop immediately. A recognized context-window rejection maps to `ContextWindowExceededError`, allowing one safe Agent compaction recovery when no output has started.

Diagnostics use stable provider-request, authentication-refresh, retry, and failure events. They contain only provider, model, phase, outcome, error type, or HTTP status. Logs never contain tokens, account IDs, headers, prompts, complete tool arguments, or response bodies.

Responses usage maps to input, output, cache-hit/miss, and reasoning tokens. ChatGPT subscription usage is quota-based rather than billed through Kana API accounting, so these model metadata currently carry zero CNY cost.
