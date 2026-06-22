# Configuration and installation

This document describes Kana's implemented commands, configuration files, and local directory layout. Configuration is parsed as Bun TOML; file keys use `snake_case` while the code uses `camelCase`.

## Install and start

```bash
# Create default local configuration
kana install

# Also install or update the default global Skills repository
kana install --skills

# Overwrite config.toml, approvals.json, and skills.toml; reclone Skills when requested
kana install --force --skills

# Start the TUI; arguments become the first prompt
kana fix the failing tests

# Restore by ID, or open the picker when the ID is omitted
kana resume [session-id]
```

`kana install` does not overwrite existing files. `--force` restores `config.toml`, `approvals.json`, and `skills/skills.toml` to their defaults; when combined with `--skills`, it also deletes and reclones the default Skills directory. It does **not** create `~/.kana/AGENTS.md`; users create global instructions themselves.

The default Skills repository is `https://github.com/longyijdos/kana-skills.git`, installed at `<KANA_HOME>/skills/kana-skills`. If the existing directory is not a Git repository, a regular update fails and `--force` is required to replace it. An existing Git repository is updated with `git pull --ff-only`.

## Root directory and file layout

Kana uses `KANA_HOME` as its root. When unset, it uses `$HOME/.kana`; when `HOME` is unavailable, it falls back to the OS-reported home directory.

```text
${KANA_HOME:-$HOME/.kana}/
├── config.toml             # Runtime configuration covered here
├── approvals.json          # bash trust rules
├── AGENTS.md               # Optional global system instructions; not created by install
├── sessions/               # Workspace-grouped JSONL sessions
├── memory/                 # Global and project memory
└── skills/
    ├── skills.toml         # Enabled global Skills
    └── kana-skills/        # Default repository cloned by `kana install --skills`
```

Files written by installation and the application are created or written with mode `0600`. This is the requested file mode; its effective result remains subject to the operating system, filesystem, and umask.

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
```

### `[model]`

| Key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `provider` | Only `deepseek` | `deepseek` | The sole provider supported by the current product configuration. |
| `name` | Non-empty string | `deepseek-v4-pro` | Model name; runtime rejects names outside DeepSeek's metadata table. |
| `api_key_env` | Non-empty string | `DEEPSEEK_API_KEY` | Name of the environment variable holding the API key; the key is not written to TOML. |
| `thinking` | Boolean | `true` | Explicitly enables DeepSeek thinking in requests. |
| `reasoning_effort` | `high` or `max` | `high` | DeepSeek reasoning effort; it is not sent when `thinking = false`. |
| `max_tokens` | Finite number | `8192` | Per-request output-token limit; it cannot exceed the selected model's hard limit. |
| `timeout_ms` | Finite number | `60000` | Timeout in milliseconds for one DeepSeek HTTP request. |
| `max_retries` | Finite number | `1` | Maximum retries after retryable request failures. |

Before startup, set the environment variable named by `api_key_env`. The default configuration uses:

```bash
export DEEPSEEK_API_KEY='sk-...'
```

### Other tables

| Table and key | Type and allowed values | Default | Meaning |
| --- | --- | --- | --- |
| `agent.max_turns` | Finite number; `-1` means unlimited | `-1` | Maximum model/tool turns in one user run. |
| `approval.mode` | `always`, `unless_trusted`, `never` | `unless_trusted` | Whether tool calls enter the TUI approval flow. |
| `notification.backend` | `auto`, `off`, `bell`, `osc9`, `osc777`, `kitty` | `auto` | Terminal-notification output protocol. `auto` detects Kitty, then iTerm, then VTE, otherwise falls back to bell. |
| `notification.on_agent_completed` | Boolean | `true` | Notify when an Agent run completes normally. Aborted, failed, and length-truncated runs are not completion. |
| `notification.on_approval_required` | Boolean | `true` | Notify when a tool-approval prompt is shown. |
| `memory.enabled` | Boolean | `true` | Register `remember` and inject memory into the system prompt. |
| `memory.max_chars` | Positive integer | `6000` | Unicode-character limit for consolidated durable memory. |
| `memory.daily_retention_days` | Optional positive integer | Unset | Number of daily staging records retained after successful full memory compaction. |

When `daily_retention_days` is commented out or omitted, daily memory is not pruned. `max_turns`, `max_tokens`, `timeout_ms`, and `max_retries` are currently validated only as finite numbers; the two `memory` quantity fields additionally require positive integers.

The configuration root and each present section must be a TOML table. Strings cannot be empty, booleans cannot be represented as strings, and unsupported providers, reasoning efforts, approval modes, or notification backends prevent startup. Kana does not silently ignore invalid known fields; fix the configuration and restart.

## API key and project instructions

`api_key_env` only tells Kana where to read the key. Kana does not load `.env` files and does not persist the key in `config.toml`. To use a different key, set the selected variable in the shell that starts Kana or choose another environment-variable name.

The global `AGENTS.md` is `<KANA_HOME>/AGENTS.md`. A project-root `AGENTS.md` is also read; when both exist, global content is injected first and project content afterward. The project file therefore occupies the more specific, later position. See the prompt-composition section of the [architecture overview](architecture.en.md).

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
| `always` | Requests approval for every tool call except `remember`. |
| `unless_trusted` | Skips approval for `read`, exact trusted bash commands, and trusted simple read-only bash commands; asks for everything else. |
| `never` | Skips approval for all calls, including writes and shell commands. |

## Global Skills configuration: `skills/skills.toml`

```toml
[model_invocation]
enabled = []
```

This list names the **global** Skills that may be injected into the model system prompt. Skills in project `.kana/skills` and `.agents/skills` are always enabled and cannot be disabled through this file. The TUI's `/skills` command changes only this global activation list.

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
