import { describe, expect, test } from "bun:test";
import { McpServerManager, type McpServerManagerDecision } from "../src/tui/components";
import { color, stripAnsi } from "../src/tui/render";
import { tuiTheme } from "../src/tui/theme";

describe("MCP server manager", () => {
  test("renders safe server details and interaction help", () => {
    const manager = new McpServerManager(
      [
        {
          id: "filesystem\nspoofed",
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem\nspoofed", "\x1b[31m/workspace"],
          enabled: true,
        },
        {
          id: "github",
          type: "stdio",
          command: "/usr/local/bin/github-mcp",
          args: [],
          enabled: false,
        },
      ],
      () => {},
    );

    const rawRendered = manager.render(80);
    const rendered = rawRendered.map(stripAnsi);

    expect(rawRendered[0]).toBe(color("MCP servers", tuiTheme.bottomTitle));
    expect(rendered).toContain("> [x] filesystem spoofed  stdio");
    expect(rendered).toContain(
      "  command: npx -y @modelcontextprotocol/server-filesystem spoofed /workspace",
    );
    expect(rendered).toContain("  [ ] github  stdio");
    expect(rendered).toContain("Enter toggle · Esc apply and close");
    expect(rendered.every((line) => !line.includes("\n") && !line.includes("\r"))).toBe(true);
  });

  test("keeps toggles as a draft until escape applies once", () => {
    const decisions: McpServerManagerDecision[] = [];
    const manager = new McpServerManager(
      [
        { id: "filesystem", type: "stdio", command: "npx", args: ["-y"], enabled: false },
        { id: "github", type: "stdio", command: "github-mcp", args: [], enabled: true },
      ],
      (decision) => decisions.push(decision),
    );

    manager.handleInput("\r");
    manager.handleInput("\x1b[B");
    manager.handleInput("\r");
    expect(decisions).toEqual([]);

    manager.handleInput("\x1b");
    expect(decisions).toEqual([
      {
        type: "apply",
        enabledServerIds: ["filesystem"],
        changed: true,
      },
    ]);
  });

  test("reports an unchanged draft and renders an empty configuration", () => {
    let decision: McpServerManagerDecision | undefined;
    const manager = new McpServerManager([], (nextDecision) => {
      decision = nextDecision;
    });

    expect(manager.render(80).map(stripAnsi)).toEqual([
      "MCP servers",
      "No MCP servers configured in mcp.json.",
      "Esc close",
    ]);

    manager.handleInput("\x1b");
    expect(decision).toEqual({ type: "apply", enabledServerIds: [], changed: false });
  });
});
