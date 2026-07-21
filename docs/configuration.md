# 配置与安装

本文说明 Kana 当前实现的启动命令、配置文件和本地目录。配置以 Bun TOML 解析；字段名使用 `snake_case`，而代码内部使用 `camelCase`。

## 安装与启动

```bash
# 创建默认本地配置
kana install

# 同时安装或更新默认的全局 Skills 仓库
kana install --skills

# 覆盖已安装的配置与状态文件，必要时重新克隆 Skills
kana install --force --skills

# 将已安装的 Kana Skills 复制到 Codex 的全局 Skills 目录
kana skills sync codex

# 复制到自定义 agent 的 Skills 目录；已有同名 Skill 默认跳过
kana skills sync --target-dir ~/.other-agent/skills

# 替换目标目录中已有的同名 Skill
kana skills sync codex --force

# 启动 TUI；参数会作为第一条提示词
kana 修复测试失败

# 按 ID 恢复会话；省略 ID 时打开选择器
kana resume [session-id]
```

`kana install` 不会覆盖已经存在的文件。`--force` 会将 `config.toml`、`mcp.json`、`mcp-enabled.json`、`approvals.json` 和 `skills/skills.toml` 恢复为默认内容；若使用 `--skills`，还会删除并重新克隆默认 Skills 目录。它**不会**创建 `~/.kana/AGENTS.md`，全局指令文件需要用户自行创建。

默认 Skills 仓库是 `https://github.com/longyijdos/kana-skills.git`，安装位置为 `<KANA_HOME>/skills/kana-skills`。已有目录不是 Git 仓库时，普通更新会报错，必须使用 `--force` 才会替换它；已有 Git 仓库则执行 `git pull --ff-only`。

`kana skills sync` 不会重新 clone 仓库；它读取 `<KANA_HOME>/skills/kana-skills`，把其中每个顶层、包含 `SKILL.md` 的 Skill 目录复制到目标 agent 的 Skills 根目录。`codex` 预设写入 `${CODEX_HOME:-$HOME/.codex}/skills`。若目标中已存在同名目录，默认跳过；传 `--force` 会先删除该目录再复制。若默认 Skills 仓库尚未安装，请先运行 `kana install --skills`。

## 根目录与文件布局

Kana 使用 `KANA_HOME` 指定根目录；未设置时使用 `$HOME/.kana`，若 `HOME` 也不存在则回退到操作系统返回的用户主目录。

```text
${KANA_HOME:-$HOME/.kana}/
├── .env                    # 可选：启动时加载的环境变量
├── config.toml             # 本文的运行配置
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
| `timeout_ms` | 有限数字 | `60000` | 等待 DeepSeek 响应头或相邻响应数据的无活动超时毫秒数。 |
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
| `env` | stdio: `{}` | 显式加入子进程环境的字符串键值。配置值覆盖同名基础环境变量。 |
| `url` | HTTP 必填 | Streamable HTTP 单端点 URL；必须为绝对 `http`/`https` URL，不能包含 credentials 或 fragment。 |
| `proxy` | HTTP: 未设置 | 绝对 `http`/`https` 代理 URL 表示仅该 server 使用指定代理；`false` 表示忽略进程级代理并强制直连。URL 不能包含 credentials 或 fragment。 |
| `headers` | HTTP: `{}` | 每个 HTTP 请求附带的字符串 headers；不能覆盖 transport 管理的 content、session、protocol 或 SSE headers。 |
| `auth` | 未设置 | HTTP OAuth 2.0 配置；设置后 `url` 必须为 HTTPS，且 `headers` 不能再设置 `Authorization`。 |
| `required` | `false` | 启动失败是否阻止 MCP manager 整体就绪。 |
| `startupTimeoutMs` | `10000` | 完成 MCP 初始化握手的超时。 |
| `requestTimeoutMs` | `60000` | 普通 MCP 请求的默认超时。 |
| `includeTools` | 未设置 | 按远端原名选择允许暴露的工具。空数组表示不暴露任何工具。 |
| `excludeTools` | 未设置 | 按远端原名排除工具；同时出现在 include/exclude 时以排除为准。 |

stdio 子进程默认只继承已存在的 `HOME`、`PATH`、`TMPDIR`、`TMP`、`TEMP`、`LANG`、`LC_ALL` 和 `LC_CTYPE`，然后合并 `env`。不会继承其他进程环境变量。环境变量名必须符合常规格式，值必须是字符串；未知字段、非正整数超时、重复或空工具名都会使配置加载失败。

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

stdio server 配置是本地代码执行的信任边界：Kana 在 MCP 工具审批之前就必须启动 `command`，所以只应配置可信程序。HTTP endpoint 与 OAuth 授权服务器同样属于远端数据、工具和凭据的信任边界。`env` 与 `headers` 按 JSON 字面值处理，静态 token 因而会以明文保存在 `mcp.json`；优先使用 OAuth 的 `clientSecretEnv` 和最小权限 scopes，不要提交或分享配置与 token 文件。Kana 的 OAuth token store 是本地明文凭据文件，只通过文件权限保护。`kana install` 会以 `0600` 创建两个 MCP 文件，但 `kana install --force` 也会把服务器定义和启用状态重置为空默认值；它不会删除 OAuth token store。协议版本由代码维护，不提供任意字符串配置。

## API key 与项目指令

`api_key_env` 只告诉 Kana 从哪里读取 key，不会把 key 持久化到 `config.toml`。Kana 在解析启动命令前会读取 `<KANA_HOME>/.env`；文件不存在时直接跳过。其中的值会覆盖启动 shell 继承的同名变量，也会覆盖 Bun 从当前工作目录 `.env` 自动加载的同名变量。因此可以把默认 key 写为：

```dotenv
DEEPSEEK_API_KEY=sk-...
```

`.env` 路径使用加载前的 `KANA_HOME` 确定；未设置时为 `$HOME/.kana/.env`。

全局 `AGENTS.md` 位于 `<KANA_HOME>/AGENTS.md`。内置默认助手指令始终注入；全局文件存在时追加到默认指令后。项目根目录的 `AGENTS.md` 也会被读取，并追加在全局内容后，因此拥有更具体的后置位置。详见[架构总览](architecture.md)中的提示词装配说明。

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

## 全局 Skills 配置：`skills/skills.toml`

```toml
[model_invocation]
enabled = []
```

该列表列出允许注入模型系统提示词的**全局** Skill 名称。项目 `.kana/skills` 和 `.agents/skills` 下的 Skills 始终启用，不能从该文件关闭。TUI 的 `/skills` 只修改这份全局启用列表：`Enter` 修改草稿，`Esc` 仅在最终选择变化时写入并刷新一次。

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
