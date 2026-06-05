import { Container, type Component } from "./component";
import { CURSOR_MARKER } from "./cursor";
import type { Terminal } from "./terminal";
import { padRightAnsi, truncateToWidth, visibleWidth } from "../render/width";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;

export class Tui extends Container {
  private focusedComponent?: Component;
  private readonly inputListeners = new Set<InputListener>();
  private renderRequested = false;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(readonly terminal: Terminal) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(true),
    );
    this.requestRender(true);
  }

  stop(): void {
    this.stopped = true;

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }

    this.terminal.stop();
  }

  setFocus(component: Component | undefined): void {
    this.focusedComponent = component;
  }

  addInputListener(listener: InputListener): () => void {
    this.inputListeners.add(listener);

    return () => {
      this.inputListeners.delete(listener);
    };
  }

  requestRender(force = false): void {
    if (this.stopped) {
      return;
    }

    if (force) {
      this.renderRequested = false;
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
      }
      queueMicrotask(() => this.renderNow());
      return;
    }

    if (this.renderRequested) {
      return;
    }

    this.renderRequested = true;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.renderRequested = false;
      this.renderNow();
    }, 16);
  }

  private handleInput(data: string): void {
    let current = data;

    for (const listener of this.inputListeners) {
      const result = listener(current);

      if (result?.consume) {
        this.requestRender();
        return;
      }

      if (result?.data !== undefined) {
        current = result.data;
      }
    }

    this.focusedComponent?.handleInput?.(current);
    this.requestRender();
  }

  private renderNow(): void {
    if (this.stopped) {
      return;
    }

    const width = Math.max(this.terminal.columns, 1);
    const height = Math.max(this.terminal.rows, 1);
    const rendered = this.render(width);
    const visibleLines = rendered.slice(-height);

    while (visibleLines.length < height) {
      visibleLines.unshift("");
    }

    const cursor = extractCursorPosition(visibleLines);
    const lines = visibleLines.map((line) => normalizeLine(line, width));
    const cursorSequence = cursor
      ? `\x1b[${cursor.row + 1};${Math.min(cursor.column, width - 1) + 1}H\x1b[?25h`
      : "\x1b[?25l";
    const buffer = `\x1b[?2026h\x1b[H${lines.join("\r\n")}\x1b[?2026l${cursorSequence}`;

    this.terminal.write(buffer);
  }
}

export function extractCursorPosition(
  lines: string[],
): { row: number; column: number } | undefined {
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    const line = lines[row];
    const markerIndex = line.indexOf(CURSOR_MARKER);

    if (markerIndex < 0) {
      continue;
    }

    const beforeMarker = line.slice(0, markerIndex);
    lines[row] =
      line.slice(0, markerIndex) +
      line.slice(markerIndex + CURSOR_MARKER.length);

    return {
      row,
      column: visibleWidth(beforeMarker),
    };
  }

  return undefined;
}

function normalizeLine(line: string, width: number): string {
  const truncated =
    visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;

  return `${padRightAnsi(truncated, width)}\x1b[0m`;
}
