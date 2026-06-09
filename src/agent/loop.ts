import type { Model } from "../core/model";
import type {
  AssistantMessage,
  Message,
  ToolCallContent,
  ToolResultMessage,
} from "../core/messages";
import type { Tool, ToolResult } from "../tools/tool";
import { validateToolArguments } from "../tools/validation";
import type { AgentEvent } from "./events";

export type AgentContext = {
  system?: string;
  messages: Message[];
  tools?: Tool[];
};

export type AgentLoopConfig = {
  model: Model;
  maxTurns?: number;
  signal?: AbortSignal;
  beforeToolExecution?: BeforeToolExecutionHook;
};

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

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

type AssistantTurnResult = {
  message: AssistantMessage;
  isError: boolean;
};

type ExecutedToolCall = {
  toolCall: ToolCallContent;
  result: ToolResult;
  isError: boolean;
  abortRun?: boolean;
};

type ExecutedToolCalls = {
  toolResults: ToolResultMessage[];
  abortRun: boolean;
};

export async function runAgentLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<Message[]> {
  const currentContext: AgentContext = {
    system: context.system,
    messages: [...context.messages],
    tools: context.tools ? [...context.tools] : undefined,
  };
  const newMessages: Message[] = [];
  const maxTurns = config.maxTurns ?? 8;
  const hasTurnLimit = maxTurns !== -1;

  await emit({ type: "agent_start" });

  for (let turn = 1; !hasTurnLimit || turn <= maxTurns; turn += 1) {
    if (config.signal?.aborted) {
      break;
    }

    await emit({ type: "turn_start", turn });

    const assistantTurn = await streamAssistantResponse(
      currentContext,
      config,
      emit,
    );
    newMessages.push(assistantTurn.message);

    if (assistantTurn.isError || config.signal?.aborted) {
      await emit({
        type: "turn_end",
        turn,
        message: assistantTurn.message,
        toolResults: [],
      });
      break;
    }

    const toolCalls =
      assistantTurn.message.stopReason === "toolUse"
        ? getToolCalls(assistantTurn.message)
        : [];
    const executedToolCalls = await executeToolCalls(
      currentContext,
      toolCalls,
      config,
      emit,
    );

    for (const toolResult of executedToolCalls.toolResults) {
      currentContext.messages.push(toolResult);
      newMessages.push(toolResult);
    }

    await emit({
      type: "turn_end",
      turn,
      message: assistantTurn.message,
      toolResults: executedToolCalls.toolResults,
    });

    if (toolCalls.length === 0 || executedToolCalls.abortRun) {
      break;
    }
  }

  await emit({ type: "agent_end", messages: newMessages });

  return newMessages;
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<AssistantTurnResult> {
  const response = config.model.stream({
    system: context.system,
    messages: context.messages,
    tools: context.tools,
    signal: config.signal,
  });
  let addedAssistantMessage = false;
  let currentMessage: AssistantMessage = {
    role: "assistant",
    content: [],
  };

  for await (const event of response) {
    switch (event.type) {
      case "start":
        currentMessage = event.snapshot;
        context.messages.push(currentMessage);
        addedAssistantMessage = true;
        await emit({
          type: "message_start",
          message: structuredClone(currentMessage),
        });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        currentMessage = event.snapshot;
        replaceLastAssistantMessage(context, currentMessage);
        await emit({
          type: "message_update",
          message: structuredClone(currentMessage),
          assistantMessageEvent: event,
        });
        break;

      case "done":
        currentMessage = {
          ...event.message,
          stopReason: event.reason,
        };
        replaceOrAppendAssistantMessage(context, currentMessage, addedAssistantMessage);
        await emit({
          type: "message_end",
          message: structuredClone(currentMessage),
        });
        return {
          message: currentMessage,
          isError: false,
        };

      case "error":
        currentMessage = {
          ...(event.snapshot ??
            ({
              role: "assistant",
              content: [],
            } satisfies AssistantMessage)),
          stopReason: event.reason,
        };
        replaceOrAppendAssistantMessage(context, currentMessage, addedAssistantMessage);
        if (!addedAssistantMessage) {
          await emit({
            type: "message_start",
            message: structuredClone(currentMessage),
          });
        }
        await emit({
          type: "message_end",
          message: structuredClone(currentMessage),
        });
        return {
          message: currentMessage,
          isError: true,
        };
    }
  }

  try {
    currentMessage = await response.result();
  } catch {
    return {
      message: currentMessage,
      isError: true,
    };
  }

  replaceOrAppendAssistantMessage(context, currentMessage, addedAssistantMessage);
  await emit({
    type: "message_end",
    message: structuredClone(currentMessage),
  });

  return {
    message: currentMessage,
    isError: false,
  };
}

async function executeToolCalls(
  context: AgentContext,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<ExecutedToolCalls> {
  const toolResults: ToolResultMessage[] = [];
  let abortRun = false;

  for (const toolCall of toolCalls) {
    if (config.signal?.aborted) {
      break;
    }

    const executed = await executeToolCall(context, toolCall, config, emit);
    const toolResultMessage = createToolResultMessage(executed);

    toolResults.push(toolResultMessage);

    if (executed.abortRun) {
      abortRun = true;
      break;
    }
  }

  return {
    toolResults,
    abortRun,
  };
}

async function executeToolCall(
  context: AgentContext,
  toolCall: ToolCallContent,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<ExecutedToolCall> {
  const tool = context.tools?.find((candidate) => candidate.name === toolCall.name);

  if (!tool) {
    const result = createErrorToolResult(`Tool "${toolCall.name}" not found`);

    await emitToolExecutionEnd(toolCall, result, true, emit);

    return {
      toolCall,
      result,
      isError: true,
    };
  }

  try {
    const args = validateToolArguments(tool, toolCall.args);
    const beforeResult = await runBeforeToolExecution(toolCall, tool, args, config);

    if (beforeResult.type === "cancel") {
      const result = createCanceledToolResult(beforeResult.message);

      await emitToolExecutionEnd(toolCall, result, true, emit);

      return {
        toolCall,
        result,
        isError: true,
        abortRun: beforeResult.abortRun ?? true,
      };
    }

    if (config.signal?.aborted) {
      const result = createErrorToolResult("Aborted before tool execution");

      await emitToolExecutionEnd(toolCall, result, true, emit);

      return {
        toolCall,
        result,
        isError: true,
        abortRun: true,
      };
    }

    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args,
    });

    const updateEvents: Array<Promise<void>> = [];
    const executed = await tool.execute(args, {
      toolCallId: toolCall.id,
      signal: config.signal,
      update: (partialResult) => {
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args,
              partialResult,
            }),
          ),
        );
      },
    });
    await Promise.all(updateEvents);

    const result = normalizeToolResult(executed);

    await emitToolExecutionEnd(toolCall, result, result.isError ?? false, emit);

    return {
      toolCall,
      result,
      isError: result.isError ?? false,
    };
  } catch (error) {
    const result = createErrorToolResult(formatError(error));

    await emitToolExecutionEnd(toolCall, result, true, emit);

    return {
      toolCall,
      result,
      isError: true,
    };
  }
}

function getToolCalls(message: AssistantMessage): ToolCallContent[] {
  return message.content.filter((content) => content.type === "tool_call");
}

function replaceLastAssistantMessage(
  context: AgentContext,
  message: AssistantMessage,
): void {
  if (context.messages[context.messages.length - 1]?.role === "assistant") {
    context.messages[context.messages.length - 1] = message;
    return;
  }

  context.messages.push(message);
}

function replaceOrAppendAssistantMessage(
  context: AgentContext,
  message: AssistantMessage,
  replaceExisting: boolean,
): void {
  if (replaceExisting) {
    replaceLastAssistantMessage(context, message);
    return;
  }

  context.messages.push(message);
}

function normalizeToolResult(value: unknown): ToolResult {
  if (isToolResult(value)) {
    return value;
  }

  return {
    content: stringifyToolContent(value),
    result: value,
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string" &&
    "result" in value
  );
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

async function runBeforeToolExecution(
  toolCall: ToolCallContent,
  tool: Tool,
  args: unknown,
  config: AgentLoopConfig,
): Promise<BeforeToolExecutionResult> {
  if (!config.beforeToolExecution) {
    return {
      type: "continue",
    };
  }

  return config.beforeToolExecution({
    toolCall,
    tool,
    args,
    signal: config.signal,
  });
}

function createToolResultMessage(executed: ExecutedToolCall): ToolResultMessage {
  return {
    role: "tool",
    toolCallId: executed.toolCall.id,
    toolName: executed.toolCall.name,
    content: executed.result.content,
    result: executed.result.result,
    isError: executed.isError,
  };
}

async function emitToolExecutionEnd(
  toolCall: ToolCallContent,
  result: ToolResult,
  isError: boolean,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: result.result,
    isError,
  });
}

function stringifyToolContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
