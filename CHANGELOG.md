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
