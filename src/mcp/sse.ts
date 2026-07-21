import { McpTransportError } from "./transport";

export type SseEvent = {
  data?: string;
  event?: string;
  id?: string;
  retry?: number;
};

export type SseDecoderOptions = {
  maxEventBytes: number;
  onEvent(event: SseEvent): void;
};

// SSE framing is shared by Streamable HTTP response streams and the deferred
// legacy HTTP+SSE compatibility path. JSON-RPC parsing deliberately remains in
// the transport so this decoder has no MCP protocol or endpoint semantics.
export class SseDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly encoder = new TextEncoder();
  private buffer = "";
  private dataLines: string[] = [];
  private eventType?: string;
  private eventId?: string;
  private retry?: number;
  private eventBytes = 0;
  private finished = false;

  constructor(private readonly options: SseDecoderOptions) {
    if (!Number.isInteger(options.maxEventBytes) || options.maxEventBytes <= 0) {
      throw new Error("maxEventBytes must be a positive integer.");
    }
  }

  push(chunk: Uint8Array): void {
    if (this.finished) {
      throw new McpTransportError("Cannot append data to a completed MCP SSE stream.");
    }

    try {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    } catch (error) {
      throw new McpTransportError("MCP SSE stream contained invalid UTF-8.", { cause: error });
    }

    this.consumeLines(false);
    this.assertBufferSize();
  }

  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;

    try {
      this.buffer += this.decoder.decode();
    } catch (error) {
      throw new McpTransportError("MCP SSE stream ended with invalid UTF-8.", { cause: error });
    }

    this.consumeLines(true);
    if (this.buffer) {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
    this.dispatchEvent();
  }

  private consumeLines(final: boolean): void {
    let lineStart = 0;

    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index];
      if (character !== "\n" && character !== "\r") {
        continue;
      }
      if (character === "\r" && index + 1 === this.buffer.length && !final) {
        break;
      }

      this.consumeLine(this.buffer.slice(lineStart, index));
      if (character === "\r" && this.buffer[index + 1] === "\n") {
        index += 1;
      }
      lineStart = index + 1;
    }

    this.buffer = this.buffer.slice(lineStart);
  }

  private consumeLine(line: string): void {
    this.eventBytes += this.encoder.encode(`${line}\n`).byteLength;
    if (this.eventBytes > this.options.maxEventBytes) {
      throw new McpTransportError(
        `MCP SSE event exceeds the ${this.options.maxEventBytes}-byte limit.`,
      );
    }

    if (!line) {
      this.dispatchEvent();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventType = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.eventId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          const retry = Number(value);
          if (Number.isSafeInteger(retry)) {
            this.retry = retry;
          }
        }
        break;
    }
  }

  private dispatchEvent(): void {
    if (
      this.dataLines.length > 0 ||
      this.eventType !== undefined ||
      this.eventId !== undefined ||
      this.retry !== undefined
    ) {
      this.options.onEvent({
        ...(this.dataLines.length === 0 ? {} : { data: this.dataLines.join("\n") }),
        ...(this.eventType === undefined ? {} : { event: this.eventType }),
        ...(this.eventId === undefined ? {} : { id: this.eventId }),
        ...(this.retry === undefined ? {} : { retry: this.retry }),
      });
    }

    this.dataLines = [];
    this.eventType = undefined;
    this.eventId = undefined;
    this.retry = undefined;
    this.eventBytes = 0;
  }

  private assertBufferSize(): void {
    if (
      this.eventBytes + this.encoder.encode(this.buffer).byteLength >
      this.options.maxEventBytes
    ) {
      throw new McpTransportError(
        `MCP SSE event exceeds the ${this.options.maxEventBytes}-byte limit.`,
      );
    }
  }
}
