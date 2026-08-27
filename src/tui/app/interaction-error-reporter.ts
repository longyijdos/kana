import { TextBlock, type Transcript } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { StatusProjectionController } from "./status-projection-controller";

export type InteractionErrorReporterOptions = {
  transcript: Transcript;
  tui: Tui;
  status: StatusProjectionController;
};

export class InteractionErrorReporter {
  constructor(private readonly options: InteractionErrorReporterOptions) {}

  showRunError(error: unknown): void {
    this.append(error);
    this.options.status.update("error");
  }

  showInteractionError(error: unknown): void {
    this.append(error);
    if (!this.options.status.running) {
      this.options.status.update("error");
    }
  }

  showOverlayError(error: unknown): void {
    this.append(error);
    this.options.status.update("error", { activeTool: undefined });
    this.options.tui.requestRender();
  }

  private append(error: unknown): void {
    this.options.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
      }),
    );
  }
}
