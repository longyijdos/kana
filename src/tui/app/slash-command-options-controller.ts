import type {
  KanaModelProvider,
  KanaToolApprovalMode,
  KanaUsageScope,
  KanaUserTaskManager,
} from "@/kana";
import { ChoicePrompt, ContentViewer, type Editor, TextPrompt } from "../components";
import { summarizeText, wrapPlainText } from "../render";
import type { Component } from "../runtime";
import { tuiTheme } from "../theme";
import type { BottomAreaController } from "./bottom-area-controller";
import type { MemoryScope } from "./memory-compact-controller";
import type { TuiModelSelection, TuiModelSettings } from "./model-selection";

type MemoryAction = "show" | "compact";

export type SlashCommandOptionsControllerOptions = {
  editor: Editor;
  bottomArea: BottomAreaController;
  onUsageScope: (scope: KanaUsageScope) => void;
  onMemoryShow: (scope: MemoryScope) => void;
  onMemoryCompact: (scope: MemoryScope, request: string | undefined) => void;
  getApprovalMode: () => KanaToolApprovalMode;
  onApprovalModeSelect: (mode: KanaToolApprovalMode) => void;
  getUserTasks?: () => KanaUserTaskManager | undefined;
  collapseLongPastes?: boolean;
  getModelSettings?: () => TuiModelSettings;
  onModelSelect?: (selection: TuiModelSelection) => void;
  showError?: (error: unknown) => void;
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

  openApproval(): void {
    this.close();
    this.options.editor.clear();
    this.showApprovalMode();
  }

  openTask(defaultTaskId?: string): void {
    this.close();
    this.options.editor.clear();
    const tasks =
      this.options
        .getUserTasks?.()
        ?.list()
        .filter((task) => task.status === "pending") ?? [];
    const prompt = new ChoicePrompt<string>({
      title: "Your tasks",
      detail: tasks.length === 0 ? "No pending tasks. Press Esc to close." : undefined,
      options: tasks.map((task) => ({
        value: task.id,
        label: `${task.id.slice(5, 13)} · ${summarizeText(task.task, 64)}`,
      })),
      defaultValue: defaultTaskId ?? tasks[0]?.id ?? "",
      onSelect: (taskId) => {
        const task = tasks.find((item) => item.id === taskId);
        if (task) this.replace(prompt, () => this.showTaskAction(task.id, task.task));
      },
      onCancel: () => this.close(),
    });
    this.show(prompt);
  }

  private showTaskDetail(taskId: string, description: string): void {
    const viewer = new ContentViewer(
      {
        title: `Task ${taskId.slice(5, 13)}`,
        render: (width) => wrapPlainText(description, width),
      },
      { onClose: () => this.replace(viewer, () => this.showTaskAction(taskId, description)) },
    );
    this.show(viewer);
  }

  private showTaskAction(taskId: string, description: string): void {
    const prompt = new ChoicePrompt<"view" | "done" | "return">({
      title: `Task ${taskId.slice(5, 13)}`,
      options: [
        { value: "view", label: "View full task" },
        { value: "done", label: "Submit completed result" },
        { value: "return", label: "Return to Kana" },
      ],
      defaultValue: "view",
      onSelect: (action) =>
        this.replace(prompt, () =>
          action === "view"
            ? this.showTaskDetail(taskId, description)
            : this.showTaskResponse(taskId, description, action),
        ),
      onCancel: () => this.openTask(taskId),
    });
    this.show(prompt);
  }

  private showTaskResponse(taskId: string, description: string, action: "done" | "return"): void {
    const prompt = new TextPrompt({
      title: action === "done" ? "Your result (required)" : "Reason for returning (optional)",
      collapseLongPastes: this.options.collapseLongPastes,
      onSubmit: (value) => {
        try {
          const tasks = this.options.getUserTasks?.();
          if (!tasks) throw new Error("User tasks are unavailable.");
          if (action === "done") tasks.done(taskId, value);
          else tasks.returnToAgent(taskId, value);
          this.finish(prompt, () => {});
        } catch (error) {
          this.options.showError?.(error);
        }
      },
      onCancel: () => this.showTaskAction(taskId, description),
    });
    this.show(prompt);
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
    const restoreFocus = this.options.bottomArea.hasFocus(prompt);

    this.activePrompt = undefined;
    this.options.bottomArea.restore(prompt, restoreFocus);
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

  private showApprovalMode(): void {
    const prompt = new ChoicePrompt<KanaToolApprovalMode>({
      title: "Tool approval mode",
      options: [
        { value: "always", label: formatToolApprovalMode("always") },
        { value: "unless_trusted", label: formatToolApprovalMode("unless_trusted") },
        { value: "never", label: formatToolApprovalMode("never") },
      ],
      defaultValue: this.options.getApprovalMode(),
      onSelect: (mode) => {
        if (mode === "never") {
          this.replace(prompt, () => this.showNeverAskConfirmation());
          return;
        }

        this.finish(prompt, () => this.options.onApprovalModeSelect(mode));
      },
      onCancel: () => this.close(),
    });

    this.show(prompt);
  }

  private showNeverAskConfirmation(): void {
    const prompt = new ChoicePrompt<"yes" | "no">({
      title: "Disable tool approvals?",
      detail:
        "Ordinary Agent tools will run without approval for this session. User task invitations still ask.",
      options: [
        { value: "no", label: "No, keep current mode" },
        { value: "yes", label: "Yes, never ask" },
      ],
      defaultValue: "no",
      titleColor: tuiTheme.error,
      onSelect: (decision) => {
        if (decision === "yes") {
          this.finish(prompt, () => this.options.onApprovalModeSelect("never"));
          return;
        }

        this.replace(prompt, () => this.showApprovalMode());
      },
      onCancel: () => this.replace(prompt, () => this.showApprovalMode()),
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
      collapseLongPastes: this.options.collapseLongPastes,
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
    if (modelSettings.error) {
      this.options.showError?.(new Error(modelSettings.error));
      this.close();
      return;
    }
    const prompt = new ChoicePrompt<string>({
      title: "Model",
      options: modelSettings.available.map((model) => ({
        value: model.name,
        label: model.name,
      })),
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

    const current = settings.model[provider];
    const reasoning = current.available.find((candidate) => candidate.name === model)?.reasoning;
    if (!reasoning) {
      this.options.onModelSelect?.({ provider, model });
      this.close();
      return;
    }

    const currentEffort =
      current.name === model &&
      current.reasoningEffort !== undefined &&
      reasoning.efforts.includes(current.reasoningEffort)
        ? current.reasoningEffort
        : reasoning.defaultEffort;
    const prompt = new ChoicePrompt<string>({
      title: "Reasoning effort",
      options: reasoning.efforts.map((effort) => ({
        value: effort,
        label: formatEffort(effort),
      })),
      defaultValue: currentEffort,
      onSelect: (effort) =>
        this.finish(prompt, () =>
          this.options.onModelSelect?.({
            provider,
            model,
            reasoningEffort: effort,
          }),
        ),
      onCancel: () => this.replace(prompt, () => this.showModelName(provider, model)),
    });

    this.show(prompt);
  }

  private show(prompt: Component): void {
    this.activePrompt = prompt;
    this.options.bottomArea.show(prompt);
  }

  private replace(prompt: Component, next: () => void): void {
    if (this.activePrompt !== prompt || !this.options.bottomArea.isShowing(prompt)) {
      return;
    }

    next();
  }

  private finish(prompt: Component, action: () => void): void {
    if (this.activePrompt !== prompt || !this.options.bottomArea.isShowing(prompt)) {
      return;
    }

    this.activePrompt = undefined;
    action();

    // A terminal action that early-returns without replacing the bottom prompt
    // (for example an unavailable-feature error) must not leave the dismissed
    // prompt on screen and focused, where Esc would be swallowed forever.
    if (this.options.bottomArea.isShowing(prompt)) {
      this.options.bottomArea.restore(prompt);
    }
  }
}

function formatScope(scope: MemoryScope): string {
  return scope[0]?.toUpperCase() + scope.slice(1);
}

function formatEffort(effort: string): string {
  if (effort === "none") {
    return "Off";
  }
  return effort === "xhigh" ? "XHigh" : `${effort[0]?.toUpperCase()}${effort.slice(1)}`;
}

export function formatToolApprovalMode(mode: KanaToolApprovalMode): string {
  switch (mode) {
    case "always":
      return "Always ask";
    case "unless_trusted":
      return "Ask unless trusted";
    case "never":
      return "Never ask";
  }
}
