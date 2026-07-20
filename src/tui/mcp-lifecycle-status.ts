import type { McpManagerProgressEvent } from "@/mcp";
import { stripTerminalControlSequences, truncateToWidth } from "./render";
import type { Terminal } from "./runtime";

export function formatMcpLifecycleStatus(event: McpManagerProgressEvent): string | undefined {
  if (event.totalServerCount === 0) {
    return undefined;
  }

  const action = event.operation === "start" ? "Starting" : "Closing";
  const progress = `${event.completedServerCount}/${event.totalServerCount}`;
  const server =
    event.serverId === undefined || event.outcome === undefined
      ? ""
      : ` · ${sanitizeLabel(event.serverId)} ${event.outcome}`;

  return `${action} MCP servers... ${progress}${server}`;
}

// MCP startup precedes the full TUI, so this presenter owns only one temporary
// terminal line. The first full TUI render clears it before normal interaction.
export class McpBootstrapStatus {
  private visible = false;

  constructor(
    private readonly terminal: Pick<Terminal, "columns" | "write">,
    private readonly enabled = true,
  ) {}

  update(event: McpManagerProgressEvent): void {
    if (!this.enabled) {
      return;
    }

    const status = formatMcpLifecycleStatus(event);
    if (status === undefined) {
      return;
    }

    this.visible = true;
    this.terminal.write(`\r\x1b[2K${truncateToWidth(status, Math.max(1, this.terminal.columns))}`);
  }

  clear(): void {
    if (!this.visible) {
      return;
    }

    this.visible = false;
    this.terminal.write("\r\x1b[2K");
  }
}

function sanitizeLabel(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\r\n]+/g, " ");
}
