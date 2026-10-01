# OpenAI Codex provider adapter

Kana's `openai-codex` adapter lives in `src/providers/openai-codex`. It uses Sign in with ChatGPT (SIWC) OAuth credentials to call the public Responses API stream, reconstructing reasoning summaries, provider-hosted web searches, visible text, and function calls as ordered `core` assistant content.

## Activation and authentication

```bash
kana auth login openai-codex
kana auth login openai-codex --new-account
kana auth status openai-codex
kana auth logout openai-codex
```

`login` uses Authorization Code, PKCE S256, state, and a fresh OIDC nonce, with the browser callback at `http://127.0.0.1:1455/auth/callback`. First sign-in sends `client_id=dynamic_agent_client`, `agent_name_hint=kana`, and a persistent UUID host ID. The issued client ID is retained before code exchange; a failed exchange can reuse that pending registration. Returning sign-in reuses the issued client ID and retained ID-token/email hints. `--new-account` registers a different account or workspace and replaces the single active connection only after identity validation.

The access token, ID token, rotating refresh token, granted scopes, expiry, and binding metadata are stored under `provider:openai-codex` in `<KANA_HOME>/oauth-tokens.json`. Its `openaiCodex` record holds `hostId`, the verified `registration` (`clientId`, `subject`, optional `email`), and an optional `pendingClientId`. Verified registration and credentials are written atomically with mode `0600`. Legacy Codex credentials are not sent to the new API and remain untouched until successful sign-in replaces them. `kana install`, rebuilding Kana, and replacing its binary do not delete credentials.

Kana verifies ID-token signatures against OpenAI's JWKS and checks issuer, issued-client audience, expiration, nonce, and the returning account's subject. Inference requires the granted `chatgpt.tokens.use.direct` scope; identity-only sign-in remains saved with plan usage disabled. An explicit later `login` requests consent when that permission is absent. Both token exchanges and refresh grants use form encoding at `https://auth.openai.com/api/accounts/oauth/token` with `resource=https://api.openai.com/v1`. Refresh omits `scope`, preserves omitted replacement fields, and reloads credentials under a host lock to serialize rotating tokens across processes. Terminal refresh errors clear tokens while retaining registration.

`status` shows safe account information and whether ChatGPT plan usage is enabled. `logout` attempts refresh-token revocation using OpenAI's discovery document, clears local tokens, and keeps the client registration and host ID. If remote revocation cannot be confirmed, it reports that local sign-out completed and directs the user to ChatGPT settings. Model names and capability metadata remain statically maintained in Kana.

Provider transport and Agent selection are configured separately:

```toml
[provider.openai-codex]
reasoning_summary = "auto"
timeout_ms = 60000
max_retries = 1

[agent]
web_search = true
image_input = true

[agent.model]
provider = "openai-codex"
name = "gpt-5.6-luna"
reasoning_effort = "medium"
max_output_tokens = 128000
```

See [Configuration and installation](configuration.md) for available models and fields.

## Model metadata

Kana maintains a static model catalog. Context ceilings and reasoning controls follow the SIWC/Codex account catalog, which can differ from API-key model specifications. `contextWindow` uses the catalog's `max_context_window`, so it also sets the default Agent context budget unless `context_limit` is configured. The catalog's smaller default `context_window` is not used as this ceiling. See [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) for the account catalog endpoint.

| Model | Context ceiling | Default reasoning effort |
| --- | --- | --- |
| `gpt-6.1-sol` | 872,000 | `low` |
| `gpt-6-astra` | 872,000 | `low` |
| `gpt-6-sol` | 872,000 | `medium` |
| `gpt-6-luna` | 872,000 | `medium` |
| `gpt-5.6-sol` | 872,000 | `low` |
| `gpt-5.6-terra` | 872,000 | `medium` |
| `gpt-5.6-luna` | 872,000 | `medium` |
| `gpt-5.5` | 272,000 | `medium` |

All listed models support image input, parallel function calls, and hosted web search, with a 128,000-token output ceiling from the public [model reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol). Reasoning efforts are `low`, `medium`, `high`, `xhigh`, and `max`, except GPT-5.5 stops at `xhigh`. Ultra is client orchestration and is not a wire reasoning effort. Hidden catalog entries are not included.

## Request conversion

`OpenAICodexModel` sends a streaming request to `https://api.openai.com/v1/responses`. The OAuth access token is sent as a Bearer credential; no ChatGPT account-ID header is required. Tokens are not written to logs or sessions.

The request follows one complete classic Responses contract:

- Function tools executed by Kana are grouped in the `kana` namespace within the top-level `tools` array. With `web_search = true`, the provider-hosted `{ "type": "web_search" }` tool is appended to that same array and `tool_choice: "auto"` lets the model decide whether to use it. Setting the option to `false` removes only the hosted tool; client function tools remain available.
- The system prompt uses top-level `instructions`; user messages, tool results, and assistant output items remain in input order.
- User image attachments become classic Responses `input_image` items with self-contained data URLs. `view_image` is registered by the same effective capability gate, and its visual result becomes native multimodal `function_call_output` content tied to the originating call. Context compaction sends both user and tool images so its summary can preserve visual details as text. When `image_input = false`, Kana omits the tool, sends no image bytes, and appends an explicit text omission marker instead.
- `store = false` and `stream = true`, with `reasoning.encrypted_content` requested.
- `parallel_tool_calls` follows the effective Agent setting after model-capability gating. All models in the static catalog support parallel calls; ToolRuntime still serializes calls when user policy disables parallelism or tool execution metadata does not permit concurrency.
- Reasoning configuration carries effort and summary type but omits `reasoning.context`, leaving the effective persisted-reasoning mode to the backend. Accepted efforts and defaults come from the selected model's metadata.
- Kana uses the Agent model's configured `max_output_tokens` and remaining context to calculate each turn's `ModelContext.maxOutputTokens`. The SIWC preview contract does not support `max_output_tokens`, so the wire request omits it.
- Local function calls retain their `kana` namespace during replay, including calls saved before this migration. Kana uses its own tool execution and MCP integration; unsupported hosted MCP, `tool_search`, image generation, and Code Interpreter are not advertised by this adapter.

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

Every completed item is attached to its assistant content as opaque `providerState`. A later turn removes the server item ID and replays reasoning encrypted content, messages, function calls, or `web_search_call` items, adding the `kana` namespace to local function calls. This preserves reasoning and search continuity with `store = false`. Summary text without a provider item is never reconstructed as reasoning input.

## Search presentation and citations

Hosted searches never enter Kana's ToolRuntime, approval flow, or tool-result messages. The TUI renders one action block per `web_search_call` in provider order: an active call shows `Searching the web`; a completed action becomes `Searched the web`, `Opened a web page`, or `Searched within a web page`, followed by a control-character-safe, bounded query or page target. Calls are not aggregated today. A blank row separates each visible action block and the following assistant text, matching the rest of the transcript.

The final message's `output_text.text` enters Markdown rendering unchanged. Provider-supplied inline Markdown links therefore retain their label and visible URL. `url_citation` annotations remain attached to the completed message in `providerState`; Kana does not insert `[1]` markers back into prior text or append a generated `Sources` footer. See [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search) for the protocol fields and action definitions.

## Failures, retries, and usage

The first HTTP `401` triggers one credential refresh and one retry. ChatGPT plan usage-limit errors stop requests without retry and link to `https://chatgpt.com/settings/usage`; temporary usage-check and user-information failures may retry before output starts. Errors retain available HTTP status, response shape, code, parameter, and request ID, including failures after streaming begins. HTTP failures and recognized transient Responses failures share the configured retry budget; stream recovery is allowed only before assistant output or hosted-search activity begins. Context-limit rejection may enter the Agent's one safe compaction recovery before output starts.

All other cancellation, inactivity, retry, error-bound, diagnostic, and usage behavior follows [Providers](providers.md). The adapter records subscription token usage without estimating monetary cost.
