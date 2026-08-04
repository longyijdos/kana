<p align="center">
  <img src="assets/kana-logo.svg" width="156" alt="Kana logo">
</p>

<h1 align="center">Kana</h1>

<p align="center">
  <strong>不是又一层 SDK 胶水：4 个直接运行时依赖，核心链路全部手搓。</strong><br>
  Agent loop、TUI、MCP/OAuth、Provider 流式适配和会话系统，都在这个仓库里。
</p>

<p align="center">
  中文 · <a href="README.en.md">English</a>
</p>

Kana 是一个本地优先、终端原生的个人 Agent 运行时。它没有把多个上游 SDK 包进一个命令行壳，而是直接实现从模型流到工具调度、从终端输入到差量渲染、从 MCP 传输到会话恢复的完整链路。

界面、二进制和持久化数据都在本地。模型请求会发送到你选择的供应商，目前支持 DeepSeek API 和通过浏览器 OAuth 登录的 OpenAI Codex。

## 极少依赖，核心手搓

Kana 只有 4 个直接运行时依赖。没有 Agent 框架，没有 TUI 框架，也没有 MCP、OAuth 或模型供应商 SDK。Kana 自己实现了：

- **Agent runtime**：消息协议、模型—工具循环、安全并行、deadline、取消、上下文压缩和生命周期事件。
- **Terminal UI**：raw terminal 生命周期、键盘协议、编辑器、焦点管理、Markdown/表格渲染和差量重绘。
- **Protocol stack**：MCP JSON-RPC、stdio、Streamable HTTP、SSE、OAuth 2.0/OIDC discovery 与 PKCE。
- **Provider adapters**：DeepSeek 与 OpenAI Codex 的请求转换、流式解析、重试、用量和上下文错误恢复。
- **Local state**：增量 JSONL turn journal、中断恢复、会话分叉、长期记忆、日志和用量账本。

这不是为了数字好看的“零依赖”挑战。Kana 会使用成熟的小型基础库，但把决定产品行为、可靠性和安全边界的代码留在自己手里：能读、能改、能调试，也不会被某个 Agent SDK 的抽象限制住。

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 终端原生 TUI | 自研终端运行时，提供流式 Markdown、语法高亮、响应式表格、多行编辑器、工具进度与审批。 |
| 完整 Agent 运行时 | 自研多轮模型—工具循环，支持安全并行工具、deadline、取消、自动上下文压缩与用量统计。 |
| 本地工具 | 内置目录浏览、glob、grep、文件读写与编辑、shell、长期记忆和进程内定时唤醒。 |
| MCP | 自研 client 与 transport，支持 stdio、Streamable HTTP、OAuth 2.0、逐服务器代理、工具筛选和运行时启停。 |
| 会话与记忆 | 按工作区保存可恢复、可分叉的 JSONL 会话；提供 project/global 两级长期记忆和自动合并。 |
| Skills 与项目指令 | 发现全局及项目 Skills，读取 `AGENTS.md`，并可把 Kana Skills 同步到 Codex 或其他 Agent。 |
| 自动化接口 | `kana exec` 提供适合脚本、CI 和评测的单次运行，以及版本化 JSONL 事件协议。 |
| 模型供应商 | 支持 DeepSeek API 与 OpenAI Codex OAuth，可在 TUI 中切换供应商、模型和推理强度。 |

## 快速开始

### 安装预编译版本

安装器支持 macOS 和 Linux 的 arm64、x64。它会下载并校验最新 Release，将 `kana` 安装到 `~/.local/bin`，然后初始化缺失的本地支持文件。

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
```

如需安装指定版本或目录，可使用 `KANA_VERSION` 和 `KANA_INSTALL_DIR`。完整选项见[配置与安装](docs/configuration.md)。

### 选择模型供应商

DeepSeek 是默认供应商。设置 API key 后即可启动：

```bash
export DEEPSEEK_API_KEY="sk-..."
kana
```

如需使用 OpenAI Codex，先完成浏览器授权：

```bash
kana auth login openai-codex
```

然后在 `~/.kana/config.toml` 中选择供应商；未写出的字段继续使用内置默认值：

```toml
[provider]
active = "openai-codex"

[model.openai-codex]
name = "gpt-5.6-sol"
```

授权方式、模型和 reasoning 配置见 [OpenAI Codex 提供商](docs/openai-codex-provider.md)。

### 从源码安装

需要 Bun 和 Git：

```bash
git clone https://github.com/longyijdos/kana.git
cd kana
bun install --frozen-lockfile
./scripts/install.sh
```

## 使用 Kana

### 交互式 TUI

```bash
# 打开空会话
kana

# 直接发送第一条任务
kana "分析这个仓库并修复失败的测试"

# 恢复指定会话；省略 ID 时打开选择器
kana resume [session-id]

# 打开不保存记录的临时会话
kana --clean
```

`--clean` 创建随进程退出即丢弃的临时会话，不写 session journal、运行时日志或 accounting，也不加载自定义指令、记忆、Skills 与 MCP。它仍读取 `.env`、模型与运行配置、认证和审批规则；状态栏会持续显示 `clean`。该模式不能与 `resume` 组合，也不是文件或进程沙箱：内置工具、provider 和本地 shell 仍可能产生外部副作用。Clean 模式中的 `/model` 只影响当前进程。

常用交互：

| 命令或按键 | 作用 |
| --- | --- |
| `/help` | 查看全部命令和快捷键。 |
| `/new`、`/resume`、`/fork <任务>` | 新建、恢复或分叉会话。 |
| `/model` | 切换供应商、模型和推理强度。 |
| `/mcp` | 启用、停用或重新加载已配置的 MCP server。 |
| `/skills` | 管理当前启用的全局 Skills。 |
| `/memory` | 查看或整理 project/global 长期记忆。 |
| `/usage` | 查看当前会话、项目或全局用量。 |
| `!<命令>` | 绕过 Agent，直接运行本地 shell 命令。 |
| `Ctrl+O` | 展开最近一项可查看的工具输出。 |
| `Ctrl+C` / `Esc` | 中止当前工作、关闭视图或退出。 |

Clean 模式下 `/fork`、`/resume`、`/delete` 和 `/usage` 的 Session 范围不可用；Project 与 Global 用量仍可查看。

完整交互说明见 [TUI 交互与渲染](docs/tui.md)。

### 无头执行

`kana exec` 使用与 TUI 相同的运行时，但在一个完整 Agent turn 后退出：

```bash
kana exec "修复失败的测试"
printf '总结这个仓库' | kana exec
kana exec resume <session-id> "继续完成任务"
kana exec --clean "使用内置 Agent 能力分析项目"
```

默认只把最终回答写到 stdout，进度写到 stderr。机器调用方可使用版本化 JSONL：

```bash
kana exec --json "分析当前项目"
```

`--allow-all-tools` 会无条件授权 Agent 执行所有可用工具。它不会隔离文件或进程，只应在受控环境中使用。协议、事件和退出码见[无头执行与 JSONL 协议](docs/headless.md)。

### Skills 与 MCP

安装或更新默认 Skills 仓库：

```bash
kana skills install
```

已安装的 Kana Skills 还可同步到 Codex：

```bash
kana skills sync codex
```

MCP server 定义保存在 `~/.kana/mcp.json`，启用状态保存在 `~/.kana/mcp-enabled.json`。Kana 支持本地 stdio server 和远端 Streamable HTTP server；在 TUI 中使用 `/mcp` 管理连接。配置格式、OAuth 和代理选项见[配置与安装](docs/configuration.md#mcpjson-与-mcp-enabledjson)。

### 更新

独立二进制可以检查并原子更新自身：

```bash
kana update --check
kana update
```

## 内置工具

| 工具 | 用途 |
| --- | --- |
| `list` | 列出目录的一层内容。 |
| `glob` | 按 glob pattern 查找路径。 |
| `grep` | 用正则或字面量搜索文本。 |
| `read` | 分页读取 UTF-8 文件。 |
| `write` | 创建文件，或显式覆盖已有文件。 |
| `edit` | 对已有文件执行精确文本替换。 |
| `bash` | 运行 shell 命令并流式返回输出。 |
| `remember` | 把信息写入 project 或 global 记忆。 |
| `schedule_wake` | 在当前 Kana 进程中安排后续 Agent 输入。 |

读操作和受信任的 shell 命令可按配置直接执行；有副作用的工具通常会进入审批。详细参数和执行语义见 [Agent 与工具执行协议](docs/agent-and-tools.md)。

## 本地数据与安全边界

Kana 默认把配置、OAuth 凭据、会话、日志、记忆和 Skills 保存在 `~/.kana/`；可通过 `KANA_HOME` 改变位置。

- 模型请求会把必要的对话、系统提示词和工具定义发送到当前供应商。
- 会话文件包含完整对话和工具结果，应视为敏感数据；OAuth token 依靠本地文件权限保护。
- 工具审批是交互确认机制，不是文件系统或进程沙箱。内置文件工具可访问工作区以外的路径，`bash` 也会执行真实命令。
- stdio MCP server 会在工具审批前启动，因此只应配置可信程序；远端 MCP endpoint 同样属于信任边界。
- `!<命令>` 是用户直接发起的本地 shell，不经过 Agent 工具审批。

更完整的文件布局、审批模式和凭据说明见[配置与安装](docs/configuration.md)。

## 文档

- [开发文档索引](docs/README.md)
- [架构总览](docs/architecture.md)
- [配置与安装](docs/configuration.md)
- [Agent 与工具执行协议](docs/agent-and-tools.md)
- [会话与记忆](docs/sessions-and-memory.md)
- [Skills 与系统提示词](docs/skills-and-prompt.md)
- [DeepSeek 提供商](docs/deepseek-provider.md)
- [OpenAI Codex 提供商](docs/openai-codex-provider.md)
- [无头执行与 JSONL 协议](docs/headless.md)
- [Terminal-Bench 本地评测](docs/terminal-bench.md)
- [TUI 交互与渲染](docs/tui.md)

## 开发

```bash
bun install --frozen-lockfile
bun src/main.ts
bun run check
```

Kana 仍处于 `1.0` 之前的快速迭代阶段，CLI、协议和持久化格式可能随次版本演进。提交代码前请阅读 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
