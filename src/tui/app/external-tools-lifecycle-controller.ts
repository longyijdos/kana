import { TextBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { RunPhase } from "./status-phase";

export type ExternalToolsLoadResult = {
  status?: string;
  warnings?: readonly string[];
};

export type ExternalToolsLifecycleControllerOptions = {
  transcript: Transcript;
  tui: Tui;
  load?: (onProgress: (status: string) => void) => Promise<ExternalToolsLoadResult>;
  reload?: (onProgress: (status: string) => void) => Promise<ExternalToolsLoadResult>;
  isStopping: () => boolean;
  onToolsChanged: () => void;
  onReady: () => void;
  updateStatus: (phase: RunPhase) => void;
  focusEditor: () => void;
  clearFocus: () => void;
};

export class ExternalToolsLifecycleController {
  private loaded: boolean;
  private loadPromise?: Promise<boolean>;
  private loadingOperation?: symbol;
  private isLoading = false;

  constructor(private readonly options: ExternalToolsLifecycleControllerOptions) {
    this.loaded = options.load === undefined;
  }

  get loading(): boolean {
    return this.isLoading;
  }

  load(): Promise<boolean> {
    if (this.loaded || this.options.load === undefined) {
      return Promise.resolve(true);
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const loadingOperation = this.beginLoading("Starting MCP servers...");

    this.loadPromise = this.options
      .load((status) => this.updateProgress(loadingOperation, status))
      .then((result) => {
        if (this.options.isStopping()) {
          this.endLoading(loadingOperation);
          return false;
        }

        this.loaded = true;
        this.endLoading(loadingOperation);
        this.renderResult(result);
        this.options.onToolsChanged();
        this.options.updateStatus("idle");
        this.options.focusEditor();
        this.options.tui.requestRender();
        this.options.onReady();
        return true;
      })
      .catch((error) => {
        this.endLoading(loadingOperation);
        if (!this.options.isStopping()) {
          this.options.transcript.addChild(
            new TextBlock(
              `Failed to load external tools: ${formatError(error)}\nPress Ctrl+C to exit.`,
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

    try {
      const result = await reload((status) => this.updateProgress(loadingOperation, status));
      if (this.options.isStopping()) {
        return;
      }

      this.renderResult(result);
      this.options.onToolsChanged();
      this.options.updateStatus("idle");
      this.options.focusEditor();
      this.options.tui.requestRender();
    } catch (error) {
      if (this.options.isStopping()) {
        return;
      }

      this.options.transcript.addChild(
        new TextBlock(`Failed to reload MCP servers: ${formatError(error)}`, {
          color: tuiTheme.error,
        }),
      );
      // Runtime failure clears its tool set. Recreate the idle Agent so it
      // cannot keep calling tools backed by the manager that was just closed.
      this.options.onToolsChanged();
      this.options.updateStatus("error");
      this.options.focusEditor();
      this.options.tui.requestRender();
    } finally {
      this.endLoading(loadingOperation);
      if (!this.options.isStopping()) {
        this.options.onReady();
      }
    }
  }

  private beginLoading(message: string): symbol {
    this.isLoading = true;
    const loadingOperation = Symbol("external-tools-loading");
    this.loadingOperation = loadingOperation;
    this.options.transcript.addChild(new TextBlock(message, { color: tuiTheme.muted }));
    this.options.updateStatus("starting");
    this.options.clearFocus();
    this.options.tui.requestRender();
    return loadingOperation;
  }

  private updateProgress(loadingOperation: symbol, status: string): void {
    if (this.options.isStopping() || this.loadingOperation !== loadingOperation) {
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
    this.isLoading = false;
  }

  private renderResult(result: ExternalToolsLoadResult): void {
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
