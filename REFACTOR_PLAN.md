# Kana 重构计划

> 这是一份工作文档，全部完成后删除。工作分支是 `refactor/simplify`；所有阶段都完成后，统一提一个 PR 合并进 `main`，中途不合并。
> 文中的行号来自制定计划时的代码，会随修改漂移，以符号名为准。

## 目标

把这个项目重构成**结构清晰、每个概念只有一份实现、读起来不费劲**的代码，而不只是给现有代码瘦身。

项目后期主要由 Codex 编写，主要问题有三类：

- **没有信任边界**：内部数据也被当成不可信输入，于是到处是深拷贝、重复校验、多层 try/catch 和幂等标志。src 中约有 300 处 `structuredClone`
- **同一个概念写了好几份**：
  - helper 动辄 5 到 8 份
  - 约 50 个配置字段手写了三遍
  - 三个前端各写一套接线
  - job 和 subagent 是两套同构的注册表
  - 三个 provider 各写一套 HTTP 和请求转换
- **边界和职责不清**：
  - 模块依赖规则只是当时 import 关系的快照，反过来逼出了重复代码
  - 1000 行以上的文件同时承担好几种职责
  - clean 模式的判断散落在 26 处

## 设计原则

1. **只在边缘校验**：配置文件、session JSONL、HTTP 请求、模型 SSE、工具参数、OAuth/MCP 响应在入口处用 schema 校验一次，内部完全依赖类型
2. **数据不可变**：已提交的消息、事件、配置、快照都用 `readonly` 类型表达，按引用传递，不做防御性拷贝。可变状态只存在于明确的所有者内部，比如 provider 正在构建的消息
3. **一个概念一份实现**：发现第二份拷贝时就抽出来，放在使用者的最近公共层
4. **能力显式化**：可选能力（skills、MCP、memory、持久化 session、subagents）启动时组装一次，每项要么是真实实现，要么是 Unavailable 实现，下游不再判断模式
5. **小文件、单一职责**：核心文件尽量不超过 500 行，一个文件只描述一个概念
6. **错误和日志各在一处处理**：Logger 本身保证不抛异常，调用方不再包 try/catch；listener 的异常隔离统一由一个 Emitter 负责；日志里的错误字段统一由 `errorFields()` 生成
7. **测试只验证行为**：测试通过公开接口验证行为。只验证内部细节的测试（"deep-clones…"、"isolates listener mutations…"）随实现一起删除或改写

## 兼容性决策（已定，可推翻）

| 对象 | 决策 | 理由 |
| --- | --- | --- |
| `config.toml` 字段与默认值 | **保持不变** | 这是用户手写的文件，改字段名会让用户的配置失效 |
| session JSONL | **旧格式必须可读**；写入格式可以改，但要升版本号 | 用户已有的会话必须能 resume |
| oauth-tokens.json、mcp.json、approvals 等本地文件 | 同上：旧文件可读，写入可以升级 | 同上 |
| headless JSONL（`schema_version`） | 尽量保持 v1；确实需要改时升版本号并更新文档 | 可能有脚本依赖这个输出 |
| HTTP server API | 允许修改，同步更新文档 | 标注为 experimental |
| 内部 TS API、模块划分、文件位置 | 完全自由 | 不对外暴露 |
| `scripts/source-boundaries.ts` 的白名单、AGENTS.md 中由 Codex 引入的约定 | 视为待重新设计，不视为约束 | 用户确认过：这些不是经过深思熟虑的设计 |

## 目标架构

### 模块分层（替代原来的两两白名单）

上层可以 import 任何下层模块；同层之间、以及下层向上层的 import 都不允许。`check-source-boundaries.ts` 的循环检测保留，把规则表换成层号。

```
L6  cli, main
L5  tui, headless, server            前端：只做输入输出的投影
L4  kana                             产品装配：配置、会话、能力、对话运行时
L3  agent, mcp                       Agent 循环 / MCP 协议
L2  tools                            可执行工具
L1  oauth, jobs, providers           通用基础设施
L0  core, utils, logging, version    叶子：不依赖任何模块
```

- `core`：provider 中立的协议契约，包括消息、事件、模型、用量、ToolSpec、EventStream。全部是 readonly 类型，不放通用 helper
- `utils`：无依赖的纯函数，比如 isRecord、formatError、`parseWithSchema` 和路径展开。准入规则是**至少有两个顶层模块在用**；只有一个模块用的 helper 留在该模块内部。`image-input` 移到 `tools`
- `logging`：Logger、`errorFields()`、`Emitter`（带异常隔离的监听器集合）
- 前端是否只能依赖 `kana` 加 L0：阶段 6 结束后再决定

### 各模块的目标形态

- **providers**：
  - 共享层负责 HTTP（signal、retry、HttpError）、SSE 读取、错误规范化，以及模型 run 的生命周期
  - Responses 协议的请求和流解析共用一份，deepseek 与 openai-codex 只是两套配置
  - openai-compatible 只负责 Chat Completions 的差异部分
- **agent**：
  - `Agent` 只是一层门面
  - `AgentRun` 负责一次运行：stream、journal、提交、compaction
  - `SteeringQueue` 封装 inbox
  - `EventHub` 负责发布和 reduce
  - tool runtime 拆成 `ToolScheduler`（分组和并行池）、`ToolInvocation`（单次执行、超时、审批）、`ToolResultFinalizer`（policy 和结果持久化）
  - 状态访问廉价、只读
- **jobs**：一个泛型的 `OwnedTaskRegistry`，负责 owner 隔离、并发上限、waiters、prune、observe 和 close。background job 与 subagent 都基于它实现
- **kana**：
  - `config`：字段只定义一次，由这份定义同时派生 schema、默认值、snake↔camel 映射和 TOML 修补路径
  - `KanaCapabilities`：替代 launchMode 判断
  - `KanaConversationHost.createRuntime(frontendOptions)`：前端只声明自己的差异
  - 会话完成后的输入通过统一的 `CompletionSource` 接入
  - 持久化基础设施（原子写、串行队列、文件锁）各只有一份
- **oauth / mcp**：
  - OAuth 规则（过期提前量、binding、拒绝码、auth method）集中放在一个模块
  - MCP 和 OAuth 的诊断直接写 Logger，不再层层回调
  - 关闭操作只在资源所有者那一层保证幂等
- **tui**：
  - `OverlayHost` 保证同一时间只有一个 overlay
  - `ListPicker` 统一列表的导航和视口
  - overlay controller 基类
  - editor 和 text-prompt 共享输入帧
  - `app.ts` 只做装配，事件投影、提交和生命周期各自独立

## 工作方式

- **每个阶段开始时**，先通读该阶段涉及的代码，把目标设计细化写进本文件的对应阶段，再动手
- 阶段内按小步提交（Conventional Commits，不加 attribution），每个提交都要通过 pre-commit（`bun run check:write`）
- 每个阶段结束时：
  1. `bun run check` 通过
  2. 完成手动冒烟测试（见文末）
  3. 更新本文件的进度
  4. 向用户简要汇报，然后继续下一阶段
- 中途不合并 `main`。如果 `main` 上有新提交，在阶段之间把它 rebase 进来，避免最后一次性处理大量冲突
- 文档：每个阶段同步修改受影响的 `docs/` 规范文档（中英文一起改）；阶段 8 统一检查一遍
- 遇到计划没有覆盖到的设计问题时自己判断，并在本文件的"决策记录"里记一笔

## 进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 地基：分层规则、类型严格化、死代码删除、合并 helper | 已完成 |
| 2 | 不可变数据模型，去掉防御性拷贝 | 已完成 |
| 3 | Agent 运行时重构 | 已完成 |
| 4 | Provider 重构 | 未开始 |
| 5 | 解析与持久化 | 未开始 |
| 6 | 产品层：能力、对话运行时、任务注册表、OAuth/MCP | 未开始 |
| 7 | 前端：headless、server、TUI | 未开始 |
| 8 | 收尾：文档、约定、删除本文件 | 未开始 |

先做"地基"和"不可变数据"，原因是后面几乎所有阶段都要碰这些类型和拷贝；先把它们定下来，后面的结构重构就不用返工。

---

## 阶段 1：地基（已完成）

### 完成内容
- 模块边界改为分层规则（`scripts/source-boundaries.ts`），`image-input` 移到 `tools`，`utils` 成为叶子模块；架构文档中英文同步更新
- 开启 `noUncheckedIndexedAccess`。数组遍历改用 `entries()`；6 个列表组件改为通过新增的 `ListViewport.visible()` 渲染，`ListViewport` 内部也顺带精简了
- 删除死代码：`OAuthSession`（约 430 行）、`validateToolCall`，以及 9 个只被测试调用的包装 API。测试改用真实 API，或使用 `tests/helpers/session.ts`。OAuth 文档同步更新
- 合并 helper：
  - `utils`：`isRecord`、`formatError`、`errorFields`/`errorCode`、`shortId`
  - `tui/render`：`singleLine`、`collapseWhitespace`、`formatByteSize`、`base64ByteLength`、`pad2`、`formatInteger`、`setsEqual`、`capitalize`
  - `throwIfAborted` 改用 `AbortSignal.throwIfAborted()`
- 日志：
  - `Logger` 新增 `child(metadata)`，替代在 agent、context-manager、loop、tool-runtime 之间层层传递的 `loggerMetadata`
  - 删除 `SessionLogManager`，以及所有包住 logger 调用的 try/catch
  - 测试 logger 统一用 `createLogger` 构造
- 不可能触发的分支与冗余标志：
  - steering 生命周期并入 `runWithLifecycle`
  - 模型流结束却没有终止事件时，改为明确报错，不再静默兜底
  - 删除 headless 的 `listening`、`settled` 标志
- 修复：MCP OAuth 授权的 finally 中，关闭 callback server 失败会覆盖原本的结果。没有补回归测试，因为 callback server 没有注入点

### 延后到后续阶段
- frontmatter 中的 `validateName` 和 `unquote` → 阶段 5（frontmatter 统一读取器）
- jobs 与 subagents 中重复的 `read*Integer`、`uniqueOwners`、`MAX_WAIT_MS`，以及走不到的 immediate-finish 和 `inspect` 分支 → 阶段 6（任务注册表）
- provider 中在 `terminalSeen` 之后才做的检查、`getOpenAICompatibleDoneReason` 走不到的 default → 阶段 4
- TUI controller 中零散的冗余检查（notification、mcp-lifecycle、tool-approval、content-viewer、slash-command-options、status-line、delete-session-confirmation）→ 阶段 7
- host 中作为死代码的 `??=` → 阶段 6（Capabilities）
- 约 150 个只被测试使用的 barrel 导出，以及 knip production 模式的配置 → 阶段 8

---

## 阶段 2：不可变数据模型（已完成）

### 结果

| 场景 | 改造前 | 改造后 |
| --- | --- | --- |
| 短回复（200 增量） | 5 ms | 4 ms |
| 长回复（4,000 增量） | 118 ms | 4 ms |
| 超长回复（12,000 增量） | 1,042 ms | 11 ms |

耗时从二次方增长变为线性增长。`structuredClone` 从约 300 处减少到 43 处，剩余的分布如下：
- 阶段 3：tools 的参数校验与结果规范化
- 阶段 4：provider 的请求回放与 replay 合并
- 阶段 5：配置类 store，以及 host 的配置 getter 和 draft
- 真正的边界：工具返回值的持久化快照（tool-runtime）

### 完成内容
- core 的消息、content、事件、用量类型全部改为 readonly；agent 的事件、inbox、`ContextCheckpoint` 也改为 readonly；会话数据、时间线、todo、goal、运行时事件、job summary 同样改为 readonly，并且一律通过整体替换来更新
- 新增 `AssistantMessageBuilder`，用结构共享构建流式消息，所有 provider 和 MockModel 都改用它
- loop 不再把流式消息写入 prepared context（原来的写入没有任何读取方）
- `Agent.state` 不再估算 token，改为调用方按需使用 `estimateContextTokens()`
- 用 readonly 消除共享可变对象之后，暴露出两处隐式依赖别名的代码，都已修正：
  - TUI 的 tool 详情检查器原来依赖 block 原地修改 args，现在改为渲染时读取实时数据
  - session journal 原来会修改调用方传入的 metadata
- 删除了约 15 个"修改返回值以验证隔离"的测试或断言，这一保证现在由 readonly 类型提供

### 与原设计的偏差
- 事件里的 `snapshot` 保留在 agent 层事件中：快照现在是结构共享的，没有拷贝成本
- subagent 的 `cloneSummary`（重建 Date 对象）留到阶段 6 合并任务注册表时处理
- `KanaSubagentProfile` 的 readonly 留到阶段 5：frontmatter 解析依赖原地赋值

### 细化设计（开工前写定）

**基线**（`bun run bench:agent-stream`，OpenAI-compatible adapter + Agent + 一个订阅者）：

| 场景 | 增量数 | 字符数 | 耗时 |
| --- | --- | --- | --- |
| 短回复 | 200 | 3,200 | 5 ms |
| 长回复 | 4,000 | 64,000 | 118 ms |
| 超长回复 | 12,000 | 192,000 | 1,042 ms |

增量数变为 3 倍时耗时约变为 9 倍，呈二次方增长。

**类型**
- `core` 的消息、content、事件、用量类型全部改为 readonly 字段，数组改为 `readonly T[]`
- `ModelContext.messages` 改为 `readonly Message[]`
- 试改时 tsc 报出 82 个写入点，全部是"正在构建的消息"或测试代码

**`AssistantMessageBuilder`（`core`）**
- provider 构建 assistant message 的唯一入口
- 内部持有 content 数组；每次增量**替换**发生变化的那个 content 块，不原地修改
- `snapshot()` 只浅拷贝 content 数组，开销为 O(块数)，与文本长度无关，未变化的块在新旧快照间共享
- 所有 provider 和 MockModel 都改用它，阶段 4 的 provider 共享层在此基础上继续建设

**事件**
- 快照变得廉价且不可变之后，事件里的 `snapshot` 不再有拷贝成本，所以保留现有结构，不做剥离（与原计划不同，原因同上）
- agent 把事件按引用发布给 listener 和 stream

**Agent 状态**
- `state.messages` 直接返回内部数组（追加时总是生成新数组，所以可以安全共享）
- `estimatedContextTokens` 每次读取都要遍历全部历史，改为单独的 `contextUsage()` 方法，调用方按需计算

**不在本阶段处理**
- `KanaConfig` 的拷贝：`applyAgentConfiguration` 依赖修改 draft，需要和阶段 5 的配置重写一起处理

### 已知事实
- 已提交的消息在 src 中从未被原地修改，唯一的修改点是 provider 正在构建的那条 assistant message
- provider 事件里的 `snapshot` 只有 `agent/loop.ts` 在读
- 每来一个 token，整条消息被深拷贝 5 次以上：
  1. provider 每个 delta 拷贝一次
  2. `loop.ts` 的 `emitMessageUpdate` 再拷一次，并且把带 snapshot 的 provider 事件原样转发
  3. `agent.ts` 给每个 listener 各拷一次
  4. `stream.push` 再拷一次
  5. TUI 的 `streaming-text-presenter` 每 16ms 一帧，又拷一次
- `Agent.state` 每次被访问都深拷贝全部历史并重新估算 token，而 TUI 状态栏只需要两个数字

### 任务
- [ ] 先写一个流式输出的 benchmark（长回复、大块 tool 参数两种场景），记录基线
- [ ] `core` 的类型全部改为 readonly：Message 及各类 content、AgentEvent、ContextCheckpoint、usage。让 tsc 找出所有写入点并逐一处理
- [ ] provider 只在内部维护可变消息；`snapshot` 只在 loop 内部使用，不再进入 agent 层的事件
- [ ] responses stream 改为只在 item 结束时解析一次 tool 参数，不再对每个 delta 解析不断变长的 rawArgs
- [ ] 删除下列位置上对已提交数据的拷贝：
  - agent、loop、inbox、context-manager、tool-runtime
  - HostedSessionRegistry、session journal、ConversationRuntime
  - jobs、subagents、user-tasks、wake-scheduler 的 listener
  - host 的 config getter，以及四个 store
  - `core/messages.ts` 中构造消息时的拷贝
  - TUI 的 presenter、editor setter、selected getter
- [ ] `Agent.state` 改为廉价的只读访问器（messages、contextUsage、isRunning 等），完整快照只在确实需要时才组装
- [ ] 删除或改写锁定拷贝行为的测试（在 tests 里 grep "clone"、"mutat"、"isolat"、"detached"、"snapshots mutable"）
- [ ] 再跑一次 benchmark，把前后对比记进决策记录

**完成标准**：`structuredClone` 只剩边缘场景（持久化、跨 worker）；benchmark 有明显改善。

---

## 阶段 3：Agent 运行时重构（已完成）

### 结果

| 文件 | 改造前 | 改造后 |
| --- | --- | --- |
| `agent.ts` | 1,000 行 | 638 行，另拆出 `settings.ts` 42 行、`steering.ts` 140 行 |
| `tool-runtime.ts` | 1,390 行 | 拆成 `tool-runtime/` 目录：runtime 334 行、invocation 393 行、results 162 行、nested 72 行、queues 49 行、types 约 60 行 |
| `context-manager.ts` | 768 行 | 597 行，另拆出 `token-estimate.ts` |
| `loop.ts` | 592 行 | 493 行 |

### 完成内容
- `resolveAgentSettings()` 在 Agent 构造时只运行一次，loop 和 ToolRuntime 直接使用解析结果；`agent.settings` 对外暴露
- 历史写入只有一条路径，有没有 journal 都逐条提交。`compact()` 复用 loop 的 `prepareWithCompaction`，统一顺序为"journal 写入 → hook → adopt"
- message ID 去重只保留两处：入口检查（prompt 与 inbox）和历史写入
- tool runtime：单个调用不再走快速路径，统一使用并行池；两段中断结果构建合并成一段；内部配置的运行时校验全部删除
- `sliceUtf8Prefix/Suffix` 移入 `utils`（agent 和 kana 共用）；schema coercion 缓存了 union 分支的编译结果
- 构造器的 4 条配置日志合并为 `agent.configured`
- 文档（agent-runtime、tools，中英文）已同步

### 与原设计的偏差
- 没有拆出 `AgentRun` 和 `history.ts`：拆出 steering 和 settings 之后，`runPrompt` 和历史写入与 Agent 的状态联系紧密，单独成类反而要传入大量内部状态。`agent.ts` 638 行，超出目标，但职责已经集中
- tools 层参数校验前的那次拷贝保留：typebox 的 `Value.Convert` 和 coerce 会原地修改，而输入来自模型输出，属于边界

### 细化设计（开工前写定）

**发现的结构问题**
- **两条持久化路径**：有 journal 时，消息逐条写入历史；没有 journal 时（clean 模式、记忆整理、btw），要等到 `agent_end` 才一次性追加。`compact()` 也因此分成了两个分支，两个分支对 hook 的调用顺序也不同
- **能力开关重复解析**：webSearch、imageInput、parallelToolCalls、maxParallel、deadline 在 Agent 构造器、loop、ToolRuntime 三处各解析一次
- **compaction 的事件和提交逻辑写了两份**：一份在 `compact()`，一份在 loop 的 `prepareModelContext`
- **message ID 去重守卫有 4 层**：构造器、`stream()`、`commitMessage`、`enqueueInput`，另外 inbox 自己还有一层
- **单个工具调用有一条独立的快速路径**，它的行为与"大小为 1 的并行池"完全相同

**目标结构**（`src/agent/`）
- `agent.ts`：门面，负责构造、状态访问、订阅、prompt/stream/compact/abort、steering API，以及 reset
- `settings.ts`：`resolveAgentSettings()`，所有能力开关和默认值在这里**只解析一次**，loop 和 ToolRuntime 直接使用解析好的结果
- `run.ts`：`AgentRun`，负责一次运行的编排，包括 journal 的开始和结束、调用 loop、提交 hook、阶段跟踪
- `history.ts`：唯一的历史写入入口，有 journal 就写 journal，然后追加到历史并做 ID 去重。两种模式都逐条提交，不再区分
- `steering.ts`：`SteeringQueue`，统一管理 inbox、steering resolver、正在提交中的 ID，以及 inbox 的 listener
- `events.ts`：保留事件类型，新增 `logAgentEvent()`（事件到日志的映射）
- `loop.ts`：只负责 turn 循环。compaction 统一为一个 `compactContext()`，`compact()` 也复用它
- `tool-runtime/` 目录：
  - `runtime.ts`：`ToolRuntime`，负责分组、并行池、按模型顺序提交
  - `invocation.ts`：单次调用的完整生命周期，包括校验、审批、执行、deadline、中断和宽限期、`run_code` 审批时暂停计时
  - `nested.ts`：codemode 的嵌套调用调度
  - `results.ts`：结果构造函数、policy 流水线、持久化快照
  - `queues.ts`：串行事件队列和串行任务队列

**行为变化（有意为之）**
- 没有 journal 时，消息也逐条进入 `state.messages`，不再等到 run 结束。两种模式从此一致
- 删除单数形式的 `toolResultPolicy` 配置项（Agent 内部本来就会把它合并进复数形式的列表）
- 删除对内部配置的运行时校验（maxTurns、deadline、concurrency、policy 返回值等），改由类型约束

- [ ] `Agent` 改成门面，内部拆为：
  - `AgentRun`：负责 stream、journal 顺序、提交、compaction。目前 compaction 的提交写了三遍，合并成一处；`context_compaction_*` 事件也只在一处构建
  - `SteeringQueue`：基于 inbox。message ID 去重目前有 4 层守卫，只保留一层
  - `EventHub`：负责 publish、reduce 和日志
  - 配置解析：maxParallel 和 deadline 目前在 agent、loop、tool-runtime 三处各解析一次，模型能力的 gating 目前有 4 处，都只保留一处
- [ ] tool runtime 拆为三部分：
  - `ToolScheduler`：分组和并行池。单个调用的快速路径并入池子，大小为 1 的池子就是同一套逻辑
  - `ToolInvocation`：执行、超时、审批，以及 `run_code` 的特殊处理
  - `ToolResultFinalizer`：policy、持久化快照、结果构造
- [ ] 合并 tool runtime 里的重复："publish 再 commit"有 4 处；"unknown outcome"和 interrupted result 的构建各有两份
- [ ] 删除内部校验：`resolve*` 系列、`assertValidToolResultPolicies`、`parseToolResultPolicyResult`（policy 是项目自己的代码，靠类型约束即可）
- [ ] 删除单数形式的 `toolResultPolicy` 通道
- [ ] loop 中三个几乎相同的"如果已中止就结束，否则抛出"包装函数，合并成一个
- [ ] context-manager 中重复的预算检查合并
- [ ] tools 层：
  - `tools/validation.ts` 对参数重复做了 clone 和 coercion
  - `json-schema-coercion` 每次调用都会重新编译 schema，没有走缓存
  - `tools/result.ts` 对已经有类型的值又规范化了一遍

**完成标准**：agent 目录内没有超过约 500 行的文件；agent 现有的行为测试全部通过。

---

## 阶段 4：Provider 重构

- [ ] 建立共享层：
  - HTTP 基础：signal、URL 拼接、HttpError、retry 循环（各 provider 只提供是否重试的判断；Codex 的 401 刷新作为钩子）、`isAbortError`
  - SSE reader：补上 cancel 和 releaseLock，`JSON.parse` 出错时给出明确的错误
  - 模型 run 的生命周期：requestStarted → 执行 → requestFailed → stream.error → dispose
  - 错误规范化：context-window 判断、错误码提取
- [ ] Responses 协议的请求转换只保留一份。目前 deepseek 和 openai-codex 有 9 对函数相同或几乎相同，差异只有 namespace、strict 和是否回放 reasoning，改为配置项
- [ ] 删除 `openai-codex/stream.ts` 这种纯转发文件，以及三个 http.ts 里的别名导出
- [ ] max output token 的校验统一
- [ ] **行为统一**：模型给出非法的 JSON 参数时，`parseToolArguments` 统一返回原始字符串，这样校验报错能指出 JSON 本身无效。目前 openai-compatible 返回原始字符串，responses 返回 `{}`，两者不一致。补充对应的测试

**完成标准**：每个 provider 目录只剩它和其他 provider 的差异部分；provider 测试全部通过。

---

## 阶段 5：解析与持久化

- [ ] 在 `utils` 中提供 `parseWithSchema(schema, raw, label)`，带编译缓存，报错格式为"字段路径 + 原因"
- [ ] **config**：
  - 字段只定义一次，从中派生 typebox schema、默认值、snake↔camel 映射和 TOML 叶子路径
  - 删除 `toRawKanaConfig`、`mergeKanaConfig`、`CONFIG_FIELDS` 三份手写映射
  - reconfigure 只校验一次
  - 跨字段规则作为解析后的检查保留
- [ ] 各种格式都改成 schema：
  - mcp.json、mcp-enabled.json、custom.toml、approvals、skills.toml
  - oauth-tokens.json、theme、GitHub release
  - session JSONL 条目：替换 `session/format.ts` 中约 250 行的手写守卫
  - accounting JSONL：坏记录写日志后再跳过，不再静默丢弃
- [ ] frontmatter 只用一个通用读取器，skills、subagent profiles、prompt templates 各自用 schema 定义宽松或严格
- [ ] 持久化基础设施各只留一份：原子写文件（现在 4 份）、串行化队列（4 份）、文件锁的重试策略（2 份）。`persistence.ts` 中非原子的写入也改用这一份
- [ ] 四个 store（config、tool-approval、skills、mcp-configuration）统一成一个 snapshot store 模式。修复 `tool-approval` 的 store 丢弃磁盘合并结果、导致与文件不一致的问题
- [ ] activation state 只解析一次

**完成标准**：旧的 config、session 和本地文件都能读取（现有的 fixture 测试全部通过）；`asRecord` 和 `readX` 系列全部删除。

---

## 阶段 6：产品层

### 能力与会话
- [ ] 引入 `KanaCapabilities`，消除 26 处 `launchMode === "clean"` 判断；去掉 registry 中每个 session 各存一份的 `persistent`
- [ ] 提供 `KanaConversationHost.createRuntime(frontendOptions)`：
  - 三个前端不再各写约 20 个回调
  - user task 目前有两道开关，合并成一个
  - 删掉 host 中纯转发的方法和只调用 `new` 的工厂函数
- [ ] 理清 `HostedSessionRegistry` 和 host 的职责：host 负责能力装配，registry 负责会话的生命周期
- [ ] accounting 的"记录并吞掉错误"目前有 3 份；MCP 统计有 2 份；SIGINT 退出码 130 算了 3 次。各合并成一处

### 任务注册表
- [ ] 在 `jobs` 中实现 `OwnedTaskRegistry`，background job 与 subagent 都基于它实现：
  - 合并冗余的标志
  - `closedOwners` 不再只增不减
  - producer 的启动方式统一
- [ ] 状态拼写统一为 `canceled`。先检查 subagent journal 和工具输出中是否出现过 `cancelled`；如果出现过，读取时要兼容旧值
- [ ] input-coordinator 改用 `CompletionSource` 接口，统一 job、subagent、user task 三组 observe 和 handle 逻辑

### OAuth / MCP
- [ ] OAuth 规则集中到一处，包括过期提前量、binding 检查、拒绝码、auth method 列表。拒绝码目前一处列了 4 个、一处列了 6 个，以 Codex 实现中的 6 个为准，核对后统一
- [ ] 诊断直接写 Logger，删除层层回调
- [ ] MCP 关闭目前最多有 5 层幂等保护，只在所有者那一层保留；各处重复的 env 拷贝也删掉
- [ ] `kana/mcp` 和 `mcp` 之间的职责重新划分：include/exclude 列表目前拷贝了 3 次，工具名校验有 2 份

**完成标准**：三个前端的启动代码只剩自己的差异部分；`kana` 下不再有模式判断。

---

## 阶段 7：前端

- [ ] headless 和 server：在 `createRuntime` 的基础上精简，各自只保留 I/O 投影
- [ ] 删除 headless 和 server 中只是转发的函数，以及冗余的标志
- [ ] TUI：
  - `OverlayHost` 替代 `app.ts` 中 8 个手写的 `openX()` 和 `closeOtherOverlays`，顺带修复漏关 overlay 的 bug。"运行中不能打开"的规则统一处理
  - 引入 overlay controller 基类，统一 open、close、focus 恢复和 refresh
  - 引入 `ListPicker`，合并 7 个列表组件里重复的导航和视口代码
  - editor 和 text-prompt 共用输入帧
  - 拆分 `app.ts`：装配、事件投影、提交（submit 和 queue 目前有重复）、生命周期
  - 拆分 `editor.ts` 和 `editor/state.ts`：预览、palette、history、boundaries、paste-display、reducer
  - 拆分 `render/latex.ts`：symbols 数据、layout、parser、environments
  - 拆分 `tools/format.ts`：措辞表、output、target、todo
  - 合并相同的运行生命周期（memory-compact 和 local-shell）和重复的重置逻辑（session 的 startNew 和 resume）
- [ ] 决定前端是否只能依赖 `kana` 加 L0，然后更新分层规则

**完成标准**：TUI 中没有超过约 500 行的文件（latex 的符号表数据文件除外）；手动冒烟测试通过。

---

## 阶段 8：收尾

- [ ] 对照最终代码通读 `docs/`，中英文一起改。删掉已经过时的描述，更新 `docs/README` 的索引
- [ ] 重新审视 AGENTS.md：保留合理的约定，删除或修改 Codex 时期引入、并且和新结构冲突的部分
- [ ] 全仓库再扫一遍残留：重复的 helper、拷贝、多余的守卫
- [ ] 删除本文件

---

## 通用验证

- `bun run check`：biome、注释长度、分层边界、tsc、knip、bun test
- 手动冒烟测试：
  - `bun run start`：新会话、resume 旧会话、fork、/mcp、后台 job、subagent、overlay 切换、长回复的流式输出
  - `kana exec --json "…"`：检查 headless 的 JSONL 输出
  - `KANA_SERVER_TOKEN=… kana serve`：检查 HTTP API 和 SSE
- 涉及持久化的阶段（2、5、6）：用改动前版本生成的 session 和配置文件，验证能正常 resume

## 已知 bug

| 问题 | 位置 | 阶段 |
| --- | --- | --- |
| finally 中 close 抛错会覆盖原本的结果 | `mcp/oauth-http-authorizer.ts` | 1 |
| 流式输出的开销是 O(n²) | provider、loop、agent、presenter | 2 |
| SSE reader 没有 cancel/releaseLock | `openai-compatible/stream.ts` | 4 |
| `parseToolArguments` 在不同 provider 之间行为不一致 | 两个 stream | 4 |
| store 的快照可能与磁盘文件不一致 | `kana/tool-approval.ts` | 5 |
| `closedOwners` 只增不减 | jobs、subagents | 6 |
| 刷新被拒的错误码列表两处不一致 | oauth、openai-codex | 1/6 |
| `closeOtherOverlays` 漏关 overlay | `tui/app/app.ts` | 7 |

## 决策记录

- 2026-10-11：开启 `noUncheckedIndexedAccess`
- 2026-10-11：模块边界从两两白名单改为分层规则；`utils` 改为无依赖的叶子模块
- 2026-10-11：用户授权不受原有约束限制。兼容性决策见上文表格
- 2026-10-11：全部阶段完成后统一提一个 PR，中途不合并
- 2026-10-11：logger 不会抛异常，因此删除"logger 抛错时流程不受影响"这类测试
- 2026-10-11：跨模块的错误与 ID 工具放 `utils`，TUI 内部的格式化工具放 `tui/render`
- 2026-10-11：阶段 2 起，内部数据一律使用 readonly 类型并通过整体替换来更新；拥有可变状态的类，用不可变更新替换自己持有的引用，不再引入 Writable 类型
- 2026-10-11：调用真实模型的冒烟测试需要先征得用户同意。shell 环境变量里带有 provider 凭据，隔离的 KANA_HOME 也会真的请求模型
