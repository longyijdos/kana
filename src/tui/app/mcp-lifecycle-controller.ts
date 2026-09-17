import { TextBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { RunPhase } from "./status-phase";

export type McpLoadResult = {
  status?: string;
  warnings?: readonly string[];
};

export type McpLifecycleControllerOptions = {
  transcript: Transcript;
  tui: Tui;
  load?: (onProgress: (status: string) => void, signal: AbortSignal) => Promise<McpLoadResult>;
  reload?: (onProgress: (status: string) => void, signal: AbortSignal) => Promise<McpLoadResult>;
  isStopping: () => boolean;
  onMcpChanged: () => void;
  onReady: () => void;
  updateStatus: (phase: RunPhase) => void;
  focusEditor: () => void;
  clearFocus: () => void;
};

export class McpLifecycleController {
  private loaded: boolean;
  private loadPromise?: Promise<boolean>;
  private loadingOperation?: symbol;
  private loadingController?: AbortController;
  private isLoading = false;

  constructor(private readonly options: McpLifecycleControllerOptions) {
    this.loaded = options.load === undefined;
  }

  get loading(): boolean {
    return this.isLoading;
  }

  cancel(): boolean {
    if (!this.loadingController || this.loadingController.signal.aborted) {
      return false;
    }

    this.loadingController.abort(new Error("MCP loading was cancelled."));
    return true;
  }

  load(): Promise<boolean> {
    if (this.loaded || this.options.load === undefined) {
      return Promise.resolve(true);
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const loadingOperation = this.beginLoading("Starting MCP servers...");
    const signal = this.loadingController!.signal;

    this.loadPromise = this.options
      .load((status) => this.updateProgress(loadingOperation, status), signal)
      .then((result) => {
        if (this.options.isStopping()) {
          this.endLoading(loadingOperation);
          return false;
        }
        if (signal.aborted) {
          return this.finishCancellation(loadingOperation, "MCP startup cancelled.", true);
        }

        this.loaded = true;
        this.endLoading(loadingOperation);
        this.renderResult(result);
        this.options.onMcpChanged();
        this.options.updateStatus("idle");
        this.options.focusEditor();
        this.options.tui.requestRender();
        this.options.onReady();
        return true;
      })
      .catch((error) => {
        if (signal.aborted) {
          return this.finishCancellation(loadingOperation, "MCP startup cancelled.", true);
        }
        this.endLoading(loadingOperation);
        if (!this.options.isStopping()) {
          this.options.transcript.addChild(
            new TextBlock(
              `Failed to start MCP servers: ${formatError(error)}\nPress Ctrl+C to exit.`,
              { color: tuiTheme.error },
            ),
          );
          this.options.updateStatus("error");
          this.options.tui.requestRender();
        }
        return false;
      });

    return this.loadPromise;
  }

  async reload(): Promise<void> {
    const reload = this.options.reload;
    if (!reload || this.options.isStopping() || this.isLoading) {
      return;
    }

    const loadingOperation = this.beginLoading("Reloading MCP servers...");
    const signal = this.loadingController!.signal;

    try {
      const result = await reload(
        (status) => this.updateProgress(loadingOperation, status),
        signal,
      );
      if (this.options.isStopping()) {
        return;
      }
      if (signal.aborted) {
        this.finishCancellation(loadingOperation, "MCP reload cancelled.", false);
        return;
      }

      this.renderResult(result);
      this.options.onMcpChanged();
      this.options.updateStatus("idle");
      this.options.focusEditor();
      this.options.tui.requestRender();
    } catch (error) {
      if (this.options.isStopping()) {
        return;
      }
      if (signal.aborted) {
        this.finishCancellation(loadingOperation, "MCP reload cancelled.", false);
        return;
      }

      this.options.transcript.addChild(
        new TextBlock(`Failed to reload MCP servers: ${formatError(error)}`, {
          color: tuiTheme.error,
        }),
      );
      // Runtime failure clears the registry. Recreate the idle Agent so its
      // gateways cannot retain the manager that was just closed.
      this.options.onMcpChanged();
      this.options.updateStatus("error");
      this.options.focusEditor();
      this.options.tui.requestRender();
    } finally {
      const shouldNotifyReady = this.loadingOperation === loadingOperation;
      this.endLoading(loadingOperation);
      if (shouldNotifyReady && !this.options.isStopping()) {
        this.options.onReady();
      }
    }
  }

  private beginLoading(message: string): symbol {
    this.isLoading = true;
    this.loadingController = new AbortController();
    const loadingOperation = Symbol("mcp-loading");
    this.loadingOperation = loadingOperation;
    this.options.transcript.addChild(new TextBlock(message, { color: tuiTheme.muted }));
    this.options.updateStatus("starting");
    this.options.clearFocus();
    this.options.tui.requestRender();
    return loadingOperation;
  }

  private updateProgress(loadingOperation: symbol, status: string): void {
    if (
      this.options.isStopping() ||
      this.loadingOperation !== loadingOperation ||
      this.loadingController?.signal.aborted
    ) {
      return;
    }

    this.options.transcript.addChild(new TextBlock(status, { color: tuiTheme.muted }));
    this.options.tui.requestRender();
  }

  private endLoading(loadingOperation: symbol): void {
    // A completed callback must not clear a newer reload operation's state.
    if (this.loadingOperation !== loadingOperation) {
      return;
    }

    this.loadingOperation = undefined;
    this.loadingController = undefined;
    this.isLoading = false;
  }

  private finishCancellation(
    loadingOperation: symbol,
    message: string,
    initialLoad: boolean,
  ): boolean {
    this.endLoading(loadingOperation);
    if (this.options.isStopping()) {
      return false;
    }

    if (initialLoad) {
      this.loaded = true;
    }
    this.options.transcript.addChild(new TextBlock(message, { color: tuiTheme.muted }));
    this.options.onMcpChanged();
    this.options.updateStatus("idle");
    this.options.focusEditor();
    this.options.tui.requestRender();
    this.options.onReady();
    return true;
  }

  private renderResult(result: McpLoadResult): void {
    for (const warning of result.warnings ?? []) {
      this.options.transcript.addChild(new TextBlock(warning, { color: tuiTheme.error }));
    }
    if (result.status !== undefined) {
      this.options.transcript.addChild(new TextBlock(result.status, { color: tuiTheme.muted }));
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
