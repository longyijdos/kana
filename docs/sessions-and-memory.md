# 会话与记忆

Kana 将可恢复的对话历史与跨对话记忆分开存储：会话保存完整 `Message` 历史，记忆保存经压缩的长期参考信息。两者均按工作区隔离；全局记忆是唯一跨工作区的数据。

## 工作区标识

会话和 project 记忆共享相同的工作区编码：先将 `cwd` 转为绝对路径，去掉开头的路径分隔符，再把路径分隔符和 `:` 替换为 `-`，最后用 `--` 包裹。它是稳定的目录名，不是加密或安全边界。

```text
cwd: /Users/alice/project
  → --Users-alice-project--
```

因此同一解析后路径的会话和 project 记忆会放到相应的同名目录；不同路径相互隔离。

## 运行时日志

运行时日志使用同一工作区编码，路径为：

```text
<KANA_HOME>/logs/<encoded-workspace>/<session-id>.jsonl
```

每行是一个分级 JSON 记录，包含时间、级别、稳定事件名、session ID 和安全的元数据。session 是日志文件边界：恢复同一 session 会追加原文件，`/new`、`/fork` 或恢复另一 session 会写入新文件。日志不是会话历史，不保存 prompt、助手文本、完整工具参数或输出；其配置和级别见[配置与安装](configuration.md)。

## 会话

会话文件位于：

```text
<KANA_HOME>/sessions/<encoded-workspace>/<safe-created-at>_<uuid>.jsonl
```

创建会话只在内存中生成 UUID、创建时间、工作目录、可选模型元数据和可选父会话路径。文件在第一次有消息需要追加时才创建；空会话不会出现在 `/resume` 列表中。

### JSONL 格式

第一行是版本为 1 的 session header，后续每行是一条消息记录：

```json
{"type":"session","version":1,"id":"…","createdAt":"2026-06-22T…Z","title":"Fix parser","cwd":"/repo","model":{"provider":"deepseek","model":"deepseek-v4-pro"}}
{"type":"message","id":"…","parentId":null,"timestamp":"2026-06-22T…Z","message":{"role":"user","content":"Fix parser"}}
{"type":"message","id":"…","parentId":"…","timestamp":"2026-06-22T…Z","message":{"role":"assistant","content":[…],"stopReason":"stop"}}
```

每次追加会读取当前叶节点 ID，使新记录的 `parentId` 指向上一个消息记录。当前加载逻辑以文件顺序重建消息数组，不会根据 `parentId` 重放分支；该字段用于保存谱系信息。`/fork <prompt>` 创建新会话，并将源 session 文件路径写入 header 的 `parentSessionPath`。

首次写入时，标题优先使用显式标题；否则使用第一条用户消息，折叠所有空白并截断为最多 80 个 JavaScript 字符。没有可用文本时使用 `Untitled session`。

### 生命周期与容错

- Agent 的 `onRunCommitted` 只在 `agent_end` 后追加本轮的新消息，因此不会持久化仍在流式生成中的快照。
- 继续会话按当前工作目录查找；会话选择器同样只展示当前工作区的其他会话。
- `listKanaSessions()` 不限定 cwd 时会扫描所有工作区目录，并按 `createdAt` 降序排序。
- 列表读取到损坏 JSONL 时会跳过该文件，避免一条坏记录隐藏其他历史；显式加载该会话仍会报错。
- 删除按 session ID 找到文件后直接移除；找不到返回 `false`。

会话文件用 `0600` 追加。文件格式中保存完整用户、助手和工具消息，可能包含工具结果；不要把会话目录当作无敏感信息的日志位置。

## 记忆模型

记忆有两个 scope：

| Scope | 长期记忆 | 每日暂存 |
| --- | --- | --- |
| `global` | `<KANA_HOME>/memory/global/memory.md` | `<KANA_HOME>/memory/global/daily/YYYY-MM-DD.md` |
| `project` | `<KANA_HOME>/memory/projects/<encoded-workspace>/memory.md` | 同目录下的 `daily/YYYY-MM-DD.md` |

长期 `memory.md` 是会被注入系统提示词的压缩 Markdown；不存在时视为空。`saveKanaMemory` 会去除首尾空白、按 Unicode code point 检查 `memory.max_chars`，写入 UUID 临时文件后原子 `rename`，最终保证文件以一个换行结尾。

`remember` 不直接改写长期记忆。它默认 project scope，将非空内容（可选标题和原因）追加到当天的 Markdown 暂存文件：

```markdown
---
id: "mem_<uuid>"
created_at: "2026-06-22T12:00:00.000Z"
scope: "project"
title: "可选标题"
reason: "可选原因"
---

持久信息正文
```

元数据由宿主生成，字段值使用 JSON 字符串形式引用。日期使用进程本地日期而非 UTC 日期。每日文件的读取器会验证日期、scope、必需元数据和整个文件格式。

## 记忆合并

一次对话成功提交后，调度器从本轮 `remember` 的成功工具结果中按 scope 收集条目。每个 scope 的任务独立，但同一 scope 的任务通过 promise 队列串行运行，避免并发的读—改—写覆盖。

```text
remember 成功
  → 当天 daily 文件追加
  → Agent 本轮提交
  → scheduler 按 scope 收集条目
  → 增量合并 Agent
      读取当前 memory.md 和本批 daily 条目
      在内存 transaction 中 edit/replace
      正常 stop 且有改动时，原子保存 memory.md
```

合并 Agent 与主 Agent 使用同一模型配置，但没有 bash、文件工具或 `remember`。增量模式仅提供 `read_memory`、`edit_memory`、`replace_memory`，且输入只包含当前长期记忆和本批新条目。它不扫描历史 daily 文件，避免把未提供的上下文推断进记忆。

所有 edit/replace 先作用于内存 transaction；每次写入前检查大小限制。仅当 Agent 最终助手消息的停止原因是 `stop` 且 transaction 有改动时才 `commit()`。中止、错误、长度截断和未改动都不会覆盖长期记忆。

## 全量压缩与保留

`/memory compact [user|workspace] [request]` 可运行全量合并：省略 target 时同时处理 global 与 project。它向模型提供当前长期记忆和可选用户请求，并额外开放以下只读工具：

- `list_daily_memory`：按可选日期范围列出每日文件及条目数。
- `read_daily_memory`：读取指定日期的所有条目。
- `search_daily_memory`：不区分大小写检索标题、原因和正文，最多返回每一天三个摘要。

全量 Agent 仍只能通过 memory transaction 修改长期记忆。若该 scope 的合并以 `stop` 结束，且配置了 `memory.daily_retention_days`，Kana 才删除早于保留窗口的每日文件。保留窗口按本地日历日计算，例如 retention 为 3 且今天是 20 日时保留 18、19、20 日。删除只在成功的全量运行之后发生，确保即将过期的数据有机会被压缩进长期记忆。

## 用户可见命令

| 命令 | 行为 |
| --- | --- |
| `/memory show` | 在查看器中显示 user 和 workspace 长期记忆。 |
| `/memory show user` | 只显示 global 记忆。 |
| `/memory show workspace` | 只显示当前 project 记忆。 |
| `/memory compact [request]` | 合并两个 scope，可附加压缩要求。 |
| `/memory compact user [request]` | 只合并 global scope。 |
| `/memory compact workspace [request]` | 只合并当前 project scope。 |

压缩任务可由 `Esc` 或 `Ctrl+C` 中止。完成提示会分别报告每个 target 的 `updated`、`unchanged`、`aborted`、`length` 或 `error` 结果。

## 维护约束

- 记忆内容被视为数据而非指令；合并提示明确禁止执行其中的命令。
- 不应记录 secrets 或敏感个人数据。`remember` 的系统提示词只建议记录持久偏好、已确认决定和有长期价值的未完成工作。
- 不要手工破坏 daily 文件的 frontmatter 格式；一个损坏文件会在读取该日期时失败。
- 修改 session JSONL 或记忆格式时应同时更新解析器、存储测试和本文；这些文件是用户持久数据。
