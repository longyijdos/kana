import { TextBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";

export type ContextCompactControllerOptions = {
  transcript: Transcript;
  tui: Tui;
  canCompact: () => boolean;
  compact: () => Promise<unknown>;
};

export class ContextCompactController {
  private activeBlock?: TextBlock;

  constructor(private readonly options: ContextCompactControllerOptions) {}

  handleCompacted(): void {
    this.removeActiveBlock();
  }

  async compact(): Promise<void> {
    if (!this.options.canCompact()) {
      return;
    }

    const block = new TextBlock("Compacting context…", {
      color: tuiTheme.muted,
    });
    this.activeBlock = block;
    this.options.transcript.addChild(block);
    this.options.tui.requestRender();

    try {
      await this.options.compact();
    } catch {
      // The runtime publishes run_error before rejecting the compact promise.
    } finally {
      this.options.transcript.removeChild(block);
      if (this.activeBlock === block) {
        this.activeBlock = undefined;
      }
      this.options.tui.requestRender();
    }
  }

  private removeActiveBlock(): void {
    if (!this.activeBlock) {
      return;
    }

    this.options.transcript.removeChild(this.activeBlock);
    this.activeBlock = undefined;
  }
}
