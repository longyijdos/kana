import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  McpClient,
  McpConnectionClosedError,
  McpProtocolError,
  McpRequestTimeoutError,
  StdioTransport,
  type StdioTransportOptions,
} from "../src/mcp";

const clients = new Set<McpClient>();
const fixturePath = path.resolve("tests/fixtures/mcp-stdio-server.ts");

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});

describe("MCP stdio transport", () => {
  test("handles chunked responses, paginated tools, combined progress, and stderr", async () => {
    const stderr: string[] = [];
    const client = createStdioClient("chunked", { onStderr: (content) => stderr.push(content) });

    const initializeResult = await client.connect();
    expect(initializeResult.serverInfo.name).toBe("fake-server");
    expect(stderr.join("")).toContain("fake MCP server started");

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "slow"]);

    const progress: number[] = [];
    const result = await client.callTool(
      "slow",
      { value: 42 },
      { onProgress: (update) => progress.push(update.progress) },
    );
    expect(progress).toEqual([1, 2]);
    expect(result.structuredContent).toEqual({ value: 42 });
  });

  test("rejects protocol version mismatches and closes the process", async () => {
    const client = createStdioClient("version-mismatch");

    await expect(client.connect()).rejects.toBeInstanceOf(McpProtocolError);
    expect(client.connected).toBe(false);
  });

  test("fails closed when stdout contains invalid JSON", async () => {
    const errors: Error[] = [];
    const client = createStdioClient("malformed", {}, (error) => errors.push(error));

    await expect(client.connect()).rejects.toThrow("invalid JSON");
    expect(errors.some((error) => error.message.includes("invalid JSON"))).toBe(true);
  });

  test("enforces the maximum stdout line size", async () => {
    const client = createStdioClient("oversized", { maxMessageBytes: 512 });

    await expect(client.connect()).rejects.toThrow("512-byte limit");
  });

  test("rejects pending calls when the server exits", async () => {
    const client = createStdioClient("exit-on-call");
    await client.connect();

    await expect(client.callTool("echo")).rejects.toBeInstanceOf(McpConnectionClosedError);
  });

  test("sends cancellation over stdio after a request timeout", async () => {
    const notifications: string[] = [];
    const client = createStdioClient(
      "hang",
      {},
      undefined,
      (notification) => notifications.push(notification.method),
      20,
    );
    await client.connect();

    await expect(client.callTool("slow")).rejects.toBeInstanceOf(McpRequestTimeoutError);
    await waitFor(() => notifications.includes("notifications/test/cancelled"));
  });
});

function createStdioClient(
  scenario: string,
  transportOptions: Partial<StdioTransportOptions> = {},
  onError?: (error: Error) => void,
  onNotification?: (notification: { method: string }) => void,
  requestTimeoutMs = 1_000,
): McpClient {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [fixturePath],
    env: { ...process.env, KANA_TEST_MCP_SCENARIO: scenario },
    shutdownTimeoutMs: 100,
    killTimeoutMs: 100,
    ...transportOptions,
  });
  const client = new McpClient({
    transport,
    clientInfo: { name: "kana-test", version: "1.0.0" },
    initializeTimeoutMs: 1_000,
    requestTimeoutMs,
    onError,
    onNotification,
  });
  clients.add(client);
  return client;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fake MCP server notification.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
