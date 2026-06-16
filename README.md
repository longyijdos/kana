<h1 align="center">kana</h1>

<p align="center">
  <img src="assets/kana-logo.svg" alt="kana logo">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/typescript-%5E6.0-3178C6?logo=typescript" alt="typescript">
  <img src="https://img.shields.io/badge/runtime-bun-f9f1e1?logo=bun" alt="bun">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
</p>

# kana

一个跑在你终端里的 AI 编程 Agent。不需要 VS Code 插件，不需要网页——打开终端，直接对话。它能读代码、跑 shell、写文件、改 bug，所有操作都在你眼皮底下完成。

## 为什么选 Kana

大多数 AI 编程工具长得都差不多——聊天框、侧边栏、网页 UI。Kana 不玩这套。

- **100% 终端原生** — 自研 TUI 框架，不是 Electron 套壳，不是浏览器包装。就是你的终端，就是你敲命令的地方。
- **你拥有运行时** — `bun build` 编译出的单文件二进制，没有云端依赖，数据全在 `~/.kana/`。
- **过程透明** — Markdown 渲染、语法高亮、流式输出、思考过程可见。没有加载动画忽悠你，每一步都看得见。

## 5 秒上手

```bash
git clone https://github.com/longyijdos/kana.git && cd kana
bun install && bun run build:cli
export DEEPSEEK_API_KEY="sk-..."
./kana install --skills && ./kana
```

或者装到全局：

```bash
bun run install:bin
kana "帮我重构这个模块"
```

## 内置工具

| | |
|---|---|
| 🔧 `bash` | 跑命令，实时看 stdout/stderr |
| 📖 `read` | 读文件，支持分页 |
| ✏️ `edit` | 精确替换文件里的指定文本 |
| 📝 `write` | 创建新文件 |

每次执行危险操作（比如 `rm -rf`），需要先确认——除非你把它加了白名单。

## 会话 & 自定义

会话持久化在本地，随时 `/resume` 切回去继续。项目根目录放一个 `AGENTS.md`，自动作为上下文注入到每次对话中。装上 Skills，还能扩展更多能力。

## TUI 快捷键

| 操作 | 按键 |
|------|------|
| 技能管理 | `/skills` |
| 会话切换 | `/resume` |
| 删除会话 | `/delete` |
| 退出 | `/quit` |
| 本地跑命令 | 以 `!` 开头 |
| 中断 Agent | `Ctrl+C` |

---

<p align="center">
  <sub>Built with TypeScript + Bun</sub>
</p>
