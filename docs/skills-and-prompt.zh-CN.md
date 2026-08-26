# Skills 与系统提示词

Kana 的 Skills 是按需加载的本地说明文件，不是运行时代码插件。启动 Agent 时，Kana 只把 Skill 的名称、描述和路径写入系统提示词；模型在任务匹配时再用 `read` 工具读取对应 `SKILL.md`。这让提示词保持较小，也让 Skill 能包含较长的工作流说明和相对资源。

## Skill 发现位置与优先级

默认发现顺序如下，前面优先：

1. `<cwd>/.kana/skills`
2. `<cwd>/.agents/skills`
3. `<KANA_HOME>/skills`

额外传给 `loadKanaSkills` 的路径会排在这些默认目录之后。每个目录递归扫描，跳过以 `.` 开头的目录和 `node_modules`，并按子目录名排序。若一个目录自身包含 `SKILL.md`，该文件代表整个目录，扫描会停止而不会继续读取其子目录。

只接受名为 `SKILL.md` 的文件。符号链接会跟随到文件或目录，已访问的真实目录不会重复扫描，从而避免链接循环。相同真实文件只加载一次；不同文件同名时保留最先发现的项，并产生 `name_collision` 诊断。因此项目 Skill 会覆盖同名全局 Skill。

## `SKILL.md` 格式

最小有效 Skill 需要非空 `description`：

```markdown
---
name: release-check
description: 检查并发布 TypeScript 包。
---

# Release check

按项目约定运行测试，然后检查变更。
```

frontmatter 仅识别 `name` 和 `description`；未知字段被忽略。支持未加引号或单/双引号标量，也支持 `|` 或 `>` 后接缩进内容的多行值。frontmatter 必须从文件第一行的 `---` 开始，并以单独的结束标记关闭。

未声明 `name` 时，`SKILL.md` 使用其父目录名作为名称。无 frontmatter 的文件仍会解析，但因为缺少 `description` 不会被注册。`description` 超过 1024 字符、`name` 超过 64 字符、非法名称字符、首尾连字符或连续 `--` 都会产生警告；当前实现仍会注册带无效名称但有描述的 Skill。

推荐名称使用小写字母、数字和单个连字符，例如 `release-check`。描述应说明触发场景，而不是复述文件名。

## 全局启用控制

项目目录中的 Skills 默认始终启用。全局目录 `<KANA_HOME>/skills` 中的 Skills 需要在 `skills.toml` 的列表中显式启用：

```toml
[model_invocation]
enabled = ["release-check", "database-migrations"]
```

文件不存在或 `enabled` 缺失时，全局 Skills 均不注入模型提示词。`/skills` 打开管理界面：project 项显示为 locked，`Enter` 只在本地草稿中切换 global 项。`Esc` 应用并关闭草稿；最终集合有变化时，Kana 只重写一次列表并重建一次 Agent 系统提示词，未变化时两项操作都不执行，持久化失败时管理界面保持打开。管理界面显示的 scope 根据 Skill 文件是否位于全局 Skills 目录内决定。

## 提示词的组成

`createKanaAgent` 在当前工作目录加载 Skills，并构造一份不可变的 prompt assembly。稳定 system 前缀按以下顺序组成：

```text
可用的 global/project 长期记忆（若启用且非空）
默认助手指令
全局 AGENTS.md（若存在）
项目 AGENTS.md（若存在）
可见 Skills 的目录
Runtime-context 状态转换协议
```

每次模型调用前，Agent 都会解析动态 context 和工具 section。环境、Background Job、session todo 与进程内 Goal 状态属于动态 section；Job、todo 和 Goal section 通过只读 resolver 回调取得状态。工作区、Goal 控制、memory、scheduled-wake 和外部/MCP 能力分别属于独立工具 section。每个 context source 都必须返回明确且非空的 `active` 或 `inactive` 状态。`update_goal` 只在进程内 Goal 为 active 时声明。同一步解析出的工具对象既会声明给该次模型请求，也会用于执行该请求产生的调用，因此后续刷新不会改变正在进行中的调用语义。稳定 system 前缀在这些步骤之间保持不变，供应商 prompt cache 可以复用它。

`--clean` 会完全绕过全局和项目 Skills 发现、`skills.toml` 激活读取、两级 memory 与两级 `AGENTS.md`。此时稳定 system 提示词包含默认助手指令和 runtime-context 协议，动态环境上下文仍然可用；Agent 不注册 `remember` 或任何外部工具。TUI 的 `/skills` 和 `/memory` 也会报告在 Clean 模式下不可用。`.env`、provider/model 和其它运行配置仍按普通启动流程加载，但 `/model` 的选择只保留在当前临时进程中。

全局指令路径是 `<KANA_HOME>/AGENTS.md`，项目指令路径是 `<cwd>/AGENTS.md`。内置默认指令只有一句，用于声明当前环境中的简洁、实用助手；具体能力的调用 guidance 位于对应工具 description。全局文件存在时会追加到默认指令后，项目文件再追加到后面。若两条 AGENTS 路径解析到同一文件，只注入一次。项目内容处于更后的、更具体的位置，但代码没有把多份指令合并为任何优先级算法，模型仍需根据完整提示词解释它们。

环境块包含当前目录、`process.platform`、按本地时区格式化的 `YYYY-MM-DD` 日期与时区名，并包装在带内部来源标记的 runtime-context 消息中：

```text
<runtime_context source="environment">
{"cwd":"/workspace","platform":"darwin","currentDate":"2026-06-22","timezone":"Asia/Shanghai"}
</runtime_context>
```

Agent 会按 `source` 将每个明确状态与历史中最近的同源消息比较。初始就是 inactive 的 source 不产生消息；激活后，每个有变化的 active 状态或由 source 定义的 inactive 状态都会在模型 I/O 前追加并写入 journal，未变化状态不重复。压缩前的所有转换都会留在模型输入中，让新请求能够延续上一请求的完整消息前缀，而不会因删除旧快照使其后的 prompt cache 失效。稳定 system 协议要求模型只把每个 source 的最后一条消息视为权威状态，并让 `status="inactive"` 作废更早状态。内部消息不会显示在 transcript 中。

上下文压缩不会把 runtime-context 消息交给摘要模型。它会在 checkpoint 边界处仅重新投影当时仍 active 的各 source 最后状态，再保留边界之后的全部转换。被覆盖的旧状态和 inactive 转换随原始历史一起退出模型输入；这是 compaction 时有意发生的 cache 重置。

Active Goal 使用独立的 `goal` runtime-context source。其紧凑 JSON 状态包含 `authorized: true` 与目标，终态更新 guidance 则位于动态声明的 `update_goal` description。controller ID、已允许的 run 计数和配置上限不会进入模型状态，避免把 runtime 调度误当成任务语义。必须提供的 inactive 状态包含 `authorized: false`，并作废之前的目标。这些转换可以保留在追加式 session 历史中，但授权与 controller 只存在于当前进程；恢复后没有 active controller 时，下一次 Agent 请求会追加 inactive 状态且不会重建 Goal。

如果 memory 启用且对应长期文件非空，Kana 在稳定 system 前缀开头写入 `<memory>`，内部区分 `global` 与 `project` 引用块。记忆文本会 XML 转义，避免其中的 `<`、`&` 等改变宿主标签结构；但它仍是模型上下文中的不可信数据，记忆合并提示要求将其作为数据而非指令。Memory 在 Agent 构建时读取，而不会在每次 `remember` 后把不断增长的完整文件追加到历史中，从而避免重复 token。何时保存、保存什么的 guidance 位于 `remember` 工具 description，因此只会在该能力可用时声明给模型。

## 注入给模型的 Skill 目录

每个可见 Skill 会变成以下 XML 风格条目：

```xml
<available_skills>
  <skill>
    <name>release-check</name>
    <description>检查并发布 TypeScript 包。</description>
    <location>/absolute/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

名称、描述和路径会 XML 转义。提示词明确要求模型在任务匹配时通过 `read` 工具加载文件，并把 Skill 内的相对路径相对于 `SKILL.md` 的父目录解析。Kana 不会自动读取 Skill 正文、自动执行其中命令，或把它们注册为 Tool。

## 诊断与维护

加载结果包含 warning 或 collision 诊断。常见原因包括文件不可读、frontmatter 不完整、元数据格式不合法和同名冲突。TUI 目前加载并显示有效 Skill 的激活状态；调用方若要处理诊断，需要读取 `loadKanaSkills`/`loadKanaSkillActivations` 的返回值。

新增 Skill 时：

- 使用目录 `<root>/<skill-name>/SKILL.md`，便于把脚本或模板放在同一目录。
- 写简短准确的 description，避免过宽泛触发。
- 不依赖“全局一定启用”：全局 Skill 需要用户在 `/skills` 中打开。
- 把相对资源写成相对于 Skill 目录的路径；模型提示词已明确这一约定。
- 用 project 目录放仓库专用流程，用 global 目录放跨项目可复用流程。
