import { color, dim, stripTerminalControlSequences, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import type { McpServerOAuthStatus } from "./mcp-server-manager";

export type McpAuthAction = "authorize" | "reauthorize" | "sign_out";

export type McpAuthActionMenuDecision =
  | { type: "action"; action: McpAuthAction }
  | { type: "back" }
  | { type: "cancel_operation" };

type McpAuthActionOption = {
  action: McpAuthAction;
  label: string;
};

export class McpAuthActionMenu implements Component {
  private readonly actions: McpAuthActionOption[];
  private selectedIndex = 0;
  private operation?: string;

  constructor(
    private readonly serverId: string,
    status: McpServerOAuthStatus,
    private readonly finish: (decision: McpAuthActionMenuDecision) => void,
  ) {
    this.actions =
      status.state === "unauthorized"
        ? [{ action: "authorize", label: "Authorize" }]
        : [
            { action: "reauthorize", label: "Reauthorize" },
            { action: "sign_out", label: "Sign out and disable" },
          ];
    this.status = { ...status };
  }

  private status: McpServerOAuthStatus;

  setOperation(operation: string | undefined): void {
    this.operation = operation;
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      this.finish({ type: this.operation === undefined ? "back" : "cancel_operation" });
      return;
    }
    if (this.operation !== undefined) {
      return;
    }
    if (isUp(data)) {
      this.move(-1);
      return;
    }
    if (isDown(data)) {
      this.move(1);
      return;
    }
    if (isEnter(data)) {
      const selected = this.actions[this.selectedIndex];
      if (selected !== undefined) {
        this.finish({ type: "action", action: selected.action });
      }
    }
  }

  render(width: number): string[] {
    const lines = [
      color(`MCP OAuth · ${formatLabel(this.serverId)}`, tuiTheme.bottomTitle),
      dim(`Status: ${formatStatus(this.status)}`),
    ];

    if (this.operation !== undefined) {
      lines.push(color(this.operation, tuiTheme.user), dim("Esc cancel"));
      return lines.map((line) => truncateToWidth(line, width, ""));
    }

    for (const [index, action] of this.actions.entries()) {
      const line = `${index === this.selectedIndex ? "> " : "  "}${action.label}`;
      lines.push(index === this.selectedIndex ? color(line, tuiTheme.user) : line);
    }
    lines.push(dim("Enter select · Esc back"));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private move(delta: number): void {
    this.selectedIndex = (this.selectedIndex + delta + this.actions.length) % this.actions.length;
  }
}

function formatStatus(status: McpServerOAuthStatus): string {
  return status.state === "expired" && status.refreshable
    ? "expired (refresh available)"
    : status.state;
}

function formatLabel(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
