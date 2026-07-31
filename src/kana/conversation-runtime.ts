import type { Agent, AgentEvent, BeforeToolExecutionHook, ContextCheckpoint } from "@/agent";
import type { Message, UserMessage } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaSessionMetadata, KanaSessionTimelineEntry } from "./session";
import { createWakeScheduler, type WakeEvent, type WakeScheduler } from "./wake-scheduler";

export type ConversationSessionSnapshot = {
  id: string;
  messages: Message[];
  timeline: KanaSessionTimelineEntry[];
  contextCheckpoint?: ContextCheckpoint;
};

export type ConversationRunSource = "user" | "scheduled" | "compaction";

export type ConversationRuntimeEvent =
  | {
      type: "run_start";
      source: ConversationRunSource;
      input?: UserMessage;
    }
  | {
      type: "agent_event";
      source: ConversationRunSource;
      event: AgentEvent;
    }
  | {
      type: "run_end";
      source: ConversationRunSource;
      event?: Extract<AgentEvent, { type: "agent_end" }>;
    }
  | {
      type: "run_error";
      source: ConversationRunSource;
      error: unknown;
    }
  | {
      type: "session_changed";
      action: "new" | "fork" | "resume";
      session: ConversationSessionSnapshot;
    };

export type ConversationRuntimeListener = (event: ConversationRuntimeEvent) => void;

export type CreateConversationAgentOptions<TConfiguration> = {
  beforeToolExecution: BeforeToolExecutionHook;
  messages?: Message[];
  sessionId?: string;
  contextCheckpoint?: ContextCheckpoint;
  configuration?: TConfiguration;
};

export type ConversationRuntimeOptions<TConfiguration> = {
  initialSession?: ConversationSessionSnapshot;
  createAgent: (options: CreateConversationAgentOptions<TConfiguration>) => Agent;
  createNewSession: () => { id: string };
  forkSession: (
    messages: Message[],
    contextCheckpoint: ContextCheckpoint | undefined,
    prompt: string,
  ) => { id: string };
  loadSession: (sessionId: string) => ConversationSessionSnapshot;
  listSessions?: () => KanaSessionMetadata[];
  deleteSession?: (sessionId: string) => boolean;
  wakeScheduler?: WakeScheduler;
  scheduledRuns?: boolean;
  canStartScheduledRun?: () => boolean;
  getLogger?: () => Logger;
};

export class ConversationRuntime<TConfiguration = never> {
  private readonly listeners = new Set<ConversationRuntimeListener>();
  private readonly wakeScheduler: WakeScheduler;
  private readonly unsubscribeWakeEvents: () => void;
  private readonly pendingWakeEvents: WakeEvent[] = [];
  private readonly getLogger: () => Logger;
  private agent: Agent;
  private sessionData?: ConversationSessionSnapshot;
  private beforeToolExecution?: BeforeToolExecutionHook;
  private activeSource?: ConversationRunSource;
  private terminalEvent?: Extract<AgentEvent, { type: "agent_end" }>;
  private drainingWakeEvents = false;
  private stopping = false;

  constructor(private readonly options: ConversationRuntimeOptions<TConfiguration>) {
    this.sessionData = cloneSession(options.initialSession);
    this.getLogger = options.getLogger ?? createNoopLogger;
    this.wakeScheduler = options.wakeScheduler ?? createWakeScheduler();
    this.agent = this.buildAgent(this.sessionData?.messages, this.sessionData?.contextCheckpoint);
    this.unsubscribeWakeEvents = this.wakeScheduler.subscribe((event) => {
      this.queueWakeEvent(event);
    });
  }

  get state(): Agent["state"] {
    return this.agent.state;
  }

  get sessionId(): string | undefined {
    return this.sessionData?.id;
  }

  get session(): ConversationSessionSnapshot | undefined {
    const session = cloneSession(this.sessionData);
    if (!session) {
      return undefined;
    }

    const state = this.agent.state;
    return {
      ...session,
      messages: state.messages,
      contextCheckpoint: state.contextCheckpoint,
    };
  }

  get isRunning(): boolean {
    return this.activeSource !== undefined || this.agent.state.isRunning;
  }

  setBeforeToolExecution(hook: BeforeToolExecutionHook): void {
    this.beforeToolExecution = hook;
  }

  subscribe(listener: ConversationRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async submit(input: UserMessage, source: "user" | "scheduled" = "user"): Promise<void> {
    this.assertCanStartRun();
    this.activeSource = source;
    this.terminalEvent = undefined;
    this.emit({
      type: "run_start",
      source,
      input: structuredClone(input),
    });
    this.log("info", "conversation.run_started", { source });

    try {
      const stream = this.agent.stream(input);
      for await (const event of stream) {
        this.handleAgentEvent(event);
      }
      await stream.result();

      const terminalEvent = this.readTerminalEvent();
      if (!terminalEvent) {
        throw new Error("Conversation run finished without an agent_end event.");
      }
      this.emit({
        type: "run_end",
        source,
        event: structuredClone(terminalEvent),
      });
      this.log("info", "conversation.run_completed", {
        source,
        outcome: terminalEvent.reason,
      });
    } catch (error) {
      this.emit({ type: "run_error", source, error });
      this.log("error", "conversation.run_failed", { source, error });
      throw error;
    } finally {
      this.activeSource = undefined;
      this.terminalEvent = undefined;
      void this.drainScheduledRuns();
    }
  }

  async compact(): Promise<ContextCheckpoint> {
    this.assertCanStartRun();
    this.activeSource = "compaction";
    this.emit({ type: "run_start", source: "compaction" });
    this.log("info", "conversation.compaction_started");
    const unsubscribe = this.agent.subscribe((event) => {
      this.handleAgentEvent(event);
    });

    try {
      const checkpoint = await this.agent.compact();
      this.emit({ type: "run_end", source: "compaction" });
      this.log("info", "conversation.compaction_completed");
      return checkpoint;
    } catch (error) {
      this.emit({ type: "run_error", source: "compaction", error });
      this.log("error", "conversation.compaction_failed", { error });
      throw error;
    } finally {
      unsubscribe();
      this.activeSource = undefined;
      void this.drainScheduledRuns();
    }
  }

  reconfigure(configuration?: TConfiguration): void {
    this.assertIdle("reconfigure the conversation");
    this.replaceAgent(this.agent.state.messages, this.agent.state.contextCheckpoint, configuration);
    this.log("info", "conversation.agent_reconfigured");
  }

  startNewSession(): ConversationSessionSnapshot {
    this.assertIdle("start a new session");
    const created = this.options.createNewSession();
    this.cancelCurrentSessionWakeEvents();
    const session: ConversationSessionSnapshot = {
      id: created.id,
      messages: [],
      timeline: [],
    };
    this.replaceSession("new", session);
    return this.session as ConversationSessionSnapshot;
  }

  forkSession(prompt: string): ConversationSessionSnapshot {
    this.assertIdle("fork the session");
    const state = this.agent.state;
    const created = this.options.forkSession(state.messages, state.contextCheckpoint, prompt);
    this.cancelCurrentSessionWakeEvents();
    const session: ConversationSessionSnapshot = {
      id: created.id,
      messages: state.messages,
      timeline: [],
      contextCheckpoint: state.contextCheckpoint,
    };
    this.replaceSession("fork", session);
    return this.session as ConversationSessionSnapshot;
  }

  resumeSession(sessionId: string): ConversationSessionSnapshot {
    this.assertIdle("resume a session");
    const session = this.options.loadSession(sessionId);
    this.cancelCurrentSessionWakeEvents();
    this.replaceSession("resume", session);
    return this.session as ConversationSessionSnapshot;
  }

  listSessions(): KanaSessionMetadata[] {
    const currentSessionId = this.sessionId;
    return (this.options.listSessions?.() ?? []).filter(
      (session) => session.id !== currentSessionId,
    );
  }

  deleteSession(sessionId: string): boolean {
    if (sessionId === this.sessionId) {
      return false;
    }
    return this.options.deleteSession?.(sessionId) ?? false;
  }

  abort(): void {
    this.agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  notifyCanStartScheduledRun(): void {
    void this.drainScheduledRuns();
  }

  async close(): Promise<void> {
    if (this.stopping) {
      await this.agent.waitForIdle();
      return;
    }

    this.stopping = true;
    this.unsubscribeWakeEvents();
    this.pendingWakeEvents.length = 0;
    this.agent.abort();
    await this.agent.waitForIdle();
    this.wakeScheduler.dispose();
    this.listeners.clear();
    this.log("info", "conversation.closed");
  }

  private buildAgent(
    messages?: Message[],
    contextCheckpoint?: ContextCheckpoint,
    configuration?: TConfiguration,
    sessionId = this.sessionData?.id,
  ): Agent {
    return this.options.createAgent({
      beforeToolExecution: (request) =>
        this.beforeToolExecution?.(request) ?? {
          type: "cancel",
          abortRun: true,
          message: "Tool approval is unavailable.",
        },
      messages,
      sessionId,
      contextCheckpoint,
      configuration,
    });
  }

  private replaceAgent(
    messages?: Message[],
    contextCheckpoint?: ContextCheckpoint,
    configuration?: TConfiguration,
  ): void {
    const previousAgent = this.agent;
    const nextAgent = this.buildAgent(messages, contextCheckpoint, configuration);

    this.agent = nextAgent;
    previousAgent.abort();
  }

  private replaceSession(
    action: Extract<ConversationRuntimeEvent, { type: "session_changed" }>["action"],
    session: ConversationSessionSnapshot,
  ): void {
    // Build against the candidate session before mutating runtime state. A
    // provider/configuration failure must leave the current Agent usable.
    const nextSession = cloneSession(session) as ConversationSessionSnapshot;
    const nextAgent = this.buildAgent(
      nextSession.messages,
      nextSession.contextCheckpoint,
      undefined,
      nextSession.id,
    );
    const previousAgent = this.agent;
    this.sessionData = nextSession;
    this.agent = nextAgent;
    previousAgent.abort();
    this.emit({
      type: "session_changed",
      action,
      session: this.session as ConversationSessionSnapshot,
    });
    this.log("info", "conversation.session_changed", { action });
  }

  private handleAgentEvent(event: AgentEvent): void {
    const source = this.activeSource;
    if (!source) {
      return;
    }
    if (event.type === "agent_end") {
      this.terminalEvent = structuredClone(event);
    }
    this.emit({
      type: "agent_event",
      source,
      event: structuredClone(event),
    });
  }

  private readTerminalEvent(): Extract<AgentEvent, { type: "agent_end" }> | undefined {
    return this.terminalEvent;
  }

  private queueWakeEvent(event: WakeEvent): void {
    if (
      this.stopping ||
      this.options.scheduledRuns === false ||
      event.sessionId !== this.sessionId
    ) {
      return;
    }

    this.pendingWakeEvents.push(structuredClone(event));
    void this.drainScheduledRuns();
  }

  private async drainScheduledRuns(): Promise<void> {
    if (
      this.stopping ||
      this.options.scheduledRuns === false ||
      this.drainingWakeEvents ||
      this.isRunning ||
      this.options.canStartScheduledRun?.() === false
    ) {
      return;
    }

    this.drainingWakeEvents = true;
    try {
      while (!this.stopping && !this.isRunning && this.options.canStartScheduledRun?.() !== false) {
        const event = this.pendingWakeEvents.shift();
        if (!event) {
          return;
        }
        if (event.sessionId !== this.sessionId) {
          continue;
        }

        await this.submit(
          {
            role: "user",
            content: ["[Scheduled wake event]", event.message].join("\n"),
            source: "scheduled",
          },
          "scheduled",
        ).catch(() => {
          // run_error already carries the failure to the active frontend.
        });
      }
    } finally {
      this.drainingWakeEvents = false;
    }
  }

  private cancelCurrentSessionWakeEvents(): void {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return;
    }

    this.wakeScheduler.cancelSession(sessionId);
    for (let index = this.pendingWakeEvents.length - 1; index >= 0; index -= 1) {
      if (this.pendingWakeEvents[index]?.sessionId === sessionId) {
        this.pendingWakeEvents.splice(index, 1);
      }
    }
  }

  private assertCanStartRun(): void {
    if (this.stopping) {
      throw new Error("Conversation runtime is stopping.");
    }
    this.assertIdle("start another run");
  }

  private assertIdle(operation: string): void {
    if (this.isRunning) {
      throw new Error(`Cannot ${operation} while a conversation run is active.`);
    }
  }

  private emit(event: ConversationRuntimeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(cloneRuntimeEvent(event));
      } catch (error) {
        this.log("warn", "conversation.listener_failed", {
          eventType: event.type,
          error,
        });
      }
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    metadata?: Record<string, unknown>,
  ): void {
    try {
      this.getLogger()[level](event, metadata);
    } catch {
      // Diagnostics must not change runtime lifecycle or cleanup behavior.
    }
  }
}

function cloneSession(
  session: ConversationSessionSnapshot | undefined,
): ConversationSessionSnapshot | undefined {
  return session === undefined ? undefined : structuredClone(session);
}

function cloneRuntimeEvent(event: ConversationRuntimeEvent): ConversationRuntimeEvent {
  if (event.type === "run_error") {
    return { ...event };
  }
  return structuredClone(event);
}
