import {
  type AssistantMessage,
  type AssistantMessageEvent,
  ContextWindowExceededError,
  type Message,
  type Model,
  type ModelContext,
  type ToolCallContent,
} from "@/core";
import type { Logger, LogMetadata } from "@/logging";
import type { Tool } from "@/tools";
import type { ContextCheckpoint, ContextManager, PreparedContext } from "./context-manager";
import type { AgentEndReason, AgentEvent } from "./events";
import { type BeforeToolExecutionHook, ToolRuntime } from "./tool-runtime";

export type { BeforeToolExecutionHook, BeforeToolExecutionResult } from "./tool-runtime";

export type AgentContext = {
  system?: string;
  messages: Message[];
  tools?: Tool[];
};

export type AgentLoopConfig = {
  model: Model;
  maxTurns?: number;
  toolDeadlineMs?: number;
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  beforeToolExecution?: BeforeToolExecutionHook;
  contextManager?: ContextManager;
  logger?: Logger;
  loggerMetadata?: LogMetadata;
  onMessageCommitted?: (message: Message) => Promise<void> | void;
  onCompactionCommitted?: (compaction: ContextCheckpoint) => Promise<void> | void;
};

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

type AssistantTurnResult = {
  message: AssistantMessage;
  isError: boolean;
  error?: unknown;
  canRetryContextLimit?: boolean;
};

type MessageContext = {
  messages: Message[];
};

export async function runAgentLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<Message[]> {
  assertValidMaxTurns(config.maxTurns);
  // Resolve once per run so provider advertisement and runtime scheduling
  // cannot diverge, and unsupported models always fail closed to serial use.
  const parallelToolCalls =
    (config.parallelToolCalls ?? true) && config.model.metadata.supportsParallelToolCalls;

  const currentContext: AgentContext = {
    system: context.system,
    messages: [...context.messages],
    tools: context.tools ? [...context.tools] : undefined,
  };
  const toolRuntime = new ToolRuntime(
    {
      tools: currentContext.tools,
      parallelToolCalls,
      signal: config.signal,
      beforeToolExecution: config.beforeToolExecution,
      defaultDeadlineMs: config.toolDeadlineMs,
      logger: config.logger,
      loggerMetadata: config.loggerMetadata,
      onMessageCommitted: config.onMessageCommitted,
      limitToolContent: (content) => config.contextManager?.limitToolContent(content) ?? content,
    },
    emit,
  );
  const newMessages: Message[] = [];
  const maxTurns = config.maxTurns ?? 8;
  const hasTurnLimit = maxTurns !== -1;
  let endReason: AgentEndReason = hasTurnLimit ? "turn_limit" : "stop";

  await emit({ type: "agent_start" });

  for (let turn = 1; !hasTurnLimit || turn <= maxTurns; turn += 1) {
    if (config.signal?.aborted) {
      endReason = "aborted";
      break;
    }

    await emit({ type: "turn_start", turn });

    const sourceMessageCount = currentContext.messages.length;
    let prepared: PreparedContext;
    try {
      prepared = await prepareModelContext(currentContext, config, emit);
    } catch (error) {
      if (config.signal?.aborted) {
        endReason = "aborted";
        break;
      }
      throw error;
    }
    let assistantTurn = await streamAssistantResponse(
      prepared.context,
      config,
      parallelToolCalls,
      emit,
    );
    if (
      assistantTurn.error instanceof ContextWindowExceededError &&
      assistantTurn.canRetryContextLimit &&
      config.contextManager
    ) {
      try {
        prepared = await prepareModelContext(currentContext, config, emit, true);
      } catch (error) {
        if (config.signal?.aborted) {
          endReason = "aborted";
          break;
        }
        throw error;
      }
      assistantTurn = await streamAssistantResponse(
        prepared.context,
        config,
        parallelToolCalls,
        emit,
      );
    }
    if (
      assistantTurn.error instanceof ContextWindowExceededError &&
      assistantTurn.canRetryContextLimit
    ) {
      throw assistantTurn.error;
    }
    config.contextManager?.recordUsage(assistantTurn.message.usage, sourceMessageCount);
    const assistantHistoryMessage = assistantMessageForHistory(assistantTurn.message);

    if (assistantHistoryMessage) {
      // Persist a complete assistant tool-call message before any referenced
      // tool can produce an external side effect.
      await config.onMessageCommitted?.(structuredClone(assistantHistoryMessage));
      currentContext.messages.push(assistantHistoryMessage);
      newMessages.push(assistantHistoryMessage);
    }

    if (assistantTurn.isError || config.signal?.aborted) {
      endReason = config.signal?.aborted ? "aborted" : endReasonForAssistantTurn(assistantTurn);
      await emit({
        type: "turn_end",
        turn,
        message: assistantHistoryMessage ?? assistantTurn.message,
        toolResults: [],
      });
      break;
    }

    const toolCalls =
      assistantTurn.message.stopReason === "toolUse" ? getToolCalls(assistantTurn.message) : [];
    const executedToolCalls = await toolRuntime.execute(toolCalls);

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
      endReason = executedToolCalls.abortRun ? "aborted" : endReasonForAssistantTurn(assistantTurn);
      break;
    }
  }

  await emit({ type: "agent_end", reason: endReason, messages: newMessages });

  return newMessages;
}

export function assertValidMaxTurns(maxTurns: number | undefined): void {
  if (maxTurns !== undefined && maxTurns !== -1 && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
    throw new Error("maxTurns must be -1 or a positive integer.");
  }
}

async function streamAssistantResponse(
  context: ModelContext,
  config: AgentLoopConfig,
  parallelToolCalls: boolean,
  emit: AgentEventSink,
): Promise<AssistantTurnResult> {
  const response = config.model.stream({
    system: context.system,
    messages: context.messages,
    tools: context.tools,
    parallelToolCalls,
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
        await emitMessageStart(currentMessage, emit);
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
        await emitMessageUpdate(currentMessage, event, emit);
        break;

      case "done":
        currentMessage = {
          ...event.message,
          stopReason: event.reason,
        };
        replaceOrAppendAssistantMessage(context, currentMessage, addedAssistantMessage);
        await emitMessageEnd(currentMessage, emit);
        return {
          message: currentMessage,
          isError: false,
        };

      case "error":
        if (event.error instanceof ContextWindowExceededError && !addedAssistantMessage) {
          return {
            message: currentMessage,
            isError: true,
            error: event.error,
            canRetryContextLimit: true,
          };
        }
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
          await emitMessageStart(currentMessage, emit);
        }
        await emitMessageEnd(currentMessage, emit);
        return {
          message: currentMessage,
          isError: true,
          error: event.error,
        };
    }
  }

  try {
    currentMessage = await response.result();
  } catch {
    return {
      message: currentMessage,
      isError: true,
      error: undefined,
    };
  }

  replaceOrAppendAssistantMessage(context, currentMessage, addedAssistantMessage);
  await emitMessageEnd(currentMessage, emit);

  return {
    message: currentMessage,
    isError: false,
  };
}

async function prepareModelContext(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  forceCompaction = false,
): Promise<PreparedContext> {
  if (!config.contextManager) {
    return {
      context: {
        system: context.system,
        messages: structuredClone(context.messages),
        tools: context.tools ? [...context.tools] : undefined,
        signal: config.signal,
      },
      estimatedTokens: 0,
    };
  }

  const prepared = await config.contextManager.prepareForModel(
    {
      system: context.system,
      messages: context.messages,
      tools: context.tools,
      signal: config.signal,
    },
    {
      signal: config.signal,
      forceCompaction,
      onCompactionStart: (event) =>
        emit({
          type: "context_compaction_start",
          ...event,
        }),
    },
  );

  if (prepared.compaction) {
    await config.onCompactionCommitted?.(structuredClone(prepared.compaction));
    await emit({
      type: "context_compacted",
      reason: prepared.compaction.reason,
      beforeTokens: prepared.compaction.beforeTokens,
      estimatedAfterTokens: prepared.compaction.estimatedAfterTokens,
      compactedMessageCount: prepared.compaction.compactedMessageCount,
      contextLimit: config.contextManager.contextLimit,
      usage: prepared.compaction.usage,
    });
  }

  return prepared;
}

async function emitMessageStart(message: AssistantMessage, emit: AgentEventSink): Promise<void> {
  await emit({
    type: "message_start",
    message: structuredClone(message),
  });
}

async function emitMessageUpdate(
  message: AssistantMessage,
  assistantMessageEvent: AssistantMessageEvent,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "message_update",
    message: structuredClone(message),
    assistantMessageEvent,
  });
}

async function emitMessageEnd(message: AssistantMessage, emit: AgentEventSink): Promise<void> {
  await emit({
    type: "message_end",
    message: structuredClone(message),
  });
}

function getToolCalls(message: AssistantMessage): ToolCallContent[] {
  return message.content.filter((content) => content.type === "tool_call");
}

function assistantMessageForHistory(message: AssistantMessage): AssistantMessage | undefined {
  if (message.stopReason === "error" && message.content.length === 0) {
    return undefined;
  }

  if (message.stopReason !== "aborted") {
    return message;
  }

  const content = message.content.filter((item) => item.type !== "tool_call");

  if (content.length === message.content.length) {
    return message;
  }

  if (content.length === 0) {
    return undefined;
  }

  return {
    ...message,
    content,
  };
}

function endReasonForAssistantTurn(turn: AssistantTurnResult): AgentEndReason {
  switch (turn.message.stopReason) {
    case "length":
      return "length";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "stop":
    case "toolUse":
    case undefined:
      return turn.isError ? "error" : "stop";
  }
}

function replaceLastAssistantMessage(context: MessageContext, message: AssistantMessage): void {
  if (context.messages[context.messages.length - 1]?.role === "assistant") {
    context.messages[context.messages.length - 1] = message;
    return;
  }

  context.messages.push(message);
}

function replaceOrAppendAssistantMessage(
  context: MessageContext,
  message: AssistantMessage,
  replaceExisting: boolean,
): void {
  if (replaceExisting) {
    replaceLastAssistantMessage(context, message);
    return;
  }

  context.messages.push(message);
}
