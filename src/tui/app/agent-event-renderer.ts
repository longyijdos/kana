import type { AgentEvent } from "@/agent";
import type { AssistantMessage } from "@/core";
import {
  AssistantMessageBlock,
  type StatusLineState,
  TextBlock,
  type Transcript,
  UserMessageBlock,
} from "../components";
import type { Tui } from "../runtime";
import { tuiTheme } from "../theme";
import { formatContextCompaction } from "./history";
import {
  isThinkingVisible,
  phaseForAgentEndReason,
  phaseForAssistantMessage,
  phaseForStopReason,
  type RunPhase,
} from "./status-phase";
import { StreamingTextPresenter } from "./streaming-text-presenter";
import { ToolCallBlocks } from "./tool-call-blocks";

export type AgentEventRendererOptions = {
  transcript: Transcript;
  tui: Tui;
  hyperlinks?: boolean;
  smoothTextStreaming?: boolean;
  updateStatus: (phase: RunPhase, extra?: Partial<StatusLineState>) => void;
};

export class AgentEventRenderer {
  private readonly toolCallBlocks: ToolCallBlocks;
  private readonly textPresenter: StreamingTextPresenter;
  private streamingAssistant?: AssistantMessageBlock;
  private activityTimer?: ReturnType<typeof setInterval>;
  private readonly activeTools = new Map<string, string>();
  private toolErrorCount = 0;

  constructor(private readonly options: AgentEventRendererOptions) {
    this.toolCallBlocks = new ToolCallBlocks(options.transcript);
    this.textPresenter = new StreamingTextPresenter({
      onUpdate: (message, complete) => {
        this.streamingAssistant?.update(message, { complete });
      },
      onSettled: () => {
        // Provider abort snapshots can leave hosted tools in progress. Stop
        // child activity timers before releasing the last mutable block reference.
        this.streamingAssistant?.stopActivityTimers();
        this.streamingAssistant = undefined;
      },
      requestRender: () => this.options.tui.requestRender(),
      smoothTextStreaming: options.smoothTextStreaming,
    });
  }

  prepareForToolInteraction(): void {
    this.textPresenter.catchUp();
  }

  resetRun(): void {
    this.textPresenter.flush();
    this.stopActivityTimer();
    this.streamingAssistant?.stopActivityTimers();
    this.streamingAssistant = undefined;
    this.toolCallBlocks.clear();
    this.activeTools.clear();
    this.toolErrorCount = 0;
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.options.updateStatus("starting");
        break;
      case "agent_end":
        if (event.reason === "aborted") {
          this.toolCallBlocks.markPendingCanceled();
        }
        this.stopActiveTimers();
        this.activeTools.clear();
        this.options.updateStatus(phaseForAgentEndReason(event.reason), {
          activeTool: undefined,
        });
        break;
      case "turn_start":
        this.activeTools.clear();
        this.toolErrorCount = 0;
        this.options.updateStatus("thinking");
        break;
      case "turn_end":
        break;
      case "turn_input":
        this.options.transcript.addChild(new UserMessageBlock(event.message));
        break;
      case "context_compaction_start":
        this.options.updateStatus("compacting");
        break;
      case "context_compacted":
        this.options.transcript.addChild(
          new TextBlock(formatContextCompaction(event.beforeTokens, event.estimatedAfterTokens), {
            color: tuiTheme.muted,
          }),
        );
        this.options.updateStatus(event.reason === "manual" ? "done" : "thinking", {
          contextUsedPercent: Math.min(
            100,
            Math.max(0, Math.round((event.estimatedAfterTokens / event.contextLimit) * 100)),
          ),
        });
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
        this.updateToolStatus();
        break;
      case "tool_execution_end":
        this.toolCallBlocks.updateResult(event.toolCallId, event.result, event.isError);
        this.activeTools.delete(event.toolCallId);
        this.toolErrorCount += event.isError ? 1 : 0;
        this.updateToolStatus();
        break;
    }

    this.updateActivityTimer();
    this.options.tui.requestRender();
  }

  private handleAssistantStart(message: AssistantMessage): void {
    this.textPresenter.flush();
    this.streamingAssistant = new AssistantMessageBlock(Date.now, {
      hyperlinks: this.options.hyperlinks,
    });
    this.options.transcript.addChild(this.streamingAssistant);
    this.textPresenter.start(message);
    this.options.updateStatus("thinking");
  }

  private handleAssistantUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
    if (!this.streamingAssistant) {
      this.handleAssistantStart(event.message);
    }

    this.textPresenter.update(event.message, event.assistantMessageEvent.type === "text_delta");
    if (
      event.assistantMessageEvent.type === "toolcall_start" ||
      event.assistantMessageEvent.type === "hosted_tool_start"
    ) {
      this.textPresenter.catchUp();
    }
    this.streamingAssistant?.showThinking(isThinkingVisible(event.assistantMessageEvent.type));
    this.toolCallBlocks.createOrUpdateFromMessage(event.message);
    if (event.assistantMessageEvent.type === "toolcall_end") {
      this.toolCallBlocks.freezePreparation(event.assistantMessageEvent.toolCall.id);
    }
    this.options.updateStatus(phaseForAssistantMessage(event.message));
  }

  private handleAssistantEnd(message: AssistantMessage): void {
    this.streamingAssistant?.showThinking(false);
    this.textPresenter.finish(message, message.stopReason === "toolUse");
    this.options.updateStatus(phaseForStopReason(message.stopReason));
  }

  private updateActivityTimer(): void {
    const hasActiveActivity =
      this.streamingAssistant?.isThinking() === true ||
      this.streamingAssistant?.hasActiveHostedTools() === true ||
      this.toolCallBlocks.hasActiveTimers();

    if (hasActiveActivity && !this.activityTimer) {
      this.activityTimer = setInterval(() => this.options.tui.requestRender(), 1_000);
    } else if (!hasActiveActivity) {
      this.stopActivityTimer();
    }
  }

  private stopActiveTimers(): void {
    this.streamingAssistant?.stopActivityTimers();
    this.toolCallBlocks.stopTimers();
    this.stopActivityTimer();
  }

  private stopActivityTimer(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
  }

  private handleToolStart(toolCallId: string, toolName: string, args: unknown): void {
    this.textPresenter.catchUp();
    this.toolCallBlocks.markStarted(toolCallId, toolName, args);
    this.activeTools.set(toolCallId, toolName);
    this.updateToolStatus();
  }

  private updateToolStatus(): void {
    this.options.updateStatus(this.toolErrorCount > 0 ? "error" : "tool", {
      activeTool: formatActiveTools(this.activeTools),
    });
  }
}

function formatActiveTools(activeTools: ReadonlyMap<string, string>): string | undefined {
  const names = [...activeTools.values()];
  if (names.length === 0) {
    return undefined;
  }
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}
