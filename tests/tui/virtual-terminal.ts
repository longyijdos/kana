import type { Terminal, TerminalNotification } from "../../src/tui/runtime";

type VirtualTerminalOptions = {
  columns: number;
  rows: number;
};

// This test-only terminal models the control sequences emitted by Tui. Its
// fixtures intentionally use single-column text; Unicode width remains covered
// by the rendering-width tests rather than duplicated in this ANSI state model.
export class VirtualTerminal implements Terminal {
  readonly writes: string[] = [];
  readonly columns: number;
  readonly rows: number;
  cursorRow = 0;
  cursorColumn = 0;
  private screenRows: string[][];
  private scrollbackRows: string[][] = [];
  private wrapPending = false;

  constructor(options: VirtualTerminalOptions) {
    this.columns = options.columns;
    this.rows = options.rows;
    this.screenRows = Array.from({ length: this.rows }, () => this.blankRow());
  }

  get screen(): string[] {
    return this.screenRows.map((row) => row.join("").trimEnd());
  }

  get scrollback(): string[] {
    return this.scrollbackRows.map((row) => row.join("").trimEnd());
  }

  start(_onInput: (data: string) => void, _onResize: () => void): void {}

  stop(): void {}

  write(data: string): void {
    this.writes.push(data);

    for (let index = 0; index < data.length; index += 1) {
      const character = data[index];

      if (character === "\x1b") {
        index = this.consumeEscapeSequence(data, index);
      } else if (character === "\r") {
        this.cursorColumn = 0;
        this.wrapPending = false;
      } else if (character === "\n") {
        this.lineFeed();
        this.wrapPending = false;
      } else {
        this.writeCharacter(character);
      }
    }
  }

  notify(_notification: TerminalNotification): void {}

  private consumeEscapeSequence(data: string, escapeIndex: number): number {
    if (data[escapeIndex + 1] !== "[") {
      throw new Error(`Unsupported terminal escape at offset ${escapeIndex}.`);
    }

    let finalIndex = escapeIndex + 2;

    while (finalIndex < data.length) {
      const code = data.charCodeAt(finalIndex);

      if (code >= 0x40 && code <= 0x7e) {
        const parameters = data.slice(escapeIndex + 2, finalIndex);
        this.applyCsi(parameters, data[finalIndex]);
        return finalIndex;
      }

      finalIndex += 1;
    }

    throw new Error(`Incomplete terminal escape at offset ${escapeIndex}.`);
  }

  private applyCsi(parameters: string, finalCharacter: string): void {
    this.wrapPending = false;

    switch (finalCharacter) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - parseCount(parameters));
        return;
      case "B":
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + parseCount(parameters));
        return;
      case "C":
        this.cursorColumn = Math.min(this.columns - 1, this.cursorColumn + parseCount(parameters));
        return;
      case "D":
        this.cursorColumn = Math.max(0, this.cursorColumn - parseCount(parameters));
        return;
      case "G":
        this.cursorColumn = Math.min(this.columns - 1, parseCount(parameters) - 1);
        return;
      case "H": {
        const [row = 1, column = 1] = parsePosition(parameters);
        this.cursorRow = Math.min(this.rows - 1, row - 1);
        this.cursorColumn = Math.min(this.columns - 1, column - 1);
        return;
      }
      case "J":
        if (parameters === "2") {
          this.screenRows = Array.from({ length: this.rows }, () => this.blankRow());
          return;
        }

        if (parameters === "3") {
          this.scrollbackRows = [];
          return;
        }
        break;
      case "K":
        if (parameters === "2") {
          this.screenRows[this.cursorRow] = this.blankRow();
          return;
        }
        break;
      case "m":
        return;
      case "h":
      case "l":
        if (parameters === "?25" || parameters === "?2026") {
          return;
        }
        break;
    }

    throw new Error(`Unsupported CSI sequence: ESC[${parameters}${finalCharacter}`);
  }

  private writeCharacter(character: string): void {
    if (this.wrapPending) {
      this.lineFeed();
      this.cursorColumn = 0;
      this.wrapPending = false;
    }

    this.screenRows[this.cursorRow][this.cursorColumn] = character;

    if (this.cursorColumn === this.columns - 1) {
      this.wrapPending = true;
    } else {
      this.cursorColumn += 1;
    }
  }

  private lineFeed(): void {
    if (this.cursorRow < this.rows - 1) {
      this.cursorRow += 1;
      return;
    }

    const firstRow = this.screenRows.shift();

    if (firstRow) {
      this.scrollbackRows.push(firstRow);
    }

    this.screenRows.push(this.blankRow());
  }

  private blankRow(): string[] {
    return Array.from({ length: this.columns }, () => " ");
  }
}

function parseCount(parameters: string): number {
  if (parameters === "") {
    return 1;
  }

  const value = Number(parameters);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid CSI count: ${parameters}`);
  }

  return value === 0 ? 1 : value;
}

function parsePosition(parameters: string): [number, number] {
  if (parameters === "") {
    return [1, 1];
  }

  const values = parameters.split(";").map((value) => (value === "" ? 1 : Number(value)));

  if (values.length > 2 || values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(`Invalid CSI position: ${parameters}`);
  }

  return [values[0] ?? 1, values[1] ?? 1];
}
