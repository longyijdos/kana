# 对话运行时

Kana 在前端与可复用 Agent 之间放置一层产品级 runtime。TUI 和 headless runner 提交工作并消费同一套与前端无关的事件；session 持久化、排队运行顺序和 Agent 构造都不归任一前端所有。

## 装配边界

```text
TUI / Headless
  → ConversationRuntime
      ├→ ConversationInputCoordinator
      │   ├→ Agent-owned inbox
      │   ├→ WakeScheduler
      │   ├→ KanaGoalController
      │   └→ session BackgroundJobClient
      └→ Agent
  → KanaConversationHost
      ├→ HostedSessionRegistry
      ├→ Agent product factory
      ├→ configuration and approvals
      ├→ memory consolidation
      └→ MCP runtime
```

`KanaConversationHost` 是产品装配边界。它加载运行配置与审批状态，初始化选中的 session，持有共享 wake scheduler 和 MCP runtime，并使用当前模型、prompt、内置工具、外部工具、logger、journal、artifact store、background-job client、todo 状态与记忆回调构造每个主 Agent。它只返回与前端无关的操作和数据，不渲染 TUI 组件，也不投影 headless 输出。

`HostedSessionRegistry` 持有每个 session 实例关联的活动资源。每条托管记录绑定 session 内存镜像、可选 journal、logger、artifact store、background-job client 与待写入的 fork snapshot。`ConversationRuntime` 通过 Host 回调选择并使用这些资源，不直接打开存储或后台进程。

`ConversationRuntime` 持有当前 Agent 与 session 快照。它下面更窄的 `ConversationInputCoordinator` 是调度边界：观察 Agent inbox、wake、Goal 与后台 Job 完成事件，发布分离的队列快照，并请求 runtime 执行每个获准的新 run。它不维护第二条消息队列。

## Run 生命周期与事件

Runtime run 的来源只能是 `user`、`scheduled`、`goal`、`job` 或 `compaction`。另一 run 或 session 切换活动时，runtime 会拒绝新 run、session 切换与 Agent 重配置。它发布事件的副本，listener 无法修改内部状态：

```text
run_start
  → agent_event*
  → run_end | run_error
```

`agent_event` 除防御性复制外原样承载可复用 Agent 协议。Runtime 另行发布 `session_changed`、`input_queue_changed`、`todo_state_changed` 与 `goal_state_changed`。Listener 异常会被隔离并记录为 `conversation.listener_failed`，不能改变执行或清理。

普通 run 开始时，runtime 标记活动来源，订阅 Agent 事件，调用 `Agent.stream()`，同时等待 stream 迭代与 `result()`，最后要求得到终态 `agent_end`。因此持久化或后处理失败会成为 `run_error`，不会伪装成成功 runtime 结果。完整 Agent 边界结算前，活动来源一直保留，使 submission exclusion 始终权威。

手动压缩沿用同一排他与事件路径，但直接调用 `Agent.compact()`，不会创建用户消息或进入响应循环。Agent 持有压缩策略与 checkpoint adoption；runtime 只把它暴露为对话操作。

## 一套 inbox 与一个 drain gate

Agent 持有两条进程内 inbox lane：

- `next-step` 保存可在当前 Agent run 的下一 turn 接受的输入。
- `next-turn` 是后续 Agent run 的 FIFO 来源。

`ConversationInputCoordinator` 观察这些 lane，不复制其中的消息，也不分配另一套关联身份。一条逻辑输入从调度、inbox 移动、Agent event、journal commit、重放到前端投影始终保留同一个 `MessageId`。

活动 run 中通过 Enter 提交的输入先调用 `Agent.steer()`。Agent 在 turn 边界提交后结果为 `steered`；若 run 在 claim 前结束，Agent 会把同一项移到 `next-turn`，coordinator 返回 `queued`。Tab 输入直接进入 `next-turn`。只有 shutdown 或 session 切换使原执行上下文失效时，输入才会被丢弃。

Coordinator 的 drain loop 是启动排队 run 的唯一边界。它只会在以下条件同时成立时运行：

- 没有活动 run 或 session 切换；
- 上一个 run 已完成结算；
- coordinator 当前没有执行 drain；
- 前端可选的 `canStartQueuedRun` gate 已打开。

它 claim 第一条 `next-turn` 项，按 delivery metadata 推导 run 来源，并等待 runtime 明确返回 completed 或 failed 后才考虑下一项。MCP 管理等 modal workflow 活动时，前端可以关闭 gate，无需移动或复制排队消息。

## 定时输入

`WakeScheduler` 在内存中保存一次性 timer。每个事件属于一个 session，包含到期时间和来源，并可带替换 key；相同 session/key 的新事件会移除旧 timer。事件先按到期时间、再按 `MessageId` 排序；投递前不会写入 session journal，进程退出后也不会恢复。

Scheduler 在创建 timer 时就分配未来逻辑输入的 `MessageId`。到期时，同一个 ID 带 scheduled provenance 进入 Agent 的 `next-turn` lane。取消操作会同步先检查当前 session 的未来 timer，再检查已经到期的 `next-turn` 项，并返回 `future`、`pending` 或 `not_found`；不存在另一套 wake 或 queue ID。

Session 切换会取消旧 session 的 timer 并清空 inbox。Shutdown 则在清理 inbox、Goal 与 observer 后释放 scheduler。

## 后台 Job 完成投递

每个托管 session 都获得一个绑定的 `BackgroundJobClient`。完成投递只包含有界 Job 身份与状态，不包含缓存输出。Agent run 仍可接受 steering 时，完成事件进入 `next-step`；否则进入 `next-turn`。位于 `next-turn` 队首的相邻 Job 完成事件会合并提交，但不会跨过更早的人类、scheduled 或 Goal 输入。

通过 Agent Job 工具观察终态 Job 时，会确认该 Job，并取消仍在等待且 Job ID 相同的完成消息。TUI Job 管理使用独立的非消费视图，不会确认 completion。普通 Job 输出不会唤醒 Agent。Job 的执行与保留行为归[工具与执行](tools.zh-CN.md)所有。

## Goals

Goal 是进程内控制状态，不是 session 历史。启动时会校验目标，快照当前正整数 `goal_max_rounds`，创建第一轮普通用户 run，并通过 runtime context 暴露活动 Goal。模型可以调用 `update_goal` 将其结束为 `completed` 或 `blocked`。

一轮 Goal run 结算后，只有 `next-turn` 为空时 coordinator 才会允许 continuation；此前排队的人类、scheduled、deferred 与 Job 输入都会排在 Goal continuation 前。每次获准的 continuation 都是带 round metadata 的具名内部消息。达到快照上限会产生 `round_limit`，不再启动新 run。

用户 abort 会取消活动 Goal。Agent 重配置、session 替换与 shutdown 会因授权执行上下文改变而丢弃它。Goal run 出错或 Agent 以 aborted 结束会把 Goal 标记为 blocked。Goal controller 状态与 run budget 不从 session 恢复；此前 Goal run 已提交的消息仍是普通、可审计的历史。

## Agent 替换与 session 切换

Agent 替换与 session 替换是两个不同操作：

- 重配置保留当前 session、messages、context checkpoint 与 Agent inbox；候选 Agent 构造成功后才替换旧 Agent，并丢弃活动 Goal 控制状态。
- New、fork 与 resume 会创建或加载候选 session，并在修改当前 runtime 状态前构造其 Agent；构造失败时当前 Agent 与 session 仍可使用。

Session 切换期间 coordinator 会关闭 drain gate 并暂停 background-job 观察。Runtime 把前台 Agent 的 `waitForIdle()` promise 作为 settlement barrier，请求 Host 释放旧 session。只有释放成功后，它才取消旧 session 的 wake 与 inbox，采用新 session 和 Agent，连接新 Job client，发布 `session_changed` 并恢复队列观察。

Fork 把当前 messages 与 context checkpoint 交给 Host；resume 获得已提交 messages、timeline、checkpoint 与 todo state。它们的持久格式与恢复规则归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

## 启动模式与清理

Normal 与 clean 启动模式使用同一套 runtime 类型。Clean 模式下，Host 注册普通的进程内 session 身份，但不提供 journal，使用 no-op logger 与临时 artifact store；它不会创建记忆合并任务或激活 MCP，模型切换只更新经过校验的进程内配置。用户可见能力矩阵归[配置与安装](configuration.zh-CN.md)所有。

`ConversationRuntime.close()` 是幂等的。它阻止新工作、丢弃 Goal 状态、停止 wake/inbox/Job 观察、清空 pending input、中止 Agent，并请求 Host 一并等待前台 Agent 与活动 session 的后台 Job。之后再释放 wake scheduler 和 listener。

前端先关闭 runtime，再关闭 Host。Host shutdown 会停止新的记忆调度并等待所有 memory scheduler，让 registry 完成 background-job 与 artifact 清理，最后关闭 MCP。Session 替换会在前台与 Job barrier 结束后立即清理该 session 的 artifact store；shutdown 则把 artifact 清理留到更宽的 Host barrier，以免仍持有资源的记忆任务提前失去依赖。

## 前端职责

TUI 持有 focus、controller、transcript block、status projection 与用户交互。Headless 持有 prompt 解析、signal/deadline 策略、JSONL 或人类可读输出投影与退出状态。两者都消费 runtime event 并调用同一套 runtime 操作；它们不应重现 inbox 顺序、Goal admission、session 替换或清理编排。
