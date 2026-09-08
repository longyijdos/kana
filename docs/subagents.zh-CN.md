# Subagent

Kana 支持有界、异步、一次性的 subagent，并且只能从预定义角色卡中选择。Conversation Agent 可以委派任务后继续工作，稍后再查看或等待 child 结果。任意 prompt 不能创建不受约束的角色：每次 spawn 都必须指定当前有效的内置或用户 profile。

## Profile

Kana 始终提供 `explorer`、`worker` 和 `reviewer`。默认能力如下：

| Profile | 工具 | 用途 |
| --- | --- | --- |
| `explorer` | `list`、`glob`、`grep`、`read`、`view_image` | 只读调查仓库。 |
| `worker` | 工作区工具加 `mcp:*` | 完成一个有界实现任务。 |
| `reviewer` | 只读工作区工具加 `bash` | 审查变更但不编辑文件。 |

用户 profile 是 `<KANA_HOME>/agents`（通常为 `~/.kana/agents`）的直接 Markdown 子文件。去掉 `.md` 的小写连字符文件名就是 profile 名称。每个文件最多 64 KiB，格式如下：

```markdown
---
description: Review database migrations
tools:
  - list
  - grep
  - read
  - bash
model: openai-codex/gpt-5.6-terra
reasoning_effort: high
---
Review the delegated migration. Report correctness risks with file references.
Do not modify files.
```

`description` 和非空指令正文是必填项，`tools` 也可以写成 inline array。`model` 可选，默认 `inherit`；显式值采用 `<provider>/<model>`。只有显式指定 model 时才能设置 `reasoning_effort`。未知 frontmatter 字段或无效值会让整张角色卡失效。

同名用户文件会遮蔽内置 profile。如果文件无效，该名称保持不可用，不会静默回退到权限或行为不同的内置版本。主 Agent 装配动态工具面以及 `/agents` 刷新时会重新加载 profile。Spawn 会快照所选角色卡的完整内容与 digest，因此后续文件修改不会改变正在运行的 child 或其 journal。

## 能力与审批边界

Host 从 conversation 的已校验 Agent 配置中派生 child 的模型和能力上限，但不传递 prompt 内容。角色卡显式指定 model 时只替换模型选择，否则继承当前模型。角色卡工具列表只能缩小有效能力：

- 工作区工具必须同时被 `agent.tools` 和角色卡允许；
- 外部工具精确名称只授权该工具，`mcp:*` 授权当前活动的 MCP 工具集合；
- child Agent 永远不会获得 `spawn_subagent`、`wait_subagent`、`cancel_subagent`、Background Job、todo、Goal、memory 或 scheduled-wake 工具；
- 过大的 child 结果不会转存进 parent-session artifact。

角色卡正文是 child 的完整 system prompt，任务是它的 user message。它的 runtime-context section 列表为空：不会接收 Kana 默认 prompt、环境上下文、AGENTS.md、memory、Skills、Host 实时状态、parent 对话消息或继承 checkpoint。主 Agent 必须通过 `task` 参数提供任务所需的全部事实、约束、路径和预期结果。Child 使用普通审批 hook，因此角色卡不能弱化 `approval.mode` 或 Bash/MCP 审批规则。TUI 按 FIFO 串行处理同时到达的 main/child 审批请求，并用准确的 profile 与短 Agent 身份标记 child 提示。

## 生命周期与工具

每个托管 session 实例持有一个 `KanaSubagentClient`。`agent.subagents.max_live` 限制其同时运行的 child 数量，终态记录不计入上限。主 Agent 获得三个 parallel-safe 控制工具：

| 工具 | 行为 |
| --- | --- |
| `spawn_subagent(profile, task)` | 校验指定 profile，启动一个 child，并立即返回 `agentId`。 |
| `wait_subagent(agentId, timeoutMs?)` | 返回当前或终态状态与输出；每次最多等待 30 秒，超时不会取消。 |
| `cancel_subagent(agentId, reason?)` | 中止一个所属的活动 child，并等待它结算。 |

Parent runtime context 只投影活动和未观察终态 child 的身份、profile 与状态，不包含任务正文或输出。完成、报错和取消会像 Background Job completion 一样为 parent 排入一条有界通知；parent 使用 `wait_subagent` 消费结果。返回终态的 `wait_subagent` 会确认 completion，并移除仍在等待的通知。`cancel_subagent` 也会确认结果，而 TUI 发起的取消不会确认。Child 失败会产生 `errored` 结果，不会自动让 parent 失败。Spawn 成功后，child 与发起 spawn 的 tool invocation 和 parent turn 相互独立；它会继续运行，直到自然结束、被显式取消、session 被替换或删除，或者进程 shutdown。Session disposal 会等待其拥有的全部 child 结算。

## 持久化、TUI 与 accounting

普通模式下，每个 child 都有独立的内部 journal：

```text
<KANA_HOME>/sessions/<encoded-workspace>/.subagents/<parent-session-id>/<child-id>.jsonl
```

它复用 session turn record 格式，但 header 额外包含 parent ID、spawn tool-call ID 与完整 profile 快照。这些文件不是普通可恢复 session，永远不会出现在 `/resume`。启动后查看一个未闭合 child turn 时会把它报告为 `interrupted`，但不会修复或恢复执行。Fork parent 不复制 child；删除 parent 会移除完整 child-journal 目录。

主 Agent 运行期间也可使用 `/agents`。面板显示有效 profile 和当前 session 的活动或归档 run；方向键选择，`Enter` 打开 transcript，`K` 取消活动 child 但不确认其 completion，`R` 重新加载，`Esc` 关闭。无效 profile 的诊断也会显示在面板中。

Child run 使用独立的 `subagent` accounting kind，并与 main、memory run 分开显示。其 usage 只向 aggregate 和 per-model 总数贡献一次，不复制进 parent run usage。Clean mode 只暴露内置 profile，child 状态仅保存在内存中，也不写 child journal 或 accounting record。
