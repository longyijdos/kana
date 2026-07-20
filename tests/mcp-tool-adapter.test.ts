import { describe, expect, test } from "bun:test";
import {
  createMcpToolAdapter,
  createMcpToolAlias,
  type JsonObject,
  McpResponseError,
  type McpToolCaller,
  McpToolSchemaError,
  normalizeMcpToolResult,
} from "../src/mcp";
import { validateToolArguments } from "../src/tools";

describe("MCP tool adapter", () => {
  test("creates readable provider-safe aliases", () => {
    const alias = createMcpToolAlias("GitHub Server", "admin.tools/create issue");

    expect(alias).toBe("github_server_admin_tools_create_issue");
    expect(alias).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(alias).toBe(createMcpToolAlias("GitHub Server", "admin.tools/create issue"));
    expect(alias).not.toBe(createMcpToolAlias("another-server", "admin.tools/create issue"));
    expect(createMcpToolAlias("s".repeat(200), "t".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  test("validates arguments, calls the remote name, and maps progress", async () => {
    const calls: Array<{ name: string; args: JsonObject | undefined; signal?: AbortSignal }> = [];
    const updates: unknown[] = [];
    const controller = new AbortController();
    const caller: McpToolCaller = {
      async callTool(name, args, options) {
        calls.push({ name, args, signal: options?.signal });
        options?.onProgress?.({
          progressToken: "remote-token",
          progress: 1,
          total: 2,
          message: "working",
        });
        return {
          content: [{ type: "text", text: "done" }],
          structuredContent: { count: args?.count ?? null },
        };
      },
    };
    const tool = createMcpToolAdapter({
      serverId: "github",
      caller,
      tool: {
        name: "create.issue",
        description: "Create an issue.",
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
    });
    const args = validateToolArguments(tool, { count: "2" });

    const result = await tool.execute(args, {
      toolCallId: "call-1",
      signal: controller.signal,
      update: (partial) => updates.push(partial),
    });

    expect(tool.name).toBe("github_create_issue");
    expect(tool.description).toContain("MCP server: github; remote tool: create.issue.");
    expect(calls).toEqual([
      { name: "create.issue", args: { count: 2 }, signal: controller.signal },
    ]);
    expect(updates).toEqual([
      {
        source: "mcp",
        serverId: "github",
        remoteToolName: "create.issue",
        progress: 1,
        total: 2,
        message: "working",
      },
    ]);
    expect(result.content).toBe("done");
    expect(result.result.structuredContent).toEqual({ count: 2 });
  });

  test("rejects input schemas that cannot be compiled", () => {
    expect(() =>
      createMcpToolAdapter({
        serverId: "broken",
        caller: createStaticCaller(),
        tool: {
          name: "invalid-pattern",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: "string", pattern: "[" },
            },
          },
        },
      }),
    ).toThrow(McpToolSchemaError);
  });

  test("normalizes resources and omits binary payloads", () => {
    const encodedImage = "aGVsbG8=";
    const encodedBlob = "AAEC";
    const normalized = normalizeMcpToolResult(
      {
        content: [
          { type: "text", text: "hello" },
          {
            type: "resource_link",
            uri: "file:///project/report.md",
            name: "report.md",
            mimeType: "text/markdown",
          },
          {
            type: "resource",
            resource: {
              uri: "file:///project/data.bin",
              mimeType: "application/octet-stream",
              blob: encodedBlob,
            },
          },
          { type: "image", data: encodedImage, mimeType: "image/png" },
          { type: "future_content", secret: encodedImage },
        ],
        structuredContent: { ok: true },
      },
      { serverId: "files", remoteToolName: "inspect" },
    );

    expect(normalized.content).toContain("hello");
    expect(normalized.content).toContain("MCP resource link");
    expect(normalized.content).toContain("MCP image omitted: image/png, 5 bytes");
    expect(normalized.result.content).toContainEqual({
      type: "binary",
      contentType: "image",
      mimeType: "image/png",
      bytes: 5,
      omitted: true,
    });
    expect(normalized.result.content).toContainEqual({
      type: "resource",
      uri: "file:///project/data.bin",
      mimeType: "application/octet-stream",
      blobBytes: 3,
    });
    expect(JSON.stringify(normalized.result)).not.toContain(encodedImage);
    expect(JSON.stringify(normalized.result)).not.toContain(encodedBlob);
  });

  test("bounds text, item count, structured content, and model content", () => {
    const normalized = normalizeMcpToolResult(
      {
        content: [
          { type: "text", text: "abcdefgh" },
          { type: "text", text: "second" },
          { type: "text", text: "omitted" },
        ],
        structuredContent: { long: "structured value" },
      },
      { serverId: "limited", remoteToolName: "large" },
      {
        maxContentItems: 2,
        maxTextCharacters: 5,
        maxStructuredCharacters: 10,
        maxModelContentCharacters: 30,
        maxMetadataCharacters: 8,
      },
    );

    expect(normalized.content.length).toBeLessThanOrEqual(30);
    expect(normalized.result.omittedContentItems).toBe(1);
    expect(normalized.result.contentTruncated).toBe(true);
    expect(normalized.result.content[0]).toEqual({
      type: "text",
      text: "abcd…",
      truncated: true,
    });
    expect(normalized.result.content[1]).toEqual({ type: "text", text: "", truncated: true });
    expect(normalized.result.structuredContent).toBeUndefined();
    expect(normalized.result.structuredContentPreview?.length).toBeLessThanOrEqual(10);
    expect(normalized.result.structuredContentTruncated).toBe(true);
  });

  test("adds structured-only results to model content", () => {
    const normalized = normalizeMcpToolResult(
      { content: [], structuredContent: { answer: 42 } },
      { serverId: "data", remoteToolName: "answer" },
    );

    expect(normalized.content).toContain("Structured content:");
    expect(normalized.content).toContain('"answer": 42');
  });

  test("converts JSON-RPC errors into safe error tool results", async () => {
    const caller: McpToolCaller = {
      async callTool() {
        throw new McpResponseError(-32602, "Unknown tool", { detail: "x".repeat(100) });
      },
    };
    const tool = createMcpToolAdapter({
      serverId: "errors",
      caller,
      resultLimits: { maxStructuredCharacters: 20 },
      tool: {
        name: "missing",
        inputSchema: { type: "object" },
      },
    });

    const result = await tool.execute({}, { toolCallId: "call-1", update() {} });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("MCP server returned JSON-RPC error -32602: Unknown tool");
    expect(result.result.protocolError?.code).toBe(-32602);
    expect(result.result.protocolError?.dataPreview?.length).toBeLessThanOrEqual(20);
    expect(result.result.protocolError?.dataTruncated).toBe(true);
  });
});

function createStaticCaller(): McpToolCaller {
  return {
    async callTool() {
      return { content: [] };
    },
  };
}
