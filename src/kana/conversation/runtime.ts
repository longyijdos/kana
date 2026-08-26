import type {
  Agent,
  AgentEvent,
  AgentInboxItem,
  AgentInboxSnapshot,
  AgentInputDelivery,
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
import type {
  BackgroundJobClient,
  BackgroundJobCompletionEvent,
  BackgroundJobSummary,
} from "@/jobs";
import { createNoopLogger, type Logger } from "@/logging";
import type { KanaSessionMetadata, KanaSessionTimelineEntry } from "../session";
import type { KanaTodoItem, KanaTodoStateChange } from "../todo";
import { KanaGoalController, type KanaGoalSnapshot, type KanaGoalUpdate } from "./goal-controller";
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

export type ConversationRunSource = "user" | "scheduled" | "goal" | "job" | "compaction";

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
    }
  | {
      id: MessageId;
      kind: "goal";
      content: string;
      imageCount?: number;
      goalId: string;
      round: number;
      maxRounds: number;
    }
  | {
      id: MessageId;
      kind: "job";
      content: string;
      jobId: string;
      imageCount?: number;
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
  deleteSession?: (sessionId: string) => boolean;
  getBackgroundJobs?: (sessionId: string) => BackgroundJobClient | undefined;
  backgroundJobCompletionRuns?: boolean;
  wakeScheduler?: WakeScheduler;
  scheduledRuns?: boolean;
  canStartQueuedRun?: () => boolean;
  goalMaxRounds: number;
  getLogger?: () => Logger;
};

export class ConversationRuntime<TConfiguration = never> {
  private readonly listeners = new Set<ConversationRuntimeListener>();
  private readonly wakeScheduler: WakeScheduler;
  private readonly unsubscribeWakeEvents: () => void;
  private readonly unsubscribeWakeState: () => void;
  private readonly getLogger: () => Logger;
  private readonly goalController = new KanaGoalController();
  private unsubscribeAgentInbox?: () => void;
  private unsubscribeBackgroundJobs?: () => void;
  private backgroundJobs?: BackgroundJobClient;
  private agent: Agent;
  private sessionData?: ConversationSessionSnapshot;
  private beforeToolExecution?: BeforeToolExecutionHook;
  private activeSource?: ConversationRunSource;
  private activeRunGoalId?: string;
  private terminalEvent?: Extract<AgentEvent, { type: "agent_end" }>;
  private drainingSubmissions = false;
  private changingSession = false;
  private stopping = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: ConversationRuntimeOptions<TConfiguration>) {
    this.sessionData = cloneSession(options.initialSession);
    this.getLogger = options.getLogger ?? createNoopLogger;
    this.wakeScheduler = options.wakeScheduler ?? createWakeScheduler();
    this.agent = this.buildAgent(this.sessionData?.messages, this.sessionData?.contextCheckpoint);
    this.observeAgentInbox(this.agent);
    this.observeBackgroundJobs(this.sessionData?.id);
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

  get goal(): KanaGoalSnapshot | undefined {
    return this.goalController.current;
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

  async submit(
    input: UserMessage,
    source: Exclude<ConversationRunSource, "compaction"> = "user",
  ): Promise<void> {
    this.assertCanStartRun();
    this.activeSource = source;
    const adjacentCompletions = source === "job" ? this.takePendingJobCompletionInputs() : [];
    const promptInput =
      adjacentCompletions.length === 0
        ? input
        : source === "job"
          ? [input, ...adjacentCompletions]
          : [...adjacentCompletions, input];
    this.activeRunGoalId = this.goalController.active?.id;
    this.terminalEvent = undefined;
    this.emit({
      type: "run_start",
      source,
      input: structuredClone(input),
    });
    this.log("info", "conversation.run_started", { source });

    try {
      const stream = this.agent.stream(promptInput);
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
        this.blockActiveGoal(`The goal run ended with ${terminalEvent.reason}.`);
      }
      const runGoal = this.goalForActiveRun();
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
    } catch (error) {
      if (source === "goal") {
        this.blockActiveGoal("The goal run failed before it could continue.");
      }
      this.emit({ type: "run_error", source, error });
      this.log("error", "conversation.run_failed", { source, error });
      throw error;
    } finally {
      for (const completion of adjacentCompletions) {
        this.observeJobCompletion(completion);
      }
      if (input.provenance.kind === "job_completion") {
        this.observeJobCompletion(input);
      }
      this.activeSource = undefined;
      this.activeRunGoalId = undefined;
      this.terminalEvent = undefined;
      void this.drainPendingSubmissions();
    }
  }

  async startGoal(objective: string): Promise<KanaGoalSnapshot> {
    this.assertCanStartRun();
    const goal = this.goalController.start(objective, this.options.goalMaxRounds);
    this.emitGoalChanged("started", goal);
    this.log("info", "conversation.goal_started", {
      goalId: goal.id,
      maxRounds: goal.maxRounds,
    });

    const input = createUserMessage({
      content: goal.objective,
      provenance: { kind: "user_input" },
    });
    await this.submit(input, "goal");
    return this.goalController.current ?? goal;
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
    this.discardActiveGoal("agent_reconfigured");
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

  deleteSession(sessionId: string): boolean {
    if (sessionId === this.sessionId) {
      return false;
    }
    return this.options.deleteSession?.(sessionId) ?? false;
  }

  abort(): void {
    const cancelled = this.goalController.cancel();
    if (cancelled) {
      this.emitGoalChanged("cancelled", cancelled);
      this.log("info", "conversation.goal_cancelled", {
        goalId: cancelled.id,
        admittedRounds: cancelled.admittedRounds,
      });
    }
    this.agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  notifyCanStartQueuedRun(): void {
    void this.drainPendingSubmissions();
  }

  queueInput(input: UserMessage): MessageId {
    if (this.stopping || this.changingSession) {
      this.log("warn", "conversation.input_discarded", {
        reason: this.stopping ? "stopping" : "session_changing",
      });
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
    if (this.stopping || this.changingSession) {
      throw new Error(
        this.stopping ? "Conversation runtime is stopping." : "Conversation session is changing.",
      );
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
    if (this.stopping || this.changingSession) {
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

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.closeInternal();
    }
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.stopping = true;
    this.discardActiveGoal("shutdown");
    this.unsubscribeWakeEvents();
    this.unsubscribeWakeState();
    this.unsubscribeAgentInbox?.();
    this.unsubscribeBackgroundJobs?.();
    this.agent.clearInbox();
    this.agent.abort();
    await Promise.all([
      this.agent.waitForIdle(),
      this.backgroundJobs?.close("shutdown") ?? Promise.resolve(),
    ]);
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
      resolveGoal: () => this.goalForAgent(),
      updateGoal: (change) => this.updateGoal(change),
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
    const previousJobs = this.backgroundJobs;
    this.changingSession = true;
    this.unsubscribeBackgroundJobs?.();
    try {
      await previousJobs?.close("session_disposal");
    } finally {
      this.changingSession = false;
    }
    if (this.stopping) {
      nextAgent.abort();
      await this.options.getBackgroundJobs?.(nextSession.id)?.close("shutdown");
      throw new Error("Conversation runtime stopped while changing sessions.");
    }
    this.cancelCurrentSessionInputs();
    this.sessionData = nextSession;
    this.agent = nextAgent;
    this.observeAgentInbox(nextAgent);
    this.observeBackgroundJobs(nextSession.id);
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
    if (event.type === "turn_input" && event.message.provenance.kind === "job_completion") {
      this.observeJobCompletion(event.message);
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
    this.queueAutomaticInput(
      input,
      {
        kind: "scheduled",
        displayContent: event.message,
        dueAt: event.dueAt,
        key: event.key,
      },
      "scheduled",
    );
  }

  private queueAutomaticInput(
    input: UserMessage,
    delivery: Extract<AgentInputDelivery, { kind: "scheduled" | "goal" }>,
    source: "scheduled" | "goal",
  ): void {
    this.agent.enqueueInput(input, "next-turn", delivery);
    this.log("info", "conversation.automatic_input_queued", {
      source,
      pendingInputCount: this.agent.inbox.nextTurn.length,
    });
  }

  private createGoalContinuationSubmission(): AgentInboxItem | undefined {
    const admission = this.goalController.admitContinuation();
    if (!admission) {
      return undefined;
    }
    if (admission.type === "round_limit") {
      this.emitGoalChanged("round_limit", admission.goal);
      this.log("info", "conversation.goal_round_limit_reached", {
        goalId: admission.goal.id,
        admittedRounds: admission.goal.admittedRounds,
      });
      return undefined;
    }

    const goal = admission.goal;
    const content = [
      "[Goal continuation]",
      "Continue the active goal using the authoritative runtime context.",
    ].join("\n");
    const input = createUserMessage({
      content,
      provenance: {
        kind: "goal_continuation",
        goalId: goal.id,
        round: goal.admittedRounds,
      },
    });
    this.queueAutomaticInput(
      input,
      {
        kind: "goal",
        displayContent: `Goal continuation · round ${goal.admittedRounds}/${goal.maxRounds}`,
        goalId: goal.id,
        round: goal.admittedRounds,
        maxRounds: goal.maxRounds,
      },
      "goal",
    );
    this.emitGoalChanged("round_admitted", goal);
    this.log("info", "conversation.goal_round_admitted", {
      goalId: goal.id,
      admittedRounds: goal.admittedRounds,
      maxRounds: goal.maxRounds,
    });
    return this.agent.shiftNextTurnInput();
  }

  private resolveSubmissionSource(
    delivery: AgentInputDelivery,
  ): Exclude<ConversationRunSource, "compaction"> {
    if (delivery.kind === "scheduled") {
      return "scheduled";
    }
    if (delivery.kind === "goal") {
      return "goal";
    }
    if (delivery.kind === "job") {
      return "job";
    }
    return "user";
  }

  private updateGoal(change: KanaGoalUpdate): KanaGoalSnapshot {
    const goal = this.goalController.update(change);
    this.emitGoalChanged(change.status, goal);
    this.log("info", `conversation.goal_${goal.status}`, {
      goalId: goal.id,
      admittedRounds: goal.admittedRounds,
    });
    return goal;
  }

  private goalForAgent(): KanaGoalSnapshot | undefined {
    const current = this.goalController.current;
    if (current?.id === this.activeRunGoalId) {
      return current;
    }
    return this.goalController.active;
  }

  private goalForActiveRun(): KanaGoalSnapshot | undefined {
    const goal = this.goalController.current;
    return goal?.id === this.activeRunGoalId ? goal : undefined;
  }

  private blockActiveGoal(detail: string): void {
    const blocked = this.goalController.block(detail);
    if (!blocked) {
      return;
    }
    this.emitGoalChanged("blocked", blocked);
    this.log("warn", "conversation.goal_blocked", {
      goalId: blocked.id,
      admittedRounds: blocked.admittedRounds,
      reason: "run_failure",
    });
  }

  private discardActiveGoal(reason: "agent_reconfigured" | "session_changed" | "shutdown"): void {
    const discarded = this.goalController.discard();
    if (!discarded) {
      return;
    }
    this.emitGoalChanged("discarded", discarded);
    this.log("info", "conversation.goal_discarded", {
      goalId: discarded.id,
      admittedRounds: discarded.admittedRounds,
      reason,
    });
  }

  private emitGoalChanged(
    change: Extract<ConversationRuntimeEvent, { type: "goal_state_changed" }>["change"],
    goal: KanaGoalSnapshot,
  ): void {
    this.emit({
      type: "goal_state_changed",
      change,
      goal: structuredClone(goal),
    });
  }

  private toPendingInput(
    item: AgentInboxSnapshot["nextTurn"][number],
    lane: "next-step" | "next-turn",
  ): ConversationPendingInput {
    if (item.delivery.kind === "job") {
      const provenance = item.message.provenance;
      if (provenance.kind !== "job_completion") {
        throw new Error("Background Job input is missing completion provenance.");
      }
      return {
        id: item.message.id,
        kind: "job",
        content: item.delivery.displayContent,
        jobId: item.delivery.jobId,
      };
    }
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
    if (item.delivery.kind === "goal") {
      const provenance = item.message.provenance;
      if (provenance.kind !== "goal_continuation") {
        throw new Error("Goal Agent input is missing goal continuation provenance.");
      }
      return {
        id: item.message.id,
        kind: "goal",
        content: item.delivery.displayContent,
        goalId: item.delivery.goalId,
        round: item.delivery.round,
        maxRounds: item.delivery.maxRounds,
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
        const next = this.agent.inbox.nextTurn[0];
        if (next?.delivery.kind === "job" && this.options.backgroundJobCompletionRuns === false) {
          return;
        }
        const submission =
          this.agent.shiftNextTurnInput() ?? this.createGoalContinuationSubmission();
        if (!submission) {
          return;
        }

        const source = this.resolveSubmissionSource(submission.delivery);
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
    return this.options.canStartQueuedRun?.() !== false;
  }

  private cancelCurrentSessionInputs(): void {
    const sessionId = this.sessionId;
    if (sessionId) {
      this.wakeScheduler.cancelSession(sessionId);
    }

    this.agent.clearInbox();
    this.discardActiveGoal("session_changed");
  }

  private observeAgentInbox(agent: Agent): void {
    this.unsubscribeAgentInbox?.();
    this.unsubscribeAgentInbox = agent.subscribeInbox(() => {
      this.emitInputQueueChanged();
      void this.drainPendingSubmissions();
    });
  }

  private observeBackgroundJobs(sessionId: string | undefined): void {
    this.unsubscribeBackgroundJobs?.();
    this.unsubscribeBackgroundJobs = undefined;
    this.backgroundJobs = sessionId ? this.options.getBackgroundJobs?.(sessionId) : undefined;
    this.unsubscribeBackgroundJobs = this.backgroundJobs?.subscribe((event) => {
      this.handleBackgroundJobEvent(event);
    });
  }

  private handleBackgroundJobEvent(event: BackgroundJobCompletionEvent): void {
    if (this.stopping || this.changingSession || event.owner.sessionId !== this.sessionId) {
      return;
    }
    if (event.type === "observed") {
      for (const item of [...this.agent.inbox.nextStep, ...this.agent.inbox.nextTurn]) {
        if (item.delivery.kind === "job" && item.delivery.jobId === event.job.id) {
          this.agent.cancelInput(item.message.id);
        }
      }
      return;
    }

    const input = createUserMessage({
      content: formatBackgroundJobCompletion(event.job),
      provenance: { kind: "job_completion", jobId: event.job.id },
    });
    const lane = this.canSteer ? "next-step" : "next-turn";
    this.agent.enqueueInput(input, lane, {
      kind: "job",
      displayContent: `Background Job ${shortJobId(event.job.id)} ${event.job.status}`,
      jobId: event.job.id,
    });
    this.log("info", "conversation.background_job_completion_queued", {
      jobId: event.job.id,
      outcome: event.job.status,
      delivery: lane,
    });
  }

  private takePendingJobCompletionInputs(): UserMessage[] {
    const inputs: UserMessage[] = [];
    while (this.agent.inbox.nextTurn[0]?.delivery.kind === "job") {
      const item = this.agent.shiftNextTurnInput();
      if (!item) {
        break;
      }
      inputs.push(item.message);
    }
    return inputs;
  }

  private observeJobCompletion(message: UserMessage): void {
    if (message.provenance.kind === "job_completion") {
      this.backgroundJobs?.observe(message.provenance.jobId);
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

function formatBackgroundJobCompletion(job: BackgroundJobSummary): string {
  return [
    "[Background Job completion]",
    `Job ${job.id} reached ${job.status}.`,
    `exitCode: ${job.exitCode}`,
    "Use job_output to consume any remaining output before deciding the next action.",
  ].join("\n");
}

function shortJobId(jobId: string): string {
  return jobId.startsWith("job_") ? jobId.slice(4, 10) : jobId.slice(0, 6);
}
