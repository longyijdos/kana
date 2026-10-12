import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { McpClient, type McpProgress, StdioClientTransport } from "@/mcp";

const clients = new Set<McpClient>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
});

describe("MCP SDK integration", () => {
  test.each(["normal", "legacy-2024", "modern"])(
    "discovers paginated tools and forwards progress with %s negotiation",
    async (scenario) => {
      const client = createClient(scenario);
      await client.connect();

      expect(client.serverInfo).toMatchObject({ name: "fake-server", version: "1.0.0" });
      expect(client.serverCapabilities).toMatchObject({ tools: {} });
      expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo", "slow"]);
      const progress: McpProgress[] = [];
      const result = await client.callTool(
        "slow",
        {},
        { onProgress: (value) => progress.push(value) },
      );
      expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      expect(progress).toEqual([
        { progress: 1, total: 2, message: "started" },
        { progress: 2, total: 2, message: "finished" },
      ]);
    },
  );

  test("aborts an in-flight SDK call without closing the client", async () => {
    const client = createClient("hang");
    await client.connect();
    const controller = new AbortController();
    const pending = client.callTool("slow", {}, { signal: controller.signal });
    controller.abort(new Error("Cancelled by test"));

    await expect(pending).rejects.toThrow("Cancelled by test");
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo", "slow"]);
  });
});

function createClient(scenario: string): McpClient {
  const client = new McpClient({
    transport: new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("tests/fixtures/mcp-stdio-server.ts")],
      env: { KANA_TEST_MCP_SCENARIO: scenario },
      stderr: "ignore",
    }),
    clientInfo: { name: "kana-test", version: "1.0.0" },
    initializeTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
  });
  clients.add(client);
  return client;
}
