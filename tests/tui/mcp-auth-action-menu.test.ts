import { describe, expect, test } from "bun:test";
import { McpAuthActionMenu, type McpAuthActionMenuDecision } from "../../src/tui/components";
import { stripAnsi } from "../../src/tui/render";

describe("MCP OAuth action menu", () => {
  test("offers authorization for an unauthorized server", () => {
    const decisions: McpAuthActionMenuDecision[] = [];
    const menu = new McpAuthActionMenu(
      "github\nspoofed",
      { type: "oauth2", state: "unauthorized", refreshable: false },
      (decision) => decisions.push(decision),
    );

    expect(menu.render(80).map(stripAnsi)).toEqual([
      "MCP OAuth · github spoofed",
      "Status: unauthorized",
      "> Authorize",
      "Enter select · Esc back",
    ]);
    menu.handleInput("\r");
    expect(decisions).toEqual([{ type: "action", action: "authorize" }]);
  });

  test("offers reauthorization and sign-out and lets Escape cancel active work", () => {
    const decisions: McpAuthActionMenuDecision[] = [];
    const menu = new McpAuthActionMenu(
      "github",
      { type: "oauth2", state: "authorized", refreshable: true },
      (decision) => decisions.push(decision),
    );

    menu.handleInput("\x1b[B");
    menu.handleInput("\r");
    expect(decisions).toEqual([{ type: "action", action: "sign_out" }]);

    menu.setOperation("Waiting for browser authorization...");
    expect(menu.render(80).map(stripAnsi)).toContain("Esc cancel");
    menu.handleInput("\x1b");
    expect(decisions.at(-1)).toEqual({ type: "cancel_operation" });
  });
});
