# Test Suite Cleanup Plan

## 目标

在不修改生产行为和产品文档的前提下，逐步整理现有测试：

- 为每项行为确定唯一的主要测试所有者。
- 删除跨层重复、实现细节重复和价值不足的测试。
- 让测试文件结构重新对应生产模块和公开边界。
- 提取少量稳定的测试辅助设施，减少重复 setup 和 fixture。
- 建立可持续的测试维护方式，避免继续以 append 为默认策略。

本计划是测试整理的工作记录，不属于产品文档，不要求同步到 `docs/`。

## 当前基线

基线分支：`refactor/test-suite-cleanup`

基线提交：`713420f refactor(tests): consolidate test ownership`

- 131 个测试文件。
- 约 38,253 行测试代码。
- `bun test` 执行 1,117 个测试用例。
- 22 个测试文件超过 500 行。
- 最大的 20 个测试文件占全部测试代码约 49%。

已完成：

- [x] 收敛 conversation coordinator、Runtime、TUI、config validation 和 Agent construction 的重复覆盖。
- [x] 将 Runtime 测试从 21 个缩减到 12 个。
- [x] 删除约 517 行净重复测试代码。
- [x] 通过完整检查。

## 工作方式

一次只处理下面清单中的一个任务。每个任务遵循相同流程：

1. 阅读对应生产模块和全部相关测试。
2. 列出行为及其当前测试所有者，标记重复、缺失和跨层覆盖。
3. 先确定目标结构，再移动测试。
4. 单独删除或合并确认重复的测试，并记录理由。
5. 运行目标测试和完整测试套件。
6. 检查测试数量、文件行数和 diff，确认减少是有意的。
7. 使用独立的 Conventional Commit 提交。
8. 更新本文件中的状态和结果。

同一时间只保留一个 `进行中` 任务。除非当前结构无法表达行为，否则不修改生产代码。

## 测试所有权原则

每项行为只保留一个完整矩阵所有者：

- 纯函数和底层模块负责边界值、输入组合及错误矩阵。
- controller 负责状态转换、依赖调用、恢复和生命周期。
- UI component 负责渲染、输入和用户交互。
- App 或入口层只保留关键接线、冒烟和跨模块集成测试。
- Provider 共享协议行为使用 contract suite；provider 文件只保留差异。

上层测试不重复下层的完整输入矩阵。一个上层成功场景和一个有意义的失败场景通常已经足够。

测试文件超过 600 行、超过 20 个用例，或导入多个生产域时，应触发归属审查，但不设置机械的行数上限。状态机模块即使较大，只要职责单一也可以保留在一个文件中。

## 有序任务清单

### 1. Prompt editor 结构整理

状态：已完成

当前文件：`tests/tui/prompt-editor.test.ts`

目标结构：

- `tests/tui/editor.test.ts`
- `tests/tui/editor-state.test.ts`
- `tests/tui/editor-layout.test.ts`
- `tests/tui/editor-commands.test.ts`

工作内容：

- 按 `Editor`、state、layout 和 commands 的生产边界迁移用例。
- 保持首次提交只做结构移动，不改变覆盖范围。
- 复核 CRLF/CR、光标移动和 completion 是否在多个层重复。
- 底层保留完整换行矩阵，Editor 只保留用户可见的粘贴集成场景。

完成条件：每个文件只覆盖一个明确模块，原有行为全部可追踪，相似换行用例逐项确认归属。

结果：已完成

提交：`refactor(tests): organize prompt editor suites`

- 测试文件：1 -> 4。
- 测试行数：1,238 -> 1,258。
- 测试用例：54 -> 54。
- 删除或合并：没有删除行为覆盖。layout 的 CRLF 处理与 Editor 的粘贴归一化属于不同契约；soft-wrap 和历史导航用例也分别验证算法、渲染位置与状态边界。
- 验证：目标测试 54 个通过；`bun run check` 通过，完整套件 1,117 个测试通过。

### 2. Workspace tools 按模块拆分

状态：已完成

当前文件：`tests/tools/workspace.test.ts`

目标结构：

- `tests/tools/read.test.ts`
- `tests/tools/list.test.ts`
- `tests/tools/glob.test.ts`
- `tests/tools/grep.test.ts`
- `tests/tools/write.test.ts`
- `tests/tools/edit.test.ts`
- `tests/tools/view-image.test.ts`
- `tests/tools/bash.test.ts`
- `tests/tools/workspace-path.test.ts`
- `tests/tools/execution.test.ts`

共享 fixture：`tests/tools/workspace-fixture.ts`

工作内容：

- 让测试文件直接对应 `src/tools` 下的实现模块。
- 识别跨工具重复的临时目录和 filesystem setup。
- 不把不同工具的相似错误处理误判为重复。
- 评估是否需要一个小型 workspace fixture，避免形成通用大 helper。

完成条件：删除 `workspace.test.ts`，每个工具可以独立运行和定位失败。

结果：已完成

提交：`refactor(tests): split workspace tool suites`

- 测试文件：1 -> 10，另有 1 个领域 fixture。
- 测试行数：1,185 -> 1,225。
- 测试用例：49 -> 45。
- 删除或合并：将 read、edit 和 write 中 7 个重复的绝对路径、外部路径及 symlink 用例迁移为 3 个 `workspace-path` 所有者测试，净删除 4 个重复用例。
- 验证：目标测试 45 个通过；`bun run check` 通过，完整套件 1,113 个测试通过。

### 3. Session store 按职责拆分

状态：已完成

当前文件：`tests/kana/session/store.test.ts`

目标结构：

- `tests/kana/session/repository.test.ts`
- `tests/kana/session/format.test.ts`
- `tests/kana/session/journal.test.ts`

共享 fixture：`tests/kana/session/session-fixture.ts`

工作内容：

- repository 负责创建、枚举、读取、删除、标题和父 session。
- format 负责 wire format、版本、校验、checkpoint 和损坏输入。
- journal 负责 turn journaling、todo、恢复和不完整尾部。
- 复核集成测试是否重新验证了 format 的完整错误矩阵。

完成条件：测试结构与 `src/kana/session` 的模块边界一致。

结果：已完成

提交：`refactor(tests): separate session persistence suites`

- 测试文件：1 -> 3，另有 1 个领域 fixture。
- 测试行数：1,027 -> 1,011。
- 测试用例：23 -> 23。
- 删除或合并：移除 repository 对 JSONL header、turn 和 message 结构的 5 组重复断言；有效图片和 usage round-trip 由 format 测试统一负责。
- 验证：目标测试 23 个通过；`bun run check` 通过，完整套件 1,113 个测试通过。

### 4. Config 测试重新归属

状态：已完成

原文件：

- `tests/kana/config.test.ts`
- `tests/kana/config-store.test.ts`
- `tests/kana/prompt.test.ts`

完成结构：

- `tests/kana/config/environment.test.ts`
- `tests/kana/config/defaults.test.ts`
- `tests/kana/config/parser.test.ts`
- `tests/kana/config/persistence.test.ts`
- `tests/kana/config/store.test.ts`
- `tests/kana/agent-configuration.test.ts`
- `tests/kana/context.test.ts`
- `tests/kana/prompt.test.ts`

共享 fixture：`tests/kana/config/config-fixture.ts`

重点清理：

- 模型 capability 限制与 `tests/kana/model.test.ts` 的重复。
- 对默认配置同时做整体相等和逐字段断言的重复。
- config 层对模型预算算法的完整重复矩阵。

完成条件：model 层拥有预算和 capability 算法，config 层只验证配置解析和接线。

结果：已完成

提交：`refactor(tests): align config suite ownership`

- 测试文件：3 -> 8，另有 1 个领域 fixture。
- 测试行数：1,388 -> 1,246。
- 测试用例：66 -> 63。
- 删除或合并：删除 Agent 层重复的模型 capability 上限测试；删除已由完整 merge 用例覆盖的 Main/Memory 模型独立解析和 API key 字段解析测试；Prompt 接线只保留一个 Agent 冒烟断言。
- 结构改进：Config 按 environment、defaults、parser、persistence 和 store 分层；环境上下文纯函数归 `context.test.ts`；AGENTS、memory 和静态 Prompt 拼装归 `prompt.test.ts`；共享 fixture 不再修改进程级环境变量。
- 验证：目标测试 63 个通过；`bun run check` 通过，完整套件 1,110 个测试通过。

### 5. Transcript 与消息组件拆分

状态：已完成

当前文件：`tests/tui/transcript.test.ts`

目标结构：

- `tests/tui/assistant-message-block.test.ts`
- `tests/tui/tool-call-block.test.ts`
- `tests/tui/hosted-tool-block.test.ts`
- `tests/tui/content-viewer.test.ts`
- 保留精简后的 `tests/tui/transcript.test.ts`

工作内容：

- 将 AssistantMessageBlock 和 ToolCallBlock 的渲染测试移出容器测试。
- 将 viewer/controller 行为迁回对应 controller 测试。
- Transcript 只负责消息组合、可见区域和容器级交互。
- 删除对 tool detail 完整 payload 矩阵的重复验证。

完成条件：Transcript 不再承担子组件和 inspector 的完整测试职责。

结果：已完成

提交：`refactor(tests): split transcript component suites`

- 测试文件：1 -> 5。
- 测试行数：1,323 -> 1,299。
- 测试用例：46 -> 45。
- 删除或合并：将同时比较 Assistant 和 Tool 颜色的跨组件用例合并到两个组件已有的渲染用例中，保留全部颜色断言并删除 1 个综合用例。
- 结构改进：Transcript 只保留 4 个子组件组合和清理行为；Assistant、Hosted Tool、ToolCall 和 ContentViewer 分别拥有自己的组件测试。原本通过 Transcript 包装检查 tool shortcut 的用例改为直接测试 `ToolCallBlock`。
- 后续边界：`tool-call-block.test.ts` 中的 tool payload 渲染矩阵留给第 6 项与 detail、approval 和 viewer 一起审查。
- 验证：目标测试 45 个通过；`bun run check` 通过，完整套件 1,109 个测试通过。

### 6. Tool detail、approval 与 result viewer 去重

状态：已完成

涉及文件：

- `tests/tui/tool-call-block.test.ts`
- `tests/tui/tool-detail.test.ts`
- `tests/tui/tool-approval.test.ts`
- `tests/tui/tool-result-viewer-controller.test.ts`
- `tests/tui/tool-transcript-budget.test.ts`
- `tests/tui/content-viewer.test.ts`

主要所有者：

- `tool-detail.test.ts` 负责 write、edit、custom、MCP、清理和空内容的完整数据矩阵。
- approval 负责选择、翻页、快捷键和批准流程。
- viewer controller 负责打开、关闭、导航、焦点和实时刷新。
- transcript 负责紧凑的调用状态渲染。

完成条件：同一 tool payload 或状态矩阵不再被三个以上层级重复验证。

结果：已完成

提交：`refactor(tests): clarify tool presentation ownership`

- 测试文件：6 -> 8；新增 `tool-call-rendering.test.ts` 和 `tool-inspector.test.ts` 两个明确所有者。
- 测试行数：2,943 -> 2,379。
- 测试用例：110 -> 87。
- detail 所有权：保留完整参数、默认值、空 payload、Custom/MCP provenance 和 sanitization；删除重复的 search filter 与 Bash timeout 用例。
- inspector 所有权：用 4 个集中用例覆盖成功输出不重复、write/edit 在 running、failed、canceled 或缺少 diff 时从 args 恢复上下文，以及字段软换行。
- approval 所有权：删除 7 个重复验证长 write/edit/custom/MCP 参数和空 payload 的用例，只保留选择、标题、布局、sanitization 接线与分页。
- controller 所有权：22 -> 9 个用例，只保留打开可检查 Tool、运行与取消状态、实时刷新、导航、viewport 重置和焦点恢复。
- compact 所有权：合并 3 个 unknown/custom/MCP target 用例，删除重复的超长 Bash approval 和 edit diff 截断覆盖；ToolCall 的 912 行大文件拆为 276 行状态套件和 580 行渲染套件。
- 验证：目标测试 87 个通过；`bun run check` 通过，完整套件 1,086 个测试通过。

### 7. Responses provider contract

状态：已完成

涉及文件：

- `tests/providers/deepseek/request.test.ts`
- `tests/providers/openai-codex/request.test.ts`

工作内容：

- 提取共享 Responses request contract。
- 共享验证普通图片、tool image output 和 multimodal function output。
- provider 文件只保留 endpoint、header、模型参数或格式差异。
- 不在本任务中顺带重构生产 request builder。

完成条件：删除两组约 30 至 40 行的近似逐行复制测试。

结果：已完成

提交：`refactor(tests): share Responses input contract`

- Provider 测试文件：2 -> 2，新增共享 contract `tests/providers/responses-request-contract.ts`。
- 测试行数：747 -> 592。
- 测试用例：10 -> 9。
- 共享所有权：每个 provider 通过同一 contract 验证用户图片和 tool image 在启用、禁用时的 Responses input wire format，以及禁用时不泄漏图片字节。
- Provider 差异：DeepSeek 保留 stateless replay、reasoning、strict tool、输出预算和 text-only 模型 capability；OpenAI Codex 保留 encrypted replay state、`store`、parallel tool calls、默认指令和 hosted search 差异。
- 删除或合并：移除两份逐行相同的 tool image 用例，并把各文件中的用户图片矩阵及主 request 用例里的图片断言收敛到共享 contract。
- 验证：目标测试 9 个通过；`bun run check` 通过，完整套件 1,085 个测试通过。

### 8. List viewport 与换行语义归属

状态：已完成

涉及范围：

- SessionPicker、SkillManager 和 ToolHistoryPicker 的列表边界。
- TextBlock、PromptEditor 和 input layout 的 CRLF/CR 处理。

工作内容：

- 为共享 ListViewport 行为建立直接测试。
- 每个具体 picker/manager 只保留一个组件集成场景。
- 修正 ToolHistoryPicker 中名称声称 wrap、断言实际 clamp 的测试。
- 换行转换由最低适当层拥有完整矩阵。

完成条件：共享行为在底层有明确所有者，组件测试不再互相复制。

结果：已完成

提交：`refactor(tests): centralize viewport and line semantics`

- 涉及测试文件：5 -> 7；新增 `list-viewport.test.ts` 和 `lines.test.ts` 两个底层所有者。
- 测试行数：781 -> 779。
- 测试用例：36 -> 37。
- ListViewport 所有权：6 个直接用例覆盖移动 clamp、选中项可见、动态 limit、page/scroll、空列表重置和高度换算。
- 组件接线：SessionPicker、SkillManager、ToolHistoryPicker 各保留一个窗口集成场景；删除 7 个重复的边界、缩高和 resize 用例。
- ToolHistoryPicker：移除名称声称 wrap、断言实际 clamp 的旧用例；新的组件场景只验证按键、受限窗口和稳定 ID 选择的接线。
- 换行所有权：`lines.test.ts` 集中覆盖 LF、CRLF、CR 的识别、归一化、拆行、空行映射和 tail 摘要；TextBlock 删除重复矩阵。
- 输入布局：保留 CRLF/CR 对 grapheme cursor offset 的集成用例；Editor 和 TextPrompt 继续只负责粘贴归一化及显式换行接线。
- 验证：目标测试 37 个通过；`bun run check` 通过，完整套件 1,086 个测试通过。

### 9. Agent 测试结构整理

状态：已完成

涉及文件：

- `tests/agent/agent.test.ts`
- `tests/agent/loop.test.ts`
- `tests/agent/tool-runtime.test.ts`
- `tests/agent/context-manager.test.ts`

建议边界：

- Agent lifecycle、input、journal 和 context integration。
- Loop core、tool turns、limits、abort 和 error recovery。
- Tool runtime lifecycle、deadline、parallel scheduling 和 result policy。
- Context manager selection、usage anchor、compact policy 和 context recovery。

工作内容：

- 先按行为域拆分或增加清晰的 suite 边界。
- ContextManager 保留 checkpoint 和 usage anchor 完整矩阵。
- Agent 只保留确认构造和生命周期正确接入 ContextManager 的代表场景。
- 复用受控 model/stream fixture，但不隐藏关键状态机步骤。

完成条件：失败可以从文件名和 suite 名直接定位到一个状态机职责。

结果：已完成

提交：`refactor(tests): organize agent behavior suites`

- 测试文件：4 -> 4；保持生产模块对应关系，不为缩短单文件机械拆散共用的受控状态机。
- 测试行数：5,524 -> 5,556；增加的内容仅为行为域 suite 边界。
- 测试用例：104 -> 104；原有 6 个顶层 suite 整理为 22 个职责明确的 suite。
- Agent：划分 lifecycle、context restoration、journal integration、input coordination、context compaction、state isolation/completion。
- Loop：划分 configuration、tool turns、cancellation、limits 和 error recovery。
- ToolRuntime：划分 invocation lifecycle、deadline/configuration、parallel scheduling、result policy 和 parallel failure containment。
- ContextManager：保留 checkpoint 与 usage anchor 完整矩阵，并分离 budgets/checkpoints、model projection、usage anchors、rollback、model policy 和 context-limit recovery。
- 重复审查：Agent/ContextManager 与 Loop/ToolRuntime 的相似场景分别属于上层接线和底层状态机契约，没有删除跨层代表性集成。
- Fixture 审查：现有 controlled model/stream 分别编码 usage、abort、tool call 和 truncation 协议，不满足语义一致的提取条件，继续保留在各所有者文件中。
- 验证：目标测试 104 个通过；`bun run check` 通过，完整套件 1,086 个测试通过。

### 10. TUI App 集成测试下沉

状态：已完成

主要文件：

- `tests/tui/session-agent.test.ts`
- `tests/tui/information-viewers.test.ts`

工作内容：

- 外部工具启动和失败迁到 external-tools lifecycle controller。
- session fork/recreate 迁到 session lifecycle controller。
- shutdown 和 Ctrl+C 迁到 process lifecycle。
- manual compact 迁到 compact controller。
- viewer 的具体行为迁回对应 viewer/controller。
- App 层只保留少量跨 controller 接线和用户流程测试。

完成条件：`session-agent.test.ts` 成为小型 App smoke suite，而不是 controller 测试集合。

结果：已完成

提交：`refactor(tests): move TUI behavior to controller suites`

- 涉及测试文件：5 -> 8；新增 external tools、session lifecycle、context compact 和 information viewer 四个 controller 所有者，删除独立但重复的 `memory-viewer.test.ts`。
- 测试行数：2,338 -> 2,204。
- 测试用例：55 -> 44。
- App smoke：`session-agent.test.ts` 由 834 行、15 个用例降至 417 行、6 个用例，只保留 session 切换、resume 启动门、clean mode、wake gate 和 context status 接线。
- App viewer：`information-viewers.test.ts` 由 677 行、26 个用例降至 330 行、9 个用例，只保留运行中 focus/escape、错误状态、todo 接线和 Ctrl+O 跨 controller 流程。
- Controller 所有权：外部工具启动/失败、fork 后 UI 流程、临时 compaction block、help/usage/memory/todo viewer 各自拥有直接测试；memory Markdown 换行场景并入 information viewer controller。
- Lifecycle 所有权：Agent abort、host/terminal shutdown 顺序、退出 usage、二次 Ctrl+C force stop 和 draft-first Ctrl+C 迁入 `process-lifecycle.test.ts`。
- Compaction 所有权：ContextCompact 负责临时 block 生命周期；AgentEventRenderer 负责持久化 compaction marker 和状态投影。
- 删除重复：命令参数错误由 slash command controller 拥有；空工具历史、picker 到 inspector 和 relinquish 由 tool history/content viewer controller 拥有；fork 后 Agent 重建由 ConversationRuntime 现有矩阵拥有。
- 验证：目标测试 44 个通过；`bun run check` 通过，完整套件 1,075 个测试通过。

### 11. CLI 与 headless 分域整理

状态：已完成

当前文件：

- `tests/cli/cli.test.ts`
- `tests/headless/headless.test.ts`

建议边界：

- CLI launch/headless forwarding、config、update、auth 和 skills。
- Headless protocol、Goal、timeout、stdin 和 approval。

注意事项：CLI 参数转发与 headless 运行行为属于不同公开边界，不因为输入相似而删除其中一层。

完成条件：文件按命令或协议职责组织，不混合无关 setup。

结果：已完成

提交：`refactor(tests): organize CLI and headless suites`

- 测试文件：2 -> 3；`cli.test.ts` 拆成 `launch.test.ts` 和 `commands.test.ts`，并新增不参与测试发现的 `cli-fixture.ts`。
- 测试实现行数：1,535 -> 1,565；其中 CLI 测试正文由 728 行降至 671 行，77 行默认依赖和解析入口集中到共享 fixture。
- 测试用例：42 -> 42；保持 CLI 参数转发与 headless 运行行为两层公开契约，不因输入相似删除任一层。
- CLI 所有权：launch suite 负责版本、TUI/headless 启动和参数转发；commands suites 分别负责安装、更新、重置、认证和 Skills。
- Headless 所有权：按 output protocol、Goal execution、timeout、approval、result reporting、input/resume 建立顶层 suite，继续共享同一受控 ConversationRuntime 和协议模型。
- 结构变化：顶层 suite 由 2 个增至 12 个；失败可直接定位到命令域或 headless 协议阶段，且没有复制默认 CLI 依赖。
- 验证：目标测试 42 个通过；`bun run check` 通过，完整套件 1,075 个测试通过。

### 12. 稳定测试 helpers

状态：待开始

候选重复设施：

- `createTempEnv`。
- `waitFor`。
- `deferred`。
- controlled model/stream。
- TUI terminal 和 default options stubs。

提取规则：

- 至少有三个语义一致的使用者。
- helper 名称可以表达领域含义。
- 不隐藏测试的关键前置条件和断言。
- 不创建集中所有 fixture 的 `test-utils.ts`。

完成条件：减少机械 setup，同时保持每个测试可独立阅读。

### 13. 剩余大文件审查

状态：待开始

重点复核：

- `tests/mcp/streamable-http-transport.test.ts`
- `tests/tui/agent-event-renderer.test.ts`
- `tests/kana/conversation/runtime.test.ts`
- `tests/tui/render.test.ts`
- `tests/kana/mcp/manager.test.ts`
- `tests/tui/markdown-block.test.ts`
- `tests/kana/skills/skills.test.ts`

这些文件目前更接近单一状态机或组件。先检查归属和重复，不因文件大而强制拆分。MarkdownBlock 只保留链接、LaTeX、table 等能力的代表性集成测试，纯函数矩阵由已有的专用测试负责。

完成条件：为每个文件记录“保留、拆分或缩减”的明确结论。

### 14. 最终复核与长期约束

状态：待开始

工作内容：

- 重新统计测试文件、行数、用例数和最大文件分布。
- 搜索完全相同的测试名称、大段 fixture clone 和跨层矩阵。
- 运行 `bun run check`。
- 逐项确认本计划没有未解释的待办。
- 单独评估是否需要调整 `AGENTS.md`，明确“add or update tests”不代表必须追加新用例。

完成条件：所有测试都有清晰所有者，新增测试默认先更新现有覆盖，而不是直接 append。

## 每项任务记录模板

完成任务时在对应章节追加：

```text
结果：已完成
提交：<commit>
测试文件：<before> -> <after>
测试行数：<before> -> <after>
测试用例：<before> -> <after>
删除或合并：<具体行为及理由>
验证：<执行的命令>
```

测试数量下降不是目标本身。只有重复、错误归属、纯实现细节或已经被更低层完整覆盖的测试才应删除。
