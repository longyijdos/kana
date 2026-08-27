import type { McpOAuthHttpDiagnosticEvent } from "@/mcp";
import { TextBlock, type Transcript } from "../components";
import { stripTerminalControlSequences } from "../render";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";

export type McpOAuthStatusControllerOptions = {
  transcript: Transcript;
  tui: Tui;
};

export class McpOAuthStatusController {
  private readonly blocks = new Map<string, TextBlock>();

  constructor(private readonly options: McpOAuthStatusControllerOptions) {}

  clear(): void {
    this.blocks.clear();
  }

  showAuthorization(serverId: string, authorizationUrl: string): void {
    const block = this.getBlock(serverId);
    block.setText(
      [
        `Authorizing MCP server ${sanitizeLabel(serverId)} in your browser.`,
        "If the browser did not open, use this temporary URL:",
        authorizationUrl,
      ].join("\n"),
    );
    this.options.tui.requestRender();
  }

  handleDiagnostic(serverId: string, diagnostic: McpOAuthHttpDiagnosticEvent): void {
    const block = this.blocks.get(serverId);
    if (!block) {
      return;
    }

    if (diagnostic.event === "oauth.authorization_succeeded") {
      block.setText(`MCP OAuth authorized: ${sanitizeLabel(serverId)}.`);
      this.options.tui.requestRender();
    } else if (diagnostic.event === "oauth.authorization_failed") {
      block.setText(
        `MCP OAuth authorization failed: ${sanitizeLabel(serverId)}. See logs for details.`,
      );
      this.options.tui.requestRender();
    }
  }

  private getBlock(serverId: string): TextBlock {
    const existing = this.blocks.get(serverId);
    if (existing) {
      return existing;
    }

    const block = new TextBlock("", { color: tuiTheme.muted });
    this.blocks.set(serverId, block);
    this.options.transcript.addChild(block);
    return block;
  }
}

function sanitizeLabel(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}
