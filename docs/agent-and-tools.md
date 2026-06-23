# Agent 与工具执行协议

本文描述 Kana 从模型流到工具执行的通用运行时协议。它面向希望阅读、测试或扩展 `src/core`、`src/agent` 和 `src/tools` 的贡献者；产品级配置和审批规则见[配置与安装](configuration.md)。

## 三种历史消息

Agent 历史只使用三种 `Message`：

| 角色 | 主要字段 | 用途 |
| --- | --- | --- |
| `user` | `content: string` | 用户输入。 |
| `assistant` | 有序 `content`、可选 `stopReason` 与 `usage` | 保存模型输出和它提出的工具调用。 |
| `tool` | `toolCallId`、`toolName`、`content`、`result`、`isError` | 将某一个工具调用的结果关联回模型。 |

助手消息的 `content` 是有序数组，而不是按类别分组。元素为 `text`、`thinking` 或 `tool_call`；每个流事件的 `contentIndex` 都指向这个数组。这使“思考 → 文本 → 工具调用”之类的交错输出能够原样回传供应商并按顺序渲染。

工具结果有两层：`content` 是给模型的文本，`result` 保留原始结构化值给 Agent、TUI 和持久化使用。工具直接返回普通值时，运行时会将字符串原样或将其他值 JSON 序列化为 `content`，同时把原值作为 `result`。

## 两层流事件

模型实现产生 `AssistantMessageEvent`。除 `done`/`error` 外，事件携带已经应用当前增量后的完整消息快照：

```text
start
  → thinking_start / thinking_delta* / thinking_end
  → text_start / text_delta* / text_end
  → toolcall_start / toolcall_delta* / toolcall_end
  → done | error
```

并非每种内容都必须出现。`done` 的原因是 `stop`、`length` 或 `toolUse`；`error` 的原因是 `aborted` 或 `error`。`AssistantEventStream.end()` 会把结束原因和用量写入最终助手消息，`error()` 则先发出错误事件，再拒绝 `result()`。

Agent 将它包装为应用级的 `AgentEvent`：

```text
agent_start
  → turn_start
  → message_start / message_update* / message_end
  → tool_execution_start / tool_execution_update* / tool_execution_end
  → turn_end
  → …（下一回合）
  → agent_end
```

两个流都可用 `for await` 消费实时事件，并可用 `result()` 等待最终结果。消费者不应修改事件中的消息；Agent 发送给监听器和对外 `state` 的消息均为深拷贝。

## 回合循环

`runAgentLoop(context, config, emit)` 的逻辑如下：

```text
复制输入 context
发出 agent_start
重复（默认最多 8 回合；maxTurns = -1 时不限）：
  若 signal 已中止，结束
  发出 turn_start
  流式读取助手消息，并把每个快照写入当前 context
  将可保留的助手消息加入新消息列表
  若模型错误或已中止，发出 turn_end 后结束
  仅当 stopReason = toolUse 时取出 tool_call 内容
  按出现顺序执行这些工具，并将结果加入 context 与新消息列表
  发出 turn_end
  若没有工具调用或执行要求中止，结束
发出 agent_end，返回本次新增消息
```

Kana 产品默认 `max_turns = -1`，但独立使用 `Agent`/`runAgentLoop` 时未提供配置的默认值是 8。工具调用即使由模型在同一条消息中同时提出，也按内容顺序串行执行；后一个调用不会在前一个结束前开始。

只有助手消息以 `toolUse` 正常结束时，工具才会执行。长度截断的消息即使带有工具调用也不会执行。发生 provider error 且助手没有任何内容时，该空助手消息不会写入历史；中止的消息会移除其中未执行的工具调用，但若仍有文本或 thinking 内容则保留该部分。

## `Agent` 的生命周期

`Agent.stream(input)` 立即把用户输入追加到内部历史，然后异步启动循环。它在任意时刻只允许一个活动运行；并发调用会得到错误流。`prompt(input)` 是等待 `stream(input).result()` 的便捷方法。

运行期间，`Agent.state` 暴露：模型、系统提示词、工具、历史、`isRunning`、当前流式助手消息、尚未结束的工具调用 ID，以及最终错误。`abort()` 中止该运行的 `AbortController`；`waitForIdle()` 等待当前运行；`reset()` 清空历史和运行状态。`onRunCommitted` 只在收到 `agent_end` 后调用，产品层用它安全地追加会话记录。

## 工具调用的前置与错误语义

每个调用按以下顺序处理：

1. 按名称查找工具；找不到时生成错误工具结果。
2. 对原始参数深拷贝后执行 `TypeBox Value.Convert`，再使用编译缓存的 schema 校验。
3. 调用可选的 `beforeToolExecution` 钩子。Kana TUI 在此显示审批界面。
4. 检查中止信号，发出 `tool_execution_start`，执行工具。
5. 工具可调用 `context.update(partialResult)`；运行时会发出对应更新事件，并在结束前等待这些事件的监听器完成。
6. 规范化返回值，发出 `tool_execution_end`，再将 `ToolResultMessage` 加入模型上下文。

参数校验失败和工具抛出的异常不会使循环本身抛出：它们成为 `isError: true` 的工具结果，模型能在下一回合看到失败原因。审批钩子返回 `cancel` 时默认中止整个运行，并为之后尚未执行的同消息工具补充“已取消”错误结果。中止发生在执行前也遵循同样的补全规则。

工具接口为：

```ts
type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(args, context): ToolResult | unknown | Promise<ToolResult | unknown>;
};

type ToolContext = {
  toolCallId: string;
  signal?: AbortSignal;
  update(partialResult: unknown): void;
};
```

## 内置工具

| 工具 | 参数 | 行为与结果 |
| --- | --- | --- |
| `read` | `path`，可选 `offset`（从 1 开始）、`limit`（1–2000，默认 200） | 读取 UTF-8 文本，返回行区间、总行数和 `truncated`。 |
| `write` | `path`、完整 `content` | 递归创建父目录，并以排他创建方式写入新文件；目标已存在即失败。返回 UTF-8 字节数。 |
| `edit` | `path`、非空 `oldText`、`newText`、可选 `replaceAll` | 对既有 UTF-8 文件做精确替换。默认要求恰好一次匹配；返回替换数、写入字节数及前后文本。 |
| `bash` | `command`，可选 `cwd`、`timeoutMs`（1–120000，默认 30000） | 用用户 shell 的 login command 模式执行，返回退出码、stdout、stderr、超时和截断状态。 |
| `remember` | `content`，可选 `scope`、`title`、`reason` | 向每日记忆记录持久信息，返回宿主生成的记忆条目。仅在记忆启用时注册。 |

`bash` 的 stdin 始终断开；它把 `sudo` 定义为 `sudo -n`，避免密码提示占用 TUI。stdout/stderr 在运行期间约每 100ms 发送部分更新，最终每个流最多保留 20,000 个 JavaScript 字符。每次命令在独立进程组中运行；取消或超时会终止整组，避免后台子进程残留或继续占用输出流。顶层 shell 已退出时，工具会在短暂排空输出后返回，因此后台任务不会阻塞工具结果。超时的退出码记为 `null`，并将结果标为错误。

`read`、`write`、`edit` 和 `bash` 都会解析相对路径相对于工具的 `root`（Kana 中为启动时的工作目录），也接受绝对路径。它们不是工作区沙箱：相对路径可越出 root，符号链接可解析到外部，`bash.cwd` 也可在外部。请将审批理解为交互确认，而不是文件系统隔离。

## 自定义工具的约束

- 始终使用 TypeBox schema；运行时没有 JSON Schema 回退路径。
- 返回可序列化的结构化 `result`，并提供简短、对模型有用的 `content`。
- 对可长时间运行的工具检查 `context.signal`，并用 `context.update` 提供进度。
- 让失败抛出有操作意义的 `Error`；循环会将其安全转换为模型可见的工具结果。
- 若工具会改变用户状态，需在产品装配层决定审批策略，并为 TUI 提供可理解的显示格式。
