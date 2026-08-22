import { randomUUID } from "node:crypto";

import {
  type AssistantMessage,
  createUserMessage,
  type Message,
  type MessageId,
  type Model,
  type UserMessage,
} from "@/core";
import { createNoopLogger, type Logger, type LogMetadata } from "@/logging";
import type { Tool } from "@/tools";
import {
  type ContextCheckpoint,
  ContextManager,
  type ContextManagerConfig,
} from "./context-manager";
import type { AgentEvent } from "./events";
import {
  AgentInbox,
  type AgentInboxItem,
  type AgentInboxSnapshot,
  type AgentInputDelivery,
  type AgentInputLane,
} from "./inbox";
import type { AgentJournal } from "./journal";
import {
  type AgentContext,
  type AgentLoopConfig,
  assertValidMaxTurns,
  type BeforeToolExecutionHook,
  runAgentLoop,
} from "./loop";
import { createPromptAssembly, type PromptAssembly } from "./prompt-assembly";
import { AgentEventStream } from "./stream";
import { resolveDefaultToolDeadlineMs } from "./tool-runtime";

export type AgentPromptInput = string | UserMessage | UserMessage[];

export type AgentConfig = {
  model: Model;
  system?: string;
  promptAssembly?: PromptAssembly;
  messages?: Message[];
  inbox?: AgentInboxSnapshot;
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
  readonly inbox: AgentInboxSnapshot;
  readonly isRunning: boolean;
  readonly streamingMessage?: AssistantMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly error?: unknown;
  readonly contextLimit?: number;
  readonly contextCheckpoint?: ContextCheckpoint;
  readonly estimatedContextTokens?: number;
};

type WritableAgentState = Omit<
  AgentState,
  | "isRunning"
  | "inbox"
  | "streamingMessage"
  | "pendingToolCalls"
  | "error"
  | "contextLimit"
  | "contextCheckpoint"
  | "estimatedContextTokens"
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

export type AgentSteerOutcome = "consumed" | "deferred";

export type AgentCompactionCommittedHook = (commit: {
  compaction: ContextCheckpoint;
  state: AgentState;
}) => Promise<void> | void;

type ActiveRun = {
  promise: Promise<void>;
  resolve(): void;
  abortController: AbortController;
  steeringEnabled?: boolean;
};

export type AgentInboxListener = (snapshot: AgentInboxSnapshot) => void;

export class Agent {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly inboxListeners = new Set<AgentInboxListener>();
  private readonly steeringResolvers = new Map<MessageId, (outcome: AgentSteerOutcome) => void>();
  private readonly committingSteeringIds = new Set<MessageId>();
  private activeRun?: ActiveRun;
  private readonly inboxData: AgentInbox;
  private readonly stateData: WritableAgentState;
  private readonly beforeToolExecution?: BeforeToolExecutionHook;
  private readonly onRunCommitted?: AgentRunCommittedHook;
  private readonly onCompactionCommitted?: AgentCompactionCommittedHook;
  private readonly journal?: AgentJournal;
  private readonly logger: Logger;
  private readonly loggerMetadata?: LogMetadata;
  private readonly contextManager?: ContextManager;
  private readonly parallelToolCalls: boolean;
  private readonly promptAssembly: PromptAssembly;

  constructor(options: AgentConfig) {
    assertValidMaxTurns(options.maxTurns);
    const toolDeadlineMs = resolveDefaultToolDeadlineMs(options.toolDeadlineMs);
    this.logger = options.logger ?? createNoopLogger();
    this.loggerMetadata = options.loggerMetadata;
    const parallelToolCallsRequested = options.parallelToolCalls ?? true;
    this.parallelToolCalls =
      parallelToolCallsRequested && options.model.metadata.supportsParallelToolCalls;
    if (options.promptAssembly && (options.system !== undefined || options.tools !== undefined)) {
      throw new Error("Agent promptAssembly cannot be combined with system or tools.");
    }
    this.promptAssembly =
      options.promptAssembly ??
      createPromptAssembly({
        system: options.system === undefined ? [] : [{ name: "agent", content: options.system }],
        tools: options.tools === undefined ? [] : [{ name: "agent", tools: options.tools }],
      });
    this.stateData = createWritableAgentState({
      ...options,
      system: this.promptAssembly.initialSystem,
      tools: this.promptAssembly.initialTools.slice(),
      toolDeadlineMs,
    });
    this.inboxData = new AgentInbox(options.inbox);
    assertUniqueMessageIds([
      ...this.stateData.messages,
      ...this.inboxData.snapshot.nextStep.map((item) => item.message),
      ...this.inboxData.snapshot.nextTurn.map((item) => item.message),
    ]);
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
      inbox: this.inboxData.snapshot,
      isRunning: this.stateData.isRunning,
      streamingMessage:
        this.stateData.streamingMessage === undefined
          ? undefined
          : structuredClone(this.stateData.streamingMessage),
      pendingToolCalls: new Set(this.stateData.pendingToolCalls),
      error: this.stateData.error,
      contextLimit: this.contextManager?.contextLimit,
      contextCheckpoint: this.contextManager?.checkpoint,
      estimatedContextTokens: this.contextManager?.estimateContextTokens({
        system: this.stateData.system,
        messages: this.stateData.messages,
        tools: this.stateData.tools,
      }),
    };
  }

  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  get inbox(): AgentInboxSnapshot {
    return this.inboxData.snapshot;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeInbox(listener: AgentInboxListener): () => void {
    this.inboxListeners.add(listener);
    return () => {
      this.inboxListeners.delete(listener);
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
    const inbox = this.inboxData.snapshot;
    try {
      assertUniqueMessageIds([
        ...this.stateData.messages,
        ...promptMessages,
        ...inbox.nextStep.map((item) => item.message),
        ...inbox.nextTurn.map((item) => item.message),
      ]);
    } catch (error) {
      stream.error(error);
      return stream;
    }
    const runContextManager = this.contextManager?.fork();

    void this.runWithSteeringLifecycle(async (signal) => {
      const writeJournal = async (operation: () => Promise<void> | void): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          journalFailed = true;
          throw error;
        }
      };
      const commitMessage = async (message: Message): Promise<void> => {
        if (!this.journal) {
          return;
        }
        assertMessageIdAvailable(this.stateData.messages, message);

        await writeJournal(() =>
          this.journal?.appendMessage({
            runId,
            message: structuredClone(message),
          }),
        );
        this.stateData.messages = [...this.stateData.messages, structuredClone(message)];
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
            onMessageCommitted: commitMessage,
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
            consumeTurnInputs: () => this.consumeSteeringInputs(commitMessage),
          }),
          async (event) => {
            if (event.type === "agent_end") {
              doneEvent = structuredClone(event);
              if (!this.journal) {
                assertUniqueMessageIds([...this.stateData.messages, ...doneEvent.messages]);
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

  steer(input: UserMessage): Promise<AgentSteerOutcome> {
    if (this.activeRun?.steeringEnabled !== true) {
      this.enqueueInput(input, "next-turn", { kind: "steering" });
      return Promise.resolve("deferred");
    }

    return new Promise((resolve) => {
      this.enqueueInput(input, "next-step", { kind: "steering" });
      // Inbox insertion must succeed before the resolver becomes visible;
      // otherwise a duplicate ID could replace the original caller's waiter.
      this.steeringResolvers.set(input.id, resolve);
      this.log("info", "agent.steering_input_queued", {
        pendingInputCount: this.inboxData.snapshot.nextStep.length,
      });
    });
  }

  enqueueInput(input: UserMessage, lane: AgentInputLane, delivery: AgentInputDelivery): void {
    if (this.stateData.messages.some((message) => message.id === input.id)) {
      throw new Error(`Message ${input.id} is already committed to Agent history.`);
    }
    this.inboxData.enqueue({ message: structuredClone(input), delivery }, lane);
    this.emitInboxChanged();
  }

  shiftNextTurnInput(): AgentInboxItem | undefined {
    const item = this.inboxData.shiftNextTurn();
    if (item) {
      this.emitInboxChanged();
    }
    return item;
  }

  cancelInput(id: MessageId): AgentInboxItem | undefined {
    if (this.committingSteeringIds.has(id)) {
      // Once journal commit starts, cancellation cannot make the durable
      // message disagree with the inbox item claimed for model history.
      this.log("info", "agent.input_cancel_skipped", { reason: "commit_in_progress" });
      return undefined;
    }
    const item = this.inboxData.remove(id);
    if (!item) {
      return undefined;
    }
    this.steeringResolvers.get(id)?.("deferred");
    this.steeringResolvers.delete(id);
    this.emitInboxChanged();
    return item;
  }

  clearInbox(): void {
    // A steering item crossing the journal boundary is no longer cancelable.
    // Shutdown may clear every other item, then wait for this claim to finish.
    const removed = this.inboxData.clear(this.committingSteeringIds);
    if (removed.length === 0) {
      return;
    }
    for (const item of removed) {
      this.steeringResolvers.get(item.message.id)?.("deferred");
      this.steeringResolvers.delete(item.message.id);
    }
    this.emitInboxChanged();
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
    this.clearInbox();
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
    hooks: Pick<
      AgentLoopConfig,
      "onMessageCommitted" | "onCompactionCommitted" | "consumeTurnInputs"
    > = {},
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
      assemblePrompt: async () => {
        try {
          const prompt = await this.promptAssembly.assemble({ signal });
          this.stateData.system = prompt.system;
          this.stateData.tools = prompt.tools;
          return prompt;
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          this.log("error", "agent.prompt_assembly_failed", {
            errorType: error instanceof Error ? error.name : typeof error,
          });
          throw error;
        }
      },
      ...hooks,
    };
  }

  private runWithSteeringLifecycle(
    executor: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    return this.runWithLifecycle((signal) => {
      if (!this.activeRun) {
        throw new Error("Agent steering initialized outside an active run.");
      }
      // Steering input belongs to this run only. Compaction uses the base
      // lifecycle and therefore never exposes a queue that it cannot consume.
      this.activeRun.steeringEnabled = true;
      return executor(signal);
    });
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
      const deferredInputs = this.activeRun.steeringEnabled ? this.inboxData.deferNextStep() : [];
      if (deferredInputs.length > 0) {
        this.log("info", "agent.steering_inputs_deferred", {
          inputCount: deferredInputs.length,
        });
      }
      for (const input of deferredInputs) {
        this.steeringResolvers.get(input.message.id)?.("deferred");
        this.steeringResolvers.delete(input.message.id);
      }
      if (deferredInputs.length > 0) {
        this.emitInboxChanged();
      }
      this.stateData.isRunning = false;
      this.stateData.streamingMessage = undefined;
      this.stateData.pendingToolCalls = new Set<string>();
      this.activeRun.resolve();
      this.activeRun = undefined;
    }
  }

  private async consumeSteeringInputs(
    commit: (message: UserMessage) => Promise<void>,
  ): Promise<UserMessage[]> {
    if (this.activeRun?.steeringEnabled !== true) {
      return [];
    }

    const consumed: UserMessage[] = [];
    let pending = this.inboxData.peekNextStep();
    while (pending) {
      const pendingId = pending.message.id;
      this.committingSteeringIds.add(pendingId);
      let claimed: AgentInboxItem;
      try {
        await commit(structuredClone(pending.message));
        claimed = this.inboxData.claimNextStep(pendingId);
      } finally {
        this.committingSteeringIds.delete(pendingId);
      }
      this.steeringResolvers.get(claimed.message.id)?.("consumed");
      this.steeringResolvers.delete(claimed.message.id);
      consumed.push(structuredClone(claimed.message));
      pending = this.inboxData.peekNextStep();
    }

    if (consumed.length > 0) {
      this.emitInboxChanged();
      this.log("info", "agent.steering_inputs_consumed", {
        inputCount: consumed.length,
      });
    }
    return consumed;
  }

  private emitInboxChanged(): void {
    const snapshot = this.inboxData.snapshot;
    for (const listener of [...this.inboxListeners]) {
      try {
        listener(structuredClone(snapshot));
      } catch (error) {
        this.log("warn", "agent.inbox_listener_failed", { error });
      }
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
      case "turn_input":
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

      case "turn_input":
        break;
    }
  }
}

function createWritableAgentState(
  options: AgentConfig & { toolDeadlineMs: number },
): WritableAgentState {
  let tools = options.tools?.slice() ?? [];
  let messages = structuredClone(options.messages ?? []);
  assertUniqueMessageIds(messages);

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

function assertUniqueMessageIds(messages: readonly Message[]): void {
  const ids = new Set<MessageId>();
  for (const message of messages) {
    if (ids.has(message.id)) {
      throw new Error(`Duplicate Message id in Agent history: ${message.id}`);
    }
    ids.add(message.id);
  }
}

function assertMessageIdAvailable(messages: readonly Message[], candidate: Message): void {
  if (messages.some((message) => message.id === candidate.id)) {
    throw new Error(`Duplicate Message id in Agent history: ${candidate.id}`);
  }
}

function toPromptMessages(input: AgentPromptInput): UserMessage[] {
  if (Array.isArray(input)) {
    return input.map((message) => structuredClone(message));
  }

  if (typeof input !== "string") {
    return [structuredClone(input)];
  }

  return [
    createUserMessage({
      content: input,
      provenance: { kind: "user_input" },
    }),
  ];
}
