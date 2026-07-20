import { describe, expect, test } from "bun:test";
import {
  formatMcpLifecycleStatus,
  formatMcpStartupSummary,
  formatMcpStartupWarnings,
} from "../src/tui/mcp-lifecycle-status";

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

  test("formats failed-server diagnostics as safe persistent warnings", () => {
    expect(
      formatMcpStartupWarnings([
        {
          id: "filesystem\nspoofed",
          required: false,
          status: "failed",
          discoveredToolCount: 0,
          toolCount: 0,
          error: { name: "Error", message: "process\nexited" },
        },
        {
          id: "github",
          required: false,
          status: "ready",
          discoveredToolCount: 2,
          toolCount: 2,
        },
      ]),
    ).toEqual(["MCP server filesystem spoofed failed to start: process exited"]);
  });

  test("summarizes the final ready-server and tool counts", () => {
    const diagnostics = [
      {
        id: "filesystem",
        required: false,
        status: "ready" as const,
        discoveredToolCount: 2,
        toolCount: 2,
      },
      {
        id: "optional",
        required: false,
        status: "failed" as const,
        discoveredToolCount: 0,
        toolCount: 0,
      },
    ];

    expect(formatMcpStartupSummary(diagnostics, 2)).toBe(
      "MCP startup complete: 1/2 servers ready · 2 tools",
    );
    expect(formatMcpStartupSummary(diagnostics.slice(0, 1), 1)).toBe(
      "MCP startup complete: 1/1 servers ready · 1 tool",
    );
  });
});
