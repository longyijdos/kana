import type { Message, ToolCallContent, ToolResultMessage } from "@/core";
import { normalizeToolResult, type Tool, type ToolResult, validateToolArguments } from "@/tools";
import type { AgentEvent } from "./events";

export type BeforeToolExecutionResult =
  | {
      type: "continue";
    }
  | {
      type: "cancel";
      abortRun?: boolean;
      message?: string;
    };

export type BeforeToolExecutionHook = (request: {
  toolCall: ToolCallContent;
  tool: Tool;
  args: unknown;
  signal?: AbortSignal;
}) => Promise<BeforeToolExecutionResult> | BeforeToolExecutionResult;

export type ToolRuntimeConfig = {
  tools?: readonly Tool[];
  signal?: AbortSignal;
  beforeToolExecution?: BeforeToolExecutionHook;
  onMessageCommitted?: (message: Message) => Promise<void> | void;
  limitToolContent?: (content: string) => string;
};

export type ToolRuntimeResult = {
  toolResults: ToolResultMessage[];
  abortRun: boolean;
};

type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

type ExecutedToolCall = {
  toolCall: ToolCallContent;
  result: ToolResult;
  isError: boolean;
  abortRun?: boolean;
};

export class ToolRuntime {
  private readonly events: SerialEventQueue;

  constructor(
    private readonly config: ToolRuntimeConfig,
    emit: AgentEventSink,
  ) {
    this.events = new SerialEventQueue(emit);
  }

  async execute(toolCalls: ToolCallContent[]): Promise<ToolRuntimeResult> {
    const toolResults: ToolResultMessage[] = [];
    let abortRun = false;

    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];

      if (this.config.signal?.aborted) {
        await this.appendCanceledResults(
          toolResults,
          toolCalls.slice(index),
          "Tool call canceled because the run was aborted.",
        );
        abortRun = true;
        break;
      }

      const executed = await this.executeToolCall(toolCall);
      toolResults.push(await this.commitResult(executed));

      if (executed.abortRun) {
        await this.appendCanceledResults(
          toolResults,
          toolCalls.slice(index + 1),
          "Tool call canceled because the run was aborted.",
        );
        abortRun = true;
        break;
      }
    }

    return {
      toolResults,
      abortRun,
    };
  }

  private async appendCanceledResults(
    toolResults: ToolResultMessage[],
    toolCalls: ToolCallContent[],
    message: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      toolResults.push(
        await this.commitResult({
          toolCall,
          result: createCanceledToolResult(message),
          isError: true,
        }),
      );
    }
  }

  private async executeToolCall(toolCall: ToolCallContent): Promise<ExecutedToolCall> {
    const tool = this.config.tools?.find((candidate) => candidate.name === toolCall.name);

    if (!tool) {
      return {
        toolCall,
        result: createErrorToolResult(`Tool "${toolCall.name}" not found`),
        isError: true,
      };
    }

    let acceptsUpdates = false;
    try {
      const args = validateToolArguments(tool, toolCall.args);
      const beforeResult = await this.runBeforeToolExecution(toolCall, tool, args);

      if (beforeResult.type === "cancel") {
        return {
          toolCall,
          result: createCanceledToolResult(beforeResult.message),
          isError: true,
          abortRun: beforeResult.abortRun ?? true,
        };
      }

      if (this.config.signal?.aborted) {
        return {
          toolCall,
          result: createErrorToolResult("Aborted before tool execution"),
          isError: true,
          abortRun: true,
        };
      }

      await this.events.emit({
        type: "tool_execution_start",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args,
      });

      acceptsUpdates = true;
      const executed = await tool.execute(args, {
        toolCallId: toolCall.id,
        signal: this.config.signal,
        update: (partialResult) => {
          if (!acceptsUpdates) {
            return;
          }
          this.events.push({
            type: "tool_execution_update",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args,
            partialResult,
          });
        },
      });
      acceptsUpdates = false;
      await this.events.drain();

      const result = normalizeToolResult(executed);
      return {
        toolCall,
        result,
        isError: result.isError ?? false,
      };
    } catch (error) {
      acceptsUpdates = false;
      try {
        await this.events.drain();
      } catch (updateError) {
        return {
          toolCall,
          result: createErrorToolResult(formatError(updateError)),
          isError: true,
        };
      }
      return {
        toolCall,
        result: createErrorToolResult(formatError(error)),
        isError: true,
      };
    }
  }

  private async runBeforeToolExecution(
    toolCall: ToolCallContent,
    tool: Tool,
    args: unknown,
  ): Promise<BeforeToolExecutionResult> {
    if (!this.config.beforeToolExecution) {
      return {
        type: "continue",
      };
    }

    return this.config.beforeToolExecution({
      toolCall,
      tool,
      args,
      signal: this.config.signal,
    });
  }

  private async commitResult(executed: ExecutedToolCall): Promise<ToolResultMessage> {
    const message: ToolResultMessage = {
      role: "tool",
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
      content: this.config.limitToolContent?.(executed.result.content) ?? executed.result.content,
      result: executed.result.result,
      isError: executed.isError,
    };

    // A successful end event must never become visible before the result can
    // be recovered from the journal.
    await this.config.onMessageCommitted?.(structuredClone(message));
    await this.events.emit({
      type: "tool_execution_end",
      toolCallId: executed.toolCall.id,
      toolName: executed.toolCall.name,
      result: executed.result.result,
      isError: executed.isError,
    });
    return message;
  }
}

class SerialEventQueue {
  private tail: Promise<void> = Promise.resolve();
  private firstError: unknown;

  constructor(private readonly emitEvent: AgentEventSink) {}

  push(event: AgentEvent): void {
    this.tail = this.tail.then(async () => {
      try {
        await this.emitEvent(event);
      } catch (error) {
        this.firstError ??= error;
      }
    });
  }

  async emit(event: AgentEvent): Promise<void> {
    this.push(event);
    await this.drain();
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.firstError === undefined) {
      return;
    }

    const error = this.firstError;
    this.firstError = undefined;
    throw error;
  }
}

function createErrorToolResult(message: string): ToolResult {
  return {
    content: `Tool call failed: ${message}`,
    result: {
      error: message,
    },
    isError: true,
  };
}

function createCanceledToolResult(message = "Tool call canceled before execution."): ToolResult {
  return {
    content: message,
    result: {
      error: message,
      canceled: true,
    },
    isError: true,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
