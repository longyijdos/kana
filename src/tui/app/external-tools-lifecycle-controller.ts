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
};

export class ExternalToolsLifecycleController {
  private loaded: boolean;
  private loadPromise?: Promise<boolean>;
  private loadingBlock?: TextBlock;
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

    const loadingBlock = this.beginLoading("Starting external tools...");

    this.loadPromise = this.options
      .load((status) => this.updateProgress(loadingBlock, status))
      .then((result) => {
        if (this.options.isStopping()) {
          return false;
        }

        this.loaded = true;
        this.isLoading = false;
        this.finishLoading(loadingBlock, result);
        this.options.onToolsChanged();
        this.options.updateStatus("idle");
        this.options.focusEditor();
        this.options.tui.requestRender();
        this.options.onReady();
        return true;
      })
      .catch((error) => {
        if (!this.options.isStopping()) {
          this.isLoading = false;
          this.loadingBlock = undefined;
          this.options.transcript.removeChild(loadingBlock);
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

    const loadingBlock = this.beginLoading("Reloading MCP servers...");

    try {
      const result = await reload((status) => this.updateProgress(loadingBlock, status));
      if (this.options.isStopping()) {
        return;
      }

      this.finishLoading(loadingBlock, result);
      this.options.onToolsChanged();
      this.options.updateStatus("idle");
      this.options.focusEditor();
      this.options.tui.requestRender();
    } catch (error) {
      if (this.options.isStopping()) {
        return;
      }

      this.loadingBlock = undefined;
      this.options.transcript.removeChild(loadingBlock);
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
      this.isLoading = false;
      if (!this.options.isStopping()) {
        this.options.onReady();
      }
    }
  }

  private beginLoading(message: string): TextBlock {
    this.isLoading = true;
    const loadingBlock = new TextBlock(message, { color: tuiTheme.muted });
    this.loadingBlock = loadingBlock;
    this.options.transcript.addChild(loadingBlock);
    this.options.updateStatus("starting");
    this.options.tui.setFocus(undefined);
    this.options.tui.requestRender();
    return loadingBlock;
  }

  private updateProgress(loadingBlock: TextBlock, status: string): void {
    if (this.options.isStopping() || this.loadingBlock !== loadingBlock) {
      return;
    }

    loadingBlock.setText(status);
    this.options.tui.requestRender();
  }

  private finishLoading(loadingBlock: TextBlock, result: ExternalToolsLoadResult): void {
    this.loadingBlock = undefined;
    if (result.status === undefined) {
      this.options.transcript.removeChild(loadingBlock);
    } else {
      loadingBlock.setText(result.status);
    }
    for (const warning of result.warnings ?? []) {
      this.options.transcript.addChild(new TextBlock(warning, { color: tuiTheme.error }));
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
