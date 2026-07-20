import type { JsonRpcMessage } from "./protocol";

export type McpTransportClose = {
  reason?: string;
};

export type McpTransportHandlers = {
  onMessage(message: unknown): void;
  onError(error: Error): void;
  onClose(event: McpTransportClose): void;
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
