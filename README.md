<p align="center">
  <img src="assets/kana-logo.svg" width="156" alt="Kana logo">
</p>

<h1 align="center">Kana</h1>

<p align="center">
  <strong>A local-first terminal AI agent that works inside your repository.</strong><br>
  Inspect code, edit files, run commands, and carry context across sessions—with DeepSeek or OpenAI Codex.
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/longyijdos/kana/releases/latest"><img src="https://img.shields.io/github/v/release/longyijdos/kana" alt="Latest release"></a>
  <a href="https://github.com/longyijdos/kana/actions/workflows/ci.yml"><img src="https://github.com/longyijdos/kana/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/longyijdos/kana" alt="MIT license"></a>
</p>

<p align="center">
  <img src="assets/kana-demo.gif" alt="Kana analyzes a repository, fixes a failing test, and verifies the result">
</p>

Kana is an open-source, terminal-native agent for coding and other tool-driven work. Its interactive TUI keeps reasoning, tool calls, approvals, diffs, delegated work, and results in one focused interface, while `kana exec` exposes the same runtime to scripts and CI.

Configuration, sessions, memory, logs, and usage records stay on your machine. Model requests go only to the provider you select.

## Quick start

Prebuilt binaries are available for macOS and Linux on arm64 and x64:

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
```

DeepSeek is the default provider. Add your API key and launch Kana inside a project:

```bash
export DEEPSEEK_API_KEY="sk-..."
cd your-project
kana
```

Prefer OpenAI Codex? Complete browser authentication, then select it in `~/.kana/config.toml`:

```bash
kana auth login openai-codex
```

```toml
[agent.model]
provider = "openai-codex"
name = "gpt-5.6-sol"
```

You can switch provider, model, and supported reasoning effort later with `/model`. A static [Custom OpenAI-compatible provider](docs/custom-provider.md) slot is available for local or hosted compatible endpoints.

## Why Kana

| | Capability | What it gives you |
| --- | --- | --- |
| 🛠️ | Work directly in your repository | Built-in file and image inspection, writing, editing, shell commands, background jobs, visible approvals, and complete oversized results stored as artifacts. |
| 🧠 | Keep context across work | Resumable and forkable sessions, interrupted-run recovery, automatic context compaction, durable project/global memory, session todos, and bounded Goals. |
| 🧩 | Delegate focused work | Asynchronous subagents selected from built-in or user-defined role profiles, with scoped tools, optional models, independent transcripts, and usage. |
| 🔌 | Bring your own tools | Project instructions through `AGENTS.md`, reusable Skills, a configurable built-in tool surface, and MCP servers over stdio or Streamable HTTP with OAuth. |
| 🤖 | Choose your model | DeepSeek API and OpenAI Codex OAuth, custom OpenAI-compatible endpoints, live model switching, configurable reasoning effort, image prompts on supported models, and hosted web search. |
| ⌨️ | Stay in the terminal | Dark, light, and custom themes; streaming Markdown; terminal-native Mermaid and LaTeX; full tool history; syntax-highlighted diffs; queued and scheduled input; notifications; and hyperlinks. |
| ⚙️ | Automate the same runtime | One-shot, resumable, time-bounded, or Goal-driven `kana exec` runs; a versioned JSONL stream; and a reusable GitHub issue-to-draft-PR workflow. |

## Built for control, not as an SDK wrapper

Kana keeps its critical path in this repository instead of delegating product behavior to an agent framework. It has no agent, TUI, MCP, OAuth, or model-provider SDK; Kana implements its own:

- **Agent runtime** — the model/tool loop, parallel tool scheduling, deadlines, cancellation, context compaction, tool-result policies, lifecycle events, and usage accounting.
- **Terminal UI** — raw terminal lifecycle, input handling, themes, streaming Markdown, semantic tool blocks and inspectors, syntax highlighting, responsive tables, and differential rendering.
- **Protocol stack** — MCP JSON-RPC, stdio, Streamable HTTP, SSE, OAuth 2.0/OIDC discovery, and PKCE.
- **Provider adapters** — request conversion, streaming, retries, usage, and context-error recovery for DeepSeek, OpenAI Codex, and custom OpenAI-compatible endpoints.
- **Local state** — incremental session and subagent journals, recovery, forks, todos, artifacts, memory, logs, and accounting.

The goal is not zero dependencies. Kana uses focused libraries where they help, while keeping the behavior that defines reliability, safety, and the user experience readable and changeable.

## Use Kana

### Interactive sessions

```bash
kana                                      # Start an empty session
kana "analyze this repository"            # Start with a task
kana resume                               # Pick a saved session
kana resume <session-id>                  # Resume a specific session
kana --clean                              # Start a temporary, unsaved session
```

Useful commands inside the TUI:

| Command | Action |
| --- | --- |
| `/model` | Switch provider, model, and reasoning effort when supported. |
| `/resume`, `/fork <task>` | Resume or branch from earlier work. |
| `/mcp`, `/skills` | Manage active MCP servers and global Skills. |
| `/agents` | View subagent profiles, inspect child transcripts, and manage current-session runs. |
| `/jobs`, `/todo` | Manage session-owned background jobs and inspect the durable session checklist. |
| `/memory` | View or consolidate durable project/global memory. |
| `/schedule` | View, create, refresh, and delete scheduled messages. |
| `/goal <objective>` | Keep advancing one bounded objective across sequential Agent runs. |
| `/tools` | Browse every tool call in the session and reopen any detail inspector. |
| `/approval` | Change tool approval behavior for the current session. |
| `/usage` | Inspect session, project, or global token usage. |
| `!<command>` | Run a local shell command directly, outside the agent loop. |

See [TUI interaction](docs/tui.md) for shortcuts, queued input, scheduled messages, and the complete command set. Rendering internals are documented separately in [Terminal rendering](docs/terminal-rendering.md).

### Delegation and long-running work

Kana can start session-owned background commands and bounded subagents without blocking the main Agent. Built-in `explorer`, `worker`, and `reviewer` profiles cover common delegation patterns; Markdown role cards under `~/.kana/agents` can further restrict tools or select another configured model. Child runs keep independent transcripts and accounting, while `/agents` lets you inspect or cancel them during the parent run.

Session todos persist across resume and fork. `/goal` drives a bounded sequence of Agent runs toward one objective, while `/jobs` keeps long-running shell work attached to the current session. See [Subagents](docs/subagents.md), [Tools and execution](docs/tools.md), and [Conversation runtime](docs/conversation-runtime.md).

### Headless automation

```bash
kana exec "fix the failing tests"
printf 'summarize this repository' | kana exec
kana exec resume <session-id> "continue the task"
kana exec --goal "finish and verify this task"
kana exec --timeout 30m "complete this change"
kana exec --json "analyze this project"
```

`kana exec` suits CI and scripted automation.

By default, the final answer goes to stdout and progress goes to stderr. `--json` emits versioned JSONL events. `--allow-all-tools` skips interactive approval for controlled automation; it does not create a sandbox.

See [Headless execution and the JSONL protocol](docs/headless.md) for event schemas and exit codes.

### GitHub automation

The reusable Kana Agent workflow can run scoped work from maintainer-authored issues and continue on Kana-owned pull requests. It uses repository-local model configuration, preserves partial progress, and opens draft PRs for review. See [Kana Agent reusable workflow](docs/kana-agent-workflow.md).

### Skills and MCP

Install or update the default Skills repository, then optionally share those Skills with Codex:

```bash
kana skills install
kana skills sync codex
```

Kana discovers project Skills from `.kana/skills` and `.agents/skills`, reads project instructions from `AGENTS.md`, and can connect to local or remote MCP servers. The main Agent's built-in tool set is selectable through `agent.tools`. MCP definitions and activation state live under `~/.kana/`; the TUI provides runtime server selection, cancellable startup and reload, and OAuth flows.

See [Configuration and installation](docs/configuration.md) for the MCP schema, proxy settings, OAuth, approvals, and every configuration option.

## Install from source

Kana requires Bun and Git when building locally:

```bash
git clone https://github.com/longyijdos/kana.git
cd kana
bun install --frozen-lockfile
./scripts/install.sh
```

Installed release binaries can update themselves:

```bash
kana update --check
kana update
```

## Local-first, with explicit trust boundaries

- Kana stores configuration, OAuth credentials, sessions, logs, memory, and usage data under `~/.kana/` by default. Set `KANA_HOME` to use another location.
- Model requests include the conversation and tool definitions needed by the selected provider.
- Tool approval is a confirmation layer, not a filesystem or process sandbox. File tools can access paths outside the workspace, and `bash` runs real commands.
- Stdio MCP servers start before individual tool approvals, so configure only programs you trust.
- Session files contain full conversations and tool results; treat them as sensitive data.

Read [Configuration and installation](docs/configuration.md) for the complete security and credential model.

## Documentation

- [Documentation index](docs/README.md)
- [Configuration and installation](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Conversation runtime](docs/conversation-runtime.md)
- [Agent runtime](docs/agent-runtime.md)
- [Tools and execution](docs/tools.md)
- [Providers](docs/providers.md)
- [OAuth](docs/oauth.md)
- [MCP](docs/mcp.md)
- [Sessions and memory](docs/sessions-and-memory.md)
- [Skills and system prompt](docs/skills-and-prompt.md)
- [Subagents](docs/subagents.md)
- [DeepSeek provider](docs/deepseek-provider.md)
- [OpenAI Codex provider](docs/openai-codex-provider.md)
- [Custom OpenAI-compatible provider](docs/custom-provider.md)
- [TUI interaction](docs/tui.md)
- [Terminal rendering](docs/terminal-rendering.md)
- [Headless execution](docs/headless.md)
- [Kana Agent reusable workflow](docs/kana-agent-workflow.md)
- [Terminal-Bench evaluation](docs/terminal-bench.md)

## Development

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs Biome, the project comment-length guard, TypeScript, Knip dead-code analysis,
and the Bun test suite. The guard rejects TypeScript comment blocks longer than four lines or 320
characters; license headers and explicit `comment-check-ignore: <reason>` suppressions are exempt.
Run `bun run knip:fix` separately when intentionally cleaning unused exports or dependencies so
its changes can be reviewed before committing.

Kana is under active development before `1.0`; CLI behavior, protocols, and persistence formats may evolve between minor releases. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute; [AGENTS.md](AGENTS.md) contains coding-agent workflow and implementation guidance and is not the primary human contribution guide. See the [release process](docs/releasing.md) for versioning and release details.

## License

[MIT](LICENSE)
