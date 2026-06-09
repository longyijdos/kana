import type { Agent, AgentEvent } from "../../agent";
import type { ModelMetadata } from "../../core/model";
import type { AssistantMessage, ToolCallContent } from "../../core/messages";
import {
  AssistantMessageBlock,
  StatusLine,
  type StatusLineState,
  TextBlock,
  ToolCallBlock,
  Transcript,
} from "../components";
import { Editor } from "../editor/editor";
import {
  isCtrlC,
  isEscape,
} from "../runtime/keys";
import type { ProcessTerminal } from "../runtime/terminal";
import { Tui } from "../runtime/tui";

type RunPhase =
  | "idle"
  | "starting"
  | "thinking"
  | "responding"
  | "tool"
  | "done"
  | "aborted"
  | "error"
  | "length";

export class KanaTuiApp {
  private readonly tui: Tui;
  private readonly transcript = new Transcript();
  private readonly status: StatusLine;
  private readonly editor = new Editor();
  private readonly pendingTools = new Map<string, ToolCallBlock>();
  private running = false;
  private streamingAssistant?: AssistantMessageBlock;

  constructor(
    private readonly agent: Agent,
    terminal: ProcessTerminal,
  ) {
    this.tui = new Tui(terminal);
    this.status = new StatusLine(formatModelName(agent.state.model.metadata));
  }

  start(): void {
    this.transcript.addChild(
      new TextBlock("Kana TUI. Type a prompt and press Enter.", {
        color: "gray",
      }),
    );
    this.transcript.addChild(
      new TextBlock(
        "Use terminal scrollback for history, /clear to reset, or /quit to exit.",
        {
          color: "gray",
        },
      ),
    );

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
  }

  stop(): void {
    this.tui.stop();
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
    name: "quit" | "clear";
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
    }
  }

  private async submitPrompt(value: string): Promise<void> {
    const prompt = value.trim();

    if (!prompt || this.running) {
      return;
    }

    this.editor.addToHistory(prompt);
    this.editor.clear();
    this.transcript.addChild(new TextBlock(prompt, { color: "cyan", prefix: "> " }));
    this.running = true;
    this.streamingAssistant = undefined;
    this.pendingTools.clear();
    this.updateStatus("starting");

    try {
      const stream = this.agent.stream(prompt);

      for await (const event of stream) {
        this.handleAgentEvent(event);
      }

      await stream.result();
    } catch (error) {
      this.transcript.addChild(
        new TextBlock(error instanceof Error ? error.message : String(error), {
          color: "red",
          paddingTop: 1,
        }),
      );
      this.updateStatus("error");
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
        this.updateStatus("done", {
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
        this.handleAssistantUpdate(event.message);
        break;
      case "message_end":
        this.handleAssistantEnd(event.message);
        break;
      case "tool_execution_start":
        this.handleToolStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update":
        this.pendingTools.get(event.toolCallId)?.updatePartialResult(event.partialResult);
        this.updateStatus("tool", {
          activeTool: event.toolName,
        });
        break;
      case "tool_execution_end":
        this.pendingTools.get(event.toolCallId)?.updateResult(event.result, event.isError);
        this.pendingTools.delete(event.toolCallId);
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

  private handleAssistantUpdate(message: AssistantMessage): void {
    if (!this.streamingAssistant) {
      this.handleAssistantStart(message);
    }

    this.streamingAssistant?.update(message);
    this.createOrUpdateToolCalls(message);
    this.updateStatus(phaseForAssistantMessage(message));
  }

  private handleAssistantEnd(message: AssistantMessage): void {
    this.streamingAssistant?.update(message);
    this.streamingAssistant = undefined;
    this.updateStatus(phaseForStopReason(message.stopReason));
  }

  private createOrUpdateToolCalls(message: AssistantMessage): void {
    for (const content of message.content) {
      if (content.type !== "tool_call") {
        continue;
      }

      let block = this.pendingTools.get(content.id);

      if (!block) {
        block = new ToolCallBlock(content);
        this.pendingTools.set(content.id, block);
        this.transcript.addChild(block);
      } else {
        block.updateArgs(content.args);
      }
    }
  }

  private handleToolStart(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): void {
    let block = this.pendingTools.get(toolCallId);

    if (!block) {
      const toolCall: ToolCallContent = {
        type: "tool_call",
        id: toolCallId,
        name: toolName,
        args,
      };
      block = new ToolCallBlock(toolCall);
      this.pendingTools.set(toolCallId, block);
      this.transcript.addChild(block);
    }

    block.markExecutionStarted();
    this.updateStatus("tool", {
      activeTool: toolName,
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

function phaseForAssistantMessage(message: AssistantMessage): RunPhase {
  if (message.content.some((content) => content.type === "tool_call")) {
    return "tool";
  }

  if (message.content.some((content) => content.type === "text" && content.text)) {
    return "responding";
  }

  return "thinking";
}

function phaseForStopReason(reason: AssistantMessage["stopReason"]): RunPhase {
  switch (reason) {
    case "length":
      return "length";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "toolUse":
      return "tool";
    case "stop":
    case undefined:
      return "done";
  }
}
