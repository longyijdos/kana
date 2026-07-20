export const MCP_PROTOCOL_VERSION = "2025-11-25";

export type JsonRpcId = string | number;
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: JsonObject;
};

export type JsonRpcErrorData = {
  code: number;
  message: string;
  data?: JsonValue;
};

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorData;
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type McpImplementation = {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
};

export type McpClientCapabilities = JsonObject;

export type McpServerCapabilities = JsonObject & {
  tools?: JsonObject & {
    listChanged?: boolean;
  };
};

export type McpInitializeResult = {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: McpImplementation;
  instructions?: string;
};

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  execution?: JsonObject;
  icons?: JsonObject[];
};

export type McpListToolsResult = {
  tools: McpTool[];
  nextCursor?: string;
};

export type McpToolContent = JsonObject & {
  type: string;
};

export type McpCallToolResult = {
  content: McpToolContent[];
  structuredContent?: JsonObject;
  isError?: boolean;
};

export type McpProgress = {
  progressToken: JsonRpcId;
  progress: number;
  total?: number;
  message?: string;
};

export class McpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isJsonObject(value) || value.jsonrpc !== "2.0") {
    throw new McpProtocolError('MCP messages must be JSON objects with jsonrpc: "2.0".');
  }

  if (typeof value.method === "string") {
    if ("result" in value || "error" in value) {
      throw new McpProtocolError("A JSON-RPC call cannot also be a response.");
    }
    if (value.params !== undefined && !isJsonObject(value.params)) {
      throw new McpProtocolError("MCP request and notification params must be JSON objects.");
    }

    if (!("id" in value)) {
      return value as JsonRpcNotification;
    }
    if (!isJsonRpcId(value.id)) {
      throw new McpProtocolError("MCP request IDs must be strings or integers.");
    }

    return value as JsonRpcRequest;
  }

  if (!isJsonRpcId(value.id)) {
    throw new McpProtocolError("MCP response IDs must be strings or integers.");
  }

  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) {
    throw new McpProtocolError("MCP responses must contain exactly one of result or error.");
  }

  if (hasResult) {
    if (!isJsonObject(value.result)) {
      throw new McpProtocolError("MCP success responses must contain a JSON object result.");
    }
    return value as JsonRpcSuccessResponse;
  }

  if (
    !isJsonObject(value.error) ||
    typeof value.error.code !== "number" ||
    !Number.isInteger(value.error.code) ||
    typeof value.error.message !== "string"
  ) {
    throw new McpProtocolError("MCP error responses must contain an integer code and message.");
  }

  return value as JsonRpcErrorResponse;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isJsonRpcErrorResponse(message: JsonRpcMessage): message is JsonRpcErrorResponse {
  return "error" in message;
}
