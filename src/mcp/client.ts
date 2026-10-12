import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { McpRequestCancelledError, McpRequestTimeoutError, McpResponseError } from "./errors";
import type { McpManagedClient } from "./manager";
import type { JsonObject, McpImplementation, McpProgress } from "./protocol";

type McpClientOptions = {
  transport: Transport;
  clientInfo: McpImplementation;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  onError?(error: Error): void;
  onToolsChanged?(): void;
};

export class McpClient implements McpManagedClient {
  private readonly client: Client;
  private closePromise?: Promise<void>;

  constructor(private readonly options: McpClientOptions) {
    this.client = new Client(options.clientInfo, {
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: options.initializeTimeoutMs ?? 30_000 },
      },
    });
    this.client.onerror = options.onError;
    this.client.setNotificationHandler("notifications/tools/list_changed", () => {
      options.onToolsChanged?.();
    });
  }

  get serverInfo() {
    return this.client.getServerVersion();
  }

  get serverCapabilities() {
    return this.client.getServerCapabilities();
  }

  async connect(options: { signal?: AbortSignal } = {}): Promise<void> {
    try {
      await this.client.connect(this.options.transport, {
        signal: options.signal,
        timeout: this.options.initializeTimeoutMs ?? 30_000,
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(options: { signal?: AbortSignal } = {}) {
    const result = await this.client.listTools(undefined, {
      signal: options.signal,
      timeout: this.options.requestTimeoutMs ?? 60_000,
    });
    return result.tools;
  }

  async callTool(
    name: string,
    args?: JsonObject,
    options: { signal?: AbortSignal; onProgress?(progress: McpProgress): void } = {},
  ) {
    try {
      return await this.client.callTool(
        { name, arguments: args },
        {
          signal: options.signal,
          timeout: this.options.requestTimeoutMs ?? 60_000,
          onprogress: options.onProgress,
        },
      );
    } catch (error) {
      // The SDK uses RequestTimeout for caller aborts too; preserve their reason.
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new McpRequestCancelledError();
      }
      if (error instanceof ProtocolError) {
        throw new McpResponseError(error.code, error.message, error.data);
      }
      if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        throw new McpRequestTimeoutError("tools/call", this.options.requestTimeoutMs ?? 60_000);
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    try {
      if (this.options.transport instanceof StreamableHTTPClientTransport) {
        await this.options.transport.terminateSession();
      }
    } finally {
      await this.client.close();
    }
  }
}
