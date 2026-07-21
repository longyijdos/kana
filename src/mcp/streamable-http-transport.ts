import {
  isJsonObject,
  isJsonRpcRequest,
  type JsonRpcId,
  type JsonRpcMessage,
  MCP_PROTOCOL_VERSION,
} from "./protocol";
import { SseDecoder } from "./sse";
import {
  type McpTransport,
  McpTransportError,
  type McpTransportHandlers,
  type McpTransportReconnectCause,
  type McpTransportReconnected,
  McpTransportSessionExpiredError,
} from "./transport";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const CANCELLED_REQUEST_REASON = new Error("MCP HTTP request was cancelled.");
const SESSION_REPLACED_REASON = new Error("MCP HTTP session was replaced.");
const RESERVED_HEADER_NAMES = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;

export type StreamableHttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type StreamableHttpTransportOptions = {
  url: string;
  headers?: Record<string, string>;
  maxMessageBytes?: number;
  closeTimeoutMs?: number;
  fetch?: StreamableHttpFetch;
};

type TransportState = "idle" | "running" | "closing" | "closed";

type SseReadResult = {
  responseReceived: boolean;
  lastEventId?: string;
  retryMs?: number;
};

type SseResumeState = {
  lastEventId?: string;
  retryMs?: number;
};

type PendingStandaloneReconnect = {
  cause: McpTransportReconnectCause;
  errorIdentity?: string;
};

type HttpSession = {
  id: string;
  generation: number;
};

// TODO(mcp): Add the deprecated 2024-11-05 HTTP+SSE transport as an explicit
// compatibility strategy if real-world server coverage justifies it. Do not
// mix its endpoint discovery lifecycle into this 2025-11-25 transport.
export class StreamableHttpTransport implements McpTransport {
  private readonly endpoint: URL;
  private readonly configuredHeaders: Headers;
  private readonly fetch: StreamableHttpFetch;
  private state: TransportState = "idle";
  private handlers?: McpTransportHandlers;
  private session?: HttpSession;
  private nextSessionGeneration = 1;
  private standaloneStreamStarted = false;
  private standaloneController?: AbortController;
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
    this.fetch = options.fetch ?? globalThis.fetch;
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
    }, describeSendPhase(message));
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
      includeSession: !isInitializeRequest(message),
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
    resumeState: SseResumeState = {},
  ): Promise<SseReadResult> {
    if (!response.body) {
      throw new McpTransportError("MCP SSE response did not contain a body.");
    }

    let responseReceived = false;
    const decoder = new SseDecoder({
      maxEventBytes: this.maxMessageBytes,
      onEvent: (event) => {
        if (event.id !== undefined) {
          resumeState.lastEventId = event.id;
        }
        if (event.retry !== undefined) {
          resumeState.retryMs = event.retry;
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
      ...(resumeState.lastEventId === undefined ? {} : { lastEventId: resumeState.lastEventId }),
      ...(resumeState.retryMs === undefined ? {} : { retryMs: resumeState.retryMs }),
    };
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get("MCP-Session-Id");
    if (sessionId === null) {
      this.session = undefined;
      return;
    }
    if (!isValidSessionId(sessionId)) {
      throw new McpTransportError("MCP server returned an invalid MCP-Session-Id header.");
    }
    this.session = { id: sessionId, generation: this.nextSessionGeneration };
    this.nextSessionGeneration += 1;
  }

  private startStandaloneStream(): void {
    if (this.standaloneStreamStarted || this.state !== "running") {
      return;
    }
    this.standaloneStreamStarted = true;

    void this.trackOperation(async (controller) => {
      this.standaloneController = controller;
      try {
        await this.runStandaloneStream(controller);
      } finally {
        if (this.standaloneController === controller) {
          this.standaloneController = undefined;
        }
      }
    }, "standalone GET/SSE stream").catch(() => {
      // trackOperation reports fatal errors and session expiry through transport hooks.
    });
  }

  private async runStandaloneStream(controller: AbortController): Promise<void> {
    // The decoder updates this cursor before the body read completes, so a
    // socket reset can resume from the last fully dispatched SSE event.
    const resumeState: SseResumeState = {};
    let pendingReconnect: PendingStandaloneReconnect | undefined;
    let reconnectCount = 0;

    while (this.state === "running" && !controller.signal.aborted) {
      let response: Response;
      try {
        response = await this.fetchEndpoint("GET", {
          controller,
          includeProtocolVersion: true,
          accept: "text/event-stream",
          ...(resumeState.lastEventId === undefined
            ? {}
            : { lastEventId: resumeState.lastEventId }),
        });
      } catch (error) {
        if (error instanceof McpTransportSessionExpiredError) {
          throw error;
        }
        if (controller.signal.aborted || this.state !== "running") {
          return;
        }
        pendingReconnect ??= {
          cause: "connect_error",
          errorIdentity: describeErrorIdentity(error),
        };
        await waitForDelay(resumeState.retryMs ?? DEFAULT_RECONNECT_DELAY_MS, controller.signal);
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

      if (pendingReconnect !== undefined) {
        reconnectCount += 1;
        this.reportReconnect({
          operation: "standalone_sse",
          cause: pendingReconnect.cause,
          reconnectCount,
          resumedFromEvent: resumeState.lastEventId !== undefined,
          ...(pendingReconnect.errorIdentity === undefined
            ? {}
            : { errorIdentity: pendingReconnect.errorIdentity }),
        });
        pendingReconnect = undefined;
      }

      try {
        await this.readSseResponse(response, undefined, resumeState);
      } catch (error) {
        if (error instanceof McpTransportError) {
          throw error;
        }
        if (controller.signal.aborted || this.state !== "running") {
          return;
        }
        pendingReconnect = {
          cause: "read_error",
          errorIdentity: describeErrorIdentity(error),
        };
      }

      pendingReconnect ??= { cause: "stream_ended" };

      if (this.state === "running" && !controller.signal.aborted) {
        await waitForDelay(resumeState.retryMs ?? DEFAULT_RECONNECT_DELAY_MS, controller.signal);
      }
    }
  }

  private reportReconnect(event: McpTransportReconnected): void {
    try {
      this.handlers?.onReconnect?.(event);
    } catch {
      // Diagnostic hooks cannot alter stream recovery.
    }
  }

  private async fetchEndpoint(
    method: "POST" | "GET",
    options: {
      controller: AbortController;
      includeSession?: boolean;
      includeProtocolVersion: boolean;
      accept: string;
      body?: string;
      lastEventId?: string;
    },
  ): Promise<Response> {
    const headers = new Headers(this.configuredHeaders);
    const session = options.includeSession === false ? undefined : this.session;
    headers.set("Accept", options.accept);
    if (method === "POST") {
      headers.set("Content-Type", "application/json");
    }
    if (session !== undefined) {
      headers.set("MCP-Session-Id", session.id);
    }
    if (options.includeProtocolVersion) {
      headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
    }
    if (options.lastEventId !== undefined) {
      headers.set("Last-Event-ID", options.lastEventId);
    }

    const response = await this.fetch(this.endpoint, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: options.controller.signal,
      redirect: "error",
    });

    if (response.status === 404 && session !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      this.expireSession(session.generation);
      throw new McpTransportSessionExpiredError(session.generation);
    }
    return response;
  }

  private expireSession(generation: number): void {
    if (this.session?.generation !== generation) {
      return;
    }

    this.session = undefined;
    this.standaloneStreamStarted = false;
    this.standaloneController?.abort(SESSION_REPLACED_REASON);
  }

  private trackOperation(
    operation: (controller: AbortController) => Promise<void>,
    phase: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.add(controller);

    const tracked = operation(controller)
      .catch((error) => {
        const transportError = asTransportError(error, `MCP HTTP ${phase} failed.`);
        if (transportError instanceof McpTransportSessionExpiredError) {
          this.handlers?.onSessionExpired?.({ generation: transportError.generation });
          throw transportError;
        }
        if (controller.signal.reason === SESSION_REPLACED_REASON) {
          return;
        }
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
    if (this.session !== undefined) {
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
      headers.set("MCP-Session-Id", this.session!.id);
      headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
      const response = await this.fetch(this.endpoint, {
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

function describeSendPhase(message: JsonRpcMessage): string {
  if ("method" in message) {
    return `POST ${sanitizeMethodName(message.method)}`;
  }
  return "POST JSON-RPC response";
}

function sanitizeMethodName(method: string): string {
  const sanitized = [...method]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e ? character : "?";
    })
    .join("");
  return sanitized.length <= 128 ? sanitized : `${sanitized.slice(0, 128)}…`;
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
    : new McpTransportError(`${message} (${describeErrorIdentity(error)})`, { cause: error });
}

function describeErrorIdentity(error: unknown): string {
  if (!(error instanceof Error)) {
    return `thrown ${typeof error}`;
  }

  const parts = [error.name || "Error"];
  const code = readSafeErrorCode(error);
  if (code !== undefined) {
    parts.push(`code ${code}`);
  }
  const cause = error.cause;
  if (cause instanceof Error && cause !== error) {
    const causeCode = readSafeErrorCode(cause);
    parts.push(`cause ${cause.name || "Error"}${causeCode === undefined ? "" : `/${causeCode}`}`);
  }
  return parts.join(", ");
}

function readSafeErrorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  const value = typeof code === "string" || typeof code === "number" ? String(code) : undefined;
  return value !== undefined && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : undefined;
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
