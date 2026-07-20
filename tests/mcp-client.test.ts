import { describe, expect, test } from "bun:test";
import {
  type JsonObject,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  McpClient,
  McpProtocolError,
  McpRequestCancelledError,
  McpRequestTimeoutError,
  McpResponseError,
  type McpTransport,
  type McpTransportHandlers,
} from "../src/mcp";

class MemoryTransport implements McpTransport {
  readonly sent: JsonRpcMessage[] = [];
  closed = false;
  onSend?: (message: JsonRpcMessage) => void;
  private handlers?: McpTransportHandlers;

  async start(handlers: McpTransportHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    this.onSend?.(message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.handlers?.onClose({});
  }

  emit(message: unknown): void {
    this.handlers?.onMessage(message);
  }
}

describe("MCP client", () => {
  test("performs the 2025-11-25 initialization lifecycle", async () => {
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport);

    const result = await client.connect();

    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
    expect(transport.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "kana-test", version: "1.0.0" },
      },
    });
    expect(transport.sent[1]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(client.connected).toBe(true);

    await client.close();
  });

  test("rejects an unsupported negotiated protocol version", async () => {
    const transport = new MemoryTransport();
    respondToInitialize(transport, "2024-11-05");
    const client = createClient(transport);

    await expect(client.connect()).rejects.toBeInstanceOf(McpProtocolError);
    expect(transport.closed).toBe(true);
  });

  test("paginates tools and delivers increasing call progress", async () => {
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport);
    await client.connect();

    transport.onSend = (message) => {
      if (!("method" in message) || !("id" in message)) {
        return;
      }

      if (message.method === "tools/list") {
        const cursor = message.params?.cursor;
        transport.emit({
          jsonrpc: "2.0",
          id: message.id,
          result:
            cursor === undefined
              ? { tools: [toolDefinition("one")], nextCursor: "next" }
              : { tools: [toolDefinition("two")] },
        });
      }

      if (message.method === "tools/call") {
        const meta = message.params?._meta as JsonObject;
        transport.emit({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: meta.progressToken, progress: 1, total: 2 },
        });
        transport.emit({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: meta.progressToken, progress: 2, total: 2 },
        });
        transport.emit({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "done" }],
            structuredContent: { ok: true },
          },
        });
      }
    };

    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["one", "two"]);

    const progress: number[] = [];
    const result = await client.callTool(
      "one",
      { value: 1 },
      { onProgress: (update) => progress.push(update.progress) },
    );
    expect(progress).toEqual([1, 2]);
    expect(result.structuredContent).toEqual({ ok: true });

    await client.close();
  });

  test("turns JSON-RPC errors into typed response errors", async () => {
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport);
    await client.connect();

    transport.onSend = (message) => {
      if (isRequest(message, "tools/call")) {
        transport.emit({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Unknown tool" },
        });
      }
    };

    const error = await client.callTool("missing").catch((cause) => cause);
    expect(error).toBeInstanceOf(McpResponseError);
    expect(error.code).toBe(-32602);

    await client.close();
  });

  test("correlates concurrent responses that arrive out of order", async () => {
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport);
    await client.connect();

    const requests: JsonRpcRequest[] = [];
    transport.onSend = (message) => {
      if (!isRequest(message, "tools/call")) {
        return;
      }

      requests.push(message);
      if (requests.length === 2) {
        for (const request of [...requests].reverse()) {
          transport.emit({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: request.params?.name }],
            },
          });
        }
      }
    };

    const [first, second] = await Promise.all([
      client.callTool("first"),
      client.callTool("second"),
    ]);
    expect(first.content).toEqual([{ type: "text", text: "first" }]);
    expect(second.content).toEqual([{ type: "text", text: "second" }]);

    await client.close();
  });

  test("reports duplicate responses without breaking the connection", async () => {
    const errors: Error[] = [];
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport, { onError: (error) => errors.push(error) });
    await client.connect();

    let response: JsonObject | undefined;
    transport.onSend = (message) => {
      if (!isRequest(message, "tools/call")) {
        return;
      }

      response = {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [] },
      };
      transport.emit(response);
    };

    await client.callTool("once");
    transport.emit(response);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(McpProtocolError);
    expect(client.connected).toBe(true);

    await client.close();
  });

  test("rejects repeated pagination cursors", async () => {
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport);
    await client.connect();

    transport.onSend = (message) => {
      if (isRequest(message, "tools/list")) {
        transport.emit({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [], nextCursor: "same" },
        });
      }
    };

    await expect(client.listTools()).rejects.toThrow("repeated tools/list cursor same");

    await client.close();
  });

  test("times out calls, notifies the server, and ignores late responses", async () => {
    const errors: Error[] = [];
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport, {
      requestTimeoutMs: 10,
      onError: (error) => errors.push(error),
    });
    await client.connect();

    transport.onSend = () => {};
    const call = client.callTool("slow");
    await expect(call).rejects.toBeInstanceOf(McpRequestTimeoutError);

    const request = transport.sent.find((message) => isRequest(message, "tools/call"));
    const cancellation = transport.sent.find(
      (message): message is JsonRpcNotification =>
        "method" in message && message.method === "notifications/cancelled",
    );
    expect(cancellation?.params?.requestId).toBe(request?.id);

    transport.emit({ jsonrpc: "2.0", id: request?.id, result: { content: [] } });
    expect(errors).toEqual([]);

    await client.close();
  });

  test("does not send a cancellation notification for initialize timeouts", async () => {
    const transport = new MemoryTransport();
    const client = createClient(transport, { initializeTimeoutMs: 10 });

    await expect(client.connect()).rejects.toBeInstanceOf(McpRequestTimeoutError);
    expect(
      transport.sent.some(
        (message) => "method" in message && message.method === "notifications/cancelled",
      ),
    ).toBe(false);
  });

  test("maps AbortSignal cancellation and responds to server requests", async () => {
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport);
    await client.connect();

    transport.emit({ jsonrpc: "2.0", id: "ping-1", method: "ping" });
    transport.emit({ jsonrpc: "2.0", id: "unknown-1", method: "sampling/createMessage" });
    expect(transport.sent).toContainEqual({ jsonrpc: "2.0", id: "ping-1", result: {} });
    expect(transport.sent).toContainEqual({
      jsonrpc: "2.0",
      id: "unknown-1",
      error: { code: -32601, message: "Method not found: sampling/createMessage" },
    });

    transport.onSend = () => {};
    const controller = new AbortController();
    const call = client.callTool("slow", {}, { signal: controller.signal });
    controller.abort(new Error("stop now"));
    await expect(call).rejects.toBeInstanceOf(McpRequestCancelledError);

    await client.close();
  });

  test("fails closed on malformed JSON-RPC messages", async () => {
    const errors: Error[] = [];
    const transport = new MemoryTransport();
    respondToInitialize(transport);
    const client = createClient(transport, { onError: (error) => errors.push(error) });
    await client.connect();

    transport.emit({ jsonrpc: "2.0", id: null, result: {} });

    expect(client.connected).toBe(false);
    expect(transport.closed).toBe(true);
    expect(errors[0]).toBeInstanceOf(McpProtocolError);
  });
});

function createClient(
  transport: MemoryTransport,
  options: Partial<ConstructorParameters<typeof McpClient>[0]> = {},
): McpClient {
  return new McpClient({
    transport,
    clientInfo: { name: "kana-test", version: "1.0.0" },
    ...options,
  });
}

function respondToInitialize(transport: MemoryTransport, protocolVersion = "2025-11-25"): void {
  transport.onSend = (message) => {
    if (!isRequest(message, "initialize")) {
      return;
    }

    transport.emit({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "test-server", version: "1.0.0" },
      },
    });
  };
}

function isRequest(message: JsonRpcMessage, method: string): message is JsonRpcRequest {
  return "method" in message && "id" in message && message.method === method;
}

function toolDefinition(name: string): JsonObject {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
  };
}
