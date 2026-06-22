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

文件不存在或 `enabled` 缺失时，全局 Skills 均不注入模型提示词。`/skills` 打开管理界面：project 项显示为 locked，global 项可用 Enter 开关；保存时会重写这个列表。管理界面显示的 scope 根据 Skill 文件是否位于全局 Skills 目录内决定。

## 系统提示词的组成

`createKanaAgent` 在当前工作目录加载 Skills，并按以下顺序构造系统提示词：

```text
可用的 global/project 长期记忆（若启用且非空）
remember 的持久化规则（若记忆启用）
全局 AGENTS.md 或默认助手指令
项目 AGENTS.md（若存在）
环境上下文
可见 Skills 的目录
```

全局指令路径是 `<KANA_HOME>/AGENTS.md`，项目指令路径是 `<cwd>/AGENTS.md`。全局文件存在时会替换内置默认助手指令；项目文件再追加到后面。若两条路径解析到同一文件，只注入一次。项目内容处于更后的、更具体的位置，但代码没有把多份指令合并为任何优先级算法，模型仍需根据完整提示词解释它们。

环境块使用 XML 风格标签，包含当前目录、`process.platform`、按本地时区格式化的 `YYYY-MM-DD` 日期与时区名：

```xml
<environment_context>
  <cwd>/workspace</cwd>
  <platform>darwin</platform>
  <current_date>2026-06-22</current_date>
  <timezone>Asia/Shanghai</timezone>
</environment_context>
```

如果 memory 启用且对应长期文件非空，Kana 在提示词开头写入 `<memory>`，内部区分 `global` 与 `project` 引用块。记忆文本会 XML 转义，避免其中的 `<`、`&` 等改变宿主标签结构；但它仍是模型上下文中的不可信数据，记忆合并提示要求将其作为数据而非指令。

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
