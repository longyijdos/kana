import { Container, type Component } from "./component";
import { CURSOR_MARKER } from "./cursor";
import type { Terminal } from "./terminal";
import { truncateToWidth, visibleWidth } from "../render/width";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
const GOODBYE_MESSAGE = "Goodbye from Kana.";

export class Tui extends Container {
  private focusedComponent?: Component;
  private readonly inputListeners = new Set<InputListener>();
  // Main-screen rendering can only move within the visible terminal viewport.
  // These rows are logical positions in the rendered line buffer.
  private previousLines: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;
  private previousViewportTop = 0;
  private hardwareCursorRow = 0;
  private forceFullRender = false;
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
    this.terminal.write(`\x1b[2J\x1b[H\x1b[3J${GOODBYE_MESSAGE}\r\n`);
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
      this.forceFullRender = true;
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
    const cursor = extractCursorPosition(rendered);
    const lines = rendered.map((line) => normalizeLine(line, width));
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
    const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
    const forceFullRender = this.forceFullRender;

    this.forceFullRender = false;

    if (this.previousLines.length === 0) {
      this.fullRender(lines, cursor, width, height, forceFullRender);
      return;
    }

    if (forceFullRender || widthChanged || heightChanged) {
      this.fullRender(lines, cursor, width, height, true);
      return;
    }

    const changed = findChangedRange(this.previousLines, lines);

    if (!changed) {
      this.positionHardwareCursor(cursor, width, height);
      this.previousWidth = width;
      this.previousHeight = height;
      return;
    }

    if (lines.length < this.previousLines.length) {
      this.fullRender(lines, cursor, width, height, true);
      return;
    }

    if (changed.first < this.previousViewportTop) {
      // The changed line has already scrolled out of the visible working area.
      // Redraw the current screen instead of corrupting terminal scrollback.
      this.fullRender(lines, cursor, width, height, true);
      return;
    }

    this.renderChangedLines(lines, changed.first, cursor, width, height);
  }

  private fullRender(
    lines: string[],
    cursor: { row: number; column: number } | undefined,
    width: number,
    height: number,
    clear: boolean,
  ): void {
    const viewportTop = viewportTopFor(lines.length, height);
    let buffer = "\x1b[?2026h";

    if (clear) {
      buffer += "\x1b[2J\x1b[H\x1b[3J";
    }

    buffer += lines.join("\r\n");
    buffer += "\x1b[?2026l";

    this.terminal.write(buffer);
    this.hardwareCursorRow = Math.max(0, lines.length - 1);
    this.previousViewportTop = viewportTop;
    this.previousLines = lines;
    this.previousWidth = width;
    this.previousHeight = height;
    this.positionHardwareCursor(cursor, width, height);
  }

  private renderChangedLines(
    lines: string[],
    firstChanged: number,
    cursor: { row: number; column: number } | undefined,
    width: number,
    height: number,
  ): void {
    const previousViewportBottom = this.previousViewportTop + height - 1;
    const appendOnly =
      lines.length > this.previousLines.length &&
      firstChanged === this.previousLines.length &&
      firstChanged > 0;
    const moveTarget = appendOnly ? firstChanged - 1 : firstChanged;

    if (moveTarget < this.previousViewportTop || moveTarget > previousViewportBottom) {
      this.fullRender(lines, cursor, width, height, true);
      return;
    }

    let buffer = "\x1b[?2026h";
    const rowDelta = moveTarget - this.hardwareCursorRow;

    if (rowDelta > 0) {
      buffer += `\x1b[${rowDelta}B`;
    } else if (rowDelta < 0) {
      buffer += `\x1b[${-rowDelta}A`;
    }

    buffer += appendOnly ? "\r\n" : "\r";

    for (let index = firstChanged; index < lines.length; index += 1) {
      if (index > firstChanged) {
        buffer += "\r\n";
      }

      buffer += `\x1b[2K${lines[index]}`;
    }

    buffer += "\x1b[?2026l";
    this.terminal.write(buffer);

    this.hardwareCursorRow = Math.max(0, lines.length - 1);
    this.previousViewportTop = viewportTopFor(lines.length, height);
    this.previousLines = lines;
    this.previousWidth = width;
    this.previousHeight = height;
    this.positionHardwareCursor(cursor, width, height);
  }

  private positionHardwareCursor(
    cursor: { row: number; column: number } | undefined,
    width: number,
    height: number,
  ): void {
    if (!cursor) {
      this.terminal.write("\x1b[?25l");
      return;
    }

    const viewportBottom = this.previousViewportTop + height - 1;

    if (cursor.row < this.previousViewportTop || cursor.row > viewportBottom) {
      this.terminal.write("\x1b[?25l");
      return;
    }

    const rowDelta = cursor.row - this.hardwareCursorRow;
    let buffer = "";

    if (rowDelta > 0) {
      buffer += `\x1b[${rowDelta}B`;
    } else if (rowDelta < 0) {
      buffer += `\x1b[${-rowDelta}A`;
    }

    buffer += `\x1b[${Math.min(cursor.column, width - 1) + 1}G\x1b[?25h`;
    this.terminal.write(buffer);
    this.hardwareCursorRow = cursor.row;
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

  return `${truncated}\x1b[0m`;
}

function findChangedRange(
  previousLines: string[],
  lines: string[],
): { first: number } | undefined {
  const maxLines = Math.max(previousLines.length, lines.length);
  let first = -1;

  for (let index = 0; index < maxLines; index += 1) {
    const previous = previousLines[index] ?? "";
    const next = lines[index] ?? "";

    if (previous !== next) {
      if (first === -1) {
        first = index;
      }
    }
  }

  return first === -1 ? undefined : { first };
}

function viewportTopFor(lineCount: number, height: number): number {
  return Math.max(0, Math.max(lineCount, height) - height);
}
