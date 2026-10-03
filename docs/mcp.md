# Model Context Protocol

Kana creates three capability-dependent built-in tools for enabled MCP servers: `mcp_list_tools` lists names and descriptions, `mcp_get_tool` reads a single tool's input schema, and `mcp_call` invokes a remote tool. The official TypeScript client SDK owns the wire protocol and transports. Neither the Agent loop nor a provider adapter understands MCP.

## Layering

```text
createKanaAgent → mcp_list_tools + mcp_get_tool + mcp_call
                      ↓
KanaMcpRuntime (reloadable registry capability)
  → McpManager (startup, filtering, catalog, diagnostics)
      ├→ RegisteredMcpTool (compiled input schema, optional output schema, remote execution)
      └→ McpClient → official SDK Client
          ├→ SDK StdioClientTransport | StreamableHTTPClientTransport
          └→ optional McpOAuthHttpAuthorizer → SDK OAuthClientProvider + auth
```

`McpClient` is a thin adapter over `@modelcontextprotocol/client`. The SDK handles JSON-RPC parsing and request correlation, version negotiation, initialization, tool-list pagination, request timeouts, cancellation, progress, and transport framing. Kana maps protocol errors into its ordinary tool pipeline and distinguishes caller cancellation from timeouts.

The client lets the SDK negotiate modern and legacy protocol versions. SDK-owned versions are not exposed as arbitrary configuration strings. Kana supports Streamable HTTP and stdio, not a separately configured legacy HTTP+SSE transport.

## Progressive tool catalogs

Startup connects enabled servers and caches their filtered tool definitions internally, including input schemas and any optional output schemas. The model initially sees server names and summaries in the `mcp_list_tools` description, together with the three gateway schemas. An optional server `description` overrides the description supplied by the server; without either, the catalog still includes the server name.

```text
mcp_list_tools({ name: "github" })
  → { server: "github", tools: [{ name, description }, ...] }

mcp_get_tool({ server: "github", tool: "get_issue" })
  → content: { server, name, inputSchema }
  → result:  { server, name, inputSchema, outputSchema? }

mcp_call({
  server: "github",
  tool: "get_issue",
  arguments: { owner: "longyijdos", repo: "kana", issue_number: 138 }
})
  → { content: formatted text, result: structuredContent or formatted text, isError }
```

`mcp_list_tools` and `mcp_get_tool` read the cached catalog. They do not connect additional servers, change the user's activation state, grant permissions, or modify the provider-facing tool array. The list contains only names and descriptions. A schema lookup returns the server, tool name, and full input schema in content and result. Its result additionally includes the remote output schema when provided; content omits that field, keeping ordinary model input focused on invocation parameters. MCP output schema describes `structuredContent`; it does not describe the remote content array or the formatted-text fallback. This keeps the tool definitions stable while metadata is loaded; provider caching still depends on the rest of the request.

Lists are paginated with optional `offset` and `limit` (default 20, maximum 50). A result with `nextOffset` has another page. Normal Agent content limits and artifact policies apply to both queries; if description content is saved to an artifact, the model must read it for the complete input schema. Queries are repeatable, including after context compaction. There is no transient activation flag that prevents rediscovery or invocation when earlier history is compacted.

Agent composition reads the current MCP registry and creates the gateways only when its server catalog is non-empty. Each gateway must be selected in `agent.tools` to expose its capability; selecting none disables Agent access without changing server activation or `/mcp` management. MCP runtime does not inject remote tools or gateway instances into the Agent.

Only ready servers and tools retained by `includeTools`/`excludeTools` are available to description lookup and invocation. `mcp_call` resolves the pair `(server, original tool name)` and validates the nested `arguments` against the cached remote JSON Schema before any remote invocation. The provider validates only the gateway envelope, so concrete remote schemas are enforced inside Kana rather than through native per-tool decoding.

Remote names are not added to the Agent registry. Different servers may use the same tool name, or names identical to Kana built-ins or gateway names. No aliases, provider-name sanitization, or cross-server reserved-name aggregation is needed. Duplicate names within one server remain invalid because they make dispatch ambiguous.

## Invocation and results

`mcp_list_tools` and `mcp_get_tool` are parallel catalog reads and never request approval. `mcp_call` defaults to exclusive execution and follows ordinary approval policy. TUI approval shows the server, original tool name, and complete nested arguments. It does not offer persistent MCP trust.

The gateway passes the invocation's abort signal and progress updates through the registered tool to the SDK. Configured request timeouts and the common Agent deadline still apply. JSON-RPC errors become formatted text error results containing their code, message, and any data; remote `isError` remains a separate result property. Caller aborts preserve their cancellation reason.

At discovery, selected input schemas are precompiled with Kana's tool validator. Unsupported input schemas fail that server atomically. Optional output schemas are retained as supplied. Result adaptation processes every content item without independently truncating text, item count, structured data, or metadata. Text and embedded text resources become content; resource links become descriptions. Image, audio, and blob payloads become text notices with type, MIME, and estimated byte size, rather than copying remote binary data into sessions as a visual observation.

The Kana `result` is the complete remote `structuredContent` when present, otherwise the complete formatted text. It does not wrap the remote MCP response. When a response has only structured data, its JSON is also included in content for direct model use. Common Agent handling bounds model-visible content and may create a text artifact, independently of full result persistence; see [Tools and execution](tools.md).

## Transports and authorization

SDK stdio launches a command and argument array without a shell, frames stdout as MCP messages, and owns subprocess cleanup. Kana supplies a restricted baseline environment and expanded explicit `env`; the SDK also includes its platform-specific safe defaults. `${NAME}` and `${NAME:-fallback}` resolve from Kana's process environment. A missing required variable fails that server. Server stderr is kept separate from protocol messages and bounded before diagnostic logging.

The SDK Streamable HTTP transport owns JSON/SSE handling, session and protocol headers, stream resumption, and reconnection. Kana validates endpoint configuration and transport-owned headers and injects its per-server proxy and authorization fetch boundary. For legacy HTTP sessions, close attempts SDK session deletion with a five-second bound before closing local transport resources. Kana does not implement a separate session-expiry reinitialization state machine; session errors reach the Agent, and explicit runtime reload can reconnect servers.

`McpOAuthHttpAuthorizer` uses the official SDK for Bearer challenges, protected-resource and authorization-server discovery, client registration, PKCE, token exchange, and refresh. Its `OAuthClientProvider` adapter supplies local storage and browser hand-off. Kana retains the exact-resource credential boundary, explicit scope policy, and shared loopback callback with `state` validation; the callback's optional `iss` is passed to the SDK for issuer validation. Provider authentication continues to use the generic [OAuth](oauth.md) session separately.

Preparation first tries stored or refreshed credentials and performs interactive authorization before MCP negotiation when needed. If metadata is available only from a challenge, an idempotent HEAD probe obtains it before the protocol startup timeout. A request challenge may recover once; a second challenge is returned to the caller. Explicit configured scopes remain the privilege boundary, and automatic expansion beyond them is rejected. Close freezes new authorization and refresh; DELETE can use only the last token retained in memory.

OAuth is enabled only by an explicit HTTP `auth` field. A configured client ID uses an already registered client; without one, the SDK dynamically registers a public client when the server supports registration. Tokens and registrations are stored under `mcp:<server-id>` in the shared credential file. Registrations retain their issuer, exact resource, and callback URI so subsequent authorization reuses the registered callback. Sign-out deletes both the token and dynamic registration.

Kana supplies browser opening and owner-only credential persistence, and routes OAuth discovery, registration, and token calls through the same proxy policy as MCP requests. Proxy URLs and credentials never enter diagnostic metadata.

## Manager and runtime lifecycle

`McpManager` snapshots registrations, starts servers concurrently, and retains successful catalogs in registration order. Filters match original remote names. Each server catalog is compiled atomically: duplicate remote names or one invalid selected schema fail that server rather than exposing a partial set.

`start()` resolves when startup completes. The registry exposes server summaries through `catalog`, filtered definitions through `listTools(serverId)`, and remote execution entries through `getTool(serverId, toolName)`. Registered entries contain compiled input schemas, remote execution, and structured source metadata; their descriptions preserve the remote text.

Server failures are diagnosed, closed, and isolated without closing successful clients. Startup reaches ready even when no server connects successfully. Diagnostics include copied server identity, lifecycle status, capabilities, discovered/retained tool counts, and error identity. Progress reports completed/total counts and terminal outcomes. Startup accepts an abort signal; cancellation is distinct from server failure. Close is idempotent, waits for startup to unwind, and releases clients in reverse registration order.

The catalog is fixed for each manager generation. `notifications/tools/list_changed` is diagnosed without changing the live gateway catalog. `KanaMcpRuntime` serializes start, reload, and close. Reload closes the old manager, reconnects from the Host's definition and enabled-server snapshots, and publishes the ready registry and diagnostics. A canceled or failed operation makes the registry unavailable and permits later reload; a closed runtime cannot be revived.

## Configuration and frontend integration

`<KANA_HOME>/mcp.json` contains server definitions, and `<KANA_HOME>/mcp-enabled.json` contains enabled IDs. A configured server starts only when its ID appears in both sets. The user-facing `/mcp` operation changes enabled state; model-facing `mcp_list_tools` and `mcp_get_tool` only read the cached catalog. Direct file edits require a restart. Exact configuration fields belong to [Configuration and installation](configuration.md).

The main conversation initially has no MCP gateways. Interactive startup waits until the chosen session is visible before loading MCP and rebuilding the Agent with the three gateways. Headless initializes MCP before submitting its run and requires interactive OAuth to have been completed earlier. Clean mode creates no MCP tools. Memory-consolidation Agents never receive MCP tools.

Subagent role cards grant MCP access by listing `mcp_list_tools`, `mcp_get_tool`, and `mcp_call`. The global `agent.tools` selection remains the ceiling for these permissions. They cover all currently enabled and filtered MCP capabilities; they do not express per-server or per-remote-tool access. Old remote aliases and `mcp:*` are not supported. See [Subagents](subagents.md).

The TUI owns selection, authorization actions, lifecycle presentation, focus, and retry interaction. Shared conversation shutdown settles Agents before the Host closes MCP. See [TUI](tui.md) and [Conversation runtime](conversation-runtime.md).
