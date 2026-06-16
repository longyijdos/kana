import type { AgentEvent } from "@/agent";
import type { AssistantMessage } from "@/core";
import { AssistantMessageBlock, type Transcript, type StatusLineState } from "../components";
import type { Tui } from "../runtime";
import {
  isThinkingVisible,
  phaseForAgentEndReason,
  phaseForAssistantMessage,
  phaseForStopReason,
  type RunPhase,
} from "./status-phase";
import { ToolCallBlocks } from "./tool-call-blocks";

export type AgentEventRendererOptions = {
  transcript: Transcript;
  tui: Tui;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
};

export class AgentEventRenderer {
  private readonly toolCallBlocks: ToolCallBlocks;
  private streamingAssistant?: AssistantMessageBlock;

  constructor(private readonly options: AgentEventRendererOptions) {
    this.toolCallBlocks = new ToolCallBlocks(options.transcript);
  }

  resetRun(): void {
    this.streamingAssistant = undefined;
    this.toolCallBlocks.clear();
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.options.updateStatus("starting");
        break;
      case "agent_end":
        this.options.updateStatus(phaseForAgentEndReason(event.reason), {
          activeTool: undefined,
        });
        break;
      case "turn_start":
        this.options.updateStatus("thinking");
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
        this.toolCallBlocks.updatePartialResult(event.toolCallId, event.partialResult);
        this.options.updateStatus("tool", {
          activeTool: event.toolName,
        });
        break;
      case "tool_execution_end":
        this.toolCallBlocks.updateResult(event.toolCallId, event.result, event.isError);
        this.options.updateStatus(event.isError ? "error" : "tool", {
          activeTool: undefined,
        });
        break;
    }

    this.options.tui.requestRender();
  }

  private handleAssistantStart(message: AssistantMessage): void {
    this.streamingAssistant = new AssistantMessageBlock();
    this.streamingAssistant.update(message);
    this.options.transcript.addChild(this.streamingAssistant);
    this.options.updateStatus("thinking");
  }

  private handleAssistantUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
    if (!this.streamingAssistant) {
      this.handleAssistantStart(event.message);
    }

    this.streamingAssistant?.update(event.message);
    this.streamingAssistant?.showThinking(isThinkingVisible(event.assistantMessageEvent.type));
    this.toolCallBlocks.createOrUpdateFromMessage(event.message);
    this.options.updateStatus(phaseForAssistantMessage(event.message));
  }

  private handleAssistantEnd(message: AssistantMessage): void {
    this.streamingAssistant?.showThinking(false);
    this.streamingAssistant?.update(message);
    this.streamingAssistant = undefined;
    this.options.updateStatus(phaseForStopReason(message.stopReason));
  }

  private handleToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.toolCallBlocks.markStarted(toolCallId, toolName, args);
    this.options.updateStatus("tool", {
      activeTool: toolName,
    });
  }
}
