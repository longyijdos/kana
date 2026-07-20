import { describe, expect, test } from "bun:test";
import { formatMcpLifecycleStatus, McpBootstrapStatus } from "../src/tui/mcp-lifecycle-status";

describe("MCP lifecycle status", () => {
  test("formats startup and shutdown progress with the latest server outcome", () => {
    expect(
      formatMcpLifecycleStatus({
        operation: "start",
        completedServerCount: 2,
        totalServerCount: 3,
        serverId: "github",
        outcome: "ready",
      }),
    ).toBe("Starting MCP servers... 2/3 · github ready");
    expect(
      formatMcpLifecycleStatus({
        operation: "close",
        completedServerCount: 1,
        totalServerCount: 2,
        serverId: "postgres",
        outcome: "closed",
      }),
    ).toBe("Closing MCP servers... 1/2 · postgres closed");
  });

  test("does not render lifecycle status when no servers are enabled", () => {
    expect(
      formatMcpLifecycleStatus({
        operation: "start",
        completedServerCount: 0,
        totalServerCount: 0,
      }),
    ).toBeUndefined();
  });

  test("owns and clears one bootstrap terminal line", () => {
    const writes: string[] = [];
    const status = new McpBootstrapStatus({
      columns: 80,
      write: (value) => writes.push(value),
    });

    status.update({
      operation: "start",
      completedServerCount: 0,
      totalServerCount: 1,
    });
    status.update({
      operation: "start",
      completedServerCount: 1,
      totalServerCount: 1,
      serverId: "filesystem\nspoofed",
      outcome: "ready",
    });
    status.clear();
    status.clear();

    expect(writes).toEqual([
      "\r\x1b[2KStarting MCP servers... 0/1",
      "\r\x1b[2KStarting MCP servers... 1/1 · filesystem spoofed ready",
      "\r\x1b[2K",
    ]);
  });
});
