import type { AssistantMessage, Message, Model, UserMessage } from "@/core";
import { createNoopLogger, type Logger, type LogMetadata } from "@/logging";
import type { Tool } from "@/tools";
import {
  type ContextCheckpoint,
  ContextManager,
  type ContextManagerConfig,
} from "./context-manager";
import type { AgentEvent } from "./events";
import {
  type AgentContext,
  type AgentLoopConfig,
  assertValidMaxTurns,
  type BeforeToolExecutionHook,
  runAgentLoop,
} from "./loop";
import { AgentEventStream } from "./stream";

export type AgentPromptInput = string | UserMessage | UserMessage[];

export type AgentConfig = {
  model: Model;
  system?: string;
  messages?: Message[];
  tools?: Tool[];
  // Prevent accidental infinite tool loops while keeping the first version
  // free of custom stop hooks. Use -1 to run without a turn limit.
  maxTurns?: number;
  beforeToolExecution?: BeforeToolExecutionHook;
  onRunCommitted?: AgentRunCommittedHook;
  logger?: Logger;
  loggerMetadata?: LogMetadata;
  context?: Omit<ContextManagerConfig, "logger" | "loggerMetadata">;
};

export type AgentState = {
  model: Model;
  system?: string;
  maxTurns?: number;
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
  private readonly logger: Logger;
  private readonly loggerMetadata?: LogMetadata;
  private readonly contextManager?: ContextManager;

  constructor(options: AgentConfig) {
    assertValidMaxTurns(options.maxTurns);
    this.logger = options.logger ?? createNoopLogger();
    this.loggerMetadata = options.loggerMetadata;
    this.stateData = createWritableAgentState(options);
    this.beforeToolExecution = options.beforeToolExecution;
    this.onRunCommitted = options.onRunCommitted;
    this.contextManager = options.context
      ? new ContextManager({
          ...options.context,
          logger: this.logger,
          loggerMetadata: this.loggerMetadata,
        })
      : undefined;
  }

  get state(): AgentState {
    return {
      model: this.stateData.model,
      system: this.stateData.system,
      maxTurns: this.stateData.maxTurns,
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

  stream(input: AgentPromptInput): AgentEventStream {
    const stream = new AgentEventStream();
    let doneEvent: Extract<AgentEvent, { type: "agent_end" }> | undefined;
    let committedCompactions: ContextCheckpoint[] = [];
    let phase: "loop" | "commit" | "publish" = "loop";

    if (this.activeRun) {
      stream.error(new Error("Agent is already running."));
      return stream;
    }

    // User input is caller-owned state, so make it visible immediately. The
    // loop result only contains messages produced by the agent runtime.
    const promptMessages = toPromptMessages(input);
    this.stateData.messages = [...this.stateData.messages, ...promptMessages];
    this.log("info", "agent.run_started", { promptMessageCount: promptMessages.length });
    const runContextManager = this.contextManager?.fork();

    void this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        this.createContextSnapshot(),
        this.createLoopConfig(signal, runContextManager),
        async (event) => {
          if (event.type === "agent_end") {
            doneEvent = structuredClone(event);
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

      phase = "commit";
      await this.onRunCommitted?.({
        messages: structuredClone([...promptMessages, ...doneEvent.messages]),
        compactions: structuredClone(committedCompactions),
        state: this.state,
        event: structuredClone(doneEvent),
      });

      phase = "publish";
      await this.publishEvent(doneEvent);
      stream.end(structuredClone(doneEvent));
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
  ): AgentLoopConfig {
    return {
      model: this.stateData.model,
      maxTurns: this.stateData.maxTurns,
      signal,
      beforeToolExecution: this.beforeToolExecution,
      contextManager,
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
        this.stateData.messages = [...this.stateData.messages, ...structuredClone(event.messages)];
        this.stateData.streamingMessage = undefined;
        break;
    }
  }
}

function createWritableAgentState(options: AgentConfig): WritableAgentState {
  let tools = options.tools?.slice() ?? [];
  let messages = structuredClone(options.messages ?? []);

  return {
    model: options.model,
    system: options.system,
    maxTurns: options.maxTurns,
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
