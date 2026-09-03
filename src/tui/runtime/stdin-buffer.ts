const ESCAPE = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
const DEFAULT_ESCAPE_TIMEOUT_MS = 10;

export type StdinBufferOptions = {
  sequenceTimeoutMs?: number;
  escapeTimeoutMs?: number;
};

export class StdinBuffer {
  private buffer = "";
  private pasteBuffer?: string;
  private timeout?: ReturnType<typeof setTimeout>;
  private readonly sequenceTimeoutMs: number;
  private readonly escapeTimeoutMs: number;

  constructor(
    private readonly onInput: (data: string) => void,
    options: StdinBufferOptions = {},
  ) {
    this.sequenceTimeoutMs = options.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
    this.escapeTimeoutMs = options.escapeTimeoutMs ?? DEFAULT_ESCAPE_TIMEOUT_MS;
  }

  process(data: string): void {
    this.clearTimeout();

    if (!data) {
      return;
    }

    this.buffer += data;
    this.drain();
  }

  destroy(): void {
    this.clearTimeout();
    this.buffer = "";
    this.pasteBuffer = undefined;
  }

  private drain(): void {
    while (this.buffer || this.pasteBuffer !== undefined) {
      if (this.pasteBuffer !== undefined) {
        this.pasteBuffer += this.buffer;
        this.buffer = "";

        const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);

        if (endIndex === -1) {
          return;
        }

        const content = this.pasteBuffer.slice(0, endIndex);
        this.buffer = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
        this.pasteBuffer = undefined;
        this.onInput(`${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`);
        continue;
      }

      if (this.buffer.startsWith(ESCAPE)) {
        const length = escapeSequenceLength(this.buffer);

        if (length === undefined) {
          this.scheduleTimeout();
          return;
        }

        const sequence = this.buffer.slice(0, length);
        this.buffer = this.buffer.slice(length);

        if (sequence === BRACKETED_PASTE_START) {
          this.pasteBuffer = "";
        } else {
          this.onInput(sequence);
        }
        continue;
      }

      const length = codePointLengthAt(this.buffer, 0);

      if (length === undefined) {
        this.scheduleTimeout();
        return;
      }

      const character = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      this.onInput(character);
    }
  }

  private scheduleTimeout(): void {
    const timeoutMs = this.buffer === ESCAPE ? this.escapeTimeoutMs : this.sequenceTimeoutMs;
    this.timeout = setTimeout(() => {
      this.timeout = undefined;

      if (!this.buffer) {
        return;
      }

      const pending = this.buffer;
      this.buffer = "";
      this.onInput(pending);
    }, timeoutMs);
  }

  private clearTimeout(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }
}

function escapeSequenceLength(input: string): number | undefined {
  if (input.length < 2) {
    return undefined;
  }

  if (input[1] === ESCAPE && isEscapeSequenceIntroducer(input[2])) {
    return 1;
  }

  switch (input[1]) {
    case "[":
      return csiSequenceLength(input);
    case "]":
      return terminatedSequenceLength(input, true);
    case "P":
    case "_":
      return terminatedSequenceLength(input, false);
    case "O": {
      const finalLength = codePointLengthAt(input, 2);
      return finalLength === undefined ? undefined : 2 + finalLength;
    }
    default: {
      const keyLength = codePointLengthAt(input, 1);
      return keyLength === undefined ? undefined : 1 + keyLength;
    }
  }
}

function csiSequenceLength(input: string): number | undefined {
  if (input.startsWith("\x1b[M")) {
    return input.length >= 6 ? 6 : undefined;
  }

  for (let index = 2; index < input.length; index += 1) {
    const code = input.charCodeAt(index);

    if (code >= 0x40 && code <= 0x7e) {
      return index + 1;
    }
  }

  return undefined;
}

function terminatedSequenceLength(input: string, allowBell: boolean): number | undefined {
  const stringTerminatorIndex = input.indexOf("\x1b\\", 2);
  const bellIndex = allowBell ? input.indexOf("\x07", 2) : -1;

  if (stringTerminatorIndex === -1) {
    return bellIndex === -1 ? undefined : bellIndex + 1;
  }

  if (bellIndex === -1 || stringTerminatorIndex < bellIndex) {
    return stringTerminatorIndex + 2;
  }

  return bellIndex + 1;
}

function codePointLengthAt(input: string, index: number): number | undefined {
  if (index >= input.length) {
    return undefined;
  }

  const first = input.charCodeAt(index);

  if (first < 0xd800 || first > 0xdbff) {
    return 1;
  }

  if (index + 1 >= input.length) {
    return undefined;
  }

  const second = input.charCodeAt(index + 1);
  return second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
}

function isEscapeSequenceIntroducer(value: string | undefined): boolean {
  return value === "[" || value === "]" || value === "O" || value === "P" || value === "_";
}
