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

When the file is absent or `enabled` is missing, no global Skills enter the model prompt. `/skills` opens the manager: project entries are locked, while `Enter` toggles global entries in a local draft. `Esc` applies and closes the draft; if its final set changed, Kana rewrites the list once and rebuilds the Agent system prompt once. An unchanged draft performs neither operation, while a persistence failure leaves the manager open. The manager determines scope by whether a Skill file resides under the global Skills directory.

## Prompt composition

`createKanaAgent` loads Skills from the current working directory and builds an immutable prompt assembly. Its stable system prefix uses this order:

```text
Available global/project durable memory (when enabled and non-empty)
Default assistant instructions
Global AGENTS.md (when present)
Project AGENTS.md (when present)
Visible Skills catalogue
Runtime-context state-transition protocol
```

Before every model step, the Agent resolves dynamic context and tool sections. The environment, session todo state, and process-local Goal state are dynamic sections; workspace, goal control, memory, scheduled-wake, and external/MCP tools are separate capability sections. Every context source must return an explicit non-empty `active` or `inactive` state. `update_goal` is advertised only while the process-local goal is active. The tool objects resolved for a step are both advertised to that model request and used to execute its resulting calls, so a later refresh cannot change the meaning of an in-flight call. The stable system prefix remains unchanged across these steps, allowing provider prompt caches to reuse it.

`--clean` bypasses global and project Skill discovery, `skills.toml` activation reads, both memory scopes, and both `AGENTS.md` scopes. The stable system prompt then contains the built-in assistant instructions and runtime-context protocol; dynamic environment context remains available. The Agent registers neither `remember` nor external tools. `/skills` and `/memory` report that they are unavailable in clean mode. `.env`, provider/model selection, and other runtime configuration still follow the normal startup path, but a `/model` selection remains local to the temporary process.

Global instructions are `<KANA_HOME>/AGENTS.md`; project instructions are `<cwd>/AGENTS.md`. Built-in default assistant instructions are always injected; when the global file exists, it is appended after the defaults, then the project file is appended. When the two AGENTS paths resolve to the same file, it is injected only once. Project content has the later, more specific position, but the code does not merge instructions through a priority algorithm; the model still interprets the complete prompt.

The environment block contains the current directory, `process.platform`, a locally time-zone-formatted `YYYY-MM-DD` date, and the time-zone name. It is wrapped in an internal source-tagged runtime-context message:

```xml
<runtime_context source="environment">
<environment_context>
  <cwd>/workspace</cwd>
  <platform>darwin</platform>
  <current_date>2026-06-22</current_date>
  <timezone>Asia/Shanghai</timezone>
</environment_context>
</runtime_context>
```

The Agent compares each explicit state with the latest history message having the same `source`. A source that starts inactive produces no message. After activation, each changed active state or source-defined inactive state is appended and journaled before model I/O; unchanged states are not duplicated. Until compaction, every transition remains in model input so a request can extend the preceding message prefix instead of deleting an older snapshot and invalidating the following prompt cache. The stable system protocol tells the model that only the last message for each source is authoritative and that `status="inactive"` invalidates earlier states. Internal messages remain hidden from the transcript.

Compaction excludes runtime-context messages from summary generation. At the checkpoint boundary, it reprojects the last state for each source only when that state is active, then retains every transition after the boundary. Covered superseded and inactive transitions disappear together with the covered raw history, which is an intentional cache reset at compaction.

An active goal uses its own `goal` runtime-context source. That state contains the objective and terminal-update guidance, but omits the controller ID, admitted-run count, and configured limit so runtime scheduling does not become task semantics. Its required inactive state says that no user-authorized Goal is active and that an earlier Goal must not continue automatically. The transitions may remain in append-only session history, but the authorization and controller are process-local; after resume without an active controller, the next Agent request appends the inactive state and does not recreate the Goal.

When memory is enabled and its durable file is non-empty, Kana starts the stable system prefix with `<memory>`, containing separate `global` and `project` reference blocks. Memory text is XML-escaped so `<`, `&`, and similar characters cannot alter the host tag structure; it remains untrusted data in model context, and the consolidation prompt directs the model to treat it as data rather than instructions. Memory is captured when an Agent is built instead of being appended after every `remember` call, avoiding repeated copies of a growing memory file. Guidance about when and what to remember lives in the `remember` tool description, so it is advertised only when that capability is available.

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
