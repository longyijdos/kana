import { formatError } from "@/utils";
import { TextBlock, type Transcript } from "../components";
import { tuiTheme } from "../theme";
import type { StatusProjectionController } from "./status-projection-controller";

export type InteractionErrorReporterOptions = {
  transcript: Transcript;
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
  }

  private append(error: unknown): void {
    this.options.transcript.addChild(
      new TextBlock(formatError(error), {
        color: tuiTheme.error,
      }),
    );
  }
}
