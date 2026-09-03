import type { KanaNotificationConfig } from "@/kana";

import {
  encodeTerminalNotification,
  resolveNotificationBackend,
  type TerminalNotification,
} from "./notifications";
import { StdinBuffer } from "./stdin-buffer";
import { supportsTerminalHyperlinks } from "./terminal-capabilities";

// Matches crossterm's DISAMBIGUATE_ESCAPE_CODES | REPORT_EVENT_TYPES |
// REPORT_ALTERNATE_KEYS so terminals can report Shift+Enter separately.
const ENABLE_KEYBOARD_ENHANCEMENT = "\x1b[>7u";
const POP_KEYBOARD_ENHANCEMENT = "\x1b[<1u";
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const SSH_ESCAPE_TIMEOUT_MS = 100;

export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY
    ? SSH_ESCAPE_TIMEOUT_MS
    : DEFAULT_ESCAPE_TIMEOUT_MS;
}

export interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  notify(notification: TerminalNotification): void;
  readonly supportsHyperlinks?: boolean;
  readonly columns: number;
  readonly rows: number;
}

export class ProcessTerminal implements Terminal {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private wasRaw = false;
  private stopped = true;
  private notificationId = 0;
  private stdinBuffer?: StdinBuffer;
  private readonly escapeTimeoutMs: number;
  private readonly notificationBackend: ReturnType<typeof resolveNotificationBackend>;
  readonly supportsHyperlinks: boolean;

  constructor(
    notificationConfig: Pick<KanaNotificationConfig, "backend"> = { backend: "auto" },
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.escapeTimeoutMs = resolveEscapeTimeoutMs(env);
    this.notificationBackend = resolveNotificationBackend(notificationConfig.backend, env);
    this.supportsHyperlinks = supportsTerminalHyperlinks(env);
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Kana TUI requires an interactive terminal.");
    }

    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.wasRaw = process.stdin.isRaw;
    this.stopped = false;

    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    this.stdinBuffer = new StdinBuffer((data) => this.inputHandler?.(data), {
      escapeTimeoutMs: this.escapeTimeoutMs,
    });
    process.stdin.on("data", this.handleInput);
    process.stdout.on("resize", this.handleResize);

    this.write(`\x1b[?2004h${ENABLE_KEYBOARD_ENHANCEMENT}\x1b[?25l`);
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    process.stdin.off("data", this.handleInput);
    process.stdout.off("resize", this.handleResize);
    this.stdinBuffer?.destroy();
    this.stdinBuffer = undefined;
    process.stdin.setRawMode(this.wasRaw);
    process.stdin.pause();

    this.write(`\x1b[?25h${POP_KEYBOARD_ENHANCEMENT}\x1b[?2004l`);
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  notify(notification: TerminalNotification): void {
    const output = encodeTerminalNotification(
      notification,
      this.notificationBackend,
      ++this.notificationId,
    );

    if (output !== undefined) {
      this.write(output);
    }
  }

  get columns(): number {
    return process.stdout.columns || Number(process.env.COLUMNS) || 80;
  }

  get rows(): number {
    return process.stdout.rows || Number(process.env.LINES) || 24;
  }

  private readonly handleInput = (data: string): void => {
    this.stdinBuffer?.process(data);
  };

  private readonly handleResize = (): void => {
    this.resizeHandler?.();
  };
}
