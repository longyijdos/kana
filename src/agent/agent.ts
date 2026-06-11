import type { AssistantMessage, Message, Model, UserMessage } from "@/core";
import type { Tool } from "@/tools";
import {
  runAgentLoop,
  type AgentContext,
  type AgentLoopConfig,
  type BeforeToolExecutionHook,
} from "./loop";
import type { AgentEvent } from "./events";
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
};

type WritableAgentState = Omit<
  AgentState,
  "isRunning" | "streamingMessage" | "pendingToolCalls" | "error"
> & {
  isRunning: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: Set<string>;
  error?: unknown;
};

export type AgentEventListener = (
  event: AgentEvent,
  signal: AbortSignal,
) => Promise<void> | void;

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

  constructor(options: AgentConfig) {
    this.stateData = createWritableAgentState(options);
    this.beforeToolExecution = options.beforeToolExecution;
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

    if (this.activeRun) {
      stream.error(new Error("Agent is already running."));
      return stream;
    }

    // User input is caller-owned state, so make it visible immediately. The
    // loop result only contains messages produced by the agent runtime.
    const promptMessages = toPromptMessages(input);
    this.stateData.messages = [...this.stateData.messages, ...promptMessages];

    void this.runWithLifecycle((signal) =>
      runAgentLoop(
        this.createContextSnapshot(),
        this.createLoopConfig(signal),
        async (event) => {
          await this.processEvent(event);

          if (event.type === "agent_end") {
            doneEvent = event;
            return;
          }

          stream.push(event);
        },
      ),
    )
      .then(() => {
        if (!doneEvent) {
          stream.error(new Error("Agent loop finished without agent_end."));
          return;
        }

        stream.end(doneEvent);
      })
      .catch((error) => {
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
    this.stateData.messages = [];
    this.stateData.isRunning = false;
    this.stateData.streamingMessage = undefined;
    this.stateData.pendingToolCalls = new Set<string>();
    this.stateData.error = undefined;
  }

  private createContextSnapshot(): AgentContext {
    return {
      system: this.stateData.system,
      messages: structuredClone(this.stateData.messages),
      tools: this.stateData.tools.slice(),
    };
  }

  private createLoopConfig(signal: AbortSignal): AgentLoopConfig {
    return {
      model: this.stateData.model,
      maxTurns: this.stateData.maxTurns,
      signal,
      beforeToolExecution: this.beforeToolExecution,
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

    const signal = this.activeRun?.abortController.signal;

    if (!signal) {
      throw new Error("Agent event processed outside an active run.");
    }

    for (const listener of this.listeners) {
      await listener(event, signal);
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
        this.stateData.messages = [
          ...this.stateData.messages,
          ...event.messages,
        ];
        this.stateData.streamingMessage = undefined;
        break;
    }
  }
}

function createWritableAgentState(options: AgentConfig): WritableAgentState {
  let tools = options.tools?.slice() ?? [];
  let messages = options.messages?.slice() ?? [];

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
