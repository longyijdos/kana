import { McpConnection } from "./connection";
import { McpCapabilityError, McpClientError, McpConnectionClosedError } from "./errors";
import {
  isJsonObject,
  type JsonObject,
  type JsonRpcNotification,
  MCP_PROTOCOL_VERSION,
  type McpCallToolResult,
  type McpClientCapabilities,
  type McpImplementation,
  type McpInitializeResult,
  type McpListToolsResult,
  type McpProgress,
  McpProtocolError,
  type McpServerCapabilities,
  type McpTool,
} from "./protocol";
import {
  type McpTransport,
  type McpTransportReconnected,
  type McpTransportSessionExpired,
  McpTransportSessionExpiredError,
} from "./transport";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOOL_LIST_PAGES = 1_000;
const SESSION_RECOVERED_MESSAGE =
  "MCP HTTP session expired and has been reinitialized successfully. The original tool call was not retried. You may call the tool again.";
const SESSION_EXPIRED_DURING_RECOVERY_MESSAGE =
  "MCP HTTP session expired again during recovery. The MCP client was closed.";

export type McpClientOptions = {
  transport: McpTransport;
  clientInfo: McpImplementation;
  capabilities?: McpClientCapabilities;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxToolListPages?: number;
  onNotification?(notification: JsonRpcNotification): void;
  onError?(error: Error): void;
  onTransportReconnect?(event: McpTransportReconnected): void;
};

export type McpRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type McpCallToolOptions = McpRequestOptions & {
  onProgress?(progress: McpProgress): void;
};

type ClientState = "idle" | "initializing" | "ready" | "recovering" | "closing" | "closed";

type SessionRecovery = {
  generation: number;
  promise: Promise<void>;
};

// Implements only the stable 2025-11-25 lifecycle; McpConnection owns reusable JSON-RPC state.
// TODO(mcp): Add 2026-07-28 as a separate client once stable; never select it dynamically here.
export class McpClient {
  private state: ClientState = "idle";
  private readonly connection: McpConnection;
  private initializeResult?: McpInitializeResult;
  private sessionRecovery?: SessionRecovery;
  private sessionRecoveryFailure?: Error;
  private recoveredSessionGeneration = 0;

  constructor(private readonly options: McpClientOptions) {
    assertPositiveInteger(options.initializeTimeoutMs, "initializeTimeoutMs");
    assertPositiveInteger(options.maxToolListPages, "maxToolListPages");

    this.connection = new McpConnection({
      transport: options.transport,
      requestTimeoutMs: options.requestTimeoutMs,
      onNotification: options.onNotification,
      onError: options.onError,
      onClose: () => {
        this.state = "closed";
      },
      onSessionExpired: (event) => this.handleSessionExpired(event),
      onTransportReconnect: options.onTransportReconnect,
    });
  }

  get connected(): boolean {
    return this.state === "ready" && this.connection.active;
  }

  get serverInfo(): McpImplementation | undefined {
    return this.initializeResult?.serverInfo;
  }

  get serverCapabilities(): McpServerCapabilities | undefined {
    return this.initializeResult?.capabilities;
  }

  async connect(): Promise<McpInitializeResult> {
    if (this.state !== "idle") {
      throw new McpClientError("MCP client can only be connected once.");
    }

    this.state = "initializing";

    try {
      await this.connection.start();
      const initializeResult = await this.initializeSession();

      if (!this.connection.active) {
        throw new McpConnectionClosedError("MCP transport closed during initialization.");
      }

      this.state = "ready";
      return initializeResult;
    } catch (error) {
      await this.closeAfterConnectFailure();
      throw error;
    }
  }

  async listTools(options: McpRequestOptions = {}): Promise<McpTool[]> {
    await this.waitUntilReady();
    this.requireToolsCapability();

    const tools: McpTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let pageIndex = 0; pageIndex < this.maxToolListPages; pageIndex += 1) {
      const result = await this.requestWithoutReplay(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        options,
      );
      const page = parseListToolsResult(result);
      tools.push(...page.tools);

      if (page.nextCursor === undefined) {
        return tools;
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new McpProtocolError(`MCP server repeated tools/list cursor ${page.nextCursor}.`);
      }

      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    throw new McpProtocolError(
      `MCP tools/list exceeded the ${this.maxToolListPages}-page safety limit.`,
    );
  }

  async callTool(
    name: string,
    args?: JsonObject,
    options: McpCallToolOptions = {},
  ): Promise<McpCallToolResult> {
    await this.waitUntilReady();
    this.requireToolsCapability();

    const params: JsonObject = { name };
    if (args !== undefined) {
      params.arguments = args;
    }

    const result = await this.requestWithoutReplay("tools/call", params, options);
    return parseCallToolResult(result);
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }

    this.state = "closing";
    try {
      await this.connection.close();
    } finally {
      this.state = "closed";
    }
  }

  private get maxToolListPages(): number {
    return this.options.maxToolListPages ?? DEFAULT_MAX_TOOL_LIST_PAGES;
  }

  private async initializeSession(): Promise<McpInitializeResult> {
    const result = await this.connection.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: this.options.capabilities ?? {},
        clientInfo: implementationToJson(this.options.clientInfo),
      },
      {
        timeoutMs: this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
        cancellable: false,
      },
    );
    const initializeResult = parseInitializeResult(result);

    if (initializeResult.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new McpProtocolError(
        `MCP server selected unsupported protocol version ${initializeResult.protocolVersion}.`,
      );
    }

    this.initializeResult = initializeResult;
    await this.connection.sendNotification("notifications/initialized");
    return initializeResult;
  }

  private handleSessionExpired(event: McpTransportSessionExpired): void {
    if (
      this.state === "idle" ||
      this.state === "initializing" ||
      this.state === "closing" ||
      this.state === "closed" ||
      event.generation <= this.recoveredSessionGeneration
    ) {
      return;
    }
    if (this.sessionRecovery?.generation === event.generation) {
      return;
    }
    if (this.state === "recovering") {
      const error = new McpClientError(SESSION_EXPIRED_DURING_RECOVERY_MESSAGE);
      this.sessionRecoveryFailure = error;
      this.reportError(error);
      void this.close();
      return;
    }

    this.state = "recovering";
    this.sessionRecoveryFailure = undefined;
    const promise = this.recoverSession(event.generation);
    this.sessionRecovery = { generation: event.generation, promise };
    void promise.catch(() => undefined);
  }

  private async recoverSession(generation: number): Promise<void> {
    try {
      await this.initializeSession();
      if (this.state !== "recovering") {
        throw new McpConnectionClosedError("MCP client closed during session recovery.");
      }
      this.recoveredSessionGeneration = generation;
      this.state = "ready";
    } catch (error) {
      const failure = this.sessionRecoveryFailure ?? asError(error);
      if (this.state !== "closing" && this.state !== "closed") {
        this.reportError(failure);
        this.state = "closing";
        try {
          await this.connection.close();
        } finally {
          this.state = "closed";
        }
      }
      throw failure;
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (this.state === "recovering") {
      await this.sessionRecovery?.promise;
    }
  }

  private async requestWithoutReplay(
    method: string,
    params: JsonObject,
    options: McpCallToolOptions,
  ): Promise<JsonObject> {
    try {
      return await this.connection.request(method, params, options);
    } catch (error) {
      if (error instanceof McpTransportSessionExpiredError) {
        const recovery = this.sessionRecovery;
        if (recovery?.generation === error.generation) {
          await recovery.promise;
          throw new McpClientError(SESSION_RECOVERED_MESSAGE, { cause: error });
        }
      }
      // A session is reinitialized for future requests, but the request that
      // observed 404 is never replayed because tools may have side effects.
      throw error;
    }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostic hooks cannot alter lifecycle recovery.
    }
  }

  private requireToolsCapability(): void {
    if (this.state !== "ready" || !this.connection.active) {
      throw new McpConnectionClosedError("MCP client is not initialized.");
    }
    if (!this.initializeResult || !isJsonObject(this.initializeResult.capabilities.tools)) {
      throw new McpCapabilityError("MCP server did not declare the tools capability.");
    }
  }

  private async closeAfterConnectFailure(): Promise<void> {
    if (this.state === "closed") {
      return;
    }

    this.state = "closing";
    try {
      await this.connection.close();
    } finally {
      this.state = "closed";
    }
  }
}

function parseInitializeResult(result: JsonObject): McpInitializeResult {
  if (
    typeof result.protocolVersion !== "string" ||
    !isJsonObject(result.capabilities) ||
    !isJsonObject(result.serverInfo)
  ) {
    throw new McpProtocolError("MCP initialize response is missing required fields.");
  }

  const serverInfo = parseImplementation(result.serverInfo, "serverInfo");
  if (result.instructions !== undefined && typeof result.instructions !== "string") {
    throw new McpProtocolError("MCP initialize instructions must be a string.");
  }

  return {
    protocolVersion: result.protocolVersion,
    capabilities: result.capabilities,
    serverInfo,
    ...(result.instructions === undefined ? {} : { instructions: result.instructions }),
  };
}

function parseListToolsResult(result: JsonObject): McpListToolsResult {
  if (!Array.isArray(result.tools)) {
    throw new McpProtocolError("MCP tools/list response must contain a tools array.");
  }
  if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
    throw new McpProtocolError("MCP tools/list nextCursor must be a string.");
  }

  return {
    tools: result.tools.map((tool, index) => parseTool(tool, index)),
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
  };
}

function parseTool(value: unknown, index: number): McpTool {
  if (!isJsonObject(value) || typeof value.name !== "string" || !isJsonObject(value.inputSchema)) {
    throw new McpProtocolError(`MCP tool at index ${index} is missing name or inputSchema.`);
  }

  const title = parseOptionalString(value.title, `MCP tool ${value.name} title`);
  const description = parseOptionalString(value.description, `MCP tool ${value.name} description`);
  const outputSchema = parseOptionalObject(
    value.outputSchema,
    `MCP tool ${value.name} outputSchema`,
  );
  const annotations = parseOptionalObject(value.annotations, `MCP tool ${value.name} annotations`);
  const execution = parseOptionalObject(value.execution, `MCP tool ${value.name} execution`);

  if (
    value.icons !== undefined &&
    (!Array.isArray(value.icons) || !value.icons.every(isJsonObject))
  ) {
    throw new McpProtocolError(`MCP tool ${value.name} icons must be JSON objects.`);
  }

  return {
    name: value.name,
    inputSchema: value.inputSchema,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(execution === undefined ? {} : { execution }),
    ...(value.icons === undefined ? {} : { icons: value.icons as JsonObject[] }),
  };
}

function parseCallToolResult(result: JsonObject): McpCallToolResult {
  if (
    !Array.isArray(result.content) ||
    !result.content.every((item) => isJsonObject(item) && typeof item.type === "string")
  ) {
    throw new McpProtocolError("MCP tools/call response must contain typed content objects.");
  }
  if (result.structuredContent !== undefined && !isJsonObject(result.structuredContent)) {
    throw new McpProtocolError("MCP structuredContent must be a JSON object.");
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new McpProtocolError("MCP tools/call isError must be a boolean.");
  }

  return {
    content: result.content as McpCallToolResult["content"],
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

function parseImplementation(value: JsonObject, field: string): McpImplementation {
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    throw new McpProtocolError(`MCP ${field} must contain name and version strings.`);
  }

  const title = parseOptionalString(value.title, `MCP ${field} title`);
  const description = parseOptionalString(value.description, `MCP ${field} description`);
  const websiteUrl = parseOptionalString(value.websiteUrl, `MCP ${field} websiteUrl`);

  return {
    name: value.name,
    version: value.version,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(websiteUrl === undefined ? {} : { websiteUrl }),
  };
}

function implementationToJson(value: McpImplementation): JsonObject {
  return {
    name: value.name,
    version: value.version,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.websiteUrl === undefined ? {} : { websiteUrl: value.websiteUrl }),
  };
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new McpProtocolError(`${field} must be a string.`);
  }

  return value;
}

function parseOptionalObject(value: unknown, field: string): JsonObject | undefined {
  if (value !== undefined && !isJsonObject(value)) {
    throw new McpProtocolError(`${field} must be a JSON object.`);
  }

  return value;
}

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
