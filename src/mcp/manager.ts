import { McpRequestCancelledError } from "./errors";
import type { McpImplementation, McpServerCapabilities, McpTool } from "./protocol";
import { type AdaptedMcpTool, createMcpToolAdapter, type McpToolCaller } from "./tool-adapter";
import type { McpToolResultLimits, McpToolSource } from "./tool-result";

export type McpManagerState = "idle" | "starting" | "ready" | "closing" | "closed";
type McpServerStatus = "idle" | "starting" | "ready" | "failed" | "closed";
export type McpManagerErrorPhase = "start" | "close";
type McpManagerOperation = "start" | "close";
type McpManagerProgressOutcome = "ready" | "failed" | "closed";

// The manager depends on capabilities rather than McpClient so a future
// lifecycle implementation can be registered without inheriting initialize.
export interface McpManagedClient extends McpToolCaller {
  readonly serverInfo?: McpImplementation;
  readonly serverCapabilities?: McpServerCapabilities;
  connect(options?: McpManagerStartOptions): Promise<unknown>;
  listTools(options?: McpManagerStartOptions): Promise<McpTool[]>;
  close(): Promise<void>;
}

export type McpManagerStartOptions = {
  signal?: AbortSignal;
};

export type McpServerRegistration = {
  id: string;
  required?: boolean;
  includeTools?: readonly string[];
  excludeTools?: readonly string[];
  resultLimits?: Partial<McpToolResultLimits>;
  createClient(options?: McpManagerStartOptions): McpManagedClient;
};

export type McpManagerErrorEvent = {
  serverId: string;
  phase: McpManagerErrorPhase;
  error: Error;
};

export type McpManagerProgressEvent = {
  operation: McpManagerOperation;
  completedServerCount: number;
  totalServerCount: number;
  serverId?: string;
  outcome?: McpManagerProgressOutcome;
  toolCount?: number;
};

export type McpManagerOptions = {
  servers: readonly McpServerRegistration[];
  reservedToolNames?: Iterable<string>;
  onError?(event: McpManagerErrorEvent): void;
  onProgress?(event: McpManagerProgressEvent): void;
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
  private readonly onProgress?: (event: McpManagerProgressEvent) => void;
  private toolsData: AdaptedMcpTool[] = [];
  private toolSourcesData = new Map<string, McpToolSource>();
  private readonly startController = new AbortController();
  private disposeStartSignal?: () => void;
  private startPromise?: Promise<AdaptedMcpTool[]>;
  private closePromise?: Promise<void>;

  constructor(options: McpManagerOptions) {
    validateRegistrations(options.servers);
    this.reservedToolNames = new Set(options.reservedToolNames ?? []);
    this.onError = options.onError;
    this.onProgress = options.onProgress;
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

  getToolSource(toolName: string): McpToolSource | undefined {
    const source = this.toolSourcesData.get(toolName);
    return source === undefined ? undefined : { ...source };
  }

  start(options: McpManagerStartOptions = {}): Promise<AdaptedMcpTool[]> {
    if (this.stateData !== "idle") {
      return Promise.reject(new Error("MCP manager can only be started once."));
    }

    this.stateData = "starting";
    this.disposeStartSignal = linkAbortSignal(options.signal, this.startController);
    // Defer work by one microtask so startPromise is installed before a
    // synchronous factory failure can invoke diagnostics or close().
    this.startPromise = Promise.resolve()
      .then(() => this.startInternal())
      .finally(() => {
        this.disposeStartSignal?.();
        this.disposeStartSignal = undefined;
      });
    return this.startPromise;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.startController.abort(new McpRequestCancelledError("MCP manager is closing."));
      this.closePromise = this.closeInternal();
    }
    return this.closePromise;
  }

  private async startInternal(): Promise<AdaptedMcpTool[]> {
    try {
      return await this.startServers();
    } catch (error) {
      if (!this.startController.signal.aborted) {
        throw error;
      }

      if (this.stateData !== "closed") {
        await this.closeAfterStartFailure();
      }
      throw createStartCancellationError(this.startController.signal);
    }
  }

  private async startServers(): Promise<AdaptedMcpTool[]> {
    throwIfStartAborted(this.startController.signal);
    let completedServerCount = 0;
    this.reportProgress({
      operation: "start",
      completedServerCount,
      totalServerCount: this.records.length,
    });
    await Promise.all(
      this.records.map(async (record) => {
        await this.startServer(record, this.startController.signal);
        completedServerCount += 1;
        if (this.startController.signal.aborted) {
          return;
        }
        this.reportProgress({
          operation: "start",
          completedServerCount,
          totalServerCount: this.records.length,
          serverId: record.registration.id,
          outcome: record.status === "ready" ? "ready" : "failed",
          toolCount: record.tools.length,
        });
      }),
    );
    throwIfStartAborted(this.startController.signal);

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

  private async startServer(record: McpServerRecord, signal: AbortSignal): Promise<void> {
    record.status = "starting";

    try {
      throwIfStartAborted(signal);
      const client = record.registration.createClient({ signal });
      record.client = client;
      await client.connect({ signal });
      throwIfStartAborted(signal);
      record.serverInfo = client.serverInfo;
      record.serverCapabilities = client.serverCapabilities;

      const remoteTools = await client.listTools({ signal });
      throwIfStartAborted(signal);
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
      if (signal.aborted) {
        await this.closeClient(record);
        return;
      }
      record.error = asError(error);
      record.status = "failed";
      this.reportError(record.registration.id, "start", record.error);
      await this.closeClient(record);
    }
  }

  private collectTools(): AdaptedMcpTool[] {
    const sources = new Map<string, McpToolNameSource>();
    const toolSources = new Map<string, McpToolSource>();
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
        toolSources.set(adapted.tool.name, {
          serverId: source.serverId,
          remoteToolName: source.remoteToolName,
        });
        tools.push(adapted.tool);
      }
    }

    this.toolSourcesData = toolSources;
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
    this.toolSourcesData.clear();
    this.stateData = "closed";
  }

  private async closeAfterStartFailure(): Promise<void> {
    this.stateData = "closing";
    await this.closeClients();
    this.toolsData = [];
    this.toolSourcesData.clear();
    this.stateData = "closed";
  }

  private async closeClients(): Promise<void> {
    const records = this.records
      .slice()
      .reverse()
      .filter((record) => record.client !== undefined && !record.clientClosed);
    let completedServerCount = 0;
    this.reportProgress({
      operation: "close",
      completedServerCount,
      totalServerCount: records.length,
    });
    // Reverse registration order mirrors resource acquisition while still
    // attempting every close if one server fails during shutdown.
    for (const record of records) {
      const closed = await this.closeClient(record);
      completedServerCount += 1;
      this.reportProgress({
        operation: "close",
        completedServerCount,
        totalServerCount: records.length,
        serverId: record.registration.id,
        outcome: closed ? "closed" : "failed",
      });
    }
  }

  private async closeClient(record: McpServerRecord): Promise<boolean> {
    if (!record.client || record.clientClosed) {
      if (record.status === "idle" || record.status === "starting") {
        record.status = "closed";
      }
      return true;
    }

    try {
      await record.client.close();
      return true;
    } catch (error) {
      this.reportError(record.registration.id, "close", asError(error));
      return false;
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

  private reportProgress(event: McpManagerProgressEvent): void {
    try {
      this.onProgress?.(event);
    } catch {
      // Presentation callbacks cannot change protocol lifecycle or cleanup.
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

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) {
    return () => {};
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }

  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function throwIfStartAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createStartCancellationError(signal);
  }
}

function createStartCancellationError(signal: AbortSignal): McpRequestCancelledError {
  if (signal.reason instanceof McpRequestCancelledError) {
    return signal.reason;
  }
  const message =
    signal.reason instanceof Error && signal.reason.message
      ? signal.reason.message
      : "MCP manager startup was cancelled.";
  return new McpRequestCancelledError(message, { cause: signal.reason });
}
