import type { ToolResult } from "@/tools";
import type { McpResponseError } from "./errors";
import { isJsonObject, type McpCallToolResult, type McpToolContent } from "./protocol";

export type McpToolSource = {
  serverId: string;
  remoteToolName: string;
};

type FormattedContentItem = {
  text: string;
  naturalText: boolean;
};

export function normalizeMcpToolResult(response: McpCallToolResult): ToolResult {
  const formatted = response.content.map(formatContentItem);
  const parts = formatted.map((item) => item.text).filter(Boolean);

  if (response.structuredContent !== undefined && !formatted.some((item) => item.naturalText)) {
    parts.push(`Structured content:\n${JSON.stringify(response.structuredContent, null, 2)}`);
  }
  if (parts.length === 0) {
    parts.push(
      response.isError
        ? "MCP tool reported an error without content."
        : "MCP tool returned no content.",
    );
  }

  const content = parts.join("\n\n");
  return {
    content,
    result: response.structuredContent === undefined ? content : response.structuredContent,
    isError: response.isError ?? false,
  };
}

export function normalizeMcpResponseError(error: McpResponseError): ToolResult<string> {
  const content = [
    `MCP server returned JSON-RPC error ${error.code}: ${error.responseMessage}`,
    ...(error.data === undefined ? [] : [JSON.stringify(error.data, null, 2)]),
  ].join("\n\n");
  return { content, result: content, isError: true };
}

function formatContentItem(item: McpToolContent): FormattedContentItem {
  switch (item.type) {
    case "text":
      if (typeof item.text !== "string") {
        return invalidContent("text", "Missing text string.");
      }
      return { text: item.text, naturalText: item.text.length > 0 };
    case "resource_link": {
      if (typeof item.uri !== "string") {
        return invalidContent("resource_link", "Missing resource URI.");
      }
      const name = optionalString(item.name);
      const mimeType = optionalString(item.mimeType);
      const description = optionalString(item.description);
      const details = [mimeType, name ? item.uri : undefined].filter(Boolean).join(", ");
      return {
        text: `[MCP resource link: ${name ?? item.uri}${details ? ` (${details})` : ""}]${description ? `\n${description}` : ""}`,
        naturalText: false,
      };
    }
    case "resource": {
      if (!isJsonObject(item.resource)) {
        return invalidContent("resource", "Missing resource object.");
      }
      const resource = item.resource;
      const label = optionalString(resource.uri) ?? "embedded resource";
      const mimeType = optionalString(resource.mimeType);
      if (typeof resource.text === "string") {
        return {
          text: `[MCP resource: ${label}${mimeType ? ` (${mimeType})` : ""}]\n${resource.text}`,
          naturalText: resource.text.length > 0,
        };
      }
      if (typeof resource.blob !== "string") {
        return invalidContent("resource", "Missing resource text or blob.");
      }
      return {
        text: `[MCP binary resource omitted: ${label}${formatBinaryDetails(mimeType, resource.blob)}]`,
        naturalText: false,
      };
    }
    case "image":
    case "audio":
      if (typeof item.data !== "string") {
        return invalidContent(item.type, "Missing base64 data string.");
      }
      return {
        text: `[MCP ${item.type} omitted${formatBinaryDetails(optionalString(item.mimeType), item.data)}]`,
        naturalText: false,
      };
    default:
      return { text: `[Unsupported MCP content type omitted: ${item.type}]`, naturalText: false };
  }
}

function invalidContent(contentType: string, reason: string): FormattedContentItem {
  return { text: `[Invalid MCP ${contentType} content omitted: ${reason}]`, naturalText: false };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatBinaryDetails(mimeType: string | undefined, data: string): string {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((data.length * 3) / 4) - padding);
  return `: ${[mimeType, `${bytes} bytes`].filter(Boolean).join(", ")}`;
}
