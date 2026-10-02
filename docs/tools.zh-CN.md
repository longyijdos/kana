# 工具与执行

核心 `ToolSpec` 是 provider 可见的名称、描述和输入 JSON Schema。可执行 `Tool` 增加 `execute`、可选的返回 schema 和执行 metadata。`ToolRuntime` 接收模型可见的工具，以及可选的脚本内部工具列表，把调用转换成规范化、可观察的结果，并把普通工具失败限制在 Agent loop 内。

## 工具与结果合同

```ts
type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  outputSchema?: TSchema;
  execution?: {
    concurrency?: "parallel" | "exclusive";
    deadlineMs?: number;
  };
  execute(args, context): ToolResult | unknown | Promise<ToolResult | unknown>;
};

type ToolContext = {
  toolCallId: string;
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};
```

未声明 concurrency 时默认 `exclusive`。`ToolRuntime` 始终提供调用级 abort signal；直接调用 `execute` 的嵌入方可以省略。长时间运行的实现应观察 signal，并用 `update` 发布有价值且有界的进度。

每个工具的实现提供自己的可选 `outputSchema`，描述成功调用的 `result` 经 JSON 传递后的格式；Date 会变成 ISO 字符串。普通 provider 工具声明不包含这项 metadata，也不在运行时按它校验返回值。Codemode 将它转成类型说明放入 `run_code` 的描述；未提供 schema 时显示为 `unknown`。

规范化结果面向不同消费者：

- `content` 是返回模型的有界文本。
- `images` 携带 provider-neutral 视觉观察。
- `result` 是实时 Agent 与前端使用的 canonical 结构化 host 值。
- `artifact` 标识保存在消息外部的完整文本。
- `isError` 告诉模型操作失败。

工具直接返回字符串时，它成为 `content`；其它普通值会 JSON 序列化为 content，并保留为实时结构化结果。显式结果字段格式错误时，会在消息提交前变成安全工具失败。

## 调用管线

`ToolRuntime.invoke(toolCall, { signal?, onAbortRun? })` 执行单次调用，与模型提出的调用共用参数校验、审批、取消、deadline、规范化和事件管线。它返回 `{ toolCall, result, isError, abortRun? }`，其中 `result` 是完整的规范化 `ToolResult`。它不应用结果策略、不限制 content、不创建 artifact，也不提交消息。`ToolRuntime.execute()` 负责批量调度和历史消息处理；`invoke()` 的调用方负责调度，并须处理 `abortRun`，或提供 `onAbortRun` 以立即收到中止通知。

只有名为 `run_code` 的工具收到 `CodemodeToolContext`，它在普通 context 的基础上增加 `invokeTool(name, args, { signal? })`。普通工具的 context 类型和运行时对象均没有这个字段。内部调用通过 `invoke()` 返回完整的规范化 `ToolResult`，不生成历史消息。每个 codemode 调用持有自己的队列，遵守 runtime 的并发开关和数量上限，exclusive 调用形成 barrier。内部调用的审批共用 runtime 的串行 hook 队列。内部调用要求 `abortRun` 时会中断 codemode；仅取消子调用的 signal 不会。内部调用发布通常的执行事件，并用 `parentToolCallId` 标明外层调用，但不会成为独立的历史工具消息。`invoke()` 接受这个可选事件字段；普通调用不带该字段。TUI 渲染工具 block 和状态时跳过这些内部事件，审批保持原有行为。

每个调用都进入同一条受控管线：

1. 按名称解析工具；找不到时生成错误结果。
2. 深拷贝参数，应用兼容的基础类型转换，再使用缓存的 TypeBox compiler 校验。
3. 调用 `beforeToolExecution`；hook 始终串行进入，可继续、取消，或不执行工具而直接返回正常结果。
4. 对继续执行的调用，检查 run cancellation，发出 `tool_execution_start`，创建调用 signal 并启动有效 deadline。
5. 串行发布 `context.update()`，并在终态前等待每个 listener。
6. 规范化结果并发出 `tool_execution_end`。
7. 应用结果策略，再通过按模型顺序排列的 slot 提交 sibling 结果，之后才能开始下一模型请求。

Kana 自有对象 schema 使用 `additionalProperties: false`，未声明参数会带属性名失败，而不是被忽略。序列化后失去库 metadata 的 TypeBox schema 仍会先补充兼容基础类型转换，再交给同一 compiler 校验。第三方和 MCP schema 保留自身声明的额外属性行为。`mcp_call` 在这条管线中校验入口 envelope，再在入口内部、远端调用前校验嵌套远端参数。

校验错误、审批拒绝、取消、deadline 到期与工具异常都会成为 `isError: true` 结果，不会抛出 turn loop。审批取消默认中止 run，并为同一 assistant 消息中后续调用补充 canceled 结果，而不执行它们。

hook 返回 `return` 时提供正常 `ToolResult`，跳过 `execute` 及其 deadline；返回 `cancel` 时生成 canceled 错误结果，即使设置 `abortRun: false` 也是如此。两条路径仍会发布 `tool_execution_end`、应用结果策略并提交工具结果。

`tool_execution_end` 描述完成、取消、hook 提供的结果或明确 unknown 终态，不保证结果已进入 journal。成功的 Agent run 才是持久边界；提交和恢复顺序见[会话与记忆](sessions-and-memory.zh-CN.md)。

## 并发、取消与 deadline

只有 Agent policy 与模型 metadata 都允许 parallel tool call 时才会并行；否则 provider 收到 `parallelToolCalls: false`，所有调用串行执行。启用后，也只有声明为 `parallel` 的相邻调用组成并发组；`exclusive`、未声明、缺失或非法工具仍是 barrier。

每个并行组使用有界滚动池。调用按模型顺序 claim 并串行进入审批，同时运行的调用 body 不超过 `maxParallelToolCalls`。Start、update 和 end event 都按 `toolCallId` 关联并遵循物理时间，因此后面的快速调用可能先显示完成。独立 result slot 会等待模型顺序后才写入 journal 并进入下一请求，保证 replay 确定性。

有效 deadline 优先使用 `tool.execution.deadlineMs`，否则使用 Agent 默认值。可复用 runtime 与 Kana 的 `agent.tool_deadline_ms` 均默认 300000 ms；`shell` 自行声明 301000 ms deadline，使其五分钟的 command ceiling 仍通过 shell 自身的超时处理结束。`shell.timeoutMs` 等调用参数可以在这个外层边界内施加更窄的操作限制。

Run abort、工具 deadline 或内部 scheduler 失败会立即停止 pool 补充并中止活动 sibling signal。尚未启动的调用获得 canceled 结果；已启动调用获得有限取消宽限期。宽限期内结束会成为 `canceled` 或 `timed_out`，之后迟到的 return 不能覆盖该结果。

调用在宽限期后仍忽略取消时，ToolRuntime 停止接收 update，把结果固定为 `status: "unknown"` 并结束 Agent run。结果禁止自动重试，因为脱离 runtime 的操作仍可能产生副作用；迟到结算只产生不含参数或输出的安全生命周期诊断。

## 工具结果策略与 artifact

结果规范化后，ToolRuntime 会依次对成功、失败、拒绝、取消、timeout 与 unknown 结果应用每个 `ToolResultPolicy`。策略收到已克隆的只读调用、当前模型可见 content 与错误状态、可测量时的结构化结果字节数，以及当前 content limit；任意结构化 host 数据本身不穿过该建议边界。

策略可以替换模型可见 content、追加带 source 的内部上下文、关闭持久结构化结果，或附加一个经过校验的 artifact 引用。它不能改变工具身份、参数、canonical 实时 result 或错误状态。策略返回非法值或抛错时会产生安全诊断，并保留此前 pipeline 状态。接受的输出会复制为普通分离快照，使 getter、Proxy、稀疏数组或后续修改无法逃逸 containment。

同一 assistant 消息的全部 sibling result 会先按模型顺序提交，之后才提交 `tool_result_policy` context。每个 Agent 持有自己的策略实例和可变策略状态；接受人类输入或 Agent reset 会清空该状态。

可复用的重复调用策略以工具名和深度规范化 JSON 参数为 key；对象键顺序被忽略，数组顺序保留。审批拒绝与失败调用也计数，配置排除项是透明调用；不同的未排除调用或已接受人类输入会重置序列。只有精确命中配置阈值时才追加建议 context，不会阻止执行。

Kana 将每条新模型可见工具结果限制为：

```text
min(8000, max(256, floor(promptBudget × 25%))) estimated tokens
```

最终字节保护按每个估算 token 三个 UTF-8 字节计算。启用 `tool_result_artifacts` 后，过大的非 `read` 文本会先完整保存，再构建大约 70% head / 30% tail 的有界预览；取回 notice、精确省略字节数和 locator 也必须进入同一上限。顶层 `read` 只做有界输出，不递归创建 artifact，并说明分页无法拆分单个超长行。

实时 result 仍可通过 `tool_execution_end` 获得。ToolRuntime 将能复制且能 JSON 序列化、序列化后 UTF-8 大小不超过 128 KiB（131072 字节）的 result 完整保存在持久消息中。超限或无法序列化的 result 会整份省略；自定义策略也可显式关闭保存。这个持久化上限独立于模型上下文预算、content 上限和 artifact 创建，不截断实时 result。模型只收到 content 与 images，不收到保存的 result。恢复后的 TUI 历史和子代理查看面板依次选择 `result`、`artifact`、`content`。保留 result 时，实时与恢复后的界面使用相同结果；result 被省略时，artifact 提供已存储输出摘要。Artifact 存储路径、权限、审计、fork 与清理归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

## Codemode 沙箱

`createCodemodeSandbox({ tools, timeoutMs? })` 封装独立的 `@earendil-works/pi-codemode` 包。每次执行都会在 Worker 中创建新的 QuickJS WASM 实例来运行 JavaScript。默认 deadline 为 300000 ms，包含等待所提供工具的时间；VM heap 上限为 256 MiB。调用方可以向 `execute()` 传入 abort signal，并须在所属对象释放时关闭沙箱。取消和 timeout 会中断 VM，并中止待完成 host 工具的 signal。

脚本沿用包提供的接口：`tools`、`ALL_TOOLS`、`text`、`image`、`console`、`exit`、`store`、`load`、顶层 `await` 和 `return`。脚本无法使用 host 的文件系统、网络、进程或模块 API。注册的 host 函数通过 JSON 与脚本交换值；参数校验、审批和历史处理由调用方负责。

Factory 直接返回包提供的沙箱，不改变结果格式。成功时返回 `ok`、`value`、`output`、`calls` 和 `storeWrites`；失败时返回 `ok: false`、`error`、`output` 和 `calls`。Store 改动仅报告给调用方，不会自动持久化。这个 host API 不会注册模型可见工具。

`createCodemodeTool({ tools, mode? })` 创建名为 `run_code` 的 exclusive 工具，输入为 `{ code: string }`。描述使用 Pi 的 TypeScript renderer：`mixed`（factory 默认值）只列返回类型，`only` 列工具描述、输入类型和返回类型。外部 MCP 定义仍通过 `mcp_describe_tool` 的结构化 result 查询。脚本中的工具通过 `context.invokeTool()` 执行，返回完整的 canonical `result`；失败调用会在脚本内抛错。外层工具不请求 Kana 审批，内部调用按各自规则审批。Agent 调用的 deadline 通过 signal 控制整个脚本；这个工具关闭沙箱独立的 timer。脚本不能调用 `tools.run_code()`。

工具的 `content` 包含显式文本输出，以及随后以 JSON 编码的返回值或脚本错误。内部工具返回的图片自动加入外层 `images`；显式 `image()` 输出转为带解码尺寸的视觉观察。结构化 `result` 保留包提供的 `CodemodeResult`，包括调用名称、状态、耗时和成功时的 store 改动。Store 改动不会自动用于后续执行。实时前端收到内部执行事件；历史和 resume 后的 transcript 只保留外层结果，并遵守普通 result 保存上限。

`AgentConfig.codemode` 默认为 `off`。`mixed` 向模型提供普通工具和 `run_code`；`only` 只提供 `run_code`。Agent 同时保存模型可见的 `tools` 和脚本内部的 `callableTools`，每次组装 prompt 时一起刷新。普通 `execute()` 只查找已公开的工具；内部 `invoke()` 查找 `callableTools`。Kana 根据 `agent.codemode` 自动提供 `run_code`，而 `agent.tools` 和子 Agent 角色卡继续限制脚本能调用的工具。子 Agent 继承父模式；记忆整理保留现有工具方式。Provider 原生 web search 等能力仍按各自配置生效。

源码执行会加载本地 Worker 和 WASM。Bun 可执行文件构建将 Worker 列为额外入口，通过静态 file import 嵌入 WASM；沙箱执行不依赖 binary 旁边的外部包文件。 构建显式使用项目根目录（`--root .`），使嵌入的 Worker 路径与运行时使用的源码路径一致。

## 内置工具

| 工具 | 主要参数 | 行为 |
| --- | --- | --- |
| `list` | 可选 `path`、`includeHidden`、`limit` | 列出目录一层内容，提供稳定排序与截断 metadata。 |
| `glob` | `pattern`；可选 `cwd`、type/depth/hidden/limit filter | 用相对 glob pattern 查找路径；拒绝绝对 pattern 和 `..` 段。 |
| `grep` | `pattern`；可选 path/include/literal/case/hidden/context/limit | 用 JavaScript 正则或字面量搜索 UTF-8 文本并返回匹配位置。 |
| `read` | `path`；可选从 1 开始的 `offset` 与 `limit` | 读取 UTF-8 行区间并报告总行数与截断。 |
| `view_image` | `path` | 规范化本地图片并返回 metadata 与视觉观察；只在有效图片输入启用时注册。 |
| `write` | `path`、完整 `content`、可选 `overwrite` | 创建父目录，默认排他创建文件；显式 overwrite 才替换。 |
| `edit` | `path`、由 `oldText`/`newText` 对组成的非空 `edits` 数组 | 原子应用精确且互不重叠的 UTF-8 替换。 |
| `shell` | `command`；可选 `cwd`、`timeoutMs` | 通过用户 shell 执行，stdin 断开并使用受管进程组。 |
| `job_start` | `command`；可选 `cwd`、`timeoutMs` | 启动 session-owned 后台 shell 命令，立即返回 Job ID 与启动状态。 |
| `job_list` | 无 | 列出当前 session 活动 Job 与最多 32 个近期终态 Job，并确认列出的终态完成。 |
| `job_output` | `jobId`、可选 `waitMs` | 从 Agent cursor 消费全部当前未读保留输出，并报告丢弃字节数。 |
| `job_kill` | `jobId`、可选 `reason` | 停止所属 Job 并等待其进程组静止。 |
| `spawn_subagent` | `profile`、`task` | 启动一个预定义的 session-owned child，并立即返回 Agent ID。 |
| `wait_subagent` | `agentId`、可选 `timeoutMs` | 读取或短暂等待所属 child 的状态与最终输出。 |
| `cancel_subagent` | `agentId`、可选 `reason` | 取消所属 child 并等待结算。 |
| `todo_write` | 完整 todo item 数组 | 原子替换或显式清空 session todo 状态。 |
| `delegate_user_task` | 具体的 `task` 文本 | 邀请用户并行处理任务；接受后创建进程内任务 ID。 |
| `remember` | `content`；可选 scope/title/reason | 记忆启用时追加长期记忆暂存记录。 |
| `schedule_wake` | `afterMinutes`、`message`、可选 `key` | 为活动 session 创建进程内未来输入。 |
| `update_goal` | `status`、可选 `detail` | 把已授权活动 Goal 结束为 completed 或 blocked。 |

`list`、`glob`、`grep`、`read`、`view_image`、`mcp_list_tools`、`mcp_describe_tool` 与三个 subagent 控制工具声明为 `parallel`。写入、Shell、记忆、调度、Goal 更新以及未声明第三方/MCP 工具都是 `exclusive`。

## 文件与 Shell 边界

文件工具和 `shell` 把相对路径解析到配置 root；Kana 将其设为启动工作目录。它们也接受绝对路径。path 参数开头的 `~` 或 `~/` 会展开为用户的 home 目录，因此 `~/notes.md` 不会再变成 root 内的字面量 `~` 目录；出现在首段之后的 `~` 仍保持字面量，而 `glob.pattern` 与 `grep.include` 是相对 glob 而非路径。这是路径规范化，不是 workspace sandbox：相对路径可以离开 root，符号链接可能解析到外部，`shell.cwd`、`glob.cwd` 与 `grep.path` 也可以指定外部位置。

`grep.context` 是非负整数，默认 0，无上限。每条匹配独立输出前后指定行数，文件边界处截断，重叠上下文不合并。匹配行保留 `path:line:column:text`，上下文行为 `path-line-text`；`limit` 只计算匹配行，通用结果大小限制仍然适用。

`edit` 会在同一份原始文件内容上分别对每个 `edits[].oldText` 做一次精确唯一匹配。文本缺失、匹配不唯一或替换区间重叠时，整次调用都会在不写文件的情况下失败；否则全部替换通过一次写入提交。

`view_image` 与用户附件共用 decoder 和大小限制。支持的 JPEG、PNG 与 WebP 保持 provider-ready；其它解码格式变成静态 PNG，动画输入使用解码后的首帧。

`shell` 接受文件名为 `sh`、`bash` 或 `zsh` 的可执行程序名称或路径。`$SHELL` 在支持范围内时使用它，否则回退到 `bash`。这些 shell 支持注入的函数语法，用于把 `sudo` 替换为 `sudo -n`，避免密码提示占用 TUI 输入；stdin 断开。前台调用默认 command timeout 为 30000 ms，最大接受 300000 ms，大约每 100 ms 发布一次有界 stdout/stderr 尾部快照；完整最终 stream 仍进入通用结果策略。

每条命令在独立进程组中运行。前台执行等待整个进程组，而不只是顶层 shell，因此裸 `command &` 不会逃过正常取消或 timeout；显式 daemonize 到另一个 process session 仍可能离开该边界。非 0 exit code 是已完成命令结果，不是工具基础设施错误；timeout 使用 `null` exit code 与 `isError: true`。

## 后台 Jobs

`job_start` 在 `BackgroundJobManager` 下启动同一 Shell 执行，立即返回 session-owned Job ID，并且默认没有 command timeout。需要工作跨越一次工具调用时应使用它；裸 shell 后台语法不提供相同的 owner 与清理语义。

通用 manager 不依赖 Kana Agent 构造。Owner 把 Job 绑定到一个 session 实例，执行并发上限，并在 dispose 时停止全部所属进程组。每个 Job 在内存中最多保留最新 1 MiB stdout/stderr。Metadata 只保存空白规范化且不超过 512 UTF-8 字节的命令 label；原始命令仍在 tool call 中。

`job_output` 使用一个消费型 Agent cursor，并在一次调用中返回全部当前未读保留输出；`droppedBytes` 报告消费前已经淘汰的输出。TUI 使用另一条非消费 tail，最多 20 KiB。每个 owner 最多保留 32 个终态 Job，较旧条目会被裁剪。Job 与保留 buffer 永不持久化或恢复。

Kana 把活动或尚未报告 Job 的身份、有界 label、cwd、状态和 exit code 投影到 runtime context，永不包含输出。完成 steering、排队 run 投递、确认与 session 切换顺序归[对话运行时](conversation-runtime.zh-CN.md)所有。

Subagent 控制工具只暴露预定义角色卡，并返回稳定 child ID。其能力交集、异步生命周期、持久化与 TUI 行为归 [Subagent](subagents.zh-CN.md)所有。

## Kana 自有状态工具

`todo_write` trim 每项内容，拒绝空白或重复内容和未知字段，最多允许一项 `in_progress`，并确保校验失败后不部分修改。完整接受列表属于当前 session；只有显式空数组才清空。最新状态会在压缩、resume 与 fork 后重新投影，工具结果保持固定紧凑确认。Journal 表示归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

`remember` 向 project 或 global daily memory 追加结构化记录，不直接编辑长期 `memory.md`；合并与保留归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

`schedule_wake` 校验 1–1440 分钟延迟和有界非空消息，再通过 Host 进程内 wake 边界安排。它与 `update_goal` 只在产品装配提供所需 runtime capability 时可用。投递与 Goal admission 归[对话运行时](conversation-runtime.zh-CN.md)所有。

Kana 永不为 `spawn_subagent`、`wait_subagent`、`cancel_subagent`、`todo_write`、`remember`、`schedule_wake`、`update_goal`、`mcp_list_tools` 或 `mcp_describe_tool` 请求审批。`delegate_user_task` 始终询问用户是否接受任务，包括 `never` 模式；拒绝会返回正常结果，任务仍由 Agent 完成。其它调用（包括 `mcp_call`）遵循配置的 `always`、`unless_trusted` 或 `never`。在 `unless_trusted` 中，只读内置工具以及经过严格识别的只读或精确 allowlist Shell 命令可以自动通过；第三方和 MCP 工具不会隐式获得信任。`job_start` 不使用 Shell allowlist，除非策略为 `never`，否则需要审批。审批是交互授权，不是文件系统或进程隔离。

## MCP 与自定义工具

全部工具使用普通 `Tool` 契约。当前 registry 可用且 `agent.tools` 选中入口时，Kana 将其创建为内置工具。MCP 暴露 `mcp_list_tools`（parallel，列出名称和描述）、`mcp_describe_tool`（parallel，查询单个工具 schema）和 `mcp_call`（exclusive、普通审批）。Schema 查询的 content 与 result 都返回 server、工具名称和 input schema；result 额外包含可选 output schema，content 不包含它。远端 input schema 在调用入口内部执行校验。调用结果使用相同的规范化与 content 上限。MCP 目录、SDK transport 与结果适配见 [MCP](mcp.zh-CN.md)。

自定义工具应：

- 优先使用 TypeBox 1.x，让 TypeScript 保留参数类型。
- 需要拒绝未知对象字段时声明 `additionalProperties: false`。
- 返回简短、对模型有用的 `content` 和可序列化结构化 `result`；`images` 只用于合法 `UserImage` 观察。
- 观察 `context.signal`，并用 `context.update` 发布有界进度。
- 抛出可操作的 `Error`；ToolRuntime 会转成模型可见失败。
- 对任何会改变用户状态的操作，在产品层决定审批和前端展示。
