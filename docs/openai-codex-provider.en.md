# OpenAI Codex provider adapter

Kana's `openai-codex` adapter lives in `src/providers/openai-codex`. It uses ChatGPT Codex OAuth credentials to call the Codex Responses Lite stream, reconstructing reasoning summaries, visible text, and function calls as ordered `core` assistant content.

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
max_tokens = 32768
timeout_ms = 60000
max_retries = 1
```

See [Configuration and installation](configuration.en.md) for available models and fields.

## Request conversion

`OpenAICodexModel` sends a streaming request to `https://chatgpt.com/backend-api/codex/responses`. The Bearer token and ChatGPT account ID exist only in request headers and are not written to logs or sessions.

The request follows the Responses Lite contract:

- Tools are developer `additional_tools` input items rather than a top-level `tools` field.
- The system prompt is a developer message; user messages, tool results, and assistant output items follow in input order.
- `store = false` and `stream = true`, with `reasoning.encrypted_content` requested.
- `parallel_tool_calls = false`. Responses Lite does not support top-level parallel tool calls, so model metadata overrides `agent.parallel_tool_calls = true`; Kana also serializes any unexpected multiple calls.
- Reasoning configuration carries effort, summary type, and `all_turns` context.
- `max_tokens` is Kana's local context-budget output reserve; the backend request omits the rejected `max_output_tokens` field.

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
| `response.completed` / `response.incomplete` | terminal stop reason and usage |

Output items use `output_index` as their primary address and item ID as a fallback. Argument deltas for multiple function calls may interleave and still update their respective content blocks. Final item content corrects accumulated deltas, and duplicate completed items are not emitted twice. `response.incomplete` maps to `length`; a completed response containing function calls maps to `toolUse`; everything else maps to `stop`.

Every completed item is attached to its assistant content as opaque `providerState`. A later turn removes the server item ID and replays reasoning encrypted content, messages, or function calls unchanged. This preserves reasoning continuity with `store = false`. Summary text without a provider item is never reconstructed as reasoning input.

## Failures, retries, and usage

The first HTTP `401` triggers one credential refresh and retries with the new token. HTTP 408, 429, 5xx, and network failures use bounded exponential-backoff retries; Agent cancellation and inactivity timeout stop immediately. A recognized context-window rejection maps to `ContextWindowExceededError`, allowing one safe Agent compaction recovery when no output has started.

Diagnostics use stable provider-request, authentication-refresh, retry, and failure events. They contain only provider, model, phase, outcome, error type, or HTTP status. Logs never contain tokens, account IDs, headers, prompts, complete tool arguments, or response bodies.

Responses usage maps to input, output, cache-hit/miss, and reasoning tokens. ChatGPT subscription usage is quota-based rather than billed through Kana API accounting, so these model metadata currently carry zero CNY cost.
