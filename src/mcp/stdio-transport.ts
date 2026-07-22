import type { JsonRpcMessage } from "./protocol";
import { type McpTransport, McpTransportError, type McpTransportHandlers } from "./transport";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;

export type StdioTransportOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  maxMessageBytes?: number;
  shutdownTimeoutMs?: number;
  killTimeoutMs?: number;
  onStderr?(content: string): void;
};

type TransportState = "idle" | "running" | "closing" | "closed";
type StdioProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export class StdioTransport implements McpTransport {
  private state: TransportState = "idle";
  private handlers?: McpTransportHandlers;
  private process?: StdioProcess;
  private monitorPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private sendQueue = Promise.resolve();
  private failureReason?: string;
  private errorReported = false;
  private closeReported = false;

  constructor(private readonly options: StdioTransportOptions) {
    if (!options.command.trim()) {
      throw new Error("MCP stdio command cannot be empty.");
    }
    assertPositiveInteger(options.maxMessageBytes, "maxMessageBytes");
    assertNonNegativeInteger(options.shutdownTimeoutMs, "shutdownTimeoutMs");
    assertNonNegativeInteger(options.killTimeoutMs, "killTimeoutMs");
  }

  async start(handlers: McpTransportHandlers): Promise<void> {
    if (this.state !== "idle") {
      throw new McpTransportError("MCP stdio transport can only be started once.");
    }

    this.handlers = handlers;

    try {
      this.process = Bun.spawn([this.options.command, ...(this.options.args ?? [])], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // Kana targets POSIX platforms. A separate process group lets shutdown
        // terminate helper processes spawned by an MCP server as well.
        detached: true,
      });
    } catch (error) {
      this.state = "closed";
      throw new McpTransportError(`Failed to start MCP server: ${this.options.command}`, {
        cause: error,
      });
    }

    this.state = "running";
    this.monitorPromise = this.monitor(this.process);
  }

  send(message: JsonRpcMessage): Promise<void> {
    let payload: Uint8Array;

    try {
      payload = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    } catch (error) {
      return Promise.reject(
        new McpTransportError("Failed to serialize MCP message.", { cause: error }),
      );
    }

    if (payload.byteLength > this.maxMessageBytes) {
      return Promise.reject(
        new McpTransportError(`MCP message exceeds the ${this.maxMessageBytes}-byte stdio limit.`),
      );
    }

    const operation = this.sendQueue.then(async () => {
      if (this.state !== "running" || !this.process) {
        throw new McpTransportError("Cannot send through a closed MCP stdio transport.");
      }

      try {
        this.process.stdin.write(payload);
        await this.process.stdin.flush();
      } catch (error) {
        const transportError = new McpTransportError("Failed to write to MCP server stdin.", {
          cause: error,
        });
        this.fail(transportError);
        throw transportError;
      }
    });

    // Keep later sends ordered even when one caller observes a rejected write.
    this.sendQueue = operation.catch(() => undefined);
    return operation;
  }

  close(): Promise<void> {
    if (this.state === "idle") {
      this.state = "closed";
      return Promise.resolve();
    }
    if (this.state === "closed") {
      return this.monitorPromise ?? Promise.resolve();
    }
    if (this.closePromise) {
      return this.closePromise;
    }

    this.state = "closing";
    this.closePromise = this.shutdown();
    return this.closePromise;
  }

  private get maxMessageBytes(): number {
    return this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  private async monitor(proc: StdioProcess): Promise<void> {
    const stdoutPromise = this.readStdout(proc.stdout);
    const stderrPromise = this.readStderr(proc.stderr);
    const exitCode = await proc.exited;

    await Promise.allSettled([stdoutPromise, stderrPromise]);

    const wasClosing = this.state === "closing";
    this.state = "closed";
    const reason =
      this.failureReason ??
      (!wasClosing
        ? exitCode === 0
          ? "MCP server exited."
          : `MCP server exited with code ${exitCode}.`
        : undefined);
    this.reportClose(reason);
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer = appendBytes(buffer, value);
        let lineStart = 0;

        for (let index = 0; index < buffer.byteLength; index += 1) {
          if (buffer[index] !== 0x0a) {
            continue;
          }

          let lineEnd = index;
          if (lineEnd > lineStart && buffer[lineEnd - 1] === 0x0d) {
            lineEnd -= 1;
          }

          this.handleLine(buffer.subarray(lineStart, lineEnd));
          lineStart = index + 1;
        }

        buffer = buffer.slice(lineStart);
        if (buffer.byteLength > this.maxMessageBytes) {
          throw new McpTransportError(
            `MCP stdout line exceeds the ${this.maxMessageBytes}-byte limit.`,
          );
        }
      }

      if (buffer.byteLength > 0 && this.state === "running") {
        throw new McpTransportError("MCP server stdout ended with an incomplete message.");
      }
    } catch (error) {
      this.fail(asTransportError(error, "Failed to read MCP server stdout."));
    } finally {
      reader.releaseLock();
    }
  }

  private handleLine(line: Uint8Array): void {
    if (line.byteLength > this.maxMessageBytes) {
      throw new McpTransportError(
        `MCP stdout line exceeds the ${this.maxMessageBytes}-byte limit.`,
      );
    }

    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      value = JSON.parse(text);
    } catch (error) {
      throw new McpTransportError("MCP server stdout contained an invalid JSON message.", {
        cause: error,
      });
    }

    this.handlers?.onMessage(value);
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const content = decoder.decode(value, { stream: true });
        if (content) {
          this.reportStderr(content);
        }
      }

      const remaining = decoder.decode();
      if (remaining) {
        this.reportStderr(remaining);
      }
    } catch (error) {
      this.fail(asTransportError(error, "Failed to read MCP server stderr."));
    } finally {
      reader.releaseLock();
    }
  }

  private reportStderr(content: string): void {
    try {
      this.options.onStderr?.(content);
    } catch {
      // stderr forwarding is diagnostic and cannot alter the protocol path.
    }
  }

  private fail(error: McpTransportError): void {
    this.failureReason ??= error.message;

    if (!this.errorReported) {
      this.errorReported = true;
      try {
        this.handlers?.onError(error);
      } catch {
        // Transport cleanup must continue even if a consumer error hook fails.
      }
    }

    void this.close();
  }

  private reportClose(reason: string | undefined): void {
    if (this.closeReported) {
      return;
    }
    this.closeReported = true;

    try {
      this.handlers?.onClose(reason ? { reason } : {});
    } catch {
      // The process and streams are already closed; callback failures are diagnostic only.
    }
  }

  private async shutdown(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      this.state = "closed";
      return;
    }

    await this.sendQueue;
    try {
      proc.stdin.end();
    } catch {
      // The server may have already closed its stdin while exiting.
    }

    if (
      !(await settlesWithin(
        proc.exited,
        this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      ))
    ) {
      signalProcessGroup(proc, "SIGTERM");

      if (
        !(await settlesWithin(proc.exited, this.options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS))
      ) {
        signalProcessGroup(proc, "SIGKILL");
      }
    }

    await proc.exited.catch(() => undefined);
    await this.monitorPromise;
  }
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function asTransportError(error: unknown, message: string): McpTransportError {
  return error instanceof McpTransportError
    ? error
    : new McpTransportError(message, { cause: error });
}

function signalProcessGroup(proc: StdioProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // The process may exit between the timeout and the signal.
    }
  }
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}
