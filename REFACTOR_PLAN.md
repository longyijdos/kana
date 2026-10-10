# Kana 精简重构计划

> 这是一份工作文档，所有阶段完成后删除。工作分支是 `refactor/simplify`，每完成一个阶段就把它合并进 `main` 一次。
> 文中的行号来自制定计划时的代码，会随修改漂移，以函数名或符号名为准。

## 背景

项目大部分在 Codex 辅助下开发，留下了大量防御性编程和冗余：src 中约有 300 处 `structuredClone`，同一个 helper 往往有 5 到 8 份拷贝，约 50 个配置字段被手写了三遍，三个前端各自手写同一套接线代码。

根因只有一个：**没有划清信任边界**。系统内部的数据也被当成不可信输入，所以每一层都在深拷贝、重新校验、包 try/catch、加幂等标志。

**原则**：只在边缘做运行时校验，内部依赖 TypeScript 类型。

- **边缘**：TOML/JSON 配置、session JSONL、HTTP 请求、模型 SSE 流、工具参数、OAuth/MCP 响应
- **内部**：模块之间的调用、项目自己写的 policy/hook、已经解析过的配置
- 已提交的 `Message` 视为不可变值，用 `readonly` 类型来表达。唯一允许原地修改的，是 provider 流里正在构建的 assistant message

## 工作约定

- **冻结的外部契约**，以下内容不得改变：
  - `config.toml` 的字段与默认值
  - session JSONL 持久化格式
  - headless JSONL 输出协议
  - HTTP server API
- 每个阶段结束前必须通过 `bun run check`。阶段内部的提交可以更小，但每个提交都要能通过 pre-commit
- 提交信息使用 Conventional Commits（`refactor:`、`fix:`、`test:`、`perf:` 等），不加任何 attribution
- 测试：
  - 只锁定防御性行为的测试（例如 "deep-clones…"、"isolates listener mutations…"、"snapshots mutable values supplied by callers"）可以删除或改写
  - 验证真实行为的测试必须保留
- 分层限制（以 `scripts/source-boundaries.ts` 为准）：
  - `oauth` 不能 import 任何其他模块
  - `providers` 只能 import `core` 和 `logging`
  - `mcp` 只能 import `oauth` 和 `tools`
  - `kana` 不能 import `utils`
  - 需要跨模块共享的 helper 优先放进 `core`
- 文档：只有当改动会让 `docs/` 中的规范文档变得不准确时才更新，并且中英文两个版本同步修改
- 每个阶段开始前，先把这份计划里该阶段的"待决定"事项定下来

## 进度

| 阶段 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| 1 | 删除死代码，合并重复 helper | 低 | 未开始 |
| 2 | 前端接线统一，TUI overlay 管理 | 低-中 | 未开始 |
| 3 | 不可变消息，清理防御性拷贝 | 中 | 未开始 |
| 4 | Provider 共享层 | 中 | 未开始 |
| 5 | 后台任务注册表 | 中 | 未开始 |
| 6 | schema 化解析 | 中-高 | 未开始 |
| 7 | 信任边界、Capabilities、拆分大文件 | 中 | 未开始 |

---

## 阶段 1：删除死代码，合并重复 helper

**目标**：纯删除和合并，不改变任何行为。

### 死代码
- [ ] 删除 `OAuthSession`（`src/oauth/session.ts`）及 `tests/oauth/session.test.ts` 中对应的测试，只保留 `OAuthSessionStatus` 类型（`kana/auth/openai-codex.ts` 在用）。同时删除 `getAccessToken`、`createLinkedAbortController` 等只为它服务的代码
- [ ] 删除 `validateToolCall`（`src/tools/validation.ts`），它没有调用方
- [ ] 删除 `McpServerCatalogEntry`（`src/mcp/manager.ts`）
- [ ] 确认 `loadKanaMcpServerActivations`、`saveKanaMcpActivationState`、`DEFAULT_KANA_MCP_CONFIG`、`DEFAULT_KANA_MCP_ACTIVATION_STATE` 这几个"只被测试使用"的导出，判断是删掉还是改为内部可见
- [ ] 清理 TUI 中只被测试使用的 barrel 导出，以及只在本文件内使用的 `export`
- 背景说明：knip 把测试文件也算作入口，所以发现不了只被测试使用的导出。是否调整 `knip.json` 留到阶段末再决定

### 合并重复的 helper
- [ ] `isRecord`（8 份）：放进 `core`，providers、kana、tools 改为引用这一份。`oauth/client.ts` 和 `mcp/protocol.ts` 因为分层限制保留自己的副本
- [ ] `asRecord` 和 `assertKnownKeys`：阶段 6 会整体替换掉，本阶段只合并完全相同的副本（mcp/config、mcp/activation、auth/token-store、tui/themes/parser）
- [ ] `getErrorType`（6 份）和 `getErrorCode`（3 份）：在 `logging` 里导出一个 `errorFields(error)`，返回 `{ errorType, errorCode }`
- [ ] `formatError`（4 份）和 37 处内联的 `instanceof Error ? .message : String()`：统一成一份
- [ ] `readPositiveInteger` 和 `readNonNegativeInteger`：先合并 jobs/manager 与 subagents/manager 之间完全相同的两份（配置解析部分留到阶段 6）
- [ ] `throwIfAborted`（4 份）：改成直接调用 `signal.throwIfAborted()`，或者共用一个基于 ToolContext 的版本
- [ ] TUI 的格式化函数，各合并为一份：
  - `formatByteSize` 和 `base64ByteLength`
  - 单行清理函数，8 份完全相同：`sanitizeLabel`、`formatSingleLine`、`singleLine`、`formatLabel`
  - shortId 系列（含前缀）
  - `pad2`、`formatInteger`、`setsEqual`、`formatDescription`、`readObjectArrayLength`（复用 `tools/properties.ts` 里的 `getArrayProperty`）
  - `capitalize`、`clamp`
  - `splitLines`（把 6 处换行规则不一致的内联写法统一过去）
- [ ] `copyStoredToken`（session.ts 与 token-store.ts 各一份）：删除 OAuthSession 之后自然只剩一份
- [ ] `validateName` 和 `unquote`（prompts/templates 与 subagents/profiles 中完全相同的副本）
- [ ] `MAX_WAIT_MS = 30_000`（tools/background-jobs.ts 与 kana/tools/subagents.ts 各一份）

### 多余的保护代码
- [ ] 删除所有在 logger 外面再包一层 try/catch 的 `private log()`。`SessionLogger.write` 内部已经吞掉了异常。涉及的位置：
  - `agent.ts`、`tool-runtime.ts`、`context-manager.ts`
  - `conversation/runtime.ts`、`input-coordinator.ts`
  - `providers/lifecycle.ts`、`headless/run-lifecycle.ts`
  - `kana/mcp/manager.ts`、`kana/mcp/oauth.ts`、`kana/auth/browser.ts`、`token-store.ts`、`openai-codex.ts`
  - 注意：包在**用户回调**外面的 try/catch 要保留
- [ ] 删除不可能触发的分支：
  - `agent.ts` 中 `runWithSteeringLifecycle` 的 `!this.activeRun` 检查，以及 `runWithLifecycle` 中重复的 activeRun 检查
  - `loop.ts` 中循环结束后的 `response.result()` 兜底，以及 `event.snapshot ??` 兜底
  - `subagents/manager.ts` 在 cancel 分支里那次结果必然为空的 `inspect` 调用
  - jobs/subagents 中 waitForChange 和 waitForSettlement 里的 immediate-finish 分支
  - provider 在 `terminalSeen` 之后才做的 stopReason/state 检查
  - `responses/stream.ts` 在类型过滤之后的 `else return`
  - `getOpenAICompatibleDoneReason` 里永远走不到的 default throw
- [ ] 删除冗余的幂等标志：headless `run-lifecycle` 的 `listening`、`runner.ts` 的 `settled`
- [ ] host.ts 的 `getMcpConfigurationStore` 和 `getSkillStore` 中的 `??=` 是死代码，删掉
- [ ] TUI 中约 20 处不可能触发的检查，清单见阶段 1 附录
- [ ] 待决定：要不要开启 `noUncheckedIndexedAccess`。开启后数组下标守卫才真正有意义；不开启的话，就把这些守卫删掉

### 顺带修复
- [ ] `mcp/oauth-http-authorizer.ts` 的授权流程里，`finally` 中的 `await this.callbackServer?.close()` 没有 catch，close 抛错会覆盖原本的结果或错误。改成和 `openai-codex.ts` 一样吞掉并记录日志

**完成标准**：`bun run check` 通过，没有行为变化，生产代码净删除行数可观。

### 阶段 1 附录：TUI 中不可能触发的检查
- `app.ts` 的 `canStartQueuedRun` 里，对非可选字段（scheduledMessageManager、backgroundJobManager、subagentManager）用了 `?.`
- `notification-controller.ts` 把 `onAgentCompleted` 检查了两次
- `mcp-lifecycle-controller.ts`：
  - `load === undefined` 与 `loaded` 的初始值重复
  - `loadingOperation`、`loadingController`、`isLoading` 三个字段总是同时设置、同时清除，可以合并成一个可空的状态对象
- `tool-approval-controller.ts`：
  - 占位用的 `onAbort: () => {}` 在下一行就被覆盖了
  - 多余的 `as PendingApproval`
- `content-viewer-controller.ts`：`close()` 之后又把 `activeToolId` 设为 undefined
- `slash-command-options-controller.ts`：
  - 守卫之后又重复调用 `getModelSettings?.()`
  - `replace` 和 `finish` 的守卫条件重复
- `content-viewer.ts` 的 `content[index] ?? ""`
- `render/text.ts` 的 `segments[keepCount]?.index ?? 0` 和 `value[0]?.`
- `todo-write.ts` 的 `wrapped[0] ?? ""`
- `status-line.ts` 中 `turn_limit` 的标签被特殊处理了一次，又单独写了一个结果相同的 case
- `delete-session-confirmation.ts` 手动处理 Esc，而 ChoicePrompt 已经支持 `onCancel`
- `list-viewport.ts`：
  - 5 个方法各自做了一遍 `length === 0` 重置，而 clamp 已经做过
  - `window()` 重复计算了一次 clamp

---

## 阶段 2：前端接线统一，TUI overlay 管理

**目标**：消除三个前端各自手写的约 20 个回调；TUI overlay 的互斥改由一个地方负责。

### Runtime 接线
- [ ] `ConversationRuntime` 改为直接接收 host（或一个窄接口 `ConversationHostPort`，由 `KanaConversationHost` 实现它），也可以提供 `host.createRuntime(frontendOptions)`
- [ ] 前端只显式声明自己的差异：`backgroundJobCompletionRuns`、`subagentCompletionRuns`、`scheduledRuns`、`canStartQueuedRun`、是否启用 user tasks
- [ ] 删除 user task 的双重开关：host 的 `enableUserTasks` 和 runtime 的 `getUserTasks` 是否传入，两者合并成一个开关
- [ ] 删除三处一字不差的 `loadSession` 字段映射（server/start-server.ts、headless/runner.ts，以及 TUI）
- [ ] 删除 host 中纯转发给 `HostedSessionRegistry` 的方法，以及只是 `new` 的工厂函数 `createKanaConversationHost` 和 `createKanaMcpRuntime`
- [ ] `recordKanaAgentRunAccounting` 外面那层 try/catch + logger.error 出现了 3 次，收进一个 `recordAccountingSafely`
- [ ] MCP 的 ready/toolCount 统计在 host 的 `runMcpOperation` 和 `start-headless.ts` 里各写了一次，只保留一份；headless 里的 SIGINT 退出码 130 算了 3 次，合并
- [ ] 待决定：选 `ConversationHostPort` 接口，还是 `host.createRuntime()`。倾向于后者，因为前端不需要知道 runtime 的构造细节

### TUI overlay
- [ ] 新增 `OverlayHost`：同一时间只允许打开一个 overlay，`open(x)` 时自动关闭上一个；它的 `active` 状态用来 gate `canStartQueuedRun`
- [ ] 删掉 `app.ts` 里 8 个 `openX()` 方法中手写的 close 列表，以及 `closeOtherOverlays`
- [ ] **修复**：`closeOtherOverlays` 漏掉了 `mcpServerManager` 和 `contentViewer`；`openTodoViewer` 不会关闭 contentViewer
- [ ] 统一"运行中不能打开"的规则。目前只有 skill 和 mcp 两个 manager 检查了这一点，需要确认是否所有 overlay 都适用
- [ ] `session-lifecycle-controller.ts` 中 `startNew` 和 `resume` 里重复的 8 行重置代码，抽成一个函数
- [ ] `app.ts` 里 6 处 `sessionId ? getX?.(sessionId) : undefined`，合并成一个 helper
- [ ] `submitPrompt` 和 `queuePrompt` 里重复的消息构建逻辑，抽成共享函数

**完成标准**：每个前端的接线代码减少到只剩它自己特有的部分；新增一个 overlay 互斥的回归测试。

---

## 阶段 3：不可变消息，清理防御性拷贝

**目标**：去掉流式热路径上 O(n²) 的拷贝，让 `Agent.state` 变得廉价。

### 已知事实（制定计划时核对过）
- 已提交的消息在 src 中从未被原地修改，唯一的修改点是 provider 流里正在构建的 assistant message
- provider 事件里的 `snapshot` **只被 `agent/loop.ts` 读取**（start 事件和各种 delta 事件）。TUI、server、headless 都只读 `.type`、`.delta`、`.contentIndex` 或 `message`
- 目前一个 token 的拷贝链路，整条消息被完整拷贝 5 次以上：
  1. provider 每次 delta 执行 `snapshot: structuredClone(this.message)`
  2. `loop.ts` 的 `emitMessageUpdate` 再执行一次 `structuredClone(message)`，同时把带 snapshot 的原始 provider 事件原样塞进 `assistantMessageEvent`
  3. `agent.ts` 的 `publishEvent` 对每个 listener 深拷贝整个事件
  4. `stream.push(structuredClone(event))` 给 stream 再拷一份
  5. TUI 的 `streaming-text-presenter.ts` 的 `publish()` 每 16ms 一帧，再深拷贝一次整条消息
- `Agent.state` getter 每次访问都会深拷贝全部历史，并重新估算 token。TUI 状态栏只需要 `estimatedContextTokens` 和 `contextLimit` 两个数字

### 任务
- [ ] 补一个流式 benchmark（参考 `scripts/bench-tui-render.ts`），先记录基线：长回复和大块 tool 参数两种场景
- [ ] `core` 中的消息和事件类型改为 `readonly`（`Message`、content 各项、`AgentEvent`、`ContextCheckpoint`），让 tsc 找出所有修改点
- [ ] provider 保留 `snapshot`；`loop.ts` 往 agent 层转发 `assistantMessageEvent` 时去掉 snapshot
- [ ] 把 `Agent.state` 拆成廉价的访问器：`messages` 返回 readonly 引用，`contextUsage` 返回两个数字，`isRunning` 等等。完整快照只在确实需要时组装
- [ ] 删除已提交数据上的拷贝：
  - agent.ts：commit、journal、onRunCommitted、listener、stream.push
  - loop.ts：message_start/update/end
  - inbox.ts 和 agent.ts 的 enqueue/peek/claim
  - context-manager.ts 的 checkpoint 和 compactions getter，以及每一步的 messages
  - tool-runtime.ts：toolCall、images、artifact
  - `HostedSessionRegistry` 的每个 journal 回调
  - `session/journal.ts`
  - `ConversationRuntime` 的 `emit` 和 `cloneRuntimeEvent`
  - `core/messages.ts` 在构造时对 provenance 和 images 的拷贝
- [ ] provider 内部的重复拷贝：
  - `responses/stream.ts` 对同一个 item 拷贝两次
  - `openai-codex/request.ts` 对已经拷贝过的 item 再拷一次
  - `deepseek/model.ts` 对 action 重复拷贝
- [ ] `responses/stream.ts` 在每个 tool 参数 delta 上都对不断变长的 rawArgs 执行一次 `JSON.parse`，改成只在 item 结束时解析一次
- [ ] TUI：
  - `streaming-text-presenter` 只替换 text 内容，不再深拷贝整条消息
  - editor 的 setter 不再拷贝调用方刚刚新建的数组
  - `selectedJob` 和 `selectedSubagent` getter 不再每次读取都拷贝
- [ ] 去掉 jobs、subagents、user-tasks、wake-scheduler 的 listener 循环里对每个 listener 的拷贝
- [ ] 去掉 host 的 config getter，以及 config、tool-approval、skills、mcp-configuration 四个 store 在读取时做的拷贝
- [ ] 改写锁定拷贝行为的测试，在 `tests/` 中 grep "clone"、"mutat"、"isolat"、"detached"、"snapshots mutable"
- [ ] 再跑一次 benchmark，记录改善幅度

**完成标准**：src 里的 `structuredClone` 只剩边缘场景（持久化、跨 worker 通信、provider 构建中的消息），benchmark 显示长回复的 CPU 开销明显下降。

---

## 阶段 4：Provider 共享层

**目标**：deepseek 和 openai-codex 共用一套 Responses 请求代码；三个 provider 共用 HTTP 和错误处理。

- [ ] 新增共享的 Responses request 模块。目前 `deepseek/request.ts` 和 `openai-codex/request.ts` 有 9 对函数相同或几乎相同（Input、Message、ToolOutput、UserContent、FunctionCall、Tools、appendImageOmission 等），真正的差异只有三项，通过参数注入：
  - namespace
  - tool schema 的 `strict`
  - 是否回放 reasoning
- [ ] 共享 HTTP 基础层，以下内容在三个 provider 里完全相同：
  - `create*RequestSignal`
  - URL 拼接
  - HttpError（错误消息里截断 body 的逻辑）
  - `getRetryDelayMs`
  - `isAbortError` 的重新导出
- [ ] retry 循环统一为一个函数，各 provider 只提供"是否重试"的判断；Codex 额外的 401 刷新作为一个钩子
- [ ] 三个 `model.ts` 的 `run()` 骨架抽成一个共享的生命周期函数：requestStarted → 执行 → requestFailed → stream.error → dispose
- [ ] `normalize*Error`、`is*ContextWindowFailure`、`get*ErrorCode` 合并成一份
- [ ] 模型能力（webSearch、imageInput、parallelToolCalls）的 gating 只在一个地方做。目前 agent、loop、provider 的 model 层和 request 层各做了一次
- [ ] max output token 校验统一。目前 openai-compatible 校验配置值和单次请求值，deepseek 是内联的一份拷贝，codex 只校验配置值
- [ ] openai-compatible 的 SSE reader 补上 `reader.cancel` 和 `releaseLock`，`JSON.parse` 失败时给出 provider 风格的错误
- [ ] `openai-codex/stream.ts` 只是在转发 `readResponsesStream`，删掉
- [ ] **待决定（行为变化）**：模型给出非法 JSON 参数时，`parseToolArguments` 应该怎么处理。目前 openai-compatible 返回原始字符串，responses 返回 `{}`，两者需要统一，而且统一后模型看到的工具报错会变。倾向于保留原始字符串，这样校验报错能说明是 JSON 本身非法

**完成标准**：provider 目录净删除；三个 provider 现有的测试全部通过；新增 parseToolArguments 一致性的测试。

---

## 阶段 5：后台任务注册表

**目标**：`BackgroundJobManager` 和 `KanaSubagentManager` 共用一个泛型的、按 owner 隔离的注册表。

- [ ] 在 `jobs` 中抽出 `OwnedTaskRegistry<Record, Summary>`，统一下面这些逻辑：
  - owner 绑定，closed-owner 准入
  - live 上限
  - settlement 和 waiters（合并 `waitForChange` 和 `waitForSettlement`）
  - finalize 守卫、prune、closeOwner
  - listener 注册与 emit、observe
  - `unknownSummary`
- [ ] job 和 subagent 只提供各自的 run 逻辑和 summary 投影。job 保留输出环形缓冲和 kill；subagent 保留 live snapshot 和 inspect
- [ ] 合并冗余的标志：`closePromise` 与 `closedOwners`、`completionObserved` 与 `completionPublished`；`closedOwners` 改成会被清理的结构，不再只增不减
- [ ] 两边启动 producer 的写法统一。目前一边是 try/catch 把同步异常转成 rejection，另一边是 `Promise.resolve().then`
- [ ] `input-coordinator.ts` 中 job、subagent、user task 三组几乎相同的 observe 和 handle 方法，合并到一个 `CompletionSource` 接口
- [ ] `KanaUserTaskManager` 评估是否复用注册表，或者只实现 `CompletionSource`
- [ ] **待决定**：统一状态拼写（jobs 用 `canceled`，subagents 用 `cancelled`）之前，先确认这个状态值是否会出现在以下地方，如果会出现，就保留现有拼写：
  - session JSONL（subagent journal）
  - 返回给模型的工具输出
  - headless 或 server 的输出（制定计划时，这两个目录的代码里没有直接出现这个字符串）

**完成标准**：两个 manager 的代码大幅缩减；jobs 和 subagents 现有的测试全部通过。

---

## 阶段 6：schema 化解析

**目标**：每种文件格式定义一个 typebox schema，并用同一个解析入口处理。配置字段只定义一次。

- [ ] 在 `core` 中实现 `parseWithSchema(schema, raw, label)`。编译缓存和错误格式化复用 `tools/validation.ts` 里现有的逻辑，报错风格保持现有的 "field must be …"
- [ ] 重写 config.toml 的解析：
  - 字段定义只写一份，从中派生默认值、snake↔camel 映射，以及 `store.ts` 做 TOML 行级修补时需要的叶子路径
  - 删除三份手写的映射：`toRawKanaConfig`、`mergeKanaConfig`、`CONFIG_FIELDS`
  - 删除 `validateKanaConfig = parse(toRaw(config))` 这种来回转换
  - 一次 reconfigure 只校验一次（目前还有 store 写盘后的重新解析、clean 模式在 host 里的再次校验、overrides 的重新解析）
  - 跨字段的检查（比如 max_turns）作为解析后的额外检查保留
- [ ] mcp.json（`kana/mcp/config.ts`）：用 schema 描述 server union 和 OAuth 块；URL、header、env 名这类细粒度规则保留为自定义检查
- [ ] session JSONL 条目（`session/format.ts` 里约 250 行的 isMessage、isProvenance 等守卫）
- [ ] 其余格式：
  - custom.toml、oauth-tokens.json（`oauth` 的分层限制要注意）
  - mcp-enabled.json、approvals JSON、skills.toml
  - theme JSON、GitHub release JSON
- [ ] accounting JSONL 目前只检查了 type 和 version，坏记录会被静默丢弃。考虑加上 schema，并把丢弃的记录写进日志
- [ ] frontmatter 只保留一个通用读取器（目前 skills、subagent profiles、prompt templates 各有一套），各自的 schema 决定宽松还是严格
- [ ] 删除 `asRecord`、`assertKnownKeys`、`readX` 系列的剩余副本
- [ ] activation state 目前会被解析三次（configuration-store 一次，`persistKanaMcpActivationState` 内外各一次），改成只解析一次
- [ ] **待决定**：报错文案是否允许变化。倾向于保持字段路径一致，具体措辞可以变，相关测试相应更新

**完成标准**：config.toml 和 session JSONL 的格式与默认值不变；现有的 config、session resume、MCP config 测试全部通过（只改报错文案的断言除外）。

---

## 阶段 7：信任边界、Capabilities、拆分大文件

### 内部重复校验
- [ ] `tool-runtime.ts` 中的 `resolve*` 系列、`assertValidToolResultPolicies`、`parseToolResultPolicyResult`（注释里写着防 "Proxy traps" 和 "sparse arrays"）全部改为依赖类型
- [ ] maxParallel 和 deadline 目前在 agent、loop、tool-runtime 三处分别解析，改成只解析一次
- [ ] message ID 去重守卫有 4 层（agent 的 constructor、stream、commit、enqueue，加上 inbox），只保留一层
- [ ] `todo.ts` 在重复校验 typebox 已经校验过的输入；`tools/result.ts` 在重复规范化 hook 的返回值；`session/format.ts` 重复检查 `hasMessageIdentity`；`mcp/oauth.ts` 重新校验 server id
- [ ] 单数形式的 `toolResultPolicy` 通道在经由 Agent 调用时永远用不到，删掉
- [ ] MCP 的关闭最多有 5 层幂等保护，只在资源所有者那一层保留

### clean 模式改为 Capabilities
- [ ] 启动时一次性组装 `KanaCapabilities`。skills、mcp、memory、sessions、subagents 这些能力，每一项要么是真实实现，要么是 Unavailable 实现，下游不再判断 `launchMode === "clean"`（目前有 26 处）
- [ ] 删除 `HostedSessionRegistry` 中每个 session 各存一份的 `persistent`，这个值对整个 registry 来说是常量

### OAuth 规则与基础设施
- [ ] OAuth 规则收进 `oauth` 下的一个模块：
  - 60s 过期提前量（3 份）
  - issuer/clientId/resource 绑定检查（3 份）
  - 刷新被拒的错误码（一处 4 个、一处 6 个，需要先确认以哪份为准）
  - token endpoint auth method 列表（3 份）
- [ ] 串行化队列（4 份）和原子写文件（4 份）各只保留一份

### TUI 骨架
- [ ] 抽一个 `ListPicker` 基类，或者 `handleListNavigation` 加 `renderWindow` 两个 helper。目前有 7 个列表组件，各自复制了一套导航和视口渲染
- [ ] 抽一个 overlay controller 基类，统一 open、close、focus 恢复和 refresh 模板。目前有 9 个 controller。`bottomArea.restore()` 已经会计算焦点，各处单独捕获 `restoreFocus` 的写法可以删掉
- [ ] `text-prompt.ts` 和 `editor.ts` 共用一个输入帧模块（applyText、applyPaste、applyAction、moveVertically、renderLine）
- [ ] `memory-compact-controller` 和 `local-shell-controller` 中相同的 abort 和运行生命周期，抽成共享代码

### 拆分大文件
- [ ] `agent/agent.ts`：拆成 AgentRun（stream、lifecycle、journal）、SteeringQueue、EventHub、配置解析。compaction 的提交逻辑目前在三处各写一遍，合并成一处
- [ ] `agent/tool-runtime.ts`：拆成 ToolScheduler、ToolInvocation、ToolResultFinalizer。同时合并以下重复：
  - 4 处 "publish 再 commit"
  - 两段几乎相同的 interrupted result 构建
  - 单个调用的快速路径（并行池大小为 1 时走的就是同一套逻辑）
- [ ] `tui/app/app.ts`：拆成 wiring、overlay 路由、事件投影、生命周期、提交路径
- [ ] `tui/components/editor/editor.ts` 和 `editor/state.ts`：拆出预览、palette、history、boundaries、paste-display、reducer
- [ ] `tui/render/latex.ts`：拆成 symbols（约 580 行数据）、layout、parser、environments
- [ ] `tui/tools/format.ts`：措辞表、output 格式化、target、todo 状态分开

**完成标准**：拆分后不再有超过约 600 行的核心文件；`bun run check` 通过；手动冒烟测试通过。

---

## 每个阶段的通用验证

- `bun run check`，包括 biome、注释长度、架构边界、tsc、knip、bun test
- 手动冒烟测试：
  - `bun run start` 跑一遍 TUI：新会话、resume、fork、/mcp、后台 job、subagent、overlay 切换、长回复的流式输出
  - `kana exec --json "…"` 检查 headless 的 JSONL 输出
  - `KANA_SERVER_TOKEN=… kana serve` 检查 HTTP API 和 SSE
- 涉及冻结契约的阶段（3、4、6），确认现有的 session、headless 和 server 测试原样通过

## 已发现的潜在问题

| 问题 | 位置 | 处理阶段 |
| --- | --- | --- |
| 流式输出时每个 token 都要多次拷贝整条消息，总开销 O(n²) | provider stream、loop、agent、streaming-text-presenter | 3 |
| `closeOtherOverlays` 漏关 overlay | `tui/app/app.ts` | 2 |
| `parseToolArguments` 在不同 provider 之间行为不一致 | `openai-compatible/stream.ts`、`responses/stream.ts` | 4 |
| `finally` 里关闭回调服务时抛出的错误会覆盖原本的结果 | `mcp/oauth-http-authorizer.ts` | 1 |
| SSE reader 没有 cancel 和 releaseLock | `openai-compatible/stream.ts` | 4 |
| `closedOwners` 只增不减 | `jobs/manager.ts`、`subagents/manager.ts` | 5 |
| 刷新被拒的错误码列表两处不一致 | `oauth/session.ts`、`kana/auth/openai-codex.ts` | 1（删除 OAuthSession 后只剩一份）/ 7 |
