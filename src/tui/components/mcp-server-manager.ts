import { color, dim, stripTerminalControlSequences, truncateToWidth } from "../render";
import type { Component } from "../runtime";
import { isDown, isEnter, isEscape, isUp } from "../runtime";
import { tuiTheme } from "../theme";
import { ListViewport, visibleLimitForHeight } from "../utils/list-viewport";

const MCP_SERVER_MANAGER_VISIBLE_LIMIT = 10;
const MCP_SERVER_MANAGER_RESERVED_ROWS = 5;

export type McpServerManagerItem = {
  id: string;
  type: "stdio";
  command: string;
  args: string[];
  enabled: boolean;
};

export type McpServerManagerDecision = {
  type: "apply";
  enabledServerIds: string[];
  changed: boolean;
};

export class McpServerManager implements Component {
  private readonly viewport: ListViewport;
  private readonly maximumVisibleServers: number;
  private readonly initialEnabledServerIds: Set<string>;

  constructor(
    private readonly servers: McpServerManagerItem[],
    private readonly finish: (decision: McpServerManagerDecision) => void,
    visibleLimit = MCP_SERVER_MANAGER_VISIBLE_LIMIT,
  ) {
    this.maximumVisibleServers = visibleLimit;
    this.viewport = new ListViewport(this.maximumVisibleServers);
    this.initialEnabledServerIds = new Set(
      servers.filter((server) => server.enabled).map((server) => server.id),
    );
  }

  handleInput(data: string): void {
    if (isEscape(data)) {
      const enabledServerIds = this.servers
        .filter((server) => server.enabled)
        .map((server) => server.id);
      this.finish({
        type: "apply",
        enabledServerIds,
        changed: !setsEqual(this.initialEnabledServerIds, new Set(enabledServerIds)),
      });
      return;
    }

    if (isEnter(data)) {
      const selected = this.servers[this.viewport.selectedIndex];
      if (selected) {
        selected.enabled = !selected.enabled;
      }
      return;
    }

    if (isUp(data)) {
      this.viewport.move(-1, this.servers.length);
      return;
    }

    if (isDown(data)) {
      this.viewport.move(1, this.servers.length);
    }
  }

  render(width: number, availableHeight?: number): string[] {
    const lines = [color("MCP servers", tuiTheme.bottomTitle)];

    if (this.servers.length === 0) {
      lines.push(dim("No MCP servers configured in mcp.json."), dim("Esc close"));
      return lines;
    }

    this.viewport.setVisibleLimit(
      visibleLimitForHeight(
        this.maximumVisibleServers,
        availableHeight,
        MCP_SERVER_MANAGER_RESERVED_ROWS,
      ),
      this.servers.length,
    );
    const viewport = this.viewport.window(this.servers.length);

    if (viewport.hiddenBefore > 0) {
      lines.push(dim(`... ${viewport.hiddenBefore} earlier servers`));
    }

    for (let index = viewport.start; index < viewport.end; index += 1) {
      const server = this.servers[index];
      const selected = index === this.viewport.selectedIndex;
      const marker = selected ? "> " : "  ";
      const checkbox = server.enabled ? "[x]" : "[ ]";
      const label = `${marker}${checkbox} ${formatSingleLine(server.id)}  ${server.type}`;

      lines.push(
        truncateToWidth(color(label, selected ? tuiTheme.user : tuiTheme.muted), width, ""),
      );

      if (selected) {
        lines.push(truncateToWidth(dim(`  command: ${formatCommand(server)}`), width, "..."));
      }
    }

    if (viewport.hiddenAfter > 0) {
      lines.push(dim(`... ${viewport.hiddenAfter} more servers`));
    }

    lines.push(dim("Enter toggle · Esc apply and close"));
    return lines;
  }
}

function setsEqual(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every((value) => second.has(value));
}

function formatSingleLine(value: string): string {
  return stripTerminalControlSequences(value).trim().replace(/\s+/g, " ");
}

function formatCommand(server: Pick<McpServerManagerItem, "command" | "args">): string {
  return [server.command, ...server.args].map(formatSingleLine).join(" ");
}
