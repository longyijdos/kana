import { McpRequestCancelledError } from "./errors";
import type { McpImplementation, McpServerCapabilities, McpTool } from "./protocol";
import { type AdaptedMcpTool, createMcpToolAdapter, type McpToolCaller } from "./tool-adapter";
import type { McpToolResultLimits } from "./tool-result";

export type McpToolRegistry = Pick<McpManager, "catalog" | "tools" | "getTool">;

export type McpManagerState = "idle" | "starting" | "ready" | "closing" | "closed";
type McpServerStatus = "idle" | "starting" | "ready" | "failed" | "closed";
export type McpManagerErrorPhase = "start" | "close";
type McpManagerOperation = "start" | "close";
type McpManagerProgressOutcome = "ready" | "failed" | "closed";

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
  description?: string;
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

export class McpManagerStartError extends Error {
  readonly failures: readonly McpServerStartFailure[];

  constructor(failures: readonly McpServerStartFailure[]) {
    const serverIds = failures.map((failure) => failure.serverId).join(", ");
    super(`Required MCP servers failed to start: ${serverIds}.`);
    this.name = "McpManagerStartError";
    this.failures = failures.slice();
  }
}

type McpServerRecord = {
  registration: McpServerRegistration;
  status: McpServerStatus;
  client?: McpManagedClient;
  clientClosed: boolean;
  tools: AdaptedMcpTool[];
  discoveredToolCount: number;
  serverInfo?: McpImplementation;
  serverCapabilities?: McpServerCapabilities;
  error?: Error;
};

export class McpManager {
  private stateData: McpManagerState = "idle";
  private readonly records: McpServerRecord[];
  private readonly onError?: (event: McpManagerErrorEvent) => void;
  private readonly onProgress?: (event: McpManagerProgressEvent) => void;
  private toolsData: AdaptedMcpTool[] = [];
  private readonly startController = new AbortController();
  private disposeStartSignal?: () => void;
  private startPromise?: Promise<AdaptedMcpTool[]>;
  private closePromise?: Promise<void>;

  constructor(options: McpManagerOptions) {
    validateRegistrations(options.servers);
    this.onError = options.onError;
    this.onProgress = options.onProgress;
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

  get catalog(): Array<{ name: string; description: string }> {
    return this.records
      .filter((record) => record.status === "ready")
      .map((record) => ({
        name: record.registration.id,
        description: record.registration.description ?? record.serverInfo?.description ?? "",
      }));
  }

  getTool(serverId: string, remoteToolName: string): AdaptedMcpTool | undefined {
    return this.toolsData.find(
      (tool) => tool.source.serverId === serverId && tool.source.remoteToolName === remoteToolName,
    );
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

    this.toolsData = this.records
      .filter((record) => record.status === "ready")
      .flatMap((record) => record.tools);

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
      record.tools = selectedTools.map((tool) =>
        createMcpToolAdapter({
          serverId: record.registration.id,
          caller: client,
          tool,
          ...(record.registration.resultLimits === undefined
            ? {}
            : { resultLimits: record.registration.resultLimits }),
        }),
      );
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
    ...(registration.description === undefined ? {} : { description: registration.description }),
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
