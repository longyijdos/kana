<p align="center">
  <img src="assets/kana-logo.svg" width="156" alt="Kana logo">
</p>

<h1 align="center">Kana</h1>

<p align="center">
  <strong>轻量、纯粹、越用越懂你的终端 AI 搭档。</strong><br>
  单二进制即刻启动，零遥测恪守本地边界。透明结对拒绝黑盒盲等，持久记忆终结失忆轮回，更可沉淀专属模板与子角色——让终端智能随你一同进化。
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
  <img src="assets/kana-demo.gif" alt="Kana 在修复超时问题时向用户委派任务，并验证修复结果">
</p>

Kana 是一个开源、单二进制的终端原生 AI Agent，专为编程、系统运维与各类工具驱动的高效工作流而生。无论是在沉浸专注的交互式 TUI 中，还是在面向自动化与 CI 的 `kana exec` 无头运行中，Kana 都能提供毫秒级冷启的丝滑体验。

与冷冰冰的黑盒脚本不同，Kana 是一位能够与你**并肩自进化**的深度搭档：

- **透明结对，并肩成长**：告别黑盒转圈与盲目等待。推理脉络、实时 diff 与工具调用全程透明可溯，它不仅能主动与你分工推进复杂任务，更在推导演进中带你洞悉代码脉络与系统底层，把被动等待转化为掌控感十足的人机结对；
- **持久记忆，内化默契**：终结每次开启新对话都得重新交代的“失忆轮回”。借助工作区与全局双层记忆网络，它会自动提炼并沉淀你的架构习惯、业务边界与历史踩坑，将过去的每一次纠偏转化为自然直觉，让智能真正随时间累积；
- **能力闭环，随你演进**：它不仅被动听令，更能随着工作流演进将常用操作转化为专用的 `:prompt` 快捷模板，甚至能为复杂的特定场景编写专职的 **Subagent 角色卡**——随着日常使用，整套系统都在为你量身自我塑形。

**纯粹、克制、恪守边界。** Kana 绝不收集任何遥测。在正常执行期间，网络交互仅限于你配置的大模型提供商与 MCP 服务；仅在检查更新、浏览器认证或安装 Skills 等显式功能时才会访问对应服务。你的配置、会话、记忆、日志与产物完全封存于本地——你的终端，由你绝对掌控。

## 快速开始

单二进制随处运行，无需 Node.js、Python 或任何额外环境依赖。预编译版本支持 macOS 与 Linux（arm64 / x64）：

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
```

### 1. 默认即刻起步（DeepSeek）

无需注册额外账号，注入 API Key 即可在任意工作目录开启专注交互：

```bash
export DEEPSEEK_API_KEY="sk-..."
cd your-project
kana
```

### 2. 或是使用 OpenAI Codex

直接通过网页授权，免手动配置 token：

```bash
kana auth login openai-codex
```

在 `~/.kana/config.toml` 中配置默认模型，或在进入 TUI 后随时按 `/model` 快速切换：

```toml
[agent.model]
provider = "openai-codex"
name = "gpt-5.6-sol"
```

进入终端后，随时可通过 `/model` 切换供应商、模型及推理强度；若使用本地 Ollama / vLLM 或私有网关，可直接连接[自定义兼容服务](docs/custom-provider.zh-CN.md)。

## 为什么选择 Kana

| | 核心能力 | 为什么与众不同 |
| --- | --- | --- |
| 🧠 | **持久记忆，内化默契** | **拒绝每次失忆从头交代**。工作区与全局双层持久记忆，自动在后台提炼合并你的架构偏好、代码约定与历史踩坑，跨会话将纠偏经验化为长期直觉。 |
| 🤝 | **透明结对，双向协作** | **告别黑盒盲等与提线木偶**。流式推理思维链与语法高亮 diff 全程透明可溯；支持反向委派任务，复杂长流程中人机并行分工推进、共同成长。 |
| 🧬 | **能力闭环，随你演进** | **越用越契合你的专属系统**。随着工作流演化将常用操作沉淀为 `:prompt` 快捷模板，甚至能为特定复杂场景编写专职的 Markdown Subagent 角色卡，实现能力自我塑形。 |
| 🛡️ | **零遥测，本地绝对主权** | **纯净单二进制，毫秒冷启**。绝无遥测暗流，常规网络请求仅发往模型与自选 MCP；配置、会话与产物严格以 `0600`/`0700` 权限封存于本地。 |
| ⌨️ | **终端原生的极致工程美学** | **为终端重度用户量身打造**。终端内原生流式渲染 Mermaid 架构图与 LaTeX 公式，全套语法高亮 diff、后台任务并行预览条、输入排队与 Readline 风格纯键盘流操作。 |
| 🔌 | **开放生态与模型自由** | **不绑死任何平台**。开箱支持 DeepSeek API、OpenAI Codex 浏览器无缝授权与本地 Ollama / vLLM 自定义网关；支持 `AGENTS.md`、可复用 Skills 与 MCP 协议扩展。 |
| ⚙️ | **确定性自动化与 Issue 解决** | **从交互终端到无头脚本无缝迁移**。`kana exec` 提供结构化 JSONL 事件流与 Goal 目标驱动执行，轻松融入自定义脚本与自动化流程，甚至端到端自主分析并解决仓库 Issue。 |

## 使用 Kana

### 1. 沉浸式终端交互（TUI）

完成模型准备后，可在任意项目目录直接启动：

```bash
kana                          # 开启空白结对会话
kana "排查单元测试失败的原因"   # 带着初始任务直接启动
kana resume                   # 交互式选择或删除历史会话
kana --clean                  # 启动不落盘的临时纯净会话
```

在 TUI 中，所有操作均遵循纯键盘流与直观的可视化反馈：
- 输入 `/` 快速调出**内置命令面板**（`/model` 换模型、`/memory` 查看整理记忆、`/tools` 检查调用历史、`/goal` 设定阶段性目标）；
- 输入 `:` 调出**可复用 Prompt 模板面板**，一键展开沉淀的高频指令；
- 输入 `@` 调出 **Skill 技能面板**，按需加载特定工作流；
- 敲击 `!<命令>` 直接在当前终端执行本地 Shell 命令；
- **多任务并行不卡顿**：异步派发的 Subagent 与后台任务会呈现在 `Background · N` 预览条中；反向委派给你的并行小任务则会在 `Your tasks` 预览，互不阻塞。

快捷键、流式文本控制与完整交互细节见 [TUI 交互](docs/tui.zh-CN.md)。

### 2. 闭环自进化：记忆、模板与专职 Subagent

Kana 不仅执行指令，更会随着日常使用自我塑形：

- **双层持久记忆**：在对话中纠偏或交代背景后，Kana 会调用记忆机制（亦可输入 `/memory` 查看或手动整理），自动把架构约定与习惯分别沉淀到工作区（Project）和全局（Global）长期记忆中，跨会话永不遗忘；
- **高频模板沉淀**：将重复出现的繁琐工作流写进 `~/.kana/prompts/<name>.md`，在终端输入 `:<name>` 即可光速调用；
- **专职 Subagent 特化**：在 `~/.kana/agents/<role>.md` 中定义精简角色卡（限定只读/特定工具或切换更轻量的模型）。主 Agent 可在复杂流程中异步唤起子 Agent 协助审查或排障，并在 `/agents` 面板中实时审计与管理。

角色卡规范见 [Subagent](docs/subagents.zh-CN.md)，记忆模型见[会话与记忆](docs/sessions-and-memory.zh-CN.md)。

### 3. 无头脚本与确定性自动化

`kana exec` 提供完全相同的底层能力，专为批处理脚本与端到端任务而生：

```bash
kana exec "修复失败的测试并验证"
printf '总结当前项目的架构核心' | kana exec
kana exec resume <session-id> "继续推进任务"
kana exec --goal "端到端排查并解决 issue #42"
kana exec --timeout 30m "重构当前模块"
kana exec --json "分析性能瓶颈"
```

默认将最终结果输出至 stdout、将执行过程输出至 stderr；`--json` 输出严格的版本化 JSONL 事件流。可直接融入本地自动化工作流，或通过 [Kana Agent 可复用工作流](docs/kana-agent-workflow.zh-CN.md)实现从 Issue 到 Pull Request 的端到端自主修复。详见[无头执行与 JSONL 协议](docs/headless.zh-CN.md)。

### 4. 扩展生态：Skills 与 MCP

安装官方精选 Skills 仓库，或一键同步给其他 Agent：

```bash
kana skills install
kana skills sync codex                               # 同步至 Codex
kana skills sync --target-dir ~/.other-agent/skills  # 同步至任意第三方 Agent
```

Kana 会自动从 `.kana/skills` 和 `.agents/skills` 发现项目私有 Skills，从 `AGENTS.md` 读取项目指令，并无缝挂载本地 stdio 或远端 MCP server。详见[配置与安装](docs/configuration.zh-CN.md)。

## 更新与源码构建

### 检查与自更新

已安装的预编译版本支持一键自更新：

```bash
kana update --check
kana update
```

### 从源码安装

从源码构建仅需 [Bun](https://bun.sh) 与 Git：

```bash
git clone https://github.com/longyijdos/kana.git
cd kana
bun install --frozen-lockfile
./scripts/install.sh
```

## 安全与信任边界

Kana 崇尚对本地环境的绝对尊重，同时也向你明确其能力边界：

- **交互审批不是环境沙箱**：内置工具与 `bash` 直接运行在你的宿主环境中，文件工具可按需访问工作区外部路径，`bash` 执行真实系统命令；请勿在未受信任的代码环境中跳过审批。
- **扩展进程的信任前置**：stdio 类型的 MCP 服务会在工具审批前作为子进程启动，请仅配置你完全信任的本地程序。
- **本地敏感数据管理**：所有配置、凭据、日志与会话均以受限权限保存在 `~/.kana/`（可通过 `KANA_HOME` 覆盖）；会话记录中包含完整对话与工具输入输出，应视同敏感数据妥善保管。

完整安全与凭据架构见[配置与安装](docs/configuration.zh-CN.md)。

## 文档

完整的文档索引、设计契约与修改路由见 [文档索引](docs/README.zh-CN.md)。

- **架构与配置**：[架构总览](docs/architecture.zh-CN.md) · [配置与安装](docs/configuration.zh-CN.md) · [发版流程](docs/releasing.zh-CN.md)
- **核心运行时**：[对话运行时](docs/conversation-runtime.zh-CN.md) · [Agent 运行时](docs/agent-runtime.zh-CN.md) · [工具与执行](docs/tools.zh-CN.md) · [会话与记忆](docs/sessions-and-memory.zh-CN.md)
- **模型与扩展**：[供应商总览](docs/providers.zh-CN.md) · [DeepSeek](docs/deepseek-provider.zh-CN.md) · [OpenAI Codex](docs/openai-codex-provider.zh-CN.md) · [自定义兼容网关](docs/custom-provider.zh-CN.md) · [OAuth](docs/oauth.zh-CN.md) · [MCP](docs/mcp.zh-CN.md) · [Skills 与提示词](docs/skills-and-prompt.zh-CN.md) · [Subagent](docs/subagents.zh-CN.md)
- **前端与工程化**：[TUI 交互](docs/tui.zh-CN.md) · [终端渲染](docs/terminal-rendering.zh-CN.md) · [无头执行](docs/headless.zh-CN.md) · [Kana Agent 工作流](docs/kana-agent-workflow.zh-CN.md) · [Terminal-Bench 评测](docs/terminal-bench.zh-CN.md)

## 参与开发

从源码构建与运行完整测试门禁：

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` 会依次执行代码格式化、类型检查、代码规范约束与全量单元测试。

Kana 仍处于 `1.0` 之前的快速迭代期，版本策略见[发版流程](docs/releasing.zh-CN.md)。我们热忱欢迎开源贡献：
- **人类开发者**：请查阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解 PR 准备流程与代码规范；
- **AI 编码 Agent**：面向代码生成 Agent 的专用规范与上下文约束请参考 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
