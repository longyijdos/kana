import type { KanaMcpRuntimeProgressEvent } from "@/kana";
import type { McpManagerProgressEvent, McpServerDiagnostic } from "@/mcp";
import { stripTerminalControlSequences } from "./render";

export function formatMcpLifecycleStatus(
  event: McpManagerProgressEvent,
  runtimeOperation?: KanaMcpRuntimeProgressEvent["runtimeOperation"],
): string | undefined {
  if (event.operation === "close") {
    if (runtimeOperation !== undefined && runtimeOperation !== "close") {
      return undefined;
    }
    if (event.totalServerCount === 0) {
      return undefined;
    }

    const progress = `${event.completedServerCount}/${event.totalServerCount}`;
    const server =
      event.serverId === undefined || event.outcome === undefined
        ? ""
        : ` · ${sanitizeLabel(event.serverId)} ${event.outcome}`;
    return `Closing MCP servers... ${progress}${server}`;
  }

  if (event.serverId === undefined || event.outcome === undefined) {
    return undefined;
  }

  const toolCount = event.toolCount ?? 0;
  const toolLabel = toolCount === 1 ? "tool" : "tools";
  const progress = `[${event.completedServerCount}/${event.totalServerCount}]`;
  return `${progress} MCP server ${sanitizeLabel(event.serverId)} ${event.outcome} · ${toolCount} ${toolLabel}.`;
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

export function formatMcpStartupSummary(diagnostics: readonly McpServerDiagnostic[]): string {
  return formatMcpSummary("startup", diagnostics);
}

export function formatMcpReloadSummary(diagnostics: readonly McpServerDiagnostic[]): string {
  return formatMcpSummary("reload", diagnostics);
}

function formatMcpSummary(
  operation: "startup" | "reload",
  diagnostics: readonly McpServerDiagnostic[],
): string {
  const readyServers = diagnostics.filter((diagnostic) => diagnostic.status === "ready");
  const readyServerCount = readyServers.length;
  const toolCount = readyServers.reduce((count, diagnostic) => count + diagnostic.toolCount, 0);
  const toolLabel = toolCount === 1 ? "tool" : "tools";

  return `MCP ${operation} complete: ${readyServerCount}/${diagnostics.length} servers ready · ${toolCount} ${toolLabel}`;
}

function sanitizeLabel(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\r\n]+/g, " ");
}
