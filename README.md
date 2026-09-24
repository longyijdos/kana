<p align="center">
  <img src="assets/kana-logo.svg" width="156" alt="Kana logo">
</p>

<h1 align="center">Kana</h1>

<p align="center">
  <strong>A lightweight, untracked, and deeply personal terminal AI companion.</strong><br>
  Instant single binary, zero telemetry. Transparent pairing ends black-box waiting, durable memory stops the amnesia loop, and reusable templates and subagents evolve alongside your workflow.
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

Kana is an open-source, single-binary, terminal-native AI agent built for coding, system workflows, and tool-driven productivity. From a focused interactive TUI that keeps reasoning, diffs, and execution in flow, to headless `kana exec` powering scripts and CI pipelines, it delivers a razor-sharp runtime with instant cold starts.

Unlike rigid black-box runners, Kana is a companion that **evolves alongside you**:

- **Transparent pairing & shared growth**: Break away from opaque spinners and passive waiting. With streamed reasoning, syntax-highlighted diffs, and visible traces, Kana doesn't just divide parallel work with you—it demystifies complex problems, helping you master system nuances and grow as you build together;
- **Durable memory, built-in intuition**: Put an end to the frustrating amnesia loop where every new session starts from scratch. Powered by a two-tier local memory architecture, Kana distills your architectural rules, habits, and past edge cases—turning every past correction into lasting intuition;
- **Self-evolving capability**: It doesn't just execute instructions—Kana can turn recurring workflows into reusable `:prompt` templates and author dedicated **Subagent role cards** as your needs evolve. The more you use it, the more it shapes itself into your personal toolkit.

**Sovereign, private, and untracked.** Kana sends no telemetry. During normal agent execution, network access is strictly limited to your configured model providers and MCP servers; explicit features such as updates, authentication, or installs access only their respective services. Your configs, sessions, memory, artifacts, and logs stay strictly on your machine.

## Quick start

Single binary with zero runtime dependencies—no Node.js or Python required. Prebuilt for macOS and Linux on arm64 and x64:

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
```

### 1. Launch with DeepSeek (Default)

No account registration needed. Just export your API key and launch Kana inside any project directory:

```bash
export DEEPSEEK_API_KEY="sk-..."
cd your-project
kana
```

### 2. Or connect OpenAI Codex

Authenticate seamlessly through your browser:

```bash
kana auth login openai-codex
```

Set it in `~/.kana/config.toml`, or switch directly inside the TUI anytime using `/model`:

```toml
[agent.model]
provider = "openai-codex"
name = "gpt-5.6-sol"
```

Once inside, switch providers, models, or reasoning efforts on the fly with `/model`. For local endpoints (Ollama, vLLM) or hosted gateways, connect via the [Custom OpenAI-compatible provider](docs/custom-provider.md).

## Why Kana

| | Capability | What Makes It Different |
| --- | --- | --- |
| 🧠 | **Durable Memory & Intuition** | **End the amnesia loop**. Two-tier persistent memory (workspace & global) automatically consolidates your architectural habits, conventions, and past edge cases—turning corrections into lasting intuition across sessions. |
| 🤝 | **Transparent Synergy & Delegation** | **No more black-box waiting**. Streamed reasoning traces and syntax-highlighted diffs keep execution transparent. Bidirectional delegation lets agent and human tackle complex tasks in parallel. |
| 🧬 | **Self-Evolving Capability** | **Grows around your workflow**. Turns recurring workflows into reusable `:prompt` templates and authors specialized Markdown Subagent role cards as your needs evolve—shaping itself around your craft. |
| 🛡️ | **Zero Telemetry & Local Sovereignty** | **Pure single binary, instant launch**. Zero telemetry, with normal execution strictly limited to your chosen models and MCP servers; sessions, memory, and artifacts are strictly isolated on your disk with `0600`/`0700` permissions. |
| ⌨️ | **Terminal-Native Craftsmanship** | **Tailored for terminal purists**. Native streaming rendering for Mermaid charts and LaTeX formulas, full syntax diffs, background activity preview strips, input queueing, and pure Readline keyboard flow. |
| 🔌 | **Open Ecosystem & Model Freedom** | **No platform lock-in**. Out-of-the-box support for DeepSeek, OpenAI Codex browser OAuth, and local Ollama/vLLM endpoints; extensible via `AGENTS.md`, reusable Skills, and MCP servers. |
| ⚙️ | **Deterministic Automation & Issue Solving** | **From interactive terminal to headless workflows**. `kana exec` delivers versioned JSONL event streams and Goal-driven autonomous execution—powering custom automation and resolving repository issues end-to-end. |

## Use Kana

### 1. Interactive pairing in the TUI

Once your model is ready, launch Kana inside any project directory:

```bash
kana                          # Start an empty pairing session
kana "diagnose failing tests" # Launch directly with an initial task
kana resume                   # Interactively resume or prune saved sessions
kana --clean                  # Launch an ephemeral, unsaved session
```

Inside the TUI, everything flows naturally through pure keyboard shortcuts and visible cues:
- Type `/` to open the **command palette** (`/model` to switch models, `/memory` to inspect memory, `/tools` for call history, `/goal` for bounded objectives);
- Type `:` to open the **reusable prompt template palette** to expand distilled workflows instantly;
- Type `@` to open the **Skill palette** and inject specialized guidance on demand;
- Type `!<command>` to run local shell commands directly outside the agent loop;
- **Non-blocking parallelism**: Active subagents and background jobs stream in the `Background · N` strip, while tasks delegated back to you appear in `Your tasks`, keeping your main flow uninterrupted.

See [TUI interaction](docs/tui.md) for shortcuts, queued inputs, and complete controls.

### 2. Self-evolution: Memory, prompts, and specialized subagents

Kana shapes itself around your habits as you work:

- **Two-tier durable memory**: When correcting conventions or defining constraints, Kana records durable facts (inspect or consolidate anytime via `/memory`), retaining them across sessions separated by workspace and global scopes;
- **Reusable prompt templates**: Crystallize recurring routines into `~/.kana/prompts/<name>.md`, then trigger them instantly in the editor with `:<name>`;
- **Dedicated subagents**: Define focused role cards under `~/.kana/agents/<role>.md` with restricted tools or alternative models. The main agent spawns them asynchronously for deep audits or migrations while keeping the parent run responsive—auditable anytime via `/agents`.

See [Subagents](docs/subagents.md) and [Sessions and memory](docs/sessions-and-memory.md) for details.

### 3. Headless automation and scripting

`kana exec` exposes the exact same runtime to scripts and automated pipelines:

```bash
kana exec "fix failing tests and verify"
printf 'summarize this codebase' | kana exec
kana exec resume <session-id> "continue this task"
kana exec --goal "resolve issue #42 end-to-end"
kana exec --timeout 30m "refactor this module"
kana exec --json "profile bottlenecks"
```

Emits the final answer to stdout and progress to stderr by default; `--json` produces versioned JSONL event streams. Power custom automation, or resolve issues into Pull Requests end-to-end using the [Kana Agent reusable workflow](docs/kana-agent-workflow.md). See [Headless execution](docs/headless.md).

### 4. Extensibility: Skills and MCP

Install curated skills or sync them across other agent environments:

```bash
kana skills install
kana skills sync codex                               # Sync to Codex
kana skills sync --target-dir ~/.other-agent/skills  # Sync to any third-party agent
```

Kana auto-discovers project skills from `.kana/skills` and `.agents/skills`, reads project instructions from `AGENTS.md`, and connects to stdio or remote MCP servers. See [Configuration and installation](docs/configuration.md).

## Updates and source install

### Check and self-update

Installed release binaries can update themselves directly:

```bash
kana update --check
kana update
```

### Install from source

Building from source requires [Bun](https://bun.sh) and Git:

```bash
git clone https://github.com/longyijdos/kana.git
cd kana
bun install --frozen-lockfile
./scripts/install.sh
```

## Security and trust boundaries

Kana respects your local environment while keeping its boundaries transparent:

- **Approvals are not a sandbox**: Built-in tools and `bash` execute directly in your host environment. File tools can inspect paths outside the workspace, and shell commands run with your user privileges; never skip approvals in untrusted codebases.
- **Pre-execution MCP trust**: Stdio MCP servers spawn as local subprocesses before individual tool approvals; configure only trusted server binaries.
- **Local sensitive data**: Configurations, credentials, logs, and sessions live under `~/.kana/` (configurable via `KANA_HOME`) with restricted permissions. Sessions contain full execution history and should be treated as private data.

See [Configuration and installation](docs/configuration.md) for the complete security model.

## Documentation

See the [Documentation index](docs/README.md) for architectural contracts, document sets, and routing guidance.

- **Architecture & Setup**: [Architecture](docs/architecture.md) · [Configuration and installation](docs/configuration.md) · [Release process](docs/releasing.md)
- **Core Runtime**: [Conversation runtime](docs/conversation-runtime.md) · [Agent runtime](docs/agent-runtime.md) · [Tools and execution](docs/tools.md) · [Sessions and memory](docs/sessions-and-memory.md)
- **Models & Extensions**: [Providers](docs/providers.md) · [DeepSeek](docs/deepseek-provider.md) · [OpenAI Codex](docs/openai-codex-provider.md) · [Custom provider](docs/custom-provider.md) · [OAuth](docs/oauth.md) · [MCP](docs/mcp.md) · [Skills & system prompt](docs/skills-and-prompt.md) · [Subagents](docs/subagents.md)
- **Frontend & Workflows**: [TUI interaction](docs/tui.md) · [Terminal rendering](docs/terminal-rendering.md) · [Headless execution](docs/headless.md) · [Kana Agent workflow](docs/kana-agent-workflow.md) · [Terminal-Bench evaluation](docs/terminal-bench.md)

## Development

Build from source and run the full verification suite:

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` runs Biome, TypeScript type checks, project style constraints, Knip dead-code analysis, and the Bun test suite.

Kana is actively evolving toward `1.0`; see the [Release process](docs/releasing.md) for versioning details. Contributions are warmly welcomed:
- **For human contributors**: Consult [CONTRIBUTING.md](CONTRIBUTING.md) for PR guidelines and development workflows;
- **For coding agents**: Consult [AGENTS.md](AGENTS.md) for agent-specific constraints and context.

## License

[MIT](LICENSE)
