# Agent 层审查备忘

日期：2026-07-22

## 结论

Kana 的 `agent` 层不是“太薄”，而是一个边界清楚的薄内核：模型流、工具循环、审批、中止、事件和状态提交都已经具备。真正薄弱的是它上面缺少一层可靠的会话运行时，主要包括上下文治理、持久化恢复、严格生命周期和工具调度策略。

当前基础完成度不错：

- `core → provider → agent → tools` 的依赖方向清晰。
- 流式消息保留了 thinking、text 和 tool call 的原始顺序。
- 工具参数校验、错误回传、审批和中止补齐结果处理得比较严谨。
- provider 错误不会污染历史，未执行的半截 tool call 也不会落盘。
- 本次审查运行的 24 个 Agent、Agent loop 和 session store 相关测试全部通过。

因此，下一步不应照搬 Codex 的模块数量或把 `Agent` 类继续做大，而应先补齐运行时不变量。

## 当前职责分布

```text
core
  └─ 消息、模型、流、用量等通用协议

agent
  ├─ Agent：单次运行控制、状态、事件和提交 hook
  └─ runAgentLoop：模型采样、工具调用和多回合循环

kana
  └─ 产品装配、prompt、Skills、记忆、session、审批和 MCP

tui
  └─ 输入互斥、wake queue、Agent 重建、提交消费和界面状态
```

这里的问题不是 `src/agent` 文件数量少，而是部分本应属于“会话运行时”的调度职责落在了 TUI 中。如果未来增加无头模式、服务端 API 或其他界面，这些逻辑会难以复用。

## 优先问题

| 优先级 | 问题 | 影响 |
| --- | --- | --- |
| P0 | 状态所有权有泄漏 | 外部初始消息和 listener 可以修改 Agent 内部历史 |
| P0 | commit 不属于 active run | `waitForIdle()` 可能在 `onRunCommitted` 完成前返回 |
| P0 | 终态语义不完整 | 达到 `maxTurns` 会被报告成普通 `stop` |
| P1 | 上下文没有统一预算 | 历史、系统 prompt 和工具结果最终会无界增长 |
| P1 | 只在整轮结束后持久化 | 工具已经产生副作用但进程崩溃时，本轮记录可能全部丢失 |
| P2 | 工具调度语义较弱 | 全部串行、取消仅靠协作、进度更新顺序没有严格保证 |
| P2 | 产品运行时落在 TUI | wake queue、Agent 重建和提交互斥难以复用于其他入口 |

## P0：生命周期和状态所有权

### 1. 公共数据并非全部深拷贝

文档声明 Agent 发送给 listener 的消息和公开 state 均为深拷贝，但实现并不完全符合这个契约。

- `src/agent/agent.ts:339` 的初始 `messages` 只复制了数组，消息对象仍与调用方共享。
- `src/agent/agent.ts:331` 在处理 `agent_end` 时，把 `event.messages` 中的对象直接放入内部状态。
- 随后 `src/agent/agent.ts:234` 又把同一个事件对象交给 listener。
- listener 抛出的异常还会直接终止 Agent loop。

本次使用最小运行例确认了两个问题：

1. 构造 Agent 后修改原始 `messages`，会改变 Agent 内部历史。
2. listener 修改 `agent_end.messages`，会改变 Agent 已提交的内部历史。

建议：

- 构造输入统一执行深拷贝。
- 在公共事件边界统一深拷贝，不依赖各个 emit 调用点自行判断。
- 将 observer 与控制 hook 分离。普通订阅者异常应被隔离和记录，不应控制 Agent 执行。

### 2. commit 没有包含在 active run 中

`onRunCommitted` 在 `runWithLifecycle()` resolve 之后执行，但 `runWithLifecycle()` 的 `finally` 已经把 `activeRun` 清空并将 `isRunning` 设为 `false`。

因此，当异步 commit 仍未完成时：

- `isRunning === false`；
- `waitForIdle()` 已经返回；
- 新一轮理论上可以开始；
- 两轮异步持久化可能乱序。

本次最小运行例也确认了这个行为。

建议明确唯一顺序：

```text
运行 loop
  → 更新内部终态
  → 执行 commit
  → commit 成功
  → 对外发出最终完成事件
  → 清除 active run
```

如果 commit 失败，应区分“模型执行已经完成”和“持久化失败”，不能让订阅者先看到成功终态、stream 消费者随后又得到失败。

### 3. `reset()` 在运行期间不安全

当前 `reset()` 会直接清空状态并把 `isRunning` 设为 `false`，但不会终止或等待真实的 active run。后续事件仍可能重新写入刚被清空的状态。

最简单的处理方式是运行中禁止 `reset()`。如果产品需要该能力，再提供语义明确的 `abortAndReset()`，内部执行 abort、等待 idle、最后清空。

### 4. `maxTurns` 耗尽被误报为正常停止

`src/agent/loop.ts:72` 将 `endReason` 初始化为 `stop`。如果最后一回合仍然产生并执行了工具调用，循环随后因为达到上限自然退出，最终仍然发出 `reason: "stop"`。

这会让通知、日志、accounting 和后续任务认为 Agent 已正常完成，但实际上它还没有生成最终答案。

建议增加明确终态：

```ts
type AgentEndReason =
  | "stop"
  | "length"
  | "aborted"
  | "error"
  | "turn_limit";
```

配置层也应只接受 `-1` 或正整数。当前通用 `readNumber()` 会接受小数和其他负数。

Kana 产品默认 `maxTurns = -1`，相当于关闭了现有的无限循环保护。长期应使用组合预算，包括最大回合、总耗时、token 预算和连续相同工具调用次数。

## P1：ContextManager

当前每次采样都会把完整历史直接交给模型。部分内置工具和 MCP 结果有自己的截断，但 Agent 层没有统一的 model-visible 内容上限。

这会产生几个问题：

- session 越长，请求上下文越大，直到 provider 拒绝。
- `read` 或 `grep` 遇到超长单行时仍可能产生很大的结果。
- 第三方 Tool 可以绕过内置工具的限制，直接返回超大字符串。
- 系统 prompt、记忆和 Skills 也没有统一预算。

Codex 最值得借鉴的是 ContextManager 的不变量，而不是完整实现：

- 写入历史时统一截断。
- 请求前正规化历史，并维持 tool call/result 配对。
- 跟踪实际 token usage，同时估算新加入内容。
- 在请求前和工具循环中检查 compaction 阈值。
- 尽量增量构建上下文，避免频繁重写导致 prompt cache miss。

Kana 第一版 ContextManager 可以很小：

```ts
interface ContextManager {
  record(messages: Message[]): void;
  prepareForModel(options: {
    contextWindow: number;
    maxOutputTokens: number;
  }): Promise<ModelContext>;
  recordUsage(usage: ModelUsage): void;
}
```

第一阶段只需要：

1. 集中限制所有 model-visible tool content。
2. 跟踪最近一次 prompt token usage。
3. 在下一次采样前预估剩余空间。
4. 达到阈值时调用可注入的 compact policy。

不要一开始实现 Codex 的完整 context fragment、world state 和多模型切换逻辑。

## P1：增量 Turn Journal

Kana 当前只在整个 Agent run 完成后批量追加消息。这避免了持久化流式快照，但不足以处理工具副作用后的进程崩溃。

风险场景：

```text
用户请求修改文件
  → 模型调用 edit
  → 文件已经修改成功
  → 进程在最终回答或 onRunCommitted 前崩溃
  → 恢复 session 后看不到本轮 prompt、tool call 和结果
```

不需要立即实现 Codex 那么复杂的 rollout reconstruction。可以先把 session JSONL 升级成最小 turn journal：

```text
turn_start
message(user)
message(assistant tool call)
tool_result
message(final assistant)
turn_end
```

记录应在每个步骤完成后增量追加。恢复时如果看到 `turn_start` 没有匹配的 `turn_end`：

- 将该 turn 标记为 `interrupted`；
- 保留已经确认完成的消息和工具结果；
- 绝不能自动重跑可能产生副作用的工具；
- 可以向模型注入一条结构化的中断说明，或者先要求用户决定是否继续。

现有 `parentId` 可继续用于谱系，但还需要稳定的 `turnId` 和明确的 turn 边界。

## P2：ToolRuntime

目前工具执行逻辑集中在 `src/agent/loop.ts:251` 之后。继续加入并发、超时、重试、生命周期和沙箱策略，会让 loop 变成高耦合的大模块。

后续可以抽出独立的 `ToolRuntime`，负责：

- 工具查找和参数校验；
- 审批；
- 执行、更新事件和结果规范化；
- 取消与超时策略；
- 并发控制；
- 工具级诊断日志。

并行能力不应直接对所有调用使用 `Promise.all()`。工具应显式声明：

```ts
type ToolConcurrency = "parallel" | "exclusive";
```

- `list`、`glob`、`grep`、`read` 等只读工具可以声明 `parallel`。
- `write`、`edit`、`bash`、`remember` 等默认使用 `exclusive`。
- 未声明的第三方和 MCP 工具默认保持 `exclusive`。

Codex 的做法也是由工具元数据决定是否允许并行，并使用读写锁保证并行工具不会越过独占工具。

### 取消契约

当前取消是协作式的：Agent 只把 `AbortSignal` 传给工具。如果第三方工具忽略 signal，`Agent.abort()` 不能保证 `waitForIdle()` 最终返回。

JavaScript 无法安全强杀任意 Promise，因此不应简单用 `Promise.race()` 假装底层执行已经结束。应明确 Tool 契约：

- 工具必须响应 signal；
- adapter 负责清理底层进程、HTTP 请求或 MCP 调用；
- 可为工具声明默认 deadline；
- 无法确认底层停止时，要将其标记为 orphaned/unknown outcome，而不是普通 aborted。

### 更新事件顺序

当前 `ToolContext.update()` 把多个 emit Promise 放入数组，最后通过 `Promise.all()` 等待。虽然能保证 `tool_execution_end` 之前所有 update 都已完成，但异步 listener 的完成顺序可能改变更新事件的可见顺序。

建议 ToolRuntime 内部维护一个串行事件队列，确保：

```text
start → update 1 → update 2 → ... → end
```

## 产品运行时边界

目前这些职责位于 `KanaTuiApp`：

- 输入期间的 `running` 互斥；
- wake event 排队和 drain；
- 外部工具变化后的 Agent 重建；
- session 切换、fork 和 resume；
- Agent stream 消费与提交后的调度。

对当前只有 TUI 的产品来说可以工作，但如果未来增加 CLI 无头执行、daemon 或 API，这些逻辑会重复。

不建议把它们放进通用 `src/agent/Agent`。更合适的是在 `src/kana` 增加一个产品级 `AgentSession` 或 `ConversationRuntime`：

```text
KanaTuiApp
  └─ ConversationRuntime
      ├─ Agent
      ├─ ContextManager
      ├─ SessionJournal
      ├─ input/wake queue
      └─ tool registry snapshot
```

TUI 只负责提交输入、消费事件和显示审批。

这项重构不是当前 P0；等生命周期、ContextManager 和 journal 的接口稳定后再做更合适。

## 从 Codex 借什么、不借什么

值得借鉴：

- 每个 turn 都有稳定身份。
- 历史按步骤增量记录，而不是只保存最终文本。
- model-visible 内容全部有硬上限。
- 请求前和工具循环中都检查上下文预算。
- 工具通过元数据声明并行能力。
- 区分可立即取消的工具和必须等待底层清理的工具。
- 流重试会通知前端，并保持明确的 retry 状态。
- 恢复时可以识别 completed、aborted 和 interrupted turn。

暂时不要借：

- 多 Agent registry 和 agent communication。
- app-server 协议和远端环境抽象。
- 插件 contributor 生命周期体系。
- world state diff、复杂 context fragment 类型树。
- 多 transport fallback 和多模型迁移。
- Codex 当前大型 `core` 的模块规模。

Codex 自己的 `AGENTS.md` 也明确提醒其 `codex-core` 已经膨胀，不应把“代码更多”误认为“Agent 更强”。

## 建议实施顺序

### 第一阶段：Agent 生命周期正确性（已完成）

只改 production code，暂不更新测试和文档，等待实现评审。

1. 修复构造输入和事件的深拷贝边界。
2. 隔离 observer 异常。
3. 将 commit 纳入 active run。
4. 统一最终事件和 stream 结束顺序。
5. 运行中禁止 `reset()`。
6. 增加 `turn_limit` 终态和配置校验。
7. 保证所有异常路径都有唯一、可解释的终态。

### 第二阶段：ContextManager（已完成）

1. 所有 model-visible tool content 设置统一硬上限。
2. 记录实际 usage 并估算新增内容。
3. 采样前执行 budget check。
4. 提供可注入 compact policy。
5. 处理 context window exceeded 后的安全恢复。

### 第三阶段：Session Turn Journal（已完成）

1. 将 session format 升级为 v3。
2. 增加 `turn_start`、增量 message/tool result、`turn_end`。
3. 定义 interrupted turn 与未完成尾记录的恢复语义。
4. 运行时只保留 v3 读取路径；本地 v1/v2 session 经一次性备份和迁移后切换。

### 第四阶段：ToolRuntime（已完成）

1. 从 `loop.ts` 抽出工具执行逻辑。
2. 加入串行事件队列。
3. 建立工具取消和 deadline 契约。
4. 通过显式 metadata 支持安全并行。

### 第五阶段：产品运行时抽取

仅在准备支持第二种前端或无头模式时，将 TUI 中的 session/wake/input 调度抽到 `src/kana`。

## 明天建议从这里开始

先处理第一阶段，不要同时改 ContextManager、session format 或工具并行。第一批 production-code 改动应保持在一个容易审查的小范围内：

- `src/agent/agent.ts`
- `src/agent/events.ts`
- `src/agent/loop.ts`
- `src/kana/config.ts`

实现完成后先审查 production code，再按项目工作流补测试和中英文文档。需要新增的回归测试至少包括：

- 构造参数不能修改内部历史。
- listener 不能修改内部历史。
- listener 异常不会终止 Agent。
- `waitForIdle()` 等待异步 commit。
- commit 期间拒绝下一轮运行。
- 运行中 `reset()` 的明确行为。
- 达到回合上限返回 `turn_limit`。
- 非法 `max_turns` 配置被拒绝。
