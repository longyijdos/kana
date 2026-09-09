import path from "node:path";
import type {
  KanaSubagentClient,
  KanaSubagentInspection,
  KanaSubagentSummary,
  LoadKanaSubagentProfilesResult,
} from "@/kana";
import { type Editor, SubagentManager, type SubagentManagerAction } from "../components";
import type { Tui } from "../runtime";
import type { BottomAreaController } from "./bottom-area-controller";

export type SubagentManagerControllerOptions = {
  editor: Editor;
  bottomArea: BottomAreaController;
  tui: Tui;
  getSubagents: () => KanaSubagentClient | undefined;
  loadProfiles: () => LoadKanaSubagentProfilesResult;
  inspect: (inspection: KanaSubagentInspection) => void;
  showError: (error: unknown) => void;
  onClose: () => void;
};

export class SubagentManagerController {
  private manager?: SubagentManager;
  private subagents?: KanaSubagentClient;
  private unsubscribe?: () => void;
  private cancelling = false;

  constructor(private readonly options: SubagentManagerControllerOptions) {}

  get active(): boolean {
    return this.manager !== undefined;
  }

  open(): void {
    if (this.manager) return;
    this.options.editor.clear();
    this.subagents = this.options.getSubagents();
    this.manager = new SubagentManager((action) => this.handle(action));
    this.unsubscribe = this.subagents?.subscribe(() => this.refresh());
    this.refresh();
    this.options.bottomArea.show(this.manager);
  }

  close(): void {
    const manager = this.manager;
    if (!manager) return;
    const restoreFocus = this.options.bottomArea.hasFocus(manager);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.manager = undefined;
    this.subagents = undefined;
    this.options.bottomArea.restore(manager, restoreFocus);
    this.options.onClose();
  }

  private handle(action: SubagentManagerAction): void {
    switch (action.type) {
      case "close":
        this.close();
        break;
      case "refresh":
        this.refresh();
        break;
      case "select":
        this.refreshPreview(action.subagent.id);
        break;
      case "cancel":
        void this.cancel(action.subagent);
        break;
      case "inspect": {
        const inspection = this.subagents?.inspect(action.subagent.id);
        if (inspection) {
          this.close();
          this.options.inspect(inspection);
        }
        break;
      }
    }
  }

  private refresh(notice?: string): void {
    if (!this.manager) return;
    try {
      const loaded = this.options.loadProfiles();
      this.manager.replace(
        loaded.profiles,
        this.subagents?.list() ?? [],
        notice ?? (this.subagents ? formatProfileDiagnostics(loaded) : "No active session."),
      );
      this.refreshPreview(this.manager.selectedSubagent?.id);
    } catch (error) {
      this.options.showError(error);
      this.manager.replace([], [], "Unable to load subagents.");
    }
    this.options.tui.requestRender();
  }

  private refreshPreview(agentId: string | undefined): void {
    if (!this.manager) return;
    const inspection = agentId ? this.subagents?.inspect(agentId) : undefined;
    this.manager.replacePreview(inspection);
    this.options.tui.requestRender();
  }

  private async cancel(subagent: KanaSubagentSummary): Promise<void> {
    if (this.cancelling || !this.subagents) return;
    this.cancelling = true;
    try {
      const settlement = this.subagents.cancel(subagent.id, {
        source: "tui",
        reason: "Stopped from the /agents manager.",
      });
      this.refresh(`Cancelling ${shortId(subagent.id)}...`);
      const result = await settlement;
      this.refresh(`${shortId(result.id)} ${result.status}.`);
    } catch (error) {
      this.options.showError(error);
      this.refresh("Unable to cancel subagent.");
    } finally {
      this.cancelling = false;
    }
  }
}

function shortId(id: string): string {
  return id.startsWith("agent_") ? id.slice(6, 14) : id.slice(0, 8);
}

function formatProfileDiagnostics(loaded: LoadKanaSubagentProfilesResult): string | undefined {
  const [first] = loaded.diagnostics;
  if (!first) return undefined;
  const suffix = loaded.diagnostics.length > 1 ? ` (+${loaded.diagnostics.length - 1} more)` : "";
  return `Invalid profile ${path.basename(first.path)}: ${first.message}${suffix}`;
}
