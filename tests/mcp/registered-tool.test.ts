import { describe, expect, test } from "bun:test";
import {
  createRegisteredMcpTool,
  type JsonObject,
  McpResponseError,
  type McpToolCaller,
  McpToolSchemaError,
  normalizeMcpToolResult,
} from "../../src/mcp";
import { validateToolArguments } from "../../src/tools";

describe("Registered MCP tools", () => {
  test("validates arguments, calls the remote name, and maps progress", async () => {
    const calls: Array<{ name: string; args: JsonObject | undefined; signal?: AbortSignal }> = [];
    const updates: unknown[] = [];
    const controller = new AbortController();
    const caller: McpToolCaller = {
      async callTool(name, args, options) {
        calls.push({ name, args, signal: options?.signal });
        options?.onProgress?.({
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
    const tool = createRegisteredMcpTool({
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

    expect(tool.name).toBe("create.issue");
    expect(tool.description).toBe("Create an issue.");
    expect(tool.source).toEqual({ serverId: "github", remoteToolName: "create.issue" });
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
    expect(result.result).toEqual({ count: 2 });
  });

  test("rejects input schemas that cannot be compiled", () => {
    expect(() =>
      createRegisteredMcpTool({
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
    const normalized = normalizeMcpToolResult({
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
    });

    expect(normalized.content).toContain("hello");
    expect(normalized.content).toContain("MCP resource link");
    expect(normalized.content).toContain("MCP image omitted: image/png, 5 bytes");
    expect(normalized.content).toContain(
      "MCP binary resource omitted: file:///project/data.bin: application/octet-stream, 3 bytes",
    );
    expect(normalized.result).toEqual({ ok: true });
    expect(JSON.stringify(normalized.result)).not.toContain(encodedImage);
    expect(JSON.stringify(normalized.result)).not.toContain(encodedBlob);
  });

  test("preserves all text, content items, metadata and structured data before common finalization", () => {
    const text = "x".repeat(50_000);
    const metadata = "m".repeat(600);
    const structuredContent = {
      entries: Array.from({ length: 100 }, (_, index) => ({ index, text })),
    };
    const normalized = normalizeMcpToolResult({
      content: [
        { type: "text", text },
        ...Array.from({ length: 70 }, (_, index) => ({ type: "text", text: `item-${index}` })),
        { type: "resource_link", uri: "file:///report", name: metadata, description: metadata },
        { type: "resource", resource: { uri: "file:///text", text } },
      ],
      structuredContent,
    });

    expect(normalized.content).toStartWith(text);
    expect(normalized.content).toContain("item-69");
    expect(normalized.content).toContain(metadata);
    expect(normalized.content).toEndWith(text);
    expect(normalized.result).toEqual(structuredContent);
  });

  test("uses formatted text as the result without structured content", () => {
    const text = "x".repeat(50_000);
    const normalized = normalizeMcpToolResult({ content: [{ type: "text", text }] });
    expect(normalized).toEqual({ content: text, result: text, isError: false });
    const empty = normalizeMcpToolResult({ content: [] });
    expect(empty.result).toBe(empty.content);
  });

  test("adds structured-only results to model content", () => {
    const normalized = normalizeMcpToolResult({ content: [], structuredContent: { answer: 42 } });

    expect(normalized.content).toContain("Structured content:");
    expect(normalized.content).toContain('"answer": 42');
    expect(normalized.result).toEqual({ answer: 42 });
  });

  test("converts JSON-RPC errors into formatted error results without truncating data", async () => {
    const caller: McpToolCaller = {
      async callTool() {
        throw new McpResponseError(-32602, "Unknown tool", { detail: "x".repeat(100) });
      },
    };
    const tool = createRegisteredMcpTool({
      serverId: "errors",
      caller,
      tool: {
        name: "missing",
        inputSchema: { type: "object" },
      },
    });

    const result = await tool.execute({}, { toolCallId: "call-1", update() {} });

    expect(tool.description).toBe("");
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith("MCP server returned JSON-RPC error -32602: Unknown tool");
    expect(result.content).toContain("x".repeat(100));
    expect(result.result).toBe(result.content);
  });
});

function createStaticCaller(): McpToolCaller {
  return {
    async callTool() {
      return { content: [] };
    },
  };
}
