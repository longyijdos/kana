import type { Tool as SdkTool } from "@modelcontextprotocol/client";

export type {
  Implementation as McpImplementation,
  JSONRPCMessage as JsonRpcMessage,
  Progress as McpProgress,
  ServerCapabilities as McpServerCapabilities,
} from "@modelcontextprotocol/client";

export type JsonObject = Record<string, unknown>;
export type McpTool = Omit<SdkTool, "inputSchema"> & { inputSchema: JsonObject };
export type McpToolContent = JsonObject & { type: string };
export type McpCallToolResult = {
  content: McpToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
