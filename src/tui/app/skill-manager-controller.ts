import type { KanaSkillActivation, LoadKanaSkillActivationsResult } from "@/kana";
import type { Editor, StatusLineState } from "../components";
import { SkillManager, type SkillManagerDecision } from "../components";
import type { BottomAreaController } from "./bottom-area-controller";
import type { RunPhase } from "./status-phase";

export type SkillManagerControllerOptions = {
  editor: Editor;
  bottomArea: BottomAreaController;
  loadSkills: () => LoadKanaSkillActivationsResult;
  saveEnabledGlobalSkills: (names: string[]) => void;
  onSkillsChanged: () => void;
  showError: (error: unknown) => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
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
      this.options.showError(error);
      this.options.bottomArea.showFallback();
      return;
    }

    const manager = new SkillManager(this.skills, (decision) => {
      this.finish(decision);
    });

    this.activeManager = manager;
    this.options.bottomArea.show(manager);
  }

  close(): void {
    if (!this.activeManager) {
      return;
    }

    const manager = this.activeManager;
    const restoreFocus = this.options.bottomArea.hasFocus(manager);
    this.activeManager = undefined;
    this.options.bottomArea.restore(manager, restoreFocus);
  }

  private finish(decision: SkillManagerDecision): void {
    if (!decision.changed) {
      this.close();
      return;
    }

    try {
      this.options.saveEnabledGlobalSkills(decision.enabledGlobalSkillNames);
    } catch (error) {
      this.options.showError(error);
      return;
    }

    this.close();
    try {
      this.options.onSkillsChanged();
      this.options.updateStatus("idle", { activeTool: undefined });
    } catch (error) {
      // Persistence already succeeded, so report the refresh error without
      // presenting the saved activation state as an unsaved draft.
      this.options.showError(error);
    }
  }
}
