export interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
}

export class ProcessTerminal implements Terminal {
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;
  private wasRaw = false;
  private stopped = true;

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
    process.stdin.on("data", this.handleInput);
    process.stdout.on("resize", this.handleResize);

    this.write("\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H");
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;
    process.stdin.off("data", this.handleInput);
    process.stdout.off("resize", this.handleResize);
    process.stdin.setRawMode(this.wasRaw);
    process.stdin.pause();

    this.write("\x1b[?25h\x1b[?2004l\x1b[?1049l");
    this.inputHandler = undefined;
    this.resizeHandler = undefined;
  }

  write(data: string): void {
    process.stdout.write(data);
  }

  get columns(): number {
    return process.stdout.columns || Number(process.env.COLUMNS) || 80;
  }

  get rows(): number {
    return process.stdout.rows || Number(process.env.LINES) || 24;
  }

  private readonly handleInput = (data: string): void => {
    this.inputHandler?.(data);
  };

  private readonly handleResize = (): void => {
    this.resizeHandler?.();
  };
}
