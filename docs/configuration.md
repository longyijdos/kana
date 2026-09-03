# Configuration and installation

This document describes Kana's implemented commands, configuration files, and local directory layout. Configuration is parsed as Bun TOML; file keys use `snake_case` while the code uses `camelCase`.

## Install and start

```bash
# Initialize local state; missing config.toml continues to use built-in defaults
kana install

# Only check the latest stable release, or download and replace the current Kana executable
kana update --check
kana update

# Reset runtime configuration; confirmation is interactive unless --yes is explicit
kana reset
kana reset --yes

# Install or safely update the default global Skills repository
kana skills install

# Delete and reclone the default Skills repository; confirmation is interactive
kana skills reinstall
kana skills reinstall --yes

# Copy installed Kana Skills to Codex's global Skills directory
kana skills sync codex

# Copy to a custom agent Skills directory; existing matching Skills are skipped by default
kana skills sync --target-dir ~/.other-agent/skills

# Replace matching target Skills without removing other or stale Skills
kana skills resync codex
kana skills resync codex --yes

# Start the TUI; arguments become the first prompt
kana fix the failing tests

# Use only built-in Agent context and tools
kana --clean

# Restore by ID, or open the picker when the ID is omitted
kana resume [session-id]

# Run one complete Agent turn headlessly; the prompt may also come from stdin
kana exec fix the failing tests
kana exec --clean analyze the project with built-in capabilities
printf 'summarize this repository' | kana exec
kana exec resume <session-id> continue the task

# Manage OpenAI Codex OAuth
kana auth login openai-codex
kana auth status openai-codex
kana auth logout openai-codex
```

`kana exec` uses the same product composition as the TUI and exits after one complete Agent turn. Human mode writes only the final answer to stdout, while `--json` provides a versioned JSONL event stream. See [Headless execution and the JSONL protocol](headless.md) for non-interactive approval, exit codes, and the complete protocol.

`--clean` applies only to a new TUI or `exec` session; combining it with `resume` or `exec resume` fails at the corresponding frontend startup boundary. It creates a temporary session that exists only in the current process: no session journal, session logger, or accounting record is created, and the session never appears in the resume list. Clean mode does not read global or project `AGENTS.md`, global/project memory, global or project Skills, or MCP definitions and activation state; it does not register `remember`, start memory consolidation, or connect to MCP servers. Kana still loads `<KANA_HOME>/.env` and `config.toml`, retaining the current provider/model, Agent runtime settings, OAuth credentials, approval rules, and notifications. Core file/Shell tools, `todo_write`, and the TUI's in-process `schedule_wake` remain available. `/todo` shows the temporary session's current todo state; `/skills`, `/mcp`, `/memory`, `/fork`, `/resume`, `/delete`, and the Session scope of `/usage` are unavailable in the TUI. `/model` validates and switches the current Agent without writing `config.toml`. Clean mode is not a file/process sandbox: built-in tools, providers, approval flows, and authentication flows can still produce their normal external side effects.

`kana install` is idempotent initialization. It does not create `config.toml` merely to materialize built-in defaults, so Kana uses those defaults directly while the file is absent. It creates `mcp.json`, `mcp-enabled.json`, `approvals.json`, and `skills/skills.toml` only when missing and never overwrites their existing content. `config.example.toml` and `providers/custom.example.toml` are Kana-managed generated references: install compares them with the current schema and creates or refreshes them only when missing or stale. Runtime never reads either example, so copy only fields being overridden into `config.toml` and copy the Custom example to `providers/custom.toml` before editing it. Install neither installs the Skills repository nor creates `~/.kana/AGENTS.md`.

`kana update --check` reads version metadata for GitHub's latest stable Release without downloading or modifying the binary. `kana update` selects the asset for the current operating system and architecture, verifies its reported size and SHA-256 digest, and runs both `--version` and the idempotent `kana install` through the candidate binary. Only after the candidate version, support-file initialization, and current executable identity all pass validation does a same-directory temporary file atomically replace the executable. Failure removes the temporary file and preserves the original binary; Kana also refuses to overwrite a target replaced by another installer while the download was in flight. Updating supports macOS/Linux on arm64 and x64, inherits Bun `fetch` handling of `HTTP_PROXY`/`HTTPS_PROXY`, and requires a writable installation directory. Source run directly through Bun has no direct-distribution build marker and therefore refuses self-update; standalone binaries built by `scripts/install.sh`, `bun run build:cli`, and the Release workflow include that marker.

`kana reset` restores the main runtime configuration to its defaults. It deletes `config.toml`, refreshes `config.example.toml`, and resets MCP definitions, MCP activation, approval rules, and global Skill activation to empty defaults. It preserves `providers/custom.toml`, `providers/custom.example.toml`, `oauth-tokens.json`, sessions, memory, accounting, logs, `AGENTS.md`, the default Skills repository, and all other installed Skills. The command shows a `[y/N]` confirmation by default. A non-interactive environment refuses to proceed unless `--yes` is explicit, and the confirmation lists every reset item and the primary preserved data.

The default Skills repository is `https://github.com/longyijdos/kana-skills.git`, installed at `<KANA_HOME>/skills/kana-skills`. `kana skills install` clones it when absent and runs `git pull --ff-only` for an existing Git checkout. An existing non-Git directory fails with a prompt to use `kana skills reinstall`. After confirmation, reinstall deletes only the complete default repository directory and clones it again, preserving the sibling `skills.toml` and all other installed Skills. Non-interactive use requires `--yes`.

`kana skills sync` does not clone the repository again. It reads `<KANA_HOME>/skills/kana-skills` and copies every top-level Skill directory containing `SKILL.md` into the target agent's Skills root. The `codex` preset writes to `${CODEX_HOME:-$HOME/.codex}/skills`. Ordinary sync skips matching target directories. After confirmation, `kana skills resync` deletes and recopies matching Skills currently present in the source repository, but does not remove other target Skills or stale Skills no longer present in the source. Non-interactive resync requires `--yes`. If the default Skills repository is absent, run `kana skills install` first.

## Root directory and file layout

Kana uses `KANA_HOME` as its root. When unset, it uses `$HOME/.kana`; when `HOME` is unavailable, it falls back to the OS-reported home directory.

```text
${KANA_HOME:-$HOME/.kana}/
├── .env                    # Optional environment variables loaded at startup
├── config.toml             # Optional runtime configuration; absence uses built-in defaults
├── config.example.toml     # Complete install-generated reference; never read at runtime
├── providers/
│   ├── custom.toml         # Optional Custom OpenAI-compatible provider definition
│   └── custom.example.toml # Install-generated Custom reference; never read at runtime
├── mcp.json                # MCP server definitions
├── mcp-enabled.json        # Enabled MCP server IDs
├── oauth-tokens.json       # OAuth credentials created after browser authorization
├── approvals.json          # bash trust rules
├── AGENTS.md               # Optional global system instructions; not created by install
├── sessions/               # Workspace-grouped JSONL sessions
├── artifacts/              # Workspace- and session-scoped oversized tool output
├── logs/                   # Workspace- and session-grouped runtime JSONL logs
├── memory/                 # Global and project memory
└── skills/
    ├── skills.toml         # Enabled global Skills
    └── kana-skills/        # Default repository cloned by `kana skills install`
```

Files written by installation and the application are created or written with mode `0600`. This is the requested file mode; its effective result remains subject to the operating system, filesystem, and umask.

Kana reads `<KANA_HOME>/.env` before parsing CLI commands. Its values override matching variables inherited by the startup process and become part of Kana's current process environment. The built-in `bash` tool and the TUI's `!` local Shell inherit these values, so commands they run can access secrets stored in this file. MCP stdio children continue to use a separate restricted environment; pass values explicitly through the server's `env` or reference `${VAR_NAME}` placeholders there.

## `config.toml`

When the configuration file is absent, Kana uses built-in defaults. When it exists, every supplied field overrides its default and omitted fields retain their defaults. Model selection and Agent policy are static per Agent: `[agent.model]` configures the conversation Agent, while `[memory.agent.model]` independently configures memory consolidation. Provider tables contain only transport and authentication settings. This schema is intentionally breaking; legacy `[provider]` and `[model.*]` selection tables are not read.

The TUI's `/model` command updates `config.toml` through the generic configuration store. It reloads the current file from disk, writes only known fields whose effective values changed, and preserves unrelated tables, unknown fields, and standalone comments. The first change away from defaults therefore creates only the required overrides instead of expanding every default. A candidate document must parse back into the complete target configuration before a sibling temporary file atomically replaces the original; validation or write failures leave the original file untouched. `config.example.toml` is reference-only and may be refreshed by a later `kana install`, so user configuration should not be stored there.

The built-in configuration is equivalent to:

```toml
[provider.deepseek]
api_key_env = "DEEPSEEK_API_KEY"
timeout_ms = 60000
max_retries = 1

[provider.openai-codex]
reasoning_summary = "auto"
timeout_ms = 60000
max_retries = 1

[agent]
web_search = true
image_input = true
max_turns = -1
goal_max_rounds = 8
tool_deadline_ms = 660000
parallel_tool_calls = true
max_parallel_tool_calls = 4
tool_result_artifacts = true

[agent.model]
provider = "deepseek"
name = "deepseek-v4-pro"
# reasoning_effort = "high"
# max_output_tokens = 128000
# context_limit = 500000

[agent.background_jobs]
max_concurrent = 4

[agent.repeated_tool_calls]
reminder_thresholds = [3,5,8]
excluded_tools = []

[approval]
mode = "unless_trusted"

[notification]
backend = "auto"
on_agent_completed = true
on_approval_required = true

[tui]
theme = "kana"
hyperlinks = true
render_latex = true
render_mermaid = true
smooth_text_streaming = true
collapse_long_pastes = true

[memory]
enabled = true
max_chars = 6000
# daily_retention_days = 30

[memory.agent]
web_search = false
image_input = false
max_turns = -1
tool_deadline_ms = 660000
parallel_tool_calls = true
max_parallel_tool_calls = 4

[memory.agent.model]
provider = "deepseek"
name = "deepseek-v4-flash"
# reasoning_effort = "low"
# max_output_tokens = 64000
# context_limit = 200000

[logging]
level = "info"
```

Omitted `reasoning_effort`, `max_output_tokens`, and `context_limit` use the selected model's metadata defaults and hard limits. A configured budget above a hard limit is safely clamped at runtime. `/model` changes only `agent.model.provider`, `name`, and `reasoning_effort`; it preserves the main Agent's budget fields and the complete Memory Agent configuration.

### Provider tables

| Key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `provider.deepseek.api_key_env` | Non-empty string | `DEEPSEEK_API_KEY` | Environment-variable name containing the API key; the key is not written to TOML. |
| `provider.deepseek.timeout_ms` | Finite number | `60000` | Inactivity timeout while waiting for DeepSeek response headers or consecutive data. |
| `provider.deepseek.max_retries` | Finite number | `1` | Maximum retries after retryable request failures. |
| `provider.openai-codex.reasoning_summary` | `auto`, `concise`, `detailed` | `auto` | Requests a streamable reasoning summary; raw chain-of-thought is not exposed. |
| `provider.openai-codex.timeout_ms` | Finite number | `60000` | Inactivity timeout while waiting for Codex response headers or consecutive data. |
| `provider.openai-codex.max_retries` | Finite number | `1` | Maximum retries after retryable request failures. |

Before startup, set the environment variable named by `api_key_env`. The default configuration uses:

```bash
export DEEPSEEK_API_KEY='sk-...'
```

Before first use of OpenAI Codex, run `kana auth login openai-codex`. Browser authorization stores the access token, refresh token, ID token, and binding metadata in `<KANA_HOME>/oauth-tokens.json` with mode `0600`. Credentials refresh before expiry; the model request also refreshes and retries once after its first `401`. `status` reports only authorization state, refreshability, and expiry, never token values. See [OpenAI Codex provider adapter](openai-codex-provider.md) for the complete protocol mapping.

### Agent model tables

| Key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `agent.web_search` / `memory.agent.web_search` | Boolean | `true` / `false` | Allows hosted search only when the selected model metadata also supports it. Custom models currently declare no hosted-search capability. |
| `agent.image_input` / `memory.agent.image_input` | Boolean | `true` / `false` | Allows persisted user/tool images and registers `view_image` only when model metadata also supports images. Disabled or unsupported images remain persisted but become omission markers in model input. |
| `agent.model.provider` / `memory.agent.model.provider` | `deepseek`, `openai-codex`, `custom` | `deepseek` | Provider selected independently for each Agent. |
| `agent.model.name` | Provider model name | `deepseek-v4-pro` | Conversation model; built-in names are validated against provider metadata. |
| `memory.agent.model.name` | Provider model name | `deepseek-v4-flash` | Memory-consolidation model, independent of `/model`. |
| `*.model.reasoning_effort` | Value advertised by model metadata | Metadata default | Optional override. DeepSeek supports `none`, `low`, `high`, `max`; Codex supports `low`, `medium`, `high`, `xhigh`, `max`; Custom uses `custom.toml` metadata. |
| `*.model.max_output_tokens` | Optional positive integer | Metadata hard output limit | Agent-level output ceiling, clamped to the selected model's hard limit and lowered per turn when prompt space is tighter. |
| `*.model.context_limit` | Optional positive integer | Metadata context window | Agent-level context cap, clamped to the selected model's context window. |

For Custom, `config.toml` uses the same Agent model shape as built-ins: set `provider = "custom"`, `name`, and optional preferences in either Agent model table. Endpoint, authentication, hard limits, modalities, parallel-tool support, reasoning efforts, and the default reasoning effort remain model metadata in `providers/custom.toml`. See [Custom OpenAI-compatible provider](custom-provider.md).

### Other tables

| Table and key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `agent.max_turns` | `-1` or a positive integer | `-1` | Maximum model/tool turns in one user run; a run that still needs to continue ends with `turn_limit`. |
| `agent.goal_max_rounds` | Positive integer | `8` | Maximum complete Agent runs admitted for one `/goal`, including its initial run. |
| `agent.tool_deadline_ms` | Positive integer | `660000` | Default per-invocation deadline in milliseconds for tools without `execution.deadlineMs`; a tool declaration takes precedence. |
| `agent.parallel_tool_calls` | Boolean | `true` | Whether the model may propose and actually execute safe tool calls concurrently; always disabled when selected-model metadata does not support it. |
| `agent.max_parallel_tool_calls` | Positive integer | `4` | Maximum concurrently executing tool bodies within one adjacent parallel-safe group. |
| `agent.tool_result_artifacts` | Boolean | `true` | Save oversized non-`read` text results as private session artifacts and give the model a bounded retrievable preview. |
| `agent.background_jobs.max_concurrent` | Positive integer | `4` | Maximum active Background Jobs owned by one session instance. Retained terminal Jobs do not count toward the limit. |
| `agent.repeated_tool_calls.reminder_thresholds` | Strictly increasing integer array; every value is at least 2 | `[3,5,8]` | Consecutive exact-call counts at which the Agent adds escalating advisory context. An empty array disables the policy. |
| `agent.repeated_tool_calls.excluded_tools` | Unique, non-empty, trimmed tool-name array | `[]` | Tools ignored transparently by repeated-call tracking; excluded calls neither advance nor reset a streak. |
| `approval.mode` | `always`, `unless_trusted`, `never` | `unless_trusted` | Whether tool calls enter the TUI approval flow. |
| `notification.backend` | `auto`, `off`, `bell`, `osc9`, `osc777`, `kitty` | `auto` | Terminal-notification output protocol. `auto` detects Kitty, iTerm, Ghostty, then VTE, otherwise falls back to bell. |
| `notification.on_agent_completed` | Boolean | `true` | Notify when an Agent run completes normally. Aborted, failed, length-truncated, and `turn_limit` runs are not completion. |
| `notification.on_approval_required` | Boolean | `true` | Notify when a tool-approval prompt is shown. |
| `tui.theme` | String | `kana` | Active TUI theme name. `kana` is the built-in default; any other name resolves to `<KANA_HOME>/themes/<name>.json` and fails startup with the available theme names when missing or invalid. |
| `tui.hyperlinks` | Boolean | `true` | Allow the TUI to render Markdown links with OSC 8 when terminal support is confirmed; disabled, unknown, or unsupported terminals show `label (url)`. |
| `tui.render_latex` | Boolean | `true` | Render supported Markdown math as terminal-friendly Unicode and character-cell layouts; when disabled, preserve the original LaTeX source. |
| `tui.render_mermaid` | Boolean | `true` | Render supported fenced Mermaid blocks as terminal Unicode diagrams while text streams; when disabled, preserve them as code blocks. |
| `tui.smooth_text_streaming` | Boolean | `true` | Smoothly reveal bursty assistant text; when disabled, show each latest provider streaming snapshot directly. |
| `tui.collapse_long_pastes` | Boolean | `true` | Collapse bracketed pastes of 1,000 or more graphemes into an atomic `[Pasted N chars]` editor item; when disabled, render and edit pasted text normally. |
| `memory.enabled` | Boolean | `true` | Register `remember` and inject memory into the system prompt. |
| `memory.max_chars` | Positive integer | `6000` | Unicode-character limit for consolidated durable memory. |
| `memory.daily_retention_days` | Optional positive integer | Unset | Number of daily staging records retained after successful full memory compaction. |
| `logging.level` | `debug`, `info`, `warn`, `error`, `off` | `info` | Minimum level written to runtime JSONL logs; `off` disables file logging entirely. |

`parallel_tool_calls` is effective only when both user policy and model metadata allow it. The repeated-call, tool-result artifact, concurrency, deadline, and Background Job fields configure behavior owned by [Tools and execution](tools.md). Context limits and compaction budgets are interpreted by [Agent runtime](agent-runtime.md).

TUI option fields remain canonical in the table above. Their interaction semantics belong to [TUI interaction](tui.md), while hyperlinks, LaTeX, Mermaid, width, and repaint behavior belong to [Terminal rendering](terminal-rendering.md). Memory retention and runtime-log persistence belong to [Sessions and memory](sessions-and-memory.md).

Logs always write under `<KANA_HOME>/logs`; the directory is not configurable. The selected log level filters records before persistence. Provider lifecycle record shapes are documented in [Providers](providers.md), while each subsystem owns its other stable diagnostic events.

The configuration root and every present section must be a TOML table. Strings cannot be empty, booleans cannot be strings, and unsupported providers, reasoning efforts, approval modes, notification backends, or log levels prevent startup. Agent and Memory Agent capability flags must be Boolean; `max_turns` accepts only `-1` or a positive integer; deadlines, parallel limits, Job limits, model token limits, context limits, and memory quantities require positive integers. Provider retry and timeout values must be finite. Kana never silently ignores an invalid known field.

## `mcp.json` and `mcp-enabled.json`

MCP servers are not stored in `config.toml`. Claude Code-style definitions live in `<KANA_HOME>/mcp.json`, while `<KANA_HOME>/mcp-enabled.json` is the sole source of activation state. A missing definitions file or omitted `mcpServers` means no servers are configured; a missing activation file or omitted `enabledServers` means none are enabled. Only configured IDs listed in `enabledServers` start, and stale unknown IDs are ignored. Runtime and protocol behavior is documented in [MCP](mcp.md).

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

Server IDs must be non-empty and unique. Unknown fields, invalid values, and duplicate IDs fail loading. The `/mcp` interaction and its redaction rules are documented in [TUI](tui.md).

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

The stdio child inherits only defined values among `HOME`, `PATH`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, and `LC_CTYPE`, then merges expanded `env`. Placeholders read from Kana's process environment, including `<KANA_HOME>/.env`; `${VAR:-default}` uses its non-recursive default when the variable is unset or empty. Missing required variables fail that server. Environment names must use conventional syntax, configured values must be strings, and timeouts must be positive.

An HTTP server's `proxy` applies consistently to its MCP and OAuth requests. `false` bypasses process-wide proxies for that server; omission preserves Bun's default routing and inherited `HTTP_PROXY` or `HTTPS_PROXY`. Browser navigation keeps the browser's own network settings. Diagnostics record only whether an explicit proxy or bypass is active, never the proxy URL.

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

MCP authorization stores tokens and binding metadata in `<KANA_HOME>/oauth-tokens.json` with mode `0600`. Discovery, PKCE, refresh, challenge recovery, and scope-boundary behavior are documented in [OAuth](oauth.md) and [MCP](mcp.md).

The HTTP transport version, JSON/SSE session behavior, recovery rules, server-failure isolation, remote-tool mapping, and manager lifecycle are documented in [MCP](mcp.md). User-visible loading, reload, approval, and shutdown behavior belongs to [TUI](tui.md).

Stdio server configuration is a local-code-execution trust boundary: Kana must start `command` before any MCP tool approval can occur, so configure only trusted programs. HTTP endpoints and OAuth authorization servers likewise form remote data, tool, and credential trust boundaries. `env` and `headers` use literal JSON values, so a static token remains plaintext inside `mcp.json`; prefer OAuth `clientSecretEnv` and least-privilege scopes, and do not commit or share config or token files. Kana's OAuth token store is also a local plaintext credential file protected only by filesystem permissions. `kana install` creates missing MCP files with mode `0600`, while confirmed `kana reset` resets definitions and activation state to empty defaults. Neither command deletes the OAuth token store. Protocol versions are maintained in code and are not exposed as arbitrary configuration strings.

## API key and project instructions

`api_key_env` only tells Kana where to read the key; it does not persist the key in `config.toml`. Before parsing its startup command, Kana reads `<KANA_HOME>/.env` when that file exists. Values from this file override matching variables inherited from the launching shell as well as matching values Bun automatically loaded from the current workspace's `.env`. The default key can therefore be stored as:

```dotenv
DEEPSEEK_API_KEY=sk-...
```

The `.env` path is resolved from `KANA_HOME` before the file is loaded; when `KANA_HOME` is unset, the path is `$HOME/.kana/.env`.

The global `AGENTS.md` is `<KANA_HOME>/AGENTS.md`. Built-in default assistant instructions are always injected; when the global file exists, it is appended after the defaults. A project-root `AGENTS.md` is also read and appended after global content, so it occupies the more specific, later position. See the prompt-composition section of the [architecture overview](architecture.md).

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
| `always` | Requests approval for every tool call except `remember`, `schedule_wake`, `todo_write`, and `update_goal`. |
| `unless_trusted` | Skips approval for `read`, `list`, `glob`, `grep`, exact trusted bash commands, and trusted simple read-only bash commands; asks for everything else. |
| `never` | Skips approval for all calls, including writes and shell commands. |

The TUI's `/approval` command can temporarily override the mode for the currently selected session; selecting `Never ask` requires confirmation. The override does not write `config.toml`, the session journal, or `approvals.json`, and new, fork, resume, or process exit restores the configured mode above.

## Global Skills configuration: `skills/skills.toml`

```toml
[model_invocation]
enabled = []
```

This list names the **global** Skills that may be injected into the model system prompt. Skills in project `.kana/skills` and `.agents/skills` are always enabled and cannot be disabled through this file. The TUI's `/skills` command changes only this global activation list: `Enter` edits a draft, while `Esc` writes and refreshes once only when the final selection changed.

## Recommended minimal configuration

This example changes only the model name and notification behavior; every other field retains its default:

```toml
[agent.model]
name = "deepseek-v4-flash"

[notification]
backend = "bell"
on_agent_completed = false
```

Switching to an already authorized Codex Luna requires only:

```toml
[agent.model]
provider = "openai-codex"
name = "gpt-5.6-luna"
```

Avoid copying the complete default file for a small change. Field-level merging keeps configuration shorter and automatically picks up future default fields.
