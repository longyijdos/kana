import type { JsonRpcMessage } from "./protocol";

export type McpTransportClose = {
  reason?: string;
};

export type McpTransportSessionExpired = {
  generation: number;
};

export type McpTransportReconnectCause = "connect_error" | "read_error" | "stream_ended";

export type McpTransportReconnected = {
  operation: "standalone_sse";
  cause: McpTransportReconnectCause;
  reconnectCount: number;
  resumedFromEvent: boolean;
  errorIdentity?: string;
};

export type McpTransportHandlers = {
  onMessage(message: unknown): void;
  onError(error: Error): void;
  onClose(event: McpTransportClose): void;
  onSessionExpired?(event: McpTransportSessionExpired): void;
  onReconnect?(event: McpTransportReconnected): void;
};

// A transport owns only message delivery. Protocol negotiation, request IDs,
// cancellation, and capability handling belong to McpClient so future protocol
// versions can reuse stdio and future HTTP transports can reuse the same client.
export interface McpTransport {
  start(handlers: McpTransportHandlers): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

export class McpTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpTransportError";
  }
}

// Session identifiers are transport-owned secrets. Recovery consumers only
// need an opaque generation to coalesce concurrent 404 responses safely.
export class McpTransportSessionExpiredError extends McpTransportError {
  constructor(public readonly generation: number) {
    super("MCP HTTP session expired.");
    this.name = "McpTransportSessionExpiredError";
  }
}
