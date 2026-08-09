# 配置与安装

本文说明 Kana 当前实现的启动命令、配置文件和本地目录。配置以 Bun TOML 解析；字段名使用 `snake_case`，而代码内部使用 `camelCase`。

## 安装与启动

```bash
# 初始化本地状态；缺少 config.toml 时继续使用内置默认值
kana install

# 只检查最新正式版，或下载并替换当前 Kana 独立二进制
kana update --check
kana update

# 重置运行配置；默认交互确认，自动化环境显式使用 --yes
kana reset
kana reset --yes

# 安装或安全更新默认的全局 Skills 仓库
kana skills install

# 删除并重新克隆默认 Skills 仓库；默认交互确认
kana skills reinstall
kana skills reinstall --yes

# 将已安装的 Kana Skills 复制到 Codex 的全局 Skills 目录
kana skills sync codex

# 复制到自定义 agent 的 Skills 目录；已有同名 Skill 默认跳过
kana skills sync --target-dir ~/.other-agent/skills

# 替换目标目录中已有的同名 Skill；不清理其它或过期 Skill
kana skills resync codex
kana skills resync codex --yes

# 启动 TUI；参数会作为第一条提示词
kana 修复测试失败

# 只使用内置 Agent 上下文和工具
kana --clean

# 按 ID 恢复会话；省略 ID 时打开选择器
kana resume [session-id]

# 无头执行一次完整 Agent turn；也可从 stdin 读取 prompt
kana exec 修复失败的测试
kana exec --clean 使用内置能力分析项目
printf '总结这个仓库' | kana exec
kana exec resume <session-id> 继续完成任务

# 管理 OpenAI Codex OAuth
kana auth login openai-codex
kana auth status openai-codex
kana auth logout openai-codex
```

`kana exec` 使用与 TUI 相同的产品装配并在一次完整 Agent turn 后退出。默认模式只把最终答案写到 stdout，`--json` 提供版本化 JSONL 事件；非交互工具审批、退出码和完整协议见[无头执行与 JSONL 协议](headless.zh-CN.md)。

`--clean` 只用于新建 TUI 或 `exec` 会话；与 `resume` 或 `exec resume` 组合会在相应前端启动边界失败。它创建只存在于当前进程的临时 session：不创建 session journal、session logger 或 accounting 记录，也不会出现在恢复列表中。Clean 模式不读取全局或项目 `AGENTS.md`、global/project memory、全局或项目 Skills，以及 MCP 定义和启用状态；不会注册 `remember`、启动记忆合并或连接 MCP server。它继续加载 `<KANA_HOME>/.env` 和 `config.toml`，沿用当前 provider/model、Agent 运行参数、OAuth 凭据、审批规则与通知，也继续提供核心文件/Shell 工具和 TUI 的进程内 `schedule_wake`。TUI 中 `/skills`、`/mcp`、`/memory`、`/fork`、`/resume`、`/delete` 与 `/usage` 的 Session 范围不可用；`/model` 会校验并切换当前 Agent，但不写回 `config.toml`。Clean 模式不是文件/进程沙箱：内置工具、provider、审批或认证流程仍可能产生其本来的外部副作用。

`kana install` 是幂等初始化：它不会为了表达内置默认值而创建 `config.toml`，缺少该文件时 Kana 直接使用默认配置；对 `mcp.json`、`mcp-enabled.json`、`approvals.json` 和 `skills/skills.toml` 也只创建缺失文件，不覆盖已有内容。`config.example.toml` 是 Kana 管理的生成参考，install 会比较当前版本应有的内容，只在缺失或内容落后时创建或刷新；运行时不会读取它，需要覆盖默认值时只把相应字段复制到 `config.toml`。install 不安装 Skills 仓库，也不会创建 `~/.kana/AGENTS.md`。

`kana update --check` 读取 GitHub 最新正式 Release 的版本元数据，不下载或修改二进制。`kana update` 根据当前操作系统和架构下载对应资产，检查 Release 元数据中的文件大小和 SHA-256 digest，然后让候选二进制依次执行 `--version` 与幂等的 `kana install`；候选版本、支持文件初始化和当前可执行文件身份全部验证成功后，才通过同目录临时文件原子替换当前二进制。失败会删除临时文件并保留原二进制；如果另一个安装进程在下载期间已经替换目标，也会拒绝覆盖。更新支持 macOS/Linux 的 arm64、x64，沿用 Bun `fetch` 对 `HTTP_PROXY`/`HTTPS_PROXY` 的处理，且要求安装目录可写。直接通过 Bun 运行源码没有 direct distribution 构建标记，因此会拒绝自更新；`scripts/install.sh`、`bun run build:cli` 和正式 Release 构建的独立二进制包含该标记。

`kana reset` 将配置恢复到纯净 install 状态：删除 `config.toml`，刷新 `config.example.toml`，并把 MCP 定义、MCP 启用状态、审批规则和全局 Skill 启用列表重置为空默认值。它不会删除 `oauth-tokens.json`、sessions、memory、accounting、logs、`AGENTS.md`、默认 Skills 仓库或其它实际 Skills。该命令默认显示 `[y/N]` 确认；非交互环境会拒绝执行并提示显式传入 `--yes`。确认文案会列出全部重置项和主要保留项。

默认 Skills 仓库是 `https://github.com/longyijdos/kana-skills.git`，安装位置为 `<KANA_HOME>/skills/kana-skills`。`kana skills install` 在目录不存在时 clone，已有 Git 仓库时执行 `git pull --ff-only`；已有目录不是 Git 仓库时失败并提示使用 `kana skills reinstall`。reinstall 会在确认后只删除整个默认仓库目录并重新 clone，保留相邻的 `skills.toml` 和其它实际 Skills；非交互环境同样要求 `--yes`。

`kana skills sync` 不会重新 clone 仓库；它读取 `<KANA_HOME>/skills/kana-skills`，把其中每个顶层、包含 `SKILL.md` 的 Skill 目录复制到目标 agent 的 Skills 根目录。`codex` 预设写入 `${CODEX_HOME:-$HOME/.codex}/skills`。普通 sync 跳过已有同名目录；`kana skills resync` 在确认后删除并重新复制源仓库当前包含的同名 Skill，但不删除目标中其它来源或已从源仓库移除的过期 Skill。resync 在非交互环境要求 `--yes`。若默认 Skills 仓库尚未安装，请先运行 `kana skills install`。

## 根目录与文件布局

Kana 使用 `KANA_HOME` 指定根目录；未设置时使用 `$HOME/.kana`，若 `HOME` 也不存在则回退到操作系统返回的用户主目录。

```text
${KANA_HOME:-$HOME/.kana}/
├── .env                    # 可选：启动时加载的环境变量
├── config.toml             # 可选：本文的运行配置；缺失时使用内置默认值
├── config.example.toml     # install 生成的完整配置参考；运行时不读取
├── mcp.json                # MCP server 定义
├── mcp-enabled.json        # 已启用的 MCP server ID
├── oauth-tokens.json       # 浏览器授权后创建的 OAuth 凭据
├── approvals.json          # bash 信任规则
├── AGENTS.md               # 可选：全局系统指令，不由 install 创建
├── sessions/               # 按工作区分组的 JSONL 会话
├── logs/                   # 按工作区和会话分组的运行时 JSONL 日志
├── memory/                 # global 与 project 的记忆
└── skills/
    ├── skills.toml         # 全局 Skill 的启用列表
    └── kana-skills/        # `kana skills install` 克隆的默认仓库
```

安装和应用写入的配置文件均以 `0600` 模式创建或写入。该权限是文件模式请求；实际效果仍受操作系统和文件系统 umask/权限模型影响。

Kana 会在解析 CLI 命令前读取 `<KANA_HOME>/.env`，其中的值覆盖启动进程继承的同名环境变量，并成为 Kana 当前进程环境的一部分。内置 `bash` 工具和 TUI 的 `!` 本地 Shell 会继承这些值，因此该文件中的 secret 对它们执行的命令可见。MCP stdio 子进程仍使用独立的受限环境；需要通过 server 的 `env` 显式传入值或引用 `${VAR_NAME}` 占位符。

## `config.toml`

配置文件不存在时，Kana 直接使用内置默认值。文件存在时，各个已提供字段覆盖默认值，未提供字段仍继承默认值；例如只写 `[model.deepseek] name` 不会删除该供应商的其他默认项。旧版扁平 `[model]` DeepSeek 配置仍可读取，但新配置应使用供应商分表。

TUI 的 `/model` 通过通用配置存储更新 `config.toml`：它从磁盘重新读取当前配置，只写本次实际变化的已知字段，并保留无关表、未知字段和独立注释。首次修改默认配置时只会创建必要的 override，不会展开所有默认值。候选文档必须重新解析为完整目标配置后才会通过同目录临时文件原子替换；验证或写入失败时原文件保持不变。`config.example.toml` 只用于查阅，后续 `kana install` 可能刷新它，因此不应在其中保存用户配置。

内置默认配置等价于：

```toml
[provider]
active = "deepseek"

[model.deepseek]
name = "deepseek-v4-pro"
api_key_env = "DEEPSEEK_API_KEY"
thinking = true
reasoning_effort = "high"
max_tokens = 384000
timeout_ms = 60000
max_retries = 1

[model.openai-codex]
name = "gpt-5.6-sol"
reasoning_effort = "medium"
reasoning_summary = "auto"
web_search = true
max_tokens = 128000
timeout_ms = 60000
max_retries = 1

[agent]
max_turns = -1
tool_deadline_ms = 660000
parallel_tool_calls = true
# context_limit = 200000

[approval]
mode = "unless_trusted"

[notification]
backend = "auto"
on_agent_completed = true
on_approval_required = true

[tui]
hyperlinks = true
smooth_text_streaming = true
collapse_long_pastes = true

[memory]
enabled = true
max_chars = 6000
# daily_retention_days = 30

[logging]
level = "info"
```

`model.openai-codex` 即使未写入文件也有独立默认值，因此切换供应商时只需写需要覆盖的字段。

### `[provider]`

| 键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `active` | `deepseek` 或 `openai-codex` | `deepseek` | 当前用于主 Agent、记忆压缩和上下文压缩的模型供应商。 |

### `[model.deepseek]`

| 键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `name` | 非空字符串 | `deepseek-v4-pro` | 模型名；运行时会拒绝不在 DeepSeek 元数据表中的模型。 |
| `api_key_env` | 非空字符串 | `DEEPSEEK_API_KEY` | 保存 API key 的环境变量名；key 不写入 TOML。 |
| `thinking` | 布尔值 | `true` | 是否在 DeepSeek 请求中显式启用 thinking。 |
| `reasoning_effort` | `high` 或 `max` | `high` | DeepSeek 推理强度；`thinking = false` 时不会发送该字段。 |
| `max_tokens` | 正整数 | `384000` | 单个请求允许的输出 token 上限；不能超过所选模型的硬上限。Agent 会按当前 prompt 剩余空间逐轮下调实际发送值。 |
| `timeout_ms` | 有限数字 | `60000` | 等待 DeepSeek 响应头或相邻响应数据的无活动超时毫秒数。 |
| `max_retries` | 有限数字 | `1` | 可重试请求失败后的最大重试次数。 |

启动前必须在环境中设置 `api_key_env` 指定的变量。例如默认配置使用：

```bash
export DEEPSEEK_API_KEY='sk-...'
```

### `[model.openai-codex]`

| 键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `name` | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` | `gpt-5.6-sol` | Codex Responses 模型。 |
| `reasoning_effort` | `low`、`medium`、`high`、`xhigh`、`max` | `medium` | 请求的推理强度。 |
| `reasoning_summary` | `auto`、`concise`、`detailed` | `auto` | 请求可流式返回的 reasoning summary；原始思维链不会作为该字段公开。 |
| `web_search` | 布尔值 | `true` | 是否向 Codex Responses 请求声明供应商托管的 `web_search` 工具。设为 `false` 时完全省略该顶层工具；其他供应商没有此配置。 |
| `max_tokens` | 正整数 | `128000` | Kana 计算逐轮输出上限时使用的配置上限；ChatGPT Codex 请求约定不暴露 `max_output_tokens`，因此请求不会发送该值。 |
| `timeout_ms` | 有限数字 | `60000` | 等待响应头或相邻响应数据的无活动超时毫秒数。 |
| `max_retries` | 有限数字 | `1` | 可重试请求失败后的最大重试次数。 |

首次使用前运行 `kana auth login openai-codex`。浏览器授权得到的 access token、refresh token、ID token 与绑定信息保存在权限为 `0600` 的 `<KANA_HOME>/oauth-tokens.json`；到期前会自动 refresh，模型请求收到首个 `401` 时也会 refresh 并重试一次。`status` 只显示授权状态、是否可刷新和到期时间，不显示 token。完整协议映射见 [OpenAI Codex 提供商适配](openai-codex-provider.zh-CN.md)。

### 其他配置表

| 表与键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `agent.max_turns` | `-1` 或正整数 | `-1` | 一次用户运行中模型—工具回合的最大数；达到上限且仍需继续时以 `turn_limit` 结束。 |
| `agent.tool_deadline_ms` | 正整数 | `660000` | 未声明 `execution.deadlineMs` 的工具每次调用的默认 deadline（毫秒）；工具自身声明的值优先。 |
| `agent.parallel_tool_calls` | 布尔值 | `true` | 是否允许模型提出并实际并发执行安全的工具调用；所选模型 metadata 不支持时始终关闭。 |
| `agent.context_limit` | 可选正整数 | 模型 metadata 的 context window | Agent 实际使用的上下文上限；不能超过所选模型的硬上限，省略时使用 metadata。 |
| `approval.mode` | `always`、`unless_trusted`、`never` | `unless_trusted` | 工具调用是否进入 TUI 审批。 |
| `notification.backend` | `auto`、`off`、`bell`、`osc9`、`osc777`、`kitty` | `auto` | 终端通知输出协议。`auto` 依次识别 Kitty、iTerm、VTE，否则退回 bell。 |
| `notification.on_agent_completed` | 布尔值 | `true` | 正常完成的 Agent 运行是否通知。中止、错误、长度截断或 `turn_limit` 不会视作完成。 |
| `notification.on_approval_required` | 布尔值 | `true` | 显示工具审批时是否通知。 |
| `tui.hyperlinks` | 布尔值 | `true` | 是否允许 TUI 在确认终端支持时用 OSC 8 渲染 Markdown 链接；关闭、终端未知或不支持时显示 `label (url)`。 |
| `tui.smooth_text_streaming` | 布尔值 | `true` | 是否平滑展开突发到达的助手文本；关闭时直接显示 provider 的最新流式快照。 |
| `tui.collapse_long_pastes` | 布尔值 | `true` | 是否把达到 1,000 个 grapheme 的 bracketed paste 折叠为原子的 `[Pasted N chars]` 编辑项；关闭时正常显示并逐字编辑粘贴文本。 |
| `memory.enabled` | 布尔值 | `true` | 是否注册 `remember`，并把记忆注入系统提示词。 |
| `memory.max_chars` | 正整数 | `6000` | 合并后长期记忆的 Unicode 字符数上限。 |
| `memory.daily_retention_days` | 可选正整数 | 未设置 | 全量记忆压缩成功后保留每日暂存记录的天数。 |
| `logging.level` | `debug`、`info`、`warn`、`error`、`off` | `info` | 运行时 JSONL 日志的最低记录级别；`off` 完全关闭文件日志。 |

`parallel_tool_calls` 是用户策略，最终值为“用户配置且所选模型 metadata 支持”。关闭后 provider 请求不会声明并行能力，且即使模型仍在一个响应中返回多个调用，ToolRuntime 也会按顺序逐个执行。打开后仍只有声明 `execution.concurrency = "parallel"` 的相邻工具能够组成并行组；当前 OpenAI Codex 模型使用 classic Responses 并声明支持 parallel tool，因此请求字段会遵循这个有效设置。

`hyperlinks` 是功能许可而不是强制开关：即使配置为 `true`，Kana 也只对确认支持 OSC 8 的终端启用，无法确认能力时保持可见 URL；配置为 `false` 时始终使用文本 fallback。`smooth_text_streaming` 默认只调整可见文本的推进节奏，不会向 provider 或 Agent 施加背压；关闭后仍由 TUI 合并终端重绘，但不再拆分 provider 的文本快照。`collapse_long_pastes` 只影响编辑器的显示与编辑方式，提交、排队和从输入历史恢复时仍使用完整粘贴原文。`daily_retention_days` 注释掉或省略时不会清理每日记忆。日志固定写入 `<KANA_HOME>/logs`，不提供目录配置，也不写入终端输出，因而不会干扰 TUI 重绘。`max_turns` 只接受 `-1` 或正整数；`parallel_tool_calls`、`hyperlinks`、`smooth_text_streaming` 和 `collapse_long_pastes` 必须是布尔值；`tool_deadline_ms`、`max_tokens` 和可选的 `context_limit` 要求正整数，`timeout_ms` 和 `max_retries` 校验为有限数字，`memory` 的两个数量字段要求正整数。

### 上下文预算

Kana 用 `agent.context_limit` 计算自动上下文压缩预算；未配置时回退到所选模型 metadata 的 context window。配置值不能超过 metadata，但不需要大于当前供应商的 `model.<provider>.max_tokens`。实际 prompt 预算和逐轮输出上限为：

```text
safetyReserve = clamp(floor(contextLimit × 5%), 256, 8192)
promptBudget = contextLimit - safetyReserve
effectiveMaxTokens = min(activeModel.max_tokens, promptBudget - estimatedPromptTokens)
```

`promptBudget` 至少需要 512 tokens。估算输入达到其 80% 时开始压缩，cutoff 会在完整 assistant turn 或完整 tool-call/result 组之后选择，使“系统提示词 + 工具定义 + 最大摘要占位 + 保留的近期消息”尽量降到 `promptBudget` 的 10%。配置的 `max_tokens` 是输出上限而不是固定预留；prompt 增长到剩余空间不足时，Agent 会降低本轮 `ModelContext.maxOutputTokens`。DeepSeek 将其发送为 `max_tokens`，不支持对应请求字段的 provider 可以忽略它。

默认 `info` 只保留 session、TUI、Agent run 和记忆任务的摘要；逐回合、provider 请求以及成功工具执行的轨迹属于 `debug`。Agent 创建时的 `agent.parallel_tool_calls_configured` 只记录 `requested`、`supported` 和最终的 `enabled`；`context.output_limit_adjusted` 只记录配置上限、本轮有效上限和估算 prompt tokens，两者也都属于 `debug`。重试和失败工具为 `warn`，运行或持久化失败为 `error`。错误记录包含 `Error` 的名称、消息和堆栈；provider HTTP 失败额外记录状态码和状态文本，但不保存响应体、授权 header、prompt 或 token。

配置根、每个已出现的表都必须是 TOML table。字符串不能为空，布尔值不能用字符串代替，枚举值之外的提供商、推理强度、审批模式、通知后端和日志级别会导致启动失败。Kana 不会忽略无效的已知字段；应修正配置后重新启动。

## `mcp.json` 与 `mcp-enabled.json`

MCP server 不写入 `config.toml`。Claude Code 风格的定义保存在 `<KANA_HOME>/mcp.json`，`<KANA_HOME>/mcp-enabled.json` 则是启用状态的唯一来源。定义文件不存在或省略 `mcpServers` 时等价于未配置服务器；启用文件不存在或省略 `enabledServers` 时等价于未启用任何服务器。Kana 只启动同时存在于定义和 `enabledServers` 中的 ID，过期的未知 ID 会被忽略。当前会话显示后，TUI 才会连接选中的服务器，使用稳定版 `2025-11-25` client 获取工具列表，再把远端工具注入重建后的主 Agent；不带 ID 的 `kana resume` 会先显示会话选择器，选中会话后才开始连接。记忆压缩 Agent 不会获得 MCP 工具。每次发现的工具列表会固定到显式执行下一次 `/mcp` reload 或本次进程结束，不处理运行中的 `notifications/tools/list_changed`。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx"
      }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "proxy": "http://127.0.0.1:7890",
      "auth": {
        "type": "oauth2",
        "clientId": "kana-client-id",
        "clientSecretEnv": "REMOTE_MCP_CLIENT_SECRET",
        "tokenEndpointAuthMethod": "client_secret_post",
        "scopes": ["read", "write"]
      }
    }
  }
}
```

启用状态单独保存，因此 `/mcp` 管理开关时无需重写服务器命令、参数、格式或包含明文环境变量的定义文件：

```json
{
  "enabledServers": ["filesystem", "github", "remote"]
}
```

Server ID 必须非空且不能重复。未知字段、无效值或重复 ID 都会导致启用状态加载失败。`/mcp` 会列出所有已配置 server 的 transport；选中 stdio server 时显示完整命令行（`command` 后拼接 `args`），选中 HTTP server 时显示 URL 和 OAuth 状态，但刻意不显示环境变量、HTTP headers、代理地址或 token。`Enter` 只切换内存中的草稿；OAuth HTTP server 还可按 `A` 打开认证操作，执行首次授权、重新授权或退出登录。`Esc` 一次性应用并关闭；草稿有变化或已启用 server 的认证状态发生变化时，Kana 执行一次 reload。退出登录会同时取消勾选该 server。持久化失败时管理界面保持打开，方便重试。

省略 `type` 时默认为 `stdio`；Streamable HTTP 必须显式使用 `"type": "http"`。配置字段如下：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `type` | `stdio` | `stdio` 或 `http`。不接受旧版 `sse`。 |
| `command` | stdio 必填 | 可执行文件的绝对路径或通过 `PATH` 查找的名称。直接以参数数组启动，不经过 shell。 |
| `args` | stdio: `[]` | 传给 stdio 可执行文件的参数数组。 |
| `cwd` | stdio: Kana 当前工作目录 | 子进程工作目录；相对路径由运行 Kana 的当前目录解析。 |
| `env` | stdio: `{}` | 显式加入子进程环境的字符串键值。`${VAR_NAME}` 从当前进程展开，缺失时该 server 启动失败；`${VAR_NAME:-default}` 在变量缺失或为空时使用默认值。配置值覆盖同名基础环境变量。 |
| `url` | HTTP 必填 | Streamable HTTP 单端点 URL；必须为绝对 `http`/`https` URL，不能包含 credentials 或 fragment。 |
| `proxy` | HTTP: 未设置 | 绝对 `http`/`https` 代理 URL 表示仅该 server 使用指定代理；`false` 表示忽略进程级代理并强制直连。URL 不能包含 credentials 或 fragment。 |
| `headers` | HTTP: `{}` | 每个 HTTP 请求附带的字符串 headers；不能覆盖 transport 管理的 content、session、protocol 或 SSE headers。 |
| `auth` | 未设置 | HTTP OAuth 2.0 配置；设置后 `url` 必须为 HTTPS，且 `headers` 不能再设置 `Authorization`。 |
| `required` | `false` | 启动失败是否阻止 MCP manager 整体就绪。 |
| `startupTimeoutMs` | `10000` | 完成 MCP 初始化握手的超时。 |
| `requestTimeoutMs` | `60000` | 普通 MCP 请求的默认超时。 |
| `includeTools` | 未设置 | 按远端原名选择允许暴露的工具。空数组表示不暴露任何工具。 |
| `excludeTools` | 未设置 | 按远端原名排除工具；同时出现在 include/exclude 时以排除为准。 |

stdio 子进程默认只继承已存在的 `HOME`、`PATH`、`TMPDIR`、`TMP`、`TEMP`、`LANG`、`LC_ALL` 和 `LC_CTYPE`，然后合并展开后的 `env`。占位符只从 Kana 进程环境读取，因此也能使用 `<KANA_HOME>/.env` 已加载的值，但不会让子进程继承其他未显式配置的变量。`${VAR:-default}` 遵循 shell 的 `:-` 语义：变量未设置或值为空时使用默认值；默认值不递归展开。没有默认值的占位符若无法解析，该 server 会以包含 server ID、env key 和变量名的错误启动失败；可选 server 不影响其他 MCP 或 editor，错误会出现在 transcript 和诊断日志中，且不会记录 secret 值。环境变量名必须符合常规格式，配置值必须是字符串；未知字段、非正整数超时、重复或空工具名都会使配置加载失败。

HTTP server 将 `proxy` 设置为 URL 后，其 MCP initialize、工具请求、SSE 恢复、session DELETE、OAuth metadata discovery、token 获取和 refresh 都通过该代理；设置为 `false` 后，同一范围的请求会绕过进程级代理并直连。直连封装只在调用 Bun `fetch` 的同步区间把当前目标主机加入进程内 `NO_PROXY`/`no_proxy`，随即恢复两个变量的原始值；不会永久修改 Kana 进程环境，也不会改变随后启动的其他 MCP 请求，它们仍使用各自的显式代理或原有全局代理。省略 `proxy` 时使用 Bun 的默认 `fetch` 路由，因此继续遵守当前 shell 或 `<KANA_HOME>/.env` 注入的 `HTTP_PROXY`/`HTTPS_PROXY`。系统浏览器中的 OAuth 授权页面不经过 Kana 的 `fetch`，仍使用浏览器自身的网络设置。诊断日志只记录该 server 使用显式代理或绕过代理，不记录代理 URL。

`auth` 当前只接受 `type: "oauth2"`，子字段如下：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `clientId` | 必填 | 已注册 OAuth client ID；它不是 secret，可直接保存在 `mcp.json`。 |
| `clientSecretEnv` | 未设置 | 从 Kana 进程环境读取 client secret 的变量名，例如放在 `<KANA_HOME>/.env`；secret 不写入 `mcp.json`。 |
| `redirectUri` | 动态 loopback | 可选的固定 `http://localhost:<port>/path`、`127.0.0.1` 或 `::1` callback。省略时 Kana 在 `127.0.0.1` 上选择空闲端口并使用 `/oauth/callback`。 |
| `scopes` | 未设置 | 显式最小权限边界。设置后不会自动申请列表外的 scope；未设置时优先使用 `WWW-Authenticate` challenge 的 scope，再回退 protected-resource metadata。 |
| `tokenEndpointAuthMethod` | 自动选择 | `none`、`client_secret_basic` 或 `client_secret_post`；必须与服务端 metadata 和是否提供 secret 一致。 |
| `authorizationParameters` | `{}` | 追加到浏览器授权请求的提供商参数，例如 `access_type` 或 `prompt`；不能覆盖 OAuth/PKCE/resource 核心参数。 |
| `callbackTimeoutMs` | `300000` | 等待 loopback callback 的正整数超时。 |

OAuth 启动前先按 MCP protected-resource metadata 和 OAuth/OIDC metadata 发现授权端点，再执行 Authorization Code + PKCE S256。浏览器授权成功后，access token、refresh token、到期时间、scope 和绑定信息写入权限为 `0600` 的 `<KANA_HOME>/oauth-tokens.json`。可用的 refresh token 会在 access token 到期前自动刷新；授权服务器以 `invalid_grant` 拒绝 refresh 时，Kana 删除旧凭据，并在下次需要时重新打开浏览器。工具调用收到带 scope 的 `401/403` challenge 时，如果配置允许所需 scope，Kana 会增量授权并只重试该 HTTP 请求一次；若服务端要求配置范围之外的 scope，则返回明确错误，不扩大权限。

HTTP transport 只实现 `2025-11-25` Streamable HTTP：POST 响应同时支持 JSON 和 SSE，初始化后支持可选 GET server stream、session header、`Last-Event-ID` 恢复和 DELETE 关闭。不会回退 `2024-11-05` 的独立 HTTP+SSE transport。URL、代理 URL、header 名称和值以及 transport 保留 header 会在启动前校验。OAuth challenge 只使当前请求失败，不会关闭仍然有效的 MCP transport；网络或协议级致命错误仍会关闭连接。关闭期间的 session DELETE 是有界的最佳努力操作，其失败会写日志，但后台清理不会把未处理 Promise 堆栈泄漏到 TUI。

可选服务器启动失败时 Kana 会记录诊断、关闭该服务器并继续，并在最终摘要后留下失败警告。初次加载时，必需服务器失败会让当前会话停留在错误状态，不启用 editor；但显式 reload 中遇到配置或必需服务器失败时，会清空已关闭 manager 的工具、用无 MCP 工具的状态重建 Agent、把错误写入 transcript，并恢复 editor，以便再次打开 `/mcp`。连接和 reload 都会在 transcript 末尾追加进度块，最终保留含 ready server 与可用工具数量的启动/reload 摘要；未选择任何服务器时，reload 摘要会显示 `MCP disabled`。远端工具默认沿用未知工具的审批策略，在 `unless_trusted` 模式下每次调用都需要确认；审批框显示 server ID、远端工具原名和完整格式化参数，只提供单次允许或拒绝。退出、空闲或加载时按 `Ctrl+C`，以及收到 `SIGHUP`、`SIGINT`、`SIGTERM` 时，Kana 会先进入优雅关闭，并在 transcript 末尾显示逐服务器关闭进度而不替换 bottom；所有 MCP server 关闭后才恢复终端并打印退出信息。优雅关闭等待期间再次按 `Ctrl+C` 会立即强制退出。

stdio server 配置是本地代码执行的信任边界：Kana 在 MCP 工具审批之前就必须启动 `command`，所以只应配置可信程序。HTTP endpoint 与 OAuth 授权服务器同样属于远端数据、工具和凭据的信任边界。`env` 与 `headers` 按 JSON 字面值处理，静态 token 因而会以明文保存在 `mcp.json`；优先使用 OAuth 的 `clientSecretEnv` 和最小权限 scopes，不要提交或分享配置与 token 文件。Kana 的 OAuth token store 是本地明文凭据文件，只通过文件权限保护。`kana install` 会以 `0600` 创建缺失的两个 MCP 文件，`kana reset` 则会在确认后把服务器定义和启用状态重置为空默认值；两者都不会删除 OAuth token store。协议版本由代码维护，不提供任意字符串配置。

## API key 与项目指令

`api_key_env` 只告诉 Kana 从哪里读取 key，不会把 key 持久化到 `config.toml`。Kana 在解析启动命令前会读取 `<KANA_HOME>/.env`；文件不存在时直接跳过。其中的值会覆盖启动 shell 继承的同名变量，也会覆盖 Bun 从当前工作目录 `.env` 自动加载的同名变量。因此可以把默认 key 写为：

```dotenv
DEEPSEEK_API_KEY=sk-...
```

`.env` 路径使用加载前的 `KANA_HOME` 确定；未设置时为 `$HOME/.kana/.env`。

全局 `AGENTS.md` 位于 `<KANA_HOME>/AGENTS.md`。内置默认助手指令始终注入；全局文件存在时追加到默认指令后。项目根目录的 `AGENTS.md` 也会被读取，并追加在全局内容后，因此拥有更具体的后置位置。详见[架构总览](architecture.zh-CN.md)中的提示词装配说明。

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
| `always` | 除 `remember` 和 `schedule_wake` 外，每个工具调用都请求审批。 |
| `unless_trusted` | `read`、`list`、`glob`、`grep`、精确受信 bash 命令和受信简单只读 bash 命令跳过审批；其余调用请求审批。 |
| `never` | 所有调用都跳过审批，包括写入和 Shell。 |

TUI 的 `/approval` 可以临时覆盖当前所选 session 的模式；选择 `Never ask` 需要二次确认。该覆盖不会写入 `config.toml`、session journal 或 `approvals.json`，并在 new、fork、resume 或进程退出时恢复这里配置的模式。

## 全局 Skills 配置：`skills/skills.toml`

```toml
[model_invocation]
enabled = []
```

该列表列出允许注入模型系统提示词的**全局** Skill 名称。项目 `.kana/skills` 和 `.agents/skills` 下的 Skills 始终启用，不能从该文件关闭。TUI 的 `/skills` 只修改这份全局启用列表：`Enter` 修改草稿，`Esc` 仅在最终选择变化时写入并刷新一次。

## 推荐的最小配置

以下示例只改变模型名和通知，其余字段继续使用默认值：

```toml
[model.deepseek]
name = "deepseek-v4-flash"

[notification]
backend = "bell"
on_agent_completed = false
```

切换到已经授权的 Codex Luna 只需要：

```toml
[provider]
active = "openai-codex"

[model.openai-codex]
name = "gpt-5.6-luna"
```

不要复制完整默认文件来做小改动：字段级合并允许配置保持更短，也能在代码添加新默认字段时自动获得默认行为。
