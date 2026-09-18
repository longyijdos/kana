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
      this.handlePickerDecision(decision);
    });

    this.openPicker(picker);
  }

  close(): void {
    const activeBottom = this.activeDeleteConfirmation ?? this.activePicker;
    const restoreFocus = activeBottom ? this.options.bottomArea.hasFocus(activeBottom) : false;

    this.activePicker = undefined;
    this.activeDeleteConfirmation = undefined;

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

  private handlePickerDecision(decision: SessionPickerDecision): void {
    if (decision.type === "cancel") {
      this.close();

      if (!this.options.hasCurrentSession()) {
        this.options.onStop();
      }
      return;
    }

    if (decision.type === "delete") {
      this.openDeleteConfirmation(decision.session);
      return;
    }

    this.close();
    this.options.onResume(decision.session.id);
  }

  private openDeleteConfirmation(session: KanaSessionMetadata): void {
    const confirmation = new DeleteSessionConfirmation(session, (confirmed) => {
      void this.finishDeleteConfirmation(session, confirmed);
    });

    this.activeDeleteConfirmation = confirmation;
    this.options.bottomArea.show(confirmation);
  }

  // The picker instance survives deletion so its selection stays on the item that
  // takes the deleted slot; only the visible bottom swaps to the confirmation.
  private async finishDeleteConfirmation(
    session: KanaSessionMetadata,
    confirmed: boolean,
  ): Promise<void> {
    if (this.deletingSession) {
      return;
    }

    const picker = this.activePicker;
    if (!confirmed) {
      this.restorePicker(picker);
      return;
    }

    this.deletingSession = true;
    let deleted: boolean;
    try {
      deleted = await this.options.deleteSession(session.id);
    } catch (error) {
      this.restorePicker(picker);
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
    if (deleted) {
      this.options.updateStatus("idle", { activeTool: undefined });
      picker?.replaceSessions(this.options.listSessions());
    }
    this.restorePicker(picker);
  }

  private restorePicker(picker: SessionPicker | undefined): void {
    this.activeDeleteConfirmation = undefined;

    if (picker && this.activePicker === picker) {
      this.options.bottomArea.show(picker);
      return;
    }

    this.close();
  }
}
