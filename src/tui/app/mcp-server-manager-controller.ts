import type { KanaMcpServerActivation } from "@/kana";
import type { Editor, StatusLineState, Transcript } from "../components";
import { McpServerManager, type McpServerManagerDecision, TextBlock } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { AppLayout } from "./app-layout";
import type { RunPhase } from "./status-phase";

export type McpServerManagerControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  loadServers: () => KanaMcpServerActivation[];
  saveEnabledServerIds: (serverIds: string[]) => void;
  onClose: (changed: boolean) => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
  restoreBottom: (focus: boolean) => void;
};

export class McpServerManagerController {
  private activeManager?: McpServerManager;

  constructor(private readonly options: McpServerManagerControllerOptions) {}

  get active(): boolean {
    return this.activeManager !== undefined;
  }

  open(): void {
    if (this.activeManager) {
      return;
    }

    this.options.editor.clear();

    let servers: KanaMcpServerActivation[];
    try {
      servers = this.options.loadServers();
    } catch (error) {
      this.showError(error);
      this.options.restoreBottom(true);
      return;
    }

    const manager = new McpServerManager(
      servers.map((server) =>
        server.type === "stdio" ? { ...server, args: server.args.slice() } : { ...server },
      ),
      (decision) => this.finish(decision),
    );
    this.activeManager = manager;
    this.options.layout.showBottom(manager);
    this.options.tui.setFocus(manager);
    this.options.tui.requestRender(true);
  }

  close(): void {
    this.closeInternal(false);
  }

  private finish(decision: McpServerManagerDecision): void {
    if (!decision.changed) {
      this.closeInternal(false);
      return;
    }

    try {
      this.options.saveEnabledServerIds(decision.enabledServerIds);
    } catch (error) {
      this.showError(error);
      return;
    }

    this.closeInternal(true);
  }

  private closeInternal(changed: boolean): void {
    const manager = this.activeManager;
    if (!manager) {
      return;
    }

    const wasVisible = this.options.layout.isBottom(manager);
    const restoreFocus = this.options.tui.getFocus() === manager;
    this.activeManager = undefined;

    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
    }
    this.options.onClose(changed);
  }

  private showError(error: unknown): void {
    this.options.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
      }),
    );
    this.options.updateStatus("error", { activeTool: undefined });
    this.options.tui.requestRender(true);
  }
}
