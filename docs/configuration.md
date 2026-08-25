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

When the configuration file is absent, Kana uses built-in defaults. Provider tables contain only transport and authentication settings. Concrete model tables contain reusable per-model invocation defaults, while `[agent]` and `[memory.agent]` independently select a provider and model and may override invocation settings. Resolution follows `provider transport + concrete model defaults + Agent overrides` and gives the Agent override highest precedence.

This schema is intentionally breaking: legacy `[provider].active`, flat `[model]`, provider-level model names, and `max_tokens` are rejected. Unknown Agent override keys are errors. Known settings that do not apply to the selected model are preserved and ignored without validation, so a provider switch does not destroy inactive values; once applicable, the same value is validated strictly. Runtime components receive only fully resolved strong types.

The TUI's `/model` command changes only the main `[agent]` selection. It patches `provider`, `model`, and an optional `reasoning_effort` while preserving comments, unrelated tables, `[memory.agent]`, and inactive overrides. Kana parses the candidate document and constructs the candidate Agent before a sibling temporary file atomically replaces the original; validation, construction, or write failures leave both the old Agent and file untouched. Clean mode retains the candidate document only in memory. `config.example.toml` is reference-only and may be refreshed by a later `kana install`, so user configuration should not be stored there.

The generated example lists every built-in model. A representative default configuration is:

```toml
[provider.deepseek]
api_key_env = "DEEPSEEK_API_KEY"
timeout_ms = 60000
max_retries = 1

[provider.openai-codex]
timeout_ms = 60000
max_retries = 1

[model.deepseek."deepseek-v4-pro"]
reasoning_effort = "high"
web_search = true
image_input = false
max_output_tokens = 384000
# context_limit = 1000000

[model.deepseek."deepseek-v4-flash"]
reasoning_effort = "high"
web_search = true
image_input = false
max_output_tokens = 384000
# context_limit = 1000000

[model.openai-codex."gpt-5.6-luna"]
reasoning_effort = "medium"
reasoning_summary = "auto"
web_search = true
image_input = true
max_output_tokens = 128000
# context_limit = 372000

# Custom transport, catalog, metadata, and defaults live in providers/custom.toml.

[agent]
provider = "deepseek"
model = "deepseek-v4-pro"
max_turns = -1
tool_deadline_ms = 660000
parallel_tool_calls = true
max_parallel_tool_calls = 4
tool_result_artifacts = true
# reasoning_effort = "max"
# context_limit = 200000

[agent.repeated_tool_calls]
reminder_thresholds = [3,5,8]
excluded_tools = []

[memory]
enabled = true
max_chars = 6000
# daily_retention_days = 30

[memory.agent]
provider = "deepseek"
model = "deepseek-v4-flash"
max_turns = -1
tool_deadline_ms = 660000
parallel_tool_calls = true
max_parallel_tool_calls = 4

[goal]
max_rounds = 8

[background_jobs]
max_concurrent = 4

[approval]
mode = "unless_trusted"

[notification]
backend = "auto"
on_agent_completed = true
on_approval_required = true

[tui]
hyperlinks = true
render_latex = true
render_mermaid = true
smooth_text_streaming = true
collapse_long_pastes = true

[logging]
level = "info"
```

Every built-in concrete model has independent literal defaults even when its table is absent. Those defaults currently mirror the corresponding metadata limits and capabilities, but they are declared separately so a metadata change cannot silently alter default behavior. User configuration can override them within the model's metadata bounds.

### Provider transport tables

| Table and key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `provider.deepseek.api_key_env` | Non-empty string | `DEEPSEEK_API_KEY` | Environment variable containing the API key; the secret is never written to TOML. |
| `provider.deepseek.timeout_ms` | Positive integer | `60000` | DeepSeek inactivity timeout in milliseconds. |
| `provider.deepseek.max_retries` | Non-negative integer | `1` | Maximum retries after retryable DeepSeek failures. |
| `provider.openai-codex.timeout_ms` | Positive integer | `60000` | OpenAI Codex inactivity timeout in milliseconds. |
| `provider.openai-codex.max_retries` | Non-negative integer | `1` | Maximum retries after retryable Codex failures. |

Set the environment variable named by `provider.deepseek.api_key_env` before using DeepSeek. Before first Codex use, run `kana auth login openai-codex`; see [OpenAI Codex provider adapter](openai-codex-provider.md) for credential storage and protocol details.

### Concrete built-in model tables

Use `[model.deepseek."<model>"]` or `[model.openai-codex."<model>"]`. Supported DeepSeek names are `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, and `deepseek-v4-pro`; supported Codex names are `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.

| Key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `reasoning_effort` | Provider model's advertised effort | DeepSeek `high`; Codex `medium` | Reusable reasoning default for this exact model. |
| `reasoning_summary` | `auto`, `concise`, `detailed` | `auto` | Codex-only streamable reasoning-summary request. |
| `web_search` | Boolean | `true` | Enables the hosted web-search tool when the model supports it. |
| `image_input` | Boolean | Vision DeepSeek and Codex: `true`; other DeepSeek: `false` | Enables model image delivery and `view_image` when the model supports images. |
| `max_output_tokens` | Positive integer up to metadata limit | DeepSeek `384000`; Codex `128000` | Configured output ceiling used to calculate each turn's `ModelContext.maxOutputTokens`. DeepSeek sends it as `max_output_tokens`; the Codex wire contract omits it. |
| `context_limit` | Positive integer | DeepSeek `1000000`; Codex `372000` | Reusable context cap, clamped to the model metadata window. |

Custom transport, authentication, catalog metadata, capabilities, and per-model defaults remain exclusively in `providers/custom.toml`; main `config.toml` must not contain `provider.custom` or `model.custom`. See [Custom OpenAI-compatible provider](custom-provider.md).

### Agent selection and overrides

`[agent]` defaults to `deepseek/deepseek-v4-pro`; `[memory.agent]` independently defaults to `deepseek/deepseek-v4-flash`. Both accept the following model-selection and invocation keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `provider` | `deepseek`, `openai-codex`, or `custom` | Provider selected for this Agent. |
| `model` | Model name from the selected provider | Concrete model selected for this Agent. |
| `reasoning_effort` | Selected model's advertised effort | Overrides the concrete model default. |
| `reasoning_summary` | `auto`, `concise`, `detailed` | Codex-only override. |
| `web_search` | Boolean | Hosted-search override when supported. |
| `image_input` | Boolean | Image-input override when supported. |
| `max_output_tokens` | Positive integer | Output override, bounded by model metadata. |
| `context_limit` | Positive integer | Context override, clamped to model metadata. |

Both Agent tables also accept `max_turns`, `tool_deadline_ms`, `parallel_tool_calls`, and `max_parallel_tool_calls`. Only the main `[agent]` accepts `tool_result_artifacts` and `[agent.repeated_tool_calls]`.

### Other tables

| Table and key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `agent.max_turns` | `-1` or a positive integer | `-1` | Maximum model/tool turns in one user run; a run that still needs to continue ends with `turn_limit`. |
| `goal.max_rounds` | Positive integer | `8` | Maximum complete Agent runs admitted for one `/goal`, including its initial run. |
| `agent.tool_deadline_ms` | Positive integer | `660000` | Default per-invocation deadline in milliseconds for tools without `execution.deadlineMs`; a tool declaration takes precedence. |
| `agent.parallel_tool_calls` | Boolean | `true` | Whether the model may propose and actually execute safe tool calls concurrently; always disabled when selected-model metadata does not support it. |
| `agent.max_parallel_tool_calls` | Positive integer | `4` | Maximum concurrently executing tool bodies within one adjacent parallel-safe group. |
| `agent.tool_result_artifacts` | Boolean | `true` | Save oversized non-`read` text results as private session artifacts and give the model a bounded retrievable preview. |
| `background_jobs.max_concurrent` | Positive integer | `4` | Maximum active Background Jobs owned by one session instance. Retained terminal Jobs do not count toward the limit. |
| `agent.repeated_tool_calls.reminder_thresholds` | Strictly increasing integer array; every value is at least 2 | `[3,5,8]` | Consecutive exact-call counts at which the Agent adds escalating advisory context. An empty array disables the policy. |
| `agent.repeated_tool_calls.excluded_tools` | Unique, non-empty, trimmed tool-name array | `[]` | Tools ignored transparently by repeated-call tracking; excluded calls neither advance nor reset a streak. |
| `approval.mode` | `always`, `unless_trusted`, `never` | `unless_trusted` | Whether tool calls enter the TUI approval flow. |
| `notification.backend` | `auto`, `off`, `bell`, `osc9`, `osc777`, `kitty` | `auto` | Terminal-notification output protocol. `auto` detects Kitty, iTerm, Ghostty, then VTE, otherwise falls back to bell. |
| `notification.on_agent_completed` | Boolean | `true` | Notify when an Agent run completes normally. Aborted, failed, length-truncated, and `turn_limit` runs are not completion. |
| `notification.on_approval_required` | Boolean | `true` | Notify when a tool-approval prompt is shown. |
| `tui.hyperlinks` | Boolean | `true` | Allow the TUI to render Markdown links with OSC 8 when terminal support is confirmed; disabled, unknown, or unsupported terminals show `label (url)`. |
| `tui.render_latex` | Boolean | `true` | Render supported Markdown math as terminal-friendly Unicode and character-cell layouts; when disabled, preserve the original LaTeX source. |
| `tui.render_mermaid` | Boolean | `true` | Render supported fenced Mermaid blocks as terminal Unicode diagrams while text streams; when disabled, preserve them as code blocks. |
| `tui.smooth_text_streaming` | Boolean | `true` | Smoothly reveal bursty assistant text; when disabled, show each latest provider streaming snapshot directly. |
| `tui.collapse_long_pastes` | Boolean | `true` | Collapse bracketed pastes of 1,000 or more graphemes into an atomic `[Pasted N chars]` editor item; when disabled, render and edit pasted text normally. |
| `memory.enabled` | Boolean | `true` | Register `remember` and inject memory into the system prompt. |
| `memory.max_chars` | Positive integer | `6000` | Unicode-character limit for consolidated durable memory. |
| `memory.daily_retention_days` | Optional positive integer | Unset | Number of daily staging records retained after successful full memory compaction. |
| `logging.level` | `debug`, `info`, `warn`, `error`, `off` | `info` | Minimum level written to runtime JSONL logs; `off` disables file logging entirely. |

`parallel_tool_calls` is a user policy; its effective value is the user setting AND selected-model metadata support. When disabled, the provider request does not advertise parallel capability, ToolRuntime executes calls one at a time even if a model still returns several in one response, and `max_parallel_tool_calls` has no scheduling effect. The limit remains validated so enabling parallelism later cannot expose a latent invalid value. When enabled, only adjacent tools declaring `execution.concurrency = "parallel"` can form a concurrent group. ToolRuntime starts those calls in model order and uses a rolling pool with at most `max_parallel_tool_calls` invocation bodies in flight; an exclusive, undeclared, unknown, or invalidly configured tool remains a barrier. Current OpenAI Codex models use classic Responses and advertise parallel-tool support, so their request field follows this effective setting.

The repeated-call policy compares tool name plus canonical JSON arguments, recursively sorting object keys while preserving array order. A different included call resets the streak; excluded calls are transparent. Human prompt or steering input and `Agent.reset()` also reset it, while agent-origin scheduled input does not. Threshold reminders are persisted internal context for the next model request and never block a tool call. Approval denial, cancellation, validation failure, missing tools, and execution errors count because tracking runs after result normalization.

With `tool_result_artifacts = true`, Kana derives one inline byte budget from the active model's prompt budget instead of exposing a second numeric threshold. A non-`read` result that crosses it is saved in full before its model-facing text is replaced by a head/tail preview containing the exact omitted UTF-8 byte count, an absolute locator, and `read`/`grep` retrieval guidance. The preview reserves its notice inside the same budget. Top-level `read` output is bounded without another artifact to prevent a retrieval loop, and its notice makes the line-based pagination limitation explicit. A storage failure emits safe diagnostics and falls back to the original model-facing outcome, which the ordinary context guard may then truncate; independently oversized or non-serializable structured data remains excluded from the durable message. Disabling the setting skips artifact storage and uses the ordinary model-facing guard, while the structured persistence boundary remains active. Clean sessions use process-scoped temporary artifact storage; normal sessions use durable session-scoped storage described in [Sessions and memory](sessions-and-memory.md).

The Background Job limit applies to process-local execution, not persistence. `max_concurrent` rejects a new `bash` call with `background: true` after the current session reaches the active limit.

`hyperlinks` is permission rather than a force switch: even when it is `true`, Kana emits OSC 8 only for terminals with confirmed support and keeps the URL visible when capability is unknown; `false` always uses the text fallback. `render_latex` applies to live and restored assistant messages, Markdown tables, and the memory viewer. Supported expressions render by default; disabling it, encountering unsupported or malformed syntax, or receiving an unclosed streaming delimiter preserves the original LaTeX. Terminal width affects wrapping after successful rendering and does not cause a source fallback. `render_mermaid` applies to live and restored assistant messages and the memory viewer. Enabled Mermaid code blocks render continuously while streaming; unsupported or malformed diagrams, renderer failures, and diagrams wider than the available terminal width remain ordinary code blocks. A partial parse may render while streaming, but if it still reports dropped source after completion Kana restores the code block and adds one warning. By default, `smooth_text_streaming` changes only visible-text pacing and never backpressures the provider or Agent. When disabled, the TUI still coalesces terminal repaints but no longer subdivides provider text snapshots. `collapse_long_pastes` affects only editor presentation and editing: the complete pasted text is still submitted, queued, and restored from input history. When `daily_retention_days` is commented out or omitted, daily memory is not pruned. Logs always write under `<KANA_HOME>/logs`; the directory is not configurable and log output never goes through the terminal, so it cannot disrupt TUI repainting. `max_turns` accepts only `-1` or a positive integer; Boolean and numeric fields are validated strictly whenever they apply to the selected model. `goal.max_rounds`, `tool_deadline_ms`, `max_parallel_tool_calls`, `background_jobs.max_concurrent`, `max_output_tokens`, and optional `context_limit` require positive integers; retry counts require non-negative integers.

### Context budget

Each Agent uses its resolved `context_limit` to calculate the automatic context-compaction budget. The effective value comes from its override, then its concrete model default, and is clamped to the selected model metadata window. The effective prompt budget and per-turn output ceiling are:

```text
safetyReserve = clamp(floor(contextLimit × 5%), 256, 8192)
promptBudget = contextLimit - safetyReserve
effectiveMaxTokens = min(activeModel.max_output_tokens, promptBudget - estimatedPromptTokens)
```

At least 512 prompt tokens must remain. Compaction starts when estimated input reaches 80% of this budget. Its cutoff lands only after a complete assistant turn or complete tool-call/result group and aims to bring “system prompt + tool definitions + maximum summary placeholder + retained recent messages” down to 10% of `promptBudget`. Configured `max_output_tokens` is a ceiling rather than a fixed reserve; as the prompt grows, the Agent lowers the current `ModelContext.maxOutputTokens`. DeepSeek sends it as Responses `max_output_tokens`; the ChatGPT Codex wire contract omits the field while Kana still uses the resolved ceiling locally.

Default `info` retains only session, TUI, Agent-run, and memory-task summaries; per-turn activity, provider requests, and successful tool execution belong to `debug`. Agent construction emits `agent.parallel_tool_calls_configured` with `requested`, `supported`, the final `enabled`, and `maxParallelToolCalls`, plus `agent.repeated_tool_calls_configured` with enablement, thresholds, and excluded-tool count. Parallel groups emit `tool.parallel_pool_started` and `tool.parallel_pool_ended` at `debug`; an aborted or failed drain additionally emits one `tool.parallel_pool_abnormal_drain` at `info` or `warn` with aggregate counts only. Policy failures emit `tool.result_policy_failed` without arguments or result content; successful insertion emits `tool.result_policy_context_committed` with source and count. Artifact save, cleanup, fork, and invalid-reference diagnostics use stable `tool.result_artifact_*` or `session.artifact_*` events with sizes, phases, outcomes, and error types only—never result text or locators. `context.output_limit_adjusted` contains only the configured ceiling, effective per-turn ceiling, and estimated prompt tokens. Retries and failed tools use `warn`, while runtime and persistence failures use `error`. Error records contain an `Error` name, message, and stack; provider HTTP failures additionally retain status code and status text, never response bodies, authorization headers, prompts, or tokens.

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

When an optional server fails to start, Kana records diagnostics, closes that server, and continues, leaving a persistent warning before the final summary. A failed required server during initial loading leaves the current session in an error state without enabling the editor. During an explicit reload, however, any configuration or required-server failure clears the closed manager's tools, rebuilds the Agent without them, reports the error in the transcript, and restores the editor so `/mcp` can be opened again. Connecting and reloading append a heading, one `[completed/total]` result line per selected server with its outcome and post-filter tool count, any warnings, and a final startup/reload summary. Selecting no servers follows the same path with no result lines and a `0/0` summary; a reload's internal close stage is not recorded as a load result. Remote tools retain the unknown-tool approval policy, so every call requires confirmation in `unless_trusted` mode; the approval prompt shows the server ID, original remote tool name, and complete formatted arguments, with allow-once and deny choices only. On quit, idle or loading `Ctrl+C`, or `SIGHUP`, `SIGINT`, and `SIGTERM`, Kana begins graceful shutdown and shows per-server close progress at the end of the transcript without replacing bottom. It restores the terminal and prints exit information only after every MCP server closes. Pressing `Ctrl+C` again while graceful shutdown is pending forces immediate termination.

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
| `always` | Requests approval for every tool call except `remember`, `schedule_wake`, and `todo_write`. |
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

This example changes only the main Agent model and notification behavior; every other field retains its default:

```toml
[agent]
provider = "deepseek"
model = "deepseek-v4-flash"

[notification]
backend = "bell"
on_agent_completed = false
```

Switching to an already authorized Codex Luna requires only:

```toml
[agent]
provider = "openai-codex"
model = "gpt-5.6-luna"
```

Avoid copying the complete default file for a small change. Omitted concrete-model and Agent fields continue to resolve from defaults.
