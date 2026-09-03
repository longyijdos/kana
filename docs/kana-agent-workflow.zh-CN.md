# Kana Agent 可复用 workflow

Kana 通过 `.github/workflows/kana-agent-reusable.yml` 发布 issue 与 pull request 自动化。
调用仓库只需保留一个很小的 `issue_comment` workflow 以及自己的 Kana 配置。Called
workflow 在调用仓库中 checkout 和发布，而运行时二进制始终来自公开的
`longyijdos/kana` release。

## 最小 caller

在调用仓库中创建 `.github/workflows/kana-agent.yml`，并把 `<release-tag>` 替换为已发布的
Kana tag：

```yaml
name: Kana Agent

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  issues: read
  pull-requests: read

jobs:
  kana:
    uses: longyijdos/kana/.github/workflows/kana-agent-reusable.yml@<release-tag>
    with:
      config-path: .github/kana/config.toml
      kana-version: <release-tag>
    secrets:
      KANA_GITHUB_TOKEN: ${{ secrets.KANA_GITHUB_TOKEN }}
      KANA_MODEL_API_KEY: ${{ secrets.KANA_MODEL_API_KEY }}
```

`KANA_GITHUB_TOKEN` 是必需 secret。它用于识别 Kana 账号、跨仓库读取 Kana 的公开 release
metadata 和 assets，并在调用仓库中发布分支、draft pull request 和评论。该 token 需要
Contents、Issues 与 Pull requests 的读写权限；如果希望 Kana 发布 workflow 文件变更，还需要
更新 workflow 文件的权限。

只有所选 provider 需要 bearer/API key 时，才必须配置 `KANA_MODEL_API_KEY`。Kana 只通过这个
provider-neutral 环境变量接收凭据；workflow 会先从 handoff 和失败文本中抹除它，再发布这些
内容。所选 provider 配置必须引用 `KANA_MODEL_API_KEY`，不要把凭据本身写进 TOML。

调用仓库还可能需要在 Actions 设置中允许来自公开 `longyijdos/kana` 仓库的 action 与可复用
workflow。

## 仓库本地配置

必需的 `config-path` 指向仓库内正常的 Kana `config.toml`。使用内置 DeepSeek provider 时，
workflow 配置可以写成：

```toml
# .github/kana/config.toml
[provider.deepseek]
api_key_env = "KANA_MODEL_API_KEY"

[agent]
goal_max_rounds = 3

[agent.model]
provider = "deepseek"
name = "deepseek-v4-flash"
reasoning_effort = "max"

[memory]
enabled = false

[notification]
backend = "off"
on_agent_completed = false
on_approval_required = false
```

模型选择完全保留在 Kana 现有配置 schema 中。所有内置 provider、Agent 与运行时设置见
[配置与安装](configuration.zh-CN.md)。

要使用 Custom OpenAI-compatible endpoint，在 `config.toml` 中选择 `custom`：

```toml
# .github/kana/config.toml
[agent]
goal_max_rounds = 3

[agent.model]
provider = "custom"
name = "coding-plan-model"

[memory]
enabled = false
```

再单独加入 provider 定义：

```toml
# .github/kana/providers/custom.toml
base_url = "https://models.example.com/v1"
api_key_env = "KANA_MODEL_API_KEY"

[[models]]
name = "coding-plan-model"
context_window = 131072
max_output_tokens = 32768
supports_parallel_tool_calls = true
```

然后从 caller 传入该文件：

```yaml
with:
  config-path: .github/kana/config.toml
  custom-provider-path: .github/kana/providers/custom.toml
  kana-version: <release-tag>
```

完整 provider schema 和 endpoint 信任边界见
[Custom OpenAI-compatible provider](custom-provider.zh-CN.md)。

运行时，workflow 会从触发运行的 caller commit 中把所选文件复制到
`$RUNNER_TEMP/kana-home`，并把该目录导出为 `KANA_HOME`。Session、日志、用量及其它可变状态
不会污染 checkout。PR follow-up 不能从 Kana 创建的工作分支替换可信配置；配置始终来自触发
事件对应的默认分支 commit。

## 仓库初始化与 preflight

可复用 workflow 不假设语言、包管理器或依赖安装器。仓库需要准备步骤时，可以提交如下脚本：

```bash
#!/usr/bin/env bash
set -euo pipefail

npm ci
```

通过 `setup-script-path: .github/kana/setup.sh` 传入。Workflow 从与配置相同的可信 caller
commit 加载脚本，并在 Kana 启动前、已 checkout 的仓库根目录中运行；不需要初始化时省略该
input。Setup 失败会记录 warning，但 Kana 仍会运行，以便检查和修复 checkout。

`preflight-command` 可以在 Kana 产生变更后运行仓库专用的格式化和校验命令。默认不配置；省略
时，Kana 仍会按任务 prompt 自行运行检查，而发布摘要会说明 workflow preflight 未配置。

## Inputs 与鉴权

| Input | 默认值 | 契约 |
| --- | --- | --- |
| `config-path` | 必需 | 仓库相对路径下的 `config.toml`。 |
| `custom-provider-path` | 空 | 仓库相对路径下的 `providers/custom.toml`。 |
| `setup-script-path` | 空 | Kana 运行前执行的仓库相对 setup 脚本。 |
| `preflight-command` | 空 | Agent run 产生变更后执行的仓库专用命令。 |
| `kana-version` | `latest` | 从 `longyijdos/kana` 下载的 release tag，或最新稳定 release。 |
| `authorized-maintainer` | 调用仓库 owner | 可以触发 workflow 的 GitHub login。 |

只有 authorized maintainer 本人发出的评论能启动工作。在 issue 中，无论 issue 由谁创建，该
maintainer 都可以使用 `@<kana-account> fix`。在 pull request 中，follow-up 仍只接受由 Kana
账号创建、位于调用仓库、保持 open 且分支名符合 `kana/issue-<number>-<run-id>` 的 PR。适当的
maintainer login 与仓库 owner 不同时（组织仓库中很常见），应设置 `authorized-maintainer`。

Kana 账号通过 `KANA_GITHUB_TOKEN` 解析，因此命令必须 mention 该账号的 login。可复用
workflow 保留现有 Goal 执行、结构化结果解析、部分进度发布、draft PR 创建和 follow-up 行为。
由 issue 触发的运行会把变更作为 draft pull request 发布。Agent 为 commit 和 pull request
提供同一个 `PR_TITLE`。Workflow 只要求它非空、单行且不超过
120 个字符，具体命名规范由调用仓库的 instructions 决定。

## 版本固定与更新

可复用 workflow 引用和下载的运行时是两个独立 pin。要得到完全可复现的集成，同时设置
`uses: ...@vX.Y.Z` 与 `kana-version: vX.Y.Z`，并在检查新版 Kana release 后一起更新。让
`kana-version` 保持 `latest`，表示 workflow 实现固定不变，但运行时二进制可以独立升级。要求
workflow 引用不可变时，`uses` 也可以使用 commit SHA；`kana-version` 仍应使用已发布的 release
tag。
