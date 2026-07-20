import type { KanaUsageScope } from "@/kana";
import { ChoicePrompt, type Editor, TextPrompt } from "../components";
import type { Component, Tui } from "../runtime";
import type { AppLayout } from "./app-layout";
import type { MemoryScope } from "./memory-compact-controller";

type MemoryAction = "show" | "compact";

export type SlashCommandOptionsControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  tui: Tui;
  onUsageScope: (scope: KanaUsageScope) => void;
  onMemoryShow: (scope: MemoryScope) => void;
  onMemoryCompact: (scope: MemoryScope, request: string | undefined) => void;
  restoreBottom: (focus: boolean) => void;
};

export class SlashCommandOptionsController {
  private activePrompt?: Component;

  constructor(private readonly options: SlashCommandOptionsControllerOptions) {}

  get active(): boolean {
    return this.activePrompt !== undefined;
  }

  openUsage(): void {
    this.close();
    this.options.editor.clear();

    const prompt = new ChoicePrompt<KanaUsageScope>({
      title: "Usage scope",
      options: [
        { value: "session", label: "Session" },
        { value: "project", label: "Project" },
        { value: "global", label: "Global" },
      ],
      defaultValue: "session",
      onSelect: (scope) => this.finish(prompt, () => this.options.onUsageScope(scope)),
      onCancel: () => this.close(),
    });

    this.show(prompt);
  }

  openMemory(): void {
    this.close();
    this.options.editor.clear();
    this.showMemoryAction();
  }

  close(): void {
    if (!this.activePrompt) {
      return;
    }

    const prompt = this.activePrompt;
    const wasVisible = this.options.layout.isBottom(prompt);
    const restoreFocus = this.options.tui.getFocus() === prompt;

    this.activePrompt = undefined;

    if (wasVisible) {
      this.options.restoreBottom(restoreFocus);
      return;
    }

    this.options.tui.requestRender(true);
  }

  private showMemoryAction(defaultValue: MemoryAction = "show"): void {
    const prompt = new ChoicePrompt<MemoryAction>({
      title: "Memory action",
      options: [
        { value: "show", label: "Show" },
        { value: "compact", label: "Compact" },
      ],
      defaultValue,
      onSelect: (action) => this.replace(prompt, () => this.showMemoryScope(action)),
      onCancel: () => this.close(),
    });

    this.show(prompt);
  }

  private showMemoryScope(action: MemoryAction, defaultValue: MemoryScope = "project"): void {
    const prompt = new ChoicePrompt<MemoryScope>({
      title: "Memory scope",
      options: [
        { value: "project", label: "Project" },
        { value: "global", label: "Global" },
        { value: "both", label: "Both" },
      ],
      defaultValue,
      onSelect: (scope) => {
        if (action === "show") {
          this.finish(prompt, () => this.options.onMemoryShow(scope));
          return;
        }

        this.replace(prompt, () => this.showMemoryRequest(scope));
      },
      onCancel: () => this.replace(prompt, () => this.showMemoryAction(action)),
    });

    this.show(prompt);
  }

  private showMemoryRequest(scope: MemoryScope): void {
    const prompt = new TextPrompt({
      title: `${formatScope(scope)} compaction request (optional)`,
      placeholder: "No additional request",
      onSubmit: (request) =>
        this.finish(prompt, () => this.options.onMemoryCompact(scope, request.trim() || undefined)),
      onCancel: () => this.replace(prompt, () => this.showMemoryScope("compact", scope)),
    });

    this.show(prompt);
  }

  private show(prompt: Component): void {
    this.activePrompt = prompt;
    this.options.layout.showBottom(prompt);
    this.options.tui.setFocus(prompt);
    this.options.tui.requestRender(true);
  }

  private replace(prompt: Component, next: () => void): void {
    if (this.activePrompt !== prompt || !this.options.layout.isBottom(prompt)) {
      return;
    }

    next();
  }

  private finish(prompt: Component, action: () => void): void {
    if (this.activePrompt !== prompt || !this.options.layout.isBottom(prompt)) {
      return;
    }

    this.activePrompt = undefined;
    action();
  }
}

function formatScope(scope: MemoryScope): string {
  return scope[0]?.toUpperCase() + scope.slice(1);
}
