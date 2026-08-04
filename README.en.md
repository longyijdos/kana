<p align="center">
  <img src="assets/kana-logo.svg" width="156" alt="Kana logo">
</p>

<h1 align="center">Kana</h1>

<p align="center">
  <strong>Not another SDK wrapper: four direct runtime dependencies, with the critical path built in-house.</strong><br>
  The agent loop, TUI, MCP, OAuth, provider streams, and session system all live in this repository.
</p>

<p align="center">
  <a href="README.md">中文</a> · English
</p>

Kana is a local-first, terminal-native personal agent runtime. Instead of wrapping a stack of upstream SDKs in a command-line shell, it directly implements the path from model streams to tool scheduling, terminal input to differential rendering, and MCP transports to session recovery.

The interface, binary, and persistent data stay local. Model requests are sent to the provider you select. Kana currently supports the DeepSeek API and OpenAI Codex through browser OAuth.

## Few dependencies, built in-house

Kana has only four direct runtime dependencies. There is no agent framework, TUI framework, MCP SDK, OAuth SDK, or model-provider SDK. Kana implements its own:

- **Agent runtime**: message protocol, model/tool loop, safe parallelism, deadlines, cancellation, context compaction, and lifecycle events.
- **Terminal UI**: raw-terminal lifecycle, keyboard protocols, editor, focus management, Markdown/table rendering, and differential repainting.
- **Protocol stack**: MCP JSON-RPC, stdio, Streamable HTTP, SSE, OAuth 2.0/OIDC discovery, and PKCE.
- **Provider adapters**: DeepSeek and OpenAI Codex request conversion, stream parsing, retries, usage, and context-error recovery.
- **Local state**: incremental JSONL turn journals, interrupted-run recovery, session forks, durable memory, logs, and usage accounting.

This is not a zero-dependency stunt. Kana uses mature, focused libraries where they help, while keeping the code that defines product behavior, reliability, and security boundaries under its own control: readable, changeable, debuggable, and unconstrained by an agent SDK's abstractions.

## Highlights

| Capability | What it provides |
| --- | --- |
| Terminal-native TUI | An in-house terminal runtime with streaming Markdown, syntax highlighting, responsive tables, a multiline editor, tool progress, and approvals. |
| Complete agent runtime | An in-house multi-turn model/tool loop with safe parallel tools, deadlines, cancellation, automatic context compaction, and usage accounting. |
| Local tools | Directory listing, glob, grep, file reading/writing/editing, shell execution, durable memory, and in-process scheduled wakes. |
| MCP | An in-house client and transports with stdio, Streamable HTTP, OAuth 2.0, per-server proxies, tool filtering, and runtime activation. |
| Sessions and memory | Workspace-scoped JSONL sessions that can be resumed or forked, plus project/global durable memory with automatic consolidation. |
| Skills and instructions | Global and project Skill discovery, `AGENTS.md` instructions, and synchronization of Kana Skills to Codex or another agent. |
| Automation interface | One-shot `kana exec` runs for scripts, CI, and evaluation, with a versioned JSONL event protocol. |
| Model providers | DeepSeek API and OpenAI Codex OAuth, with in-TUI switching of provider, model, and reasoning effort. |

## Quick start

### Install a prebuilt release

The installer supports macOS and Linux on arm64 and x64. It downloads and verifies the latest Release, installs `kana` to `~/.local/bin`, and initializes missing local support files.

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
```

Use `KANA_VERSION` or `KANA_INSTALL_DIR` to install a specific version or location. See [Configuration and installation](docs/configuration.en.md) for every option.

### Choose a model provider

DeepSeek is the default provider. Set an API key and start Kana:

```bash
export DEEPSEEK_API_KEY="sk-..."
kana
```

To use OpenAI Codex, first complete browser authorization:

```bash
kana auth login openai-codex
```

Then select the provider in `~/.kana/config.toml`. Omitted fields continue to use built-in defaults:

```toml
[provider]
active = "openai-codex"

[model.openai-codex]
name = "gpt-5.6-sol"
```

See the [OpenAI Codex provider](docs/openai-codex-provider.en.md) for authentication, models, and reasoning configuration.

### Install from source

Bun and Git are required:

```bash
git clone https://github.com/longyijdos/kana.git
cd kana
bun install --frozen-lockfile
./scripts/install.sh
```

## Use Kana

### Interactive TUI

```bash
# Open an empty session
kana

# Send the first task immediately
kana "analyze this repository and fix the failing tests"

# Resume by ID, or open the picker when the ID is omitted
kana resume [session-id]

# Open a temporary session that will not be saved
kana --clean
```

`--clean` creates a temporary session that is discarded when the process exits. It writes no session journal, runtime log, or accounting record and loads no custom instructions, memory, Skills, or MCP. It still reads `.env`, model and runtime configuration, authentication, and approval rules, and the status line keeps a `clean` marker visible. Clean mode cannot be combined with `resume` and is not a file or process sandbox: built-in tools, providers, and the local shell can still have external side effects. `/model` changes only the current process in clean mode.

Common interactions:

| Command or key | Action |
| --- | --- |
| `/help` | Show every command and shortcut. |
| `/new`, `/resume`, `/fork <task>` | Create, restore, or fork a session. |
| `/model` | Switch provider, model, and reasoning effort. |
| `/mcp` | Enable, disable, or reload configured MCP servers. |
| `/skills` | Manage enabled global Skills. |
| `/memory` | View or consolidate project/global memory. |
| `/usage` | Inspect usage for the current session, project, or all workspaces. |
| `!<command>` | Run a local shell command directly, bypassing the agent. |
| `Ctrl+O` | Expand the most recent inspectable tool output. |
| `Ctrl+C` / `Esc` | Abort active work, close a view, or exit. |

In clean mode, `/fork`, `/resume`, `/delete`, and the Session scope of `/usage` are unavailable; Project and Global usage remain readable.

See [TUI interaction and rendering](docs/tui.en.md) for the complete interaction model.

### Headless execution

`kana exec` uses the same runtime as the TUI and exits after one complete agent turn:

```bash
kana exec "fix the failing tests"
printf 'summarize this repository' | kana exec
kana exec resume <session-id> "continue the task"
kana exec --clean "analyze the project with built-in Agent capabilities"
```

By default, only the final answer goes to stdout and progress goes to stderr. Machine consumers can request versioned JSONL:

```bash
kana exec --json "analyze this project"
```

`--allow-all-tools` unconditionally authorizes the agent to execute every available tool. It does not isolate files or processes and should be used only in a controlled environment. See [Headless execution and the JSONL protocol](docs/headless.en.md) for events, output, and exit codes.

### Skills and MCP

Install or update the default Skills repository:

```bash
kana skills install
```

Installed Kana Skills can also be synchronized to Codex:

```bash
kana skills sync codex
```

MCP server definitions live in `~/.kana/mcp.json`, while activation state lives in `~/.kana/mcp-enabled.json`. Kana supports local stdio servers and remote Streamable HTTP servers; use `/mcp` in the TUI to manage connections. See [Configuration and installation](docs/configuration.en.md#mcpjson-and-mcp-enabledjson) for the schema, OAuth, and proxy options.

### Update

A standalone binary can check for and atomically install its own updates:

```bash
kana update --check
kana update
```

## Built-in tools

| Tool | Purpose |
| --- | --- |
| `list` | List one level of a directory. |
| `glob` | Find paths with a glob pattern. |
| `grep` | Search text with a regular expression or literal string. |
| `read` | Read UTF-8 files with pagination. |
| `write` | Create files or explicitly overwrite existing files. |
| `edit` | Perform exact text replacement in an existing file. |
| `bash` | Run shell commands with streaming output. |
| `remember` | Record information in project or global memory. |
| `schedule_wake` | Schedule later agent input in the current Kana process. |

Read operations and trusted shell commands can run directly according to configuration; tools with side effects normally enter approval. See the [Agent and tool execution protocol](docs/agent-and-tools.en.md) for parameters and execution semantics.

## Local data and security boundaries

Kana stores configuration, OAuth credentials, sessions, logs, memory, and Skills under `~/.kana/` by default. Set `KANA_HOME` to use another location.

- Model requests send the necessary conversation, system prompt, and tool definitions to the active provider.
- Session files contain complete conversations and tool results and should be treated as sensitive. OAuth tokens rely on local file permissions for protection.
- Tool approval is an interactive confirmation mechanism, not a filesystem or process sandbox. Built-in file tools can access paths outside the workspace, and `bash` runs real commands.
- A stdio MCP server starts before its tools can be approved, so configure only trusted programs. Remote MCP endpoints are also part of the trust boundary.
- `!<command>` is a user-initiated local shell command and does not pass through agent tool approval.

See [Configuration and installation](docs/configuration.en.md) for the complete file layout, approval modes, and credential handling.

## Documentation

- [Developer documentation index](docs/README.en.md)
- [Architecture overview](docs/architecture.en.md)
- [Configuration and installation](docs/configuration.en.md)
- [Agent and tool execution protocol](docs/agent-and-tools.en.md)
- [Sessions and memory](docs/sessions-and-memory.en.md)
- [Skills and the system prompt](docs/skills-and-prompt.en.md)
- [DeepSeek provider](docs/deepseek-provider.en.md)
- [OpenAI Codex provider](docs/openai-codex-provider.en.md)
- [Headless execution and the JSONL protocol](docs/headless.en.md)
- [Local Terminal-Bench evaluation](docs/terminal-bench.en.md)
- [TUI interaction and rendering](docs/tui.en.md)

## Development

```bash
bun install --frozen-lockfile
bun src/main.ts
bun run check
```

Kana is still evolving before `1.0`; CLI behavior, protocols, and persistence formats may change across minor releases. Read [AGENTS.md](AGENTS.md) before contributing code.

See the [release process](docs/releasing.en.md) for version selection, Changelog, tags, and GitHub Releases. Historical release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
