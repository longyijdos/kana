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

`--clean` 只用于新建 TUI 或 `exec` 会话；与 `resume` 或 `exec resume` 组合会在相应前端启动边界失败。它创建只存在于当前进程的临时 session：不创建 session journal、session logger 或 accounting 记录，也不会出现在恢复列表中。Clean 模式不读取全局或项目 `AGENTS.md`、global/project memory、全局或项目 Skills，以及 MCP 定义和启用状态；不会注册 `remember`、启动记忆合并或连接 MCP server。它继续加载 `<KANA_HOME>/.env` 和 `config.toml`，沿用当前 provider/model、Agent 运行参数、OAuth 凭据、审批规则与通知，也继续提供核心文件/Shell 工具、`todo_write` 和 TUI 的进程内 `schedule_wake`。`/todo` 会显示临时 session 的当前 todo 状态；TUI 中 `/skills`、`/mcp`、`/memory`、`/fork`、`/resume`、`/delete` 与 `/usage` 的 Session 范围不可用；`/model` 会校验并切换当前 Agent，但不写回 `config.toml`。Clean 模式不是文件/进程沙箱：内置工具、provider、审批或认证流程仍可能产生其本来的外部副作用。

`kana install` 是幂等初始化：它不会为了表达内置默认值而创建 `config.toml`，缺少该文件时 Kana 直接使用默认配置；对 `mcp.json`、`mcp-enabled.json`、`approvals.json` 和 `skills/skills.toml` 也只创建缺失文件，不覆盖已有内容。`config.example.toml` 和 `providers/custom.example.toml` 是 Kana 管理的生成参考，install 会比较当前版本应有的内容，只在缺失或内容落后时创建或刷新；运行时不会读取这两个 example，需要覆盖默认值时只把相应字段复制到 `config.toml`，并在编辑前把 Custom example 复制为 `providers/custom.toml`。install 不安装 Skills 仓库，也不会创建 `~/.kana/AGENTS.md`。

`kana update --check` 读取 GitHub 最新正式 Release 的版本元数据，不下载或修改二进制。`kana update` 根据当前操作系统和架构下载对应资产，检查 Release 元数据中的文件大小和 SHA-256 digest，然后让候选二进制依次执行 `--version` 与幂等的 `kana install`；候选版本、支持文件初始化和当前可执行文件身份全部验证成功后，才通过同目录临时文件原子替换当前二进制。失败会删除临时文件并保留原二进制；如果另一个安装进程在下载期间已经替换目标，也会拒绝覆盖。更新支持 macOS/Linux 的 arm64、x64，沿用 Bun `fetch` 对 `HTTP_PROXY`/`HTTPS_PROXY` 的处理，且要求安装目录可写。直接通过 Bun 运行源码没有 direct distribution 构建标记，因此会拒绝自更新；`scripts/install.sh`、`bun run build:cli` 和正式 Release 构建的独立二进制包含该标记。

`kana reset` 将主运行配置恢复到默认状态：删除 `config.toml`，刷新 `config.example.toml`，并把 MCP 定义、MCP 启用状态、审批规则和全局 Skill 启用列表重置为空默认值。它不会删除 `providers/custom.toml`、`providers/custom.example.toml`、`oauth-tokens.json`、sessions、memory、accounting、logs、`AGENTS.md`、用户主题、默认 Skills 仓库或其它实际 Skills。该命令默认显示 `[y/N]` 确认；非交互环境会拒绝执行并提示显式传入 `--yes`。确认文案会列出全部重置项和主要保留项。

默认 Skills 仓库是 `https://github.com/longyijdos/kana-skills.git`，安装位置为 `<KANA_HOME>/skills/kana-skills`。`kana skills install` 在目录不存在时 clone，已有 Git 仓库时执行 `git pull --ff-only`；已有目录不是 Git 仓库时失败并提示使用 `kana skills reinstall`。reinstall 会在确认后只删除整个默认仓库目录并重新 clone，保留相邻的 `skills.toml` 和其它实际 Skills；非交互环境同样要求 `--yes`。

`kana skills sync` 不会重新 clone 仓库；它读取 `<KANA_HOME>/skills/kana-skills`，把其中每个顶层、包含 `SKILL.md` 的 Skill 目录复制到目标 agent 的 Skills 根目录。`codex` 预设写入 `${CODEX_HOME:-$HOME/.codex}/skills`。普通 sync 跳过已有同名目录；`kana skills resync` 在确认后删除并重新复制源仓库当前包含的同名 Skill，但不删除目标中其它来源或已从源仓库移除的过期 Skill。resync 在非交互环境要求 `--yes`。若默认 Skills 仓库尚未安装，请先运行 `kana skills install`。

## 根目录与文件布局

Kana 使用 `KANA_HOME` 指定根目录；未设置时使用 `$HOME/.kana`，若 `HOME` 也不存在则回退到操作系统返回的用户主目录。

```text
${KANA_HOME:-$HOME/.kana}/
├── .env                    # 可选：启动时加载的环境变量
├── config.toml             # 可选：本文的运行配置；缺失时使用内置默认值
├── config.example.toml     # install 生成的完整配置参考；运行时不读取
├── providers/
│   ├── custom.toml         # 可选：Custom OpenAI-compatible 供应商定义
│   └── custom.example.toml # install 生成的 Custom 参考；运行时不读取
├── mcp.json                # MCP server 定义
├── mcp-enabled.json        # 已启用的 MCP server ID
├── oauth-tokens.json       # 浏览器授权后创建的 OAuth 凭据
├── approvals.json          # bash 信任规则
├── AGENTS.md               # 可选：全局系统指令，不由 install 创建
├── sessions/               # 按工作区分组的 JSONL 会话
├── artifacts/              # 按工作区和会话隔离的超大工具输出
├── logs/                   # 按工作区和会话分组的运行时 JSONL 日志
├── memory/                 # global 与 project 的记忆
├── themes/                 # 用户 TUI 主题
└── skills/
    ├── skills.toml         # 全局 Skill 的启用列表
    └── kana-skills/        # `kana skills install` 克隆的默认仓库
```

安装和应用写入的配置文件均以 `0600` 模式创建或写入。该权限是文件模式请求；实际效果仍受操作系统和文件系统 umask/权限模型影响。

Kana 会在解析 CLI 命令前读取 `<KANA_HOME>/.env`，其中的值覆盖启动进程继承的同名环境变量，并成为 Kana 当前进程环境的一部分。内置 `bash` 工具和 TUI 的 `!` 本地 Shell 会继承这些值，因此该文件中的 secret 对它们执行的命令可见。MCP stdio 子进程仍使用独立的受限环境；需要通过 server 的 `env` 显式传入值或引用 `${VAR_NAME}` 占位符。

## `config.toml`

配置文件不存在时，Kana 直接使用内置默认值。文件存在时，各个已提供字段覆盖默认值，未提供字段仍继承默认值。模型选择和 Agent 策略按 Agent 静态配置：`[agent.model]` 属于对话 Agent，`[memory.agent.model]` 独立属于记忆压缩 Agent；provider 表只保存传输和鉴权设置。这是有意的破坏性 schema 变更，不再读取旧 `[provider]` 和 `[model.*]` 选择表。

TUI 的 `/model` 通过通用配置存储更新 `config.toml`：它从磁盘重新读取当前配置，只写本次实际变化的已知字段，并保留无关表、未知字段和独立注释。首次修改默认配置时只会创建必要的 override，不会展开所有默认值。候选文档必须重新解析为完整目标配置后才会通过同目录临时文件原子替换；验证或写入失败时原文件保持不变。`config.example.toml` 只用于查阅，后续 `kana install` 可能刷新它，因此不应在其中保存用户配置。

内置默认配置等价于：

```toml
[provider.deepseek]
api_key_env = "DEEPSEEK_API_KEY"
timeout_ms = 60000
max_retries = 1

[provider.openai-codex]
reasoning_summary = "auto"
timeout_ms = 60000
max_retries = 1

[agent]
web_search = true
image_input = true
max_turns = -1
goal_max_rounds = 8
tool_deadline_ms = 660000
parallel_tool_calls = true
max_parallel_tool_calls = 4
tool_result_artifacts = true

[agent.model]
provider = "deepseek"
name = "deepseek-v4-pro"
# reasoning_effort = "high"
# max_output_tokens = 128000
# context_limit = 500000

[agent.background_jobs]
max_concurrent = 4

[agent.repeated_tool_calls]
reminder_thresholds = [3,5,8]
excluded_tools = []

[approval]
mode = "unless_trusted"

[notification]
backend = "auto"
on_agent_completed = true
on_approval_required = true

[tui]
theme = "kana"
hyperlinks = true
render_latex = true
render_mermaid = true
smooth_text_streaming = true
collapse_long_pastes = true

[memory]
enabled = true
max_chars = 6000
# daily_retention_days = 30

[memory.agent]
web_search = false
image_input = false
max_turns = -1
tool_deadline_ms = 660000
parallel_tool_calls = true
max_parallel_tool_calls = 4

[memory.agent.model]
provider = "deepseek"
name = "deepseek-v4-flash"
# reasoning_effort = "low"
# max_output_tokens = 64000
# context_limit = 200000

[logging]
level = "info"
```

省略 `reasoning_effort`、`max_output_tokens` 和 `context_limit` 时，使用所选模型 metadata 的默认值与硬上限；配置预算高于硬上限时会在运行时安全钳制。`/model` 只修改 `agent.model.provider`、`name` 和 `reasoning_effort`，保留主 Agent 的预算字段以及完整的 Memory Agent 配置。

### Provider 表

| 键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `provider.deepseek.api_key_env` | 非空字符串 | `DEEPSEEK_API_KEY` | 保存 API key 的环境变量名；key 不写入 TOML。 |
| `provider.deepseek.timeout_ms` | 有限数字 | `60000` | 等待 DeepSeek 响应头或相邻数据的无活动超时。 |
| `provider.deepseek.max_retries` | 有限数字 | `1` | 可重试请求失败后的最大重试次数。 |
| `provider.openai-codex.reasoning_summary` | `auto`、`concise`、`detailed` | `auto` | 请求可流式返回的 reasoning summary；不会公开原始思维链。 |
| `provider.openai-codex.timeout_ms` | 有限数字 | `60000` | 等待 Codex 响应头或相邻数据的无活动超时。 |
| `provider.openai-codex.max_retries` | 有限数字 | `1` | 可重试请求失败后的最大重试次数。 |

启动前必须在环境中设置 `api_key_env` 指定的变量。例如默认配置使用：

```bash
export DEEPSEEK_API_KEY='sk-...'
```

首次使用 OpenAI Codex 前运行 `kana auth login openai-codex`。浏览器授权得到的 access token、refresh token、ID token 与绑定信息保存在权限为 `0600` 的 `<KANA_HOME>/oauth-tokens.json`；到期前会自动 refresh，模型请求收到首个 `401` 时也会 refresh 并重试一次。`status` 只显示授权状态、是否可刷新和到期时间，不显示 token。完整协议映射见 [OpenAI Codex 提供商适配](openai-codex-provider.zh-CN.md)。

### Agent 模型表

| 键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `agent.web_search` / `memory.agent.web_search` | 布尔值 | `true` / `false` | 仅在所选模型 metadata 也支持时允许托管搜索；Custom 模型目前不声明托管搜索能力。 |
| `agent.image_input` / `memory.agent.image_input` | 布尔值 | `true` / `false` | 仅在 metadata 支持图片时允许已持久化的用户/工具图片并注册 `view_image`；禁用或不支持时，图片仍保留，但模型输入使用省略标记。 |
| `agent.model.provider` / `memory.agent.model.provider` | `deepseek`、`openai-codex`、`custom` | `deepseek` | 两个 Agent 各自独立选择的 provider。 |
| `agent.model.name` | Provider 模型名 | `deepseek-v4-pro` | 对话模型；内置模型名按 provider metadata 校验。 |
| `memory.agent.model.name` | Provider 模型名 | `deepseek-v4-flash` | 独立于 `/model` 的记忆压缩模型。 |
| `*.model.reasoning_effort` | 模型 metadata 声明的值 | Metadata 默认值 | 可选覆盖。DeepSeek 支持 `none`、`low`、`high`、`max`；Codex 支持 `low`、`medium`、`high`、`xhigh`、`max`；Custom 使用 `custom.toml` metadata。 |
| `*.model.max_output_tokens` | 可选正整数 | Metadata 输出硬上限 | Agent 级输出上限；先按模型硬上限钳制，prompt 空间更紧时再逐轮降低。 |
| `*.model.context_limit` | 可选正整数 | Metadata context window | Agent 级上下文上限，按所选模型 context window 钳制。 |

Custom 在 `config.toml` 中与内置模型使用完全相同的 Agent model 结构：在任一 Agent 模型表中设置 `provider = "custom"`、`name` 和可选偏好。Endpoint、鉴权、硬上限、输入模态、并行工具能力、推理档位和默认推理强度仍作为模型 metadata 保存在 `providers/custom.toml`。详见[自定义 OpenAI-compatible 提供商](custom-provider.zh-CN.md)。

### 其他配置表

| 表与键 | 类型与可选值 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `agent.max_turns` | `-1` 或正整数 | `-1` | 一次用户运行中模型—工具回合的最大数；达到上限且仍需继续时以 `turn_limit` 结束。 |
| `agent.goal_max_rounds` | 正整数 | `8` | 单个 `/goal` 最多允许的完整 Agent run 数，包含首次 run。 |
| `agent.tool_deadline_ms` | 正整数 | `660000` | 未声明 `execution.deadlineMs` 的工具每次调用的默认 deadline（毫秒）；工具自身声明的值优先。 |
| `agent.parallel_tool_calls` | 布尔值 | `true` | 是否允许模型提出并实际并发执行安全的工具调用；所选模型 metadata 不支持时始终关闭。 |
| `agent.max_parallel_tool_calls` | 正整数 | `4` | 一个相邻并行安全组内可同时执行的工具调用 body 上限。 |
| `agent.tool_result_artifacts` | 布尔值 | `true` | 将超大的非 `read` 文本结果保存为私有 session artifact，并给模型提供有界、可取回的预览。 |
| `agent.background_jobs.max_concurrent` | 正整数 | `4` | 单个 session 实例最多拥有的活动 Background Job 数；已保留的终态 Job 不计入上限。 |
| `agent.repeated_tool_calls.reminder_thresholds` | 严格递增且每项不小于 2 的整数数组 | `[3,5,8]` | 连续精确重复达到哪些次数时，Agent 插入逐级增强的建议上下文；空数组关闭策略。 |
| `agent.repeated_tool_calls.excluded_tools` | 唯一、非空、已去除首尾空白的工具名数组 | `[]` | 重复调用统计透明忽略的工具；被排除的调用既不推进也不重置连续计数。 |
| `approval.mode` | `always`、`unless_trusted`、`never` | `unless_trusted` | 工具调用是否进入 TUI 审批。 |
| `notification.backend` | `auto`、`off`、`bell`、`osc9`、`osc777`、`kitty` | `auto` | 终端通知输出协议。`auto` 依次识别 Kitty、iTerm、Ghostty、VTE，否则退回 bell。 |
| `notification.on_agent_completed` | 布尔值 | `true` | 正常完成的 Agent 运行是否通知。中止、错误、长度截断或 `turn_limit` 不会视作完成。 |
| `notification.on_approval_required` | 布尔值 | `true` | 显示工具审批时是否通知。 |
| `tui.theme` | 小写主题标识符 | `kana` | 选择内置主题或 `<KANA_HOME>/themes/<name>.json`；变更在下次启动 TUI 时生效。 |
| `tui.hyperlinks` | 布尔值 | `true` | 是否允许 TUI 在确认终端支持时用 OSC 8 渲染 Markdown 链接；关闭、终端未知或不支持时显示 `label (url)`。 |
| `tui.render_latex` | 布尔值 | `true` | 是否把支持的 Markdown 数学公式渲染为终端友好的 Unicode 和字符单元布局；关闭时保留原始 LaTeX。 |
| `tui.render_mermaid` | 布尔值 | `true` | 是否在文本流式生成时把支持的 Mermaid 代码围栏渲染为终端 Unicode 图；关闭时保留为代码块。 |
| `tui.smooth_text_streaming` | 布尔值 | `true` | 是否平滑展开突发到达的助手文本；关闭时直接显示 provider 的最新流式快照。 |
| `tui.collapse_long_pastes` | 布尔值 | `true` | 是否把达到 1,000 个 grapheme 的 bracketed paste 折叠为原子的 `[Pasted N chars]` 编辑项；关闭时正常显示并逐字编辑粘贴文本。 |
| `memory.enabled` | 布尔值 | `true` | 是否注册 `remember`，并把记忆注入系统提示词。 |
| `memory.max_chars` | 正整数 | `6000` | 合并后长期记忆的 Unicode 字符数上限。 |
| `memory.daily_retention_days` | 可选正整数 | 未设置 | 全量记忆压缩成功后保留每日暂存记录的天数。 |
| `logging.level` | `debug`、`info`、`warn`、`error`、`off` | `info` | 运行时 JSONL 日志的最低记录级别；`off` 完全关闭文件日志。 |

`parallel_tool_calls` 只有在用户策略与模型 metadata 都允许时才生效。重复调用、tool-result artifact、并发、deadline 与 Background Job 字段所配置的行为属于[工具与执行](tools.zh-CN.md)；context limit 与压缩预算由 [Agent 运行时](agent-runtime.zh-CN.md)解释。

上表仍是 TUI option 字段的 canonical 定义。交互语义属于 [TUI 交互](tui.zh-CN.md)，hyperlink、LaTeX、Mermaid、宽度与 repaint 行为属于[终端渲染](terminal-rendering.zh-CN.md)。Memory retention 与 runtime-log 持久化属于[会话与记忆](sessions-and-memory.zh-CN.md)。

### TUI 主题

内置 `kana` 主题是默认值，保持 Kana 的标准配色，并使用 Shiki 的 `tokyo-night` 主题进行语法高亮。名为 `ocean` 的用户主题保存在 `<KANA_HOME>/themes/ocean.json`，通过 `theme = "ocean"` 选择。主题标识符最多包含 64 个小写 ASCII 字母、数字、下划线或连字符，并且必须以字母或数字开头。内置名称被保留，因此 `kana.json` 这类用户文件不能覆盖内置主题。

Kana 只在 TUI 启动时读取选中的用户主题文件。文件必须是只包含 `syntaxTheme` 和 `colors` 的 JSON object；`syntaxTheme` 是当前安装的 Shiki 所捆绑的 theme ID。下例中的每个颜色键都必填，未知键会被拒绝，颜色值使用六位 `#rrggbb` 格式：

```json
{
  "syntaxTheme": "tokyo-night",
  "colors": {
    "assistant": "#dee2e6",
    "markdownText": "#dee2e6",
    "markdownHeading": "#69d0c4",
    "markdownQuote": "#8b949e",
    "markdownRule": "#4b5563",
    "markdownTable": "#cdd5df",
    "markdownCodeBlock": "#cdd5df",
    "markdownInlineCode": "#e5b567",
    "user": "#7ea6ff",
    "userMessageText": "#dee2e6",
    "shortcutHint": "#c099e0",
    "command": "#c099e0",
    "commandSelected": "#d5b0f5",
    "bottomTitle": "#69d0c4",
    "muted": "#8b949e",
    "model": "#7ea6ff",
    "contextUsage": "#69d0c4",
    "cwd": "#8b949e",
    "toolActive": "#e5b567",
    "toolSuccess": "#89d185",
    "toolOutput": "#9ca6b2",
    "error": "#f47067",
    "usageInput": "#7ea6ff",
    "usageCache": "#69d0c4",
    "usageOutput": "#89d185",
    "usageReasoning": "#c099e0",
    "usageWarning": "#f0ab56",
    "usageMuted": "#5c6674",
    "statusIdle": "#cdd5df",
    "diffDeleteBackground": "#461818",
    "diffInsertBackground": "#124626",
    "welcomeBorder": "#4b5563",
    "welcomeTitle": "#69d0c4",
    "welcomeMuted": "#8b949e",
    "welcomeText": "#dee2e6"
  }
}
```

所选 palette 与语法主题在进程生命周期内保持不变。修改 `config.toml` 或 JSON 文件只影响下次启动；Kana 不会扫描、监听或热加载 themes 目录。Clean mode 的 TUI 仍使用已配置主题。Headless `kana exec` 会把主题标识符作为 `config.toml` 的一部分进行校验，但不会读取主题 JSON 文件。

日志固定写入 `<KANA_HOME>/logs`，目录不可配置；所选 log level 会在持久化前过滤记录。Provider 生命周期记录格式见[供应商](providers.zh-CN.md)，其它稳定诊断 event 由各子系统文档拥有。

配置根和每个已出现的 section 都必须是 TOML table。字符串不能为空，布尔值不能写成字符串，不支持的 provider、reasoning effort、审批模式、notification backend 或 log level 会阻止启动。Agent 与 Memory Agent capability flag 必须为 Boolean；`max_turns` 只接受 `-1` 或正整数；deadline、并发限制、Job 限制、模型 token limit、context limit 与 memory 数量必须为正整数。Provider retry 与 timeout 必须是有限数字。Kana 不会静默忽略无效的已知字段。

## `mcp.json` 与 `mcp-enabled.json`

MCP server 不写入 `config.toml`。Claude Code 风格的定义保存在 `<KANA_HOME>/mcp.json`，`<KANA_HOME>/mcp-enabled.json` 则是启用状态的唯一来源。定义文件不存在或省略 `mcpServers` 时等价于未配置 server；启用文件不存在或省略 `enabledServers` 时等价于未启用任何 server。Kana 只启动同时存在于定义和 `enabledServers` 中的 ID，过期的未知 ID 会被忽略。运行时与协议行为见 [MCP](mcp.zh-CN.md)。

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

Server ID 必须非空且不能重复。未知字段、无效值或重复 ID 都会导致加载失败。`/mcp` 交互及其脱敏规则见 [TUI](tui.zh-CN.md)。

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

stdio 子进程默认只继承已存在的 `HOME`、`PATH`、`TMPDIR`、`TMP`、`TEMP`、`LANG`、`LC_ALL` 和 `LC_CTYPE`，然后合并展开后的 `env`。占位符从 Kana 进程环境读取，因此也能使用 `<KANA_HOME>/.env`；`${VAR:-default}` 会在变量未设置或为空时使用不递归展开的默认值。缺少必需变量会使该 server 失败。环境变量名必须符合常规格式，配置值必须是字符串，超时必须为正数。

HTTP server 的 `proxy` 会一致应用于其 MCP 与 OAuth 请求；设为 `false` 时该 server 绕过进程级代理，省略时保留 Bun 默认路由及继承的 `HTTP_PROXY` 或 `HTTPS_PROXY`。浏览器跳转仍使用浏览器自身的网络设置。诊断只记录是否使用显式代理或 bypass，不记录代理 URL。

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

MCP 授权把 token 与绑定信息写入权限为 `0600` 的 `<KANA_HOME>/oauth-tokens.json`。Discovery、PKCE、refresh、challenge 恢复和 scope 边界见 [OAuth](oauth.zh-CN.md) 与 [MCP](mcp.zh-CN.md)。

HTTP transport 版本、JSON/SSE session 行为、恢复规则、server 失败隔离、远端工具映射和 manager 生命周期见 [MCP](mcp.zh-CN.md)。用户可见的加载、reload、审批和关闭行为属于 [TUI](tui.zh-CN.md)。

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
| `always` | 除 `remember`、`schedule_wake`、`todo_write` 和 `update_goal` 外，每个工具调用都请求审批。 |
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
[agent.model]
name = "deepseek-v4-flash"

[notification]
backend = "bell"
on_agent_completed = false
```

切换到已经授权的 Codex Luna 只需要：

```toml
[agent.model]
provider = "openai-codex"
name = "gpt-5.6-luna"
```

不要复制完整默认文件来做小改动：字段级合并允许配置保持更短，也能在代码添加新默认字段时自动获得默认行为。
