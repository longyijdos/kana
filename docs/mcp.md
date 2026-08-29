# Model Context Protocol

Kana implements MCP as a stack of independent JSON-RPC, client-lifecycle, transport, authorization, tool-adaptation, multi-server, and product-runtime boundaries. Remote tools enter the Agent through the ordinary `Tool` contract; neither the Agent loop nor a provider adapter understands MCP.

## Layering

```text
KanaMcpRuntime (reloadable product boundary)
  → McpManager (multi-server startup, filtering, conflicts, diagnostics)
      ├→ McpToolAdapter → Tool
      └→ McpManagedClient
          ├→ McpClient (stable 2025-11-25 lifecycle and tool methods)
          │   → McpConnection (JSON-RPC correlation, timeout, cancellation, progress)
          │       → StdioTransport | StreamableHttpTransport
          └→ optional McpOAuthHttpAuthorizer
              → protected-resource discovery → OAuthSession
```

`McpConnection` and transports are version-neutral. `McpClient` owns the stable protocol lifecycle. `McpManager` depends on a structural managed-client interface rather than a concrete client, so another protocol version can be introduced without changing tool aggregation.

## JSON-RPC connection

The protocol parser accepts JSON-RPC 2.0 requests, notifications, and responses with string or integer IDs. Requests and notifications require object parameters; responses contain exactly one object result or a structured error. Malformed or ambiguous messages are protocol failures.

`McpConnection` allocates request IDs, correlates out-of-order responses, and rejects unknown or duplicate IDs unless they belong to a bounded set of locally cancelled requests. Every request has a configured or default timeout. An abort or timeout removes correlation state, rejects the caller, and normally sends `notifications/cancelled`; callers can mark protocol-forbidden operations such as initialization non-cancellable.

Requests with progress callbacks receive unique progress tokens in `_meta`. `notifications/progress` must contain finite, strictly increasing values for an active token. Callback failures are reported but do not corrupt the request. The connection answers server `ping` requests and returns method-not-found for other server requests.

A protocol, transport, or parsing failure rejects all pending requests and closes the transport. Explicit close is idempotent and also rejects pending work before waiting for transport cleanup.

## Stable client lifecycle

`McpClient` implements protocol version `2025-11-25`. `initialize` is the first request, uses a separate startup timeout, and is followed by `notifications/initialized` only after the server returns the same supported version. The client snapshots server identity and capabilities.

Tool methods require the server's tools capability. `tools/list` follows pagination, rejects repeated cursors, and has a finite page limit. `tools/call` supports cancellation and progress and validates the returned content envelope. Server notifications are exposed to the integration, but Kana deliberately freezes the startup tool list and logs `notifications/tools/list_changed` without mutating a live Agent.

When Streamable HTTP reports that an active session expired, the client coalesces recovery for that session generation and reinitializes without replaying the triggering operation. A successfully recovered error tells the Agent it may explicitly call the tool again. If the replacement session expires during recovery, the client closes and waiting operations fail. Automatic replay is forbidden because a tool may already have produced side effects.

## Stdio transport

`StdioTransport` launches an argument array directly through Bun without a shell and places the server in its own process group. Stdout is newline-delimited UTF-8 JSON-RPC with a 4 MiB default message limit. Invalid UTF-8/JSON, oversized or incomplete messages, protocol pollution, and unexpected process exit fail the transport.

Stderr is separate from protocol framing and goes through a protected diagnostic callback. Sends are serialized even after one write fails. Graceful close waits for queued writes, closes stdin, waits up to the shutdown timeout, signals the process group with SIGTERM, then uses SIGKILL after a second timeout. Monitor and close callbacks are reported once.

Kana's stdio composition inherits only a small baseline environment. Explicit `env` values support `${NAME}` and `${NAME:-fallback}` resolution from Kana's process environment. A missing required value fails that server. Server stderr is bounded before being written to the current session logger.

## Streamable HTTP transport

`StreamableHttpTransport` implements the `2025-11-25` single-endpoint transport. It rejects endpoint credentials, fragments, and configured overrides for transport-owned headers. Each JSON-RPC message uses a POST accepting JSON or SSE; a `202` is valid only for notifications. Initialization captures an optional `Mcp-Session-Id`, and later operations carry that ID and the negotiated protocol version.

The shared SSE decoder handles CR/LF framing across chunks, strict UTF-8, event byte limits, event IDs, and retry values. If a response stream ends before its request response but has an event ID, transport resumes with `Last-Event-ID` GET rather than replaying the POST. After initialization it also attempts a standalone GET server stream; ordinary EOF or network read failure reconnects with the last completed event ID after the server-provided or default delay.

Malformed UTF-8, SSE, JSON, unsupported content type, oversized events, wrong response IDs, and other protocol failures are fatal. HTTP `404` on a request carrying a session ID marks that session expired for client-level recovery. Recognized OAuth `401/403` challenges remain request-local so authorization can recover without corrupting transport state.

Cancellation sends the protocol notification before aborting the matching HTTP operation. Shutdown stops reconnection, aborts remaining streams, waits for active operations within a bound, and sends a bounded DELETE when a session exists. The legacy `2024-11-05` HTTP+SSE transport is not auto-detected or mixed into this state machine.

## HTTP authorization

`McpOAuthHttpAuthorizer` wraps one fetch boundary for a protected resource. It canonicalizes an HTTPS resource, discovers protected-resource metadata from a Bearer challenge or well-known URLs, verifies the returned resource, requires authorization-server issuers, and rejects metadata that does not support Authorization-header Bearer tokens.

The authorizer uses generic [OAuth](oauth.md) for authorization-server discovery, PKCE, callback, token exchange, refresh, and injected token storage. It owns one session for the exact resource and confines credentials to requests whose origin and path remain within that endpoint.

Preparation first tries stored or refreshed credentials and performs interactive authorization before MCP initialization when needed. If metadata is available only from a challenge, an idempotent HEAD probe obtains it before the initialize timeout begins. A request challenge may recover once through a stored token, refresh, or interactive authorization. A second challenge is returned to the caller.

Explicit configured scopes take precedence. If a challenge requests scopes outside that set, automatic privilege expansion is rejected and diagnosed. Requests are copied for retry without reusing consumed bodies. DELETE during close may use only the last token already retained in memory; close freezes new authorization and refresh before transport session deletion.

Kana stores credentials under `mcp:<server-id>`, supplies browser opening and owner-only token persistence, and routes OAuth metadata/token calls through the same configured proxy policy as MCP transport.

## Remote tool adaptation

At discovery, `McpToolAdapter` precompiles the remote JSON Schema and creates an ordinary Kana `Tool`. The provider-visible alias is a deterministic sanitized combination of server ID and remote name, bounded to 64 characters. The original remote name and server identity remain available for invocation, diagnostics, approval presentation, and result metadata.

The adapter passes invocation abort and request timeout to `tools/call` and maps increasing MCP progress into bounded `ToolContext.update()` values. JSON-RPC response errors become structured tool errors rather than escaping the Agent loop.

Result normalization independently bounds item count, natural text, structured JSON, model-facing content, and metadata. Text and embedded text resources may reach model content; resource links become descriptions. Image, audio, and blob payloads retain only safe type, MIME, and estimated byte metadata—remote binary data is not copied into sessions as a visual observation. MCP `isError` and JSON-RPC error semantics remain distinct in the structured result.

The common Agent tool-result policy may apply a tighter model-context limit or create a text artifact afterward; see [Tools and execution](tools.md).

## Multi-server manager

`McpManager` snapshots registrations, starts servers concurrently, and aggregates successful tools in registration order. `includeTools` and `excludeTools` match original remote names. Each server is adapted atomically: duplicate remote names or one invalid selected schema fail that server instead of exposing a partial, order-dependent set.

Optional-server failures are isolated, recorded, and closed. Any required-server failure closes all clients and aborts startup. Alias collisions between servers or with reserved Kana tools fail the complete aggregation rather than overwriting a tool or assigning an unstable suffix.

Diagnostics expose copied server identity, required flag, lifecycle status, discovered and retained tool counts, capabilities, and safe error identity. Progress reports completed/total server counts and each terminal startup or close outcome. Listener failures are contained. Close is idempotent and releases clients in reverse registration order.

## Kana configuration and activation

`<KANA_HOME>/mcp.json` contains validated server definitions; `<KANA_HOME>/mcp-enabled.json` contains only selected IDs. Missing files produce empty definitions or activation. A configured server starts only when its ID appears in both sets. Exact fields and examples belong to [Configuration and installation](configuration.md).

An omitted server `type` means stdio; HTTP must be explicit. The product factory builds the selected transport, stable client, optional OAuth authorizer, filters, request timeouts, logger callbacks, and reserved tool-name set. Config and mutable collections are snapshotted before asynchronous startup.

HTTP `proxy` is a Kana/Bun composition concern. A URL is passed through Bun's fetch extension. `false` temporarily adds only the target hostname to `NO_PROXY` and `no_proxy` during the synchronous fetch call, then restores both variables before yielding. Omission keeps default process routing. The same fetch wrapper is injected into MCP and OAuth.

## Runtime and frontend integration

`KanaMcpRuntime` owns a replaceable one-shot manager. It serializes `start`, `reload`, and `close`; reload closes the old manager before rereading configuration and activation, then publishes a fresh detached tool/diagnostic snapshot. Failure clears stale tools and source mappings, while a later reload can recover. Once close is requested, queued lifecycle work cannot create another manager.

The main conversation initially has no external tools. Interactive startup waits until the selected session is visible before loading MCP and rebuilding the Agent; the resume picker therefore has no server side effects. Headless starts MCP before submitting its run. Clean mode never reads MCP configuration or creates the runtime's external tools. Memory-consolidation Agents never receive MCP tools.

The TUI owns selection drafts, OAuth actions, lifecycle transcript blocks, focus, and retry interaction, not protocol or transport state. Headless cannot open a browser and requires interactive OAuth to have been completed earlier. Shared conversation shutdown settles the Agent before the product host closes MCP; see [Conversation runtime](conversation-runtime.md).

## Security and extension constraints

- Treat MCP tools as untrusted external capabilities. They require ordinary approval and default to exclusive execution.
- Do not log headers, tokens, endpoint URLs, session/event/progress IDs, request parameters, tool arguments, or complete results.
- Keep transport framing independent from version negotiation and feature methods.
- Add a new stable protocol version as a separate client lifecycle rather than runtime version guessing.
- Do not replay a timed-out, cancelled, session-expired, or authorization-challenged tool call automatically.
- Keep configuration parsing and proxy behavior in Kana composition, not generic MCP packages.
- Preserve the one-shot manager contract; implement live replacement through `KanaMcpRuntime`.
