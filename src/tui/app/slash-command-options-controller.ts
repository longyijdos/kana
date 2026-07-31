import type { KanaModelManagement, KanaModelProvider, KanaUsageScope } from "@/kana";
import { ChoicePrompt, type Editor, TextPrompt } from "../components";
import type { Component, Tui } from "../runtime";
import type { AppLayout } from "./app-layout";
import type { MemoryScope } from "./memory-compact-controller";
import type { TuiModelSelection, TuiModelSettings } from "./model-selection";

type MemoryAction = "show" | "compact";
type DeepSeekThinkingChoice =
  | "off"
  | KanaModelManagement["model"]["deepseek"]["reasoningEfforts"][number];

export type SlashCommandOptionsControllerOptions = {
  editor: Editor;
  layout: AppLayout;
  tui: Tui;
  onUsageScope: (scope: KanaUsageScope) => void;
  onMemoryShow: (scope: MemoryScope) => void;
  onMemoryCompact: (scope: MemoryScope, request: string | undefined) => void;
  getModelSettings?: () => TuiModelSettings;
  onModelSelect?: (selection: TuiModelSelection) => void;
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

  openModel(): boolean {
    if (!this.options.getModelSettings || !this.options.onModelSelect) {
      return false;
    }

    this.close();
    this.options.editor.clear();
    this.showModelProvider(this.options.getModelSettings().activeProvider);
    return true;
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

  private showModelProvider(defaultValue: KanaModelProvider): void {
    const settings = this.options.getModelSettings?.();
    if (!settings) {
      this.close();
      return;
    }

    const prompt = new ChoicePrompt<KanaModelProvider>({
      title: "Provider",
      options: settings.providers.map((provider) => ({ ...provider })),
      defaultValue,
      onSelect: (provider) => this.replace(prompt, () => this.showModelName(provider)),
      onCancel: () => this.close(),
    });

    this.show(prompt);
  }

  private showModelName(provider: KanaModelProvider, defaultValue?: string): void {
    const settings = this.options.getModelSettings?.();
    if (!settings) {
      this.close();
      return;
    }

    const modelSettings = settings.model[provider];
    const prompt = new ChoicePrompt<string>({
      title: "Model",
      options: modelSettings.available.map((model) => ({ value: model, label: model })),
      defaultValue: defaultValue ?? modelSettings.name,
      onSelect: (model) => this.replace(prompt, () => this.showReasoningEffort(provider, model)),
      onCancel: () => this.replace(prompt, () => this.showModelProvider(provider)),
    });

    this.show(prompt);
  }

  private showReasoningEffort(provider: KanaModelProvider, model: string): void {
    const settings = this.options.getModelSettings?.();
    if (!settings) {
      this.close();
      return;
    }

    if (provider === "deepseek") {
      const current = settings.model.deepseek;
      const prompt = new ChoicePrompt<DeepSeekThinkingChoice>({
        title: "Reasoning effort",
        options: [
          { value: "off", label: "Off" },
          ...current.reasoningEfforts.map((effort) => ({
            value: effort,
            label: formatEffort(effort),
          })),
        ],
        defaultValue: current.thinking ? current.reasoningEffort : "off",
        onSelect: (effort) =>
          this.finish(prompt, () =>
            this.options.onModelSelect?.({
              provider,
              model,
              thinking: effort !== "off",
              reasoningEffort: effort === "off" ? current.reasoningEffort : effort,
            }),
          ),
        onCancel: () => this.replace(prompt, () => this.showModelName(provider, model)),
      });

      this.show(prompt);
      return;
    }

    const current = settings.model["openai-codex"];
    const prompt = new ChoicePrompt<(typeof current.reasoningEfforts)[number]>({
      title: "Reasoning effort",
      options: current.reasoningEfforts.map((effort) => ({
        value: effort,
        label: formatEffort(effort),
      })),
      defaultValue: current.reasoningEffort,
      onSelect: (reasoningEffort) =>
        this.finish(prompt, () =>
          this.options.onModelSelect?.({
            provider,
            model,
            reasoningEffort,
          }),
        ),
      onCancel: () => this.replace(prompt, () => this.showModelName(provider, model)),
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

function formatEffort(effort: string): string {
  return effort === "xhigh" ? "XHigh" : `${effort[0]?.toUpperCase()}${effort.slice(1)}`;
}
