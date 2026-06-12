import type {
  Agent,
  AgentEvent,
  BeforeToolExecutionHook,
  BeforeToolExecutionResult,
} from "@/agent";
import type { KanaSessionMetadata } from "@/kana";
import type { AssistantMessage, Message, ModelMetadata, ToolCallContent } from "@/core";
import { addHistoryMessagesToTranscript } from "./history";
import {
  isThinkingVisible,
  phaseForAgentEndReason,
  phaseForAssistantMessage,
  phaseForStopReason,
  type RunPhase,
} from "./status-phase";
import { ToolCallBlocks } from "./tool-call-blocks";
import { preloadSyntaxHighlighter } from "../utils/syntax-highlighter";
import {
  AssistantMessageBlock,
  DeleteSessionConfirmation,
  Editor,
  SessionPicker,
  type SessionPickerDecision,
  StatusLine,
  type StatusLineState,
  TextBlock,
  ToolApproval,
  type ToolApprovalDecision as ToolApprovalSelection,
  Transcript,
} from "../components";
import {
  isCtrlC,
  isEscape,
} from "../runtime";
import type { ProcessTerminal } from "../runtime";
import { tuiTheme } from "../theme";
import { Tui } from "../runtime";

export type KanaTuiLoadedSession = {
  id: string;
  messages: Message[];
};

export type KanaTuiAppOptions = {
  sessionId?: string;
  initialMessages?: Message[];
  initialPrompt?: string;
  getResumeSessionId: () => string | undefined;
  createNewSession: () => { id: string };
  forkSession: (messages: Message[], prompt: string) => { id: string };
  listSessions: () => KanaSessionMetadata[];
  loadSession: (sessionId: string) => KanaTuiLoadedSession;
  deleteSession: (sessionId: string) => boolean;
  startInResumePicker?: boolean;
};

export class KanaTuiApp {
  private readonly tui: Tui;
  private readonly transcript = new Transcript();
  private readonly toolCallBlocks = new ToolCallBlocks(this.transcript);
  private readonly status: StatusLine;
  private readonly editor = new Editor();
  private agent: Agent;
  private sessionId?: string;
  private running = false;
  private streamingAssistant?: AssistantMessageBlock;
  private activePicker?: SessionPicker;
  private activeDeleteConfirmation?: DeleteSessionConfirmation;

  constructor(
    private readonly createAgent: (options: {
      beforeToolExecution: BeforeToolExecutionHook;
    }) => Agent,
    terminal: ProcessTerminal,
    private readonly options: KanaTuiAppOptions,
  ) {
    this.sessionId = options.sessionId;
    this.tui = new Tui(terminal);
    this.agent = this.createAgentForCurrentSession();
    this.status = new StatusLine(formatModelName(this.agent.state.model.metadata));
  }

  start(): void {
    void preloadSyntaxHighlighter().then(
      () => this.tui.requestRender(),
      () => undefined,
    );

    if (!this.options.startInResumePicker) {
      this.initializeTranscript(this.options.initialMessages ?? []);
    }

    this.tui.addChild(this.transcript);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.status);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.handleGlobalInput(data));
    this.editor.onSubmit = (submit) => {
      if (submit.type === "command") {
        this.handleCommand(submit);
        return;
      }

      void this.submitPrompt(submit.content);
    };

    this.updateStatus("idle");
    this.tui.start();

    if (this.options.startInResumePicker) {
      this.openResumePicker();
      return;
    }

    if (this.options.initialPrompt) {
      void this.submitPrompt(this.options.initialPrompt);
    }
  }

  stop(): void {
    const resumeSessionId = this.options.getResumeSessionId();

    this.tui.stop(
      resumeSessionId
        ? `Resume this session with: kana resume ${resumeSessionId}`
        : "No saved session.",
    );
  }

  private createAgentForCurrentSession(): Agent {
    return this.createAgent({
      beforeToolExecution: ({ toolCall, signal }) =>
        this.showToolApprovalPrompt(toolCall, signal),
    });
  }

  private initializeTranscript(initialMessages: Message[]): void {
    if (initialMessages.length > 0) {
      this.transcript.addChild(
        new TextBlock(`Resumed session ${this.sessionId ?? ""}.`, {
          color: tuiTheme.muted,
        }),
      );
      addHistoryMessagesToTranscript(this.transcript, initialMessages);
      return;
    }

    this.transcript.addChild(
      new TextBlock("Kana TUI. Type a prompt and press Enter.", {
        color: tuiTheme.muted,
      }),
    );
    this.transcript.addChild(
      new TextBlock(
        "Use terminal scrollback for history, /clear to clear display, /new to start fresh, /fork <prompt> to branch, /resume to switch, /delete to remove saved sessions, or /quit to exit.",
        {
          color: tuiTheme.muted,
        },
      ),
    );
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (isCtrlC(data)) {
      if (this.running) {
        this.abort();
        return { consume: true };
      }

      this.stop();
      process.exit(0);
    }

    if (isEscape(data) && this.running) {
      this.abort();
      return { consume: true };
    }

    return undefined;
  }

  private abort(): void {
    this.agent.abort();
    this.updateStatus("aborted");
  }

  private handleCommand(command: {
    name: "quit" | "clear" | "new" | "fork" | "resume" | "delete";
    arguments: string;
    raw: string;
  }): void {
    switch (command.name) {
      case "quit":
        if (command.arguments) {
          void this.submitPrompt(command.raw);
          return;
        }

        this.stop();
        process.exit(0);
        break;
      case "clear":
        if (command.arguments) {
          void this.submitPrompt(command.raw);
          return;
        }

        this.transcript.clear();
        this.editor.clear();
        this.tui.requestRender(true);
        break;
      case "new":
        if (command.arguments) {
          void this.submitPrompt(command.raw);
          return;
        }

        this.startNewSession();
        break;
      case "fork":
        if (!command.arguments) {
          this.showError(new Error("Usage: /fork <prompt>"));
          return;
        }

        void this.forkSession(command.arguments);
        break;
      case "resume":
        if (command.arguments) {
          this.resumeSession(command.arguments);
          return;
        }

        this.openResumePicker();
        break;
      case "delete":
        if (command.arguments) {
          this.showError(new Error("Usage: /delete"));
          return;
        }

        this.openDeletePicker();
        break;
    }
  }

  private startNewSession(): void {
    if (this.running) {
      return;
    }

    this.sessionId = this.options.createNewSession().id;
    this.closeSessionOverlay();
    this.agent.reset();
    this.streamingAssistant = undefined;
    this.toolCallBlocks.clear();
    this.transcript.clear();
    this.editor.clear();
    this.initializeTranscript([]);
    this.updateStatus("idle", {
      activeTool: undefined,
    });
    this.tui.requestRender(true);
  }

  private async forkSession(prompt: string): Promise<void> {
    if (this.running) {
      return;
    }

    this.sessionId = this.options.forkSession(this.agent.state.messages, prompt).id;
    this.closeSessionOverlay();
    this.editor.clear();
    this.transcript.addChild(
      new TextBlock(`Forked session ${this.sessionId}.`, {
        color: tuiTheme.muted,
        paddingTop: 1,
      }),
    );
    this.updateStatus("idle", {
      activeTool: undefined,
    });
    this.tui.requestRender();
    await this.submitPrompt(prompt);
  }

  private openResumePicker(): void {
    if (this.running) {
      return;
    }

    const picker = new SessionPicker(
      this.options.listSessions(),
      (decision) => this.finishResumePicker(decision),
    );

    this.closeSessionOverlay();
    this.editor.clear();
    this.activePicker = picker;
    this.tui.insertChildAfter(this.editor, picker);
    this.tui.setFocus(picker);
    this.tui.requestRender(true);
  }

  private finishResumePicker(decision: SessionPickerDecision): void {
    this.closeSessionOverlay();

    if (decision.type === "cancel") {
      if (!this.sessionId) {
        this.stop();
        return;
      }

      this.tui.setFocus(this.editor);
      this.tui.requestRender(true);
      return;
    }

    this.resumeSession(decision.session.id);
  }

  private closeResumePicker(): void {
    if (!this.activePicker) {
      return;
    }

    this.tui.removeChild(this.activePicker);
    this.activePicker = undefined;
  }

  private openDeletePicker(): void {
    if (this.running) {
      return;
    }

    const picker = new SessionPicker(
      this.options.listSessions(),
      (decision) => this.finishDeletePicker(decision),
    );

    this.closeSessionOverlay();
    this.editor.clear();
    this.activePicker = picker;
    this.tui.insertChildAfter(this.editor, picker);
    this.tui.setFocus(picker);
    this.tui.requestRender(true);
  }

  private finishDeletePicker(decision: SessionPickerDecision): void {
    this.closeResumePicker();

    if (decision.type === "cancel") {
      this.tui.setFocus(this.editor);
      this.tui.requestRender(true);
      return;
    }

    const confirmation = new DeleteSessionConfirmation(decision.session, (confirmed) => {
      this.finishDeleteConfirmation(decision.session, confirmed);
    });

    this.activeDeleteConfirmation = confirmation;
    this.tui.insertChildAfter(this.editor, confirmation);
    this.tui.setFocus(confirmation);
    this.tui.requestRender(true);
  }

  private finishDeleteConfirmation(
    session: KanaSessionMetadata,
    confirmed: boolean,
  ): void {
    this.closeDeleteConfirmation();

    if (!confirmed) {
      this.tui.setFocus(this.editor);
      this.tui.requestRender(true);
      return;
    }

    const deleted = this.options.deleteSession(session.id);

    this.transcript.addChild(
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
    this.updateStatus(deleted ? "idle" : "error", {
      activeTool: undefined,
    });
    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);
  }

  private closeDeleteConfirmation(): void {
    if (!this.activeDeleteConfirmation) {
      return;
    }

    this.tui.removeChild(this.activeDeleteConfirmation);
    this.activeDeleteConfirmation = undefined;
  }

  private closeSessionOverlay(): void {
    this.closeResumePicker();
    this.closeDeleteConfirmation();
  }

  private resumeSession(sessionId: string): void {
    if (this.running) {
      return;
    }

    let session: KanaTuiLoadedSession;

    try {
      session = this.options.loadSession(sessionId);
    } catch (error) {
      this.showError(error);
      this.closeSessionOverlay();
      this.tui.setFocus(this.editor);
      this.tui.requestRender(true);
      return;
    }

    this.closeSessionOverlay();
    this.sessionId = session.id;
    this.agent.abort();
    this.agent = this.createAgentForCurrentSession();
    this.streamingAssistant = undefined;
    this.toolCallBlocks.clear();
    this.transcript.clear();
    this.editor.clear();
    this.initializeTranscript(session.messages);
    this.updateStatus("idle", {
      activeTool: undefined,
    });
    this.tui.setFocus(this.editor);
    this.tui.requestRender(true);
  }

  private showError(error: unknown): void {
    this.transcript.addChild(
      new TextBlock(error instanceof Error ? error.message : String(error), {
        color: tuiTheme.error,
        paddingTop: 1,
      }),
    );
    this.updateStatus("error");
  }

  private async submitPrompt(value: string): Promise<void> {
    const prompt = value.trim();

    if (!prompt || this.running) {
      return;
    }

    this.editor.addToHistory(prompt);
    this.editor.clear();
    this.transcript.addChild(
      new TextBlock(prompt, { color: tuiTheme.user, prefix: "> " }),
    );
    this.running = true;
    this.streamingAssistant = undefined;
    this.toolCallBlocks.clear();
    this.updateStatus("starting");

    try {
      const stream = this.agent.stream(prompt);

      for await (const event of stream) {
        this.handleAgentEvent(event);
      }

      await stream.result();
    } catch (error) {
      this.showError(error);
    } finally {
      this.running = false;
      this.status.update({
        running: false,
        activeTool: undefined,
      });
      this.tui.requestRender();
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.updateStatus("starting");
        break;
      case "agent_end":
        this.updateStatus(phaseForAgentEndReason(event.reason), {
          activeTool: undefined,
        });
        break;
      case "turn_start":
        this.updateStatus("thinking");
        break;
      case "turn_end":
        break;
      case "message_start":
        this.handleAssistantStart(event.message);
        break;
      case "message_update":
        this.handleAssistantUpdate(event);
        break;
      case "message_end":
        this.handleAssistantEnd(event.message);
        break;
      case "tool_execution_start":
        this.handleToolStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update":
        this.toolCallBlocks.updatePartialResult(
          event.toolCallId,
          event.partialResult,
        );
        this.updateStatus("tool", {
          activeTool: event.toolName,
        });
        break;
      case "tool_execution_end":
        this.toolCallBlocks.updateResult(
          event.toolCallId,
          event.result,
          event.isError,
        );
        this.updateStatus(event.isError ? "error" : "tool", {
          activeTool: undefined,
        });
        break;
    }

    this.tui.requestRender();
  }

  private handleAssistantStart(message: AssistantMessage): void {
    this.streamingAssistant = new AssistantMessageBlock();
    this.streamingAssistant.update(message);
    this.transcript.addChild(this.streamingAssistant);
    this.updateStatus("thinking");
  }

  private handleAssistantUpdate(
    event: Extract<AgentEvent, { type: "message_update" }>,
  ): void {
    if (!this.streamingAssistant) {
      this.handleAssistantStart(event.message);
    }

    this.streamingAssistant?.update(event.message);
    this.streamingAssistant?.showThinking(isThinkingVisible(event.assistantMessageEvent.type));
    this.toolCallBlocks.createOrUpdateFromMessage(event.message);
    this.updateStatus(phaseForAssistantMessage(event.message));
  }

  private handleAssistantEnd(message: AssistantMessage): void {
    this.streamingAssistant?.showThinking(false);
    this.streamingAssistant?.update(message);
    this.streamingAssistant = undefined;
    this.updateStatus(phaseForStopReason(message.stopReason));
  }

  private handleToolStart(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): void {
    this.toolCallBlocks.markStarted(toolCallId, toolName, args);
    this.updateStatus("tool", {
      activeTool: toolName,
    });
  }

  private showToolApprovalPrompt(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
  ): Promise<BeforeToolExecutionResult> {
    return new Promise((resolve) => {
      let approval: ToolApproval | undefined;
      let settled = false;

      const finish = (decision: ToolApprovalSelection): void => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener("abort", handleAbort);

        if (approval) {
          this.transcript.removeChild(approval);
          approval = undefined;
        }

        this.tui.setFocus(this.editor);
        this.tui.requestRender();
        resolve(
          decision === "yes"
            ? { type: "continue" }
            : {
                type: "cancel",
                abortRun: true,
                message: "Tool call rejected by user.",
              },
        );
      };

      const handleAbort = (): void => {
        finish("no");
      };

      if (signal?.aborted) {
        handleAbort();
        return;
      }

      approval = new ToolApproval(toolCall, finish);
      this.transcript.addChild(approval);
      this.tui.setFocus(approval);
      signal?.addEventListener("abort", handleAbort, { once: true });
      this.updateStatus("tool", {
        activeTool: toolCall.name,
      });
      this.tui.requestRender();
    });
  }

  private updateStatus(
    phase: RunPhase,
    extra: Partial<StatusLineState> = {},
  ): void {
    this.status.update({
      phase,
      running: this.running,
      ...extra,
    });
  }
}

function formatModelName(metadata: ModelMetadata): string {
  return `${metadata.provider}/${metadata.model}`;
}
