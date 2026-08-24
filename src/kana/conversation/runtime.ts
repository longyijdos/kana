import type {
  Agent,
  AgentEvent,
  AgentInboxSnapshot,
  BeforeToolExecutionHook,
  ContextCheckpoint,
} from "@/agent";
import {
  createUserMessage,
  type Message,
  type MessageId,
  readMessageId,
  type UserMessage,
} from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaSessionMetadata, KanaSessionTimelineEntry } from "../session";
import type { KanaTodoItem, KanaTodoStateChange } from "../todo";
import {
  createWakeScheduler,
  type WakeEvent,
  type WakeEventOrigin,
  type WakeScheduler,
} from "./wake-scheduler";

export type ConversationSessionSnapshot = {
  id: string;
  messages: Message[];
  timeline: KanaSessionTimelineEntry[];
  todoState?: KanaTodoItem[];
  contextCheckpoint?: ContextCheckpoint;
};

export type ConversationRunSource = "user" | "scheduled" | "compaction";

export type ConversationInputDisposition = "steered" | "queued" | "discarded";

type ConversationPendingInput =
  | {
      id: MessageId;
      kind: "steering" | "queued" | "deferred";
      content: string;
      imageCount?: number;
    }
  | {
      id: MessageId;
      kind: "scheduled";
      content: string;
      imageCount?: number;
      dueAt: Date;
      origin: WakeEventOrigin;
      key?: string;
    };

export type ConversationInputQueueSnapshot = {
  pending: ConversationPendingInput[];
  scheduled: WakeEvent[];
};

export type ConversationScheduledInputCancellation = "future" | "pending" | "not_found";

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
    }
  | {
      type: "input_queue_changed";
      queue: ConversationInputQueueSnapshot;
    }
  | {
      type: "todo_state_changed";
      source: ConversationRunSource;
      change: KanaTodoStateChange;
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
  deleteSession?: (sessionId: string) => boolean;
  wakeScheduler?: WakeScheduler;
  scheduledRuns?: boolean;
  canStartQueuedRun?: () => boolean;
  /** @deprecated Use canStartQueuedRun. */
  canStartScheduledRun?: () => boolean;
  getLogger?: () => Logger;
};

export class ConversationRuntime<TConfiguration = never> {
  private readonly listeners = new Set<ConversationRuntimeListener>();
  private readonly wakeScheduler: WakeScheduler;
  private readonly unsubscribeWakeEvents: () => void;
  private readonly unsubscribeWakeState: () => void;
  private readonly getLogger: () => Logger;
  private unsubscribeAgentInbox?: () => void;
  private agent: Agent;
  private sessionData?: ConversationSessionSnapshot;
  private beforeToolExecution?: BeforeToolExecutionHook;
  private activeSource?: ConversationRunSource;
  private terminalEvent?: Extract<AgentEvent, { type: "agent_end" }>;
  private drainingSubmissions = false;
  private stopping = false;

  constructor(private readonly options: ConversationRuntimeOptions<TConfiguration>) {
    this.sessionData = cloneSession(options.initialSession);
    this.getLogger = options.getLogger ?? createNoopLogger;
    this.wakeScheduler = options.wakeScheduler ?? createWakeScheduler();
    this.agent = this.buildAgent(this.sessionData?.messages, this.sessionData?.contextCheckpoint);
    this.observeAgentInbox(this.agent);
    this.unsubscribeWakeEvents = this.wakeScheduler.subscribe((event) => {
      this.queueWakeEvent(event);
    });
    this.unsubscribeWakeState = this.wakeScheduler.subscribeState(() => {
      this.emitInputQueueChanged();
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

  get todoState(): KanaTodoItem[] {
    return structuredClone(this.sessionData?.todoState ?? []);
  }

  get isRunning(): boolean {
    return this.activeSource !== undefined || this.agent.state.isRunning;
  }

  get canSteer(): boolean {
    return (
      this.activeSource !== undefined &&
      this.activeSource !== "compaction" &&
      this.agent.state.isRunning
    );
  }

  get inputQueue(): ConversationInputQueueSnapshot {
    const sessionId = this.sessionId;
    const inbox = this.agent.inbox;
    return {
      pending: [
        ...inbox.nextStep.map((item) => this.toPendingInput(item, "next-step")),
        ...inbox.nextTurn.map((item) => this.toPendingInput(item, "next-turn")),
      ],
      scheduled:
        sessionId === undefined || this.options.scheduledRuns === false
          ? []
          : this.wakeScheduler.list(sessionId),
    };
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
      void this.drainPendingSubmissions();
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
      void this.drainPendingSubmissions();
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
    this.cancelCurrentSessionInputs();
    const session: ConversationSessionSnapshot = {
      id: created.id,
      messages: [],
      timeline: [],
      todoState: [],
    };
    this.replaceSession("new", session);
    return this.session as ConversationSessionSnapshot;
  }

  forkSession(prompt: string): ConversationSessionSnapshot {
    this.assertIdle("fork the session");
    const state = this.agent.state;
    const created = this.options.forkSession(state.messages, state.contextCheckpoint, prompt);
    this.cancelCurrentSessionInputs();
    const session: ConversationSessionSnapshot = {
      id: created.id,
      messages: state.messages,
      timeline: [],
      todoState: structuredClone(created.todoState ?? this.sessionData?.todoState ?? []),
      contextCheckpoint: state.contextCheckpoint,
    };
    this.replaceSession("fork", session);
    return this.session as ConversationSessionSnapshot;
  }

  resumeSession(sessionId: string): ConversationSessionSnapshot {
    this.assertIdle("resume a session");
    const session = this.options.loadSession(sessionId);
    this.cancelCurrentSessionInputs();
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

  notifyCanStartQueuedRun(): void {
    void this.drainPendingSubmissions();
  }

  /** @deprecated Use notifyCanStartQueuedRun. */
  notifyCanStartScheduledRun(): void {
    this.notifyCanStartQueuedRun();
  }

  queueInput(input: UserMessage): MessageId {
    if (this.stopping) {
      this.log("warn", "conversation.input_discarded", { reason: "stopping" });
      return input.id;
    }
    this.agent.enqueueInput(input, "next-turn", { kind: "queued" });
    this.log("info", "conversation.input_queued", {
      source: "user",
      pendingInputCount: this.agent.inbox.nextTurn.length,
    });
    return input.id;
  }

  scheduleInput(afterMinutes: number, message: string): WakeEvent {
    if (this.stopping) {
      throw new Error("Conversation runtime is stopping.");
    }
    const sessionId = this.sessionId;
    if (!sessionId) {
      throw new Error("Cannot schedule a message without an active session.");
    }
    if (this.options.scheduledRuns === false) {
      throw new Error("Scheduled messages are unavailable when scheduled runs are disabled.");
    }
    if (!Number.isInteger(afterMinutes) || afterMinutes < 1 || afterMinutes > 1_440) {
      throw new Error("Scheduled message delay must be between 1 minute and 24 hours.");
    }
    const normalizedMessage = message.trim();
    if (!normalizedMessage || normalizedMessage.length > 4_000) {
      throw new Error("Scheduled message must contain between 1 and 4000 characters.");
    }

    return this.wakeScheduler.schedule({
      sessionId,
      afterMinutes,
      message: normalizedMessage,
      origin: "user",
    });
  }

  cancelScheduledInput(id: string): ConversationScheduledInputCancellation {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return "not_found";
    }

    const isCurrentSessionWake = this.wakeScheduler
      .list(sessionId)
      .some((event) => event.id === id);
    // Expiry and cancellation share the JavaScript event loop, so the stable
    // ID is synchronously present in either the timer map or the pending FIFO.
    if (isCurrentSessionWake && this.wakeScheduler.cancel(readMessageId(id))) {
      this.log("info", "conversation.scheduled_input_cancelled", { state: "future" });
      return "future";
    }

    const pending = this.agent.inbox.nextTurn.find(
      (item) => item.message.id === id && item.delivery.kind === "scheduled",
    );
    if (!pending) {
      this.log("info", "conversation.scheduled_input_cancel_skipped", {
        reason: "not_found",
      });
      return "not_found";
    }

    this.agent.cancelInput(pending.message.id);
    this.log("info", "conversation.scheduled_input_cancelled", { state: "pending" });
    return "pending";
  }

  async steer(input: UserMessage): Promise<ConversationInputDisposition> {
    if (this.stopping) {
      return "discarded";
    }

    const sessionId = this.sessionId;
    const outcome = await this.agent.steer(input);
    if (outcome === "consumed") {
      return "steered";
    }
    if (this.stopping || sessionId !== this.sessionId) {
      this.log("warn", "conversation.input_discarded", {
        reason: this.stopping ? "stopping" : "session_changed",
      });
      return "discarded";
    }

    return "queued";
  }

  async close(): Promise<void> {
    if (this.stopping) {
      await this.agent.waitForIdle();
      return;
    }

    this.stopping = true;
    this.unsubscribeWakeEvents();
    this.unsubscribeWakeState();
    this.unsubscribeAgentInbox?.();
    this.agent.clearInbox();
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
    this.observeAgentInbox(nextAgent);
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
    this.observeAgentInbox(nextAgent);
    previousAgent.abort();
    this.emit({
      type: "session_changed",
      action,
      session: this.session as ConversationSessionSnapshot,
    });
    this.emitInputQueueChanged();
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

    const input = createUserMessage({
      id: event.id,
      content: ["[Scheduled wake event]", event.message].join("\n"),
      provenance: { kind: "scheduled_input", origin: event.origin },
    });
    this.agent.enqueueInput(input, "next-turn", {
      kind: "scheduled",
      displayContent: event.message,
      dueAt: event.dueAt,
      key: event.key,
    });
    this.log("info", "conversation.input_queued", {
      source: "scheduled",
      pendingInputCount: this.agent.inbox.nextTurn.length,
    });
  }

  private toPendingInput(
    item: AgentInboxSnapshot["nextTurn"][number],
    lane: "next-step" | "next-turn",
  ): ConversationPendingInput {
    if (item.delivery.kind === "scheduled") {
      const provenance = item.message.provenance;
      if (provenance.kind !== "scheduled_input") {
        throw new Error("Scheduled Agent input is missing scheduled provenance.");
      }
      return {
        id: item.message.id,
        kind: "scheduled",
        content: item.delivery.displayContent,
        dueAt: new Date(item.delivery.dueAt.getTime()),
        origin: provenance.origin,
        key: item.delivery.key,
      };
    }

    return {
      id: item.message.id,
      kind:
        lane === "next-step"
          ? "steering"
          : item.delivery.kind === "steering"
            ? "deferred"
            : "queued",
      content: item.message.content,
      ...(item.message.images?.length ? { imageCount: item.message.images.length } : {}),
    };
  }

  private async drainPendingSubmissions(): Promise<void> {
    if (this.stopping || this.drainingSubmissions || this.isRunning || !this.canStartQueuedRun()) {
      return;
    }

    this.drainingSubmissions = true;
    try {
      while (!this.stopping && !this.isRunning && this.canStartQueuedRun()) {
        const submission = this.agent.shiftNextTurnInput();
        if (!submission) {
          return;
        }

        const source = submission.delivery.kind === "scheduled" ? "scheduled" : "user";

        this.log("info", "conversation.queued_input_started", {
          source,
          pendingInputCount: this.agent.inbox.nextTurn.length,
        });
        await this.submit(submission.message, source).catch(() => {
          // run_error already carries the failure to the active frontend.
        });
      }
    } finally {
      this.drainingSubmissions = false;
    }
  }

  private canStartQueuedRun(): boolean {
    return (this.options.canStartQueuedRun ?? this.options.canStartScheduledRun)?.() !== false;
  }

  private cancelCurrentSessionInputs(): void {
    const sessionId = this.sessionId;
    if (sessionId) {
      this.wakeScheduler.cancelSession(sessionId);
    }

    this.agent.clearInbox();
  }

  private observeAgentInbox(agent: Agent): void {
    this.unsubscribeAgentInbox?.();
    this.unsubscribeAgentInbox = agent.subscribeInbox(() => {
      this.emitInputQueueChanged();
      void this.drainPendingSubmissions();
    });
  }

  private emitInputQueueChanged(): void {
    if (this.stopping) {
      return;
    }
    this.emit({
      type: "input_queue_changed",
      queue: this.inputQueue,
    });
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
