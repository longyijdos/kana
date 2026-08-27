import type { AgentEndReason } from "@/agent";
import { type AssistantMessage, addModelUsage, type ModelUsage } from "@/core";
import type { ConversationRuntimeEvent, KanaGoalSnapshot } from "@/kana";
import {
  createKanaExecEvent,
  type KanaExecEvent,
  toKanaExecGoal,
  toKanaExecRunTermination,
  toKanaExecUsage,
} from "./protocol";
import type { HeadlessRunTermination } from "./run-lifecycle";

export type HeadlessOutputStream = {
  write(chunk: string): unknown;
};

export type HeadlessWarning = {
  phase: "mcp_startup";
  message: string;
  serverId?: string;
};

export type HeadlessRunResult = {
  exitCode: number;
  outcome?: AgentEndReason;
  termination?: HeadlessRunTermination;
  finalMessage?: string;
  usage?: ModelUsage;
  goal?: KanaGoalSnapshot;
};

type HeadlessRunOutputOptions = {
  goal: boolean;
  json: boolean;
  stdout: HeadlessOutputStream;
  stderr: HeadlessOutputStream;
  getTermination(): HeadlessRunTermination | undefined;
};

export class HeadlessRunOutputProjector {
  private outcome?: AgentEndReason;
  private finalMessage?: string;
  private usage?: ModelUsage;
  private termination?: HeadlessRunTermination;
  private hasWriteFailure = false;
  private writeFailure?: unknown;
  private runFailed = false;
  private runStarted = false;
  private runCompleted = false;
  private goal?: KanaGoalSnapshot;

  constructor(private readonly options: HeadlessRunOutputOptions) {}

  startSession(sessionId: string | undefined): void {
    if (!sessionId) {
      throw new Error("Kana exec could not create an active session.");
    }
    this.emit(
      createKanaExecEvent({
        type: "session.started",
        session_id: sessionId,
      }),
      `Session: ${sessionId}`,
    );
  }

  warning(warning: HeadlessWarning): void {
    this.emit(
      createKanaExecEvent({
        type: "warning",
        phase: warning.phase,
        message: warning.message,
        ...(warning.serverId === undefined ? {} : { server_id: warning.serverId }),
      }),
      `Warning: ${warning.message}`,
    );
  }

  approvalDenied(message: string): void {
    if (!this.options.json) {
      this.write(this.options.stderr, `${sanitizeTerminalText(message)}\n`);
    }
  }

  startRun(): void {
    if (this.runStarted) {
      return;
    }
    this.runStarted = true;
    this.emit(createKanaExecEvent({ type: "run.started" }), "Running...");
  }

  handle(event: ConversationRuntimeEvent): void {
    switch (event.type) {
      case "run_start":
        this.startRun();
        return;
      case "run_end":
        if (!event.event) {
          return;
        }
        this.termination = this.options.getTermination();
        // Frontend cancellation wins a race with the Agent terminal event.
        this.outcome = this.termination === undefined ? event.event.reason : "aborted";
        if (!this.options.goal) {
          this.complete();
        }
        return;
      case "run_error":
        this.fail(event.error);
        return;
      case "agent_event":
        this.handleAgentEvent(event.event);
        return;
      case "session_changed":
      case "input_queue_changed":
      case "todo_state_changed":
        return;
      case "goal_state_changed":
        this.goal = structuredClone(event.goal);
        return;
    }
  }

  completeGoal(goal: KanaGoalSnapshot): void {
    this.goal = structuredClone(goal);
    this.complete();
    if (!this.options.json && goal.status !== "completed" && this.termination === undefined) {
      const detail = goal.detail === undefined ? "" : `: ${goal.detail}`;
      this.write(
        this.options.stderr,
        `Goal stopped (${goal.status})${sanitizeTerminalText(detail)}\n`,
      );
    }
  }

  fail(error: unknown): void {
    if (this.runFailed || this.runCompleted) {
      return;
    }
    this.runFailed = true;
    this.outcome = undefined;
    this.termination = this.options.getTermination();
    const normalized = normalizeError(error);
    this.emit(
      createKanaExecEvent({
        type: "run.failed",
        error: normalized,
        ...(this.termination === undefined
          ? {}
          : { termination: toKanaExecRunTermination(this.termination) }),
        ...(this.goal === undefined || this.goal.status === "active"
          ? {}
          : { goal: toKanaExecGoal(this.goal) }),
      }),
      `Error: ${normalized.message}`,
    );
  }

  throwIfWriteFailed(): void {
    if (this.hasWriteFailure) {
      throw this.writeFailure;
    }
  }

  result(): HeadlessRunResult {
    return {
      exitCode: this.exitCode(),
      outcome: this.outcome,
      termination: this.termination,
      finalMessage: this.finalMessage,
      usage: this.usage,
      ...(this.goal === undefined ? {} : { goal: structuredClone(this.goal) }),
    };
  }

  private handleAgentEvent(
    event: Extract<ConversationRuntimeEvent, { type: "agent_event" }>["event"],
  ): void {
    switch (event.type) {
      case "turn_start":
        this.emit(
          createKanaExecEvent({
            type: "model_turn.started",
            turn: event.turn,
          }),
        );
        return;
      case "turn_end":
        this.recordUsage(event.message.usage);
        this.emit(
          createKanaExecEvent({
            type: "model_turn.completed",
            turn: event.turn,
            ...(event.message.stopReason === undefined
              ? {}
              : { stop_reason: event.message.stopReason }),
            ...(event.message.usage === undefined
              ? {}
              : { usage: toKanaExecUsage(event.message.usage) }),
          }),
        );
        return;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.emit(
            createKanaExecEvent({
              type: "assistant.delta",
              delta: event.assistantMessageEvent.delta,
            }),
          );
        }
        return;
      case "message_end": {
        const text = visibleAssistantText(event.message);
        this.finalMessage = text;
        this.emit(
          createKanaExecEvent({
            type: "assistant.completed",
            text,
            ...(event.message.usage === undefined
              ? {}
              : { usage: toKanaExecUsage(event.message.usage) }),
          }),
        );
        return;
      }
      case "tool_execution_start":
        this.emit(
          createKanaExecEvent({
            type: "tool.started",
            tool_call_id: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
          }),
          `Tool started: ${event.toolName}`,
        );
        return;
      case "tool_execution_update":
        this.emit(
          createKanaExecEvent({
            type: "tool.updated",
            tool_call_id: event.toolCallId,
            name: event.toolName,
            partial_result: event.partialResult,
          }),
        );
        return;
      case "tool_execution_end":
        this.emit(
          createKanaExecEvent({
            type: "tool.completed",
            tool_call_id: event.toolCallId,
            name: event.toolName,
            result: event.result,
            is_error: event.isError,
          }),
          `Tool ${event.isError ? "failed" : "completed"}: ${event.toolName}`,
        );
        return;
      case "context_compaction_start":
        this.emit(
          createKanaExecEvent({
            type: "context.compaction_started",
            reason: event.reason,
            estimated_tokens: event.estimatedTokens,
            context_limit: event.contextLimit,
          }),
          "Compacting context...",
        );
        return;
      case "context_compacted":
        this.recordUsage(event.usage);
        this.emit(
          createKanaExecEvent({
            type: "context.compacted",
            reason: event.reason,
            before_tokens: event.beforeTokens,
            estimated_after_tokens: event.estimatedAfterTokens,
            compacted_message_count: event.compactedMessageCount,
            context_limit: event.contextLimit,
            ...(event.usage === undefined ? {} : { usage: toKanaExecUsage(event.usage) }),
          }),
          "Context compacted.",
        );
        return;
      case "agent_start":
      case "agent_end":
      case "message_start":
      case "turn_input":
        return;
    }
  }

  private recordUsage(usage: ModelUsage | undefined): void {
    if (usage) {
      this.usage = addModelUsage(this.usage, usage);
    }
  }

  private complete(): void {
    if (this.runFailed || this.runCompleted || this.outcome === undefined) {
      return;
    }
    this.runCompleted = true;
    this.termination = this.options.getTermination();
    if (this.termination !== undefined) {
      this.outcome = "aborted";
    }
    this.emit(
      createKanaExecEvent({
        type: "run.completed",
        outcome: this.outcome,
        ...(this.usage === undefined ? {} : { usage: toKanaExecUsage(this.usage) }),
        ...(this.termination === undefined
          ? {}
          : { termination: toKanaExecRunTermination(this.termination) }),
        ...(this.goal === undefined ? {} : { goal: toKanaExecGoal(this.goal) }),
      }),
    );
    if (!this.options.json && this.termination?.reason === "timeout") {
      this.write(
        this.options.stderr,
        `Kana exec timed out after ${this.termination.timeoutMs}ms.\n`,
      );
    }
    if (!this.options.json && this.finalMessage) {
      this.write(this.options.stdout, `${sanitizeTerminalOutput(this.finalMessage)}\n`);
    }
  }

  private exitCode(): number {
    if (this.runFailed) {
      return 1;
    }
    switch (this.termination?.reason) {
      case "timeout":
        return 124;
      case "sigint":
        return 130;
      default:
        return this.options.goal
          ? this.goal?.status === "completed"
            ? 0
            : 1
          : this.outcome === "stop"
            ? 0
            : 1;
    }
  }

  private emit(event: KanaExecEvent, humanMessage?: string): void {
    if (this.options.json) {
      this.write(this.options.stdout, `${stringifyJsonLine(event)}\n`);
      return;
    }
    if (humanMessage) {
      this.write(this.options.stderr, `${sanitizeTerminalText(humanMessage)}\n`);
    }
  }

  private write(stream: HeadlessOutputStream, chunk: string): void {
    try {
      stream.write(chunk);
    } catch (error) {
      if (!this.hasWriteFailure) {
        this.writeFailure = error;
      }
      this.hasWriteFailure = true;
      throw error;
    }
  }
}

export function writeHeadlessStartupError(
  error: unknown,
  json: boolean,
  stdout: HeadlessOutputStream = process.stdout,
  stderr: HeadlessOutputStream = process.stderr,
): void {
  const normalized = normalizeError(error);
  if (json) {
    stdout.write(
      `${stringifyJsonLine(
        createKanaExecEvent({
          type: "error",
          phase: "startup",
          error: normalized,
        }),
      )}\n`,
    );
    return;
  }
  stderr.write(`Error: ${sanitizeTerminalText(normalized.message)}\n`);
}

function visibleAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

function stringifyJsonLine(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function sanitizeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").replace(/\r?\n/g, " ");
}

function sanitizeTerminalOutput(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
