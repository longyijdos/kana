# 实验性 HTTP 服务

`kana serve` 通过 Bun 原生 HTTP 服务暴露共享对话运行时。它是单用户、单工作目录、单活跃 session 的前端，不是多租户服务。不增加包依赖，也不提供 UI。

## 启动与生命周期

```bash
export KANA_SERVER_TOKEN="$(openssl rand -hex 32)"
bun src/main.ts serve                 # 源码运行
kana serve --port 8318               # 编译后的二进制
```

默认端口为 8318；`--port` 接受 1 至 65535 的整数。监听地址固定为 `127.0.0.1`。所有路由（包括 SSE）都要求 `Authorization: Bearer <token>`。缺少或空白 `KANA_SERVER_TOKEN` 会在创建产品资源前拒绝启动。沿用通常的环境与配置加载，支持 `--set` 和 `--clean`。

此入口只提供 HTTP。HTTPS、证书、续期、公网入口和进程托管属于部署层。禁止通过未加密的公网代理暴露：token 授权调用 Agent 的真实工具和本地文件，并非操作系统沙箱。不提供 CORS 头。原生客户端和未来同源前端可发送 Authorization 头；浏览器 `EventSource` 无法设置该头，应使用流式 `fetch`。不接受 URL 中的 token，也不记录 token。

启动创建新 session，并在接受请求前初始化已启用 MCP server；非 ready 的 MCP 诊断写入 stderr。Normal session 使用与 TUI 相同的工作目录级持久化。重启不自动恢复旧 session 或续跑中断任务，定时唤醒、排队输入、Goal、Job 和待审批请求也不恢复。客户端断开不会取消 Agent 执行或待审批请求。`SIGINT`、`SIGTERM` 会停止接入、关闭事件流，再按既有顺序等待 runtime 和 host 清理。

Clean 模式保留临时 session 创建和核心执行，移除持久资源与可选项目能力。Clean 模式下 fork、resume、删除已保存 session 返回 400。此 API 不注册 `delegate_user_task`，不解析 TUI 斜杠命令，也不提供模型、Skill、MCP 管理端点。

## HTTP 契约

JSON 成功响应为 `{schema_version: 1, data: ...}`；错误为 `{schema_version: 1, error: {code, message}}`。JSON 响应和 SSE 都将 BigInt 编码为十进制字符串，不改变执行期的原始结果。其他值沿用标准 JSON 序列化规则，不支持循环引用。请求体必须是 JSON 对象，原生 server 限制请求体为 1 MiB。未知路由返回 404，鉴权失败返回 401，输入无效返回 400，session 不匹配或切换忙碌返回 409，关闭阶段返回 503。意外失败返回通用 500，并写入安全的结构化诊断。

| 方法与路径 | 请求 | 结果 |
| --- | --- | --- |
| GET /v1/state | — | 完整当前状态快照 |
| GET /v1/events | — | 首帧为快照的 SSE |
| GET /v1/sessions | — | `current_session_id` 与已保存 session metadata，不含活跃 session |
| POST /v1/sessions | 无请求体 | 创建并激活新 session；201，含 `session_id` |
| POST /v1/sessions/fork | `{session_id, prompt?}` | Fork 并激活；201，含 `session_id` |
| POST /v1/sessions/:id/resume | 无请求体 | 恢复并激活；`session_id` |
| DELETE /v1/sessions/:id | 无请求体 | 删除非活跃已保存 session；`{deleted: true}` |
| POST /v1/messages | `{session_id, message, delivery?}` | 接收入队；202，含 `message_id`、`delivery` |
| POST /v1/abort | `{session_id}` | 请求取消；202，含 `{stopping: true}` |
| GET /v1/approvals | — | 待审批请求 |
| POST /v1/approvals/:id | `{session_id, decision}` | 完成审批；`{resolved: true}` |

消息、停止、fork、审批决策要求当前 `session_id`，避免过期客户端误操作刚切换的 session。创建、fork、恢复、删除要求 runtime 空闲。已保存 session 限于启动工作目录；活跃 session 不可删除。

消息 `delivery` 默认为 `auto`：空闲时启动 run；执行中且可 steer 时进入 steering lane；其他执行中输入进入 next-turn 队列。`queue` 总是进入该队列。响应 delivery 为 `submitted`、`steering` 或 `queued`，只确认接收，不表示执行完成。Steering 可能按既有 runtime 语义转为排队。Abort 沿用原取消策略，不额外清空排队消息；通过事件和状态观察后续执行。

## 审批

沿用 TUI 的配置策略和持久化命令信任来判断工具是否需要审批。每项包含 `id`、`session_id`、请求方 `agent`、`tool_call: {id, name, arguments}` 和 `allow_always`。主 Agent 与委派 Agent 使用同一个 hook。

决策为 `allow`（单次）、`reject`（中止 run）、`always`（持久化精确 shell 命令信任）、`never`（当前 session 临时不再询问）。仅 shell 命令支持 `always`。永久信任和临时 never 也会放行符合条件的待审批请求。临时模式在 session 切换时重置；取消与关闭会拒绝尚未决策的请求。已完成审批的 ID 返回 404。没有客户端连接时，不受信任工具继续等待决策、取消或关闭。

## 状态与事件协议

快照包含 `session`（ID、消息、timeline 或 null）、`running`（runtime 执行互斥状态）、`run`（最近进程内 ID、source、status、可选 outcome/error 或 null）、`assistant`（生成中的消息或 null）、`tools`（当前 run 的外层执行状态）、`input_queue`、`todo`、`goal`、`approvals`。消息采用 Core 的供应商中立结构，但不暴露 assistant content 中的 opaque `providerState` 或 context checkpoint。Run status 为 `running`、`completed`、`failed`；completed 不一定成功，需检查 `stop`、`aborted`、`error` 等 outcome。

`session.messages` 是消息正文的权威集合。`session.timeline` 的 message entry 使用 `message_id` 替代内嵌 `message`，通过 `session.messages[].id` 查找正文。Entry 的 `id`、`parentId`、`timestamp` 以及 timeline 顺序均保留；非 message entry 不变。这样保留交错历史，又不重复传输消息文本、图片或结构化结果。

每个 SSE 帧的 `event` 名与 JSON `type` 相同，`data` 为对象：

```text
event: run.started
data: {"schema_version":1,"type":"run.started","session_id":"...","run_id":"...","data":{"source":"user","input":{...}}}
```

首帧总是以最新快照替换客户端状态，后续事件无订阅空窗地跟随快照。每 15 秒发送心跳注释。慢消费者的待发送流缓冲达到 1 MiB 时断开，不阻塞 Agent；重连以重新同步。不支持事件回放或 `Last-Event-ID`。新进程/session 重置临时投影；收到 `session.changed` 后重新获取状态以替换历史。

| 事件 | Data |
| --- | --- |
| snapshot | 完整状态快照 |
| run.started | `source` 与已接收 `input` |
| run.completed | `outcome` 与可选 `goal` |
| run.failed | `error: {name, message}` |
| session.changed | `action`、`session_id` |
| input.queue_changed | Runtime 队列快照 |
| input.committed | 已消费 steering 用户 `message` |
| todo.changed / goal.changed | Todo 变更 / Goal 变更与状态 |
| assistant.started / assistant.completed | `message` |
| assistant.delta | `message_id`、`kind`、`content_index`、`delta` |
| assistant.content | `message_id`、`content_index`、替换的 `content` 块 |
| model_turn.started / model_turn.completed | `turn`；完成时另含 `usage` |
| tool.started | 工具身份、`status`、`arguments` |
| tool.updated | 工具身份、`partial_result` |
| tool.completed | 工具身份、`status`、`result`、`is_error` |
| tool.paused / tool.resumed | 工具身份、审批 `reason` |
| context.compaction_started / context.compacted | Reason、token 数与 context limit；完成时另含 usage |
| approval.required / approval.resolved | 待审批项 / `{id, decision}` |

工具身份为 `tool_call_id`、`name`。Code Mode 仅投影外层生命周期和输出，不暴露嵌套执行事件。工具完成不等于 journal 已提交：应等待 `run.completed`，并单独处理 `run.failed`。客户端忽略未知事件类型和新增字段。Delta 可更新文本、thinking 或原始工具参数，content 块事件和完整消息是权威替换值。
