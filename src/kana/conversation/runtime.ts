import type {
  Agent,
  AgentEvent,
  AgentInboxSnapshot,
  BeforeToolExecutionHook,
  ContextCheckpoint,
} from "@/agent";
import type { Message, MessageId, UserMessage } from "@/core";
import type { BackgroundJobClient } from "@/jobs";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaSessionMetadata, KanaSessionTimelineEntry } from "../session";
import type { KanaTodoItem, KanaTodoStateChange } from "../todo";
import type { KanaGoalSnapshot, KanaGoalUpdate } from "./goal-controller";
import {
  ConversationInputCoordinator,
  type ConversationInputDisposition,
  type ConversationInputQueueSnapshot,
  type ConversationInputRunRequest,
  type ConversationInputRunResult,
  type ConversationInputRunSource,
  type ConversationScheduledInputCancellation,
} from "./input-coordinator";
import { createWakeScheduler, type WakeEvent, type WakeScheduler } from "./wake-scheduler";

export type {
  ConversationInputDisposition,
  ConversationInputQueueSnapshot,
  ConversationScheduledInputCancellation,
} from "./input-coordinator";

export type ConversationSessionSnapshot = {
  id: string;
  messages: Message[];
  timeline: KanaSessionTimelineEntry[];
  todoState?: KanaTodoItem[];
  contextCheckpoint?: ContextCheckpoint;
};

export type ConversationRunSource = ConversationInputRunSource | "compaction";

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
      goal?: KanaGoalSnapshot;
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
    }
  | {
      type: "input_queue_changed";
      queue: ConversationInputQueueSnapshot;
    }
  | {
      type: "todo_state_changed";
      source: ConversationRunSource;
      change: KanaTodoStateChange;
    }
  | {
      type: "goal_state_changed";
      change:
        | "started"
        | "round_admitted"
        | "completed"
        | "blocked"
        | "cancelled"
        | "round_limit"
        | "discarded";
      goal: KanaGoalSnapshot;
    };

export type ConversationRuntimeListener = (event: ConversationRuntimeEvent) => void;

type CreateConversationAgentOptions<TConfiguration> = {
  beforeToolExecution: BeforeToolExecutionHook;
  messages?: Message[];
  inbox?: AgentInboxSnapshot;
  sessionId?: string;
  contextCheckpoint?: ContextCheckpoint;
  configuration?: TConfiguration;
  onTodoStateCommitted: (change: KanaTodoStateChange) => void;
  resolveGoal: () => KanaGoalSnapshot | undefined;
  updateGoal: (change: KanaGoalUpdate) => KanaGoalSnapshot;
};

export type ConversationRuntimeOptions<TConfiguration> = {
  initialSession?: ConversationSessionSnapshot;
  createAgent: (options: CreateConversationAgentOptions<TConfiguration>) => Agent;
  createNewSession: () => { id: string };
  forkSession: (
    messages: Message[],
    contextCheckpoint: ContextCheckpoint | undefined,
    prompt: string,
  ) => { id: string; todoState?: KanaTodoItem[] };
  loadSession: (sessionId: string) => ConversationSessionSnapshot;
  listSessions?: () => KanaSessionMetadata[];
  deleteSession?: (sessionId: string) => Promise<boolean> | boolean;
  getBackgroundJobs?: (sessionId: string) => BackgroundJobClient | undefined;
  disposeSession?: (
    sessionId: string,
    source: "session_disposal" | "shutdown",
    foregroundSettled: Promise<void>,
  ) => Promise<void>;
  backgroundJobCompletionRuns?: boolean;
  wakeScheduler?: WakeScheduler;
  scheduledRuns?: boolean;
  canStartQueuedRun?: () => boolean;
  goalMaxRounds: number;
  getLogger?: () => Logger;
};

export class ConversationRuntime<TConfiguration = never> {
  private readonly listeners = new Set<ConversationRuntimeListener>();
  private readonly getLogger: () => Logger;
  private readonly inputCoordinator: ConversationInputCoordinator;
  private agent: Agent;
  private sessionData?: ConversationSessionSnapshot;
  private beforeToolExecution?: BeforeToolExecutionHook;
  private activeSource?: ConversationRunSource;
  private activeRunGoalId?: string;
  private terminalEvent?: Extract<AgentEvent, { type: "agent_end" }>;
  private changingSession = false;
  private stopping = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: ConversationRuntimeOptions<TConfiguration>) {
    this.sessionData = cloneSession(options.initialSession);
    this.getLogger = options.getLogger ?? createNoopLogger;
    this.inputCoordinator = new ConversationInputCoordinator({
      wakeScheduler: options.wakeScheduler ?? createWakeScheduler(),
      goalMaxRounds: options.goalMaxRounds,
      scheduledRuns: options.scheduledRuns,
      backgroundJobCompletionRuns: options.backgroundJobCompletionRuns,
      getBackgroundJobs: options.getBackgroundJobs,
      isRunActive: () => this.isRunning,
      canSteer: () => this.canSteer,
      canStartQueuedRun: options.canStartQueuedRun,
      requestRun: (request) => this.executeRun(request),
      onQueueChanged: (queue) => {
        this.emit({ type: "input_queue_changed", queue });
      },
      onGoalChanged: (change, goal) => {
        this.emit({
          type: "goal_state_changed",
          change,
          goal: structuredClone(goal),
        });
      },
      getLogger: this.getLogger,
    });
    this.agent = this.buildAgent(this.sessionData?.messages, this.sessionData?.contextCheckpoint);
    this.inputCoordinator.initialize(this.agent, this.sessionData?.id);
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

  get todoState(): KanaTodoItem[] {
    return structuredClone(this.sessionData?.todoState ?? []);
  }

  get goal(): KanaGoalSnapshot | undefined {
    return this.inputCoordinator.goal;
  }

  get isRunning(): boolean {
    return this.changingSession || this.activeSource !== undefined || this.agent.state.isRunning;
  }

  get canSteer(): boolean {
    return (
      this.activeSource !== undefined &&
      this.activeSource !== "compaction" &&
      this.agent.state.isRunning
    );
  }

  get inputQueue(): ConversationInputQueueSnapshot {
    return this.inputCoordinator.queue;
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

  async submit(
    input: UserMessage,
    source: Exclude<ConversationRunSource, "compaction"> = "user",
  ): Promise<void> {
    this.assertCanStartRun();
    const result = await this.inputCoordinator.submit(input, source);
    if (result.type === "failed") {
      throw result.error;
    }
  }

  async startGoal(objective: string): Promise<KanaGoalSnapshot> {
    this.assertCanStartRun();
    const { goal, input } = this.inputCoordinator.startGoal(objective);
    await this.submit(input, "goal");
    return this.inputCoordinator.goal ?? goal;
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
      this.inputCoordinator.notifyRunSettled();
    }
  }

  reconfigure(configuration?: TConfiguration): void {
    this.assertIdle("reconfigure the conversation");
    this.replaceAgent(this.agent.state.messages, this.agent.state.contextCheckpoint, configuration);
    this.inputCoordinator.discardGoal("agent_reconfigured");
    this.log("info", "conversation.agent_reconfigured");
  }

  async startNewSession(): Promise<ConversationSessionSnapshot> {
    this.assertIdle("start a new session");
    const created = this.options.createNewSession();
    const session: ConversationSessionSnapshot = {
      id: created.id,
      messages: [],
      timeline: [],
      todoState: [],
    };
    await this.replaceSession("new", session);
    return this.session as ConversationSessionSnapshot;
  }

  async forkSession(prompt: string): Promise<ConversationSessionSnapshot> {
    this.assertIdle("fork the session");
    const state = this.agent.state;
    const created = this.options.forkSession(state.messages, state.contextCheckpoint, prompt);
    const session: ConversationSessionSnapshot = {
      id: created.id,
      messages: state.messages,
      timeline: [],
      todoState: structuredClone(created.todoState ?? this.sessionData?.todoState ?? []),
      contextCheckpoint: state.contextCheckpoint,
    };
    await this.replaceSession("fork", session);
    return this.session as ConversationSessionSnapshot;
  }

  async resumeSession(sessionId: string): Promise<ConversationSessionSnapshot> {
    this.assertIdle("resume a session");
    const session = this.options.loadSession(sessionId);
    await this.replaceSession("resume", session);
    return this.session as ConversationSessionSnapshot;
  }

  listSessions(): KanaSessionMetadata[] {
    const currentSessionId = this.sessionId;
    return (this.options.listSessions?.() ?? []).filter(
      (session) => session.id !== currentSessionId,
    );
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (sessionId === this.sessionId) {
      return false;
    }
    return (await this.options.deleteSession?.(sessionId)) ?? false;
  }

  abort(): void {
    this.inputCoordinator.cancelGoal();
    this.agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  notifyCanStartQueuedRun(): void {
    this.inputCoordinator.notifyCanStartRun();
  }

  queueInput(input: UserMessage): MessageId {
    return this.inputCoordinator.queueInput(input);
  }

  scheduleInput(afterMinutes: number, message: string): WakeEvent {
    return this.inputCoordinator.scheduleInput(afterMinutes, message);
  }

  cancelScheduledInput(id: string): ConversationScheduledInputCancellation {
    return this.inputCoordinator.cancelScheduledInput(id);
  }

  async steer(input: UserMessage): Promise<ConversationInputDisposition> {
    return this.inputCoordinator.steer(input);
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal();
    }
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.stopping = true;
    const backgroundJobs = this.inputCoordinator.backgroundJobClient;
    this.inputCoordinator.prepareForShutdown();
    this.agent.abort();
    await this.disposeHostedSession(
      this.sessionData?.id,
      "shutdown",
      this.agent.waitForIdle(),
      backgroundJobs,
    );
    this.inputCoordinator.finishShutdown();
    this.listeners.clear();
    this.log("info", "conversation.closed");
  }

  private buildAgent(
    messages?: Message[],
    contextCheckpoint?: ContextCheckpoint,
    configuration?: TConfiguration,
    sessionId = this.sessionData?.id,
    inbox?: AgentInboxSnapshot,
  ): Agent {
    return this.options.createAgent({
      beforeToolExecution: (request) =>
        this.beforeToolExecution?.(request) ?? {
          type: "cancel",
          abortRun: true,
          message: "Tool approval is unavailable.",
        },
      messages,
      inbox,
      sessionId,
      contextCheckpoint,
      configuration,
      onTodoStateCommitted: (change) => this.handleTodoStateCommitted(sessionId, change),
      resolveGoal: () => this.inputCoordinator.resolveGoal(this.activeRunGoalId),
      updateGoal: (change) => this.inputCoordinator.updateGoal(change),
    });
  }

  private handleTodoStateCommitted(
    sessionId: string | undefined,
    change: KanaTodoStateChange,
  ): void {
    const source = this.activeSource;
    if (!source || !this.sessionData || sessionId !== this.sessionData.id) {
      return;
    }

    this.sessionData.todoState = structuredClone(change.items);
    this.emit({
      type: "todo_state_changed",
      source,
      change: structuredClone(change),
    });
  }

  private replaceAgent(
    messages?: Message[],
    contextCheckpoint?: ContextCheckpoint,
    configuration?: TConfiguration,
  ): void {
    const previousAgent = this.agent;
    const nextAgent = this.buildAgent(
      messages,
      contextCheckpoint,
      configuration,
      this.sessionData?.id,
      this.agent.inbox,
    );

    this.agent = nextAgent;
    this.inputCoordinator.replaceAgent(nextAgent);
    previousAgent.abort();
  }

  private async replaceSession(
    action: Extract<ConversationRuntimeEvent, { type: "session_changed" }>["action"],
    session: ConversationSessionSnapshot,
  ): Promise<void> {
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
    const previousJobs = this.inputCoordinator.backgroundJobClient;
    const previousSessionId = this.sessionData?.id;
    this.changingSession = true;
    this.inputCoordinator.beginSessionChange();
    try {
      await this.disposeHostedSession(
        previousSessionId,
        "session_disposal",
        previousAgent.waitForIdle(),
        previousJobs,
      );
    } catch (error) {
      this.inputCoordinator.cancelSessionChange();
      throw error;
    } finally {
      this.changingSession = false;
    }
    if (this.stopping) {
      nextAgent.abort();
      await this.disposeHostedSession(
        nextSession.id,
        "shutdown",
        nextAgent.waitForIdle(),
        this.options.getBackgroundJobs?.(nextSession.id),
      );
      throw new Error("Conversation runtime stopped while changing sessions.");
    }
    this.inputCoordinator.cancelCurrentSessionInputs();
    this.sessionData = nextSession;
    this.agent = nextAgent;
    this.inputCoordinator.adoptSession(nextAgent, nextSession.id);
    previousAgent.abort();
    this.emit({
      type: "session_changed",
      action,
      session: this.session as ConversationSessionSnapshot,
    });
    this.inputCoordinator.emitCurrentQueue();
    this.log("info", "conversation.session_changed", { action });
  }

  private async disposeHostedSession(
    sessionId: string | undefined,
    source: "session_disposal" | "shutdown",
    foregroundSettled: Promise<void>,
    backgroundJobs: BackgroundJobClient | undefined,
  ): Promise<void> {
    if (sessionId !== undefined && this.options.disposeSession) {
      await this.options.disposeSession(sessionId, source, foregroundSettled);
      return;
    }
    await Promise.all([foregroundSettled, backgroundJobs?.close(source) ?? Promise.resolve()]);
  }

  private async executeRun(
    request: ConversationInputRunRequest,
  ): Promise<ConversationInputRunResult> {
    const { source, input, prompt } = request;
    this.assertCanStartRun();
    this.activeSource = source;
    this.activeRunGoalId = this.inputCoordinator.activeGoal?.id;
    this.terminalEvent = undefined;
    this.emit({
      type: "run_start",
      source,
      input: structuredClone(input),
    });
    this.log("info", "conversation.run_started", { source });

    try {
      const stream = this.agent.stream(prompt);
      for await (const event of stream) {
        this.handleAgentEvent(event);
      }
      await stream.result();

      const terminalEvent = this.readTerminalEvent();
      if (!terminalEvent) {
        throw new Error("Conversation run finished without an agent_end event.");
      }
      if (
        source === "goal" &&
        (terminalEvent.reason === "error" || terminalEvent.reason === "aborted")
      ) {
        this.inputCoordinator.blockGoal(`The goal run ended with ${terminalEvent.reason}.`);
      }
      const runGoal = this.inputCoordinator.goalForRun(this.activeRunGoalId);
      this.emit({
        type: "run_end",
        source,
        event: structuredClone(terminalEvent),
        ...(runGoal === undefined ? {} : { goal: runGoal }),
      });
      this.log("info", "conversation.run_completed", {
        source,
        outcome: terminalEvent.reason,
      });
      return { type: "completed", event: structuredClone(terminalEvent) };
    } catch (error) {
      if (source === "goal") {
        this.inputCoordinator.blockGoal("The goal run failed before it could continue.");
      }
      this.emit({ type: "run_error", source, error });
      this.log("error", "conversation.run_failed", { source, error });
      return { type: "failed", error };
    } finally {
      this.activeSource = undefined;
      this.activeRunGoalId = undefined;
      this.terminalEvent = undefined;
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    const source = this.activeSource;
    if (!source) {
      return;
    }
    if (event.type === "agent_end") {
      this.terminalEvent = structuredClone(event);
    }
    this.inputCoordinator.observeAgentEvent(event);
    this.emit({
      type: "agent_event",
      source,
      event: structuredClone(event),
    });
  }

  private readTerminalEvent(): Extract<AgentEvent, { type: "agent_end" }> | undefined {
    return this.terminalEvent;
  }

  private assertCanStartRun(): void {
    if (this.stopping) {
      throw new Error("Conversation runtime is stopping.");
    }
    this.assertIdle("start another run");
  }

  private assertIdle(operation: string): void {
    if (this.changingSession) {
      throw new Error(`Cannot ${operation} while the conversation session is changing.`);
    }
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
