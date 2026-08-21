## [0.5.0](https://github.com/longyijdos/kana/compare/v0.4.0...v0.5.0) (2026-08-21)

Kana v0.5.0 adds custom OpenAI-compatible providers, image prompts for DeepSeek V4 Flash Vision, and terminal-native Mermaid and LaTeX rendering.

### Features

- Connect any OpenAI-compatible endpoint with static custom model definitions over HTTP or HTTPS, including streamed thinking events and unified TUI working state for compatible models.
- Attach images to DeepSeek V4 Flash Vision Exp prompts, gated by model metadata and the `image_input` option so text-only V4 models stay unchanged.
- Render Mermaid diagrams and LaTeX formulas directly in the terminal transcript.
- Align editor shortcuts with readline for consistent text navigation.
- Remove per-request cost estimates from `/usage`; token usage summaries remain.

### Bug Fixes

- Detect the Ghostty notification backend instead of silently falling back to a generic terminal notification.
- Dismiss the usage-scope prompt when the selection fails, and align `/usage` summary columns.
- Reject duplicate pending message identities and serialize inbox claims during shutdown.
- Pin the Bun toolchain version so local tooling, CI, and release builds stay aligned.

## [0.4.0](https://github.com/longyijdos/kana/compare/v0.3.0...v0.4.0) (2026-08-13)

Kana v0.4.0 adds image prompts for OpenAI Codex, hosted web search for DeepSeek V4, and clearer TUI feedback for large inputs and tool execution.

### Features

- Attach up to 10 images to OpenAI Codex prompts from the macOS clipboard or local paths, with safe normalization, session persistence, and context compaction.
- Run DeepSeek V4 Flash and Pro through the Responses API with hosted web search and low, high, or max reasoning effort.
- Collapse long pasted input into a compact editor item while preserving the complete text for submission and history.
- Group streamed tool-call preparation into one progress block, then show running, completed, canceled, and failed states at their actual lifecycle boundaries.
- Expand `/help` with the current editor, image, cancellation, tool-output, and local-shell shortcuts.

### Bug Fixes

- Keep Codex tools and image inputs on the compatible classic Responses contract and surface provider stream error details.
- Distinguish non-zero Bash exits from execution failures, and stop tool or hosted-search timers cleanly after cancellation.
- Estimate context usage from replayable conversation state and preserve image-bearing history safely during compaction.
- Keep prompt placeholders inside the editor frame and preserve one thinking timer across adjacent reasoning items.
- Stop background memory consolidation cleanly during shutdown.

## [0.3.0](https://github.com/longyijdos/kana/compare/v0.2.2...v0.3.0) (2026-08-08)

Kana v0.3.0 adds queued input and scheduled-message management, Codex hosted web search, and clickable terminal hyperlinks.

### Features

- Add OpenAI Codex hosted web search with visible provider activity rendering.
- Add `/schedule` to view, create, refresh, and delete in-process scheduled messages.
- Queue input during Agent runs and deliver queued submissions and due wakes in FIFO order.
- Render safe Markdown links as terminal hyperlinks when supported, with readable fallbacks.

### Bug Fixes

- Fix queued-input delivery and duplicate display after deferred steering.

## [0.2.2](https://github.com/longyijdos/kana/compare/v0.2.1...v0.2.2) (2026-08-05)

Kana v0.2.2 makes `kana update` more reliable by streaming asset downloads to disk instead of buffering them in memory.

### Bug Fixes

- Stream self-update downloads to disk so large releases no longer stall on slow or proxied responses.

## [0.2.1](https://github.com/longyijdos/kana/compare/v0.2.0...v0.2.1) (2026-08-04)

Kana v0.2.1 sharpens session control and reliability with a new clean launch mode, per-session approval overrides, and smarter context handling.

### Features

- Add `--clean` for temporary sessions that do not write session files or use memory.
- Add `/approval` to override tool approval behavior for the current session without changing persisted configuration.
- Gate parallel tool calls by model capability and cap tool output against the remaining context budget.
- Show reasoning effort in the TUI status line and remove unsupported Codex `ultra` effort.
- Add a Harbor evaluation adapter with proxy support.

### Bug Fixes

- Prevent clean-mode sessions from being forked or persisted.
- Render buffered TUI text before tool results.
- Raise the Bash timeout ceiling for longer-running commands.

## [0.2.0](https://github.com/longyijdos/kana/compare/v0.1.3...v0.2.0) (2026-07-31)

Kana v0.2.0 adds a second model provider, a complete MCP stack, and a shared runtime for interactive and automated work.

### Features

- Add OpenAI Codex OAuth authentication, live provider/model switching, and configurable reasoning effort.
- Add MCP stdio and Streamable HTTP transports, OAuth 2.0/PKCE, per-server proxies, runtime activation, and TUI management.
- Add `kana exec` with resumable sessions and a versioned JSONL protocol for automation.
- Add automatic and manual context compaction with durable checkpoints.
- Add incremental V3 session journals, interruption recovery, parallel tool execution, deadlines, and cancellation.
- Add built-in self-update support for subsequent binary releases.

### Breaking Changes

- Kana reads V3 sessions only. Existing V1/V2 files remain on disk but no longer appear or load.
- `kana install --skills` is replaced by `kana skills install`.
- `kana install --force` is replaced by `kana reset`; use `kana skills reinstall` when only bundled Skills need restoration.
- `/memory show` and `/memory compact` are replaced by the interactive `/memory` flow.

### Upgrade

Kana v0.1.3 does not include the self-updater. Upgrade once with the installer; later releases can use `kana update`:

```bash
curl -fsSL https://raw.githubusercontent.com/longyijdos/kana/main/scripts/install.sh | bash
```

## [0.1.3](https://github.com/longyijdos/kana/compare/v0.1.2...v0.1.3) (2026-06-24)

### Features

- Add persistent usage accounting and detailed usage summaries.
- Add in-memory scheduled agent wakes.

### Bug Fixes

- Isolate memory consolidation runs by session.

## [0.1.2](https://github.com/longyijdos/kana/compare/v0.1.1...v0.1.2) (2026-06-22)

### Features

- Improve tool output rendering, paging, and elapsed-time feedback.
- Add structured session runtime logging.

### Bug Fixes

- Harden TUI rendering for canceled, truncated, and syntax-highlighted tool output.

## [0.1.1](https://github.com/longyijdos/kana/compare/v0.1.0...v0.1.1) (2026-06-20)

### Features

- Add durable global and project memory with background consolidation.
- Add context usage and session cost reporting.
- Add the tool result viewer and terminal notifications.

## [0.1.0](https://github.com/longyijdos/kana/commits/v0.1.0) (2026-06-16)

Initial release with the DeepSeek provider, terminal UI, persistent sessions, Skills, tool approvals, workspace tools, and multi-platform binary publishing.
