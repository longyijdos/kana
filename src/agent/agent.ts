import { randomUUID } from "node:crypto";

import {
  type AssistantMessage,
  createUserMessage,
  type Message,
  type MessageId,
  type Model,
  type UserMessage,
} from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import { createCodemodeTool, type Tool } from "@/tools";
import { errorFields } from "@/utils";
import {
  type ContextCheckpoint,
  ContextManager,
  type ContextManagerConfig,
} from "./context-manager";
import { type AgentEvent, logAgentEvent } from "./events";
import type {
  AgentInboxItem,
  AgentInboxSnapshot,
  AgentInputDelivery,
  AgentInputLane,
} from "./inbox";
import type { AgentJournal } from "./journal";
import {
  type AgentContext,
  type AgentLoopConfig,
  type BeforeToolExecutionHook,
  prepareWithCompaction,
  runAgentLoop,
} from "./loop";
import { createPromptAssembly, type PromptAssembly } from "./prompt-assembly";
import {
  createRepeatedToolCallPolicy,
  type RepeatedToolCallPolicyConfig,
} from "./repeated-tool-call-policy";
import { type AgentSettings, resolveAgentSettings } from "./settings";
import { type AgentInboxListener, type AgentSteerOutcome, SteeringQueue } from "./steering";
import { AgentEventStream } from "./stream";
import type { ToolResultPolicy } from "./tool-result-policy";

export type { AgentInboxListener, AgentSteerOutcome } from "./steering";

export type AgentPromptInput = string | UserMessage | readonly UserMessage[];

export type AgentConfig = {
  model: Model;
  system?: string;
  promptAssembly?: PromptAssembly;
  messages?: readonly Message[];
  inbox?: AgentInboxSnapshot;
  tools?: Tool[];
  codemode?: "off" | "mixed" | "only";
  // Prevents accidental infinite tool loops. Use -1 to run without a turn limit.
  maxTurns?: number;
  toolDeadlineMs?: number;
  webSearch?: boolean;
  imageInput?: boolean;
  parallelToolCalls?: boolean;
  maxParallelToolCalls?: number;
  repeatedToolCalls?: RepeatedToolCallPolicyConfig;
  toolResultPolicy?: ToolResultPolicy;
  beforeToolExecution?: BeforeToolExecutionHook;
  onRunCommitted?: AgentRunCommittedHook;
  onCompactionCommitted?: AgentCompactionCommittedHook;
  journal?: AgentJournal;
  logger?: Logger;
  context?: Omit<ContextManagerConfig, "logger">;
};

export type AgentState = {
  readonly model: Model;
  readonly system?: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly inbox: AgentInboxSnapshot;
  readonly isRunning: boolean;
  readonly streamingMessage?: AssistantMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly error?: unknown;
  readonly contextLimit?: number;
  readonly contextCheckpoint?: ContextCheckpoint;
};

export type AgentStableContext = {
  readonly model: Model;
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly imageInput: boolean;
  readonly contextLimit?: number;
  readonly maxOutputTokens?: number;
  readonly contextCheckpoint?: ContextCheckpoint;
};

export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

type AgentEndEvent = Extract<AgentEvent, { type: "agent_end" }>;

export type AgentRunCommittedHook = (commit: {
  messages: readonly Message[];
  compactions: readonly ContextCheckpoint[];
  state: AgentState;
  event: AgentEndEvent;
}) => Promise<void> | void;

export type AgentCompactionCommittedHook = (commit: {
  compaction: ContextCheckpoint;
  state: AgentState;
}) => Promise<void> | void;

type ActiveRun = {
  promise: Promise<void>;
  abortController: AbortController;
  // Steering input belongs to prompt runs only. Compaction never exposes a
  // queue that it cannot consume.
  steeringEnabled: boolean;
};

type RunPhase = "journal_start" | "loop" | "journal_end" | "commit" | "publish";

export class Agent {
  readonly settings: AgentSettings;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly steering: SteeringQueue;
  private readonly logger: Logger;
  private readonly promptAssembly: PromptAssembly;
  private readonly codemode: NonNullable<AgentConfig["codemode"]>;
  private readonly toolResultPolicies: readonly ToolResultPolicy[];
  private readonly beforeToolExecution?: BeforeToolExecutionHook;
  private readonly onRunCommitted?: AgentRunCommittedHook;
  private readonly onCompactionCommitted?: AgentCompactionCommittedHook;
  private readonly journal?: AgentJournal;
  private readonly contextManager?: ContextManager;
  private messages: readonly Message[] = [];
  private system?: string;
  private callableTools: readonly Tool[];
  private tools: readonly Tool[];
  private streamingMessage?: AssistantMessage;
  private pendingToolCalls: ReadonlySet<string> = new Set();
  private error?: unknown;
  private activeRun?: ActiveRun;
  private stableContext: Pick<AgentStableContext, "system" | "messages" | "contextCheckpoint">;

  constructor(options: AgentConfig) {
    if (options.promptAssembly && (options.system !== undefined || options.tools !== undefined)) {
      throw new Error("Agent promptAssembly cannot be combined with system or tools.");
    }
    this.settings = resolveAgentSettings(options);
    this.logger = options.logger ?? createNoopLogger();
    this.promptAssembly =
      options.promptAssembly ??
      createPromptAssembly({
        system: options.system === undefined ? [] : [{ name: "agent", content: options.system }],
        tools: options.tools === undefined ? [] : [{ name: "agent", tools: options.tools }],
      });
    this.codemode = options.codemode ?? "off";
    this.system = this.promptAssembly.initialSystem;
    this.callableTools = this.promptAssembly.initialTools;
    this.tools = this.modelTools(this.callableTools);
    this.steering = new SteeringQueue(options.inbox, this.logger);
    this.appendHistory(options.messages ?? []);
    this.toolResultPolicies = [
      ...(options.toolResultPolicy ? [options.toolResultPolicy] : []),
      ...(options.repeatedToolCalls?.reminderThresholds.length
        ? [createRepeatedToolCallPolicy(options.repeatedToolCalls)]
        : []),
    ];
    this.beforeToolExecution = options.beforeToolExecution;
    this.onRunCommitted = options.onRunCommitted;
    this.onCompactionCommitted = options.onCompactionCommitted;
    this.journal = options.journal;
    this.contextManager = options.context
      ? new ContextManager({ ...options.context, logger: this.logger })
      : undefined;
    // Assistant usage survives session replay inside committed messages, so
    // rebuild the provider anchor that keeps the next-request estimate stable
    // after resume instead of falling back to a full local estimate.
    this.contextManager?.rehydrateUsageAnchor(this.messages);
    this.stableContext = {
      system: this.system,
      messages: this.messages,
      contextCheckpoint: this.contextManager?.checkpoint,
    };
    this.logger.debug("agent.configured", {
      webSearch: this.settings.webSearch,
      imageInput: this.settings.imageInput,
      parallelToolCalls: this.settings.parallelToolCalls,
      maxParallelToolCalls: this.settings.maxParallelToolCalls,
      toolResultPolicySources: this.toolResultPolicies.map((policy) => policy.source),
    });
  }

  get state(): AgentState {
    return {
      model: this.settings.model,
      system: this.system,
      tools: this.tools,
      messages: this.messages,
      inbox: this.steering.snapshot,
      isRunning: this.activeRun !== undefined,
      streamingMessage: this.streamingMessage,
      pendingToolCalls: this.pendingToolCalls,
      error: this.error,
      contextLimit: this.contextManager?.contextLimit,
      contextCheckpoint: this.contextManager?.checkpoint,
    };
  }

  // Walks the full history, so callers request it only when they need a fresh estimate.
  estimateContextTokens(): number | undefined {
    return this.contextManager?.estimateContextTokens({
      system: this.system,
      messages: this.messages,
      tools: this.tools,
    });
  }

  getStableContext(): AgentStableContext {
    return {
      model: this.settings.model,
      imageInput: this.settings.imageInput,
      contextLimit: this.contextManager?.contextLimit,
      maxOutputTokens: this.contextManager?.maxOutputTokens,
      ...this.stableContext,
    };
  }

  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  get inbox(): AgentInboxSnapshot {
    return this.steering.snapshot;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeInbox(listener: AgentInboxListener): () => void {
    return this.steering.subscribe(listener);
  }

  async prompt(input: AgentPromptInput): Promise<void> {
    await this.stream(input).result();
  }

  stream(input: AgentPromptInput): AgentEventStream {
    const stream = new AgentEventStream();
    const promptMessages = toPromptMessages(input);
    try {
      if (this.activeRun) {
        throw new Error("Agent is already running.");
      }
      const { nextStep, nextTurn } = this.steering.snapshot;
      this.assertNewMessages([
        ...[...nextStep, ...nextTurn].map((item) => item.message),
        ...promptMessages,
      ]);
    } catch (error) {
      stream.error(error);
      return stream;
    }
    // The stream fails only after the run lifecycle has recorded the error and settled.
    void this.runWithLifecycle(
      (signal) => this.runPrompt(promptMessages, signal, stream),
      true,
    ).catch((error) => stream.error(error));
    return stream;
  }

  async compact(): Promise<ContextCheckpoint> {
    const contextManager = this.contextManager;
    if (!contextManager) {
      throw new Error("Context compaction is not configured.");
    }

    return this.runWithLifecycle(async (signal) => {
      const runContextManager = contextManager.fork();
      const prepared = await prepareWithCompaction(
        runContextManager,
        { system: this.system, messages: this.messages, tools: this.tools, signal },
        {
          signal,
          forceCompaction: true,
          compactionReason: "manual",
          // The checkpoint takes effect only after every persistence step succeeds.
          onCommitted: async (compaction) => {
            await this.journal?.appendCompaction({ compaction });
            await this.onCompactionCommitted?.({
              compaction,
              state: { ...this.state, contextCheckpoint: compaction },
            });
            contextManager.adopt(runContextManager);
            this.updateStableContext(this.system, this.messages);
          },
        },
        (event) => this.processEvent(event),
      );
      if (!prepared.compaction) {
        throw new Error("There is no complete context to compact.");
      }
      return prepared.compaction;
    });
  }

  abort(): void {
    this.activeRun?.abortController.abort();
  }

  steer(input: UserMessage): Promise<AgentSteerOutcome> {
    if (this.activeRun?.steeringEnabled !== true) {
      this.steering.enqueue(input, "next-turn", { kind: "steering" });
      return Promise.resolve("deferred");
    }
    return this.steering.steer(input);
  }

  enqueueInput(input: UserMessage, lane: AgentInputLane, delivery: AgentInputDelivery): void {
    this.steering.enqueue(input, lane, delivery);
  }

  shiftNextTurnInput(): AgentInboxItem | undefined {
    return this.steering.shiftNextTurn();
  }

  cancelInput(id: MessageId): AgentInboxItem | undefined {
    return this.steering.cancel(id);
  }

  clearInbox(): void {
    this.steering.clear();
  }

  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  reset(): void {
    if (this.activeRun) {
      throw new Error("Cannot reset Agent while it is running.");
    }
    this.messages = [];
    this.streamingMessage = undefined;
    this.pendingToolCalls = new Set();
    this.error = undefined;
    this.steering.clear();
    this.resetToolResultPolicies();
    this.contextManager?.reset();
    this.updateStableContext(this.system, this.messages);
  }

  private async runPrompt(
    promptMessages: readonly UserMessage[],
    signal: AbortSignal,
    stream: AgentEventStream,
  ): Promise<void> {
    const runId = randomUUID();
    const runContextManager = this.contextManager?.fork();
    let phase: RunPhase = "journal_start";
    // An open journal turn must be closed even when the run fails, unless the
    // journal itself failed and can no longer be written.
    let journalOpen = false;
    let done: AgentEndEvent | undefined;
    const writeJournal = async (write: () => Promise<void> | void): Promise<void> => {
      try {
        await write();
      } catch (error) {
        journalOpen = false;
        throw error;
      }
    };
    const commitMessage = async (message: Message): Promise<void> => {
      this.assertNewMessages([message]);
      await writeJournal(() => this.journal?.appendMessage({ runId, message }));
      this.appendHistory([message]);
    };

    try {
      // A run cannot begin model I/O until its prompt is durable. Later
      // messages use the same ordering before they enter Agent history.
      await writeJournal(() => this.journal?.startRun({ runId, messages: promptMessages }));
      journalOpen = true;
      this.appendHistory(promptMessages);
      this.updateStableContext(this.system, this.messages);
      this.resetToolResultPoliciesFor(promptMessages);
      this.logger.info("agent.run_started", { promptMessageCount: promptMessages.length });

      phase = "loop";
      await runAgentLoop(
        this.createContextSnapshot(),
        this.createLoopConfig(signal, runContextManager, {
          onMessageCommitted: commitMessage,
          onCompactionCommitted: async (compaction) => {
            // Adopt a checkpoint only after the session can recover it.
            await writeJournal(() => this.journal?.appendCompaction({ runId, compaction }));
            if (runContextManager) {
              this.contextManager?.adopt(runContextManager);
            }
          },
          consumeTurnInputs: async () => {
            const consumed = await this.steering.consume(commitMessage);
            this.resetToolResultPoliciesFor(consumed);
            return consumed;
          },
          onStableContext: (context) =>
            this.updateStableContext(context.system, context.messages, runContextManager),
        }),
        async (event) => {
          if (event.type === "agent_end") {
            done = event;
            if (runContextManager) {
              this.contextManager?.adopt(runContextManager);
            }
            this.reduceEvent(event);
            return;
          }
          await this.processEvent(event);
          stream.push(event);
        },
      );
      if (!done) {
        throw new Error("Agent loop finished without agent_end.");
      }
      const end = done;

      phase = "journal_end";
      await writeJournal(() => this.journal?.endRun({ runId, reason: end.reason }));
      journalOpen = false;

      phase = "commit";
      await this.onRunCommitted?.({
        messages: [...promptMessages, ...end.messages],
        compactions: runContextManager?.compactions ?? [],
        state: this.state,
        event: end,
      });

      phase = "publish";
      await this.publishEvent(end);
      stream.end(end);
    } catch (error) {
      if (journalOpen && !done) {
        phase = "journal_end";
        try {
          await this.journal?.endRun({ runId, reason: "error" });
        } catch (endError) {
          this.logger.error("agent.run_failed", { phase, error: endError });
        }
      }
      this.logger.error("agent.run_failed", { phase, error });
      throw error;
    }
  }

  private createLoopConfig(
    signal: AbortSignal,
    contextManager: ContextManager | undefined,
    hooks: Pick<
      AgentLoopConfig,
      "onMessageCommitted" | "onCompactionCommitted" | "consumeTurnInputs" | "onStableContext"
    >,
  ): AgentLoopConfig {
    return {
      settings: this.settings,
      signal,
      beforeToolExecution: this.beforeToolExecution,
      toolResultPolicies: this.toolResultPolicies,
      contextManager,
      logger: this.logger,
      assemblePrompt: async () => {
        try {
          const prompt = await this.promptAssembly.assemble({ signal });
          this.system = prompt.system;
          this.callableTools = prompt.tools;
          this.tools = this.modelTools(this.callableTools);
          return { ...prompt, tools: this.tools, callableTools: this.callableTools };
        } catch (error) {
          if (!signal.aborted) {
            this.logger.error("agent.prompt_assembly_failed", { ...errorFields(error) });
          }
          throw error;
        }
      },
      ...hooks,
    };
  }

  private async runWithLifecycle<T>(
    executor: (signal: AbortSignal) => Promise<T>,
    steeringEnabled = false,
  ): Promise<T> {
    if (this.activeRun) {
      throw new Error("Agent is already running.");
    }

    const abortController = new AbortController();
    let resolveRun!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    this.activeRun = { promise, abortController, steeringEnabled };
    this.streamingMessage = undefined;
    this.pendingToolCalls = new Set();
    this.error = undefined;

    try {
      return await executor(abortController.signal);
    } catch (error) {
      this.error = error;
      throw error;
    } finally {
      if (steeringEnabled) {
        this.steering.deferPending();
      }
      this.streamingMessage = undefined;
      this.pendingToolCalls = new Set();
      this.activeRun = undefined;
      resolveRun();
    }
  }

  private createContextSnapshot(): AgentContext {
    return {
      system: this.system,
      messages: this.messages,
      tools: this.tools,
      callableTools: this.callableTools,
    };
  }

  private modelTools(tools: readonly Tool[]): readonly Tool[] {
    if (this.codemode === "off") return tools;
    const runCode = createCodemodeTool({ tools, mode: this.codemode });
    return this.codemode === "mixed" ? [...tools, runCode] : [runCode];
  }

  private updateStableContext(
    system: string | undefined,
    messages: readonly Message[],
    contextManager = this.contextManager,
  ): void {
    this.stableContext = { system, messages, contextCheckpoint: contextManager?.checkpoint };
  }

  private assertNewMessages(messages: readonly Message[]): void {
    const ids = new Set<MessageId>(this.messages.map((message) => message.id));
    for (const message of messages) {
      if (ids.has(message.id)) {
        throw new Error(`Duplicate Message id in Agent history: ${message.id}`);
      }
      ids.add(message.id);
    }
  }

  private appendHistory(messages: readonly Message[]): void {
    this.assertNewMessages(messages);
    this.messages = [...this.messages, ...messages];
  }

  private resetToolResultPoliciesFor(messages: readonly UserMessage[]): void {
    if (messages.some(isHumanAuthoredInput)) {
      this.resetToolResultPolicies();
    }
  }

  private resetToolResultPolicies(): void {
    for (const policy of this.toolResultPolicies) {
      try {
        policy.reset?.();
      } catch (error) {
        this.logger.warn("tool.result_policy_reset_failed", {
          policySource: policy.source,
          ...errorFields(error),
        });
      }
    }
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    this.reduceEvent(event);
    await this.publishEvent(event);
  }

  private async publishEvent(event: AgentEvent): Promise<void> {
    logAgentEvent(this.logger, event);
    // Events are only produced while a run is active.
    const { signal } = this.activeRun!.abortController;
    for (const listener of [...this.listeners]) {
      try {
        await listener(event, signal);
      } catch (error) {
        this.logger.warn("agent.listener_failed", { eventType: event.type, error });
      }
    }
  }

  private reduceEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.streamingMessage = event.message;
        break;
      case "message_end":
      case "agent_end":
        this.streamingMessage = undefined;
        break;
      case "tool_execution_start":
        this.pendingToolCalls = new Set([...this.pendingToolCalls, event.toolCallId]);
        break;
      case "tool_execution_end": {
        const pending = new Set(this.pendingToolCalls);
        pending.delete(event.toolCallId);
        this.pendingToolCalls = pending;
        break;
      }
    }
  }
}

function toPromptMessages(input: AgentPromptInput): readonly UserMessage[] {
  if (typeof input === "string") {
    return [createUserMessage({ content: input, provenance: { kind: "user_input" } })];
  }
  return "role" in input ? [input] : input;
}

function isHumanAuthoredInput(message: UserMessage): boolean {
  return (
    message.provenance.kind === "user_input" ||
    (message.provenance.kind === "scheduled_input" && message.provenance.origin === "user")
  );
}
