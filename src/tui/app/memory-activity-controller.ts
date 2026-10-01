import type { MemoryConsolidationActivitySource } from "@/kana";
import type { Editor } from "../components";
import type { Tui } from "../runtime";

type MemoryActivityControllerOptions = {
  source?: MemoryConsolidationActivitySource;
  editor: Editor;
  tui: Tui;
  showError: (error: string) => void;
};

export class MemoryActivityController {
  private unsubscribe?: () => void;

  constructor(private readonly options: MemoryActivityControllerOptions) {}

  get active(): boolean {
    return (this.options.source?.getActivity().length ?? 0) > 0;
  }

  bind(): void {
    this.unsubscribe = this.options.source?.subscribe((event) => {
      if (event.type === "failed") {
        this.options.showError(`Memory consolidation failed · ${event.scope} · ${event.error}`);
      }
      this.refresh();
    });
    this.refresh();
  }

  unbind(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.options.editor.setMemoryActivity([]);
    this.options.tui.requestRender();
  }

  private refresh(): void {
    this.options.editor.setMemoryActivity(this.options.source?.getActivity() ?? []);
    this.options.tui.requestRender();
  }
}
