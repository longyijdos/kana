<h1 align="center">Kana</h1>

<p align="center">
  <img src="assets/kana-logo.svg" alt="Kana logo">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/typescript-%5E6.0-3178C6?logo=typescript" alt="typescript">
  <img src="https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun" alt="bun">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

一个跑在终端里的通用 AI Agent。不需要 VS Code 插件或网页 UI：打开终端，直接对话。它能处理本地文件、运行 shell、维护长期记忆，并通过 Skills 扩展信息检索、内容创作和本地服务操作；工具调用、输出与审批都显示在终端中。

Kana 的界面、二进制和数据都在本地，但模型请求会发送到配置的 DeepSeek API。默认配置使用 `DEEPSEEK_API_KEY`。

## 为什么选 Kana

大多数 AI 工具长得都差不多——聊天框、侧边栏、网页 UI。Kana 不玩这套。

- **100% 终端原生** — 自研 TUI 框架，不是 Electron 套壳，不是浏览器包装。就是你的终端，就是你敲命令的地方。
- **你拥有运行时** — `bun build` 可编译为单文件二进制；会话、记忆、日志和配置默认都保存在 `~/.kana/`。
- **过程透明** — Markdown 渲染、语法高亮、流式输出、思考过程可见。没有加载动画忽悠你，每一步都看得见。

## 安装与启动

预编译安装器支持 macOS 和 Linux 的 arm64、x64。它会下载校验过的二进制、安装到 `~/.local/bin`，并创建默认配置。

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
export DEEPSEEK_API_KEY="sk-..."
kana
```

如果 `~/.local/bin` 不在 `PATH` 中，安装器会提示你如何添加。安装后也可直接带着首条任务启动：

```bash
kana "修复当前项目的测试"
```

从源码构建需要 Bun 和 Git：

```bash
git clone https://github.com/longyijdos/kana.git && cd kana
bun install && ./scripts/install.sh
```

可选安装默认 Skills：

```bash
kana install --skills
```

更多安装选项、配置字段与审批模式见[配置与安装文档](docs/configuration.md)和[English version](docs/configuration.en.md)。

## 内置工具

| | |
|---|---|
| 🔧 `bash` | 运行命令，实时显示 stdout/stderr |
| 📖 `read` | 读取文件，支持分页 |
| ✏️ `edit` | 精确替换文件中的指定文本 |
| 📝 `write` | 创建新文件 |
| 🧠 `remember` | 保存可跨会话使用的长期信息 |
| ⏰ `schedule_wake` | 在当前进程中定时唤起 Agent |

默认情况下，读文件和受信任的只读 shell 命令可直接执行；写文件与其他 shell 命令会在终端请求确认。你可以在配置中收紧、放宽或关闭审批。

## 会话、记忆与 Skills

- 会话持久化在本地，可用 `/resume` 恢复，或用 `/fork <任务>` 从当前对话分叉。
- Agent 可通过 `remember` 保存长期信息；使用 `/memory show` 查看，或用 `/memory compact` 整理。
- 项目根目录的 `AGENTS.md` 会自动注入每次对话；`~/.kana/AGENTS.md` 可提供全局指令。
- 使用 `/skills` 管理已安装的全局 Skills；项目内 `.kana/skills` 和 `.agents/skills` 会自动启用。
- `/usage` 可查看当前会话、项目或全局的 token 用量与费用。

默认 [Kana Skills 仓库](https://github.com/longyijdos/kana-skills)包含网页搜索与正文提取、内容创作、媒体与平台操作等工作流。每项 Skill 都声明了自己的依赖与授权边界；安装后按实际需求启用，不把它们当作默认可用的能力。

会话、记忆和 Skills 的完整行为见[开发文档索引](docs/README.md)（[English](docs/README.en.md)）。

## 常用命令与快捷键

| 操作 | 命令或按键 |
|---|---|
| 查看全部命令与快捷键 | `/help` |
| 新建、恢复、分叉会话 | `/new`、`/resume`、`/fork <任务>` |
| 删除会话 | `/delete` |
| 管理 Skills | `/skills` |
| 查看或整理记忆 | `/memory show`、`/memory compact` |
| 查看用量与费用 | `/usage` |
| 清空当前显示 | `/clear` |
| 退出 | `/quit` |
| 本地运行命令 | 以 `!` 开头 |
| 中断运行；空闲时退出 | `Ctrl+C` |
| 查看最近可展开的工具输出 | `Ctrl+O` |
| 关闭查看器或取消运行 | `Esc` |
