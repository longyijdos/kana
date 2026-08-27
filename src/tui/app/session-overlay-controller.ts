import type { KanaSessionMetadata } from "@/kana";
import {
  DeleteSessionConfirmation,
  type Editor,
  SessionPicker,
  type SessionPickerDecision,
  type StatusLineState,
  TextBlock,
  type Transcript,
} from "../components";
import { tuiTheme } from "../theme";
import type { BottomAreaController } from "./bottom-area-controller";
import type { RunPhase } from "./status-phase";

export type SessionOverlayControllerOptions = {
  editor: Editor;
  bottomArea: BottomAreaController;
  transcript: Transcript;
  listSessions: () => KanaSessionMetadata[];
  deleteSession: (sessionId: string) => Promise<boolean> | boolean;
  hasCurrentSession: () => boolean;
  onResume: (sessionId: string) => void;
  onStop: () => void;
  onError: (error: unknown) => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
};

export class SessionOverlayController {
  private activePicker?: SessionPicker;
  private activeDeleteConfirmation?: DeleteSessionConfirmation;
  private deletingSession = false;

  constructor(private readonly options: SessionOverlayControllerOptions) {}

  openResume(): void {
    const picker = new SessionPicker(this.options.listSessions(), (decision) => {
      this.finishResumePicker(decision);
    });

    this.openPicker(picker);
  }

  openDelete(): void {
    const picker = new SessionPicker(this.options.listSessions(), (decision) => {
      this.finishDeletePicker(decision);
    });

    this.openPicker(picker);
  }

  close(): void {
    const activeBottom = this.activeDeleteConfirmation ?? this.activePicker;
    const restoreFocus = activeBottom ? this.options.bottomArea.hasFocus(activeBottom) : false;

    this.closeResumePicker();
    this.closeDeleteConfirmation();

    if (activeBottom) {
      this.options.bottomArea.restore(activeBottom, restoreFocus);
    }
  }

  private openPicker(picker: SessionPicker): void {
    this.close();
    this.options.editor.clear();
    this.activePicker = picker;
    this.options.bottomArea.show(picker);
  }

  private finishResumePicker(decision: SessionPickerDecision): void {
    this.close();

    if (decision.type === "cancel") {
      if (!this.options.hasCurrentSession()) {
        this.options.onStop();
        return;
      }

      return;
    }

    this.options.onResume(decision.session.id);
  }

  private finishDeletePicker(decision: SessionPickerDecision): void {
    if (decision.type === "cancel") {
      this.close();
      return;
    }

    this.closeResumePicker();

    const confirmation = new DeleteSessionConfirmation(decision.session, (confirmed) => {
      void this.finishDeleteConfirmation(decision.session, confirmed);
    });

    this.activeDeleteConfirmation = confirmation;
    this.options.bottomArea.show(confirmation);
  }

  private async finishDeleteConfirmation(
    session: KanaSessionMetadata,
    confirmed: boolean,
  ): Promise<void> {
    if (this.deletingSession) {
      return;
    }
    if (!confirmed) {
      this.close();
      return;
    }

    this.deletingSession = true;
    let deleted: boolean;
    try {
      deleted = await this.options.deleteSession(session.id);
    } catch (error) {
      this.close();
      this.options.onError(error);
      return;
    } finally {
      this.deletingSession = false;
    }

    this.options.transcript.addChild(
      new TextBlock(
        deleted
          ? `Deleted session ${session.title || session.id}.`
          : `Session not found: ${session.id}`,
        {
          color: deleted ? tuiTheme.muted : tuiTheme.error,
        },
      ),
    );
    this.options.updateStatus(deleted ? "idle" : "error", {
      activeTool: undefined,
    });
    this.close();
  }

  private closeResumePicker(): void {
    if (!this.activePicker) {
      return;
    }

    this.activePicker = undefined;
  }

  private closeDeleteConfirmation(): void {
    if (!this.activeDeleteConfirmation) {
      return;
    }

    this.activeDeleteConfirmation = undefined;
  }
}
