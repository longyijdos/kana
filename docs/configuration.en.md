# Configuration and installation

This document describes Kana's implemented commands, configuration files, and local directory layout. Configuration is parsed as Bun TOML; file keys use `snake_case` while the code uses `camelCase`.

## Install and start

```bash
# Create default local configuration
kana install

# Also install or update the default global Skills repository
kana install --skills

# Overwrite installed config/state files; reclone Skills when requested
kana install --force --skills

# Copy installed Kana Skills to Codex's global Skills directory
kana skills sync codex

# Copy to a custom agent Skills directory; existing matching Skills are skipped by default
kana skills sync --target-dir ~/.other-agent/skills

# Replace matching Skills that already exist in the target directory
kana skills sync codex --force

# Start the TUI; arguments become the first prompt
kana fix the failing tests

# Restore by ID, or open the picker when the ID is omitted
kana resume [session-id]
```

`kana install` does not overwrite existing files. `--force` restores `config.toml`, `mcp.json`, `mcp-enabled.json`, `approvals.json`, and `skills/skills.toml` to their defaults; when combined with `--skills`, it also deletes and reclones the default Skills directory. It does **not** create `~/.kana/AGENTS.md`; users create global instructions themselves.

The default Skills repository is `https://github.com/longyijdos/kana-skills.git`, installed at `<KANA_HOME>/skills/kana-skills`. If the existing directory is not a Git repository, a regular update fails and `--force` is required to replace it. An existing Git repository is updated with `git pull --ff-only`.

`kana skills sync` does not clone the repository again. It reads `<KANA_HOME>/skills/kana-skills` and copies every top-level Skill directory containing `SKILL.md` into the target agent's Skills root. The `codex` preset writes to `${CODEX_HOME:-$HOME/.codex}/skills`. When the target already contains a matching directory, the command skips it by default; `--force` deletes that directory first, then copies the Skill again. If the default Skills repository is not installed yet, run `kana install --skills` first.

## Root directory and file layout

Kana uses `KANA_HOME` as its root. When unset, it uses `$HOME/.kana`; when `HOME` is unavailable, it falls back to the OS-reported home directory.

```text
${KANA_HOME:-$HOME/.kana}/
├── .env                    # Optional environment variables loaded at startup
├── config.toml             # Runtime configuration covered here
├── mcp.json                # MCP server definitions
├── mcp-enabled.json        # Enabled MCP server IDs
├── oauth-tokens.json       # OAuth credentials created after browser authorization
├── approvals.json          # bash trust rules
├── AGENTS.md               # Optional global system instructions; not created by install
├── sessions/               # Workspace-grouped JSONL sessions
├── logs/                   # Workspace- and session-grouped runtime JSONL logs
├── memory/                 # Global and project memory
└── skills/
    ├── skills.toml         # Enabled global Skills
    └── kana-skills/        # Default repository cloned by `kana install --skills`
```

Files written by installation and the application are created or written with mode `0600`. This is the requested file mode; its effective result remains subject to the operating system, filesystem, and umask.

Kana reads `<KANA_HOME>/.env` before parsing CLI commands. Its values override matching variables inherited by the startup process and become part of Kana's current process environment. The built-in `bash` tool and the TUI's `!` local Shell inherit these values, so commands they run can access secrets stored in this file. MCP stdio children continue to use a separate restricted environment; pass values explicitly through the server's `env` or reference `${VAR_NAME}` placeholders there.

## `config.toml`

When the configuration file is absent, Kana uses built-in defaults. When it exists, every supplied field overrides its default and omitted fields retain their defaults; for example, supplying only `[model] name` does not remove the other default model settings.

The equivalent configuration written by `kana install` is:

```toml
[model]
provider = "deepseek"
name = "deepseek-v4-pro"
api_key_env = "DEEPSEEK_API_KEY"
thinking = true
reasoning_effort = "high"
max_tokens = 8192
timeout_ms = 60000
max_retries = 1

[agent]
max_turns = -1
# context_limit = 200000

[approval]
mode = "unless_trusted"

[notification]
backend = "auto"
on_agent_completed = true
on_approval_required = true

[memory]
enabled = true
max_chars = 6000
# daily_retention_days = 30

[logging]
level = "info"
```

### `[model]`

| Key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | Only `deepseek` | `deepseek` | The sole provider supported by the current product configuration. |
| `name` | Non-empty string | `deepseek-v4-pro` | Model name; runtime rejects names outside DeepSeek's metadata table. |
| `api_key_env` | Non-empty string | `DEEPSEEK_API_KEY` | Name of the environment variable holding the API key; the key is not written to TOML. |
| `thinking` | Boolean | `true` | Explicitly enables DeepSeek thinking in requests. |
| `reasoning_effort` | `high` or `max` | `high` | DeepSeek reasoning effort; it is not sent when `thinking = false`. |
| `max_tokens` | Positive integer | `8192` | Per-request output-token limit; it cannot exceed the selected model's hard limit and is reserved from the context prompt budget. |
| `timeout_ms` | Finite number | `60000` | Inactivity timeout in milliseconds while waiting for DeepSeek response headers or consecutive response data. |
| `max_retries` | Finite number | `1` | Maximum retries after retryable request failures. |

Before startup, set the environment variable named by `api_key_env`. The default configuration uses:

```bash
export DEEPSEEK_API_KEY='sk-...'
```

### Other tables

| Table and key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `agent.max_turns` | `-1` or a positive integer | `-1` | Maximum model/tool turns in one user run; a run that still needs to continue ends with `turn_limit`. |
| `agent.context_limit` | Optional positive integer | model metadata context window | Context limit the Agent actually uses; it cannot exceed the selected model's hard limit, and omission uses metadata. |
| `approval.mode` | `always`, `unless_trusted`, `never` | `unless_trusted` | Whether tool calls enter the TUI approval flow. |
| `notification.backend` | `auto`, `off`, `bell`, `osc9`, `osc777`, `kitty` | `auto` | Terminal-notification output protocol. `auto` detects Kitty, then iTerm, then VTE, otherwise falls back to bell. |
| `notification.on_agent_completed` | Boolean | `true` | Notify when an Agent run completes normally. Aborted, failed, length-truncated, and `turn_limit` runs are not completion. |
| `notification.on_approval_required` | Boolean | `true` | Notify when a tool-approval prompt is shown. |
| `memory.enabled` | Boolean | `true` | Register `remember` and inject memory into the system prompt. |
| `memory.max_chars` | Positive integer | `6000` | Unicode-character limit for consolidated durable memory. |
| `memory.daily_retention_days` | Optional positive integer | Unset | Number of daily staging records retained after successful full memory compaction. |
| `logging.level` | `debug`, `info`, `warn`, `error`, `off` | `info` | Minimum level written to runtime JSONL logs; `off` disables file logging entirely. |

When `daily_retention_days` is commented out or omitted, daily memory is not pruned. Logs always write under `<KANA_HOME>/logs`; the directory is not configurable and log output never goes through the terminal, so it cannot disrupt TUI repainting. `max_turns` accepts only `-1` or a positive integer; `max_tokens` and optional `context_limit` require positive integers, `timeout_ms` and `max_retries` are validated as finite numbers, and the two `memory` quantity fields require positive integers.

### Context budget

Kana uses `agent.context_limit` to calculate its automatic context-compaction budget; when omitted, it falls back to the selected model metadata's context window. The configured value cannot exceed metadata and must be greater than `model.max_tokens`. The effective prompt budget is:

```text
safetyReserve = clamp(floor(contextLimit × 5%), 256, 8192)
promptBudget = contextLimit - model.max_tokens - safetyReserve
```

At least 512 prompt tokens must remain. Compaction starts when estimated input reaches 80% of this budget. Its cutoff lands only after a complete assistant turn or complete tool-call/result group and aims to bring “system prompt + tool definitions + maximum summary placeholder + retained recent messages” down to 55% of `promptBudget`. `model.max_tokens` still controls output only; subtracting it reserves context space for that output.

Default `info` retains only session, TUI, Agent-run, and memory-task summaries; per-turn activity, provider requests, and successful tool execution belong to `debug`. Retries and failed tools use `warn`, while runtime and persistence failures use `error`. Error records contain an `Error` name, message, and stack; DeepSeek HTTP failures additionally retain status code and status text, never the response body.

The configuration root and each present section must be a TOML table. Strings cannot be empty, booleans cannot be represented as strings, and unsupported providers, reasoning efforts, approval modes, notification backends, or log levels prevent startup. Kana does not silently ignore invalid known fields; fix the configuration and restart.

## `mcp.json` and `mcp-enabled.json`

MCP servers are not stored in `config.toml`. Claude Code-style definitions live in `<KANA_HOME>/mcp.json`, while `<KANA_HOME>/mcp-enabled.json` is the sole source of activation state. A missing definitions file or omitted `mcpServers` means that no servers are configured; a missing activation file or omitted `enabledServers` means that none are enabled. Only configured IDs listed in `enabledServers` are started, and stale unknown IDs are ignored. After the current session is visible, the TUI connects the selected servers, uses stable `2025-11-25` clients to discover their tools, and injects the remote tools into a rebuilt main Agent. `kana resume` without an ID shows the session picker first and begins connecting only after selection. Memory-consolidation Agents never receive MCP tools. Each discovered tool list remains fixed until an explicit `/mcp` reload or process exit; runtime `notifications/tools/list_changed` events are not processed.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx"
      }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "proxy": "http://127.0.0.1:7890",
      "auth": {
        "type": "oauth2",
        "clientId": "kana-client-id",
        "clientSecretEnv": "REMOTE_MCP_CLIENT_SECRET",
        "tokenEndpointAuthMethod": "client_secret_post",
        "scopes": ["read", "write"]
      }
    }
  }
}
```

Activation is stored separately so `/mcp` can manage it without rewriting server commands, arguments, formatting, or plaintext environment values:

```json
{
  "enabledServers": ["filesystem", "github", "remote"]
}
```

Server IDs must be non-empty and unique. Unknown fields, invalid values, and duplicate IDs fail activation-state loading. `/mcp` lists every configured server with its transport. Selecting a stdio server shows its full command line (`command` followed by `args`), while selecting an HTTP server shows its URL and OAuth status; environment values, HTTP headers, proxy URLs, and tokens are deliberately omitted. `Enter` toggles an in-memory draft. An OAuth HTTP server also accepts `A` to open authorization actions for initial authorization, reauthorization, or sign-out. `Esc` applies and closes the draft. Kana performs one reload when the selection changed or an enabled server's authorization changed. Signing out also unchecks that server. A persistence failure leaves the manager open so it can be retried.

Omitting `type` defaults to `stdio`; Streamable HTTP must explicitly use `"type": "http"`. The configuration fields are:

| Key | Default | Meaning |
| --- | --- | --- |
| `type` | `stdio` | `stdio` or `http`. Legacy `sse` is not accepted. |
| `command` | Required for stdio | Absolute executable path or a name resolved through `PATH`. It is launched directly as an argument array, never through a shell. |
| `args` | stdio: `[]` | Arguments passed to the stdio executable. |
| `cwd` | stdio: Kana's current working directory | Child-process working directory; relative paths resolve from the directory where Kana runs. |
| `env` | stdio: `{}` | String key/value pairs explicitly added to the child environment. `${VAR_NAME}` expands from the current process and fails that server when missing; `${VAR_NAME:-default}` uses its default when the variable is missing or empty. Configured values override matching baseline variables. |
| `url` | Required for HTTP | Single Streamable HTTP endpoint; it must be an absolute `http`/`https` URL without credentials or a fragment. |
| `proxy` | HTTP: Unset | An absolute `http`/`https` URL routes only this server through that proxy; `false` ignores process-wide proxies and forces direct connections. URLs cannot contain credentials or fragments. |
| `headers` | HTTP: `{}` | String headers sent with every HTTP request; transport-owned content, session, protocol, and SSE headers cannot be overridden. |
| `auth` | Unset | HTTP OAuth 2.0 configuration. When set, `url` must use HTTPS and `headers` cannot also set `Authorization`. |
| `required` | `false` | Whether a startup failure prevents the whole MCP manager from becoming ready. |
| `startupTimeoutMs` | `10000` | Timeout for completing the MCP initialization handshake. |
| `requestTimeoutMs` | `60000` | Default timeout for ordinary MCP requests. |
| `includeTools` | Unset | Allowlist matched against original remote tool names. An empty array exposes no tools. |
| `excludeTools` | Unset | Denylist matched against original remote names; exclusion wins when a name appears in both lists. |

The stdio child inherits only defined values among `HOME`, `PATH`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, and `LC_CTYPE`, then merges the expanded `env`. Placeholders read only from Kana's process environment, including values already loaded from `<KANA_HOME>/.env`, without making other unconfigured variables inheritable by the child. `${VAR:-default}` follows shell `:-` semantics and uses the default when the variable is unset or empty; defaults are not expanded recursively. An unresolved placeholder without a default fails that server with an error containing the server ID, env key, and variable name. An optional server does not block other MCP servers or the editor; the error appears in the transcript and diagnostic log without recording the secret value. Environment names must use conventional syntax and configured values must be strings. Unknown fields, non-positive timeouts, and duplicate or empty tool names fail configuration loading.

When an HTTP server sets `proxy` to a URL, its MCP initialization, tool requests, SSE recovery, session DELETE, OAuth metadata discovery, token exchange, and refresh all use that proxy. Setting it to `false` makes the same request set bypass process-wide proxies and connect directly. The direct wrapper adds the current target host to process-local `NO_PROXY`/`no_proxy` only for the synchronous Bun `fetch` invocation, then restores both variables exactly. It does not permanently modify Kana's environment or change later requests from other MCP servers, which retain their own explicit proxy or the original global proxy. When `proxy` is omitted, Kana uses Bun's default `fetch` routing and therefore continues to honor `HTTP_PROXY`/`HTTPS_PROXY` inherited from the current shell or loaded from `<KANA_HOME>/.env`. OAuth pages opened in the system browser do not pass through Kana's `fetch` and continue to use the browser's own network settings. Diagnostic logs record only whether a server uses an explicit proxy or bypasses proxies, never the proxy URL.

`auth` currently accepts only `type: "oauth2"`, with these nested fields:

| Key | Default | Meaning |
| --- | --- | --- |
| `clientId` | Required | Registered OAuth client ID. It is not a secret and may be stored directly in `mcp.json`. |
| `clientSecretEnv` | Unset | Environment variable from which Kana reads the client secret, for example via `<KANA_HOME>/.env`; the secret is not stored in `mcp.json`. |
| `redirectUri` | Dynamic loopback | Optional fixed `http://localhost:<port>/path`, `127.0.0.1`, or `::1` callback. When omitted, Kana selects a free port on `127.0.0.1` and uses `/oauth/callback`. |
| `scopes` | Unset | Explicit least-privilege boundary. Kana never requests a scope outside this list. When unset, challenge scopes take precedence, followed by protected-resource metadata. |
| `tokenEndpointAuthMethod` | Automatic | `none`, `client_secret_basic`, or `client_secret_post`; it must agree with server metadata and the presence of a secret. |
| `authorizationParameters` | `{}` | Provider parameters appended to the browser request, such as `access_type` or `prompt`; OAuth, PKCE, and resource parameters cannot be overridden. |
| `callbackTimeoutMs` | `300000` | Positive timeout for the loopback callback. |

Before MCP startup, OAuth discovers MCP protected-resource metadata and OAuth/OIDC authorization-server metadata, then uses Authorization Code with PKCE S256. After browser authorization, access tokens, refresh tokens, expiry, scopes, and binding metadata are stored in `<KANA_HOME>/oauth-tokens.json` with mode `0600`. A usable refresh token renews an expiring access token automatically. If the authorization server rejects refresh with `invalid_grant`, Kana deletes the credentials and opens the browser the next time authorization is required. When a tool call receives a scoped `401/403` challenge, Kana performs step-up authorization and retries that HTTP request once if the configured permission boundary includes the required scope. A scope outside the configured boundary produces an actionable error instead of expanding access.

The HTTP transport implements only `2025-11-25` Streamable HTTP. POST responses support both JSON and SSE, followed by an optional GET server stream, session headers, `Last-Event-ID` resumption, and DELETE shutdown. It does not fall back to the standalone `2024-11-05` HTTP+SSE transport. Endpoint URLs, proxy URLs, header names and values, and transport-reserved headers are validated before startup. An OAuth challenge fails only the current request and does not close an otherwise valid MCP transport; fatal network or protocol errors still close the connection. Session DELETE during shutdown is bounded and best-effort. Its failure is logged, but background cleanup cannot leak an unhandled Promise stack into the TUI.

When an optional server fails to start, Kana records diagnostics, closes that server, and continues, leaving a persistent warning after the final summary. A failed required server during initial loading leaves the current session in an error state without enabling the editor. During an explicit reload, however, any configuration or required-server failure clears the closed manager's tools, rebuilds the Agent without them, reports the error in the transcript, and restores the editor so `/mcp` can be opened again. Connecting and reloading append progress blocks after the transcript, followed by startup/reload summaries with ready-server and available-tool counts; selecting no servers produces an `MCP disabled` reload summary. Remote tools retain the unknown-tool approval policy, so every call requires confirmation in `unless_trusted` mode; the approval prompt shows the server ID, original remote tool name, and complete formatted arguments, with allow-once and deny choices only. On quit, idle or loading `Ctrl+C`, or `SIGHUP`, `SIGINT`, and `SIGTERM`, Kana begins graceful shutdown and shows per-server close progress at the end of the transcript without replacing bottom. It restores the terminal and prints exit information only after every MCP server closes. Pressing `Ctrl+C` again while graceful shutdown is pending forces immediate termination.

Stdio server configuration is a local-code-execution trust boundary: Kana must start `command` before any MCP tool approval can occur, so configure only trusted programs. HTTP endpoints and OAuth authorization servers likewise form remote data, tool, and credential trust boundaries. `env` and `headers` use literal JSON values, so a static token remains plaintext inside `mcp.json`; prefer OAuth `clientSecretEnv` and least-privilege scopes, and do not commit or share config or token files. Kana's OAuth token store is also a local plaintext credential file protected only by filesystem permissions. `kana install` creates both MCP files with mode `0600`, but `kana install --force` resets definitions and activation state to empty defaults; it does not delete the OAuth token store. Protocol versions are maintained in code and are not exposed as arbitrary configuration strings.

## API key and project instructions

`api_key_env` only tells Kana where to read the key; it does not persist the key in `config.toml`. Before parsing its startup command, Kana reads `<KANA_HOME>/.env` when that file exists. Values from this file override matching variables inherited from the launching shell as well as matching values Bun automatically loaded from the current workspace's `.env`. The default key can therefore be stored as:

```dotenv
DEEPSEEK_API_KEY=sk-...
```

The `.env` path is resolved from `KANA_HOME` before the file is loaded; when `KANA_HOME` is unset, the path is `$HOME/.kana/.env`.

The global `AGENTS.md` is `<KANA_HOME>/AGENTS.md`. Built-in default assistant instructions are always injected; when the global file exists, it is appended after the defaults. A project-root `AGENTS.md` is also read and appended after global content, so it occupies the more specific, later position. See the prompt-composition section of the [architecture overview](architecture.en.md).

## Approval file: `approvals.json`

The default file is:

```json
{
  "version": 2,
  "bash": {
    "exactCommands": [],
    "readOnlyCommands": ["ls", "grep", "rg", "cat", "head", "tail", "wc", "pwd", "stat", "file"]
  }
}
```

`exactCommands` holds complete bash commands after trimming surrounding whitespace. Choosing “Always allow this command” in the TUI appends that command. `readOnlyCommands` can contain only executable names without whitespace or `/`; a command is automatically trusted only when its first word is one of these names and it is a single simple command. Bash commands with `;`, `|`, redirection, command substitution, backticks, backslashes, or newlines are never treated as read-only.

Approval modes behave as follows:

| Mode | Behavior |
| --- | --- |
| `always` | Requests approval for every tool call except `remember` and `schedule_wake`. |
| `unless_trusted` | Skips approval for `read`, `list`, `glob`, `grep`, exact trusted bash commands, and trusted simple read-only bash commands; asks for everything else. |
| `never` | Skips approval for all calls, including writes and shell commands. |

## Global Skills configuration: `skills/skills.toml`

```toml
[model_invocation]
enabled = []
```

This list names the **global** Skills that may be injected into the model system prompt. Skills in project `.kana/skills` and `.agents/skills` are always enabled and cannot be disabled through this file. The TUI's `/skills` command changes only this global activation list: `Enter` edits a draft, while `Esc` writes and refreshes once only when the final selection changed.

## Recommended minimal configuration

This example changes only the model name and notification behavior; every other field retains its default:

```toml
[model]
name = "deepseek-v4-flash"

[notification]
backend = "bell"
on_agent_completed = false
```

Avoid copying the complete default file for a small change. Field-level merging keeps configuration shorter and automatically picks up future default fields.
