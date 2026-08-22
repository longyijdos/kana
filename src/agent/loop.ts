import {
  type AssistantContent,
  type AssistantMessage,
  type AssistantMessageEvent,
  ContextWindowExceededError,
  createMessageIdentity,
  type Message,
  type Model,
  type ModelContext,
  type ToolCallContent,
  type UserMessage,
} from "@/core";
import type { Logger, LogMetadata } from "@/logging";
import type { Tool } from "@/tools";
import type { ContextCheckpoint, ContextManager, PreparedContext } from "./context-manager";
import type { AgentEndReason, AgentEvent } from "./events";
import {
  type AssembledPrompt,
  createRuntimeContextMessage,
  createRuntimeContextRemovalMessage,
  type PromptContextSnapshot,
  projectRuntimeContextMessages,
} from "./prompt-assembly";
import type { ToolResultPolicy } from "./tool-result-policy";
import {
  type BeforeToolExecutionHook,
  resolveMaxParallelToolCalls,
  ToolRuntime,
} from "./tool-runtime";

export type { BeforeToolExecutionHook } from "./tool-runtime";

export type AgentContext = {
  system?: string;
  messages: Message[];
  tools?: Tool[];
};

type RuntimeContextMessage = UserMessage & {
  provenance: { kind: "runtime_context"; source: string };
};

export type AgentLoopConfig = {
  model: Model;
  maxTurns?: number;
  toolDeadlineMs?: number;
  parallelToolCalls?: boolean;
  maxParallelToolCalls?: number;
  signal?: AbortSignal;
  beforeToolExecution?: BeforeToolExecutionHook;
  toolResultPolicy?: ToolResultPolicy;
  contextManager?: ContextManager;
  logger?: Logger;
  loggerMetadata?: LogMetadata;
  onMessageCommitted?: (message: Message) => Promise<void> | void;
  onCompactionCommitted?: (compaction: ContextCheckpoint) => Promise<void> | void;
  consumeTurnInputs?: () => Promise<UserMessage[]>;
  assemblePrompt?: () => Promise<AssembledPrompt>;
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
  const maxParallelToolCalls = resolveMaxParallelToolCalls(config.maxParallelToolCalls);
  // Resolve once per run so provider advertisement and runtime scheduling
  // cannot diverge, and unsupported models always fail closed to serial use.
  const parallelToolCalls =
    (config.parallelToolCalls ?? true) && config.model.metadata.supportsParallelToolCalls;

  const currentContext: AgentContext = {
    system: context.system,
    messages: [...context.messages],
    tools: context.tools ? [...context.tools] : undefined,
  };
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

    let assembledPrompt: AssembledPrompt;
    try {
      assembledPrompt = config.assemblePrompt
        ? await config.assemblePrompt()
        : {
            system: currentContext.system,
            context: [],
            tools: currentContext.tools ?? [],
          };
      await applyAssembledPrompt(
        currentContext,
        assembledPrompt,
        newMessages,
        config.onMessageCommitted,
        config.signal,
      );
    } catch (error) {
      if (config.signal?.aborted) {
        endReason = "aborted";
        break;
      }
      throw error;
    }
    if (config.signal?.aborted) {
      endReason = "aborted";
      break;
    }

    const sourceMessageCount = currentContext.messages.length;
    let prepared: PreparedContext;
    try {
      prepared = await prepareModelContext(currentContext, config, emit, assembledPrompt.context);
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
        prepared = await prepareModelContext(
          currentContext,
          config,
          emit,
          assembledPrompt.context,
          true,
        );
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
    config.contextManager?.recordAssistantUsage(assistantTurn.message, sourceMessageCount);
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
        estimatedContextTokens: estimateCurrentContextTokens(currentContext, config),
      });
      break;
    }

    const toolCalls =
      assistantTurn.message.stopReason === "toolUse" ? getToolCalls(assistantTurn.message) : [];
    // Execute against exactly the tool objects advertised for this model step.
    // A later assembly may observe a different capability set.
    const toolRuntime = new ToolRuntime(
      {
        tools: currentContext.tools,
        parallelToolCalls,
        maxParallelToolCalls,
        signal: config.signal,
        beforeToolExecution: config.beforeToolExecution,
        defaultDeadlineMs: config.toolDeadlineMs,
        logger: config.logger,
        loggerMetadata: config.loggerMetadata,
        onMessageCommitted: config.onMessageCommitted,
        limitToolContent: (content) => config.contextManager?.limitToolContent(content) ?? content,
        toolResultPolicy: config.toolResultPolicy,
      },
      emit,
    );
    const executedToolCalls = await toolRuntime.execute(toolCalls);

    for (const toolResult of executedToolCalls.toolResults) {
      currentContext.messages.push(toolResult);
      newMessages.push(toolResult);
    }
    for (const additionalMessage of executedToolCalls.additionalMessages) {
      currentContext.messages.push(additionalMessage);
      newMessages.push(additionalMessage);
    }

    await emit({
      type: "turn_end",
      turn,
      message: assistantTurn.message,
      toolResults: executedToolCalls.toolResults,
      estimatedContextTokens: estimateCurrentContextTokens(currentContext, config),
    });

    if (executedToolCalls.abortRun) {
      endReason = "aborted";
      break;
    }

    // Steering belongs after the complete model/tool turn. Leave it queued when
    // no further turn is available so the Agent owner can defer it to a new run.
    const canStartAnotherTurn = !hasTurnLimit || turn < maxTurns;
    const turnInputs = canStartAnotherTurn ? await config.consumeTurnInputs?.() : undefined;
    for (const input of turnInputs ?? []) {
      currentContext.messages.push(input);
      newMessages.push(input);
      await emit({ type: "turn_input", message: input });
    }

    if (toolCalls.length === 0 && !turnInputs?.length) {
      endReason = endReasonForAssistantTurn(assistantTurn);
      break;
    }
  }

  await emit({ type: "agent_end", reason: endReason, messages: newMessages });

  return newMessages;
}

async function applyAssembledPrompt(
  context: AgentContext,
  prompt: AssembledPrompt,
  newMessages: Message[],
  commit: ((message: Message) => Promise<void> | void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  context.system = prompt.system;
  context.tools = prompt.tools.slice();
  const activeSources = new Set(prompt.context.map((snapshot) => snapshot.source));

  for (const snapshot of prompt.context) {
    throwIfAborted(signal);
    const message = createRuntimeContextMessage(snapshot);
    const previous = findLatestRuntimeContext(context.messages, snapshot);
    if (previous?.content === message.content) {
      continue;
    }

    // Dynamic state becomes visible only after the same logical message is
    // durable, preserving recovery ordering before the model request begins.
    await commit?.(structuredClone(message));
    context.messages.push(message);
    newMessages.push(message);
  }

  const inactiveSources = findLatestRuntimeContextBySource(context.messages).filter(
    ({ message }) => !activeSources.has(message.provenance.source),
  );
  for (const { message: previous } of inactiveSources) {
    throwIfAborted(signal);
    const message = createRuntimeContextRemovalMessage(previous.provenance.source);
    if (previous.content === message.content) {
      continue;
    }

    await commit?.(structuredClone(message));
    context.messages.push(message);
    newMessages.push(message);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Prompt assembly aborted.");
  }
}

function findLatestRuntimeContext(
  messages: readonly Message[],
  snapshot: PromptContextSnapshot,
): UserMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      message.provenance.kind === "runtime_context" &&
      message.provenance.source === snapshot.source
    ) {
      return message;
    }
  }
  return undefined;
}

function findLatestRuntimeContextBySource(
  messages: readonly Message[],
): Array<{ index: number; message: RuntimeContextMessage }> {
  const latest = new Map<
    string,
    {
      index: number;
      message: RuntimeContextMessage;
    }
  >();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isRuntimeContextMessage(message)) {
      latest.set(message.provenance.source, { index, message });
    }
  }
  return [...latest.values()].sort((left, right) => left.index - right.index);
}

function isRuntimeContextMessage(message: Message): message is RuntimeContextMessage {
  return message.role === "user" && message.provenance.kind === "runtime_context";
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
    maxOutputTokens: context.maxOutputTokens,
    signal: config.signal,
  });
  let addedAssistantMessage = false;
  let currentMessage: AssistantMessage = {
    ...createMessageIdentity({ kind: "model_output" }),
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
      case "hosted_tool_start":
      case "hosted_tool_end":
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

      case "error": {
        if (event.error instanceof ContextWindowExceededError && !addedAssistantMessage) {
          return {
            message: currentMessage,
            isError: true,
            error: event.error,
            canRetryContextLimit: true,
          };
        }
        const terminalMessage: AssistantMessage = {
          ...(event.snapshot ??
            ({
              ...createMessageIdentity({ kind: "model_output" }),
              role: "assistant",
              content: [],
            } satisfies AssistantMessage)),
          stopReason: event.reason,
        };
        // Provider snapshots describe the last streamed state. The Agent owns
        // the terminal transition, so publish and persist one canonical
        // canceled status for hosted work interrupted by an abort.
        currentMessage =
          event.reason === "aborted"
            ? cancelInProgressHostedTools(terminalMessage)
            : terminalMessage;
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
  runtimeContext: readonly PromptContextSnapshot[],
  forceCompaction = false,
): Promise<PreparedContext> {
  if (!config.contextManager) {
    return {
      context: {
        system: context.system,
        messages: structuredClone(projectRuntimeContextMessages(context.messages, runtimeContext)),
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
      runtimeContext,
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

function estimateCurrentContextTokens(
  context: AgentContext,
  config: AgentLoopConfig,
): number | undefined {
  return config.contextManager?.estimateContextTokens({
    system: context.system,
    messages: context.messages,
    tools: context.tools,
  });
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

function cancelInProgressHostedTools(message: AssistantMessage): AssistantMessage {
  let changed = false;
  const content = message.content.map((item): AssistantContent => {
    if (item.type !== "hosted_tool" || item.status !== "in_progress") {
      return item;
    }

    changed = true;
    return {
      ...item,
      status: "canceled",
    };
  });

  return changed ? { ...message, content } : message;
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
