export class McpAuthorizationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpAuthorizationError";
  }
}

class McpClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpClientError";
  }
}

export class McpRequestTimeoutError extends McpClientError {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`MCP request ${method} timed out after ${timeoutMs}ms.`);
    this.name = "McpRequestTimeoutError";
  }
}

export class McpRequestCancelledError extends McpClientError {
  constructor(message = "MCP request was cancelled.", options?: ErrorOptions) {
    super(message, options);
    this.name = "McpRequestCancelledError";
  }
}

export class McpResponseError extends McpClientError {
  constructor(
    public readonly code: number,
    public readonly responseMessage: string,
    public readonly data?: unknown,
  ) {
    super(`MCP error ${code}: ${responseMessage}`);
    this.name = "McpResponseError";
  }
}
