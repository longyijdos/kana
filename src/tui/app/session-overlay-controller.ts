import type { KanaSessionMetadata } from "@/kana";
import {
  DeleteSessionConfirmation,
  type Editor,
  SessionPicker,
  TextBlock,
  type Transcript,
  type SessionPickerDecision,
  type StatusLineState,
} from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { RunPhase } from "./status-phase";

export type SessionOverlayControllerOptions = {
  editor: Editor;
  transcript: Transcript;
  tui: Tui;
  listSessions: () => KanaSessionMetadata[];
  deleteSession: (sessionId: string) => boolean;
  hasCurrentSession: () => boolean;
  onResume: (sessionId: string) => void;
  onStop: () => void;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
};

export class SessionOverlayController {
  private activePicker?: SessionPicker;
  private activeDeleteConfirmation?: DeleteSessionConfirmation;

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
    this.closeResumePicker();
    this.closeDeleteConfirmation();
  }

  private openPicker(picker: SessionPicker): void {
    this.close();
    this.options.editor.clear();
    this.activePicker = picker;
    this.options.tui.insertChildAfter(this.options.editor, picker);
    this.options.tui.setFocus(picker);
    this.options.tui.requestRender(true);
  }

  private finishResumePicker(decision: SessionPickerDecision): void {
    this.close();

    if (decision.type === "cancel") {
      if (!this.options.hasCurrentSession()) {
        this.options.onStop();
        return;
      }

      this.focusEditor();
      return;
    }

    this.options.onResume(decision.session.id);
  }

  private finishDeletePicker(decision: SessionPickerDecision): void {
    this.closeResumePicker();

    if (decision.type === "cancel") {
      this.focusEditor();
      return;
    }

    const confirmation = new DeleteSessionConfirmation(decision.session, (confirmed) => {
      this.finishDeleteConfirmation(decision.session, confirmed);
    });

    this.activeDeleteConfirmation = confirmation;
    this.options.tui.insertChildAfter(this.options.editor, confirmation);
    this.options.tui.setFocus(confirmation);
    this.options.tui.requestRender(true);
  }

  private finishDeleteConfirmation(session: KanaSessionMetadata, confirmed: boolean): void {
    this.closeDeleteConfirmation();

    if (!confirmed) {
      this.focusEditor();
      return;
    }

    const deleted = this.options.deleteSession(session.id);

    this.options.transcript.addChild(
      new TextBlock(
        deleted
          ? `Deleted session ${session.title || session.id}.`
          : `Session not found: ${session.id}`,
        {
          color: deleted ? tuiTheme.muted : tuiTheme.error,
          paddingTop: 1,
        },
      ),
    );
    this.options.updateStatus(deleted ? "idle" : "error", {
      activeTool: undefined,
    });
    this.focusEditor();
  }

  private closeResumePicker(): void {
    if (!this.activePicker) {
      return;
    }

    this.options.tui.removeChild(this.activePicker);
    this.activePicker = undefined;
  }

  private closeDeleteConfirmation(): void {
    if (!this.activeDeleteConfirmation) {
      return;
    }

    this.options.tui.removeChild(this.activeDeleteConfirmation);
    this.activeDeleteConfirmation = undefined;
  }

  private focusEditor(): void {
    this.options.tui.setFocus(this.options.editor);
    this.options.tui.requestRender(true);
  }
}
