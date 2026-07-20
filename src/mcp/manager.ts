import type { McpImplementation, McpServerCapabilities, McpTool } from "./protocol";
import { type AdaptedMcpTool, createMcpToolAdapter, type McpToolCaller } from "./tool-adapter";
import type { McpToolResultLimits } from "./tool-result";

export type McpManagerState = "idle" | "starting" | "ready" | "closing" | "closed";
export type McpServerStatus = "idle" | "starting" | "ready" | "failed" | "closed";
export type McpManagerErrorPhase = "start" | "close";

// The manager depends on capabilities rather than McpClient so a future
// lifecycle implementation can be registered without inheriting initialize.
export interface McpManagedClient extends McpToolCaller {
  readonly serverInfo?: McpImplementation;
  readonly serverCapabilities?: McpServerCapabilities;
  connect(): Promise<unknown>;
  listTools(): Promise<McpTool[]>;
  close(): Promise<void>;
}

export type McpServerRegistration = {
  id: string;
  required?: boolean;
  includeTools?: readonly string[];
  excludeTools?: readonly string[];
  resultLimits?: Partial<McpToolResultLimits>;
  createClient(): McpManagedClient;
};

export type McpManagerErrorEvent = {
  serverId: string;
  phase: McpManagerErrorPhase;
  error: Error;
};

export type McpManagerOptions = {
  servers: readonly McpServerRegistration[];
  reservedToolNames?: Iterable<string>;
  onError?(event: McpManagerErrorEvent): void;
};

export type McpServerDiagnostic = {
  id: string;
  required: boolean;
  status: McpServerStatus;
  discoveredToolCount: number;
  toolCount: number;
  serverInfo?: McpImplementation;
  serverCapabilities?: McpServerCapabilities;
  error?: {
    name: string;
    message: string;
  };
};

export type McpServerStartFailure = {
  serverId: string;
  error: Error;
};

export type McpToolNameSource =
  | {
      kind: "reserved";
      toolName: string;
    }
  | {
      kind: "mcp";
      serverId: string;
      remoteToolName: string;
    };

export class McpManagerStartError extends Error {
  readonly failures: readonly McpServerStartFailure[];

  constructor(failures: readonly McpServerStartFailure[]) {
    const serverIds = failures.map((failure) => failure.serverId).join(", ");
    super(`Required MCP servers failed to start: ${serverIds}.`);
    this.name = "McpManagerStartError";
    this.failures = failures.slice();
  }
}

export class McpToolNameConflictError extends Error {
  readonly toolName: string;
  readonly first: McpToolNameSource;
  readonly second: McpToolNameSource;

  constructor(toolName: string, first: McpToolNameSource, second: McpToolNameSource) {
    super(
      `MCP tool alias ${toolName} conflicts between ${formatToolSource(first)} and ${formatToolSource(second)}.`,
    );
    this.name = "McpToolNameConflictError";
    this.toolName = toolName;
    this.first = first;
    this.second = second;
  }
}

type McpServerRecord = {
  registration: McpServerRegistration;
  status: McpServerStatus;
  client?: McpManagedClient;
  clientClosed: boolean;
  tools: Array<{
    tool: AdaptedMcpTool;
    remoteToolName: string;
  }>;
  discoveredToolCount: number;
  serverInfo?: McpImplementation;
  serverCapabilities?: McpServerCapabilities;
  error?: Error;
};

export class McpManager {
  private stateData: McpManagerState = "idle";
  private readonly records: McpServerRecord[];
  private readonly reservedToolNames: Set<string>;
  private readonly onError?: (event: McpManagerErrorEvent) => void;
  private toolsData: AdaptedMcpTool[] = [];
  private startPromise?: Promise<AdaptedMcpTool[]>;
  private closePromise?: Promise<void>;

  constructor(options: McpManagerOptions) {
    validateRegistrations(options.servers);
    this.reservedToolNames = new Set(options.reservedToolNames ?? []);
    this.onError = options.onError;
    validateToolNames(this.reservedToolNames, "reserved tool");
    // Registrations are caller-owned configuration. Snapshot their mutable
    // collections so startup behavior cannot change after construction.
    this.records = options.servers.map((registration) => ({
      registration: copyRegistration(registration),
      status: "idle",
      clientClosed: false,
      tools: [],
      discoveredToolCount: 0,
    }));
  }

  get state(): McpManagerState {
    return this.stateData;
  }

  get tools(): AdaptedMcpTool[] {
    return this.toolsData.slice();
  }

  get diagnostics(): McpServerDiagnostic[] {
    return this.records.map((record) => ({
      id: record.registration.id,
      required: record.registration.required ?? false,
      status: record.status,
      discoveredToolCount: record.discoveredToolCount,
      toolCount: record.tools.length,
      ...(record.serverInfo === undefined ? {} : { serverInfo: { ...record.serverInfo } }),
      ...(record.serverCapabilities === undefined
        ? {}
        : { serverCapabilities: structuredClone(record.serverCapabilities) }),
      ...(record.error === undefined
        ? {}
        : { error: { name: record.error.name, message: record.error.message } }),
    }));
  }

  start(): Promise<AdaptedMcpTool[]> {
    if (this.stateData !== "idle") {
      return Promise.reject(new Error("MCP manager can only be started once."));
    }

    this.stateData = "starting";
    // Defer work by one microtask so startPromise is installed before a
    // synchronous factory failure can invoke diagnostics or close().
    this.startPromise = Promise.resolve().then(() => this.startInternal());
    return this.startPromise;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal();
    }
    return this.closePromise;
  }

  private async startInternal(): Promise<AdaptedMcpTool[]> {
    await Promise.all(this.records.map((record) => this.startServer(record)));

    const requiredFailures = this.records
      .filter((record) => record.registration.required && record.error)
      .map((record) => ({
        serverId: record.registration.id,
        error: record.error!,
      }));

    if (requiredFailures.length > 0) {
      const error = new McpManagerStartError(requiredFailures);
      await this.closeAfterStartFailure();
      throw error;
    }

    try {
      this.toolsData = this.collectTools();
    } catch (error) {
      await this.closeAfterStartFailure();
      throw error;
    }

    this.stateData = "ready";
    return this.tools;
  }

  private async startServer(record: McpServerRecord): Promise<void> {
    record.status = "starting";

    try {
      const client = record.registration.createClient();
      record.client = client;
      await client.connect();
      record.serverInfo = client.serverInfo;
      record.serverCapabilities = client.serverCapabilities;

      const remoteTools = await client.listTools();
      record.discoveredToolCount = remoteTools.length;
      assertUniqueRemoteToolNames(record.registration.id, remoteTools);

      const includeTools =
        record.registration.includeTools === undefined
          ? undefined
          : new Set(record.registration.includeTools);
      const excludeTools = new Set(record.registration.excludeTools ?? []);
      const selectedTools = remoteTools.filter(
        (tool) =>
          (includeTools === undefined || includeTools.has(tool.name)) &&
          !excludeTools.has(tool.name),
      );

      // Adapt a server atomically. A malformed schema cannot leave a silently
      // partial tool set whose contents depend on discovery order.
      record.tools = selectedTools.map((tool) => ({
        tool: createMcpToolAdapter({
          serverId: record.registration.id,
          caller: client,
          tool,
          ...(record.registration.resultLimits === undefined
            ? {}
            : { resultLimits: record.registration.resultLimits }),
        }),
        remoteToolName: tool.name,
      }));
      record.status = "ready";
    } catch (error) {
      record.error = asError(error);
      record.status = "failed";
      this.reportError(record.registration.id, "start", record.error);
      await this.closeClient(record);
    }
  }

  private collectTools(): AdaptedMcpTool[] {
    const sources = new Map<string, McpToolNameSource>();
    for (const toolName of this.reservedToolNames) {
      sources.set(toolName, { kind: "reserved", toolName });
    }

    const tools: AdaptedMcpTool[] = [];
    for (const record of this.records) {
      if (record.status !== "ready") {
        continue;
      }

      for (const adapted of record.tools) {
        const source: McpToolNameSource = {
          kind: "mcp",
          serverId: record.registration.id,
          remoteToolName: adapted.remoteToolName,
        };
        const existing = sources.get(adapted.tool.name);
        if (existing) {
          throw new McpToolNameConflictError(adapted.tool.name, existing, source);
        }

        sources.set(adapted.tool.name, source);
        tools.push(adapted.tool);
      }
    }

    return tools;
  }

  private async closeInternal(): Promise<void> {
    if (this.stateData === "starting") {
      try {
        await this.startPromise;
      } catch {
        // startInternal already closes every client when startup fails.
      }
    }
    if (this.stateData === "closed") {
      return;
    }

    this.stateData = "closing";
    await this.closeClients();
    this.toolsData = [];
    this.stateData = "closed";
  }

  private async closeAfterStartFailure(): Promise<void> {
    this.stateData = "closing";
    await this.closeClients();
    this.toolsData = [];
    this.stateData = "closed";
  }

  private async closeClients(): Promise<void> {
    // Reverse registration order mirrors resource acquisition while still
    // attempting every close if one server fails during shutdown.
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      await this.closeClient(this.records[index]!);
    }
  }

  private async closeClient(record: McpServerRecord): Promise<void> {
    if (!record.client || record.clientClosed) {
      if (record.status === "idle" || record.status === "starting") {
        record.status = "closed";
      }
      return;
    }

    try {
      await record.client.close();
    } catch (error) {
      this.reportError(record.registration.id, "close", asError(error));
    } finally {
      record.clientClosed = true;
      if (record.status !== "failed") {
        record.status = "closed";
      }
    }
  }

  private reportError(serverId: string, phase: McpManagerErrorPhase, error: Error): void {
    try {
      this.onError?.({ serverId, phase, error });
    } catch {
      // Diagnostics must not change server lifecycle or cleanup behavior.
    }
  }
}

function copyRegistration(registration: McpServerRegistration): McpServerRegistration {
  return {
    id: registration.id,
    ...(registration.required === undefined ? {} : { required: registration.required }),
    ...(registration.includeTools === undefined
      ? {}
      : { includeTools: registration.includeTools.slice() }),
    ...(registration.excludeTools === undefined
      ? {}
      : { excludeTools: registration.excludeTools.slice() }),
    ...(registration.resultLimits === undefined
      ? {}
      : { resultLimits: { ...registration.resultLimits } }),
    createClient: registration.createClient,
  };
}

function validateRegistrations(registrations: readonly McpServerRegistration[]): void {
  const serverIds = new Set<string>();

  for (const registration of registrations) {
    if (!registration.id.trim()) {
      throw new Error("MCP server ID cannot be empty.");
    }
    if (serverIds.has(registration.id)) {
      throw new Error(`Duplicate MCP server ID: ${registration.id}.`);
    }

    serverIds.add(registration.id);
    validateToolNames(registration.includeTools ?? [], `include_tools for ${registration.id}`);
    validateToolNames(registration.excludeTools ?? [], `exclude_tools for ${registration.id}`);
  }
}

function validateToolNames(names: Iterable<string>, source: string): void {
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`MCP ${source} names must be non-empty strings.`);
    }
  }
}

function assertUniqueRemoteToolNames(serverId: string, tools: readonly McpTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`MCP server ${serverId} returned duplicate tool name ${tool.name}.`);
    }
    names.add(tool.name);
  }
}

function formatToolSource(source: McpToolNameSource): string {
  return source.kind === "reserved"
    ? `reserved tool ${source.toolName}`
    : `MCP tool ${source.serverId}/${source.remoteToolName}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
