import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@/agent";
import type { AssistantMessage } from "@/core";
import type { ConversationRuntime, ConversationRuntimeEvent } from "@/kana";
import {
  projectAssistant,
  projectError,
  projectMessage,
  projectTimelineEntry,
  type ServerEventType,
} from "./protocol";

type RunState = {
  id: string;
  source: string;
  status: "running" | "completed" | "failed";
  outcome?: string;
  error?: ReturnType<typeof projectError>;
};

type ToolState = {
  tool_call_id: string;
  name: string;
  status: "running" | "completed";
  arguments?: unknown;
  partial_result?: unknown;
  result?: unknown;
  is_error?: boolean;
};

export class ServerProjection {
  private run: RunState | null = null;
  private assistant: AssistantMessage | null = null;
  private readonly tools = new Map<string, ToolState>();

  constructor(
    private readonly runtime: ConversationRuntime,
    private readonly emit: (type: ServerEventType, data: unknown) => void,
  ) {}

  get runId(): string | null {
    return this.run?.id ?? null;
  }

  snapshot() {
    const session = this.runtime.session;
    return {
      session: session
        ? {
            id: session.id,
            messages: session.messages.map(projectMessage),
            timeline: session.timeline.map(projectTimelineEntry),
          }
        : null,
      running: this.runtime.isRunning,
      run: this.run ? { ...this.run } : null,
      assistant: this.assistant ? projectAssistant(this.assistant) : null,
      tools: structuredClone([...this.tools.values()]),
      input_queue: this.runtime.inputQueue,
      todo: this.runtime.todoState,
      goal: this.runtime.goal ?? null,
    };
  }

  handle(event: ConversationRuntimeEvent): void {
    switch (event.type) {
      case "run_start":
        this.run = { id: randomUUID(), source: event.source, status: "running" };
        this.assistant = null;
        this.tools.clear();
        this.emit("run.started", {
          source: event.source,
          input: event.input ? projectMessage(event.input) : null,
        });
        return;
      case "run_end":
        if (this.run) {
          this.run.status = "completed";
          this.run.outcome = event.event?.reason;
        }
        this.emit("run.completed", {
          outcome: event.event?.reason ?? null,
          goal: event.goal ?? null,
        });
        return;
      case "run_error":
        if (this.run) {
          this.run.status = "failed";
          this.run.error = projectError(event.error);
        }
        this.emit("run.failed", { error: projectError(event.error) });
        return;
      case "session_changed":
        this.run = null;
        this.assistant = null;
        this.tools.clear();
        this.emit("session.changed", { action: event.action, session_id: event.session.id });
        return;
      case "input_queue_changed":
        this.emit("input.queue_changed", event.queue);
        return;
      case "todo_state_changed":
        this.emit("todo.changed", event.change);
        return;
      case "goal_state_changed":
        this.emit("goal.changed", { change: event.change, goal: event.goal });
        return;
      case "agent_event":
        this.handleAgent(event.event);
    }
  }

  private handleAgent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
        this.assistant = event.message;
        this.emit("assistant.started", { message: projectAssistant(event.message) });
        return;
      case "message_update": {
        this.assistant = event.message;
        const update = event.assistantMessageEvent;
        if ("delta" in update) {
          this.emit("assistant.delta", {
            message_id: event.message.id,
            kind: update.type,
            content_index: update.contentIndex,
            delta: update.delta,
          });
        } else if ("contentIndex" in update) {
          this.emit("assistant.content", {
            message_id: event.message.id,
            content_index: update.contentIndex,
            content: projectAssistant(event.message).content[update.contentIndex],
          });
        }
        return;
      }
      case "message_end":
        this.assistant = null;
        this.emit("assistant.completed", { message: projectAssistant(event.message) });
        return;
      case "turn_start":
        this.emit("model_turn.started", { turn: event.turn });
        return;
      case "turn_end":
        this.emit("model_turn.completed", { turn: event.turn, usage: event.message.usage ?? null });
        return;
      case "tool_execution_start": {
        if (event.parentToolCallId !== undefined) return;
        const state: ToolState = {
          tool_call_id: event.toolCallId,
          name: event.toolName,
          status: "running",
          arguments: event.args,
        };
        this.tools.set(event.toolCallId, state);
        this.emit("tool.started", state);
        return;
      }
      case "tool_execution_update": {
        if (event.parentToolCallId !== undefined) return;
        const state = this.tools.get(event.toolCallId);
        if (state) state.partial_result = event.partialResult;
        this.emit("tool.updated", {
          tool_call_id: event.toolCallId,
          name: event.toolName,
          partial_result: event.partialResult,
        });
        return;
      }
      case "tool_execution_end": {
        if (event.parentToolCallId !== undefined) return;
        const state: ToolState = {
          tool_call_id: event.toolCallId,
          name: event.toolName,
          status: "completed",
          result: event.result,
          is_error: event.isError,
        };
        this.tools.set(event.toolCallId, state);
        this.emit("tool.completed", state);
        return;
      }
      case "tool_execution_pause":
      case "tool_execution_resume":
        this.emit(event.type === "tool_execution_pause" ? "tool.paused" : "tool.resumed", {
          tool_call_id: event.toolCallId,
          name: event.toolName,
          reason: event.reason,
        });
        return;
      case "context_compaction_start":
        this.emit("context.compaction_started", {
          reason: event.reason,
          estimated_tokens: event.estimatedTokens,
          context_limit: event.contextLimit,
        });
        return;
      case "context_compacted":
        this.emit("context.compacted", {
          reason: event.reason,
          before_tokens: event.beforeTokens,
          estimated_after_tokens: event.estimatedAfterTokens,
          compacted_message_count: event.compactedMessageCount,
          context_limit: event.contextLimit,
          usage: event.usage ?? null,
        });
        return;
      case "turn_input":
        this.emit("input.committed", { message: projectMessage(event.message) });
        return;
      case "agent_start":
      case "agent_end":
        return;
    }
  }
}
