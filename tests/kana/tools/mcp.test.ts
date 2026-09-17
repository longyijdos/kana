import { afterEach, describe, expect, mock, test } from "bun:test";
import { type McpManagedClient, McpManager, type McpServerRegistration, type McpTool } from "@/mcp";
import { normalizeToolResult, type ToolContext } from "@/tools";
import { createMcpTools } from "../../../src/kana/tools";

const managers = new Set<McpManager>();
const context: ToolContext = { toolCallId: "call-1", update() {} };

afterEach(async () => {
  await Promise.all([...managers].map((manager) => manager.close()));
  managers.clear();
});

describe("MCP gateway tools", () => {
  test("loads filtered, paginated schemas repeatedly without changing provider tools", async () => {
    const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    const tools: McpTool[] = [
      { name: "read", description: "Read a file.", inputSchema: schema },
      { name: "mcp_call", inputSchema: { type: "object" } },
      { name: "hidden", inputSchema: { type: "object" } },
    ];
    const manager = await createManager([
      {
        id: "alpha",
        description: "GitHub issues.",
        excludeTools: ["hidden"],
        createClient: () => client(tools),
      },
      { id: "beta", createClient: () => client([tools[0]!]) },
    ]);
    const gateways = createMcpTools(manager);
    const [listTools] = gateways;
    const specs = JSON.stringify(gateways);
    expect(gateways.map((tool) => tool.name)).toEqual(["mcp_list_tools", "mcp_call"]);
    expect(listTools!.description).toContain("- alpha: GitHub issues.");
    expect(listTools!.description).toContain("- beta: Server-provided summary.");

    const firstPage = await listTools!.execute({ name: "alpha", limit: 1 }, context);
    expect(firstPage).toMatchObject({
      server: "alpha",
      tools: [{ name: "read", description: "Read a file.", inputSchema: schema }],
      nextOffset: 1,
    });
    expect(await listTools!.execute({ name: "alpha", offset: 1, limit: 1 }, context)).toMatchObject(
      {
        tools: [{ name: "mcp_call" }],
      },
    );
    expect(await listTools!.execute({ name: "alpha", limit: 1 }, context)).toEqual(firstPage);
    expect(JSON.stringify(gateways)).toBe(specs);
    expect(await listTools!.execute({ name: "alpha" }, context)).toMatchObject({
      tools: [{ name: "read" }, { name: "mcp_call" }],
    });
    expect(() => listTools!.execute({ name: "missing" }, context)).toThrow("not available");
  });

  test("validates the remote schema and resolves calls by server and original name", async () => {
    const remoteTool: McpTool = {
      name: "read",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    };
    const alphaCall = mock<McpManagedClient["callTool"]>(async () => ({
      content: [{ type: "text", text: "alpha" }],
    }));
    const betaCall = mock<McpManagedClient["callTool"]>(async () => ({
      content: [{ type: "text", text: "beta" }],
    }));
    const manager = await createManager([
      { id: "alpha", createClient: () => client([remoteTool], alphaCall) },
      { id: "beta", createClient: () => client([remoteTool], betaCall) },
    ]);
    const call = createMcpTools(manager)[1]!;

    await expect(
      call.execute({ server: "alpha", tool: "read", arguments: {} }, context),
    ).rejects.toThrow();
    await expect(
      call.execute(
        { server: "alpha", tool: "read", arguments: { title: "Bug", extra: true } },
        context,
      ),
    ).rejects.toThrow("extra");
    await expect(
      call.execute({ server: "alpha", tool: "missing", arguments: {} }, context),
    ).rejects.toThrow("not available");
    expect(alphaCall).not.toHaveBeenCalled();
    const result = normalizeToolResult(
      await call.execute({ server: "beta", tool: "read", arguments: { title: "Bug" } }, context),
    );
    expect(result.content).toBe("beta");
    expect(betaCall.mock.calls[0]!.slice(0, 2)).toEqual(["read", { title: "Bug" }]);
    expect(alphaCall).not.toHaveBeenCalled();
  });

  test("forwards invocation cancellation, progress and normalized remote errors", async () => {
    const controller = new AbortController();
    const updates: unknown[] = [];
    const remoteCall: McpManagedClient["callTool"] = async (_name, _args, options) => {
      expect(options?.signal).toBe(controller.signal);
      options?.onProgress?.({ progress: 1, total: 2 });
      return { content: [], structuredContent: [{ error: "Failed" }], isError: true };
    };
    const manager = await createManager([
      {
        id: "alpha",
        createClient: () => client([{ name: "read", inputSchema: { type: "object" } }], remoteCall),
      },
    ]);
    const result = normalizeToolResult(
      await createMcpTools(manager)[1]!.execute(
        {
          server: "alpha",
          tool: "read",
          arguments: {},
        },
        { ...context, signal: controller.signal, update: (value) => updates.push(value) },
      ),
    );

    expect(updates).toEqual([
      { source: "mcp", serverId: "alpha", remoteToolName: "read", progress: 1, total: 2 },
    ]);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"error": "Failed"');
    expect(result.result).toMatchObject({
      serverId: "alpha",
      remoteToolName: "read",
      structuredContent: [{ error: "Failed" }],
    });
  });
});

async function createManager(servers: McpServerRegistration[]): Promise<McpManager> {
  const manager = new McpManager({ servers });
  managers.add(manager);
  await manager.start();
  return manager;
}

function client(
  tools: McpTool[],
  callTool: McpManagedClient["callTool"] = async () => ({ content: [] }),
): McpManagedClient {
  return {
    serverInfo: { name: "fake-server", version: "1.0.0", description: "Server-provided summary." },
    async connect() {},
    async close() {},
    async listTools() {
      return tools;
    },
    callTool,
  };
}
