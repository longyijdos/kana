# TUI interaction and rendering

Kana uses a custom main-screen TUI rather than an alternate screen. `ProcessTerminal` owns raw terminal I/O, `Tui` owns components, focus, and ANSI repainting, and `KanaTuiApp` connects Agents, sessions, and product controllers to the interface.

## Runtime structure

```text
ProcessTerminal
  raw stdin, resize, terminal notifications, stdout
    → Tui
      input listeners → focused component
      render(width, availableHeight?) → differential ANSI repaint
        → AppLayout
          main (currently transcript)
          exactly one bottom component (height tier)
            editor with status line
            or tool approval
            or session / skills / MCP / slash-command prompt
            or content viewer
```

The minimum `Component` interface is `render(width, availableHeight?): string[]`, with optional `handleInput` and `invalidate`. The protocol does not clip output, but components may use the height to select a rendering strategy. `AppLayout` reserves a tiered region for exactly one bottom component: 15 rows at terminal heights of 30 or more, 12 at 24-29, 9 at 18-23, and 7 at 7-17; terminals shorter than 7 rows assign all available rows to bottom. It passes the remainder to main. The layout owns the first bottom row as the main/bottom divider and passes the remaining height to the bottom component; every bottom component starts directly after the divider. The layout pads shorter component output with blank rows so switching bottom components does not move main content. List views shrink their item window while keeping the selection visible, the editor reduces its input and command windows, and long choice-prompt details use `PageUp`/`PageDown` paging. Neutral bottom titles use `bottomTitle` and current selections use `user`; tool approvals and destructive confirmations override the title with `toolActive` and `error`, respectively. `KanaTuiApp` currently supplies the transcript as main; Transcript intentionally renders its complete history for terminal scrollback. Components mostly own presentation and local keyboard input.

## Terminal lifecycle and rendering

`ProcessTerminal.start()` requires TTY stdin/stdout, enables raw mode, bracketed paste, enhanced keyboard reporting, and a hidden cursor, then registers input and resize. Enhanced keyboard reporting lets supporting terminals distinguish `Shift+Enter` from `Enter`. After the current session is visible, the external-tool loader appends a status block to the transcript and removes editor focus. The block follows MCP manager progress and remains as a final server/tool-count summary; the Agent is then rebuilt with discovered tools and the editor is restored. When an OAuth server needs browser authorization, a separate transcript block temporarily contains the authorization URL and is replaced in place by the final success or failure state, so a credential-bearing URL is not retained. Optional-server failures leave error-colored warnings after the summary, while a required-server failure during initial loading displays an error and keeps input disabled. The `kana resume` session picker sits before this loading boundary, so browsing or leaving the list never starts MCP. Applying a changed `/mcp` draft follows the same transcript-progress pattern, but a reload failure rebuilds the Agent without stale MCP tools and restores the editor so the user can retry. `KanaTuiApp.stop()` is an idempotent asynchronous boundary: it appends shutdown status to the transcript, removes focus from the bottom component, aborts and awaits the active Agent, then lets product cleanup close the MCP manager. Transport-neutral manager progress events update the same transcript block without replacing bottom. Only after cleanup does Kana stop the terminal, restore raw state, pause stdin, show the cursor, pop enhanced keyboard reporting, disable bracketed paste, clear the screen and scrollback, and print accumulated tokens, API cost, and a resume command when available. Idle exit and `SIGHUP`, `SIGINT`, and `SIGTERM` all use this path. A second raw-mode `Ctrl+C` during graceful shutdown restores the terminal first and then sends the process its default `SIGINT`. The first process signal likewise removes Kana's listeners so a second signal retains its default force-termination behavior.

Normal `Tui.requestRender()` calls are coalesced into an approximately 16ms timer. Each render:

1. Calls the root component's `render(width, height)`.
2. Extracts the editor's internal cursor marker.
3. Normalizes lines using ANSI and Unicode visible width.
4. Repaints only changed lines when dimensions are stable and changes remain visible.
5. Falls back to a full clear-and-repaint on width/height changes, shrinking output, changes above the viewport, or a forced refresh.
6. Moves and shows the hardware cursor only for the focused component while synchronized output is active; with no focus it leaves the cursor at the layout tail and hidden.

It caches rendered lines and viewport state, avoiding repeated CJK width computation for unchanged transcript content. The TUI uses the main screen, never `?1049` alternate screen, so the transcript remains in terminal scrollback.

Rendering helpers strip ANSI/control sequences for width calculation and use `string-width` plus `Intl.Segmenter` to wrap and truncate by grapheme. CJK, emoji, combining characters, and color therefore do not consume incorrect columns. Tool output is stripped of unsafe terminal controls before display.

## App and Agent events

`KanaTuiApp` owns the active Agent, session ID, running flag, accumulated model usage, and cost. On prompt submission it adds user text to the transcript, consumes `AgentEventStream`, and delegates visible mapping to `AgentEventRenderer`. Transcript inserts one plain blank row between every two blocks that render output, while each block owns only its internal spacing. Typed user messages use an ASCII frame, light-gray text, and a blue `> ` prefix. Explicit and soft-wrapped continuation lines align with the text. A due `schedule_wake` event is shown as `Scheduled wake: …` rather than typed user input; a running Agent, local shell, memory compaction, open MCP manager, or MCP reload queues it until that state ends. Its successful result is a compact tool block that shows the delay and reminder text:

| Agent event | TUI behavior |
| --- | --- |
| `message_start` / `message_update` / `message_end` | Create, update, and complete assistant Markdown blocks; thinking shows its current elapsed time while streamed thinking is active. Tool calls show preparing elapsed time while parsing, then freeze it when that call ends. |
| `tool_execution_start` | Create or mark a tool block running and start its running elapsed time at zero. |
| `tool_execution_update` | Update partial output for bash and similar tools. |
| `tool_execution_end` | Store structured results and mark success/failure. |
| `agent_end` | Update status phase and clear the active tool. |

The editor owns the status line, which shows provider/model, context percentage from the latest assistant message, run phase, active tool, and cwd. The status line is hidden while the slash-command palette is open. Replacing the editor with another bottom component hides both editor input and status. Each completed assistant usage accumulates into process totals and CNY cost using model metadata.

## Input and shortcuts

Global input runs before the focused component:

| Input | Behavior |
| --- | --- |
| `Ctrl+C` | Cancel local shell, memory compaction, or Agent while running; begin graceful exit while idle or loading external tools; press again during shutdown to force exit. |
| `Esc` | Close the content viewer first; cancel active work when running. |
| `Ctrl+O` | Open/close the newest expandable tool output. |
| `!<command>` | Run local bash directly without Agent or approval, displayed in the same tool block style. |

The editor uses the same ASCII frame, light-gray text, and blue `> ` prefix as user message blocks, without setting an input-area background color. Its frame follows the Layout divider directly and it does not add an extra blank row below it. While empty, it randomly selects a placeholder from the `/help` slash commands and stable global shortcuts. It chooses a tip at startup and switches to a different one after each plain `Enter`, while other redraws keep the current choice stable. The command palette, placeholder, `/help`, and usage errors all read from the same command syntax and description catalog. The editor supports multiline input, five visible lines, history capped at 100 entries, arrow navigation, Home/End/Delete, bracketed paste, and slash completion. `Enter` submits the current input; in terminals that support enhanced keyboard reporting, `Shift+Enter` inserts an explicit newline. Editing, movement, and deletion work on grapheme boundaries. Up/down move inside soft/explicit lines first, then enter history at the boundary. A leading `/` opens the command palette; it shows up to 10 commands, scrolls with the selection, and stops at either boundary. Unknown slash input and a lone `!` with no shell command are sent as normal model messages.

| Slash command | Behavior |
| --- | --- |
| `/help` | Open commands and shortcuts in a read-only bottom view. |
| `/clear` | Clear transcript and editor without deleting the session. |
| `/new` | Create an empty session and rebuild the Agent. |
| `/fork <prompt>` | Create a fork from current Agent history, then send the prompt. |
| `/resume [id]` | Resume a session or open the picker. |
| `/delete` | Select and confirm session deletion. |
| `/skills` | Manage global Skill activation and rebuild the Agent system prompt. |
| `/mcp` | Manage active MCP servers and reload them when the selection changes. |
| `/memory` | Choose an action and scope in the bottom view; see [Sessions and memory](sessions-and-memory.en.md). |
| `/usage` | Choose a scope in the bottom view, then open its API usage. |
| `/quit` | Exit without arguments; with arguments it is a normal prompt. |

## Controllers and focus

Separate controllers keep `KanaTuiApp` from owning every interaction state machine:

- `ToolApprovalController` implements the Agent `beforeToolExecution` hook. Its choice prompt replaces the editor when the editor is visible. If another bottom view is active, the approval remains pending and the configured approval notification still fires; closing that view reveals the prompt. MCP tools use a product-level alias resolver to show the server ID, original remote tool name, and complete formatted arguments; long arguments reuse detail paging, and MCP approvals do not offer persistent trust. Denial aborts the run, while always allow adds only an exact bash command to the allowlist.
- `SessionOverlayController` replaces the editor with the resume list or delete confirmation. New, resumed, and deleted sessions update transcript and focus.
- `SkillManagerController` replaces the editor with the global Skill list. `Enter` edits only a local draft; `Esc` applies it. A changed draft is persisted once and rebuilds the Agent once with the same history, while an unchanged draft just closes. Persistence errors keep the view open.
- `McpServerManagerController` replaces the editor with configured MCP server checkboxes. `Enter` edits only a local draft. On a selected OAuth HTTP server, `A` opens an auth submenu for authorize, reauthorize, or sign-out; `Esc` cancels browser authorization while it is active. Authorization URLs and success, failure, or cancellation states are written to the transcript, and sign-out disables the server. Back in the list, the main `Esc` applies the draft. A selection change or credential change for an enabled server triggers exactly one full runtime reload. Persistence errors keep the view open. The component displays the server ID, transport, OAuth status, and either the full stdio command line (`command` plus `args`) or HTTP URL, but never receives environment values, HTTP headers, or tokens.
- `SlashCommandOptionsController` collects slash-command options with cancellable multi-step prompts. `/usage` offers session, project, and global scopes; `/memory` selects an action and scope, then Compact uses a separate `TextPrompt` for the optional request. Options are not passed as editor arguments, and `Esc` returns to the previous nested step.
- `ContentViewerController` replaces the bottom component with scrollable read-only content, including help, usage, memory, and tool output, while the transcript remains rendered. Closing it restores a waiting approval prompt first, otherwise the editor.
- `LocalShellController` reuses bash Tool presentation but never requests approval.
- `MemoryCompactController` runs cancellable full memory consolidation and writes a summary into transcript.

While running, slash commands other than `/quit` are ignored to prevent re-entry. Opening a bottom view changes focus; closing restores a waiting approval prompt first and otherwise returns to the editor. Bottom views do not preempt one another when an approval arrives.

## Notifications and Markdown

The configured notification backend selects output. `auto` probes Kitty, iTerm, then VTE, then uses bell; explicit `off` emits nothing. Notification text removes control characters and collapses whitespace; OSC 777 additionally replaces semicolons. Normal Agent completion and approval-required notifications are separately configurable.

Assistant messages and the memory viewer use lightweight Markdown rendering: headings, lists, quotes, fenced code, some inline styles, tables, link/image text, and limited HTML normalization. Tables are parsed as blocks with optional boundary pipes, empty cells, escaped pipes, and column alignment; widths use visible terminal columns and narrow layouts fall back to vertical key/value records. While streaming, only completed rows determine column widths, the growing tail row previews below the table with full-line width, and message completion folds it into the finalized table. Paired HTML tags and void tags are removed, while unmatched programming syntax such as `vector<int>` is preserved verbatim. Shiki highlighting preloads in the background; code is plain text until it is ready. Tool blocks display list/glob/grep/read summaries and highlighted write/edit diffs; bash blocks display stdout/stderr text directly without exit-code or field labels. Write approvals and tool blocks distinguish new-file writes from overwrites; long output opens in the scrollable viewer, whose multiline titles are collapsed and truncated to one row.

## Rendering-change constraints

- Do not write component content directly to stdout; use `Tui.requestRender` so differential rendering maintains cache and cursor state.
- A new bottom view must explicitly define focus restoration on open and close.
- New tool views must sanitize control sequences and handle partial as well as final results.
- Width logic must use visible width and graphemes, never direct `string.length`.
- Changes to main-screen repainting or terminal sequences require updates to render, cursor, and width tests to avoid breaking scrollback or IME cursor placement.
