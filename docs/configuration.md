# 配置与安装

本文说明 Kana 当前实现的启动命令、配置文件和本地目录。配置以 Bun TOML 解析；字段名使用 `snake_case`，而代码内部使用 `camelCase`。

## 安装与启动

```bash
# 创建默认本地配置
kana install

# 同时安装或更新默认的全局 Skills 仓库
kana install --skills

# 覆盖现有 config.toml、approvals.json 和 skills.toml，必要时重新克隆 Skills
kana install --force --skills

# 启动 TUI；参数会作为第一条提示词
kana 修复测试失败

# 按 ID 恢复会话；省略 ID 时打开选择器
kana resume [session-id]
```

`kana install` 不会覆盖已经存在的文件。`--force` 会将 `config.toml`、`approvals.json` 和 `skills/skills.toml` 恢复为默认内容；若使用 `--skills`，还会删除并重新克隆默认 Skills 目录。它**不会**创建 `~/.kana/AGENTS.md`，全局指令文件需要用户自行创建。

默认 Skills 仓库是 `https://github.com/longyijdos/kana-skills.git`，安装位置为 `<KANA_HOME>/skills/kana-skills`。已有目录不是 Git 仓库时，普通更新会报错，必须使用 `--force` 才会替换它；已有 Git 仓库则执行 `git pull --ff-only`。

## 根目录与文件布局

Kana 使用 `KANA_HOME` 指定根目录；未设置时使用 `$HOME/.kana`，若 `HOME` 也不存在则回退到操作系统返回的用户主目录。

```text
${KANA_HOME:-$HOME/.kana}/
├── config.toml             # 本文的运行配置
├── approvals.json          # bash 信任规则
├── AGENTS.md               # 可选：全局系统指令，不由 install 创建
├── sessions/               # 按工作区分组的 JSONL 会话
├── logs/                   # 按工作区和会话分组的运行时 JSONL 日志
├── memory/                 # global 与 project 的记忆
└── skills/
    ├── skills.toml         # 全局 Skill 的启用列表
    └── kana-skills/        # `kana install --skills` 克隆的默认仓库
```

安装和应用写入的配置文件均以 `0600` 模式创建或写入。该权限是文件模式请求；实际效果仍受操作系统和文件系统 umask/权限模型影响。

## `config.toml`

配置文件不存在时，Kana 直接使用内置默认值。文件存在时，各个已提供字段覆盖默认值，未提供字段仍继承默认值；例如只写 `[model] name` 不会删除该表中的其他默认项。

执行 `kana install` 后得到的等价默认配置如下：

```toml
[model]
provider = "deepseek"
name = "deepseek-v4-pro"
api_key_env = "DEEPSEEK_API_KEY"
thinking = true
reasoning_effort = "high"
max_tokens = 8192
timeout_ms = 60000
max_retries = 1

[agent]
max_turns = -1

[approval]
mode = "unless_trusted"

[notification]
backend = "auto"
on_agent_completed = true
on_approval_required = true

[memory]
enabled = true
max_chars = 6000
# daily_retention_days = 30

[logging]
level = "info"
```

### `[model]`

| 键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `provider` | 仅 `deepseek` | `deepseek` | 当前产品配置唯一支持的供应商。 |
| `name` | 非空字符串 | `deepseek-v4-pro` | 模型名；运行时会拒绝不在 DeepSeek 元数据表中的模型。 |
| `api_key_env` | 非空字符串 | `DEEPSEEK_API_KEY` | 保存 API key 的环境变量名；key 不写入 TOML。 |
| `thinking` | 布尔值 | `true` | 是否在 DeepSeek 请求中显式启用 thinking。 |
| `reasoning_effort` | `high` 或 `max` | `high` | DeepSeek 推理强度；`thinking = false` 时不会发送该字段。 |
| `max_tokens` | 有限数字 | `8192` | 单个请求的输出 token 上限；不能超过所选模型的硬上限。 |
| `timeout_ms` | 有限数字 | `60000` | 单个 DeepSeek HTTP 请求的超时毫秒数。 |
| `max_retries` | 有限数字 | `1` | 可重试请求失败后的最大重试次数。 |

启动前必须在环境中设置 `api_key_env` 指定的变量。例如默认配置使用：

```bash
export DEEPSEEK_API_KEY='sk-...'
```

### 其他配置表

| 表与键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `agent.max_turns` | 有限数字；`-1` 表示不限 | `-1` | 一次用户运行中模型—工具回合的最大数。 |
| `approval.mode` | `always`、`unless_trusted`、`never` | `unless_trusted` | 工具调用是否进入 TUI 审批。 |
| `notification.backend` | `auto`、`off`、`bell`、`osc9`、`osc777`、`kitty` | `auto` | 终端通知输出协议。`auto` 依次识别 Kitty、iTerm、VTE，否则退回 bell。 |
| `notification.on_agent_completed` | 布尔值 | `true` | 正常完成的 Agent 运行是否通知。中止、错误或长度截断不会视作完成。 |
| `notification.on_approval_required` | 布尔值 | `true` | 显示工具审批时是否通知。 |
| `memory.enabled` | 布尔值 | `true` | 是否注册 `remember`，并把记忆注入系统提示词。 |
| `memory.max_chars` | 正整数 | `6000` | 合并后长期记忆的 Unicode 字符数上限。 |
| `memory.daily_retention_days` | 可选正整数 | 未设置 | 全量记忆压缩成功后保留每日暂存记录的天数。 |
| `logging.level` | `debug`、`info`、`warn`、`error`、`off` | `info` | 运行时 JSONL 日志的最低记录级别；`off` 完全关闭文件日志。 |

`daily_retention_days` 注释掉或省略时不会清理每日记忆。日志固定写入 `<KANA_HOME>/logs`，不提供目录配置，也不写入终端输出，因而不会干扰 TUI 重绘。`max_turns`、`max_tokens`、`timeout_ms` 和 `max_retries` 当前只校验为有限数字；其中 `memory` 的两个数量字段额外要求正整数。

默认 `info` 只保留 session、TUI、Agent run 和记忆任务的摘要；逐回合、provider 请求以及成功工具执行的轨迹属于 `debug`。重试和失败工具为 `warn`，运行或持久化失败为 `error`。错误记录包含 `Error` 的名称、消息和堆栈；DeepSeek HTTP 失败额外记录状态码和状态文本，但不保存响应体。

配置根、每个已出现的表都必须是 TOML table。字符串不能为空，布尔值不能用字符串代替，枚举值之外的提供商、推理强度、审批模式、通知后端和日志级别会导致启动失败。Kana 不会忽略无效的已知字段；应修正配置后重新启动。

## API key 与项目指令

`api_key_env` 只告诉 Kana 从哪里读取 key，不会加载 `.env` 文件，也不会把 key 持久化到 `config.toml`。如需不同 key，可在启动 Kana 的 shell 中设置对应变量，或改用另一环境变量名。

全局 `AGENTS.md` 位于 `<KANA_HOME>/AGENTS.md`。项目根目录的 `AGENTS.md` 也会被读取；二者同时存在时，全局内容先注入、项目内容后注入。项目文件因此拥有更具体的后置位置。详见[架构总览](architecture.md)中的提示词装配说明。

## 审批文件：`approvals.json`

默认内容：

```json
{
  "version": 2,
  "bash": {
    "exactCommands": [],
    "readOnlyCommands": ["ls", "grep", "rg", "cat", "head", "tail", "wc", "pwd", "stat", "file"]
  }
}
```

`exactCommands` 是去掉首尾空白后的完整 bash 命令列表。TUI 中选择“Always allow this command”会把该命令追加到这里。`readOnlyCommands` 只能包含没有空白和 `/` 的可执行文件名；只有简单单命令的首个单词在此列表中时才被自动信任。含有 `;`、`|`、重定向、命令替换、反引号、反斜杠或换行的 bash 命令不会被当作只读。

审批模式的效果：

| 模式 | 行为 |
| --- | --- |
| `always` | 除 `remember` 外，每个工具调用都请求审批。 |
| `unless_trusted` | `read`、精确受信 bash 命令和受信简单只读 bash 命令跳过审批；其余调用请求审批。 |
| `never` | 所有调用都跳过审批，包括写入和 Shell。 |

## 全局 Skills 配置：`skills/skills.toml`

```toml
[model_invocation]
enabled = []
```

该列表列出允许注入模型系统提示词的**全局** Skill 名称。项目 `.kana/skills` 和 `.agents/skills` 下的 Skills 始终启用，不能从该文件关闭。TUI 的 `/skills` 只修改这份全局启用列表。

## 推荐的最小配置

以下示例只改变模型名和通知，其余字段继续使用默认值：

```toml
[model]
name = "deepseek-v4-flash"

[notification]
backend = "bell"
on_agent_completed = false
```

不要复制完整默认文件来做小改动：字段级合并允许配置保持更短，也能在代码添加新默认字段时自动获得默认行为。
