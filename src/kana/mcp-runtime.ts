import type { McpManagerProgressEvent, McpServerDiagnostic, McpToolSource } from "@/mcp";
import type { Tool } from "@/tools";

import { type CreateKanaMcpManagerOptions, createKanaMcpManager } from "./mcp";
import { loadKanaMcpActivationState } from "./mcp-activation";
import { loadKanaMcpConfig } from "./mcp-config";

export type KanaMcpRuntimeOperation = "start" | "reload" | "close";

export type KanaMcpRuntimeProgressEvent = McpManagerProgressEvent & {
  runtimeOperation: KanaMcpRuntimeOperation;
};

export type KanaMcpRuntimeSnapshot = {
  tools: Tool[];
  diagnostics: McpServerDiagnostic[];
  selectedServerIds: string[];
};

export type CreateKanaMcpRuntimeOptions = Omit<
  CreateKanaMcpManagerOptions,
  "enabledServerIds" | "onProgress"
> & {
  onProgress?(event: KanaMcpRuntimeProgressEvent): void;
};

export class KanaMcpRuntime {
  private readonly env: NodeJS.ProcessEnv;
  private readonly managerOptions: Omit<CreateKanaMcpManagerOptions, "enabledServerIds">;
  private manager?: ReturnType<typeof createKanaMcpManager>;
  private toolsData: Tool[] = [];
  private selectedServerIdsData: string[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private activeOperation?: KanaMcpRuntimeOperation;
  private startRequested = false;
  private closeRequested = false;
  private closePromise?: Promise<void>;

  constructor(options: CreateKanaMcpRuntimeOptions = {}) {
    this.env = { ...(options.env ?? process.env) };
    // Runtime reloads reuse these values. Snapshot iterable and object options
    // so a one-shot generator or later caller mutation cannot change behavior.
    this.managerOptions = {
      env: this.env,
      ...(options.reservedToolNames === undefined
        ? {}
        : { reservedToolNames: [...options.reservedToolNames] }),
      ...(options.getLogger === undefined ? {} : { getLogger: options.getLogger }),
      ...(options.clientInfo === undefined ? {} : { clientInfo: { ...options.clientInfo } }),
      onProgress: (event) => {
        if (this.activeOperation !== undefined) {
          options.onProgress?.({ ...event, runtimeOperation: this.activeOperation });
        }
      },
    };
  }

  get tools(): Tool[] {
    return this.toolsData.slice();
  }

  get diagnostics(): McpServerDiagnostic[] {
    return this.manager?.diagnostics ?? [];
  }

  get selectedServerIds(): string[] {
    return this.selectedServerIdsData.slice();
  }

  getToolSource(toolName: string): McpToolSource | undefined {
    return this.manager?.getToolSource(toolName);
  }

  start(): Promise<KanaMcpRuntimeSnapshot> {
    if (this.startRequested) {
      return Promise.reject(new Error("MCP runtime can only be started once."));
    }
    if (this.closeRequested) {
      return Promise.reject(new Error("MCP runtime is closing or closed."));
    }

    this.startRequested = true;
    return this.enqueue("start", () => this.replaceManager());
  }

  reload(): Promise<KanaMcpRuntimeSnapshot> {
    if (!this.startRequested) {
      return Promise.reject(new Error("MCP runtime must be started before it can reload."));
    }
    if (this.closeRequested) {
      return Promise.reject(new Error("MCP runtime is closing or closed."));
    }

    return this.enqueue("reload", () => this.replaceManager());
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closeRequested = true;
      this.closePromise = this.enqueue("close", () => this.closeCurrentManager());
    }
    return this.closePromise;
  }

  private enqueue<T>(operation: KanaMcpRuntimeOperation, task: () => Promise<T>): Promise<T> {
    // Keep lifecycle mutations serialized even when a UI action, process
    // signal, and startup completion arrive in adjacent microtasks.
    const result = this.operationTail.then(async () => {
      this.activeOperation = operation;
      try {
        return await task();
      } finally {
        this.activeOperation = undefined;
      }
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async replaceManager(): Promise<KanaMcpRuntimeSnapshot> {
    if (this.closeRequested) {
      throw new Error("MCP runtime is closing or closed.");
    }

    await this.closeCurrentManager();
    if (this.closeRequested) {
      throw new Error("MCP runtime is closing or closed.");
    }

    const config = loadKanaMcpConfig(this.env);
    const activationState = loadKanaMcpActivationState(this.env);
    const enabledServerIds = new Set(activationState.enabledServers);
    this.selectedServerIdsData = Object.keys(config.mcpServers).filter((serverId) =>
      enabledServerIds.has(serverId),
    );

    const manager = createKanaMcpManager(config, {
      ...this.managerOptions,
      enabledServerIds,
    });
    this.manager = manager;

    try {
      this.toolsData = await manager.start();
      return this.snapshot();
    } catch (error) {
      this.toolsData = [];
      throw error;
    }
  }

  private async closeCurrentManager(): Promise<void> {
    const manager = this.manager;
    this.manager = undefined;
    this.toolsData = [];
    this.selectedServerIdsData = [];
    await manager?.close();
  }

  private snapshot(): KanaMcpRuntimeSnapshot {
    return {
      tools: this.tools,
      diagnostics: this.diagnostics,
      selectedServerIds: this.selectedServerIds,
    };
  }
}

export function createKanaMcpRuntime(options: CreateKanaMcpRuntimeOptions = {}): KanaMcpRuntime {
  return new KanaMcpRuntime(options);
}
