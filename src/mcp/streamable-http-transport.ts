import {
  isJsonObject,
  isJsonRpcRequest,
  type JsonRpcId,
  type JsonRpcMessage,
  MCP_PROTOCOL_VERSION,
} from "./protocol";
import { SseDecoder } from "./sse";
import { type McpTransport, McpTransportError, type McpTransportHandlers } from "./transport";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const CANCELLED_REQUEST_REASON = new Error("MCP HTTP request was cancelled.");
const RESERVED_HEADER_NAMES = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;

export type StreamableHttpTransportOptions = {
  url: string;
  headers?: Record<string, string>;
  maxMessageBytes?: number;
  closeTimeoutMs?: number;
};

type TransportState = "idle" | "running" | "closing" | "closed";

type SseReadResult = {
  responseReceived: boolean;
  lastEventId?: string;
  retryMs?: number;
};

// TODO(mcp): Add the deprecated 2024-11-05 HTTP+SSE transport as an explicit
// compatibility strategy if real-world server coverage justifies it. Do not
// mix its endpoint discovery lifecycle into this 2025-11-25 transport.
export class StreamableHttpTransport implements McpTransport {
  private readonly endpoint: URL;
  private readonly configuredHeaders: Headers;
  private state: TransportState = "idle";
  private handlers?: McpTransportHandlers;
  private sessionId?: string;
  private standaloneStreamStarted = false;
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeOperations = new Set<Promise<void>>();
  private readonly activeRequests = new Map<JsonRpcId, AbortController>();
  private closePromise?: Promise<void>;
  private failureReason?: string;
  private errorReported = false;
  private closeReported = false;

  constructor(private readonly options: StreamableHttpTransportOptions) {
    this.endpoint = parseEndpoint(options.url);
    this.configuredHeaders = new Headers(options.headers);
    assertNoReservedHeaders(this.configuredHeaders);
    assertPositiveInteger(options.maxMessageBytes, "maxMessageBytes");
    assertNonNegativeInteger(options.closeTimeoutMs, "closeTimeoutMs");
  }

  start(handlers: McpTransportHandlers): Promise<void> {
    if (this.state !== "idle") {
      return Promise.reject(
        new McpTransportError("MCP Streamable HTTP transport can only be started once."),
      );
    }

    this.handlers = handlers;
    this.state = "running";
    return Promise.resolve();
  }

  send(message: JsonRpcMessage): Promise<void> {
    if (this.state !== "running") {
      return Promise.reject(
        new McpTransportError("Cannot send through a closed MCP Streamable HTTP transport."),
      );
    }

    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch (error) {
      return Promise.reject(
        new McpTransportError("Failed to serialize MCP HTTP message.", { cause: error }),
      );
    }

    if (new TextEncoder().encode(payload).byteLength > this.maxMessageBytes) {
      return Promise.reject(
        new McpTransportError(`MCP message exceeds the ${this.maxMessageBytes}-byte HTTP limit.`),
      );
    }

    return this.trackOperation(async (controller) => {
      const requestId = isJsonRpcRequest(message) ? message.id : undefined;
      if (requestId !== undefined) {
        this.activeRequests.set(requestId, controller);
      }

      try {
        await this.postMessage(message, payload, controller);
        const cancelledRequestId = readCancelledRequestId(message);
        if (cancelledRequestId !== undefined) {
          this.activeRequests.get(cancelledRequestId)?.abort(CANCELLED_REQUEST_REASON);
        }
      } catch (error) {
        if (controller.signal.reason !== CANCELLED_REQUEST_REASON) {
          throw error;
        }
      } finally {
        if (requestId !== undefined && this.activeRequests.get(requestId) === controller) {
          this.activeRequests.delete(requestId);
        }
      }
    });
  }

  close(): Promise<void> {
    if (this.state === "idle") {
      this.state = "closed";
      return Promise.resolve();
    }
    if (this.state === "closed") {
      return this.closePromise ?? Promise.resolve();
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

  private async postMessage(
    message: JsonRpcMessage,
    payload: string,
    controller: AbortController,
  ): Promise<void> {
    const response = await this.fetchEndpoint("POST", {
      body: payload,
      controller,
      includeProtocolVersion: !isInitializeRequest(message),
      accept: "application/json, text/event-stream",
    });

    if (!response.ok) {
      throw await createHttpStatusError(response, this.maxMessageBytes);
    }

    if (isInitializeRequest(message)) {
      this.captureSessionId(response);
    }

    if (response.status === 202) {
      if (isJsonRpcRequest(message)) {
        throw new McpTransportError("MCP HTTP request received 202 without a JSON-RPC response.");
      }
      await response.body?.cancel().catch(() => undefined);
      if (isInitializedNotification(message)) {
        this.startStandaloneStream();
      }
      return;
    }

    const expectedResponseId = isJsonRpcRequest(message) ? message.id : undefined;
    await this.consumeResponse(response, expectedResponseId, controller);

    if (isInitializedNotification(message)) {
      this.startStandaloneStream();
    }
  }

  private async consumeResponse(
    response: Response,
    expectedResponseId: JsonRpcId | undefined,
    controller: AbortController,
  ): Promise<void> {
    const contentType = readContentType(response);

    if (contentType === "application/json") {
      const value = await readJsonResponse(response, this.maxMessageBytes);
      this.handlers?.onMessage(value);
      if (expectedResponseId !== undefined && !isResponseFor(value, expectedResponseId)) {
        throw new McpTransportError(
          `MCP HTTP response did not contain JSON-RPC response ID ${expectedResponseId}.`,
        );
      }
      return;
    }

    if (contentType !== "text/event-stream") {
      throw new McpTransportError(
        `MCP HTTP response has unsupported Content-Type: ${contentType ?? "missing"}.`,
      );
    }

    let result = await this.readSseResponse(response, expectedResponseId);
    while (expectedResponseId !== undefined && !result.responseReceived) {
      if (!result.lastEventId) {
        throw new McpTransportError(
          `MCP SSE stream ended before JSON-RPC response ID ${expectedResponseId}.`,
        );
      }

      await waitForDelay(result.retryMs ?? DEFAULT_RECONNECT_DELAY_MS, controller.signal);
      const resumed = await this.fetchEndpoint("GET", {
        controller,
        includeProtocolVersion: true,
        accept: "text/event-stream",
        lastEventId: result.lastEventId,
      });
      if (!resumed.ok) {
        throw await createHttpStatusError(resumed, this.maxMessageBytes);
      }
      if (readContentType(resumed) !== "text/event-stream") {
        throw new McpTransportError("MCP resumed stream did not return text/event-stream.");
      }

      const next = await this.readSseResponse(resumed, expectedResponseId);
      result = {
        responseReceived: next.responseReceived,
        lastEventId: next.lastEventId ?? result.lastEventId,
        retryMs: next.retryMs ?? result.retryMs,
      };
    }
  }

  private async readSseResponse(
    response: Response,
    expectedResponseId: JsonRpcId | undefined,
  ): Promise<SseReadResult> {
    if (!response.body) {
      throw new McpTransportError("MCP SSE response did not contain a body.");
    }

    let responseReceived = false;
    let lastEventId: string | undefined;
    let retryMs: number | undefined;
    const decoder = new SseDecoder({
      maxEventBytes: this.maxMessageBytes,
      onEvent: (event) => {
        if (event.id !== undefined) {
          lastEventId = event.id;
        }
        if (event.retry !== undefined) {
          retryMs = event.retry;
        }
        if (event.data === undefined || event.data === "") {
          return;
        }

        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch (error) {
          throw new McpTransportError("MCP SSE event contained invalid JSON.", { cause: error });
        }

        if (expectedResponseId !== undefined && isResponseFor(value, expectedResponseId)) {
          responseReceived = true;
        }
        this.handlers?.onMessage(value);
      },
    });
    const reader = response.body.getReader();

    try {
      while (!responseReceived) {
        const { done, value } = await reader.read();
        if (done) {
          decoder.finish();
          break;
        }
        decoder.push(value);
      }
      if (responseReceived) {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      reader.releaseLock();
    }

    return {
      responseReceived,
      ...(lastEventId === undefined ? {} : { lastEventId }),
      ...(retryMs === undefined ? {} : { retryMs }),
    };
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get("MCP-Session-Id");
    if (sessionId === null) {
      return;
    }
    if (!isValidSessionId(sessionId)) {
      throw new McpTransportError("MCP server returned an invalid MCP-Session-Id header.");
    }
    this.sessionId = sessionId;
  }

  private startStandaloneStream(): void {
    if (this.standaloneStreamStarted || this.state !== "running") {
      return;
    }
    this.standaloneStreamStarted = true;

    void this.trackOperation((controller) => this.runStandaloneStream(controller)).catch(() => {
      // trackOperation reports fatal stream errors through the transport hook.
    });
  }

  private async runStandaloneStream(controller: AbortController): Promise<void> {
    let lastEventId: string | undefined;
    let retryMs = DEFAULT_RECONNECT_DELAY_MS;

    while (this.state === "running" && !controller.signal.aborted) {
      let response: Response;
      try {
        response = await this.fetchEndpoint("GET", {
          controller,
          includeProtocolVersion: true,
          accept: "text/event-stream",
          ...(lastEventId === undefined ? {} : { lastEventId }),
        });
      } catch {
        if (controller.signal.aborted || this.state !== "running") {
          return;
        }
        await waitForDelay(retryMs, controller.signal);
        continue;
      }

      if (response.status === 405) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!response.ok) {
        throw await createHttpStatusError(response, this.maxMessageBytes);
      }
      if (readContentType(response) !== "text/event-stream") {
        throw new McpTransportError("MCP standalone GET did not return text/event-stream.");
      }

      const result = await this.readSseResponse(response, undefined);
      lastEventId = result.lastEventId ?? lastEventId;
      retryMs = result.retryMs ?? retryMs;

      if (this.state === "running" && !controller.signal.aborted) {
        await waitForDelay(retryMs, controller.signal);
      }
    }
  }

  private async fetchEndpoint(
    method: "POST" | "GET",
    options: {
      controller: AbortController;
      includeProtocolVersion: boolean;
      accept: string;
      body?: string;
      lastEventId?: string;
    },
  ): Promise<Response> {
    const headers = new Headers(this.configuredHeaders);
    headers.set("Accept", options.accept);
    if (method === "POST") {
      headers.set("Content-Type", "application/json");
    }
    if (this.sessionId !== undefined) {
      headers.set("MCP-Session-Id", this.sessionId);
    }
    if (options.includeProtocolVersion) {
      headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    }
    if (options.lastEventId !== undefined) {
      headers.set("Last-Event-ID", options.lastEventId);
    }

    return fetch(this.endpoint, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: options.controller.signal,
      redirect: "error",
    });
  }

  private trackOperation(operation: (controller: AbortController) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.add(controller);

    const tracked = operation(controller)
      .catch((error) => {
        const transportError = asTransportError(error, "MCP HTTP transport failed.");
        if (this.state === "running") {
          this.fail(transportError);
        }
        throw transportError;
      })
      .finally(() => {
        this.activeControllers.delete(controller);
        this.activeOperations.delete(tracked);
      });

    this.activeOperations.add(tracked);
    return tracked;
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

  private async shutdown(): Promise<void> {
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    await Promise.allSettled([...this.activeOperations]);

    let closeError: unknown;
    if (this.sessionId !== undefined) {
      try {
        await this.deleteSession();
      } catch (error) {
        closeError = error;
      }
    }

    this.state = "closed";
    this.reportClose(this.failureReason);
    if (closeError !== undefined) {
      throw asTransportError(closeError, "Failed to close MCP HTTP session.");
    }
  }

  private async deleteSession(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    );

    try {
      const headers = new Headers(this.configuredHeaders);
      headers.set("Accept", "application/json, text/event-stream");
      headers.set("MCP-Session-Id", this.sessionId!);
      headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
      const response = await fetch(this.endpoint, {
        method: "DELETE",
        headers,
        signal: controller.signal,
        redirect: "error",
      });

      if (!response.ok && response.status !== 404 && response.status !== 405) {
        throw await createHttpStatusError(response, this.maxMessageBytes);
      }
      await response.body?.cancel().catch(() => undefined);
    } finally {
      clearTimeout(timeout);
    }
  }

  private reportClose(reason: string | undefined): void {
    if (this.closeReported) {
      return;
    }
    this.closeReported = true;
    try {
      this.handlers?.onClose(reason ? { reason } : {});
    } catch {
      // HTTP resources are already closed; callback failures are diagnostic only.
    }
  }
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw new Error("MCP Streamable HTTP URL must be an absolute URL.", { cause: error });
  }

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("MCP Streamable HTTP URL must use http or https.");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("MCP Streamable HTTP URL cannot contain credentials.");
  }
  if (endpoint.hash) {
    throw new Error("MCP Streamable HTTP URL cannot contain a fragment.");
  }
  return endpoint;
}

function assertNoReservedHeaders(headers: Headers): void {
  const reserved = RESERVED_HEADER_NAMES.find((name) => headers.has(name));
  if (reserved !== undefined) {
    throw new Error(`MCP Streamable HTTP headers cannot override ${reserved}.`);
  }
}

function isInitializeRequest(message: JsonRpcMessage): boolean {
  return isJsonRpcRequest(message) && message.method === "initialize";
}

function isInitializedNotification(message: JsonRpcMessage): boolean {
  return (
    "method" in message && !("id" in message) && message.method === "notifications/initialized"
  );
}

function readCancelledRequestId(message: JsonRpcMessage): JsonRpcId | undefined {
  if (
    !("method" in message) ||
    "id" in message ||
    message.method !== "notifications/cancelled" ||
    !isJsonObject(message.params)
  ) {
    return undefined;
  }

  const requestId = message.params.requestId;
  return typeof requestId === "string" ||
    (typeof requestId === "number" && Number.isInteger(requestId))
    ? requestId
    : undefined;
}

function isResponseFor(value: unknown, id: JsonRpcId): boolean {
  return isJsonObject(value) && value.id === id && ("result" in value || "error" in value);
}

function isValidSessionId(value: string): boolean {
  if (!value) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function readContentType(response: Response): string | undefined {
  return response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await readBoundedBody(response, maxBytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    throw new McpTransportError("MCP HTTP response contained invalid JSON.", { cause: error });
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpTransportError(`MCP HTTP response exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function createHttpStatusError(
  response: Response,
  maxMessageBytes: number,
): Promise<McpTransportError> {
  const maxErrorBytes = Math.min(maxMessageBytes, 4_096);
  let detail = "";
  try {
    const body = await readBoundedBody(response, maxErrorBytes);
    detail = new TextDecoder().decode(body).trim();
  } catch {
    detail = "";
  }
  return new McpTransportError(
    `MCP HTTP request failed with ${response.status} ${response.statusText}${
      detail ? `: ${detail}` : "."
    }`,
  );
}

async function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = () => done(signal.reason ?? new Error("MCP HTTP operation aborted."));

    function done(error?: unknown): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

function asTransportError(error: unknown, message: string): McpTransportError {
  return error instanceof McpTransportError
    ? error
    : new McpTransportError(message, { cause: error });
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
