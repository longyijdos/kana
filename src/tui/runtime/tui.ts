import { truncateToWidth, visibleWidth } from "../render";
import { type Component, Container } from "./component";
import { CURSOR_MARKER } from "./cursor";
import type { Terminal } from "./terminal";

type InputListenerResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputListenerResult;
type ChangedRange = { first: number; last: number };
const GOODBYE_MESSAGE = "Goodbye from Kana.";

export class Tui extends Container {
  private focusedComponent?: Component;
  private readonly inputListeners = new Set<InputListener>();
  // Main-screen rendering can only move within the visible terminal viewport.
  // These rows are logical positions in the rendered line buffer.
  private previousLines: string[] = [];
  private previousRenderedLines: string[] = [];
  private previousWidth = 0;
  private previousHeight = 0;
  private previousViewportTop = 0;
  private hardwareCursorRow = 0;
  private hasRendered = false;
  private renderRequested = false;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(readonly terminal: Terminal) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.hasRendered = false;
    this.renderRequested = false;
    this.terminal.start(
      (data) => this.handleInput(data),
      () => this.requestRender(),
    );
    // Keep the first paint responsive while leaving full-redraw selection to
    // renderNow(), just like every later declarative render request.
    this.renderRequested = true;
    queueMicrotask(() => {
      this.renderRequested = false;
      this.renderNow();
    });
  }

  stop(message = GOODBYE_MESSAGE): void {
    this.stopped = true;

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.renderRequested = false;

    this.terminal.stop();
    this.terminal.write(`\x1b[2J\x1b[H\x1b[3J${message}\r\n`);
  }

  setFocus(component: Component | undefined): void {
    this.focusedComponent = component;
  }

  getFocus(): Component | undefined {
    return this.focusedComponent;
  }

  addInputListener(listener: InputListener): () => void {
    this.inputListeners.add(listener);

    return () => {
      this.inputListeners.delete(listener);
    };
  }

  requestRender(): void {
    if (this.stopped) {
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
    const rendered = this.render(width, height);
    const extractedCursor = extractCursorPosition(rendered);
    // A visible but disabled editor still emits its layout marker. Only a
    // focused component may own the hardware cursor; otherwise forced exit
    // would leave the shell prompt inside the editor instead of after it.
    const cursor = this.focusedComponent === undefined ? undefined : extractedCursor;
    const lines = rendered.map((line, index) =>
      // Cached transcript components return the same strings between keystrokes.
      // Reuse their normalized form to avoid recalculating CJK display widths.
      this.previousWidth === width && this.previousRenderedLines[index] === line
        ? this.previousLines[index]!
        : normalizeLine(line, width),
    );
    const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
    const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;

    this.previousRenderedLines = rendered;

    if (!this.hasRendered) {
      this.fullRender(lines, cursor, width, height);
      return;
    }

    if (widthChanged || heightChanged) {
      this.fullRender(lines, cursor, width, height);
      return;
    }

    const changed = findChangedRange(this.previousLines, lines);
    const grew = lines.length > this.previousLines.length;
    const shrank = lines.length < this.previousLines.length;

    if (!changed && !grew && !shrank) {
      this.positionHardwareCursor(cursor, width, height);
      this.previousWidth = width;
      this.previousHeight = height;
      return;
    }

    if (changed && changed.first < this.previousViewportTop) {
      // The changed line has already scrolled out of the visible working area.
      // Redraw the current screen instead of corrupting terminal scrollback.
      this.fullRender(lines, cursor, width, height);
      return;
    }

    const nextTail = Math.max(0, lines.length - 1);

    if (shrank && nextTail < this.previousViewportTop) {
      this.fullRender(lines, cursor, width, height);
      return;
    }

    if (!this.renderChangedLines(lines, changed, cursor, width, height)) {
      this.fullRender(lines, cursor, width, height);
    }
  }

  private fullRender(
    lines: string[],
    cursor: { row: number; column: number } | undefined,
    width: number,
    height: number,
  ): void {
    const viewportTop = viewportTopFor(lines.length, height);
    let buffer = `\x1b[?2026h\x1b[?25l\x1b[2J\x1b[H\x1b[3J${lines.join("\r\n")}`;

    this.previousViewportTop = viewportTop;

    const positioned = this.appendHardwareCursorPosition(
      buffer,
      cursor,
      Math.max(0, lines.length - 1),
      width,
      height,
    );

    buffer = `${positioned.buffer}\x1b[?2026l`;

    this.terminal.write(buffer);
    this.hardwareCursorRow = positioned.row;
    this.hasRendered = true;
    this.previousLines = lines;
    this.previousWidth = width;
    this.previousHeight = height;
  }

  private renderChangedLines(
    lines: string[],
    changed: ChangedRange | undefined,
    cursor: { row: number; column: number } | undefined,
    width: number,
    height: number,
  ): boolean {
    const previousLineCount = this.previousLines.length;
    const previousViewportBottom = this.previousViewportTop + height - 1;
    const isAddressable = (row: number) =>
      row >= this.previousViewportTop && row <= previousViewportBottom;

    if (!isAddressable(this.hardwareCursorRow)) {
      return false;
    }

    if (changed && (!isAddressable(changed.first) || !isAddressable(changed.last))) {
      return false;
    }

    if (lines.length > previousLineCount) {
      const appendAnchor = Math.max(0, previousLineCount - 1);

      if (!isAddressable(appendAnchor)) {
        return false;
      }
    }

    if (lines.length < previousLineCount && !isAddressable(lines.length)) {
      return false;
    }

    let buffer = "\x1b[?2026h\x1b[?25l";
    let currentRow = this.hardwareCursorRow;

    if (changed) {
      buffer = moveToRow(buffer, currentRow, changed.first);
      buffer += "\r";

      for (let index = changed.first; index <= changed.last; index += 1) {
        if (index > changed.first) {
          buffer += "\r\n";
        }

        buffer += `\x1b[2K${lines[index]}`;
      }

      currentRow = changed.last;
    }

    if (lines.length > previousLineCount) {
      const appendAnchor = Math.max(0, previousLineCount - 1);
      buffer = moveToRow(buffer, currentRow, appendAnchor);
      buffer += previousLineCount === 0 ? "\r" : "\r\n";

      for (let index = previousLineCount; index < lines.length; index += 1) {
        if (index > previousLineCount) {
          buffer += "\r\n";
        }

        buffer += `\x1b[2K${lines[index]}`;
      }

      currentRow = lines.length - 1;
      // A prior local shrink can leave logical rows in scrollback even when the
      // frame is shorter than the terminal. Appending can advance this boundary,
      // but it cannot make those rows addressable again.
      this.previousViewportTop = Math.max(
        this.previousViewportTop,
        viewportTopFor(lines.length, height),
      );
    }

    if (lines.length < previousLineCount) {
      buffer = moveToRow(buffer, currentRow, lines.length);
      buffer += "\r";

      for (let index = lines.length; index < previousLineCount; index += 1) {
        if (index > lines.length) {
          buffer += "\r\n";
        }

        buffer += "\x1b[2K";
      }

      const nextTail = Math.max(0, lines.length - 1);
      buffer = moveToRow(buffer, previousLineCount - 1, nextTail);
      currentRow = nextTail;
    }

    const positioned = this.appendHardwareCursorPosition(buffer, cursor, currentRow, width, height);

    buffer = `${positioned.buffer}\x1b[?2026l`;
    this.terminal.write(buffer);

    this.hardwareCursorRow = positioned.row;
    this.previousLines = lines;
    this.previousWidth = width;
    this.previousHeight = height;
    return true;
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

  private appendHardwareCursorPosition(
    buffer: string,
    cursor: { row: number; column: number } | undefined,
    currentRow: number,
    width: number,
    height: number,
  ): { buffer: string; row: number } {
    if (!cursor) {
      return { buffer, row: currentRow };
    }

    const viewportBottom = this.previousViewportTop + height - 1;

    if (cursor.row < this.previousViewportTop || cursor.row > viewportBottom) {
      return { buffer, row: currentRow };
    }

    const rowDelta = cursor.row - currentRow;

    if (rowDelta > 0) {
      buffer += `\x1b[${rowDelta}B`;
    } else if (rowDelta < 0) {
      buffer += `\x1b[${-rowDelta}A`;
    }

    // Keep the cursor hidden while repainting, then reveal it at its final
    // position before releasing synchronized output.
    buffer += `\x1b[${Math.min(cursor.column, width - 1) + 1}G\x1b[?25h`;

    return { buffer, row: cursor.row };
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
    lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

    return {
      row,
      column: visibleWidth(beforeMarker),
    };
  }

  return undefined;
}

function normalizeLine(line: string, width: number): string {
  const truncated = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;

  return `${truncated}\x1b[0m`;
}

function findChangedRange(previousLines: string[], lines: string[]): ChangedRange | undefined {
  const sharedLineCount = Math.min(previousLines.length, lines.length);
  let first = -1;
  let last = -1;

  for (let index = 0; index < sharedLineCount; index += 1) {
    if (previousLines[index] !== lines[index]) {
      if (first === -1) {
        first = index;
      }

      last = index;
    }
  }

  return first === -1 ? undefined : { first, last };
}

function moveToRow(buffer: string, fromRow: number, toRow: number): string {
  const rowDelta = toRow - fromRow;

  if (rowDelta > 0) {
    return `${buffer}\x1b[${rowDelta}B`;
  }

  if (rowDelta < 0) {
    return `${buffer}\x1b[${-rowDelta}A`;
  }

  return buffer;
}

function viewportTopFor(lineCount: number, height: number): number {
  return Math.max(0, Math.max(lineCount, height) - height);
}
