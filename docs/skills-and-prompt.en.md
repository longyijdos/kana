# Skills and the system prompt

Kana Skills are local, on-demand instruction files, not runtime code plugins. When an Agent starts, Kana writes only each Skill's name, description, and path into the system prompt; when a task matches, the model reads the relevant `SKILL.md` with the `read` tool. This keeps the prompt smaller while allowing a Skill to contain longer workflows and relative resources.

## Discovery locations and precedence

Default discovery order is, with earlier paths winning:

1. `<cwd>/.kana/skills`
2. `<cwd>/.agents/skills`
3. `<KANA_HOME>/skills`

Additional paths supplied to `loadKanaSkills` follow these defaults. Each directory is scanned recursively, skipping dot-prefixed directories and `node_modules`, with child directories sorted by name. If a directory itself contains `SKILL.md`, that file represents the directory and scanning stops instead of reading descendants.

Only files named `SKILL.md` are accepted. Symlinks are followed to files or directories, and visited real directories are not scanned again, avoiding link cycles. The same real file loads once; when distinct files share a name, the first wins and a `name_collision` diagnostic is emitted. Project Skills therefore override global Skills with the same name.

## `SKILL.md` format

The smallest usable Skill needs a non-empty `description`:

```markdown
---
name: release-check
description: Check and release a TypeScript package.
---

# Release check

Run the project-required tests, then inspect changes.
```

Frontmatter recognizes only `name` and `description`; unknown fields are ignored. It supports unquoted or single/double-quoted scalars and multi-line values after `|` or `>` with indented content. Frontmatter must begin with `---` on the first line and have a separate closing marker.

If `name` is absent, `SKILL.md` uses its parent directory name. A file without frontmatter is still parsed, but it is not registered because it has no `description`. A description longer than 1024 characters, a name longer than 64 characters, invalid name characters, leading/trailing hyphens, or consecutive `--` produce warnings; the current implementation still registers a Skill with an invalid name when it has a description.

Use lowercase letters, digits, and single hyphens for names, such as `release-check`. Describe the trigger scenario rather than repeating the file name.

## Global activation

Skills in project directories are always enabled. Skills under `<KANA_HOME>/skills` require explicit activation in the `skills.toml` list:

```toml
[model_invocation]
enabled = ["release-check", "database-migrations"]
```

When the file is absent or `enabled` is missing, no global Skills enter the model prompt. `/skills` opens the manager: project entries are locked, while global entries can be toggled with Enter; saving rewrites this list. The manager determines scope by whether a Skill file resides under the global Skills directory.

## System-prompt composition

`createKanaAgent` loads Skills from the current working directory and builds the system prompt in this order:

```text
Available global/project durable memory (when enabled and non-empty)
Durable-memory guidance for remember (when memory is enabled)
Global AGENTS.md or default assistant instructions
Project AGENTS.md (when present)
Environment context
Visible Skills catalogue
```

Global instructions are `<KANA_HOME>/AGENTS.md`; project instructions are `<cwd>/AGENTS.md`. When the global file exists it replaces the built-in default assistant instructions, then the project file is appended. When the two resolved paths are the same file, it is injected only once. Project content has the later, more specific position, but the code does not merge instructions through a priority algorithm; the model still interprets the complete prompt.

The environment block uses XML-like tags and contains the current directory, `process.platform`, a locally time-zone-formatted `YYYY-MM-DD` date, and the time-zone name:

```xml
<environment_context>
  <cwd>/workspace</cwd>
  <platform>darwin</platform>
  <current_date>2026-06-22</current_date>
  <timezone>Asia/Shanghai</timezone>
</environment_context>
```

When memory is enabled and its durable file is non-empty, Kana starts the prompt with `<memory>`, containing separate `global` and `project` reference blocks. Memory text is XML-escaped so `<`, `&`, and similar characters cannot alter the host tag structure; it remains untrusted data in model context, and the consolidation prompt directs the model to treat it as data rather than instructions.

## Skill catalogue injected into the model

Each visible Skill becomes an XML-like entry:

```xml
<available_skills>
  <skill>
    <name>release-check</name>
    <description>Check and release a TypeScript package.</description>
    <location>/absolute/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

Names, descriptions, and paths are XML-escaped. The prompt instructs the model to load matching files with the `read` tool and resolve paths referenced inside a Skill relative to the parent directory of `SKILL.md`. Kana does not automatically read Skill bodies, execute their commands, or register them as Tools.

## Diagnostics and maintenance

Loading produces warning or collision diagnostics. Common causes are unreadable files, incomplete frontmatter, invalid metadata, and name collisions. The TUI currently loads and displays activation state for valid Skills; callers that need diagnostics must inspect the result of `loadKanaSkills` or `loadKanaSkillActivations`.

When adding a Skill:

- Use `<root>/<skill-name>/SKILL.md` so scripts and templates can live beside it.
- Write a short, accurate description to avoid overly broad matching.
- Do not assume a global Skill is enabled: users must activate it in `/skills`.
- Reference relative resources from the Skill directory; the model prompt specifies this convention.
- Put repository-specific workflows in project directories and reusable workflows in the global directory.
