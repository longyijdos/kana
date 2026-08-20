import type { KanaSkillActivation, LoadKanaSkillActivationsResult } from "@/kana";
import type { Editor, StatusLineState, Transcript } from "../components";
import { SkillManager, type SkillManagerDecision, TextBlock } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { AppLayout } from "./app-layout";
import type { RunPhase } from "./status-phase";

export type SkillManagerControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  loadSkills: () => LoadKanaSkillActivationsResult;
  saveEnabledGlobalSkills: (names: string[]) => void;
  onSkillsChanged: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
  restoreBottom: (focus: boolean) => void;
};

export class SkillManagerController {
  private activeManager?: SkillManager;
  private skills: KanaSkillActivation[] = [];

  constructor(private readonly options: SkillManagerControllerOptions) {}

  get active(): boolean {
    return this.activeManager !== undefined;
  }

  open(): void {
    this.close();
    this.options.editor.clear();

    try {
      const result = this.options.loadSkills();

      this.skills = result.skills.map((skill) => ({ ...skill }));
    } catch (error) {
      this.showError(error);
      this.options.restoreBottom(true);
      return;
    }

    const manager = new SkillManager(this.skills, (decision) => {
      this.finish(decision);
    });

    this.activeManager = manager;
    this.options.layout.showBottom(manager);
    this.options.tui.setFocus(manager);
    this.options.tui.requestRender();
  }

  close(): void {
    if (!this.activeManager) {
      return;
    }

    const wasVisible = this.options.layout.isBottom(this.activeManager);
    const restoreFocus = this.options.tui.getFocus() === this.activeManager;
    this.activeManager = undefined;

    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
    }
  }

  private finish(decision: SkillManagerDecision): void {
    if (!decision.changed) {
      this.close();
      return;
    }

    try {
      this.options.saveEnabledGlobalSkills(decision.enabledGlobalSkillNames);
    } catch (error) {
      this.showError(error);
      return;
    }

    this.close();
    try {
      this.options.onSkillsChanged();
      this.options.updateStatus("idle", { activeTool: undefined });
    } catch (error) {
      // Persistence already succeeded, so report the refresh error without
      // presenting the saved activation state as an unsaved draft.
      this.showError(error);
    }
  }

  private showError(error: unknown): void {
    this.options.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
      }),
    );
    this.options.updateStatus("error", {
      activeTool: undefined,
    });
  }
}
