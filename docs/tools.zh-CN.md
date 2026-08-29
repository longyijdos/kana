# 工具与执行

核心 `ToolSpec` 是 provider 可见的名称、描述和 JSON Schema。可执行 `Tool` 在此基础上增加 `execute` 与可选执行 metadata。`ToolRuntime` 接收一次 model step 实际公开的工具对象，把模型提出的每个调用转换成规范化、可观察的结果，并把普通工具失败限制在 Agent loop 内。

## 工具与结果合同

```ts
type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
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

规范化结果面向不同消费者：

- `content` 是返回模型的有界文本。
- `images` 携带 provider-neutral 视觉观察。
- `result` 是实时 Agent 与前端使用的 canonical 结构化 host 值。
- `artifact` 标识保存在消息外部的完整文本。
- `isError` 告诉模型操作失败。

工具直接返回字符串时，它成为 `content`；其它普通值会 JSON 序列化为 content，并保留为实时结构化结果。显式结果字段格式错误时，会在消息提交前变成安全工具失败。

## 调用管线

每个调用都进入同一条受控管线：

1. 按名称解析工具；找不到时生成错误结果。
2. 深拷贝参数，应用兼容的基础类型转换，再使用缓存的 TypeBox compiler 校验。
3. 调用 `beforeToolExecution`；审批 hook 始终串行进入，并可允许或取消调用。
4. 检查 run cancellation，发出 `tool_execution_start`，创建调用 signal 并启动有效 deadline。
5. 串行发布 `context.update()`，并在终态前等待每个 listener。
6. 规范化物理结果并发出 `tool_execution_end`。
7. 应用结果策略，再通过按模型顺序排列的 slot 提交 sibling 结果，之后才能开始下一模型请求。

Kana 自有对象 schema 使用 `additionalProperties: false`，未声明参数会带属性名失败，而不是被忽略。序列化后失去库 metadata 的 TypeBox schema 仍会先补充兼容基础类型转换，再交给同一 compiler 校验。第三方和 MCP schema 保留自身声明的额外属性行为。

校验错误、审批拒绝、取消、deadline 到期与工具异常都会成为 `isError: true` 结果，不会抛出 turn loop。审批取消默认中止 run，并为同一 assistant 消息中后续调用补充 canceled 结果，而不执行它们。

`tool_execution_end` 描述物理完成、取消或明确 unknown 终态，不保证结果已进入 journal。成功的 Agent run 才是持久边界；提交和恢复顺序见[会话与记忆](sessions-and-memory.zh-CN.md)。

## 并发、取消与 deadline

只有 Agent policy 与模型 metadata 都允许 parallel tool call 时才会并行；否则 provider 收到 `parallelToolCalls: false`，所有调用串行执行。启用后，也只有声明为 `parallel` 的相邻调用组成并发组；`exclusive`、未声明、缺失或非法工具仍是 barrier。

每个并行组使用有界滚动池。调用按模型顺序 claim 并串行进入审批，同时运行的调用 body 不超过 `maxParallelToolCalls`。Start、update 和 end event 都按 `toolCallId` 关联并遵循物理时间，因此后面的快速调用可能先显示完成。独立 result slot 会等待模型顺序后才写入 journal 并进入下一请求，保证 replay 确定性。

有效 deadline 优先使用 `tool.execution.deadlineMs`，否则使用 Agent 默认值。可复用 runtime 默认 300000 ms；Kana 通过 `agent.tool_deadline_ms` 默认配置为 660000 ms。`bash.timeoutMs` 等调用参数可以在这个外层边界内施加更窄的操作限制。

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

实时结构化 result 仍可通过 `tool_execution_end` 获得。过大、不可序列化或 artifact-backed 的结构化数据会独立从持久消息中省略。Artifact 存储路径、权限、审计、fork 与清理归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

## 内置工具

| 工具 | 主要参数 | 行为 |
| --- | --- | --- |
| `list` | 可选 `path`、`includeHidden`、`limit` | 列出目录一层内容，提供稳定排序与截断 metadata。 |
| `glob` | `pattern`；可选 `cwd`、type/depth/hidden/limit filter | 用相对 glob pattern 查找路径；拒绝绝对 pattern 和 `..` 段。 |
| `grep` | `pattern`；可选 path/include/literal/case/hidden/limit | 用 JavaScript 正则或字面量搜索 UTF-8 文本并返回匹配位置。 |
| `read` | `path`；可选从 1 开始的 `offset` 与 `limit` | 读取 UTF-8 行区间并报告总行数与截断。 |
| `view_image` | `path` | 规范化本地图片并返回 metadata 与视觉观察；只在有效图片输入启用时注册。 |
| `write` | `path`、完整 `content`、可选 `overwrite` | 创建父目录，默认排他创建文件；显式 overwrite 才替换。 |
| `edit` | `path`、非空 `oldText`、`newText`、可选 `replaceAll` | 精确替换 UTF-8 内容；默认要求一次匹配。 |
| `bash` | `command`；可选 `cwd`、`timeoutMs`、`background` | 通过用户 shell 执行，stdin 断开并使用受管进程组。 |
| `job_list` | 无 | 列出当前 session 活动 Job 与最多 32 个近期终态 Job，并确认列出的终态完成。 |
| `job_output` | `jobId`、可选 `waitMs` | 从 Agent cursor 消费全部当前未读保留输出，并报告丢弃字节数。 |
| `job_kill` | `jobId`、可选 `reason` | 停止所属 Job 并等待其进程组静止。 |
| `todo_write` | 完整 todo item 数组 | 原子替换或显式清空 session todo 状态。 |
| `remember` | `content`；可选 scope/title/reason | 记忆启用时追加长期记忆暂存记录。 |
| `schedule_wake` | `afterMinutes`、`message`、可选 `key` | 为活动 session 创建进程内未来输入。 |
| `update_goal` | `status`、可选 `detail` | 把已授权活动 Goal 结束为 completed 或 blocked。 |

`list`、`glob`、`grep`、`read` 与 `view_image` 声明为 `parallel`。写入、Shell、记忆、调度、Goal 更新以及未声明第三方/MCP 工具都是 `exclusive`。

## 文件与 Shell 边界

文件工具和 `bash` 把相对路径解析到配置 root；Kana 将其设为启动工作目录。它们也接受绝对路径。这是路径规范化，不是 workspace sandbox：相对路径可以离开 root，符号链接可能解析到外部，`bash.cwd`、`glob.cwd` 与 `grep.path` 也可以指定外部位置。

`view_image` 与用户附件共用 decoder 和大小限制。支持的 JPEG、PNG 与 WebP 保持 provider-ready；其它解码格式变成静态 PNG，动画输入使用解码后的首帧。

`bash` 断开 stdin，并把 `sudo` 替换为 `sudo -n`，避免密码提示占用 TUI 输入。前台调用默认 command timeout 为 30000 ms，大约每 100 ms 发布一次有界 stdout/stderr 尾部快照；完整最终 stream 仍进入通用结果策略。

每条命令在独立进程组中运行。前台执行等待整个进程组，而不只是顶层 shell，因此裸 `command &` 不会逃过正常取消或 timeout；显式 daemonize 到另一个 process session 仍可能离开该边界。非 0 exit code 是已完成命令结果，不是工具基础设施错误；timeout 使用 `null` exit code 与 `isError: true`。

## 后台 Jobs

`background: true` 在 `BackgroundJobManager` 下启动同一 Bash 执行，立即返回 session-owned Job ID，并且默认没有 command timeout。需要工作跨越一次工具调用时应使用它；裸 shell 后台语法不提供相同的 owner 与清理语义。

通用 manager 不依赖 Kana Agent 构造。Owner 把 Job 绑定到一个 session 实例，执行并发上限，并在 dispose 时停止全部所属进程组。每个 Job 在内存中最多保留最新 1 MiB stdout/stderr。Metadata 只保存空白规范化且不超过 512 UTF-8 字节的命令 label；原始命令仍在 tool call 中。

`job_output` 使用一个消费型 Agent cursor，并在一次调用中返回全部当前未读保留输出；`droppedBytes` 报告消费前已经淘汰的输出。TUI 使用另一条非消费 tail，最多 20 KiB。每个 owner 最多保留 32 个终态 Job，较旧条目会被裁剪。Job 与保留 buffer 永不持久化或恢复。

Kana 把活动或尚未报告 Job 的身份、有界 label、cwd、状态和 exit code 投影到 runtime context，永不包含输出。完成 steering、排队 run 投递、确认与 session 切换顺序归[对话运行时](conversation-runtime.zh-CN.md)所有。

## Kana 自有状态工具

`todo_write` trim 每项内容，拒绝空白或重复内容和未知字段，最多允许一项 `in_progress`，并确保校验失败后不部分修改。完整接受列表属于当前 session；只有显式空数组才清空。最新状态会在压缩、resume 与 fork 后重新投影，工具结果保持固定紧凑确认。Journal 表示归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

`remember` 向 project 或 global daily memory 追加结构化记录，不直接编辑长期 `memory.md`；合并与保留归[会话与记忆](sessions-and-memory.zh-CN.md)所有。

`schedule_wake` 校验 1–1440 分钟延迟和有界非空消息，再通过 Host 进程内 wake 边界安排。它与 `update_goal` 只在产品装配提供所需 runtime capability 时可用。投递与 Goal admission 归[对话运行时](conversation-runtime.zh-CN.md)所有。

Kana 永不为 `todo_write`、`remember`、`schedule_wake` 或 `update_goal` 请求审批。其它调用遵循配置的 `always`、`unless_trusted` 或 `never`。在 `unless_trusted` 中，只读内置工具以及经过严格识别的只读或精确 allowlist Bash 命令可以自动通过；第三方和 MCP 工具不会隐式获得信任。审批是交互授权，不是文件系统或进程隔离。

## 外部与自定义工具

MCP 与其它外部工具通过同一个 `Tool` 契约进入 Agent。它们保留自身 schema 行为，默认 exclusive，经过普通审批，并使用相同的结果规范化与 content 上限。MCP 专用 discovery、alias、transport 与结果适配见 [MCP](mcp.zh-CN.md)。

自定义工具应：

- 优先使用 TypeBox 1.x，让 TypeScript 保留参数类型。
- 需要拒绝未知对象字段时声明 `additionalProperties: false`。
- 返回简短、对模型有用的 `content` 和可序列化结构化 `result`；`images` 只用于合法 `UserImage` 观察。
- 观察 `context.signal`，并用 `context.update` 发布有界进度。
- 抛出可操作的 `Error`；ToolRuntime 会转成模型可见失败。
- 对任何会改变用户状态的操作，在产品层决定审批和前端展示。
