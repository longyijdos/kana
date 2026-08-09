import type { Agent, AgentEvent, BeforeToolExecutionHook, ContextCheckpoint } from "@/agent";
import type { Message, UserMessage } from "@/core";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaSessionMetadata, KanaSessionTimelineEntry } from "../session";
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
  contextCheckpoint?: ContextCheckpoint;
};

export type ConversationRunSource = "user" | "scheduled" | "compaction";

export type ConversationInputDisposition = "steered" | "queued" | "discarded";

export type ConversationPendingInput =
  | {
      id: string;
      kind: "queued" | "deferred";
      content: string;
      imageCount?: number;
    }
  | {
      id: string;
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
  canStartQueuedRun?: () => boolean;
  /** @deprecated Use canStartQueuedRun. */
  canStartScheduledRun?: () => boolean;
  getLogger?: () => Logger;
};

type PendingSubmissionBase = {
  id: string;
  sessionId?: string;
  input: UserMessage;
  displayContent: string;
};

type PendingSubmission =
  | (PendingSubmissionBase & {
      source: "user";
      kind: "queued" | "deferred";
    })
  | (PendingSubmissionBase & {
      source: "scheduled";
      kind: "scheduled";
      scheduled: {
        dueAt: Date;
        origin: WakeEventOrigin;
        key?: string;
      };
    });

type PendingSubmissionDraft =
  | (Omit<Extract<PendingSubmission, { source: "user" }>, "id"> & { id?: string })
  | (Omit<Extract<PendingSubmission, { source: "scheduled" }>, "id"> & {
      id?: string;
    });

export class ConversationRuntime<TConfiguration = never> {
  private readonly listeners = new Set<ConversationRuntimeListener>();
  private readonly wakeScheduler: WakeScheduler;
  private readonly unsubscribeWakeEvents: () => void;
  private readonly unsubscribeWakeState: () => void;
  private readonly pendingSubmissions: PendingSubmission[] = [];
  private readonly getLogger: () => Logger;
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
    return {
      pending: this.pendingSubmissions
        .filter((submission) => submission.sessionId === sessionId)
        .map((submission): ConversationPendingInput => {
          if (submission.kind === "scheduled") {
            return {
              id: submission.id,
              kind: "scheduled",
              content: submission.displayContent,
              dueAt: new Date(submission.scheduled.dueAt.getTime()),
              origin: submission.scheduled.origin,
              key: submission.scheduled.key,
            };
          }

          return {
            id: submission.id,
            kind: submission.kind,
            content: submission.displayContent,
            ...(submission.input.images?.length
              ? { imageCount: submission.input.images.length }
              : {}),
          };
        }),
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

  queueInput(input: UserMessage): string {
    return this.queueSubmission({
      sessionId: this.sessionId,
      input,
      source: "user",
      kind: "queued",
      displayContent: input.content,
    });
  }

  scheduleInput(afterMinutes: number, message: string): WakeEvent {
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
    if (isCurrentSessionWake && this.wakeScheduler.cancel(id)) {
      this.log("info", "conversation.scheduled_input_cancelled", { state: "future" });
      return "future";
    }

    const pendingIndex = this.pendingSubmissions.findIndex(
      (submission) =>
        submission.id === id &&
        submission.sessionId === sessionId &&
        submission.kind === "scheduled",
    );
    if (pendingIndex < 0) {
      this.log("info", "conversation.scheduled_input_cancel_skipped", {
        reason: "not_found",
      });
      return "not_found";
    }

    this.pendingSubmissions.splice(pendingIndex, 1);
    this.emitInputQueueChanged();
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

    this.queueSubmission({
      sessionId,
      input,
      source: "user",
      kind: "deferred",
      displayContent: input.content,
    });
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
    this.pendingSubmissions.length = 0;
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

    this.queueSubmission({
      id: event.id,
      sessionId: event.sessionId,
      input: {
        role: "user",
        content: ["[Scheduled wake event]", event.message].join("\n"),
        source: "scheduled",
      },
      source: "scheduled",
      kind: "scheduled",
      displayContent: event.message,
      scheduled: {
        dueAt: event.dueAt,
        origin: event.origin,
        key: event.key,
      },
    });
  }

  private queueSubmission(submission: PendingSubmissionDraft): string {
    if (this.stopping) {
      return submission.id ?? crypto.randomUUID();
    }

    const id = submission.id ?? crypto.randomUUID();
    const queuedSubmission: PendingSubmission = { ...structuredClone(submission), id };
    this.pendingSubmissions.push(queuedSubmission);
    this.log("info", "conversation.input_queued", {
      source: submission.source,
      pendingInputCount: this.pendingSubmissions.length,
    });
    this.emitInputQueueChanged();
    void this.drainPendingSubmissions();
    return queuedSubmission.id;
  }

  private async drainPendingSubmissions(): Promise<void> {
    if (this.stopping || this.drainingSubmissions || this.isRunning || !this.canStartQueuedRun()) {
      return;
    }

    this.drainingSubmissions = true;
    try {
      while (!this.stopping && !this.isRunning && this.canStartQueuedRun()) {
        const submission = this.pendingSubmissions.shift();
        if (!submission) {
          return;
        }
        this.emitInputQueueChanged();
        if (submission.sessionId !== this.sessionId) {
          continue;
        }

        this.log("info", "conversation.queued_input_started", {
          source: submission.source,
          pendingInputCount: this.pendingSubmissions.length,
        });
        await this.submit(submission.input, submission.source).catch(() => {
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

    let pendingChanged = false;
    for (let index = this.pendingSubmissions.length - 1; index >= 0; index -= 1) {
      if (this.pendingSubmissions[index]?.sessionId === sessionId) {
        this.pendingSubmissions.splice(index, 1);
        pendingChanged = true;
      }
    }
    if (pendingChanged) {
      this.emitInputQueueChanged();
    }
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
