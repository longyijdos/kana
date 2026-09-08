# Subagents

Kana supports bounded asynchronous one-shot subagents selected from predefined role-card profiles. The conversation Agent can delegate a task, continue working, and later inspect or wait for the child result. Arbitrary prompts cannot create an unrestricted role: every spawn must name a currently valid built-in or user profile.

## Profiles

Kana always provides `explorer`, `worker`, and `reviewer`. Their default capabilities are:

| Profile | Tools | Purpose |
| --- | --- | --- |
| `explorer` | `list`, `glob`, `grep`, `read`, `view_image` | Read-only repository investigation. |
| `worker` | Workspace tools plus `mcp:*` | A bounded implementation task. |
| `reviewer` | Read-only workspace tools plus `bash` | Review changes without editing files. |

User profiles are direct Markdown children of `<KANA_HOME>/agents`, normally `~/.kana/agents`. The lowercase hyphenated filename without `.md` is the profile name. Each file is at most 64 KiB and uses this format:

```markdown
---
description: Review database migrations
tools:
  - list
  - grep
  - read
  - bash
model: openai-codex/gpt-5.6-terra
reasoning_effort: high
---
Review the delegated migration. Report correctness risks with file references.
Do not modify files.
```

`description` and a non-empty instruction body are required. `tools` may also be an inline array. `model` is optional and defaults to `inherit`; an explicit value is `<provider>/<model>`. `reasoning_effort` is valid only with an explicit model. Unknown frontmatter fields and invalid values reject the complete card.

A user file shadows a built-in with the same name. If that file is invalid, the name stays unavailable instead of silently falling back to broader or different built-in permissions. Profiles are reloaded when the main Agent's dynamic tool surface is assembled and when `/agents` refreshes. A spawn snapshots the complete selected card and digest, so later file edits do not change a running child or its journal.

## Capability and approval boundaries

The host derives the child model and capability limits from the conversation's validated Agent configuration, but does not carry prompt content across. An explicit card model replaces only the model selection; otherwise the child inherits the current model. The card's tool list can only reduce effective capabilities:

- workspace tools must be enabled by both `agent.tools` and the card;
- an exact external tool name grants only that tool, while `mcp:*` grants the currently active MCP tool set;
- child Agents never receive `spawn_subagent`, `wait_subagent`, `cancel_subagent`, Background Job, todo, Goal, memory, or scheduled-wake tools;
- oversized child results are not moved into parent-session artifacts.

The card body is the child's complete system prompt, and the task is its user message. Its runtime-context section list is empty: it receives no default Kana prompt, environment context, AGENTS.md content, memory, Skills, live host state, parent conversation messages, or inherited checkpoint. The main Agent must include every task-specific fact, constraint, path, and expected result in the `task` argument. The child uses the ordinary approval hook, so cards cannot weaken `approval.mode` or Bash/MCP approval rules. The TUI serializes simultaneous main/child approval requests in FIFO order and labels child prompts with their exact profile and short Agent identity.

## Lifecycle and tools

Each hosted session instance owns a `KanaSubagentClient`. `agent.subagents.max_live` limits its concurrently running children; terminal records do not count. The main Agent receives three parallel-safe control tools:

| Tool | Behavior |
| --- | --- |
| `spawn_subagent(profile, task)` | Validates the named profile, starts one child, and immediately returns an `agentId`. |
| `wait_subagent(agentId, timeoutMs?)` | Returns current or terminal state and output; waits at most 30 seconds per call and never cancels on timeout. |
| `cancel_subagent(agentId, reason?)` | Aborts an owned live child and waits for settlement. |

Live child identity, profile, and state are projected into the parent runtime context, but task text and output are not. Child failures become an `errored` result rather than failing the parent automatically. Aborting the parent turn cancels children spawned by that turn. Session replacement, deletion, and shutdown cancel all children owned by the disposed session instance and wait for them to settle.

## Persistence, TUI, and accounting

In normal mode every child has an independent internal journal:

```text
<KANA_HOME>/sessions/<encoded-workspace>/.subagents/<parent-session-id>/<child-id>.jsonl
```

It uses the session turn record format but includes the parent ID, spawning tool-call ID, and complete profile snapshot in its header. These files are not ordinary resumable sessions and never appear in `/resume`. Startup inspection reports an open child turn as `interrupted` without repairing or resuming it. Forking a parent does not copy children. Deleting the parent removes its complete child-journal directory.

`/agents` is available while the main Agent runs. It shows valid profiles and current-session live or archived runs; arrows select, `Enter` opens the transcript, `K` cancels a live child, `R` reloads, and `Esc` closes. Invalid profile diagnostics appear in the panel.

Child runs are recorded under the `subagent` accounting kind and displayed separately from main and memory runs. Their usage contributes once to aggregate and per-model totals; it is not copied into the parent run's usage. Clean mode exposes only built-in profiles, keeps child state in memory, and writes neither child journals nor accounting records.
