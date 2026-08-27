import type { KanaUsageScope, KanaUsageSummary } from "@/kana";
import { type Editor, MarkdownBlock, TextBlock, UsageSummaryBlock } from "../components";
import {
  formatPromptCommandHelpLine,
  formatPromptShortcutHelpLine,
  PROMPT_COMMANDS,
  PROMPT_HELP_TITLE,
  PROMPT_SHORTCUTS,
  PROMPT_SHORTCUTS_TITLE,
} from "../components/editor/commands";
import { tuiTheme } from "../theme";
import type { ContentViewerController } from "./content-viewer-controller";
import type { MemoryScope } from "./memory-compact-controller";
import type { StatusProjectionController } from "./status-projection-controller";

export type InformationViewerControllerOptions = {
  editor: Editor;
  contentViewer: ContentViewerController;
  status: StatusProjectionController;
  cleanMode: boolean;
  hyperlinks: boolean;
  renderLatex: boolean;
  renderMermaid: boolean;
  loadMemory: (target: Exclude<MemoryScope, "both">) => string;
  loadUsage: (scope: KanaUsageScope) => KanaUsageSummary;
  renderTodos: (width: number) => string[];
  showError: (error: unknown) => void;
};

export class InformationViewerController {
  constructor(private readonly options: InformationViewerControllerOptions) {}

  openMemory(target: MemoryScope): void {
    const memoryTargets =
      target === "both" ? (["global", "project"] as const) : ([target] as const);
    const markdown = new MarkdownBlock(
      memoryTargets
        .flatMap((memoryTarget, index) => [
          ...(index > 0 ? [""] : []),
          `# ${memoryTarget === "global" ? "Global" : "Project"} memory`,
          "",
          this.options.loadMemory(memoryTarget).trim() || "No saved memory.",
        ])
        .join("\n"),
      {
        hyperlinks: this.options.hyperlinks,
        renderLatex: this.options.renderLatex,
        renderMermaid: this.options.renderMermaid,
      },
    );

    this.options.contentViewer.open({
      title: "Memory",
      render: (contentWidth) => markdown.render(contentWidth),
    });
  }

  openUsage(scope: KanaUsageScope): void {
    if (this.options.cleanMode && scope === "session") {
      this.options.showError(new Error("Session usage is unavailable in clean mode."));
      return;
    }

    const summary = this.options.loadUsage(scope);
    const usage = new UsageSummaryBlock(summary);
    this.options.editor.clear();
    this.options.contentViewer.open({
      title: `Usage · ${summary.scope}`,
      render: (contentWidth) => usage.render(contentWidth),
    });
    this.markIdle();
  }

  openHelp(): void {
    const help = new TextBlock(
      [
        ...PROMPT_COMMANDS.map(formatPromptCommandHelpLine),
        "",
        PROMPT_SHORTCUTS_TITLE,
        "",
        ...PROMPT_SHORTCUTS.map(formatPromptShortcutHelpLine),
      ].join("\n"),
      { color: tuiTheme.muted },
    );

    this.options.editor.clear();
    this.options.contentViewer.open({
      title: PROMPT_HELP_TITLE,
      render: (contentWidth) => help.render(contentWidth),
    });
    this.markIdle();
  }

  openTodos(): void {
    this.options.contentViewer.open({
      title: "Todos",
      render: this.options.renderTodos,
    });
  }

  private markIdle(): void {
    if (!this.options.status.running) {
      this.options.status.update("idle", { activeTool: undefined });
    }
  }
}
