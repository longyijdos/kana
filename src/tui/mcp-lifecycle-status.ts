import type { McpManagerProgressEvent, McpServerDiagnostic } from "@/mcp";
import { stripTerminalControlSequences } from "./render";

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

export function formatMcpStartupWarnings(diagnostics: readonly McpServerDiagnostic[]): string[] {
  return diagnostics.flatMap((diagnostic) => {
    if (diagnostic.status !== "failed") {
      return [];
    }

    const serverId = sanitizeLabel(diagnostic.id);
    const message = sanitizeLabel(diagnostic.error?.message ?? "Unknown startup error.");
    return [`MCP server ${serverId} failed to start: ${message}`];
  });
}

export function formatMcpStartupSummary(
  diagnostics: readonly McpServerDiagnostic[],
  toolCount: number,
): string {
  const readyServerCount = diagnostics.filter((diagnostic) => diagnostic.status === "ready").length;
  const toolLabel = toolCount === 1 ? "tool" : "tools";

  return `MCP startup complete: ${readyServerCount}/${diagnostics.length} servers ready · ${toolCount} ${toolLabel}`;
}

function sanitizeLabel(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\r\n]+/g, " ");
}
