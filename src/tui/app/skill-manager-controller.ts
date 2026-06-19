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
};

export class SkillManagerController {
  private activeManager?: SkillManager;
  private skills: KanaSkillActivation[] = [];

  constructor(private readonly options: SkillManagerControllerOptions) {}

  open(): void {
    this.close();
    this.options.editor.clear();

    try {
      const result = this.options.loadSkills();

      this.skills = result.skills;
    } catch (error) {
      this.showError(error);
      this.focusEditor();
      return;
    }

    const manager = new SkillManager(this.skills, (decision) => {
      this.finish(decision);
    });

    this.activeManager = manager;
    this.options.layout.showOverlay(manager);
    this.options.tui.setFocus(manager);
    this.options.tui.requestRender(true);
  }

  close(): void {
    if (!this.activeManager) {
      return;
    }

    this.options.layout.clearOverlay(this.activeManager);
    this.activeManager = undefined;
  }

  private finish(decision: SkillManagerDecision): void {
    if (decision.type === "close") {
      this.close();
      this.focusEditor();
      return;
    }

    try {
      this.options.saveEnabledGlobalSkills(
        this.skills
          .filter((skill) => skill.scope === "global" && skill.enabled)
          .map((skill) => skill.name),
      );
      this.options.onSkillsChanged();
      this.options.updateStatus("idle", {
        activeTool: undefined,
      });
    } catch (error) {
      decision.item.enabled = !decision.enabled;
      this.showError(error);
    }
  }

  private showError(error: unknown): void {
    this.options.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
        paddingTop: 1,
      }),
    );
    this.options.updateStatus("error", {
      activeTool: undefined,
    });
  }

  private focusEditor(): void {
    this.options.tui.setFocus(this.options.editor);
    this.options.tui.requestRender(true);
  }
}
