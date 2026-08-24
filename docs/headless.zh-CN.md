# 无头执行与 JSONL 协议

`kana exec` 在不启动 TUI 的情况下执行一次完整的 Agent turn，适合脚本、CI 和评测。这里的“一次 turn”不是一次模型请求：它会沿用 TUI 相同的 Agent 配置，持续完成模型调用、工具执行、上下文压缩和后续模型调用，直到 Agent 得到终止结果，然后进程退出。

## 命令

```bash
# 执行新 session；参数会拼成一条 prompt
kana exec 修复失败的测试

# 也可从 stdin 读取 prompt
printf '总结这个仓库' | kana exec
kana exec < prompt.txt

# 恢复已有 session 后再执行一次
kana exec resume <session-id> 继续完成任务

# 输出稳定的 JSONL 事件
kana exec --json 分析当前项目
kana exec resume <session-id> --json 继续分析

# 显式允许所有工具，无需交互审批
kana exec --allow-all-tools 完成这项修改

# 在不保存 session 的纯净模式中执行
kana exec --clean 检查当前项目

# 30 分钟后优雅取消 Agent run
kana exec --timeout 30m 完成这项修改
kana exec resume <session-id> --timeout 30m 继续任务
```

新执行和恢复执行都通过 `KanaConversationHost` 与 `ConversationRuntime` 装配，因此与 TUI 共用模型、reasoning 配置、系统提示词、Skills、工作区工具和产品策略。普通模式继续使用 MCP、session V5 journal、accounting、日志和记忆调度。

conversation runtime 关闭后，headless 退出流程会取消并等待尚未完成的自动记忆合并，再关闭 MCP。此时 `remember` 条目已经持久化到 daily 暂存；取消会保留该条目，也不会提交未完成的长期记忆 transaction。

`--clean` 创建随本次进程结束即丢弃的临时 session。它仍加载 `config.toml`、`<KANA_HOME>/.env`、provider/model、OAuth 与审批规则，但不读取全局或项目 `AGENTS.md`、记忆、Skills 与 MCP 配置，不连接 MCP server，也不创建 session journal、session log 或 accounting 记录。`exec resume` 与 `--clean` 组合会在启动时以退出码 `1` 失败；JSON 模式会输出相应的 startup `error` 事件。纯净模式不是 sandbox 或隐私边界，内置工具和 provider 仍可能产生外部副作用。

唯一刻意省略的内置工具是 `schedule_wake`：它依赖当前进程中的定时器，而无头进程会在本次 turn 后退出，无法兑现未来的 wake。其它内置工具继续使用相同的并发策略、deadline 和结果语义。普通模式会在 turn 开始前加载 MCP；可选 server 失败会产生 warning，必需 server 失败会使启动失败。纯净模式完全跳过这一步。无头模式不会打开浏览器完成 MCP OAuth，因此需要交互授权的 server 应预先在 TUI 中授权。

`--timeout <duration>` 接受正整数加 `ms`、`s`、`m` 或 `h` 单位，默认不启用。计时从 Agent run 提交时开始，不包括此前的 prompt 解析、Host/session 装配和 MCP 启动；正常的 runtime、记忆、MCP 与 Host 清理也不计入 deadline。到时后，Kana 会优雅取消活动 Agent 及其工具，等待正常的 run 与清理边界，并保留已经写入工作区和 session journal 的工作。因此它是软 deadline：不响应取消的外部操作或清理流程可能让进程晚于指定时长才返回。

它与其它限制控制的是不同范围：

| 控制项 | 范围 |
| --- | --- |
| `kana exec --timeout` | 完整 Agent run 的墙钟时间 |
| `agent.max_turns` | 一次 Agent run 内的模型/工具回合数 |
| Provider 请求 timeout | 单次 provider 请求或无活动窗口 |
| 外部进程/job timeout | 进程总生命周期的硬限制；可能在优雅清理完成前中断 Kana |

## 输出与退出状态

默认的人类可读模式把 session、工具和压缩进度写到 stderr，只把最后一条助手消息的可见文本写到 stdout。因此脚本可以直接捕获最终答案，同时仍可在终端观察进度。模型文本写到终端前会移除控制字符；`--json` 中的文本保持为 JSON 数据。

退出码含义：

| 退出码 | 含义 |
| --- | --- |
| `0` | Agent 以 `stop` 正常完成 |
| `1` | 启动/运行失败，或结果为 `aborted`、`error`、`length`、`turn_limit` |
| `124` | `--timeout` 到时；活动 Agent 会先收到取消信号 |
| `130` | 收到 `SIGINT`；活动 Agent 会先收到取消信号 |

无头模式没有审批界面。它默认执行 `approval.mode` 与 `approvals.json` 已信任的工具；若某个工具仍需交互审批，本次 run 会以 `aborted` 结束且不会执行该工具。`--allow-all-tools` 会无条件授权 Agent 执行所有可用工具：文件工具仍使用当前用户的真实文件权限，`bash` 仍会执行真实系统命令。该选项不会隔离文件或进程，只应在受控环境中使用。

## `--json` 协议

`--json` 让 stdout 只包含一行一个 JSON object。每个事件都包含 `schema_version: 2`；调用方应按 `type` 分派并忽略不认识的附加字段。该协议由无头前端从内部事件投影而来，不直接序列化 `AgentEvent`，因此内部重构不会自动变成公共协议变化。

| `type` | 主要字段 | 含义 |
| --- | --- | --- |
| `session.started` | `session_id` | 已创建或加载 session |
| `warning` | `phase`, `message`, `server_id?` | 非致命启动警告 |
| `run.started` | — | 本次 Agent run 已开始 |
| `model_turn.started` | `turn` | 一次模型回合开始 |
| `assistant.delta` | `delta` | 可见助手文本增量 |
| `assistant.completed` | `text`, `usage?` | 一条完整助手消息 |
| `tool.started` | `tool_call_id`, `name`, `arguments` | 工具开始执行 |
| `tool.updated` | `tool_call_id`, `name`, `partial_result` | 工具进度更新 |
| `tool.completed` | `tool_call_id`、`name`、`result`、`is_error` | 工具调用到达物理终态 |
| `model_turn.completed` | `turn`, `stop_reason?`, `usage?` | 一次模型回合结束 |
| `context.compaction_started` | token 估算与上限 | 上下文压缩开始 |
| `context.compacted` | 压缩统计与 `usage?` | 压缩 checkpoint 已提交 |
| `run.completed` | `outcome`、`usage?`、`termination?` | run、有序消息提交与后处理全部完成 |
| `run.failed` | `error`、`termination?` | run 因基础设施或持久化异常失败 |
| `error` | `phase`, `error` | Agent run 开始前的启动失败 |

Schema v2 将 `tool.completed` 从提交确认改为执行生命周期事件。它跟随物理完成、取消或明确的 unknown 终态，不表示工具结果已经进入 journal。因此即使已经出现一个或多个 `tool.completed`，之后的 journal 或后处理失败仍会发出 `run.failed`；需要完整持久 run 的调用方必须等待 `run.completed`。

当取消由无头前端发起时，终态 run 事件会包含 `termination`。超时对应 `{ "reason": "timeout", "timeout_ms": 1800000 }`，`SIGINT` 对应 `{ "reason": "sigint" }`。成功取消的超时通常以 `run.completed`、`outcome: "aborted"` 和退出码 `124` 结束。如果 run 在取消过程中发生失败，`run.failed` 仍按失败处理，进程退出码为 `1`，但 `termination` 会记录同时发生的取消来源。

`usage` 使用 `input_tokens`、`output_tokens`、`total_tokens`，并可包含 `cache_read_input_tokens`、`cache_miss_input_tokens` 和 `reasoning_tokens`。`run.completed.usage` 是本次 run 内模型回合与上下文压缩的累计值。工具的 `arguments`、`partial_result` 和 `result` 属于显式请求的机器输出，可能包含工具处理的数据；不要把 JSONL 不加审查地上传或写入公开日志。
