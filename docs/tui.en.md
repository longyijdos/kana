# TUI interaction and rendering

Kana uses a custom main-screen TUI rather than an alternate screen. `ProcessTerminal` owns raw terminal I/O, `Tui` owns components, focus, and ANSI repainting, and `KanaTuiApp` connects Agents, sessions, and product controllers to the interface.

## Runtime structure

```text
ProcessTerminal
  raw stdin, resize, terminal notifications, stdout
    → Tui
      input listeners → focused component
      render(width) → differential ANSI repaint
        → AppLayout
          transcript / content viewer
          inline tool approval
          editor
          session or skills overlay
          status line
```

The minimum `Component` interface is `render(width): string[]`, with optional `handleInput` and `invalidate`. `Container` joins child lines in order. `AppLayout` fixes the order: main content, inline prompt, editor, overlay, status line. Controllers change layout and focus; components mostly own presentation and local keyboard input.

## Terminal lifecycle and rendering

`ProcessTerminal.start()` requires TTY stdin/stdout, enables raw mode, bracketed paste, and a hidden cursor, then registers input and resize. Stopping restores the prior raw state, pauses stdin, shows the cursor, and disables bracketed paste. TUI shutdown clears the screen and scrollback, then prints exit information including accumulated tokens, API cost, and a resume command when available.

Normal `Tui.requestRender()` calls are coalesced into an approximately 16ms timer. Each render:

1. Calls the root component's `render(width)`.
2. Extracts the editor's internal cursor marker.
3. Normalizes lines using ANSI and Unicode visible width.
4. Repaints only changed lines when dimensions are stable and changes remain visible.
5. Falls back to a full clear-and-repaint on width/height changes, shrinking output, changes above the viewport, or a forced refresh.
6. Moves and shows the hardware cursor last while synchronized output is active.

It caches rendered lines and viewport state, avoiding repeated CJK width computation for unchanged transcript content. The TUI uses the main screen, never `?1049` alternate screen, so the transcript remains in terminal scrollback.

Rendering helpers strip ANSI/control sequences for width calculation and use `string-width` plus `Intl.Segmenter` to wrap and truncate by grapheme. CJK, emoji, combining characters, and color therefore do not consume incorrect columns. Tool output is stripped of unsafe terminal controls before display.

## App and Agent events

`KanaTuiApp` owns the active Agent, session ID, running flag, accumulated model usage, and cost. On prompt submission it adds user text to the transcript, consumes `AgentEventStream`, and delegates visible mapping to `AgentEventRenderer`. A due `schedule_wake` event is shown as `Scheduled wake: …` rather than typed user input; a running Agent queues it until the current turn completes. Its successful result is a compact tool block that shows the delay and reminder text:

| Agent event | TUI behavior |
| --- | --- |
| `message_start` / `message_update` / `message_end` | Create, update, and complete assistant Markdown blocks; thinking shows its current elapsed time while streamed thinking is active. Tool calls show preparing elapsed time while parsing, then freeze it when that call ends. |
| `tool_execution_start` | Create or mark a tool block running and start its running elapsed time at zero. |
| `tool_execution_update` | Update partial output for bash and similar tools. |
| `tool_execution_end` | Store structured results and mark success/failure. |
| `agent_end` | Update status phase and clear the active tool. |

The status line shows provider/model, context percentage from the latest assistant message, run phase, active tool, and cwd. Each completed assistant usage accumulates into process totals and CNY cost using model metadata.

## Input and shortcuts

Global input runs before the focused component:

| Input | Behavior |
| --- | --- |
| `Ctrl+C` | Cancel local shell, memory compaction, or Agent while running; exit while idle. |
| `Esc` | Close the content viewer first; cancel active work when running. |
| `Ctrl+O` | Open/close the newest expandable tool output. |
| `!<command>` | Run local bash directly without Agent or approval, displayed in the same tool block style. |

The editor supports multiline input, five visible lines, history capped at 100 entries, arrow navigation, Home/End/Delete, bracketed paste, and slash completion. Editing, movement, and deletion work on grapheme boundaries. Up/down move inside soft/explicit lines first, then enter history at the boundary. A leading `/` opens the command palette; it shows up to 10 commands, scrolls with the selection, and stops at either boundary; unknown slash input is sent as a normal model message.

| Slash command | Behavior |
| --- | --- |
| `/help` | Print commands and shortcuts. |
| `/clear` | Clear transcript and editor without deleting the session. |
| `/new` | Create an empty session and rebuild the Agent. |
| `/fork <prompt>` | Create a fork from current Agent history, then send the prompt. |
| `/resume [id]` | Resume a session or open the picker. |
| `/delete` | Select and confirm session deletion. |
| `/skills` | Manage global Skill activation and rebuild the Agent system prompt. |
| `/memory …` | View or compact memory; see [Sessions and memory](sessions-and-memory.en.md). |
| `/quit` | Exit without arguments; with arguments it is a normal prompt. |

## Controllers and focus

Separate controllers keep `KanaTuiApp` from owning every interaction state machine:

- `ToolApprovalController` implements the Agent `beforeToolExecution` hook. It shows an inline choice prompt; denial aborts the run, while always allow adds only an exact bash command to the allowlist.
- `SessionOverlayController` manages the resume list and delete confirmation. New, resumed, and deleted sessions update transcript and focus.
- `SkillManagerController` changes only the global Skill list. On save it aborts the prior Agent and constructs a new one with the same history, refreshing its prompt.
- `ContentViewerController` replaces transcript with scrollable main content and restores a waiting approval prompt's focus first when closed.
- `LocalShellController` reuses bash Tool presentation but never requests approval.
- `MemoryCompactController` runs cancellable full memory consolidation and writes a summary into transcript.

While running, slash commands other than `/quit` are ignored to prevent re-entry. Opening overlays or viewers changes focus; closing normally returns it to the editor.

## Notifications and Markdown

The configured notification backend selects output. `auto` probes Kitty, iTerm, then VTE, then uses bell; explicit `off` emits nothing. Notification text removes control characters and collapses whitespace; OSC 777 additionally replaces semicolons. Normal Agent completion and approval-required notifications are separately configurable.

Assistant messages and the memory viewer use lightweight Markdown rendering: headings, lists, quotes, fenced code, some inline styles, table rows, link/image text, and limited HTML normalization. Shiki highlighting preloads in the background; code is plain text until it is ready. Tool blocks display highlighted write/edit diffs and tail bash output; long output opens in the scrollable viewer.

## Rendering-change constraints

- Do not write component content directly to stdout; use `Tui.requestRender` so differential rendering maintains cache and cursor state.
- A new overlay must explicitly define focus restoration on open and close.
- New tool views must sanitize control sequences and handle partial as well as final results.
- Width logic must use visible width and graphemes, never direct `string.length`.
- Changes to main-screen repainting or terminal sequences require updates to render, cursor, and width tests to avoid breaking scrollback or IME cursor placement.
