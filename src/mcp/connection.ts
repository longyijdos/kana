import {
  McpClientError,
  McpConnectionClosedError,
  McpRequestCancelledError,
  McpRequestTimeoutError,
  McpResponseError,
} from "./errors";
import {
  isJsonObject,
  isJsonRpcErrorResponse,
  isJsonRpcId,
  isJsonRpcNotification,
  isJsonRpcRequest,
  type JsonObject,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpProgress,
  McpProtocolError,
  parseJsonRpcMessage,
} from "./protocol";
import type { McpTransport, McpTransportClose } from "./transport";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_IGNORED_RESPONSE_IDS = 256;

export type McpConnectionOptions = {
  transport: McpTransport;
  requestTimeoutMs?: number;
  onNotification?(notification: JsonRpcNotification): void;
  onError?(error: Error): void;
  onClose?(event: McpTransportClose): void;
};

export type McpConnectionRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  cancellable?: boolean;
  onProgress?(progress: McpProgress): void;
};

type ConnectionState = "idle" | "running" | "closing" | "closed";

type PendingRequest = {
  id: JsonRpcId;
  method: string;
  resolve(result: JsonObject): void;
  reject(error: unknown): void;
  timeout?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
  progressToken?: JsonRpcId;
  lastProgress?: number;
  onProgress?(progress: McpProgress): void;
};

// McpConnection owns the bidirectional JSON-RPC session but no version-specific
// lifecycle or feature methods. Both the stable and future protocol clients can
// therefore share request correlation, cancellation, progress, and ping handling.
export class McpConnection {
  private state: ConnectionState = "idle";
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly progressRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly ignoredResponseIds = new Set<JsonRpcId>();
  private readonly ignoredResponseOrder: JsonRpcId[] = [];

  constructor(private readonly options: McpConnectionOptions) {
    assertPositiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
  }

  get active(): boolean {
    return this.state === "running";
  }

  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new McpClientError("MCP connection can only be started once.");
    }

    this.state = "running";
    try {
      await this.options.transport.start({
        onMessage: (message) => this.handleMessage(message),
        onError: (error) => this.handleTransportError(error),
        onClose: (event) => this.handleTransportClose(event),
      });
    } catch (error) {
      this.state = "closed";
      throw error;
    }
  }

  async request(
    method: string,
    params: JsonObject,
    options: McpConnectionRequestOptions = {},
  ): Promise<JsonObject> {
    if (this.state !== "running") {
      throw new McpConnectionClosedError("MCP connection is not active.");
    }
    if (options.signal?.aborted) {
      throw createCancellationError(options.signal);
    }

    const id = this.allocateRequestId();
    const requestParams = { ...params };
    const progressToken = options.onProgress ? `kana-${id}` : undefined;

    if (progressToken !== undefined) {
      const existingMeta = isJsonObject(requestParams._meta) ? requestParams._meta : {};
      requestParams._meta = { ...existingMeta, progressToken };
    }

    const message: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: requestParams,
    };
    const response = new Promise<JsonObject>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        resolve,
        reject,
        progressToken,
        onProgress: options.onProgress,
      };
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

      pending.timeout = setTimeout(() => {
        this.cancelPending(
          pending,
          new McpRequestTimeoutError(method, timeoutMs),
          `Request timed out after ${timeoutMs}ms.`,
          options.cancellable !== false,
        );
      }, timeoutMs);

      if (options.signal) {
        const onAbort = () => {
          this.cancelPending(
            pending,
            createCancellationError(options.signal!),
            "Request aborted by client.",
            options.cancellable !== false,
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, pending);
      if (progressToken !== undefined) {
        this.progressRequests.set(progressToken, pending);
      }
    });

    try {
      await this.options.transport.send(message);
    } catch (error) {
      const pending = this.takePending(id);
      pending?.reject(error);
    }

    return response;
  }

  async sendNotification(method: string, params?: JsonObject): Promise<void> {
    if (this.state !== "running") {
      throw new McpConnectionClosedError("MCP connection is not active.");
    }

    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    await this.options.transport.send(notification);
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (this.state === "idle") {
      this.state = "closed";
      await this.options.transport.close();
      return;
    }

    this.state = "closing";
    this.rejectAllPending(new McpConnectionClosedError("MCP connection closed."));

    try {
      await this.options.transport.close();
    } finally {
      this.state = "closed";
    }
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private handleMessage(value: unknown): void {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(value);
    } catch (error) {
      this.failConnection(asError(error));
      return;
    }

    if (isJsonRpcRequest(message)) {
      this.handleServerRequest(message);
      return;
    }
    if (isJsonRpcNotification(message)) {
      this.handleNotification(message);
      return;
    }

    this.handleResponse(message);
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.takePending(message.id);
    if (!pending) {
      if (!this.ignoredResponseIds.has(message.id)) {
        this.reportError(
          new McpProtocolError(`Received an unknown or duplicate MCP response ID: ${message.id}.`),
        );
      }
      return;
    }

    if (isJsonRpcErrorResponse(message)) {
      pending.reject(
        new McpResponseError(message.error.code, message.error.message, message.error.data),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const response: JsonRpcResponse =
      request.method === "ping"
        ? { jsonrpc: "2.0", id: request.id, result: {} }
        : createErrorResponse(request.id, -32601, `Method not found: ${request.method}`);

    void this.options.transport.send(response).catch((error) => {
      this.handleTransportError(asError(error));
    });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "notifications/progress") {
      this.handleProgress(notification.params);
    }

    try {
      this.options.onNotification?.(notification);
    } catch (error) {
      this.reportError(asError(error));
    }
  }

  private handleProgress(params: JsonObject | undefined): void {
    if (
      !params ||
      !isJsonRpcId(params.progressToken) ||
      typeof params.progress !== "number" ||
      !Number.isFinite(params.progress) ||
      (params.total !== undefined &&
        (typeof params.total !== "number" || !Number.isFinite(params.total))) ||
      (params.message !== undefined && typeof params.message !== "string")
    ) {
      this.reportError(new McpProtocolError("Received an invalid MCP progress notification."));
      return;
    }

    const pending = this.progressRequests.get(params.progressToken);
    if (!pending?.onProgress) {
      return;
    }
    if (pending.lastProgress !== undefined && params.progress <= pending.lastProgress) {
      this.reportError(
        new McpProtocolError("MCP progress values must increase for an active request."),
      );
      return;
    }

    pending.lastProgress = params.progress;

    try {
      pending.onProgress({
        progressToken: params.progressToken,
        progress: params.progress,
        ...(params.total === undefined ? {} : { total: params.total }),
        ...(params.message === undefined ? {} : { message: params.message }),
      });
    } catch (error) {
      this.reportError(asError(error));
    }
  }

  private handleTransportError(error: Error): void {
    this.failConnection(error);
  }

  private handleTransportClose(event: McpTransportClose): void {
    const alreadyClosing = this.state === "closing" || this.state === "closed";
    this.state = "closed";

    if (!alreadyClosing) {
      this.rejectAllPending(
        new McpConnectionClosedError(event.reason ?? "MCP transport closed unexpectedly."),
      );
    }

    try {
      this.options.onClose?.(event);
    } catch (error) {
      this.reportError(asError(error));
    }
  }

  private failConnection(error: Error): void {
    if (this.state === "closing" || this.state === "closed") {
      return;
    }

    this.reportError(error);
    this.state = "closing";
    this.rejectAllPending(error);
    void this.options.transport.close().finally(() => {
      this.state = "closed";
    });
  }

  private cancelPending(
    pending: PendingRequest,
    error: Error,
    reason: string,
    notifyServer: boolean,
  ): void {
    if (this.pending.get(pending.id) !== pending) {
      return;
    }

    this.takePending(pending.id);
    this.rememberIgnoredResponseId(pending.id);
    pending.reject(error);

    if (notifyServer && this.state === "running") {
      void this.sendNotification("notifications/cancelled", {
        requestId: pending.id,
        reason,
      }).catch(() => undefined);
    }
  }

  private takePending(id: JsonRpcId): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) {
      return undefined;
    }

    this.pending.delete(id);
    if (pending.progressToken !== undefined) {
      this.progressRequests.delete(pending.progressToken);
    }
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.removeAbortListener?.();
    return pending;
  }

  private rejectAllPending(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      const pending = this.takePending(id);
      pending?.reject(error);
    }
  }

  private rememberIgnoredResponseId(id: JsonRpcId): void {
    this.ignoredResponseIds.add(id);
    this.ignoredResponseOrder.push(id);

    if (this.ignoredResponseOrder.length > MAX_IGNORED_RESPONSE_IDS) {
      const oldest = this.ignoredResponseOrder.shift();
      if (oldest !== undefined) {
        this.ignoredResponseIds.delete(oldest);
      }
    }
  }

  private allocateRequestId(): number {
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER) {
      throw new McpClientError("MCP request ID space exhausted for this connection.");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostic hooks cannot alter request settlement or connection cleanup.
    }
  }
}

function createErrorResponse(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function createCancellationError(signal: AbortSignal): McpRequestCancelledError {
  const cause = signal.reason;
  const message =
    cause instanceof Error && cause.message ? cause.message : "MCP request was cancelled.";
  return new McpRequestCancelledError(message, { cause });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
