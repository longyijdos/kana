import {
  type AssistantContent,
  type AssistantMessage,
  ContextWindowExceededError,
  createMessageIdentity,
  type Message,
  type ModelContext,
  type ToolCallContent,
  type UserMessage,
} from "@/core";
import type { Logger } from "@/logging";
import type { Tool } from "@/tools";
import type {
  ContextCheckpoint,
  ContextCompactionReason,
  ContextManager,
  PreparedContext,
} from "./context-manager";
import type { AgentEndReason, AgentEvent } from "./events";
import {
  type AssembledPrompt,
  createRuntimeContextMessage,
  type PromptContextSnapshot,
} from "./prompt-assembly";
import type { AgentSettings } from "./settings";
import type { ToolResultPolicy } from "./tool-result-policy";
import { type BeforeToolExecutionHook, ToolRuntime } from "./tool-runtime";

export type { BeforeToolExecutionHook } from "./tool-runtime";

export type AgentContext = {
  system?: string;
  messages: readonly Message[];
  tools?: readonly Tool[];
  callableTools?: readonly Tool[];
};

type WorkingContext = Omit<AgentContext, "messages"> & { messages: Message[] };

export type AgentLoopConfig = {
  settings: AgentSettings;
  signal?: AbortSignal;
  beforeToolExecution?: BeforeToolExecutionHook;
  toolResultPolicies?: readonly ToolResultPolicy[];
  contextManager?: ContextManager;
  logger?: Logger;
  onMessageCommitted?: (message: Message) => Promise<void> | void;
  onCompactionCommitted?: (compaction: ContextCheckpoint) => Promise<void> | void;
  onStableContext?: (context: Pick<AgentContext, "system" | "messages">) => void;
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

const ABORTED = Symbol("aborted");

export async function runAgentLoop(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
): Promise<Message[]> {
  const { settings, signal } = config;
  const working: WorkingContext = { ...context, messages: [...context.messages] };
  const newMessages: Message[] = [];
  const append = (message: Message): void => {
    working.messages.push(message);
    newMessages.push(message);
  };
  const hasTurnLimit = settings.maxTurns !== -1;
  let endReason: AgentEndReason = hasTurnLimit ? "turn_limit" : "stop";
  // A failure caused by cancellation ends the run as aborted instead of failing it.
  const attempt = async <T>(work: () => Promise<T>): Promise<T | typeof ABORTED> => {
    try {
      return await work();
    } catch (error) {
      if (signal?.aborted) return ABORTED;
      throw error;
    }
  };

  await emit({ type: "agent_start" });

  for (let turn = 1; !hasTurnLimit || turn <= settings.maxTurns; turn += 1) {
    if (signal?.aborted) {
      endReason = "aborted";
      break;
    }

    await emit({ type: "turn_start", turn });

    const assembled = await attempt(() => applyPrompt(working, config, append));
    if (assembled === ABORTED || signal?.aborted) {
      endReason = "aborted";
      break;
    }

    const sourceMessageCount = working.messages.length;
    let assistantTurn = await attempt(() => requestAssistantTurn(working, config, emit, false));
    if (assistantTurn !== ABORTED && assistantTurn.canRetryContextLimit && config.contextManager) {
      assistantTurn = await attempt(() => requestAssistantTurn(working, config, emit, true));
    }
    if (assistantTurn === ABORTED) {
      endReason = "aborted";
      break;
    }
    if (assistantTurn.canRetryContextLimit) {
      throw assistantTurn.error;
    }
    config.contextManager?.recordAssistantUsage(assistantTurn.message, sourceMessageCount);
    const assistantHistoryMessage = assistantMessageForHistory(assistantTurn.message);

    if (assistantHistoryMessage) {
      // Persist a complete assistant tool-call message before any referenced
      // tool can produce an external side effect.
      await config.onMessageCommitted?.(assistantHistoryMessage);
      append(assistantHistoryMessage);
    }

    if (assistantTurn.isError || signal?.aborted) {
      endReason = signal?.aborted ? "aborted" : endReasonForAssistantTurn(assistantTurn);
      if (!assistantHistoryMessage || getToolCalls(assistantHistoryMessage).length === 0) {
        publishStableContext(working, config);
      }
      await emit({
        type: "turn_end",
        turn,
        message: assistantHistoryMessage ?? assistantTurn.message,
        toolResults: [],
        estimatedContextTokens: estimateWorkingTokens(working, config),
      });
      break;
    }

    const toolCalls =
      assistantTurn.message.stopReason === "toolUse" ? getToolCalls(assistantTurn.message) : [];
    // Execute against exactly the tool objects advertised for this model step.
    // A later assembly may observe a different capability set.
    const toolRuntime = new ToolRuntime(
      {
        tools: working.tools,
        callableTools: working.callableTools,
        parallelToolCalls: settings.parallelToolCalls,
        maxParallelToolCalls: settings.maxParallelToolCalls,
        defaultDeadlineMs: settings.toolDeadlineMs,
        signal,
        beforeToolExecution: config.beforeToolExecution,
        logger: config.logger,
        onMessageCommitted: config.onMessageCommitted,
        limitToolContent: (content) => config.contextManager?.limitToolContent(content) ?? content,
        toolContentByteLimit: config.contextManager?.maxToolContentBytes,
        toolResultPolicies: config.toolResultPolicies,
      },
      emit,
    );
    const executed = await toolRuntime.execute(toolCalls);
    for (const message of [...executed.toolResults, ...executed.additionalMessages]) {
      append(message);
    }

    // A truncated response may retain calls that were never executed and
    // therefore cannot be inherited as a complete context boundary.
    const isStableTurn = toolCalls.length > 0 || getToolCalls(assistantTurn.message).length === 0;
    if (isStableTurn) {
      publishStableContext(working, config);
    }
    await emit({
      type: "turn_end",
      turn,
      message: assistantTurn.message,
      toolResults: executed.toolResults,
      estimatedContextTokens: estimateWorkingTokens(working, config),
    });

    if (executed.abortRun) {
      endReason = "aborted";
      break;
    }

    // Steering belongs after the complete model/tool turn. Leave it queued when
    // no further turn is available so the Agent owner can defer it to a new run.
    const canStartAnotherTurn = !hasTurnLimit || turn < settings.maxTurns;
    const turnInputs = canStartAnotherTurn ? await config.consumeTurnInputs?.() : undefined;
    for (const input of turnInputs ?? []) {
      append(input);
      if (isStableTurn) {
        publishStableContext(working, config);
      }
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

// Projects the context for the model and, when a compaction happens, lets the
// owner commit the checkpoint before the compacted event becomes visible.
export async function prepareWithCompaction(
  contextManager: ContextManager,
  context: ModelContext,
  options: {
    signal?: AbortSignal;
    forceCompaction?: boolean;
    compactionReason?: ContextCompactionReason;
    onCommitted?: (compaction: ContextCheckpoint) => Promise<void> | void;
  },
  emit: AgentEventSink,
): Promise<PreparedContext> {
  const prepared = await contextManager.prepareForModel(context, {
    signal: options.signal,
    forceCompaction: options.forceCompaction,
    compactionReason: options.compactionReason,
    onCompactionStart: (event) => emit({ type: "context_compaction_start", ...event }),
  });
  const { compaction } = prepared;
  if (compaction) {
    await options.onCommitted?.(compaction);
    await emit({
      type: "context_compacted",
      reason: compaction.reason,
      beforeTokens: compaction.beforeTokens,
      estimatedAfterTokens: compaction.estimatedAfterTokens,
      compactedMessageCount: compaction.compactedMessageCount,
      contextLimit: contextManager.contextLimit,
      usage: compaction.usage,
    });
  }
  return prepared;
}

function publishStableContext(context: AgentContext, config: AgentLoopConfig): void {
  config.onStableContext?.({
    system: context.system,
    messages: [...context.messages],
  });
}

async function applyPrompt(
  context: AgentContext,
  config: AgentLoopConfig,
  append: (message: Message) => void,
): Promise<void> {
  const prompt: AssembledPrompt = config.assemblePrompt
    ? await config.assemblePrompt()
    : {
        system: context.system,
        context: [],
        tools: context.tools ?? [],
        callableTools: context.callableTools,
      };
  context.system = prompt.system;
  context.tools = prompt.tools;
  context.callableTools = prompt.callableTools;

  for (const snapshot of prompt.context) {
    config.signal?.throwIfAborted();
    const previous = findLatestRuntimeContext(context.messages, snapshot);
    if (!previous && snapshot.status === "inactive") {
      continue;
    }

    const message = createRuntimeContextMessage(snapshot);
    if (previous?.content === message.content) {
      continue;
    }

    // Dynamic state becomes visible only after the same logical message is
    // durable, preserving recovery ordering before the model request begins.
    await config.onMessageCommitted?.(message);
    append(message);
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

async function requestAssistantTurn(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  forceCompaction: boolean,
): Promise<AssistantTurnResult> {
  const { settings, signal } = config;
  const modelContext: ModelContext = {
    system: context.system,
    messages: [...context.messages],
    tools: context.tools,
    signal,
  };
  const prepared = config.contextManager
    ? (
        await prepareWithCompaction(
          config.contextManager,
          modelContext,
          { signal, forceCompaction, onCommitted: config.onCompactionCommitted },
          emit,
        )
      ).context
    : modelContext;
  const response = settings.model.stream({
    system: prepared.system,
    messages: prepared.messages,
    tools: prepared.tools,
    webSearch: settings.webSearch,
    imageInput: settings.imageInput,
    parallelToolCalls: settings.parallelToolCalls,
    maxOutputTokens: prepared.maxOutputTokens,
    signal,
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
        addedAssistantMessage = true;
        await emit({ type: "message_start", message: currentMessage });
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
        await emit({
          type: "message_update",
          message: currentMessage,
          assistantMessageEvent: event,
        });
        break;

      case "done":
        currentMessage = {
          ...event.message,
          stopReason: event.reason,
        };
        await emit({ type: "message_end", message: currentMessage });
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
        // cancelled status for hosted work interrupted by an abort.
        currentMessage =
          event.reason === "aborted"
            ? cancelInProgressHostedTools(terminalMessage)
            : terminalMessage;
        if (!addedAssistantMessage) {
          await emit({ type: "message_start", message: currentMessage });
        }
        await emit({ type: "message_end", message: currentMessage });
        return {
          message: currentMessage,
          isError: true,
          error: event.error,
        };
      }
    }
  }

  throw new Error("Model stream ended without a done or error event.");
}

function estimateWorkingTokens(context: AgentContext, config: AgentLoopConfig): number | undefined {
  return config.contextManager?.estimateContextTokens({
    system: context.system,
    messages: context.messages,
    tools: context.tools,
  });
}

function getToolCalls(message: AssistantMessage): ToolCallContent[] {
  return message.content.filter((content) => content.type === "tool_call");
}

function assistantMessageForHistory(message: AssistantMessage): AssistantMessage | undefined {
  if (message.stopReason === "error" && message.content.length === 0) {
    return undefined;
  }

  if (message.stopReason !== "aborted" && message.stopReason !== "error") {
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
      status: "cancelled",
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
