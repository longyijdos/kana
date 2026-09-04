# Terminal rendering

Kana renders its interface directly on the terminal's main screen. This document covers terminal control, component layout, differential repainting, visible-width handling, Markdown, diagrams, and tool presentation. Application commands, focus transitions, and event projection are documented in [TUI interaction](tui.md).

## Rendering stack

```text
ProcessTerminal
  raw input, resize events, capabilities, stdout
    → Tui
      component render(width, availableHeight?)
      cursor extraction and line normalization
      differential ANSI repaint
        → AppLayout
          transcript
          one focused bottom component
```

`ProcessTerminal` owns the operating-system terminal boundary. `Tui` owns render scheduling, frame state, cursor placement, and output. Components return declarative lines and never write content directly to stdout.

## Components and layout

The minimum `Component` contract is `render(width, availableHeight?): string[]`, with optional input and invalidation hooks. Components may adapt to the height hint, but the protocol does not clip their output.

`AppLayout` reserves exactly one bottom region and gives the remainder to the transcript. Its total bottom budget is 15 rows at terminal heights of 30 or more, 12 at 24–29, 9 at 18–23, and 7 at 7–17; shorter terminals give all rows to bottom. The first reserved row is the divider. Shorter bottom output is padded so switching editors, prompts, pickers, and viewers does not move the transcript boundary.

The transcript intentionally renders complete history so natural terminal scrolling retains it. Compact blocks bound their own height; long detail is opened in the bottom viewer instead of expanding the main history indefinitely.

## Terminal lifecycle

`ProcessTerminal.start()` requires TTY stdin and stdout. It enables raw mode, bracketed paste, enhanced keyboard reporting when supported, and a hidden cursor, then registers input and resize handling. Enhanced reporting allows terminals to distinguish inputs such as `Shift+Enter` from `Enter`.

Raw stdin chunks pass through a stateful framing buffer before `Tui` sees them. The buffer dispatches batched keys separately, reassembles fragmented CSI, SS3, OSC, DCS, and APC sequences, and delivers each bracketed paste as one complete event. Incomplete sequences wait briefly for their suffix; a lone `Esc` uses a longer reassembly window under SSH.

Shutdown restores the prior raw state, pauses stdin, shows the cursor, pops enhanced keyboard reporting, disables bracketed paste, and clears Kana's visible frame and scrollback before exit information is printed. Application cleanup completes before this terminal restoration begins. A forced second interrupt also restores terminal state before default signal handling takes over.

Kana never enters the `?1049` alternate screen. The main-screen choice is what makes completed transcript content remain in the terminal's scrollback.

## Render scheduling and repaint

Application and controller code call `Tui.requestRender()`. Normal requests are coalesced into an approximately 16 ms frame. On each frame, the runtime:

1. Renders the root component with current dimensions.
2. Extracts the editor's internal cursor marker.
3. Normalizes lines by ANSI-aware visible width.
4. Updates only the hardware cursor when logical content is unchanged.
5. Otherwise repaints the smallest visible first-to-last changed range, appending through natural scrolling and clearing stale visible tail rows with `CSI 2K`.

A full clear and replay is required for the first frame, dimension changes, changed content already in scrollback, deletion that moves the new tail above the addressable viewport, or cursor state that cannot be inferred safely. `/clear` uses the same rules: it patches locally when removed rows remain addressable and falls back to replay after scrollback is affected.

The renderer caches normalized lines and viewport state. Synchronized output wraps a repaint when available. A focused component receives the visible hardware cursor; without focus, the cursor remains hidden at the layout tail.

## Text width and terminal safety

Rendering helpers strip ANSI and terminal control sequences before measurement, then use `string-width` and `Intl.Segmenter` to wrap and truncate by grapheme. CJK text, emoji, combining marks, and ANSI color therefore consume their terminal columns without splitting user-perceived characters.

Untrusted tool and provider text is sanitized before display. Width-sensitive code must work in visible cells rather than JavaScript string length, and ANSI styles must be closed at line boundaries so repainting cannot leak presentation into later rows.

## Markdown

The TUI resolves `[tui].theme` before constructing the application and keeps its semantic palette fixed until exit. The welcome logo's green pixels remain fixed Kana branding; its surrounding panel uses the active theme.

Assistant messages and the memory viewer share the lightweight Markdown renderer. It supports headings, lists, quotes, fenced code, selected inline styles, tables, link and image text, and limited HTML normalization. Paired and void HTML tags are removed; unmatched programming text such as `vector<int>` remains literal.

When enabled and confirmed by terminal capabilities, safe `http:`, `https:`, and `mailto:` links use OSC 8. Each wrapped row closes and reopens its link. Disabled or unknown support and unsafe targets use the readable `label (url)` fallback; an incomplete streaming link stays as literal Markdown.

Tables accept optional outer pipes, empty cells, escaped pipes, and alignment. Column widths use visible cells; narrow terminals fall back to vertical key/value records. During streaming, complete rows determine widths while the growing tail is previewed separately, then folded into the final table when the message completes.

The active TUI theme selects the bundled Shiki syntax theme before background preload starts. Fenced code remains plain text until the highlighter is ready.

## LaTeX and Mermaid

With `tui.render_latex = true`, inline and display delimiters render a deliberately limited set of symbols, scripts, fractions, roots, operators, matrices, cases, and display limits into Unicode cell layouts. Unsupported, malformed, disabled, or unfinished expressions retain their complete source. Code spans and fences never interpret math delimiters.

With `tui.render_mermaid = true`, `mermaid` fences can render themed Unicode diagrams while streaming. The supported subset covers flowcharts, state diagrams, class diagrams, entity-relationship diagrams, and sequence diagrams. Unsupported syntax, fatal parse errors, renderer failure, or output wider than the available Markdown width falls back to the source fence. A partial streaming parse may render provisionally; unrepresented source at completion restores the fence and adds a bounded warning.

## Tool blocks and detail

Tool blocks use schema-owned renderers for built-in tools and a generic representation for unknown, Custom, and MCP tools. Compact history is deliberately bounded:

| Content | Compact budget |
| --- | --- |
| Identity | One title row |
| Built-in target | One flattened, horizontally truncated row |
| Bash | Last 8 source rows |
| Write | Up to 7 preview rows, including the byte-count result |
| Edit | Up to 3 removed and 3 inserted rows, including omission markers |
| Unknown, Custom, or MCP | First 8 rows of pretty JSON |

Only built-ins with a Kana-owned parameter schema promote fields into a target row. Omitted rows receive an explicit count, and over-wide preview rows are truncated rather than wrapped. These limits affect presentation only; canonical arguments, results, and approval details remain complete.

The detail inspector can open every tool call, regardless of compact expandability. It uses full renderers, soft-wraps long lines, includes effective execution metadata, and supports moving between calls without changing transcript history. Control sequences remain sanitized in both compact and detailed forms.

## Change checklist

- Route component changes through `requestRender()`; direct stdout content invalidates frame and cursor state.
- Define bottom-height behavior and focus-visible cursor placement for every new component.
- Use visible width and graphemes for wrapping, truncation, tables, cursor columns, and diagrams.
- Sanitize partial and final external output before rendering.
- Exercise repaint, shrink, scrollback, resize, cursor, ANSI, CJK, emoji, and IME cases when terminal mechanics change.
- Keep configuration fields in [Configuration and installation](configuration.md) and user interaction in [TUI interaction](tui.md).
