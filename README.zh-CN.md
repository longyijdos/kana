<p align="center">
  <img src="assets/kana-logo.svg" width="156" alt="Kana logo">
</p>

<h1 align="center">Kana</h1>

<p align="center">
  <strong>一个直接在仓库中工作的本地优先终端 AI Agent。</strong><br>
  分析代码、编辑文件、执行命令，并在多次会话之间延续上下文——支持 DeepSeek 与 OpenAI Codex。
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文
</p>

<p align="center">
  <a href="https://github.com/longyijdos/kana/releases/latest"><img src="https://img.shields.io/github/v/release/longyijdos/kana" alt="最新版本"></a>
  <a href="https://github.com/longyijdos/kana/actions/workflows/ci.yml"><img src="https://github.com/longyijdos/kana/actions/workflows/ci.yml/badge.svg" alt="CI 状态"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/longyijdos/kana" alt="MIT 许可证"></a>
</p>

<p align="center">
  <img src="assets/kana-demo.gif" alt="Kana 分析仓库、修复失败测试并验证结果">
</p>

Kana 是一个开源、终端原生的 Agent，面向编程和其他由工具驱动的工作。交互式 TUI 把推理、工具调用、审批、diff 和结果放在同一个专注界面中；`kana exec` 则把相同的运行时能力带到脚本与 CI。

配置、会话、记忆、日志和用量记录都保存在本机；模型请求只会发送给你选择的供应商。

## 快速开始

预编译版本支持 macOS 与 Linux 的 arm64、x64：

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
```

DeepSeek 是默认供应商。设置 API key，然后在项目目录中启动 Kana：

```bash
export DEEPSEEK_API_KEY="sk-..."
cd your-project
kana
```

如果更喜欢 OpenAI Codex，可先完成浏览器授权，再在 `~/.kana/config.toml` 中选择它：

```bash
kana auth login openai-codex
```

```toml
[provider]
active = "openai-codex"
```

之后可随时通过 `/model` 切换供应商、模型和推理强度。

## 为什么选择 Kana

| | 能力 | 你能得到什么 |
| --- | --- | --- |
| 🛠️ | 直接在仓库中工作 | 内置文件搜索、读取、写入、编辑和 Shell 工具，并提供可见进度与审批。 |
| 🧠 | 在多次工作间延续上下文 | 可恢复、可分叉的会话，中断恢复，自动上下文压缩，以及 project/global 两级长期记忆。 |
| 🔌 | 接入自己的工具 | 通过 `AGENTS.md` 提供项目指令，使用可复用 Skills，并通过 stdio 或带 OAuth 的 Streamable HTTP 连接 MCP server。 |
| 🤖 | 自由选择模型 | 支持 DeepSeek API 与 OpenAI Codex OAuth、运行时模型切换、可配置推理强度和 Codex 托管网页搜索。 |
| ⌨️ | 始终留在终端 | 自研 TUI 提供流式 Markdown、语法高亮 diff、输入排队、定时消息、通知和终端超链接。 |
| ⚙️ | 自动化同一套运行时 | 一次性或可恢复的 `kana exec`，以及适用于脚本、CI 和评测的版本化 JSONL 事件流。 |

## 核心链路自研，而不是 SDK 外壳

Kana 把关键行为留在这个仓库中，而不是交给上游 Agent 框架。它没有使用 Agent、TUI、MCP、OAuth 或模型供应商 SDK，而是自行实现：

- **Agent runtime**：模型—工具循环、并行工具调度、deadline、取消、上下文压缩、生命周期事件和用量统计。
- **Terminal UI**：raw terminal 生命周期、输入处理、流式 Markdown、语法高亮、响应式表格和差量渲染。
- **Protocol stack**：MCP JSON-RPC、stdio、Streamable HTTP、SSE、OAuth 2.0/OIDC discovery 与 PKCE。
- **Provider adapters**：DeepSeek 与 OpenAI Codex 的请求转换、流式传输、重试、用量和上下文错误恢复。
- **Local state**：增量会话日志、中断恢复、会话分叉、长期记忆、运行日志和用量账本。

目标不是追求“零依赖”。Kana 会在合适的地方使用专注的小型库，同时把决定可靠性、安全边界和用户体验的行为保持为可读、可改的本地代码。

## 使用 Kana

### 交互式会话

```bash
kana                                      # 打开空会话
kana "分析这个仓库"                       # 直接发送第一条任务
kana resume                               # 选择已保存的会话
kana resume <session-id>                  # 恢复指定会话
kana --clean                              # 打开不保存的临时会话
```

TUI 中的常用命令：

| 命令 | 作用 |
| --- | --- |
| `/model` | 切换供应商、模型和推理强度。 |
| `/resume`、`/fork <任务>` | 恢复旧会话，或从当前上下文分叉。 |
| `/mcp`、`/skills` | 管理当前启用的 MCP server 和全局 Skills。 |
| `/memory` | 查看或整理 project/global 长期记忆。 |
| `/approval` | 临时修改当前会话的工具审批模式。 |
| `/usage` | 查看 session、project 或 global 范围的 token 用量。 |
| `!<命令>` | 绕过 Agent loop，直接运行本地 Shell。 |

快捷键、输入排队、定时消息和完整命令集见 [TUI 交互与渲染](docs/tui.zh-CN.md)。

### 无头自动化

```bash
kana exec "修复失败的测试"
printf '总结这个仓库' | kana exec
kana exec resume <session-id> "继续完成任务"
kana exec --json "分析当前项目"
```

默认只把最终回答写到 stdout，进度写到 stderr。`--json` 会输出版本化 JSONL 事件。`--allow-all-tools` 可在受控自动化环境中跳过交互审批，但不会提供沙箱。

事件结构和退出码见[无头执行与 JSONL 协议](docs/headless.zh-CN.md)。

### Skills 与 MCP

安装或更新默认 Skills 仓库，并按需把 Skills 分享给 Codex：

```bash
kana skills install
kana skills sync codex
```

Kana 会从 `.kana/skills` 和 `.agents/skills` 发现项目 Skills，从 `AGENTS.md` 读取项目指令，并可连接本地或远端 MCP server。MCP 定义和启用状态保存在 `~/.kana/` 下；TUI 支持运行时选择 server 和完成 OAuth 流程。

MCP schema、代理、OAuth、审批及完整配置项见[配置与安装](docs/configuration.zh-CN.md)。

## 从源码安装

从源码构建需要 Bun 和 Git：

```bash
git clone https://github.com/longyijdos/kana.git
cd kana
bun install --frozen-lockfile
./scripts/install.sh
```

已安装的 Release 二进制可以自行更新：

```bash
kana update --check
kana update
```

## 本地优先与信任边界

- Kana 默认把配置、OAuth 凭据、会话、日志、记忆和用量数据保存在 `~/.kana/`；可通过 `KANA_HOME` 更改位置。
- 模型请求会向当前供应商发送完成对话所需的上下文与工具定义。
- 工具审批是确认层，不是文件系统或进程沙箱。文件工具可以访问工作区之外的路径，`bash` 会执行真实命令。
- stdio MCP server 会在单次工具审批前启动，因此只应配置可信程序。
- 会话文件包含完整对话和工具结果，应视为敏感数据。

完整安全与凭据模型见[配置与安装](docs/configuration.zh-CN.md)。

## 文档

- [文档索引](docs/README.zh-CN.md)
- [架构总览](docs/architecture.zh-CN.md)
- [Agent 与工具执行](docs/agent-and-tools.zh-CN.md)
- [会话与记忆](docs/sessions-and-memory.zh-CN.md)
- [Skills 与系统提示词](docs/skills-and-prompt.zh-CN.md)
- [DeepSeek 提供商](docs/deepseek-provider.zh-CN.md)
- [OpenAI Codex 提供商](docs/openai-codex-provider.zh-CN.md)
- [Terminal-Bench 评测](docs/terminal-bench.zh-CN.md)

## 开发

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` 会依次运行 Biome、TypeScript、Knip 死代码分析和 Bun 测试。需要主动清理未使用的
导出或依赖时，应单独运行 `bun run knip:fix`，并在提交前审阅它产生的修改。

Kana 仍处于 `1.0` 前的快速开发阶段，CLI 行为、协议和持久化格式可能随次版本演进。贡献前请阅读 [AGENTS.md](AGENTS.md)，版本与发布细节见[发版流程](docs/releasing.zh-CN.md)。

## 许可证

[MIT](LICENSE)
