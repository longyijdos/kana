import { afterEach, describe, expect, test } from "bun:test";
import {
  type JsonObject,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  McpClient,
  McpRequestTimeoutError,
  StreamableHttpTransport,
  type StreamableHttpTransportOptions,
} from "../src/mcp";

const clients = new Set<McpClient>();
const servers = new Set<Bun.Server<unknown>>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close().catch(() => undefined)));
  clients.clear();
  await Promise.all([...servers].map((server) => server.stop(true)));
  servers.clear();
});

describe("MCP Streamable HTTP transport", () => {
  test("rejects endpoint credentials and transport-owned headers", () => {
    expect(
      () =>
        new StreamableHttpTransport({
          url: "https://user:secret@example.com/mcp",
        }),
    ).toThrow("cannot contain credentials");
    expect(
      () =>
        new StreamableHttpTransport({
          url: "https://example.com/mcp",
          headers: { "MCP-Session-Id": "user-supplied" },
        }),
    ).toThrow("cannot override mcp-session-id");
  });

  test("handles JSON and SSE responses with session headers and a standalone GET stream", async () => {
    const received: ReceivedRequest[] = [];
    let sessionDeleted = false;
    const server = createServer(async (request) => {
      const record = await recordRequest(request);
      received.push(record);

      if (request.method === "DELETE") {
        sessionDeleted = true;
        return new Response(null, { status: 200 });
      }
      if (request.method === "GET") {
        return openSseStream(request.signal, [
          sseEvent({
            id: "ping-1",
            data: {
              jsonrpc: "2.0",
              id: "server-ping",
              method: "ping",
            },
          }),
          sseEvent({
            id: "notice-1",
            data: {
              jsonrpc: "2.0",
              method: "notifications/tools/list_changed",
            },
          }),
        ]);
      }

      const message = record.message!;
      if (isRequestMethod(message, "initialize")) {
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: initializeResult(),
          },
          { "MCP-Session-Id": "session-1" },
        );
      }
      if (isNotificationMethod(message, "notifications/initialized")) {
        return new Response(null, { status: 202 });
      }
      if (isRequestMethod(message, "tools/list")) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [toolDefinition("slow")],
          },
        });
      }
      if (isRequestMethod(message, "tools/call")) {
        const progressToken = (message.params?._meta as JsonObject | undefined)?.progressToken;
        return chunkedSseResponse([
          "id: call-1\r",
          `\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken, progress: 1, total: 2 },
          })}\r\n\r`,
          "\n",
          sseEvent({
            id: "call-2",
            data: {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: "done" }],
                structuredContent: { value: 42 },
              },
            },
          }),
        ]);
      }

      return new Response(null, { status: 202 });
    });
    const notifications: string[] = [];
    const client = createClient(server, {
      headers: { Authorization: "Bearer test-token" },
      onNotification: (method) => notifications.push(method),
    });

    await client.connect();
    await waitFor(() => notifications.includes("notifications/tools/list_changed"));
    await waitFor(() =>
      received.some(
        (item) =>
          item.message !== undefined &&
          "id" in item.message &&
          item.message.id === "server-ping" &&
          "result" in item.message,
      ),
    );
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["slow"]);

    const progress: number[] = [];
    const result = await client.callTool(
      "slow",
      { value: 42 },
      { onProgress: (update) => progress.push(update.progress) },
    );
    expect(progress).toEqual([1]);
    expect(result.structuredContent).toEqual({ value: 42 });

    const initialize = received.find((item) => item.rpcMethod === "initialize")!;
    expect(initialize.sessionId).toBeNull();
    expect(initialize.protocolVersion).toBeNull();
    expect(initialize.accept).toBe("application/json, text/event-stream");
    expect(initialize.authorization).toBe("Bearer test-token");

    const initialized = received.find((item) => item.rpcMethod === "notifications/initialized")!;
    expect(initialized.sessionId).toBe("session-1");
    expect(initialized.protocolVersion).toBe("2025-11-25");

    const standaloneGet = received.find((item) => item.httpMethod === "GET")!;
    expect(standaloneGet.sessionId).toBe("session-1");
    expect(standaloneGet.protocolVersion).toBe("2025-11-25");

    await client.close();
    expect(sessionDeleted).toBe(true);
    const deletion = received.find((item) => item.httpMethod === "DELETE")!;
    expect(deletion.sessionId).toBe("session-1");
    expect(deletion.protocolVersion).toBe("2025-11-25");
  });

  test("resumes a POST SSE response with Last-Event-ID instead of retrying the request", async () => {
    let listPostCount = 0;
    const resumeHeaders: string[] = [];
    const server = createServer(async (request) => {
      if (request.method === "GET") {
        const lastEventId = request.headers.get("Last-Event-ID");
        if (lastEventId === null) {
          return new Response(null, { status: 405 });
        }
        resumeHeaders.push(lastEventId);
        return chunkedSseResponse([
          sseEvent({
            id: "resume-2",
            data: {
              jsonrpc: "2.0",
              id: 2,
              result: { tools: [toolDefinition("resumed")] },
            },
          }),
        ]);
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 200 });
      }

      const message = (await request.json()) as JsonRpcMessage;
      if (isRequestMethod(message, "initialize")) {
        return jsonResponse(
          { jsonrpc: "2.0", id: message.id, result: initializeResult() },
          { "MCP-Session-Id": "resume-session" },
        );
      }
      if (isNotificationMethod(message, "notifications/initialized")) {
        return new Response(null, { status: 202 });
      }
      if (isRequestMethod(message, "tools/list")) {
        listPostCount += 1;
        return chunkedSseResponse(["id: resume-1\nretry: 0\ndata:\n\n"]);
      }
      return new Response(null, { status: 202 });
    });
    const client = createClient(server);
    await client.connect();

    const tools = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["resumed"]);
    expect(listPostCount).toBe(1);
    expect(resumeHeaders).toEqual(["resume-1"]);
  });

  test("times out a streaming request and sends an explicit cancellation notification", async () => {
    let cancellationRequestId: unknown;
    let toolRequestAborted = false;
    const server = createServer(async (request) => {
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 200 });
      }

      const message = (await request.json()) as JsonRpcMessage;
      if (isRequestMethod(message, "initialize")) {
        return jsonResponse(
          { jsonrpc: "2.0", id: message.id, result: initializeResult() },
          { "MCP-Session-Id": "timeout-session" },
        );
      }
      if (isNotificationMethod(message, "notifications/initialized")) {
        return new Response(null, { status: 202 });
      }
      if (isNotificationMethod(message, "notifications/cancelled")) {
        cancellationRequestId = message.params?.requestId;
        return new Response(null, { status: 202 });
      }
      if (isRequestMethod(message, "tools/call")) {
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              toolRequestAborted = true;
              resolve(new Response(null, { status: 499 }));
            },
            { once: true },
          );
        });
      }
      return new Response(null, { status: 202 });
    });
    const client = createClient(server, { requestTimeoutMs: 20 });
    await client.connect();

    await expect(client.callTool("slow")).rejects.toBeInstanceOf(McpRequestTimeoutError);
    await waitFor(() => cancellationRequestId !== undefined);
    expect(cancellationRequestId).toBe(2);
    await waitFor(() => toolRequestAborted);
  });

  test("does not fall back to the deprecated legacy SSE transport", async () => {
    let getCount = 0;
    const server = createServer((request) => {
      if (request.method === "GET") {
        getCount += 1;
      }
      return new Response(null, { status: 405, statusText: "Method Not Allowed" });
    });
    const client = createClient(server);

    await expect(client.connect()).rejects.toThrow("405 Method Not Allowed");
    expect(getCount).toBe(0);
  });

  test("rejects invalid session IDs and oversized SSE events", async () => {
    const invalidSessionServer = createServer(async (request) => {
      const message = (await request.json()) as JsonRpcMessage;
      return jsonResponse(
        { jsonrpc: "2.0", id: "id" in message ? message.id : 1, result: initializeResult() },
        { "MCP-Session-Id": "invalid session" },
      );
    });
    const invalidSessionClient = createClient(invalidSessionServer);

    await expect(invalidSessionClient.connect()).rejects.toThrow("invalid MCP-Session-Id");

    const oversizedServer = createServer(async (request) => {
      if (request.method === "GET") {
        return new Response(null, { status: 405 });
      }
      const message = (await request.json()) as JsonRpcMessage;
      if (isRequestMethod(message, "initialize")) {
        return jsonResponse({ jsonrpc: "2.0", id: message.id, result: initializeResult() });
      }
      if (isNotificationMethod(message, "notifications/initialized")) {
        return new Response(null, { status: 202 });
      }
      if (isRequestMethod(message, "tools/list")) {
        return chunkedSseResponse([
          sseEvent({
            data: {
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [toolDefinition("x".repeat(600))] },
            },
          }),
        ]);
      }
      return new Response(null, { status: 202 });
    });
    const oversizedClient = createClient(oversizedServer, { maxMessageBytes: 512 });
    await oversizedClient.connect();

    await expect(oversizedClient.listTools()).rejects.toThrow("SSE event exceeds the 512-byte");
  });
});

type CreateClientOptions = Partial<StreamableHttpTransportOptions> & {
  requestTimeoutMs?: number;
  onNotification?(method: string): void;
};

function createClient(server: Bun.Server<unknown>, options: CreateClientOptions = {}): McpClient {
  const transport = new StreamableHttpTransport({
    url: `http://127.0.0.1:${server.port}/mcp`,
    headers: options.headers,
    maxMessageBytes: options.maxMessageBytes,
    closeTimeoutMs: options.closeTimeoutMs,
  });
  const client = new McpClient({
    transport,
    clientInfo: { name: "kana-test", version: "1.0.0" },
    initializeTimeoutMs: 1_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    onNotification: (notification) => options.onNotification?.(notification.method),
  });
  clients.add(client);
  return client;
}

function createServer(
  fetchHandler: (request: Request) => Response | Promise<Response>,
): Bun.Server<unknown> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: fetchHandler,
  });
  servers.add(server);
  return server;
}

type ReceivedRequest = {
  httpMethod: string;
  rpcMethod?: string;
  message?: JsonRpcMessage;
  sessionId: string | null;
  protocolVersion: string | null;
  accept: string | null;
  authorization: string | null;
};

async function recordRequest(request: Request): Promise<ReceivedRequest> {
  const message =
    request.method === "POST" ? ((await request.json()) as JsonRpcMessage) : undefined;
  return {
    httpMethod: request.method,
    ...(message === undefined ? {} : { message }),
    ...(message && "method" in message ? { rpcMethod: message.method } : {}),
    sessionId: request.headers.get("MCP-Session-Id"),
    protocolVersion: request.headers.get("MCP-Protocol-Version"),
    accept: request.headers.get("Accept"),
    authorization: request.headers.get("Authorization"),
  };
}

function initializeResult(): JsonObject {
  return {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: { name: "fake-http-server", version: "1.0.0" },
  };
}

function toolDefinition(name: string): JsonObject {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", additionalProperties: false },
  };
}

function isRequestMethod(message: JsonRpcMessage, method: string): message is JsonRpcRequest {
  return "method" in message && "id" in message && message.method === method;
}

function isNotificationMethod(
  message: JsonRpcMessage,
  method: string,
): message is JsonRpcNotification {
  return "method" in message && !("id" in message) && message.method === method;
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function chunkedSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}

function openSseStream(signal: AbortSignal, initialEvents: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of initialEvents) {
          controller.enqueue(encoder.encode(event));
        }
        signal.addEventListener("abort", () => controller.close(), { once: true });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function sseEvent(options: { id?: string; data: unknown }): string {
  return `${options.id === undefined ? "" : `id: ${options.id}\n`}data: ${JSON.stringify(options.data)}\n\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fake Streamable HTTP server state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
