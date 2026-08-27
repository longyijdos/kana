import type {
  ConversationRuntime,
  ConversationSessionSnapshot,
  KanaSessionTimelineEntry,
} from "@/kana";
import { type Editor, TextBlock, type Transcript, WelcomeBlock } from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import type { AppLayout } from "./app-layout";
import { addHistoryTimelineToTranscript } from "./history";
import type { TuiModelSelection } from "./model-selection";
import { SessionOverlayController } from "./session-overlay-controller";
import type { RunPhase } from "./status-phase";
import { WELCOME_LOGO_LINES } from "./welcome-logo";

export type SessionLifecycleControllerOptions = {
  conversation: ConversationRuntime<TuiModelSelection>;
  editor: Editor;
  layout: AppLayout;
  transcript: Transcript;
  tui: Tui;
  hyperlinks?: boolean;
  renderLatex?: boolean;
  renderMermaid?: boolean;
  isRunning: () => boolean;
  closeOtherOverlays: () => void;
  closeContentViewer: () => void;
  resetAgentEvents: () => void;
  clearMcpOAuthBlocks: () => void;
  updateContextUsage: () => void;
  updateStatus: (phase: RunPhase) => void;
  restoreBottom: (focus: boolean) => void;
  showError: (error: unknown) => void;
  stop: () => void;
  submitPrompt: (prompt: string) => Promise<void>;
  activateSession: () => void;
  savedSessionsAvailable?: boolean;
};

export class SessionLifecycleController {
  private readonly overlay: SessionOverlayController;

  constructor(private readonly options: SessionLifecycleControllerOptions) {
    this.overlay = new SessionOverlayController({
      editor: options.editor,
      layout: options.layout,
      transcript: options.transcript,
      tui: options.tui,
      listSessions: () => options.conversation.listSessions(),
      deleteSession: (sessionId) => options.conversation.deleteSession(sessionId),
      hasCurrentSession: () => options.conversation.sessionId !== undefined,
      onResume: (sessionId) => {
        void this.resume(sessionId);
      },
      onStop: options.stop,
      onError: options.showError,
      updateStatus: (phase) => options.updateStatus(phase),
      restoreBottom: options.restoreBottom,
    });
  }

  initializeTranscript(timeline: KanaSessionTimelineEntry[]): void {
    if (timeline.length > 0) {
      this.options.transcript.addChild(
        new TextBlock(`Resumed session ${this.options.conversation.sessionId ?? ""}.`, {
          color: tuiTheme.muted,
        }),
      );
      addHistoryTimelineToTranscript(this.options.transcript, timeline, {
        hyperlinks: this.options.hyperlinks,
        renderLatex: this.options.renderLatex,
        renderMermaid: this.options.renderMermaid,
      });
      return;
    }

    this.options.transcript.addChild(
      new WelcomeBlock({
        logoLines: WELCOME_LOGO_LINES,
        recentSessions: this.options.conversation.listSessions(),
        savedSessionsAvailable: this.options.savedSessionsAvailable,
      }),
    );
  }

  async startNew(): Promise<void> {
    if (this.options.isRunning()) {
      return;
    }

    try {
      await this.options.conversation.startNewSession();
    } catch (error) {
      this.options.showError(error);
      return;
    }
    this.overlay.close();
    this.options.closeContentViewer();
    this.options.resetAgentEvents();
    this.options.transcript.clear();
    this.options.clearMcpOAuthBlocks();
    this.options.editor.clear();
    this.initializeTranscript([]);
    this.options.updateContextUsage();
    this.options.updateStatus("idle");
    this.options.tui.requestRender();
  }

  async fork(prompt: string): Promise<void> {
    if (this.options.isRunning()) {
      return;
    }

    let session: ConversationSessionSnapshot;
    try {
      session = await this.options.conversation.forkSession(prompt);
    } catch (error) {
      this.options.showError(error);
      return;
    }
    this.overlay.close();
    this.options.closeContentViewer();
    this.options.editor.clear();
    this.options.transcript.addChild(
      new TextBlock(`Forked session ${session.id}.`, {
        color: tuiTheme.muted,
      }),
    );
    this.options.updateStatus("idle");
    this.options.tui.requestRender();
    await this.options.submitPrompt(prompt);
  }

  openResume(): void {
    if (this.options.isRunning()) {
      return;
    }

    this.options.closeOtherOverlays();
    this.options.closeContentViewer();
    this.overlay.openResume();
  }

  openDelete(): void {
    if (this.options.isRunning()) {
      return;
    }

    this.options.closeOtherOverlays();
    this.options.closeContentViewer();
    this.overlay.openDelete();
  }

  close(): void {
    this.overlay.close();
  }

  async resume(sessionId: string): Promise<void> {
    if (this.options.isRunning()) {
      return;
    }

    let session: ConversationSessionSnapshot;

    try {
      session = await this.options.conversation.resumeSession(sessionId);
    } catch (error) {
      this.options.showError(error);
      this.overlay.close();
      this.options.tui.setFocus(this.options.editor);
      this.options.tui.requestRender();
      return;
    }

    this.overlay.close();
    this.options.closeContentViewer();
    this.options.resetAgentEvents();
    this.options.transcript.clear();
    this.options.clearMcpOAuthBlocks();
    this.options.editor.clear();
    this.initializeTranscript(session.timeline);
    this.options.updateContextUsage();
    this.options.updateStatus("idle");
    this.options.tui.setFocus(this.options.editor);
    this.options.tui.requestRender();
    this.options.activateSession();
  }
}
