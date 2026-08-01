import { randomUUID } from "node:crypto";

import type { AssistantMessage, Message, Model, UserMessage } from "@/core";
import { createNoopLogger, type Logger, type LogMetadata } from "@/logging";
import type { Tool } from "@/tools";
import {
  type ContextCheckpoint,
  ContextManager,
  type ContextManagerConfig,
} from "./context-manager";
import type { AgentEvent } from "./events";
import type { AgentJournal } from "./journal";
import {
  type AgentContext,
  type AgentLoopConfig,
  assertValidMaxTurns,
  type BeforeToolExecutionHook,
  runAgentLoop,
} from "./loop";
import { AgentEventStream } from "./stream";
import { resolveDefaultToolDeadlineMs } from "./tool-runtime";

export type AgentPromptInput = string | UserMessage | UserMessage[];

export type AgentConfig = {
  model: Model;
  system?: string;
  messages?: Message[];
  tools?: Tool[];
  // Prevent accidental infinite tool loops while keeping the first version
  // free of custom stop hooks. Use -1 to run without a turn limit.
  maxTurns?: number;
  toolDeadlineMs?: number;
  parallelToolCalls?: boolean;
  beforeToolExecution?: BeforeToolExecutionHook;
  onRunCommitted?: AgentRunCommittedHook;
  onCompactionCommitted?: AgentCompactionCommittedHook;
  journal?: AgentJournal;
  logger?: Logger;
  loggerMetadata?: LogMetadata;
  context?: Omit<ContextManagerConfig, "logger" | "loggerMetadata">;
};

export type AgentState = {
  model: Model;
  system?: string;
  maxTurns?: number;
  readonly toolDeadlineMs: number;
  tools: Tool[];
  messages: Message[];
  readonly isRunning: boolean;
  readonly streamingMessage?: AssistantMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly error?: unknown;
  readonly contextLimit?: number;
  readonly contextCheckpoint?: ContextCheckpoint;
};

type WritableAgentState = Omit<
  AgentState,
  | "isRunning"
  | "streamingMessage"
  | "pendingToolCalls"
  | "error"
  | "contextLimit"
  | "contextCheckpoint"
> & {
  isRunning: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: Set<string>;
  error?: unknown;
};

export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export type AgentRunCommittedHook = (commit: {
  messages: Message[];
  compactions: ContextCheckpoint[];
  state: AgentState;
  event: Extract<AgentEvent, { type: "agent_end" }>;
}) => Promise<void> | void;

export type AgentCompactionCommittedHook = (commit: {
  compaction: ContextCheckpoint;
  state: AgentState;
}) => Promise<void> | void;

type ActiveRun = {
  promise: Promise<void>;
  resolve(): void;
  abortController: AbortController;
};

export class Agent {
  private readonly listeners = new Set<AgentEventListener>();
  private activeRun?: ActiveRun;
  private readonly stateData: WritableAgentState;
  private readonly beforeToolExecution?: BeforeToolExecutionHook;
  private readonly onRunCommitted?: AgentRunCommittedHook;
  private readonly onCompactionCommitted?: AgentCompactionCommittedHook;
  private readonly journal?: AgentJournal;
  private readonly logger: Logger;
  private readonly loggerMetadata?: LogMetadata;
  private readonly contextManager?: ContextManager;
  private readonly parallelToolCalls: boolean;

  constructor(options: AgentConfig) {
    assertValidMaxTurns(options.maxTurns);
    const toolDeadlineMs = resolveDefaultToolDeadlineMs(options.toolDeadlineMs);
    this.logger = options.logger ?? createNoopLogger();
    this.loggerMetadata = options.loggerMetadata;
    const parallelToolCallsRequested = options.parallelToolCalls ?? true;
    this.parallelToolCalls =
      parallelToolCallsRequested && options.model.metadata.supportsParallelToolCalls;
    this.stateData = createWritableAgentState({
      ...options,
      toolDeadlineMs,
    });
    this.beforeToolExecution = options.beforeToolExecution;
    this.onRunCommitted = options.onRunCommitted;
    this.onCompactionCommitted = options.onCompactionCommitted;
    this.journal = options.journal;
    this.contextManager = options.context
      ? new ContextManager({
          ...options.context,
          logger: this.logger,
          loggerMetadata: this.loggerMetadata,
        })
      : undefined;
    this.log("debug", "agent.parallel_tool_calls_configured", {
      requested: parallelToolCallsRequested,
      supported: options.model.metadata.supportsParallelToolCalls,
      enabled: this.parallelToolCalls,
    });
  }

  get state(): AgentState {
    return {
      model: this.stateData.model,
      system: this.stateData.system,
      maxTurns: this.stateData.maxTurns,
      toolDeadlineMs: this.stateData.toolDeadlineMs,
      tools: this.stateData.tools.slice(),
      messages: structuredClone(this.stateData.messages),
      isRunning: this.stateData.isRunning,
      streamingMessage:
        this.stateData.streamingMessage === undefined
          ? undefined
          : structuredClone(this.stateData.streamingMessage),
      pendingToolCalls: new Set(this.stateData.pendingToolCalls),
      error: this.stateData.error,
      contextLimit: this.contextManager?.contextLimit,
      contextCheckpoint: this.contextManager?.checkpoint,
    };
  }

  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async prompt(input: AgentPromptInput): Promise<void> {
    await this.stream(input).result();
  }

  async compact(): Promise<ContextCheckpoint> {
    if (!this.contextManager) {
      throw new Error("Context compaction is not configured.");
    }

    let committed: ContextCheckpoint | undefined;
    await this.runWithLifecycle(async (signal) => {
      const runContextManager = this.contextManager?.fork();
      if (!runContextManager) {
        throw new Error("Context compaction is not configured.");
      }

      const prepared = await runContextManager.prepareForModel(this.createContextSnapshot(), {
        signal,
        forceCompaction: true,
        compactionReason: "manual",
        onCompactionStart: async (event) => {
          await this.processEvent({
            type: "context_compaction_start",
            reason: event.reason,
            estimatedTokens: event.estimatedTokens,
            contextLimit: event.contextLimit,
          });
        },
      });
      if (!prepared.compaction) {
        throw new Error("There is no complete context to compact.");
      }

      committed = prepared.compaction;
      if (this.journal) {
        await this.journal.appendCompaction({
          compaction: structuredClone(committed),
        });
        this.contextManager?.adopt(runContextManager);
        await this.onCompactionCommitted?.({
          compaction: structuredClone(committed),
          state: this.state,
        });
      } else {
        // Preserve the original hook contract for embedders that use it as
        // their persistence boundary instead of the incremental journal.
        await this.onCompactionCommitted?.({
          compaction: structuredClone(committed),
          state: {
            ...this.state,
            contextCheckpoint: structuredClone(committed),
          },
        });
        this.contextManager?.adopt(runContextManager);
      }
      await this.processEvent({
        type: "context_compacted",
        reason: committed.reason,
        beforeTokens: committed.beforeTokens,
        estimatedAfterTokens: committed.estimatedAfterTokens,
        compactedMessageCount: committed.compactedMessageCount,
        contextLimit: runContextManager.contextLimit,
        usage: committed.usage,
      });
    });

    if (!committed) {
      throw new Error("Context compaction did not produce a checkpoint.");
    }
    return structuredClone(committed);
  }

  stream(input: AgentPromptInput): AgentEventStream {
    const stream = new AgentEventStream();
    let doneEvent: Extract<AgentEvent, { type: "agent_end" }> | undefined;
    let committedCompactions: ContextCheckpoint[] = [];
    let phase: "journal_start" | "loop" | "journal_end" | "commit" | "publish" = "journal_start";
    let journalStarted = false;
    let journalFailed = false;
    const runId = randomUUID();

    if (this.activeRun) {
      stream.error(new Error("Agent is already running."));
      return stream;
    }

    const promptMessages = toPromptMessages(input);
    const runContextManager = this.contextManager?.fork();

    void this.runWithLifecycle(async (signal) => {
      const writeJournal = async (operation: () => Promise<void> | void): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          journalFailed = true;
          throw error;
        }
      };

      try {
        // A run cannot begin model I/O until its prompt is durable. Later
        // message hooks use the same ordering before mutating Agent history.
        await writeJournal(() =>
          this.journal?.startRun({
            runId,
            messages: structuredClone(promptMessages),
          }),
        );
        journalStarted = true;
        this.stateData.messages = [...this.stateData.messages, ...structuredClone(promptMessages)];
        this.log("info", "agent.run_started", {
          promptMessageCount: promptMessages.length,
        });

        phase = "loop";
        await runAgentLoop(
          this.createContextSnapshot(),
          this.createLoopConfig(signal, runContextManager, {
            onMessageCommitted: async (message) => {
              if (this.journal) {
                await writeJournal(() =>
                  this.journal?.appendMessage({
                    runId,
                    message: structuredClone(message),
                  }),
                );
                this.stateData.messages = [...this.stateData.messages, structuredClone(message)];
              }
            },
            onCompactionCommitted: async (compaction) => {
              if (this.journal) {
                // Adopt a checkpoint only after the session can recover it.
                await writeJournal(() =>
                  this.journal?.appendCompaction({
                    runId,
                    compaction: structuredClone(compaction),
                  }),
                );
                if (runContextManager && this.contextManager) {
                  this.contextManager.adopt(runContextManager);
                }
              }
            },
          }),
          async (event) => {
            if (event.type === "agent_end") {
              doneEvent = structuredClone(event);
              if (!this.journal) {
                this.stateData.messages = [
                  ...this.stateData.messages,
                  ...structuredClone(doneEvent.messages),
                ];
              }
              if (runContextManager && this.contextManager) {
                this.contextManager.adopt(runContextManager);
                committedCompactions = runContextManager.compactions;
              }
              this.reduceEvent(doneEvent);
              return;
            }

            await this.processEvent(event);
            stream.push(structuredClone(event));
          },
        );

        if (!doneEvent) {
          throw new Error("Agent loop finished without agent_end.");
        }
        const completedEvent = doneEvent;

        phase = "journal_end";
        await writeJournal(() =>
          this.journal?.endRun({
            runId,
            reason: completedEvent.reason,
          }),
        );

        phase = "commit";
        await this.onRunCommitted?.({
          messages: structuredClone([...promptMessages, ...completedEvent.messages]),
          compactions: structuredClone(committedCompactions),
          state: this.state,
          event: structuredClone(completedEvent),
        });

        phase = "publish";
        await this.publishEvent(completedEvent);
        stream.end(structuredClone(completedEvent));
      } catch (error) {
        if (journalStarted && !journalFailed && !doneEvent) {
          phase = "journal_end";
          await writeJournal(() =>
            this.journal?.endRun({
              runId,
              reason: "error",
            }),
          );
        }
        throw error;
      }
    }).catch((error) => {
      this.log("error", "agent.run_failed", { phase, error });
      stream.error(error);
    });

    return stream;
  }

  abort(): void {
    this.activeRun?.abortController.abort();
  }

  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  reset(): void {
    if (this.activeRun) {
      throw new Error("Cannot reset Agent while it is running.");
    }

    this.stateData.messages = [];
    this.stateData.streamingMessage = undefined;
    this.stateData.pendingToolCalls = new Set<string>();
    this.stateData.error = undefined;
    this.contextManager?.reset();
  }

  private createContextSnapshot(): AgentContext {
    return {
      system: this.stateData.system,
      messages: structuredClone(this.stateData.messages),
      tools: this.stateData.tools.slice(),
    };
  }

  private createLoopConfig(
    signal: AbortSignal,
    contextManager: ContextManager | undefined,
    hooks: Pick<AgentLoopConfig, "onMessageCommitted" | "onCompactionCommitted"> = {},
  ): AgentLoopConfig {
    return {
      model: this.stateData.model,
      maxTurns: this.stateData.maxTurns,
      toolDeadlineMs: this.stateData.toolDeadlineMs,
      parallelToolCalls: this.parallelToolCalls,
      signal,
      beforeToolExecution: this.beforeToolExecution,
      contextManager,
      logger: this.logger,
      loggerMetadata: this.loggerMetadata,
      ...hooks,
    };
  }

  private async runWithLifecycle(
    executor: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already running.");
    }

    const abortController = new AbortController();
    let resolveRun!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });

    this.activeRun = {
      promise,
      resolve: resolveRun,
      abortController,
    };
    this.stateData.isRunning = true;
    this.stateData.streamingMessage = undefined;
    this.stateData.pendingToolCalls = new Set<string>();
    this.stateData.error = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      this.stateData.error = error;
      throw error;
    } finally {
      this.stateData.isRunning = false;
      this.stateData.streamingMessage = undefined;
      this.stateData.pendingToolCalls = new Set<string>();
      this.activeRun.resolve();
      this.activeRun = undefined;
    }
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    this.reduceEvent(event);
    await this.publishEvent(event);
  }

  private async publishEvent(event: AgentEvent): Promise<void> {
    this.logEvent(event);

    const signal = this.activeRun?.abortController.signal;

    if (!signal) {
      throw new Error("Agent event processed outside an active run.");
    }

    for (const listener of [...this.listeners]) {
      try {
        await listener(structuredClone(event), signal);
      } catch (error) {
        this.log("warn", "agent.listener_failed", {
          eventType: event.type,
          error,
        });
      }
    }
  }

  private logEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.log("debug", "agent.started");
        break;
      case "turn_start":
        this.log("debug", "agent.turn_started", { turn: event.turn });
        break;
      case "turn_end":
        this.log("debug", "agent.turn_ended", {
          turn: event.turn,
          stopReason: event.message.stopReason,
          toolResultCount: event.toolResults.length,
        });
        break;
      case "tool_execution_start":
        this.log("debug", "tool.execution_started", { toolName: event.toolName });
        break;
      case "tool_execution_end":
        if (event.isError) {
          this.log("warn", "tool.execution_failed", { toolName: event.toolName });
          break;
        }
        this.log("debug", "tool.execution_ended", {
          toolName: event.toolName,
        });
        break;
      case "agent_end":
        this.log("info", "agent.ended", {
          reason: event.reason,
          committedMessageCount: event.messages.length,
        });
        break;

      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_update":
      case "context_compaction_start":
      case "context_compacted":
        break;
    }
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    metadata?: LogMetadata,
  ): void {
    const mergedMetadata = {
      ...this.loggerMetadata,
      ...metadata,
    };

    try {
      this.logger[level](
        event,
        Object.keys(mergedMetadata).length === 0 ? undefined : mergedMetadata,
      );
    } catch {
      // Diagnostics must not change Agent lifecycle or cleanup behavior.
    }
  }

  private reduceEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.stateData.streamingMessage = event.message;
        break;

      case "message_end":
        this.stateData.streamingMessage = undefined;
        break;

      case "tool_execution_start": {
        const pendingToolCalls = new Set(this.stateData.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this.stateData.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "tool_execution_end": {
        const pendingToolCalls = new Set(this.stateData.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this.stateData.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "agent_end":
        this.stateData.streamingMessage = undefined;
        break;
    }
  }
}

function createWritableAgentState(
  options: AgentConfig & { toolDeadlineMs: number },
): WritableAgentState {
  let tools = options.tools?.slice() ?? [];
  let messages = structuredClone(options.messages ?? []);

  return {
    model: options.model,
    system: options.system,
    maxTurns: options.maxTurns,
    toolDeadlineMs: options.toolDeadlineMs,
    get tools() {
      return tools;
    },
    set tools(nextTools: Tool[]) {
      tools = nextTools.slice();
    },
    get messages() {
      return messages;
    },
    set messages(nextMessages: Message[]) {
      messages = nextMessages.slice();
    },
    isRunning: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    error: undefined,
  };
}

function toPromptMessages(input: AgentPromptInput): UserMessage[] {
  if (Array.isArray(input)) {
    return input.map((message) => structuredClone(message));
  }

  if (typeof input !== "string") {
    return [structuredClone(input)];
  }

  return [
    {
      role: "user",
      content: input,
    },
  ];
}
