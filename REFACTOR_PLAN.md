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
| 4 | Provider 重构 | 已完成 |
| 5 | 解析与持久化 | 已完成 |
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

## 阶段 4：Provider 重构（已完成）

### 结果
- providers 目录：3,860 行 → 约 3,190 行；三个 provider 的 model 文件分别为 125、139、221 行
- 删除了 `deepseek/http.ts`、`openai-compatible/http.ts`、`openai-codex/stream.ts`；`openai-codex/http.ts` 只保留 URL、可重试判定和恢复提示
- 新增共享模块：`run.ts`（请求生命周期）、`sse.ts`、`tool-arguments.ts`、`responses/request.ts`
- 三份 HTTP 错误类、三个重试循环、两套 SSE 读取、两套 Responses 消息转换，各合并为一份
- Codex 的 HTTP 重试和流恢复共享同一个重试预算，保持原有行为（测试覆盖了这一点）
- 删除 DeepSeek 未使用的配置项，以及 core 里的通用 `ModelConfig`；provider 内不再重复检查模型能力
- 顺带清理了阶段 1 延后的几处：`terminalSeen` 并入 `stopReason`；finish reason 在入口处收窄为联合类型，映射函数不再需要 default 分支
- 回放合并时的深拷贝改为浅拷贝
- HTTP 相关测试合并到 `tests/providers/http.test.ts`，在共享层测试一次
- 文档（providers、deepseek-provider，中英文）已同步

### 细化设计（开工前写定）

**共享层**（`src/providers/` 根目录）
- `http.ts`：
  - `ProviderHttpError`：一个类替代三个，统一截断 body，解析 OpenAI 格式的错误码、param 和 request id
  - `fetchWithRetries(url, init, options)`：一个重试循环替代三个，统一支持 `Retry-After`；provider 可以自定义"是否重试"，Codex 的 401 刷新凭据通过 `refreshOn401` 钩子实现
  - 原有的 request signal 和 backoff 工具保留
- `sse.ts`：`readSseJson()`，统一的 SSE 读取，包含 cancel/releaseLock、无效 JSON 的包装错误、`[DONE]` 处理
- `run.ts`：`streamProviderRequest()`，统一 run 骨架：builder、阶段跟踪、诊断、错误规范化、done/error 事件。每个 provider 只需写"发请求、读流"这一段
- `lifecycle.ts`：新增 `describeProviderFailure()`，统一错误码分类；新增 `toContextWindowError()`、`assertOutputLimit()`
- `tool-arguments.ts`：`parseToolArguments()` 只保留一份

**Responses 协议**（`responses/`）
- `request.ts`：消息和工具转换只保留一份，差异通过选项注入：
  - `replayReasoningText`：DeepSeek 为 true，Codex 为 false
  - `namespace`：Codex 为 `kana`
  - `stateless`：Codex 回放时去掉 item id
  - `strictTools`
- stream processor 新增 `ignoredEventTypes` 选项，替代 Codex 那个只为忽略 `response.done` 而写的子类
- deepseek 和 openai-codex 只保留顶层请求参数、认证和各自的特殊行为（Codex 的流恢复、DeepSeek 的 action 标记清理）

**provider 内不再重复 gating**：webSearch、imageInput、parallelToolCalls 已由 `AgentSettings` 按模型能力解析过

**行为变化（有意为之）**
- 非法 JSON 的 tool 参数统一保留原始字符串（原来 responses 返回 `{}`），校验报错能指出 JSON 本身无效
- DeepSeek 的重试也遵循 `Retry-After`
- 跨 provider 回放 assistant 文本时统一使用标准的 `output_text` 结构（带 status 和 annotations）
- Codex 也校验单次请求的输出上限

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

## 阶段 5：解析与持久化（已完成）

### 结果

本阶段 src 加 tests 净减少约 1200 行（+1499 / −2703）。

| 文件 | 改造前 | 改造后 |
| --- | --- | --- |
| `config/parser.ts` | 666 行 | 178 行 |
| `config/store.ts` | 268 行 | 172 行 |
| `mcp/config.ts` | 534 行 | 312 行 |
| `session/format.ts` | 647 行 | 523 行（大部分是 schema 声明） |
| `custom-provider.ts` | 332 行 | 230 行 |

### 完成内容
- `utils` 中新增：
  - `parseWithSchema`，统一错误格式为 `<文件>.<字段路径> <原因>.`，未知字段统一报 `contains unknown field X`
  - 公共构造器 `strictObject`、`nonEmptyString`、`positiveInteger`
  - `writeFileAtomic`
  - `SerialTaskQueue`（从 agent 移入）
- config.toml、mcp.json、MCP 激活状态、approvals、skills.toml、custom.toml、oauth-tokens.json、TUI 主题、session JSONL、accounting 记录全部改为 schema 校验，`asRecord` 和 `readX` 系列全部删除
- core 导出 `USER_IMAGE_SCHEMA`、`TOOL_RESULT_ARTIFACT_SCHEMA`、`MODEL_USAGE_SCHEMA`，原来的守卫函数改为基于 schema；session 和 accounting 直接复用它们
- `KanaConfig` 改为 readonly：
  - 修改配置统一用 `KanaConfigDraft`，只有 store 和 host 的 clean 模式各做一次拷贝
  - host 的配置 getter 和各 store 不再拷贝
- 三处 frontmatter 解析合并为 `kana/frontmatter.ts` 中的一个读取器，字段规则由各自的调用方决定
- accounting 读取：其他版本的记录静默跳过；损坏的记录写 `accounting.record_skipped` 日志后跳过
- 原子写只保留一份，`persistence.ts` 也改用它
- 串行队列只保留一份：token store、MCP runtime、记忆合并队列、tool approval 共用 `SerialTaskQueue`
- `structuredClone` 从 37 处降到 8 处，剩下的都在真实边界上：工具参数转换、hook 返回值、MCP 服务端能力、持久化快照，以及两个 config draft

### 与原设计的偏差
- tool-approval store "与文件不一致"并不是 bug：四个 store 采用同一个语义（内存快照只在启动时读取，写入时与磁盘合并），是有意为之。所以只删除了拷贝，没有引入通用的 store 抽象，每个 store 现在大约 15 行
- 文件锁保留两种实现：config 是同步锁；token store 需要异步锁，并且要跨越网络操作持有，两者无法合并
- GitHub release 的解析保持手写：代码很短，而且每个错误都带有更新流程需要的失败码
- `assertContextCheckpointForAppend` 已删除：checkpoint 由 agent 内部生成，journal 中真正的不变量检查（顺序、引用）仍然保留
- 用户可见的错误文案有小幅变化（例如 `Unknown config field: x` 改为 `config.x contains unknown field ...`），测试已同步更新

### 细化设计（开工前写定）

**`parseWithSchema(schema, value, label)`（`utils`）**
- typebox 编译后按 schema 缓存；失败时只报第一条错误，格式为 `<字段路径> <原因>.`，与现有错误风格一致
- schema 节点可以带 `errorMessage`，用来保留现有的文案（例如 "must be -1 or a positive integer"）；没有时按 keyword 生成默认文案：类型、枚举（"must be one of: …"）、未知字段（"Unknown <label> field: <路径>."）、缺少字段
- 只做结构校验。跨字段规则和语义检查（URL、header、重复项）写在解析后的普通函数里
- tools 的参数校验仍保留自己的格式化：它面向模型，需要列出所有错误

**config.toml**
- 文件格式只写一份 typebox schema（snake_case 键，全部可选，禁止未知字段）
- 解析流程：schema 校验 → 通用的 snake→camel 转换并叠加到 `DEFAULT_KANA_CONFIG` 上
- 反方向（启动覆盖项、store 写回）也用同一个通用转换；store 要修补的 TOML 叶子从 schema 遍历得到
- 由此删除 `toRawKanaConfig`、`mergeKanaConfig`、`CONFIG_FIELDS` 和约 20 个 `readX`
- `contracts.ts` 中手写的类型保留，作为可读的契约文档，并全部改为 readonly
- `KanaConfigStore.update(change: (config) => KanaConfig)`：去掉 draft 和多余的拷贝。`applyAgentConfiguration` 改为返回新 config
- store 写入后重新解析文件这一步保留：它校验的是"行级 TOML 修补"有没有生效，不属于重复校验

**其他格式**：mcp.json、mcp-enabled、custom.toml、approvals、skills.toml、oauth-tokens、theme、GitHub release、session 条目都按上面的方式处理：用 schema 做结构校验，再接语义检查。每个格式迁移时单独核对错误文案，测试改为断言字段路径

**持久化基础设施**：`utils` 中保留一份 `writeFileAtomic`；文件锁的重试和串行化队列各保留一份，放在 `kana` 内部共享

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

## 阶段 6：产品层（已完成）

### 结果

本阶段 src 加 tests 净减少约 370 行（+1092 / −1460）。分支累计相对 main 净减少约 4700 行。`launchMode === "clean"` 的判断从 26 处降到 14 处，剩下的集中在 TUI（阶段 7 处理）、启动入口和 prompt 装配。

### 完成内容
- **任务注册表**：`jobs/owned-tasks.ts` 中新增 `OwnedTaskRegistry`，负责准入、settlement、waiter、observe、prune、close。background job 和 subagent 只保留各自的负载：job 的输出缓冲区，subagent 的结果。closed owner 改用 `WeakSet` 记录，不再无限增长；事件统一为 `{ type, owner, task }`
- **CompletionSource**：input-coordinator 中 job、subagent、user task 三组 observe/handle/pause 合并为一个接口，加三个适配器；toPendingInput 中重复的 provenance 守卫删除
- **能力**：
  - host 用 `customizations`（skills、MCP 配置 store）和 `persistent` 表达 clean 模式；`??=` 死代码和 `assertCustomizationsAvailable` 删除
  - registry 不再在每个 session 上存一份 `persistent`，改为 registry 级别的一个开关
- **runtime 装配**：
  - host 提供 `runtimeOptions` 和 `createRuntime(frontend)`；server 和 headless 各自约 30 行的装配代码改为一次调用，TUI 直接展开 `runtimeOptions`
  - user task 只剩 host 的 `enableUserTasks` 一道开关
  - host 上 9 个纯转发方法删除
- host 中 accounting 的"记录并吞掉错误"合并为 `recordAccounting`；headless 中重复的 MCP 就绪日志删除（host 已经记录过 `mcp.started`）；130 改为具名常量 `SIGINT_EXIT_CODE`
- **OAuth**：刷新提前量、token 状态计算、auth method 列表集中到 `oauth/token.ts` 和 `oauth/types.ts`
- **MCP**：删除 adapter 和 runtime 中多余的幂等标志，以及 registration 和 server config 的防御性拷贝和重复校验

### 与原设计的偏差
- 状态拼写统一为 `cancelled`（用户确认不需要兼容）：subagent、goal、job、hosted tool、tool runtime、codemode、日志事件名、错误类名和文案全部使用这一种拼写。这与外部协议一致（OpenAI Responses 状态、codemode 沙箱库），不需要在边界上转换
- 拒绝码"一处 4 个、一处 6 个"的问题，在阶段 1 删除 `OAuthSession` 后已不存在
- TUI 的 `KanaTuiApp` 构造器仍然注入 createAgent 和会话回调（大量 TUI 测试依赖这种注入方式），拆分 `app.ts` 时在阶段 7 一起调整
- OAuth 诊断回调保留：它把授权进度显示到 TUI，是展示用途而不是日志

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

## 阶段 7：前端（已完成）

### 结果

本阶段 src 加 tests 净减少约 260 行（+2465 / −2725，其中大部分是文件拆分带来的移动）。分支累计相对 main 净减少约 4900 行。

| 文件 | 改造前 | 改造后 |
| --- | --- | --- |
| `app.ts` | 1,259 行 | 1,134 行 |
| `editor.ts` | 1,053 行 | 752 行，另拆出 `previews.ts`、`input-frame.ts` |
| `editor/state.ts` | 844 行 | 311 行，另拆出 `text-state.ts`、`boundaries.ts`、`display.ts` |
| `render/latex.ts` | 1,575 行 | 拆成 `latex/` 目录：symbols 629、parser 738、layout 268、index 57 |
| `tools/format.ts` | 572 行 | 410 行，另拆出 `wording.ts` |

### 完成内容
- `ListViewport.handleNavigationKey` 替代 7 个列表组件中重复的导航按键分支
- overlay 互斥改为 `openOverlay` 和 `closeOverlays` 一条路径；"运行中不能打开"由 `idleOnly` 统一处理。修复 resume picker 打开时不关闭 MCP 管理面板的 bug，并补了回归测试
- 9 处多余的 `restoreFocus` 计算删除（`restore()` 的默认参数已经计算了焦点）
- app：运行输入的 transcript 视图移到 `run-input-view.ts`；`submitPrompt` 和 `queuePrompt` 共用 `createPromptInput`；按 session 取资源统一为 `forActiveSession`；clean 模式提示统一为 `unavailableInCleanMode`
- editor 与 text-prompt 共用 `input-frame.ts`（插入、粘贴、纵向移动、光标行渲染）；editor 的 Enter 和 Tab 共用 `createSubmit`；三个预览区由同一个 `renderSection` 渲染
- local shell 和 memory compact 共用 `AuxiliaryRun`；session 的 new 和 resume 共用 `showSession`

### 与原设计的偏差
- 没有引入 `BottomPanelSlot`：各 overlay controller 的 open 流程差异较大（交出焦点、替换面板、确认弹窗等），真正重复的只有焦点恢复计算，删掉即可
- `app.ts` 没有降到 600 行：剩余部分主要是构造器中对约 30 个 controller 的线性装配，以及按键和事件分发。进一步拆分需要引入共享上下文对象，并改动所有 controller 的选项类型和大量直接访问 app 内部字段的 TUI 测试，收益不足
- `latex/parser.ts` 保持 738 行：它是一个内聚的解析器类，拆分环境渲染只会把私有方法散到多个文件
- headless 和 server 已经在阶段 1 和阶段 6 精简过；server api 的 `closed` 用于在关闭期间拒绝请求，不是冗余标志
- 分层规则保持不变：前端对 `agent`、`mcp`、`jobs` 等模块的依赖主要是事件协议类型；运行时依赖只有 btw 旁路对话、本地 shell 和图片工具，都是 TUI 自身的功能。现有的分层方向已经能防止反向依赖

### 细化设计（开工前写定）

**列表导航**：9 个列表组件已经共用 `ListViewport`，真正重复的是每个组件里约 30 行的按键分支（上下、翻页、Home/End）。给 `ListViewport` 加一个 `handleNavigationKey(data, length)`，返回是否处理了按键，组件只保留各自特有的按键。这比引入一个 `ListPicker` 基类更轻，渲染部分仍由各组件自己负责

**底部面板**：overlay controller 共有的"显示面板、关闭时恢复焦点、释放订阅"改为组合式的 `BottomPanelSlot<T>`，替代每个 controller 手写的 `manager?` 字段、`active` getter 和 close 逻辑。不用继承基类，因为各 controller 的 open 流程差异较大

**overlay 互斥**：app 中维护一份 overlay 列表，`openOverlay(target)` 先关闭其他所有 overlay 再打开目标，替代 8 个手写的 `openX()` 和 sessions 的 `closeOtherOverlays`（后者漏关 MCP 管理面板）。会修改 Agent 配置的 overlay（Skills、MCP）标记为"运行中不可打开"，统一在 `openOverlay` 中检查

**app.ts 拆分**：
- 会话事件投影（`handleConversationEvent` 及格式化函数）移到 `conversation-event-view.ts`
- `submitPrompt` 与 `queuePrompt` 共用输入校验和消息构造
- 斜杠命令接线移到单独文件
- 目标：app.ts 降到约 600 行。控制器装配本身是线性代码，继续拆分只会增加间接层

**大文件拆分**：editor（预览、palette、history）、editor/state（reducer 与边界计算）、render/latex（符号表数据单独成文件）、tools/format（措辞表）

**其他**：memory-compact 与 local-shell 的运行生命周期合并；session 的 startNew 和 resume 中相同的重置逻辑合并；headless 和 server 删除转发函数和冗余标志

**分层**：前端（tui、headless、server）是否只能依赖 `kana` 加 L0，在完成后根据实际 import 决定

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
